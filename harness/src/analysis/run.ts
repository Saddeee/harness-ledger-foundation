// Round 4 Task A3: analysis runs and the "Analyse now" trigger -- the one
// place that turns an open analysis_requests row into
// classify -> segment -> mine and always finishes its analysis_runs row,
// exactly the way executor/beats.ts's runAll always finishes its
// sync_runs row for a sync. See docs/superpowers/plans/2026-09-11-round-4.md
// Task A3 and the spec's §2 ("Analysis runs only when you press Analyse
// now" -- independent of the Lovable connection; a per-run cap of 200
// calls).
import * as store from "../store.js";
import type { CallLlm, LlmProvider } from "../llm/types.js";
import { classifyPending } from "./classify.js";
import { segmentAllProjects } from "./segment.js";
import { mineEpisodes } from "./mine.js";
import { keyStatus } from "../llm-keys.js";
import { defaultExec, type Exec } from "../llm/claude-code.js";

/** Per-run cap on LLM calls (spec §2): classify gets at most this many of it. */
const PER_RUN_CALL_CAP = 200;
const CLASSIFY_CALL_CAP = 150;

export type ProviderReady = { ok: true } | { ok: false; reason: string };

type LlmModelsSetting = Partial<Record<"classifier" | "miner", { provider: string }>>;

/**
 * The provider(s) a real run would actually dispatch to: the classifier and
 * miner roles (segmentAllProjects makes no LLM call at all), read from the
 * llm_models setting with the same "fall back to the global llm_provider"
 * defense-in-depth harness/src/llm/index.ts's own resolveRoleModel uses if
 * llm_models fails to parse or a role entry is missing.
 */
function providersInUse(): LlmProvider[] {
  let models: LlmModelsSetting = {};
  try {
    models = JSON.parse(store.getSetting("llm_models")) as LlmModelsSetting;
  } catch {
    models = {};
  }
  const fallback = store.getSetting("llm_provider") as LlmProvider;
  const providers = new Set<LlmProvider>();
  for (const role of ["classifier", "miner"] as const) {
    providers.add((models[role]?.provider as LlmProvider | undefined) ?? fallback);
  }
  return [...providers];
}

// Fix round 1: providerReady() is called on every executor route GET (the
// Inbox/Instructions notices poll it), so a claude_code setup was spawning
// `claude --version` on every page load. The CLI check itself is cheap but
// not free (a real process spawn) and its answer changes at most as often
// as the CLI is installed/removed -- a 60-second memo is plenty fresh for a
// UI status line. Key checks (harness/src/llm-keys.ts's keyStatus) stay
// live/uncached: they're a local file read, not a process spawn, and must
// reflect a key the user just saved immediately.
const CLAUDE_CODE_CHECK_TTL_MS = 60_000;
let claudeCodeCheckCache: { at: number; result: ProviderReady } | null = null;

async function checkClaudeCode(exec: Exec, now: () => number): Promise<ProviderReady> {
  const nowMs = now();
  if (claudeCodeCheckCache && nowMs - claudeCodeCheckCache.at < CLAUDE_CODE_CHECK_TTL_MS) {
    return claudeCodeCheckCache.result;
  }
  const raw = await exec("claude", ["--version"], "").catch(() => null);
  const result: ProviderReady =
    raw && raw.code === 0
      ? { ok: true }
      : { ok: false, reason: "Claude Code was not found on this machine." };
  claudeCodeCheckCache = { at: nowMs, result };
  return result;
}

/**
 * Checks the provider(s) a run would use are actually usable before
 * spending a single LLM call: an API provider (openai/anthropic/google)
 * needs a stored key (harness/src/llm-keys.ts, checked live every call);
 * claude_code needs the CLI on PATH, checked via an injectable `exec` (so
 * tests never spawn the real binary) and memoized for 60 seconds (see
 * checkClaudeCode above). Returns the first reason found, in role order
 * (classifier before miner) -- there is normally only one distinct
 * provider across both roles. `deps.now` is injectable for tests to
 * control the memo window without a real 60-second wait.
 */
