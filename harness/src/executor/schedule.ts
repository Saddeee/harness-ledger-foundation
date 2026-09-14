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
import {
  acquireLock,
  currentLockHolder,
  defaultLockPath,
  heartbeat,
  releaseLock,
  type LockOwner,
} from "./lock.js";

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

// Round 6 Task 2: the pretty name for the OTHER owner, for both directions
// of the "someone else already has the schedule" message (the CLI's loop
// refused because the app holds it, and vice versa).
function otherOwnerLabel(owner: LockOwner): string {
  return owner === "app" ? "the app" : "the executor process";
}

/**
 * The scheduler. One tick decides at most one sync run: an explicit "Sync
 * now" beats the schedule, and a sync run already in flight beats both. The
 * Lovable client is opened lazily on the first run and reused afterwards.
 * Analysis (above) is checked every tick too, independent of all of this.
 *
 * Round 6 Task 2: driving Lovable at all requires holding the executor
 * process lock (executor/lock.ts) under `owner` ("cli" for a plain `npm run
 * harness:executor`, "app" for the web server's own in-app scheduler --
 * see startInAppScheduler below). A lock already held by the OTHER owner
 * means a second driver is not allowed to run at all: this call logs once
 * and returns immediately, touching neither Lovable nor the lock file.
 * Once acquired, the lock is heartbeated every tick and released when the
 * loop exits for any reason (including the lock being lost to someone else
 * mid-run, which this loop treats as its own cue to stop).
 */
export async function loop(
  opts: { tickMs?: number; once?: boolean; owner?: LockOwner } = {},
): Promise<void> {
  const tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
  const owner = opts.owner ?? "cli";
  const lockPath = defaultLockPath();

  const acquired = acquireLock(lockPath, owner);
  if (!acquired.held) {
    const holder = acquired.holder;
    console.log(
      holder
        ? `${otherOwnerLabel(holder.owner)} is already running the schedule (pid ${holder.pid})`
        : "the schedule lock is already held; not starting a second driver",
    );
    return;
  }

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
      const hb = heartbeat(lockPath);
      if (!hb.ok) {
        console.log(
          hb.holder
            ? `Lost the schedule lock to ${otherOwnerLabel(hb.holder.owner)} (pid ${hb.holder.pid}) -- stopping.`
            : "Lost the schedule lock -- stopping.",
        );
        return;
      }

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
            result.ran
              ? `Sync run ${result.runId} (${kind}) ${result.ok ? "ok" : `failed: ${result.error}`} ${JSON.stringify(result.counts)}`
              : `Sync (${kind}) not started: ${result.error}`,
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
    releaseLock(lockPath);
  }
}

// ---- Round 6 Task 2 ----
/** Guards a single `startInAppScheduler()` call per server process --
 * `loadHarnessExecutor()` (the web app's local-runtime bridge) calls this
 * once, the first time it successfully loads the executor bundle; this flag
 * stops a second call (e.g. a later cache-miss retry) from starting a
 * second background loop in the same process. */
let inAppSchedulerStarted = false;

/**
 * Starts the schedule inside the web server's own process, so a separately
 * started `npm run harness:executor` is never required for syncing to run
 * (spec §2). Acquires the executor lock as "app" and, if won, runs `loop()`
 * in the background (not awaited -- this call returns immediately once the
 * lock has been claimed or refused, since acquireLock itself is
 * synchronous). If the lock is already held by a `cli` driver, this logs
 * once and does nothing further: the app simply does not sync until that
 * CLI process exits or its heartbeat goes stale.
 *
 * SIGTERM releases the lock explicitly (`loop()`'s own `finally` only runs
 * if the process unwinds normally; a container/orchestrator SIGTERM does
 * not wait for that) so a restarted app, or a `npm run harness:executor`
 * started right after, does not have to wait out the 3-minute staleness
 * window for a lock its own previous instance is done with.
 */
export function startInAppScheduler(opts: { tickMs?: number } = {}): void {
  if (inAppSchedulerStarted) return;
  inAppSchedulerStarted = true;

  const lockPath = defaultLockPath();
  void loop({ tickMs: opts.tickMs ?? 60_000, owner: "app" }).catch((err) => {
    console.error(
      `The in-app schedule stopped: ${err instanceof Error ? err.message : String(err)}`,
    );
  });

  process.once("SIGTERM", () => releaseLock(lockPath));
}
// ---- end Round 6 Task 2 ----

/** "Analyse now" from the app: start the requested run right away instead
 * of on the next scheduler tick (up to a minute later), but only in the
 * process that runs the schedule -- another process leaves it to its
 * scheduler. Fire-and-forget; maybeRunAnalysis never throws. */
export function kickAnalysisNow(): void {
  if (!inAppSchedulerStarted) return;
  const holder = currentLockHolder(defaultLockPath());
  if (!holder || holder.pid !== process.pid) return;
  void maybeRunAnalysis();
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
      result.ran
        ? `Sync run ${result.runId} ${result.ok ? "ok" : `failed: ${result.error}`} ${JSON.stringify(result.counts)}`
        : `Sync not started: ${result.error}`,
    );
    // Fix round 1 item 3: runAll's own tryStartSyncRun is now the source of
    // truth for "did this actually run" -- the plain runningSyncRun() check
    // above is still a fast pre-check, but the two can race (an await gap
    // between them and this call), so this reflects whatever runAll itself
    // decided, not an assumption that reaching this line means it ran.
    return { ok: result.ok, ran: result.ran, ...(result.error ? { error: result.error } : {}) };
  } finally {
    await client.close().catch(() => {});
  }
}
