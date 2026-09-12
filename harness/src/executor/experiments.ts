/**
 * Round 6 Task 6a: the paired-test runner (spec §6, "The paired test (Phase
 * B), finally"). Given a correction candidate that already carries a rule,
 * this copies the user's real Lovable project at the moment before the
 * request that produced the correction (Lovable "remix ... before"), writes
 * the rule under test into the copy's Knowledge, replays the exact original
 * request against the copy, waits for the build, and records everything the
 * judging screen (a later task) needs to show side by side with what
 * actually happened -- then deletes the copy (or, failing that, sets it
 * private and leaves a note).
 *
 * Every Lovable call goes through the injected LovableRest client
 * (lovable-rest.ts); this module never imports the Lovable MCP client and
 * never opens a network connection of its own. The first real run is the
 * owner's own button press (Task 6b's wiring calls runExperiment); nothing
 * here may be invoked by anything else. No test in this repo may reach
 * Lovable -- see experiments.test.ts, which scripts a fake REST server
 * (test/fake-lovable.ts) for every case below.
 */
import * as store from "../store.js";
import type { ExperimentRunRow } from "../store.js";
import { composeManagedKnowledge } from "../knowledge.js";
import { humanVisibleText } from "../analysis/reply-text.js";
import { status as lovableConnectionStatus } from "./lovable-auth.js";
import { LovableRestError, type LovableRest } from "./lovable-rest.js";

// ---------------------------------------------------------------- tuning
//
// Poll cadences and timeouts straight from spec §6's own "Run" steps 1 and
// 3. REPLY_CHAR_CAP/DIFF_LINE_CAP are the judging screen's own limits (spec
// §6 record step) -- capped here, once, rather than by every future reader
// of these columns.

const REMIX_POLL_MS = 2_000;
const REMIX_TIMEOUT_MS = 5 * 60_000;
const BUILD_POLL_MS = 20_000;
const BUILD_TIMEOUT_MS = 15 * 60_000;
const REPLY_CHAR_CAP = 4_000;
const DIFF_LINE_CAP = 400;
// How many of the source project's most recent edits to look at when
// counting how many landed after the episode started (store.countEditsSince
// is a pure filter over whatever this fetches -- it does not paginate on
// its own). Generous enough that a real project's edit history since one
// episode is very unlikely to spill past it; this is a secondary,
// non-credited read, not something worth a full pagination loop for.
const EDITS_SINCE_LIMIT = 200;

const NOT_CONNECTED_REFUSAL = "Harness is not connected — connect on the Projects page.";
const NO_REQUEST_REFUSAL = "This suggestion has no original request to replay.";
const ALREADY_RUNNING_REFUSAL = "A test is already running; one runs at a time.";

// --------------------------------------------------------------- helpers

/** The one correction_candidates row (joined with its episode) that matches
 * this id, via the same listCorrectionCandidates() read every other reader
 * of a candidate + its episode already uses (buildImprovement/getImprovement
 * in improvements.ts). Not a dedicated single-row query -- there isn't one
 * exported for "a candidate with its episode's project_id/started_at" today,
 * and this module may not add one (store.ts is Task 2's file this round). */
type CandidateEpisodeRow = {
  id: number;
  task_episode_id: number;
  project_id: string | null;
  episode_started_at: string | null;
};

function findCandidateEpisode(correctionCandidateId: number): CandidateEpisodeRow | undefined {
  return (store.listCorrectionCandidates() as unknown as CandidateEpisodeRow[]).find(
    (c) => c.id === correctionCandidateId,
  );
}

function clipTitle(text: string, max = 40): string {
  return text.length > max ? text.slice(0, max) : text;
}

/** Splits a unified-diff-shaped string (LovableRest#getDiff's own return
 * shape) into at most DIFF_LINE_CAP lines, same convention for both the
 * copy's diff and the source project's original diff. */
function capDiff(diffText: string): { lines: string[]; truncated: boolean } {
  if (!diffText) return { lines: [], truncated: false };
  const allLines = diffText.split("\n");
  return { lines: allLines.slice(0, DIFF_LINE_CAP), truncated: allLines.length > DIFF_LINE_CAP };
}

/** The Knowledge snapshot this run's copy should start from: the newest
 * snapshot at or before the episode's own started_at (so the copy's
 * Knowledge, like its code, reflects "before your request" as closely as
 * Harness's own snapshot history allows), else the newest snapshot at all,
 * else "" when there is no snapshot on file yet. `snapshots` must be oldest
 * first (listKnowledgeSnapshots' own order) -- a pure function over that
 * list (rather than a store.ts query of its own) so it's directly testable
 * without backdating rows in a real database. Exported for that reason. */