export async function providerReady(deps?: {
  exec?: Exec;
  now?: () => number;
}): Promise<ProviderReady> {
  const exec = deps?.exec ?? defaultExec;
  const now = deps?.now ?? Date.now;
  for (const provider of providersInUse()) {
    if (provider === "claude_code") {
      const result = await checkClaudeCode(exec, now);
      if (!result.ok) return result;
    } else {
      const status = keyStatus()[provider];
      if (!status?.has_key) {
        return { ok: false, reason: `No API key saved for ${provider}. Add one in Settings.` };
      }
    }
  }
  return { ok: true };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export type AnalysisCounts = {
  classified: number;
  failed: number;
  episodes_created: number;
  proposed: number;
  skipped_duplicate: number;
  rejected: number;
};

export type RunAnalysisResult = {
  runId: number;
  ok: boolean;
  counts: AnalysisCounts;
  tokens: number;
  costUsd: number;
  error?: string;
};

const EMPTY_COUNTS: AnalysisCounts = {
  classified: 0,
  failed: 0,
  episodes_created: 0,
  proposed: 0,
  skipped_duplicate: 0,
  rejected: 0,
};

/**
 * One full analysis pass: takes any open "Analyse now" requests, checks the
 * configured provider is actually usable, then
 * classify -> segment (every allowed project) -> mine. `opts.maxCalls`
 * (default 200, spec §2's per-run cap) is split between classify (up to
 * 150 of it) and mine (whatever classify didn't use); segment makes no LLM
 * call at all. Never throws: a provider-not-ready result, or any step
 * throwing, still finishes the analysis_runs row with ok:false and the
 * reason/message, and still completes every request this run took.
 */
export async function runAnalysis(
  callLlm: CallLlm,
  kind: "manual" | "scheduled" = "manual",
  opts: { maxCalls?: number } = {},
): Promise<RunAnalysisResult> {
  const runId = store.startAnalysisRun(kind);
  const requestIds: number[] = [];
  for (;;) {
    const id = store.takeAnalysisRequest(runId);
    if (id === null) break;
    requestIds.push(id);
  }

  const maxCalls = opts.maxCalls ?? PER_RUN_CALL_CAP;
  const counts: AnalysisCounts = { ...EMPTY_COUNTS };
  let ok = true;
  let error: string | undefined;

  try {
    const ready = await providerReady();
    if (!ready.ok) {
      ok = false;
      error = ready.reason;
    } else {
      const classifyLimit = Math.max(0, Math.min(CLASSIFY_CALL_CAP, maxCalls));
      const classifyResult = await classifyPending(callLlm, { limit: classifyLimit, runId });
      counts.classified = classifyResult.classified;
      counts.failed += classifyResult.failed;

      const segmentResult = segmentAllProjects();
      counts.episodes_created = segmentResult.created;

      const callsUsed = classifyResult.classified + classifyResult.failed;
      const mineLimit = Math.max(0, maxCalls - callsUsed);
      if (mineLimit > 0) {
        const mineResult = await mineEpisodes(callLlm, { limit: mineLimit, runId });
        counts.proposed = mineResult.proposed;
        counts.skipped_duplicate = mineResult.skippedDuplicate;
        counts.rejected = mineResult.skippedNoProposal;
        counts.failed += mineResult.failed;
      }
    }
  } catch (err) {
    ok = false;
    error = errorMessage(err);
  }

  const tokens = store.sumLlmTokensForRun(runId);
  const costUsd = store.sumLlmCostForRun(runId);
  store.finishAnalysisRun(runId, {
    ok,
    error: error ?? null,
    counts: counts as unknown as Record<string, number>,
    tokens,
    cost_usd: costUsd,
  });
  for (const id of requestIds) store.completeAnalysisRequest(id);

  return { runId, ok, counts, tokens, costUsd, ...(error ? { error } : {}) };
}

export type RunAnalyseCommandResult = { ran: true; result: RunAnalysisResult } | { ran: false };

/**
 * Fix round 1: the single entry point for a manual "Analyse now" trigger
 * from outside the scheduler loop (the `--analyse` CLI flag). Queues an
 * `analysis_requests` row first -- coalesced with any request already open,
 * exactly like the UI's "Analyse now" button -- so a CLI-triggered run
 * leaves the same audit trail (a request row, `done` and linked to the run
 * that consumed it) a UI-triggered one does; previously `--analyse` called
 * runAnalysis directly with no request at all, invisible to that trail.
 * Then, unless a run is already in flight (store.runningAnalysisRun's own
 * 15-minute crash window -- the same guard schedule.ts's loop and
 * executor/schedule.ts's runOnce use for sync), runs it, which consumes the
 * request just queued (and any other still open). Never calls the LLM when
 * a run is already running; prints its own status line either way, exactly
 * like schedule.ts's runOnce does for sync, so cli.ts only has to decide
 * the exit code.
 */
export async function runAnalyseCommand(callLlm: CallLlm): Promise<RunAnalyseCommandResult> {
  store.requestAnalysis();

  const running = store.runningAnalysisRun();
  if (running) {
    console.log(
      `An analysis is already running (run ${running.id}, started ${running.started_at}).`,
    );
    return { ran: false };
  }

  const result = await runAnalysis(callLlm, "manual");
  console.log(
    `Analysis run ${result.runId} ${result.ok ? "ok" : `failed: ${result.error}`} ${JSON.stringify(result.counts)} tokens=${result.tokens}`,
  );
  return { ran: true, result };
}
