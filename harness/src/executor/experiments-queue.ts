/**
 * Round 6 Task 6b: the background queue behind "Test this rule" (spec §6
 * "Run ... background job with progress"). startExperiment (experiments.ts)
 * only ever inserts a `queued` row -- it never drives the run itself, so a
 * `test` action's own request can return immediately. Something has to pick
 * that row up and actually call runExperiment; this module is that
 * something.
 *
 * kickExperimentRunner is meant to be called from two places: right after a
 * successful `test` action (so the run starts promptly), and at the end of
 * every executor pass (runAll, beats.ts) so a run that was still `queued`
 * when the process died gets picked up again on the next sync/scheduler
 * tick, without anyone having to press anything. Both call sites fire this
 * and move on -- the module-level `inFlight` promise is what makes that
 * safe to do from two places at once: a second call while one run is still
 * driving just returns the SAME promise (a no-op from the caller's own
 * point of view) rather than starting a second one. It IS still awaitable
 * (tests await it directly), just never awaited by production callers --
 * that is what "fire-and-forget behind an in-flight flag" means here.
 */
import * as store from "../store.js";
import { runExperiment } from "./experiments.js";
import { createLovableRest, type LovableRest } from "./lovable-rest.js";

// Same crash-window convention runningExperimentRun/activeExperimentRun
// already use elsewhere (Task 1/6a): a copying/building row with no
// heartbeat in the last 20 minutes is presumed crashed, not still running.
const CRASH_WINDOW_MINUTES = 20;

// Round 6 fix wave item 3 (queue crash recovery): the sentence a run that
// was mid-flight when the process died is marked failed with, before this
// same kick ever looks for a queued row to start next. Without this, a
// copying/building row whose heartbeat has gone stale is invisible to
// runningExperimentRun (by design -- see its own doc comment) but was never
// actually closed out either, so its card/judging screen would read
// "Testing… copying the project" forever.
const CRASH_RESTART_MESSAGE = "Harness Ledger restarted while the test was running.";

let inFlight: Promise<void> | null = null;

/**
 * If nothing is currently driving a run (no copying/building row with a
 * recent heartbeat) and a `queued` row exists, drives the OLDEST queued run
 * (store.listExperimentRuns orders newest-first, so the last element of a
 * queued-only filter is the oldest) to completion via runExperiment, behind
 * one Lovable REST client instance built just for that run (createLovableRest
 * reused as deps.rest across the whole run -- one instance per run, since
 * allowCopy() state lives on that instance). A no-op (resolves immediately)
 * when a run is already in flight, nothing is queued, or one is already
 * copying/building with a live heartbeat.
 */
export function kickExperimentRunner(deps?: {
  rest?: LovableRest;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<void> {
  if (inFlight) return inFlight;

  if (store.runningExperimentRun(CRASH_WINDOW_MINUTES)) return Promise.resolve();

  // Round 6 fix wave item 3: close out a crashed run (its own heartbeat is
  // stale, so runningExperimentRun above doesn't see it as "running" either)
  // before ever starting the next one -- same as store.staleExperimentRun's
  // own doc comment.
  const stale = store.staleExperimentRun(CRASH_WINDOW_MINUTES);
  if (stale) {
    store.updateExperimentRun(stale.id, {
      status: "failed",
      error: CRASH_RESTART_MESSAGE,
      finished_at: new Date().toISOString(),
    });
  }

  const queued = store.listExperimentRuns({ status: ["queued"] });
  if (queued.length === 0) return Promise.resolve();
  const oldest = queued[queued.length - 1]!;

  const rest = deps?.rest ?? createLovableRest();
  const run = runExperiment(oldest.id, { rest, sleep: deps?.sleep, now: deps?.now })
    .catch(() => {
      // runExperiment itself never throws (every failure is written to the
      // run's own row) -- this catch exists only so a programming error here
      // can never leave an unhandled rejection behind.
    })
    .then(() => {});
  inFlight = run;
  void run.finally(() => {
    inFlight = null;
  });
  return run;
}

/** Test-only: clears the in-flight flag so each test starts clean, the same
 * convention lock.ts/other module-level-state modules in this codebase use. */
export function _reset(): void {
  inFlight = null;
}
