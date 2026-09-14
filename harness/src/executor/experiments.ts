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
import { ensureFreshLovableToken } from "./lovable-mcp.js";
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
// Round 7: Lovable takes a screenshot of a project's latest commit some time
// after a build; poll for one that belongs to that commit.
const SCREENSHOT_POLL_MS = 10_000;
const SCREENSHOT_POLL_ATTEMPTS = 18;
const DIFF_LINE_CAP = 400;
// How many of the source project's most recent edits to look at when
// counting how many landed after the episode started (store.countEditsSince
// is a pure filter over whatever this fetches -- it does not paginate on
// its own). Generous enough that a real project's edit history since one
// episode is very unlikely to spill past it; this is a secondary,
// non-credited read, not something worth a full pagination loop for.
// The real endpoint rejects limit > 50 (422); older pages come from
// `before` (an ISO timestamp). A live run with limit 200 recorded null.
const EDITS_PAGE_LIMIT = 50;
const EDITS_MAX_PAGES = 10;

// Round 6 fix wave item A: how far resolveRequestMessageId below pages
// through the source project's own message list (a free, uncredited read)
// looking for the REST id that matches the episode's own request, and how
// close (in wall-clock time) a message's created_at must be to the
// episode's own occurred_at to count as a fallback match when no content
// match is ever found. 20 pages of 50 (1,000 messages) is generous for the
// same reason EDITS_SINCE_LIMIT above is -- a real project's own request is
// very unlikely to sit past this many messages back.
const LIST_MESSAGES_MAX_PAGES = 20;
const LIST_MESSAGES_PAGE_LIMIT = 50;
const REQUEST_MATCH_WINDOW_MS = 90_000;

const NOT_CONNECTED_REFUSAL = "Harness is not connected — connect on the Projects page.";
const NO_REQUEST_REFUSAL = "This suggestion has no original request to replay.";
const ALREADY_RUNNING_REFUSAL = "A test is already running; one runs at a time.";
// Round 6 fix wave item A: the owner's own real first test failed with a
// bare Lovable 400 (invalid_message_id) because remixInit was called with
// the sync's own MCP list_messages id, a format the REST API's remix
// endpoint (and every other REST message_id-addressed endpoint) does not
// accept -- see resolveRequestMessageId's own doc comment below.
const NO_REQUEST_MATCH_ERROR =
  "Harness could not find your original request in Lovable's message list, so it cannot copy the project at that point.";

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

/** A test copy's Lovable project name, e.g. "Harness test #7 · with the
 * rule · Quick Tip Calculator". The old name cut the rule text at 40
 * characters mid-word, which read like a broken project. Exported for its
 * unit test. */
export function testCopyName(
  runId: number,
  which: "with the rule" | "original build",
  sourceProjectId: string,
): string {
  const raw = store.getProjectMeta(sourceProjectId)?.name ?? "your project";
  // Lovable only accepts letters, numbers, spaces and - _ . ' · & ( ) [ ] | ,
  // ! : in a display name, and no links or domain names ("#" is refused with
  // a 400, which would fail the whole test). Dots go too, so a project named
  // like a domain can't trip the check.
  const project =
    raw
      .replace(/[^\p{L}\p{N} \-_'·&()[\]|,!:]/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60) || "your project";
  return `Harness test ${runId} · ${which} · ${project}`;
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
    // Parsed, not string-compared: snapshots use SQLite's "YYYY-MM-DD
    // HH:MM:SS" (UTC) and episodes ISO "…T…Z", and " " sorts before "T".
    const startedMs = parseTimestampMs(episodeStartedAt);
    let picked: string | null = null;
    for (const snap of snapshots) {
      if (parseTimestampMs(snap.fetched_at) <= startedMs) picked = snap.content;
      else break;
    }
    if (picked !== null) return picked;
  }
  if (snapshots.length > 0) return snapshots[snapshots.length - 1]!.content;
  return "";
}

/** Trims, collapses internal whitespace runs to one space, and clamps to
 * 400 characters -- the comparison text resolveRequestMessageId uses on
 * both sides, so a stored request that was clamped somewhere upstream (or
 * whitespace that Lovable's own API normalizes differently) still matches. */
function normalizeForMatch(text: string): string {
  return text.trim().replace(/\s+/g, " ").slice(0, 400);
}

/** Same "SQLite datetime('now') is UTC without a zone marker" parsing
 * convention store.ts's own runningExperimentRun/activeExperimentRun use --
 * duplicated here (rather than exported from store.ts) because this is
 * about parsing a Lovable REST timestamp, not a store.ts column. */
function parseTimestampMs(iso: string): number {
  // SQLite's zone-less "YYYY-MM-DD HH:MM:SS" is UTC; Date.parse would read
  // it as local time, so it is converted explicitly first.
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(iso)) {
    return Date.parse(iso.replace(" ", "T") + "Z");
  }
  return Date.parse(iso);
}

