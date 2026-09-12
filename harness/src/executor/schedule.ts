/**
 * When the executor runs: a pure window/interval predicate over the `settings`
 * table, plus the long-running loop that drives `runAll`.
 *
 * All times are local: the window ("between 10 and 22") is the user's day, not
 * UTC.
 */
import * as store from "../store.js";
import { runAll } from "./beats.js";
import { status } from "./lovable-auth.js";
import { openLovableClient, type LovableClient } from "./lovable-mcp.js";
import { runAnalysis } from "../analysis/run.js";
import { createCallLlm } from "../llm/index.js";

export type ScheduleSettings = {
  enabled: boolean;
  intervalMinutes: number;
  windowStartHour: number;
  windowEndHour: number;
};

const DEFAULT_TICK_MS = 30_000;
const NOT_CONNECTED_LOG_INTERVAL_MS = 10 * 60 * 1000;
/** `nextRunAt` walks minute by minute; two days covers any window/interval. */
const NEXT_RUN_SEARCH_MINUTES = 48 * 60;

function intOr(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

export function scheduleFromSettings(s: Record<string, string>): ScheduleSettings {
  return {
    enabled: s.sync_enabled !== "false",
    intervalMinutes: intOr(s.sync_interval_minutes, 60),
    windowStartHour: intOr(s.sync_window_start_hour, 10),
    windowEndHour: intOr(s.sync_window_end_hour, 22),
  };
}

// `setSettings` already rejects start >= end, so an overnight window cannot be
// reached through the API; the guard below turns a hand-edited settings row
// into a loud error rather than a scheduler that silently never runs.
function assertWindow(s: ScheduleSettings): void {
  if (s.windowStartHour >= s.windowEndHour) {
    throw new Error(
      `sync window ${s.windowStartHour}-${s.windowEndHour} is empty or overnight; start must be before end`,
    );
  }
}

export function shouldRunAt(
  now: Date,
  lastRunStartedAt: Date | null,
  s: ScheduleSettings,
): boolean {
  if (!s.enabled) return false;
  assertWindow(s);
  const hour = now.getHours();
  if (hour < s.windowStartHour || hour >= s.windowEndHour) return false;
  if (!lastRunStartedAt) return true;
  return now.getTime() - lastRunStartedAt.getTime() >= s.intervalMinutes * 60_000;
}

/**
 * The earliest instant at or after `now` that `shouldRunAt` accepts. `null`
 * means one thing only — syncing is switched off — so `--status` can say so.
 */
export function nextRunAt(
  now: Date,
  lastRunStartedAt: Date | null,
  s: ScheduleSettings,
): Date | null {
  if (!s.enabled) return null;
  assertWindow(s);
  const cursor = new Date(now.getTime());
  cursor.setSeconds(0, 0);
  for (let i = 0; i <= NEXT_RUN_SEARCH_MINUTES; i += 1) {
    const at = new Date(cursor.getTime() + i * 60_000);
    if (shouldRunAt(at, lastRunStartedAt, s)) return at;
  }
  return null;
}

function lastRunStart(): Date | null {
  const last = store.latestSyncRun();
  if (!last) return null;
  // SQLite's datetime('now') is UTC without a zone marker.
  const parsed = new Date(last.started_at.replace(" ", "T") + "Z");
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function openRequestExists(): boolean {
  return store.hasOpenSyncRequest();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Round 4 Task A3: "Analyse now" runs independent of the Lovable connection
 * and of the sync schedule/window (spec §2) -- an open analysis_requests
 * row is picked up on the very next tick regardless of `status().connected`.
 * A run already in flight (store.runningAnalysisRun's own 15-minute crash
 * window) blocks a second one. Never throws: a failure to even start is
 * logged, exactly like the sync run's own catch below, so it can never
 * break the tick that follows.
 */
async function maybeRunAnalysis(): Promise<void> {
  if (!store.hasOpenAnalysisRequest() || store.runningAnalysisRun()) return;
  try {
    const result = await runAnalysis(createCallLlm(), "manual");
    console.log(
      `Analysis run ${result.runId} ${result.ok ? "ok" : `failed: ${result.error}`} ${JSON.stringify(result.counts)}`,
    );
  } catch (err) {
    console.error(
      `Analysis run could not start: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * The scheduler. One tick decides at most one sync run: an explicit "Sync
 * now" beats the schedule, and a sync run already in flight beats both. The
 * Lovable client is opened lazily on the first run and reused afterwards.
 * Analysis (above) is checked every tick too, independent of all of this.
 */
export async function loop(opts: { tickMs?: number; once?: boolean } = {}): Promise<void> {
  const tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
  let client: LovableClient | null = null;
  let lastNotConnectedLog = 0;

  const closeClient = async () => {
    if (!client) return;
    const c = client;
    client = null;
    await c.close().catch(() => {});
  };

  try {
    for (;;) {
      await maybeRunAnalysis();

      const connected = status().connected;
      if (!connected) {
        await closeClient();
        const now = Date.now();
        if (
          now - lastNotConnectedLog >= NOT_CONNECTED_LOG_INTERVAL_MS ||
          lastNotConnectedLog === 0
        ) {
          lastNotConnectedLog = now;
          console.log("Not connected — run `npm run harness:executor -- --connect`");
        }
        if (opts.once) return;
        await sleep(tickMs);
        continue;
      }
      lastNotConnectedLog = 0;

      const requested = openRequestExists();
      const schedule = scheduleFromSettings(store.getSettings());
      const due = shouldRunAt(new Date(), lastRunStart(), schedule);
      const kind: "manual" | "scheduled" | null = store.runningSyncRun()
        ? null
        : requested
          ? "manual"
          : due
            ? "scheduled"
            : null;

      if (kind) {
        try {
          client ??= await openLovableClient();
          const result = await runAll(client, opts.once ? "once" : kind);
          console.log(
            `Sync run ${result.runId} (${kind}) ${result.ok ? "ok" : `failed: ${result.error}`} ${JSON.stringify(result.counts)}`,
          );
        } catch (err) {
          // Opening the client failed (expired grant, network): drop it so the
          // next tick reconnects rather than reusing a dead transport.
          await closeClient();
          console.error(
            `Sync run could not start: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      if (opts.once) return;
      await sleep(tickMs);
    }
  } finally {
    await closeClient();
  }
}

/** One pass regardless of the window, for `--once` and crontab use. */
export async function runOnce(): Promise<{ ok: boolean; ran: boolean; error?: string }> {
  if (!status().connected) {
    console.log("Not connected — run `npm run harness:executor -- --connect`");
    return { ok: false, ran: false, error: "not connected" };
  }
  const running = store.runningSyncRun();
  if (running) {
    console.log(`A sync is already running (run ${running.id}, started ${running.started_at}).`);
    return { ok: true, ran: false, error: "already running" };
  }
  const client = await openLovableClient();
  try {
    const result = await runAll(client, "once");
    console.log(
      `Sync run ${result.runId} ${result.ok ? "ok" : `failed: ${result.error}`} ${JSON.stringify(result.counts)}`,
    );
    return { ok: result.ok, ran: true, ...(result.error ? { error: result.error } : {}) };
  } finally {
    await client.close().catch(() => {});
  }
}