export function knowledgeBaseAtOrBefore(
  snapshots: { content: string; fetched_at: string }[],
  episodeStartedAt: string | null,
): string {
  if (episodeStartedAt) {
    let picked: string | null = null;
    for (const snap of snapshots) {
      if (snap.fetched_at <= episodeStartedAt) picked = snap.content;
      else break;
    }
    if (picked !== null) return picked;
  }
  if (snapshots.length > 0) return snapshots[snapshots.length - 1]!.content;
  return "";
}

/** A plain sentence for every non-`completed` terminal build status
 * (fix round 1 item 1) -- `stopped`/`awaiting_input`/`error` each get their
 * own named copy; anything else (a status this client's toRestBuildStatus
 * passed through raw rather than recognizing) names the status itself so
 * the owner isn't left with a generic "something went wrong". */
function buildFailureMessage(status: string): string {
  switch (status) {
    case "stopped":
      return "Lovable stopped without finishing the build in the copy.";
    case "awaiting_input":
      return "Lovable is waiting for more input; the test could not complete.";
    case "error":
      return "Lovable reported an error while building in the copy.";
    default:
      return `Lovable returned an unexpected build status: ${status}.`;
  }
}

/** A plain sentence for experiment_runs.error -- LovableRestError's own
 * "reconnect" signal (a 401) gets the owner-facing copy the brief specifies
 * verbatim; anything else is the thrown error's own message, which every
 * throw site in this module already writes as a plain sentence. */