/** Resolves the REST message id (Lovable's own ids, from GET .../messages)
 * of the role: "user" message that corresponds to one episode's own
 * request -- what remixInit's message_id must be. Lovable's REST ids are
 * role-prefixed ("umsg_..." for a user message, "aimsg_..." for an
 * assistant one, so this always returns a "umsg_..." id) but the match
 * below is on role + content/time, never on that prefix -- don't "simplify"
 * this to an id.startsWith("umsg_") filter, the prefix isn't a documented
 * API contract, just an observed convention. The sync's own stored
 * request_message_external_id is the MCP list_messages id (a different
 * format, e.g. "main:user#00000000000006#usr:34J3MCVP"); the REST API's
 * remix endpoint (and every other REST message_id-addressed endpoint) only
 * accepts its own ids -- calling remixInit with the MCP id is exactly what
 * produced the owner's own real "400 (invalid_message_id)" failure.
 *
 * Pages through rest.listMessages(source, ...) (a free, uncredited read)
 * looking for a role: "user" message whose content, normalized
 * (normalizeForMatch above), equals the episode's own request text --
 * returned immediately on the first such match, preferred over a time
 * match found on an earlier page. Failing any content match anywhere in the
 * scan, falls back to the first role: "user" message whose created_at fell
 * within 90 seconds of the episode's own occurred_at (found during the same
 * single pass, so this never re-pages). null when neither ever matches --
 * the caller fails the run with NO_REQUEST_MATCH_ERROR rather than send
 * anything to Lovable. Exported for its own unit tests. */
