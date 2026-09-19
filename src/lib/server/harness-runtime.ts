// Bridges this app's server routes to the local-only Harness SQLite adapter
// (harness/src/adapter.ts, compiled to harness/dist/adapter.js). Only used
// when HARNESS_RUNTIME=local. On the hosted deployment better-sqlite3 cannot
// run at all (this app's Nitro target is Cloudflare, which has no native
// Node addon support), so every caller must treat a null return as a normal
// "hosted preview" state, never crash.
//
// The import path points at compiled output, not harness/src/*.ts directly,
// so that loading it never depends on this app's own Vite/TS toolchain
// being able to transform a sibling package's TypeScript at runtime. Run
// `npm run harness:build` once (or after editing harness/) before using
// HARNESS_RUNTIME=local locally.
type HarnessAdapter = typeof import("../../../harness/dist/adapter.js");

let cached: HarnessAdapter | null | undefined;

export async function loadHarnessAdapter(): Promise<HarnessAdapter | null> {
  if (cached !== undefined) return cached;
  if (process.env["HARNESS_RUNTIME"] !== "local") {
    cached = null;
    return cached;
  }
  try {
    cached = await import(/* @vite-ignore */ "../../../harness/dist/adapter.js");
  } catch {
    cached = null;
  }
  return cached;
}

// Same guard and caching shape as loadHarnessAdapter, but for the executor
// modules the knowledge/executor/projects routes need: connecting to
// Lovable, computing the next scheduled run, checking whether the
// configured AI-analysis provider is actually usable (Round 4 Task A3 --
// harness/src/analysis/run.ts's providerReady, itself never calling
// Lovable), running a sync/single-version write inline from a request
// (Round 6 Task 2 -- beats.js), and reading who currently holds the
// executor process lock (lock.js). Everything else Lovable touches stays
// server-side, driven from this same process now (see
// startInAppScheduler below) rather than a separate `npm run
// harness:executor`; the analysis run itself (classify/segment/mine) is
// the one piece that still only ever gets asked "could this run?" here.
type HarnessExecutor = {
  auth: typeof import("../../../harness/dist/executor/lovable-auth.js");
  schedule: typeof import("../../../harness/dist/executor/schedule.js");
  mcp: typeof import("../../../harness/dist/executor/lovable-mcp.js");
  analysis: typeof import("../../../harness/dist/analysis/run.js");
  beats: typeof import("../../../harness/dist/executor/beats.js");
  lock: typeof import("../../../harness/dist/executor/lock.js");
};

let cachedExecutor: HarnessExecutor | null | undefined;

// Round 6 Task 2: startInAppScheduler() (harness/src/executor/schedule.ts)
// is started at most once per server process -- guarded here, not inside
// that function alone, so a later loadHarnessExecutor() call (once
// cachedExecutor is already set) never even reaches it again.
let inAppSchedulerStarted = false;

export async function loadHarnessExecutor(): Promise<HarnessExecutor | null> {
  if (cachedExecutor !== undefined) return cachedExecutor;
  if (process.env["HARNESS_RUNTIME"] !== "local") {
    cachedExecutor = null;
    return cachedExecutor;
  }
  try {
    const [auth, schedule, mcp, analysis, beats, lock] = await Promise.all([
      import(/* @vite-ignore */ "../../../harness/dist/executor/lovable-auth.js"),
      import(/* @vite-ignore */ "../../../harness/dist/executor/schedule.js"),
      import(/* @vite-ignore */ "../../../harness/dist/executor/lovable-mcp.js"),
      import(/* @vite-ignore */ "../../../harness/dist/analysis/run.js"),
      import(/* @vite-ignore */ "../../../harness/dist/executor/beats.js"),
      import(/* @vite-ignore */ "../../../harness/dist/executor/lock.js"),
    ]);
    cachedExecutor = { auth, schedule, mcp, analysis, beats, lock };

    // The app drives the sync schedule itself now (spec §2) -- started
    // once the executor bundle is confirmed loadable, guarded so a second
    // call (or a route hit again after the first) never starts a second
    // background loop in this same process. startInAppScheduler itself
    // does nothing further if a `npm run harness:executor` CLI process
    // already holds the schedule lock.
    if (!inAppSchedulerStarted) {
      inAppSchedulerStarted = true;
      try {
        schedule.startInAppScheduler();
      } catch (err) {
        console.error(
          `Could not start the in-app schedule: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } catch {
    cachedExecutor = null;
  }
  return cachedExecutor;
}

export function hostedPreviewBody(detail?: string) {
  return {
    available: false as const,
    reason:
      detail ??
      "This is the hosted preview. Harness Ledger runs on your own computer: clone the repository and run it locally to see your data.",
  };
}