function errorMessage(err: unknown): string {
  if (err instanceof LovableRestError && err.reason === "reconnect") {
    return "Lovable asked Harness to reconnect.";
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

// ----------------------------------------------------------- startExperiment

/** Opens a new paired-test attempt for a correction candidate that already
 * has a rule -- refusals in the exact order and copy spec §6 gives, before
 * ever touching Lovable. `deps.rest` is accepted (not used by any refusal
 * check) purely so callers can construct one LovableRest instance and pass
 * it to both startExperiment and runExperiment, the same shape runExperiment
 * itself takes. `deps.connected` defaults to the real
 * lovable-auth.ts#status().connected but is overridable for tests. */
export async function startExperiment(
  candidateId: number,
  deps: { rest: LovableRest; connected?: () => boolean },
): Promise<{ run_id: number } | { refused: string }> {
  const isConnected = deps.connected ?? (() => lovableConnectionStatus().connected);
  if (!isConnected()) {
    return { refused: NOT_CONNECTED_REFUSAL };
  }

  const candidate = findCandidateEpisode(candidateId);
  const rule = store.getRuleForCorrection(candidateId) as {
    id: number;
    instruction: string;
  } | null;
  const requestExternalId =
    candidate?.project_id != null
      ? store.episodeRequestExternalId(candidate.task_episode_id)
      : null;

  // Any of "no such candidate", "its episode has no project", "no rule was
  // ever built for it yet", or "its episode has no evidence message at all"
  // means the same thing to the owner: there is nothing to replay.
  if (!candidate || candidate.project_id == null || !rule || !requestExternalId) {
    return { refused: NO_REQUEST_REFUSAL };
  }

  if (store.activeExperimentRun(20)) {
    return { refused: ALREADY_RUNNING_REFUSAL };
  }

  const budget = Number(store.getSetting("lovable_monthly_credit_budget"));
  const usedThisMonth = store.creditsThisMonth();
  const projectedCost = store.lastKnownTestCost() ?? 2;
  if (usedThisMonth + projectedCost > budget) {
    return {
      refused: `This would exceed your monthly Lovable credit budget (${usedThisMonth} of ${budget} used).`,
    };
  }

  const { id } = store.createExperimentRun({
    rule_id: rule.id,
    correction_candidate_id: candidateId,
    task_episode_id: candidate.task_episode_id,
    source_project_id: candidate.project_id,
    request_message_external_id: requestExternalId,
  });
  return { run_id: id };
}

// ------------------------------------------------------------- runExperiment

type GetMessageResult = Awaited<ReturnType<LovableRest["getMessage"]>>;

/** Drives one queued run all the way through spec §6's Run steps: copy,
 * Knowledge, build, record, cleanup, hand off to the owner. Never throws --
 * any failure at any step is caught, written to the run as `status: failed`
 * + a plain-sentence `error`, and cleanup is still attempted (the copy may
 * already exist and be worth real Lovable credits even though the run
 * didn't finish). Always returns the run's own row as it stands when this
 * returns, whichever way it went. `deps.sleep`/`deps.now` default to real
 * timers; tests inject a no-op sleep (and, where a poll loop's own timeout
 * matters, a controllable now) so nothing here ever waits in real time. */
export async function runExperiment(
  runId: number,
  deps: { rest: LovableRest; sleep?: (ms: number) => Promise<void>; now?: () => number },
): Promise<ExperimentRunRow> {
  const rest = deps.rest;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => Date.now());

  const initial = store.getExperimentRun(runId);
  if (!initial) throw new Error(`experiment run ${runId} not found`);
  const source = initial.source_project_id;

  try {
    const ruleDetail = store.getRule(initial.rule_id) as { rule: { instruction: string } } | null;
    const ruleInstruction = ruleDetail?.rule.instruction ?? "";

    // ---- 1. copy the project at the moment before the request (spec §6 Run 1) ----
    store.updateExperimentRun(runId, {
      status: "copying",
      stage_note: "Copying the project at the moment before your request",
    });

    const { job_id } = await rest.remixInit(source, {
      message_id: initial.request_message_external_id,
      remix_mode: "before",
      include_history: false,
      include_custom_knowledge: false,
      skip_initial_remix_message: true,
      project_name: `Harness test: ${clipTitle(ruleInstruction)}`,
    });

    const remixStart = now();
    let copyProjectId: string | null = null;
    for (;;) {
      store.updateExperimentRun(runId, {
        stage_note: "Copying the project at the moment before your request",
      });
      const progress = await rest.remixProgress(source, job_id);
      if (progress.status === "completed") {
        copyProjectId = progress.project_id ?? null;
        break;
      }
      if (progress.status === "failed") {
        throw new Error(
          progress.error
            ? `Copying the project failed: ${progress.error}`
            : "Copying the project failed.",
        );
      }
      if (now() - remixStart >= REMIX_TIMEOUT_MS) {
        throw new Error("Copying the project timed out.");
      }
      await sleep(REMIX_POLL_MS);
    }
    if (!copyProjectId) {
      throw new Error("Copying the project finished without producing a copy.");
    }
    // Registers the copy (and only the copy) as chattable -- rest.chat()
    // below refuses any id that was never allowCopy()'d, so a bug that
    // somehow passed `source` instead fails loudly rather than spending the
    // owner's real project's credits.
    rest.allowCopy(copyProjectId);
    store.updateExperimentRun(runId, { copy_project_id: copyProjectId });

    // ---- 2. Knowledge = historical snapshot + the rule under test (spec §6 Run 2) ----
    const candidateEpisode = findCandidateEpisode(initial.correction_candidate_id);
    const episodeStartedAt = candidateEpisode?.episode_started_at ?? null;
    const snapshots = store.listKnowledgeSnapshots("project", source);
    const baseContent = knowledgeBaseAtOrBefore(snapshots, episodeStartedAt);
    const composed = composeManagedKnowledge(baseContent, [
      { id: initial.rule_id, instruction: ruleInstruction },
    ]);
    await rest.setProjectKnowledge(copyProjectId, composed.final_content);

    // ---- 3. build in the copy (spec §6 Run 3) ----
    store.updateExperimentRun(runId, { status: "building", stage_note: "Building in the copy" });

    // episodeRequestText (fix round 1), not episodeTextForJudge's own
    // `request` -- that one is capped at 1500 chars for the judge screen;
    // the runner replays the owner's original request in full.
    const requestText = store.episodeRequestText(initial.task_episode_id) ?? "";
    const { message_id: copyMessageId, thread_id: copyThreadId } = await rest.chat(
      copyProjectId,
      requestText,
    );
    store.updateExperimentRun(runId, {
      copy_message_id: copyMessageId,
      copy_thread_id: copyThreadId,
    });

    const buildStart = now();
    let finalMessage: GetMessageResult | null = null;
    for (;;) {
      store.updateExperimentRun(runId, { stage_note: "Building in the copy" });
      const msg = await rest.getMessage(copyProjectId, copyMessageId, { thread_id: copyThreadId });
      if (msg.status !== "running") {
        finalMessage = msg;
        break;
      }
      if (now() - buildStart >= BUILD_TIMEOUT_MS) {
        throw new Error("Building in the copy timed out.");
      }
      await sleep(BUILD_POLL_MS);
    }
    // Fix round 1 item 1: only a `completed` build is judgeable. Every
    // other terminal status (stopped, awaiting_input, error, or anything
    // this client doesn't otherwise name -- toRestBuildStatus, fix round 1
    // item 2, now passes those through instead of guessing "running") fails
    // the run with its own distinct, plain-sentence error; cleanup still
    // runs via the outer catch below.
    if (finalMessage.status !== "completed") {
      throw new Error(buildFailureMessage(finalMessage.status));
    }

    // ---- 4. record results (spec §6 Run 4) ----
    const copyDiffText = await rest.getDiff(copyProjectId, { message_id: copyMessageId });
    store.updateExperimentRun(runId, {
      copy_commit_sha: finalMessage.commit_sha ?? null,
      copy_summary: finalMessage.summary ?? null,
      copy_reply: humanVisibleText(finalMessage.content ?? "").slice(0, REPLY_CHAR_CAP),
      copy_diff_json: JSON.stringify(capDiff(copyDiffText)),
      cost_credits: finalMessage.cost_credits ?? null,
    });
    if (finalMessage.cost_credits !== undefined) {
      store.recordCredits(runId, finalMessage.cost_credits);
    }

    // Best effort: the source project's own commit/diff for the original
    // request -- neither failure here fails the whole run, since the copy's
    // own build already succeeded and is worth keeping. Fix round 1 minor:
    // separate try/catch per field, so a getDiff failure alone doesn't also
    // null out a commit_sha that getMessage already successfully returned.
    let originalCommitSha: string | null = null;
    try {
      const originalMessage = await rest.getMessage(source, initial.request_message_external_id);
      originalCommitSha = originalMessage.commit_sha ?? null;
    } catch {
      originalCommitSha = null;
    }
    let originalDiffJson: string | null = null;
    try {
      const originalDiffText = await rest.getDiff(source, {
        message_id: initial.request_message_external_id,
      });
      originalDiffJson = JSON.stringify(capDiff(originalDiffText));
    } catch {
      originalDiffJson = null;
    }

    // Fix round 1 item 4: also best effort -- an already-successful,
    // already-paid build must not be failed over a secondary read.
    let editsSinceEpisode: number | null = null;
    if (episodeStartedAt) {
      try {
        const edits = await rest.listEdits(source, { limit: EDITS_SINCE_LIMIT });
        editsSinceEpisode = store.countEditsSince(
          episodeStartedAt,
          edits.edits.map((e) => e.created_at),
        );
      } catch {
        editsSinceEpisode = null;
      }
    }

    store.updateExperimentRun(runId, {
      original_commit_sha: originalCommitSha,
      original_diff_json: originalDiffJson,
      edits_since_episode: editsSinceEpisode,
    });

    // ---- 5. cleanup (spec §6 Run 5) ----
    await cleanupCopy(store.getExperimentRun(runId)!, rest);

    // ---- 6. hand off to the owner (spec §6 Run 6) ----
    store.updateExperimentRun(runId, {
      status: "judging",
      finished_at: new Date(now()).toISOString(),
    });
  } catch (err) {
    store.updateExperimentRun(runId, {
      status: "failed",
      error: errorMessage(err),
      finished_at: new Date(now()).toISOString(),
    });
    const failed = store.getExperimentRun(runId);
    // cleanupCopy never throws (its own try/catch swallows every failure
    // mode internally), so no .catch is needed here.
    if (failed) await cleanupCopy(failed, rest);
  }

  return store.getExperimentRun(runId)!;
}

// -------------------------------------------------------------- cleanupCopy

/** Deletes the run's copy project unless the owner asked to keep test
 * copies -- a real, credit-bearing Lovable project, so this always runs,
 * success or failure, whenever a copy exists (runExperiment's own catch
 * calls this too). On a delete failure, falls back to making the copy
 * private (best effort of its own -- swallowed on failure, same as any
 * other cleanup step) and leaves a note store.listUndeletedCopies() (the
 * Projects page's own reminder, a later task) picks up. Never throws. */
export async function cleanupCopy(run: ExperimentRunRow, rest: LovableRest): Promise<void> {
  if (!run.copy_project_id) return;
  if (store.getSetting("keep_test_copies") === "true") return;

  try {
    await rest.deleteProject(run.copy_project_id);
    store.updateExperimentRun(run.id, { copy_deleted: 1 });
  } catch {
    try {
      await rest.setProjectVisibility(run.copy_project_id, "private");
    } catch {
      // Nothing more this module can do locally; the note below still
      // tells the owner to delete it by hand either way.
    }
    store.updateExperimentRun(run.id, {
      copy_cleanup_note:
        "Could not delete the test copy; it was set private. Delete it by hand in Lovable.",
    });
  }
}