export async function resolveRequestMessageId(
  rest: LovableRest,
  source: string,
  target: { content: string; occurred_at: string | null },
): Promise<string | null> {
  const wantContent = normalizeForMatch(target.content);
  const wantMs = target.occurred_at ? parseTimestampMs(target.occurred_at) : NaN;
  let timeMatch: string | null = null;
  let cursor: string | undefined;

  for (let page = 0; page < LIST_MESSAGES_MAX_PAGES; page += 1) {
    const { messages, next_cursor } = await rest.listMessages(source, {
      limit: LIST_MESSAGES_PAGE_LIMIT,
      cursor,
    });
    for (const m of messages) {
      if (m.role !== "user") continue;
      if (normalizeForMatch(m.content) === wantContent) return m.message_id;
      if (timeMatch === null && !Number.isNaN(wantMs) && m.created_at) {
        const gotMs = parseTimestampMs(m.created_at);
        if (!Number.isNaN(gotMs) && Math.abs(gotMs - wantMs) <= REQUEST_MATCH_WINDOW_MS) {
          timeMatch = m.message_id;
        }
      }
    }
    if (!next_cursor) break;
    cursor = next_cursor;
  }
  return timeMatch;
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

/** How many of the source project's edits landed after the request, paging
 * newest-first until a page reaches back past it (or runs out). */
async function countEditsSinceEpisode(
  rest: LovableRest,
  source: string,
  episodeStartedAt: string,
): Promise<number> {
  const startedMs = parseTimestampMs(episodeStartedAt);
  let count = 0;
  let before: string | undefined;
  for (let page = 0; page < EDITS_MAX_PAGES; page += 1) {
    const { edits, has_more } = await rest.listEdits(source, { limit: EDITS_PAGE_LIMIT, before });
    const times = edits.map((e) => e.created_at);
    count += store.countEditsSince(new Date(startedMs).toISOString(), times.map((t) => new Date(parseTimestampMs(t)).toISOString()));
    const oldestMs = Math.min(...times.map(parseTimestampMs));
    if (!has_more || edits.length === 0 || oldestMs <= startedMs) break;
    before = new Date(oldestMs).toISOString();
  }
  return count;
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
  opts: { showOriginal?: boolean } = {},
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
    show_original: opts.showOriginal === true,
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
  deps: {
    rest: LovableRest;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    // Round 6 fix wave item B: refreshes the stored Lovable access token
    // before the run's very first REST call, when it's within 5 minutes of
    // expiring (or already expired) -- see lovable-mcp.ts's own doc comment.
    // Defaults to the real ensureFreshLovableToken; tests inject a no-op or
    // a counting stub.
    ensureFreshToken?: () => Promise<void>;
  },
): Promise<ExperimentRunRow> {
  const rest = deps.rest;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => Date.now());
  const ensureFreshToken = deps.ensureFreshToken ?? ensureFreshLovableToken;

  const initial = store.getExperimentRun(runId);
  if (!initial) throw new Error(`experiment run ${runId} not found`);
  const source = initial.source_project_id;

  try {
    await ensureFreshToken();

    const ruleDetail = store.getRule(initial.rule_id) as { rule: { instruction: string } } | null;
    const ruleInstruction = ruleDetail?.rule.instruction ?? "";

    // ---- 1. copy the project at the moment before the request (spec §6 Run 1) ----
    store.updateExperimentRun(runId, {
      status: "copying",
      stage_note: "Copying the project at the moment before your request",
    });

    // Round 6 fix wave item A: resolve the REST message id BEFORE ever
    // calling remixInit -- see resolveRequestMessageId's own doc comment.
    // requestFullText is reused below for the chat replay (step 3) instead
    // of a second store read.
    const requestFullText = store.episodeRequestText(initial.task_episode_id) ?? "";
    const requestOccurredAt = store.episodeRequestOccurredAt(initial.task_episode_id);
    const restRequestId = await resolveRequestMessageId(rest, source, {
      content: requestFullText,
      occurred_at: requestOccurredAt,
    });
    if (!restRequestId) {
      throw new Error(NO_REQUEST_MATCH_ERROR);
    }
    store.insertEvent("experiment.resolved_request", null, {
      run_id: runId,
      mcp_id: initial.request_message_external_id,
      rest_id: restRequestId,
    });

    const { job_id } = await rest.remixInit(source, {
      message_id: restRequestId,
      remix_mode: "before",
      include_history: false,
      include_custom_knowledge: false,
      skip_initial_remix_message: true,
      project_name: testCopyName(runId, "with the rule", source),
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

    // requestFullText (resolved above, before remixInit) is the owner's
    // original request in full -- episodeTextForJudge's own `request` is
    // capped at 1500 chars for the judge screen, not what gets replayed.
    const { message_id: copyMessageId, thread_id: copyThreadId } = await rest.chat(
      copyProjectId,
      requestFullText,
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
    // Round 6 fix wave item A: restRequestId (the REST id resolved above),
    // not initial.request_message_external_id (the MCP id) -- these are the
    // same message_id-addressed REST endpoints remixInit uses, and only
    // accept Lovable's own ids.
    let originalCommitSha: string | null = null;
    let originalSummary: string | null = null;
    try {
      const originalMessage = await rest.getMessage(source, restRequestId);
      originalCommitSha = originalMessage.commit_sha ?? null;
      originalSummary = originalMessage.summary ?? null;
    } catch {
      originalCommitSha = null;
    }
    let originalDiffJson: string | null = null;
    try {
      const originalDiffText = await rest.getDiff(source, {
        message_id: restRequestId,
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
        editsSinceEpisode = await countEditsSinceEpisode(rest, source, episodeStartedAt);
      } catch {
        editsSinceEpisode = null;
      }
    }

    store.updateExperimentRun(runId, {
      original_commit_sha: originalCommitSha,
      original_summary: originalSummary,
      original_diff_json: originalDiffJson,
      edits_since_episode: editsSinceEpisode,
    });

    // ---- 4b. Round 7: builds you can look at ----
    // A free copy of the project right after the original request (remix
    // "including" it, no chat) so the original build can be opened next to
    // the new one; best effort -- the paid build above is already recorded.
    if (initial.show_original === 1) {
      store.updateExperimentRun(runId, { stage_note: "Copying your original build to look at" });
      try {
        const { job_id: originalJob } = await rest.remixInit(source, {
          message_id: restRequestId,
          remix_mode: "including",
          include_history: false,
          include_custom_knowledge: false,
          skip_initial_remix_message: true,
          project_name: testCopyName(runId, "original build", source),
        });
        const originalStart = now();
        for (;;) {
          const progress = await rest.remixProgress(source, originalJob);
          if (progress.status === "completed") {
            if (progress.project_id) {
              store.updateExperimentRun(runId, { original_copy_project_id: progress.project_id });
            }
            break;
          }
          if (progress.status === "failed") {
            throw new Error(progress.error ?? "Copying the original build failed.");
          }
          if (now() - originalStart >= REMIX_TIMEOUT_MS) {
            throw new Error("Copying the original build timed out.");
          }
          await sleep(REMIX_POLL_MS);
        }
      } catch (err) {
        store.updateExperimentRun(runId, { original_copy_error: errorMessage(err) });
      }
    }

    store.updateExperimentRun(runId, { stage_note: "Waiting for screenshots of the builds" });
    const withRuleShot = await screenshotOf(rest, copyProjectId, sleep);
    const afterShots = store.getExperimentRun(runId)!;
    const originalShot = afterShots.original_copy_project_id
      ? await screenshotOf(rest, afterShots.original_copy_project_id, sleep)
      : null;
    store.updateExperimentRun(runId, {
      copy_screenshot_url: withRuleShot,
      original_screenshot_url: originalShot,
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
    // A failed test's copies prove nothing: always delete them.
    if (failed) await cleanupCopy(failed, rest, { force: true });
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
export async function cleanupCopy(
  run: ExperimentRunRow,
  rest: LovableRest,
  opts: { force?: boolean } = {},
): Promise<void> {
  // Round 7: copies are kept unless the owner turned that off -- they are
  // real builds to open and continue from. A failed test's are always
  // deleted (force).
  if (!opts.force && store.getSetting("keep_test_copies") !== "false") return;

  if (run.copy_project_id && !run.copy_deleted) {
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
  if (run.original_copy_project_id && !run.original_copy_deleted) {
    try {
      await rest.deleteProject(run.original_copy_project_id);
      store.updateExperimentRun(run.id, { original_copy_deleted: 1 });
    } catch {
      store.updateExperimentRun(run.id, {
        copy_cleanup_note:
          "Could not delete a test copy; delete it by hand in Lovable.",
      });
    }
  }
}

/** The screenshot URL of a project's latest commit, once Lovable has taken
 * it (its URL carries the commit's first 8 characters), else null. */
async function screenshotOf(
  rest: LovableRest,
  projectId: string,
  sleep: (ms: number) => Promise<void>,
): Promise<string | null> {
  for (let attempt = 0; attempt < SCREENSHOT_POLL_ATTEMPTS; attempt += 1) {
    try {
      const project = await rest.getProject(projectId);
      const url = project.latest_screenshot_url;
      const sha = project.latest_commit_sha;
      if (url && (!sha || url.includes(`-${sha.slice(0, 8)}--`))) return url;
    } catch {
      return null;
    }
    await sleep(SCREENSHOT_POLL_MS);
  }
  return null;
}

/** "Delete copy" on the judging screen: deletes one of this run's own test
 * copies in Lovable. Refuses anything that is not a copy this run recorded,
 * and always refuses the source project. */
export async function deleteTestCopy(
  runId: number,
  which: "with_rule" | "original",
  rest: LovableRest,
): Promise<ExperimentRunRow> {
  const run = store.getExperimentRun(runId);
  if (!run) throw new Error(`test ${runId} not found`);
  const projectId = which === "with_rule" ? run.copy_project_id : run.original_copy_project_id;
  if (!projectId) throw new Error("This test has no such copy.");
  if (projectId === run.source_project_id) {
    throw new Error("Refusing to delete the source project.");
  }
  await rest.deleteProject(projectId);
  store.updateExperimentRun(
    runId,
    which === "with_rule" ? { copy_deleted: 1 } : { original_copy_deleted: 1 },
  );
  return store.getExperimentRun(runId)!;
}
