import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Round 6 Task 6a: the paired-test runner (spec §6) -- startExperiment,
// runExperiment, cleanupCopy over the Lovable REST client (Task 1). Every
// test here runs against startFakeLovable's scratch node:http server; no
// test may touch Lovable. HARNESS_AUTH_PATH points at a file that is never
// written, so lovableStatus().connected is false by default -- exactly what
// the "not connected" refusal test needs; every other test passes its own
// `connected: () => true` override (the same injection point the brief
// asks startExperiment's deps to expose).
const tmp = mkdtempSync(join(tmpdir(), "harness-experiments-test-"));
process.env.HARNESS_DB_PATH = join(tmp, "harness.db");
process.env.HARNESS_AUTH_PATH = join(tmp, "lovable-auth.json");

const store = await import("../src/store.js");
const { db } = await import("../src/db.js");
const { composeManagedKnowledge } = await import("../src/knowledge.js");
const { startExperiment, runExperiment, cleanupCopy, resolveRequestMessageId } =
  await import("../src/executor/experiments.js");
const { createLovableRest } = await import("../src/executor/lovable-rest.js");
// Round 6 Task 6b: the background queue behind "Test this rule" -- see its
// own header comment (experiments-queue.ts) for why it lives in its own
// module rather than folded into experiments.ts.
const { kickExperimentRunner, _reset } = await import("../src/executor/experiments-queue.js");
const { startFakeLovable } = await import("./fake-lovable.js");
type FakeLovableServer = Awaited<ReturnType<typeof startFakeLovable>>;
type FakeScript = Parameters<typeof startFakeLovable>[0];

const SOURCE = "prj_source";
const WORKSPACE = "ws_1";

store.allowProject(SOURCE, "Source project");
store.upsertProject({
  lovable_project_id: SOURCE,
  name: "Source project",
  workspace_id: WORKSPACE,
});

const CONNECTED = { connected: () => true };

function noopSleep(): Promise<void> {
  return Promise.resolve();
}

function restFor(fake: FakeLovableServer) {
  return createLovableRest({ baseUrl: fake.baseUrl, fetchFn: fetch, token: "test-token" });
}

// ------------------------------------------------------------------ seeds
//
// One full episode -> candidate -> learning -> rule chain per call, mirroring
// demo.ts's own demoImprovementSeed shape (that helper is module-private, so
// this rebuilds the same five store.ts calls directly). The user request
// message gets an external_id shaped like Lovable's own message ids
// ("aimsg_...") -- episodeRequestExternalId (store.ts) resolves it as "the
// earliest evidence message", which is what remixInit's message_id and the
// runner's replay text are built from.

// Round 6 fix wave item A: the sync's own stored external_id (the MCP
// list_messages id shape, e.g. "aimsg_req_1" here) is deliberately NOT what
// remixInit's message_id ends up being -- runExperiment now resolves the
// REST id via resolveRequestMessageId's own listMessages scan first (see
// that function's own doc comment). DEFAULT_REQUEST_TEXT/DEFAULT_REST_ID
// below are what happyPathScript's own listMessages handler returns to make
// that resolution succeed for every seedCandidate() call that doesn't
// override requestText.
const DEFAULT_REQUEST_TEXT = "Add a contact form to the landing page.";
const DEFAULT_REST_REQUEST_ID = "aimsg_resolved_default";

let seedSeq = 0;

function seedCandidate(opts?: { instruction?: string; projectId?: string; requestText?: string }): {
  candidateId: number;
  ruleId: number;
  episodeId: number;
  requestExternalId: string;
} {
  seedSeq += 1;
  const projectId = opts?.projectId ?? SOURCE;
  const requestExternalId = `aimsg_req_${seedSeq}`;

  const userRow = store.upsertHistoryItem({
    project_id: projectId,
    kind: "message",
    external_id: requestExternalId,
    role: "user",
    content: opts?.requestText ?? DEFAULT_REQUEST_TEXT,
    occurred_at: "2026-09-01 10:00:00",
    provenance: "lovable_mcp",
  }) as { id: number };
  const assistantRow = store.upsertHistoryItem({
    project_id: projectId,
    kind: "message",
    external_id: `aimsg_reply_${seedSeq}`,
    role: "assistant",
    content: "Sure -- adding a contact form now.",
    occurred_at: "2026-09-01 10:01:00",
    provenance: "lovable_mcp",
  }) as { id: number };

  const episode = store.createTaskEpisode({
    project_id: projectId,
    title: `Episode ${seedSeq}`,
    summary: "Contact form episode",
    provenance: "manual",
    started_at: "2026-09-01 10:00:00",
    evidence_history_item_ids: [userRow.id, assistantRow.id],
  }) as { id: number };

  const candidate = store.createCorrectionCandidate({
    task_episode_id: episode.id,
    classification: "defect_correction",
    is_correction: true,
    reusable: true,
    proposed_scope: "project",
    summary: "Contact form had no email validation",
    confidence: 0.8,
    evidence_reason: "user pointed it out directly",
    evidence_history_item_ids: [userRow.id, assistantRow.id],
  }) as { id: number };

  const learning = store.createLearning({
    correction_candidate_id: candidate.id,
    observed_problem: "Contact forms shipped without email validation",
    desired_behavior: "Validate email fields before submit",
    reuse_rationale: "Applies to every form Lovable builds for this project",
    proposed_scope: "project",
    confidence: 0.8,
    provenance: "manual",
    created_by: "test",
  }) as { id: number };

  const rule = store.createRule({
    learning_id: learning.id,
    correction_candidate_id: candidate.id,
    instruction:
      opts?.instruction ?? "Always validate email fields on contact forms before allowing submit.",
    scope: "project",
    applies_when: "a contact form is added or edited",
    predicted_failure: "invalid emails get submitted silently",
    ownership: "harness",
    created_by: "test",
  }) as { id: number };

  return { candidateId: candidate.id, ruleId: rule.id, episodeId: episode.id, requestExternalId };
}

/** A second allowed project, isolated from SOURCE's own knowledge_snapshots
 * history -- the Knowledge-content tests (fix round 1 item 5) each need a
 * clean slate rather than accumulating snapshots on the one shared SOURCE
 * project across sequential tests in this file. */
function newProject(id: string): void {
  store.allowProject(id, `Test project ${id}`);
  store.upsertProject({ lovable_project_id: id, name: id, workspace_id: WORKSPACE });
}

/** Records a project Knowledge snapshot and backdates its fetched_at to an
 * exact, caller-chosen timestamp -- recordKnowledgeSnapshot itself always
 * stamps `datetime('now')`, with no way to control it through the public
 * store API, so this reaches into the DB directly (the same direct-db
 * convention other test files in this suite already use for fixture setup,
 * e.g. improvements.test.ts's raw allowed_projects insert) purely to make
 * the "at or before the episode's started_at" ordering deterministic. */
function recordSnapshotAt(projectId: string, fetchedAt: string, content: string): void {
  const snap = store.recordKnowledgeSnapshot({
    target: "project",
    project_id: projectId,
    content,
    fetched_by: "test",
  }) as { id: number };
  db.prepare(`UPDATE knowledge_snapshots SET fetched_at = ? WHERE id = ?`).run(fetchedAt, snap.id);
}

// ------------------------------------------------------------ fake script

const REPLY_BLOB =
  '<lov-tool-use id="a" name="user_messaging--message_user" integration-id="user_messaging" ' +
  'data="{\\"summary\\": \\"s\\", \\"message\\": \\"Added a validated contact form.\\", \\"finished\\": true}">\n</lov-tool-use>';

function diffBody(text: string) {
  return {
    diffs: [
      {
        action: "modified",
        file_path: "src/ContactForm.tsx",
        is_image: false,
        hunks: [
          {
            oldStart: 1,
            oldCount: 1,
            newStart: 1,
            newCount: 2,
            lines: [
              { type: "context", content: "export function ContactForm() {" },
              { type: "add", content: `  // ${text}` },
            ],
          },
        ],
      },
    ],
  };
}

/** Every handler the happy path needs, keyed the same way the fake server's
 * own Endpoint union is -- individual tests override just the endpoint(s)
 * whose behaviour they're exercising. */
function happyPathScript(copyId: string): FakeScript {
  return {
    getProject: (req) => ({
      status: 200,
      body: { id: req.params.project_id, name: "source", workspace_id: WORKSPACE },
    }),
    // Round 6 fix wave item A: resolveRequestMessageId's own listMessages
    // scan -- one page, one user message whose content matches
    // DEFAULT_REQUEST_TEXT (what seedCandidate() sends unless a test
    // overrides requestText, in which case that test overrides this handler
    // too -- see "full request replay" below).
    listMessages: () => ({
      status: 200,
      body: {
        has_more: false,
        messages: [
          {
            message_id: DEFAULT_REST_REQUEST_ID,
            role: "user",
            content: DEFAULT_REQUEST_TEXT,
            created_at: "2026-09-01T10:00:00Z",
          },
        ],
      },
    }),
    postProjects: () => ({ status: 201, body: { id: copyId, job_id: "job_1" } }),
    remixProgress: () => ({
      status: 200,
      body: { status: "completed", result: { project_id: copyId } },
    }),
    putKnowledge: (req) => ({
      status: 200,
      body: { content: (req.body as { content: string }).content },
    }),
    postMessage: () => ({
      status: 200,
      body: { message_id: "msg_copy_1", thread_id: "thread_1", status: "accepted" },
    }),
    getMessage: (req) => {
      if (req.params.project_id === copyId) {
        return {
          status: 200,
          body: {
            status: "completed",
            response: {
              status: "completed",
              commit_sha: "sha_copy",
              edit_id: "edit_copy",
              summary: "Added a validated contact form",
              cost_credits: 1.5,
              content: REPLY_BLOB,
            },
          },
        };
      }
      // the source project's own request message id -- its nested response
      // carries the original build's own commit_sha.
      return {
        status: 200,
        body: {
          status: "completed",
          response: { status: "completed", commit_sha: "sha_original", content: "original reply" },
        },
      };
    },
    getDiff: (req) => ({
      status: 200,
      body: diffBody(req.params.project_id === copyId ? "with the rule" : "original"),
    }),
    listEdits: () => ({
      status: 200,
      body: {
        has_more: false,
        edits: [
          {
            id: "e1",
            commit_sha: "sha_a",
            commit_message: "unrelated edit",
            created_at: "2026-09-02 00:00:00",
          },
        ],
      },
    }),
    deleteProject: () => ({ status: 204 }),
    patchProject: (req) => ({
      status: 200,
      body: { id: req.params.project_id, visibility: "private", workspace_id: WORKSPACE },
    }),
  };
}

// -------------------------------------------------------------- happy path

test("happy path: records every field, deletes the copy, never chats with the source project", async () => {
  const seed = seedCandidate();
  const fake = startFakeLovable(happyPathScript("prj_copy_happy"));
  try {
    const rest = restFor(fake);
    const started = await startExperiment(seed.candidateId, { rest, ...CONNECTED });
    assert.ok("run_id" in started, `expected a run_id, got ${JSON.stringify(started)}`);
    const runId = (started as { run_id: number }).run_id;

    const queued = store.getExperimentRun(runId)!;
    assert.equal(queued.status, "queued");
    assert.equal(queued.rule_id, seed.ruleId);
    assert.equal(queued.correction_candidate_id, seed.candidateId);
    assert.equal(queued.task_episode_id, seed.episodeId);
    assert.equal(queued.source_project_id, SOURCE);
    assert.equal(queued.request_message_external_id, seed.requestExternalId);

    const result = await runExperiment(runId, { rest, sleep: noopSleep });

    assert.equal(result.status, "judging");
    assert.equal(result.error, null);
    assert.equal(result.copy_project_id, "prj_copy_happy");
    assert.equal(result.copy_message_id, "msg_copy_1");
    assert.equal(result.copy_thread_id, "thread_1");
    assert.equal(result.copy_commit_sha, "sha_copy");
    assert.equal(result.copy_summary, "Added a validated contact form");
    assert.equal(result.copy_reply, "Added a validated contact form.");
    assert.equal(result.cost_credits, 1.5);
    assert.equal(result.original_commit_sha, "sha_original");
    assert.equal(result.edits_since_episode, 1);
    assert.equal(result.copy_deleted, 1);
    assert.equal(result.copy_cleanup_note, null);
    assert.ok(result.finished_at);

    const copyDiff = JSON.parse(result.copy_diff_json!) as { lines: string[]; truncated: boolean };
    assert.ok(copyDiff.lines.length > 0);
    assert.equal(copyDiff.truncated, false);
    assert.match(copyDiff.lines.join("\n"), /with the rule/);

    const originalDiff = JSON.parse(result.original_diff_json!) as {
      lines: string[];
      truncated: boolean;
    };
    assert.match(originalDiff.lines.join("\n"), /original/);

    assert.equal(
      fake.calls.filter((c) => c.method === "POST" && c.path === `/v1/projects/${SOURCE}/messages`)
        .length,
      0,
      "chat must never be called against the source project id",
    );
    const chatCalls = fake.calls.filter((c) => c.method === "POST" && c.path.endsWith("/messages"));
    assert.equal(chatCalls.length, 1);
    assert.equal(chatCalls[0]!.path, "/v1/projects/prj_copy_happy/messages");

    assert.equal(
      fake.calls.filter((c) => c.method === "DELETE" && c.path === "/v1/projects/prj_copy_happy")
        .length,
      1,
      "the copy was deleted exactly once",
    );

    const ledgerTotal = store.creditsThisMonth();
    assert.ok(ledgerTotal >= 1.5);
  } finally {
    await fake.close();
  }
});

// ------------------------------------------------------------- remix fails

test("remix failed: the run fails, and nothing beyond the remix calls is ever sent", async () => {
  const seed = seedCandidate();
  const fake = startFakeLovable({
    getProject: (req) => ({
      status: 200,
      body: { id: req.params.project_id, name: "source", workspace_id: WORKSPACE },
    }),
    // Round 6 fix wave item A: the REST id resolution happens before
    // remixInit is ever called, so this handler is needed even on the
    // remix-failure path.
    listMessages: () => ({
      status: 200,
      body: {
        has_more: false,
        messages: [
          {
            message_id: DEFAULT_REST_REQUEST_ID,
            role: "user",
            content: DEFAULT_REQUEST_TEXT,
            created_at: "2026-09-01T10:00:00Z",
          },
        ],
      },
    }),
    postProjects: () => ({ status: 201, body: { id: "prj_copy_never", job_id: "job_fail" } }),
    remixProgress: () => ({
      status: 200,
      body: { status: "error", error_message: "FILE_TOO_LARGE_FOR_COMMIT" },
    }),
  });
  try {
    const rest = restFor(fake);
    const started = await startExperiment(seed.candidateId, { rest, ...CONNECTED });
    const runId = (started as { run_id: number }).run_id;

    const result = await runExperiment(runId, { rest, sleep: noopSleep });

    assert.equal(result.status, "failed");
    assert.ok(result.error, "a plain-sentence error is recorded");
    assert.equal(result.copy_project_id, null);
    assert.equal(result.copy_deleted, 0);

    const allowedPaths = new Set([
      `/v1/projects/${SOURCE}/messages`,
      "/v1/projects",
      `/v1/projects/${SOURCE}`,
      `/v1/projects/${SOURCE}/remix/progress`,
    ]);
    for (const call of fake.calls) {
      assert.ok(allowedPaths.has(call.path), `unexpected call ${call.method} ${call.path}`);
    }
    assert.equal(
      fake.calls.some((c) => c.method === "POST" && c.path.endsWith("/messages")),
      false,
      "chat was never sent",
    );
    assert.equal(
      fake.calls.some((c) => c.method === "PUT" && c.path.endsWith("/knowledge")),
      false,
      "Knowledge was never written",
    );
  } finally {
    await fake.close();
  }
});

// -------------------------------------------------------------- build error

test("build error: the run fails and the copy is still cleaned up", async () => {
  const seed = seedCandidate();
  const copyId = "prj_copy_builderror";
  const fake = startFakeLovable({
    ...happyPathScript(copyId),
    getMessage: (req) => {
      if (req.params.project_id === copyId) {
        return { status: 200, body: { status: "error", response: { status: "error" } } };
      }
      return {
        status: 200,
        body: {
          status: "completed",
          response: { status: "completed", commit_sha: "sha_original" },
        },
      };
    },
  });
  try {
    const rest = restFor(fake);
    const started = await startExperiment(seed.candidateId, { rest, ...CONNECTED });
    const runId = (started as { run_id: number }).run_id;

    const result = await runExperiment(runId, { rest, sleep: noopSleep });

    assert.equal(result.status, "failed");
    assert.ok(result.error);
    assert.equal(result.copy_project_id, copyId);
    assert.equal(result.copy_deleted, 1, "the copy is deleted even though the run failed");

    assert.equal(
      fake.calls.filter((c) => c.method === "DELETE" && c.path === `/v1/projects/${copyId}`).length,
      1,
    );
    // the run failed before the record step, so no diff/edits reads happened
    assert.equal(
      fake.calls.some((c) => c.path.includes("/git/diff")),
      false,
    );
    assert.equal(
      fake.calls.some((c) => c.path.endsWith("/edits")),
      false,
    );
  } finally {
    await fake.close();
  }
});

// ------------------------------------------------- non-completed terminal builds
//
// Fix round 1 item 1: only a `completed` build is judgeable -- every other
// terminal status the build poll can end on (stopped, awaiting_input, or a
// status this client doesn't otherwise name) must fail the run with its
// own distinct sentence, not silently proceed to `judging` with empty
// content.

function nonCompletedBuildScript(copyId: string, copyStatus: string): FakeScript {
  return {
    ...happyPathScript(copyId),
    getMessage: (req) => {
      if (req.params.project_id === copyId) {
        return { status: 200, body: { status: copyStatus, response: { status: copyStatus } } };
      }
      return {
        status: 200,
        body: {
          status: "completed",
          response: { status: "completed", commit_sha: "sha_original" },
        },
      };
    },
  };
}

test("build stopped: the run fails with its own sentence and the copy is still cleaned up", async () => {
  const seed = seedCandidate();
  const copyId = "prj_copy_stopped";
  const fake = startFakeLovable(nonCompletedBuildScript(copyId, "stopped"));
  try {
    const rest = restFor(fake);
    const started = await startExperiment(seed.candidateId, { rest, ...CONNECTED });
    const runId = (started as { run_id: number }).run_id;

    const result = await runExperiment(runId, { rest, sleep: noopSleep });

    assert.equal(result.status, "failed");
    assert.equal(result.error, "Lovable stopped without finishing the build in the copy.");
    assert.equal(result.copy_deleted, 1, "the copy is deleted even though the run failed");
  } finally {
    await fake.close();
  }
});

test("build awaiting_input: the run fails with its own sentence and the copy is still cleaned up", async () => {
  const seed = seedCandidate();
  const copyId = "prj_copy_awaitinginput";
  const fake = startFakeLovable(nonCompletedBuildScript(copyId, "awaiting_input"));
  try {
    const rest = restFor(fake);
    const started = await startExperiment(seed.candidateId, { rest, ...CONNECTED });
    const runId = (started as { run_id: number }).run_id;

    const result = await runExperiment(runId, { rest, sleep: noopSleep });

    assert.equal(result.status, "failed");
    assert.equal(result.error, "Lovable is waiting for more input; the test could not complete.");
    assert.equal(result.copy_deleted, 1, "the copy is deleted even though the run failed");
  } finally {
    await fake.close();
  }
});

test("build status the client doesn't otherwise name (Lovable's own 'timeout'): the run fails, names the status, and the copy is cleaned up", async () => {
  const seed = seedCandidate();
  const copyId = "prj_copy_timeoutstatus";
  const fake = startFakeLovable({
    ...happyPathScript(copyId),
    getMessage: (req) => {
      if (req.params.project_id === copyId) {
        // No nested `response` here -- a top-level status this client's
        // toRestBuildStatus (lovable-rest.ts, fix round 1 item 2) now
        // passes through verbatim instead of collapsing to "running".
        return { status: 200, body: { status: "timeout" } };
      }
      return {
        status: 200,
        body: {
          status: "completed",
          response: { status: "completed", commit_sha: "sha_original" },
        },
      };
    },
  });
  try {
    const rest = restFor(fake);
    const started = await startExperiment(seed.candidateId, { rest, ...CONNECTED });
    const runId = (started as { run_id: number }).run_id;

    const result = await runExperiment(runId, { rest, sleep: noopSleep });

    assert.equal(result.status, "failed");
    assert.equal(result.error, "Lovable returned an unexpected build status: timeout.");
    assert.equal(result.copy_deleted, 1, "the copy is deleted even though the run failed");
  } finally {
    await fake.close();
  }
});

// -------------------------------------------------------- delete fails

test("delete fails: the copy is set private, a cleanup note is recorded, and it shows up in listUndeletedCopies", async () => {
  const seed = seedCandidate();
  const copyId = "prj_copy_deletefails";
  const fake = startFakeLovable({
    ...happyPathScript(copyId),
    deleteProject: () => ({ status: 500, body: { status: 500, type: "internal_error" } }),
  });
  try {
    const rest = restFor(fake);
    const started = await startExperiment(seed.candidateId, { rest, ...CONNECTED });
    const runId = (started as { run_id: number }).run_id;

    const result = await runExperiment(runId, { rest, sleep: noopSleep });

    assert.equal(result.status, "judging", "a delete failure doesn't fail the run itself");
    assert.equal(result.copy_deleted, 0);
    assert.equal(
      result.copy_cleanup_note,
      "Could not delete the test copy; it was set private. Delete it by hand in Lovable.",
    );

    const patchCalls = fake.calls.filter(
      (c) => c.method === "PATCH" && c.path === `/v1/projects/${copyId}`,
    );
    assert.equal(patchCalls.length, 1);
    assert.deepEqual(patchCalls[0]!.body, { visibility: "private" });

    const undeleted = store.listUndeletedCopies();
    assert.ok(undeleted.some((u) => u.run_id === runId && u.copy_project_id === copyId));
  } finally {
    await fake.close();
  }
});

// ------------------------------------------------- listEdits best effort

test("listEdits failure is best effort: an already-paid, already-completed build still reaches judging", async () => {
  const seed = seedCandidate();
  const copyId = "prj_copy_editsfail";
  const fake = startFakeLovable({
    ...happyPathScript(copyId),
    listEdits: () => ({ status: 500, body: { status: 500, type: "internal_error" } }),
  });
  try {
    const rest = restFor(fake);
    const started = await startExperiment(seed.candidateId, { rest, ...CONNECTED });
    const runId = (started as { run_id: number }).run_id;

    const result = await runExperiment(runId, { rest, sleep: noopSleep });

    assert.equal(
      result.status,
      "judging",
      "a listEdits failure never fails an already-successful build",
    );
    assert.equal(result.edits_since_episode, null);
    assert.equal(
      result.copy_commit_sha,
      "sha_copy",
      "the successful build's own fields are still recorded",
    );
  } finally {
    await fake.close();
  }
});

// ------------------------------------------------------ full request replay

test("full request replay: a request longer than the judge-screen's own 1500-char cap is sent to chat in full", async () => {
  const longText = "A".repeat(3000);
  const seed = seedCandidate({ requestText: longText });
  const copyId = "prj_copy_longrequest";
  const fake = startFakeLovable({
    ...happyPathScript(copyId),
    // Round 6 fix wave item A: this seed's own requestText differs from
    // DEFAULT_REQUEST_TEXT, so it needs its own listMessages match (content
    // is compared over the first 400 chars -- see normalizeForMatch --
    // which longText satisfies trivially, being 400+ identical characters).
    listMessages: () => ({
      status: 200,
      body: {
        has_more: false,
        messages: [
          {
            message_id: "aimsg_resolved_longrequest",
            role: "user",
            content: longText,
            created_at: "2026-09-01T10:00:00Z",
          },
        ],
      },
    }),
  });
  try {
    const rest = restFor(fake);
    const started = await startExperiment(seed.candidateId, { rest, ...CONNECTED });
    const runId = (started as { run_id: number }).run_id;

    await runExperiment(runId, { rest, sleep: noopSleep });

    const chatCall = fake.calls.find(
      (c) => c.method === "POST" && c.path === `/v1/projects/${copyId}/messages`,
    );
    assert.ok(chatCall, "chat was called");
    const sentMessage = (chatCall!.body as { message: string }).message;
    assert.equal(sentMessage.length, 3000);
    assert.equal(sentMessage, longText);
  } finally {
    await fake.close();
  }
});

// ------------------------------------------- REST message id resolution (fix wave item A)

test("resolveRequestMessageId: pages through listMessages and picks the right aimsg_ id by content match on the second page", async () => {
  const wantContent = "Please add validation to the checkout form.";
  const fake = startFakeLovable({
    listMessages: (req) => {
      if (!req.query.before) {
        // Page 1: no match, has_more true -- next_cursor is the oldest
        // message id on this page (lovable-rest.ts's own convention).
        return {
          status: 200,
          body: {
            has_more: true,
            messages: [
              {
                message_id: "aimsg_unrelated_1",
                role: "user",
                content: "Unrelated earlier request.",
                created_at: "2026-08-01T00:00:00Z",
              },
            ],
          },
        };
      }
      // Page 2 (before=aimsg_unrelated_1): the match.
      return {
        status: 200,
        body: {
          has_more: false,
          messages: [
            {
              message_id: "aimsg_the_real_one",
              role: "assistant",
              content: "not this one",
              created_at: "2026-09-01T09:59:00Z",
            },
            {
              message_id: "aimsg_the_real_one_user",
              role: "user",
              // Irregular whitespace only (no extra words) -- normalizeForMatch
              // collapses this back to exactly `wantContent`.
              content: "  Please  add   validation to the checkout   form.  ",
              created_at: "2026-09-01T10:00:00Z",
            },
          ],
        },
      };
    },
  });
  try {
    const rest = restFor(fake);
    const resolved = await resolveRequestMessageId(rest, SOURCE, {
      content: wantContent,
      occurred_at: "2026-09-01 10:00:00",
    });
    assert.equal(resolved, "aimsg_the_real_one_user");
    const listCalls = fake.calls.filter(
      (c) => c.method === "GET" && c.path === `/v1/projects/${SOURCE}/messages`,
    );
    assert.equal(listCalls.length, 2, "paged exactly twice to find the match");
  } finally {
    await fake.close();
  }
});

test("resolveRequestMessageId: falls back to a created_at match within 90 seconds when no content ever matches", async () => {
  const fake = startFakeLovable({
    listMessages: () => ({
      status: 200,
      body: {
        has_more: false,
        messages: [
          {
            message_id: "aimsg_close_in_time",
            role: "user",
            content: "Completely different wording -- Lovable's own paraphrase, say.",
            created_at: "2026-09-01T10:01:20Z", // 80s after occurred_at, inside the 90s window
          },
          {
            message_id: "aimsg_too_far",
            role: "user",
            content: "Also unrelated.",
            created_at: "2026-09-01T10:10:00Z", // well outside the window
          },
        ],
      },
    }),
  });
  try {
    const rest = restFor(fake);
    const resolved = await resolveRequestMessageId(rest, SOURCE, {
      content: "The original request text, never echoed back verbatim by this fake.",
      occurred_at: "2026-09-01 10:00:00",
    });
    assert.equal(resolved, "aimsg_close_in_time");
  } finally {
    await fake.close();
  }
});

test("no REST match: the run fails with the exact sentence, and nothing beyond the messages read is ever sent", async () => {
  const seed = seedCandidate();
  const fake = startFakeLovable({
    getProject: (req) => ({
      status: 200,
      body: { id: req.params.project_id, name: "source", workspace_id: WORKSPACE },
    }),
    listMessages: () => ({
      status: 200,
      body: {
        has_more: false,
        messages: [
          {
            message_id: "aimsg_nope",
            role: "user",
            content: "Nothing like the seeded request, and no created_at near it either.",
            created_at: "2020-01-01T00:00:00Z",
          },
        ],
      },
    }),
  });
  try {
    const rest = restFor(fake);
    const started = await startExperiment(seed.candidateId, { rest, ...CONNECTED });
    const runId = (started as { run_id: number }).run_id;

    const result = await runExperiment(runId, { rest, sleep: noopSleep });

    assert.equal(result.status, "failed");
    assert.equal(
      result.error,
      "Harness could not find your original request in Lovable's message list, so it cannot copy the project at that point.",
    );
    assert.equal(result.copy_project_id, null, "nothing was ever sent to remix");
    assert.equal(
      fake.calls.some((c) => c.method === "POST"),
      false,
      "nothing spent -- no POST call was ever made",
    );
  } finally {
    await fake.close();
  }
});

test("REST id resolution records an experiment.resolved_request event with both ids, even when the run fails later", async () => {
  // Deliberately fails at the remix step (no getMessage/postMessage/etc
  // scripted) -- this asserts the event is recorded as soon as the id is
  // resolved, not only on a full successful run, and costs nothing (this
  // suite's own shared monthly credit ledger has a finite, already-tight
  // budget -- see the other runExperiment-calling tests in this file).
  const seed = seedCandidate();
  const fake = startFakeLovable({
    getProject: (req) => ({
      status: 200,
      body: { id: req.params.project_id, name: "source", workspace_id: WORKSPACE },
    }),
    listMessages: () => ({
      status: 200,
      body: {
        has_more: false,
        messages: [
          {
            message_id: DEFAULT_REST_REQUEST_ID,
            role: "user",
            content: DEFAULT_REQUEST_TEXT,
            created_at: "2026-09-01T10:00:00Z",
          },
        ],
      },
    }),
    postProjects: () => ({ status: 201, body: { id: "prj_copy_resolvedevent", job_id: "job_x" } }),
    remixProgress: () => ({ status: 200, body: { status: "error", error_message: "boom" } }),
  });
  try {
    const rest = restFor(fake);
    const started = await startExperiment(seed.candidateId, { rest, ...CONNECTED });
    const runId = (started as { run_id: number }).run_id;

    const result = await runExperiment(runId, { rest, sleep: noopSleep });
    assert.equal(result.status, "failed", "the run itself still fails at the remix step");

    const events = db
      .prepare(
        `SELECT payload FROM events WHERE kind = 'experiment.resolved_request' ORDER BY id DESC`,
      )
      .all() as { payload: string }[];
    const match = events
      .map((e) => JSON.parse(e.payload) as { run_id: number; mcp_id: string; rest_id: string })
      .find((p) => p.run_id === runId);
    assert.ok(match, "an experiment.resolved_request event was recorded for this run");
    assert.equal(match!.mcp_id, seed.requestExternalId);
    assert.equal(match!.rest_id, DEFAULT_REST_REQUEST_ID);
  } finally {
    await fake.close();
  }
});

// ----------------------------------------------- Knowledge sent to the copy

test("Knowledge sent to the copy: the snapshot at or before the episode's started_at wins over a newer one", async () => {
  const PROJECT = "prj_knowledge_older";
  newProject(PROJECT);
  const seed = seedCandidate({ projectId: PROJECT });
  recordSnapshotAt(PROJECT, "2026-08-01 00:00:00", "# Older\nOlder content.");
  recordSnapshotAt(PROJECT, "2026-09-05 00:00:00", "# Newer\nNewer content, after the episode.");

  const copyId = "prj_copy_knowledgeolder";
  const fake = startFakeLovable(happyPathScript(copyId));
  try {
    const rest = restFor(fake);
    const started = await startExperiment(seed.candidateId, { rest, ...CONNECTED });
    const runId = (started as { run_id: number }).run_id;
    await runExperiment(runId, { rest, sleep: noopSleep });

    const putCall = fake.calls.find(
      (c) => c.method === "PUT" && c.path === `/v1/projects/${copyId}/knowledge`,
    );
    assert.ok(putCall);
    const ruleDetail = store.getRule(seed.ruleId) as { rule: { instruction: string } };
    const expected = composeManagedKnowledge("# Older\nOlder content.", [
      { id: seed.ruleId, instruction: ruleDetail.rule.instruction },
    ]).final_content;
    assert.equal((putCall!.body as { content: string }).content, expected);
  } finally {
    await fake.close();
  }
});

test("Knowledge sent to the copy: falls back to the latest snapshot when none is at or before the episode's started_at", async () => {
  const PROJECT = "prj_knowledge_onlynewer";
  newProject(PROJECT);
  const seed = seedCandidate({ projectId: PROJECT });
  recordSnapshotAt(PROJECT, "2026-09-05 00:00:00", "# Only newer\nRecorded after the episode.");

  const copyId = "prj_copy_knowledgenewer";
  const fake = startFakeLovable(happyPathScript(copyId));
  try {
    const rest = restFor(fake);
    const started = await startExperiment(seed.candidateId, { rest, ...CONNECTED });
    const runId = (started as { run_id: number }).run_id;
    await runExperiment(runId, { rest, sleep: noopSleep });

    const putCall = fake.calls.find(
      (c) => c.method === "PUT" && c.path === `/v1/projects/${copyId}/knowledge`,
    );
    assert.ok(putCall);
    const ruleDetail = store.getRule(seed.ruleId) as { rule: { instruction: string } };
    const expected = composeManagedKnowledge("# Only newer\nRecorded after the episode.", [
      { id: seed.ruleId, instruction: ruleDetail.rule.instruction },
    ]).final_content;
    assert.equal((putCall!.body as { content: string }).content, expected);
  } finally {
    await fake.close();
  }
});

test("Knowledge sent to the copy: base is empty when no snapshot has ever been recorded", async () => {
  const PROJECT = "prj_knowledge_none";
  newProject(PROJECT);
  const seed = seedCandidate({ projectId: PROJECT });

  const copyId = "prj_copy_knowledgenone";
  const fake = startFakeLovable(happyPathScript(copyId));
  try {
    const rest = restFor(fake);
    const started = await startExperiment(seed.candidateId, { rest, ...CONNECTED });
    const runId = (started as { run_id: number }).run_id;
    await runExperiment(runId, { rest, sleep: noopSleep });

    const putCall = fake.calls.find(
      (c) => c.method === "PUT" && c.path === `/v1/projects/${copyId}/knowledge`,
    );
    assert.ok(putCall);
    const ruleDetail = store.getRule(seed.ruleId) as { rule: { instruction: string } };
    const expected = composeManagedKnowledge("", [
      { id: seed.ruleId, instruction: ruleDetail.rule.instruction },
    ]).final_content;
    assert.equal((putCall!.body as { content: string }).content, expected);
  } finally {
    await fake.close();
  }
});

// ----------------------------------------------------------- budget refusal

test("budget refusal: exact string, current usage and budget", async () => {
  const seed = seedCandidate();
  store.setSettings({ lovable_monthly_credit_budget: "1" });
  const usedBefore = store.creditsThisMonth();
  const projected = store.lastKnownTestCost() ?? 2;
  assert.ok(usedBefore + projected > 1, "test setup must actually exceed the budget");

  const fake = startFakeLovable({});
  try {
    const rest = restFor(fake);
    const result = await startExperiment(seed.candidateId, { rest, ...CONNECTED });
    assert.deepEqual(result, {
      refused: `This would exceed your monthly Lovable credit budget (${usedBefore} of 1 used).`,
    });
    assert.equal(fake.calls.length, 0, "a refused start never touches Lovable");
  } finally {
    await fake.close();
    store.setSettings({ lovable_monthly_credit_budget: "12" });
  }
});

// ------------------------------------------------------- one run at a time

test("second start while one is running: refused", async () => {
  const first = seedCandidate();
  const second = seedCandidate();

  const { id: runningId } = store.createExperimentRun({
    rule_id: first.ruleId,
    correction_candidate_id: first.candidateId,
    task_episode_id: first.episodeId,
    source_project_id: SOURCE,
    request_message_external_id: first.requestExternalId,
  });
  store.updateExperimentRun(runningId, { status: "building" });

  const fake = startFakeLovable({});
  try {
    const rest = restFor(fake);
    const result = await startExperiment(second.candidateId, { rest, ...CONNECTED });
    assert.deepEqual(result, { refused: "A test is already running; one runs at a time." });
    assert.equal(fake.calls.length, 0);
  } finally {
    await fake.close();
    // leave the fixture run in a terminal state so it doesn't block later tests
    store.updateExperimentRun(runningId, { status: "cancelled" });
  }
});

test("queued race: a second startExperiment call right after the first (before runExperiment ever starts) is refused", async () => {
  const first = seedCandidate();
  const second = seedCandidate();
  const fake = startFakeLovable({});
  let firstRunId: number | undefined;
  try {
    const rest = restFor(fake);
    const firstResult = await startExperiment(first.candidateId, { rest, ...CONNECTED });
    assert.ok("run_id" in firstResult, `expected a run_id, got ${JSON.stringify(firstResult)}`);
    firstRunId = (firstResult as { run_id: number }).run_id;
    // firstRunId is still `queued` here -- runExperiment was never called --
    // which is exactly the gap runningExperimentRun (Task 1) alone leaves
    // open (it only looks at copying/building); activeExperimentRun closes
    // it by also checking recent queued rows.

    const secondResult = await startExperiment(second.candidateId, { rest, ...CONNECTED });
    assert.deepEqual(secondResult, { refused: "A test is already running; one runs at a time." });
    assert.equal(fake.calls.length, 0, "a refused start never touches Lovable");
  } finally {
    await fake.close();
    if (firstRunId !== undefined) {
      store.updateExperimentRun(firstRunId, { status: "cancelled" });
    }
  }
});

// ------------------------------------------------------------- not connected

test("not connected: refused with the exact copy, before touching Lovable", async () => {
  const seed = seedCandidate();
  const fake = startFakeLovable({});
  try {
    const rest = restFor(fake);
    // No `connected` override here -- exercises the real status().connected
    // path, which is false because HARNESS_AUTH_PATH points at a file that
    // was never written.
    const result = await startExperiment(seed.candidateId, { rest });
    assert.deepEqual(result, {
      refused: "Harness is not connected — connect on the Projects page.",
    });
    assert.equal(fake.calls.length, 0);
  } finally {
    await fake.close();
  }
});

// -------------------------------------------------------- no request to replay

test("no original request: refused when the candidate's episode has no evidence message", async () => {
  const episode = store.createTaskEpisode({
    project_id: SOURCE,
    title: "No evidence episode",
    provenance: "manual",
  }) as { id: number };
  const candidate = store.createCorrectionCandidate({
    task_episode_id: episode.id,
    classification: "defect_correction",
    is_correction: true,
    reusable: true,
    proposed_scope: "project",
    summary: "orphan candidate",
    confidence: 0.5,
    evidence_reason: "none",
    evidence_history_item_ids: [],
  }) as { id: number };
  const learning = store.createLearning({
    correction_candidate_id: candidate.id,
    observed_problem: "x",
    desired_behavior: "y",
    reuse_rationale: "z",
    proposed_scope: "project",
    provenance: "manual",
    created_by: "test",
  }) as { id: number };
  store.createRule({
    learning_id: learning.id,
    correction_candidate_id: candidate.id,
    instruction: "Some rule with no evidence message behind it.",
    scope: "project",
    applies_when: "n/a",
    predicted_failure: "n/a",
    ownership: "harness",
    created_by: "test",
  });

  const fake = startFakeLovable({});
  try {
    const rest = restFor(fake);
    const result = await startExperiment(candidate.id, { rest, ...CONNECTED });
    assert.deepEqual(result, { refused: "This suggestion has no original request to replay." });
    assert.equal(fake.calls.length, 0);
  } finally {
    await fake.close();
  }
});

// -------------------------------------------------- cleanupCopy unit tests

test("cleanupCopy: keep_test_copies=true skips deletion entirely", async () => {
  const seed = seedCandidate();
  store.setSettings({ keep_test_copies: "true" });
  const { id: runId } = store.createExperimentRun({
    rule_id: seed.ruleId,
    correction_candidate_id: seed.candidateId,
    task_episode_id: seed.episodeId,
    source_project_id: SOURCE,
    request_message_external_id: seed.requestExternalId,
  });
  store.updateExperimentRun(runId, { copy_project_id: "prj_kept" });
  const fake = startFakeLovable({
    deleteProject: () => ({ status: 204 }),
  });
  try {
    const rest = restFor(fake);
    await cleanupCopy(store.getExperimentRun(runId)!, rest);
    assert.equal(
      fake.calls.length,
      0,
      "no delete/patch call is made when keep_test_copies is true",
    );
    assert.equal(store.getExperimentRun(runId)!.copy_deleted, 0);
  } finally {
    await fake.close();
    store.setSettings({ keep_test_copies: "false" });
    // Round 6 Task 6b: this row was created directly via createExperimentRun
    // and never left `queued` -- kickExperimentRunner (a later test in this
    // file) picks the OLDEST queued row across the whole process, so a
    // fixture row like this one must not linger as the oldest queued row
    // forever.
    store.updateExperimentRun(runId, { status: "cancelled" });
  }
});

// ------------------------------------------------- kickExperimentRunner

test("kickExperimentRunner: runs the oldest queued run once via the fake server, leaving a newer queued run untouched", async () => {
  // Both rows are created directly (not via startExperiment, which itself
  // refuses a second start while one is already queued/running -- exactly
  // the scenario this test needs two queued rows to exist for at once).
  const older = seedCandidate();
  const newer = seedCandidate();
  const { id: olderRunId } = store.createExperimentRun({
    rule_id: older.ruleId,
    correction_candidate_id: older.candidateId,
    task_episode_id: older.episodeId,
    source_project_id: SOURCE,
    request_message_external_id: older.requestExternalId,
  });
  const { id: newerRunId } = store.createExperimentRun({
    rule_id: newer.ruleId,
    correction_candidate_id: newer.candidateId,
    task_episode_id: newer.episodeId,
    source_project_id: SOURCE,
    request_message_external_id: newer.requestExternalId,
  });

  const fake = startFakeLovable(happyPathScript("prj_copy_kick"));
  try {
    await kickExperimentRunner({ rest: restFor(fake), sleep: noopSleep });

    assert.equal(
      store.getExperimentRun(olderRunId)!.status,
      "judging",
      "the oldest queued run was driven all the way through",
    );
    assert.equal(
      store.getExperimentRun(newerRunId)!.status,
      "queued",
      "a single kick drives exactly one run -- the newer queued row is untouched",
    );
    const chatCalls = fake.calls.filter((c) => c.method === "POST" && c.path.endsWith("/messages"));
    assert.equal(chatCalls.length, 1, "only the oldest run's request was ever replayed");
  } finally {
    await fake.close();
    _reset();
    // Leave the untouched queued row terminal so it can't be picked up by
    // (and change the fixture assumptions of) a later test in this file.
    store.updateExperimentRun(newerRunId, { status: "cancelled" });
  }
});

test("kickExperimentRunner: a no-op when nothing is queued and no run is in flight", async () => {
  await kickExperimentRunner({ rest: createLovableRest({ baseUrl: "http://127.0.0.1:1" }) });
  // No assertion beyond "this resolved without throwing and touched
  // nothing" -- every run seeded by an earlier test in this file is left in
  // a terminal state by the time its own test finishes, so any Lovable call
  // reaching that unreachable baseUrl would itself prove a bug (the fake
  // rest client above is never given the chance to matter).
});

test("kickExperimentRunner: a second call while one is in flight returns the same promise, and never drives a second run concurrently", async () => {
  const first = seedCandidate();
  const second = seedCandidate();
  const { id: firstRunId } = store.createExperimentRun({
    rule_id: first.ruleId,
    correction_candidate_id: first.candidateId,
    task_episode_id: first.episodeId,
    source_project_id: SOURCE,
    request_message_external_id: first.requestExternalId,
  });
  const { id: secondRunId } = store.createExperimentRun({
    rule_id: second.ruleId,
    correction_candidate_id: second.candidateId,
    task_episode_id: second.episodeId,
    source_project_id: SOURCE,
    request_message_external_id: second.requestExternalId,
  });

  const fake = startFakeLovable(happyPathScript("prj_copy_inflight"));
  try {
    const rest = restFor(fake);
    // Both calls happen before either has a chance to await anything --
    // the in-flight promise is assigned synchronously inside
    // kickExperimentRunner (see its own doc comment), so the second call
    // here is guaranteed to observe it already set.
    const p1 = kickExperimentRunner({ rest, sleep: noopSleep });
    const p2 = kickExperimentRunner({ rest, sleep: noopSleep });
    assert.equal(p1, p2, "a call made while one is in flight returns that exact same promise");

    await p1;

    assert.equal(store.getExperimentRun(firstRunId)!.status, "judging");
    assert.equal(
      store.getExperimentRun(secondRunId)!.status,
      "queued",
      "the in-flight guard kept a second run from ever starting concurrently",
    );
  } finally {
    await fake.close();
    _reset();
    store.updateExperimentRun(secondRunId, { status: "cancelled" });
  }
});

test("kickExperimentRunner: a crashed run (stale heartbeat) is marked failed with the restart sentence before the next queued run is driven", async () => {
  const crashed = seedCandidate();
  const { id: crashedRunId } = store.createExperimentRun({
    rule_id: crashed.ruleId,
    correction_candidate_id: crashed.candidateId,
    task_episode_id: crashed.episodeId,
    source_project_id: SOURCE,
    request_message_external_id: crashed.requestExternalId,
  });
  store.updateExperimentRun(crashedRunId, { status: "copying", copy_project_id: "prj_ghost" });
  // updateExperimentRun always stamps heartbeat_at = now(); backdate it
  // directly to simulate a process that died 25 minutes ago (past the
  // 20-minute crash window), same direct-db convention recordSnapshotAt
  // above uses.
  db.prepare(
    `UPDATE experiment_runs SET heartbeat_at = datetime('now', '-25 minutes') WHERE id = ?`,
  ).run(crashedRunId);

  const queued = seedCandidate();
  const { id: queuedRunId } = store.createExperimentRun({
    rule_id: queued.ruleId,
    correction_candidate_id: queued.candidateId,
    task_episode_id: queued.episodeId,
    source_project_id: SOURCE,
    request_message_external_id: queued.requestExternalId,
  });

  const fake = startFakeLovable(happyPathScript("prj_copy_aftercrash"));
  try {
    await kickExperimentRunner({ rest: restFor(fake), sleep: noopSleep });

    const crashedRow = store.getExperimentRun(crashedRunId)!;
    assert.equal(crashedRow.status, "failed");
    assert.equal(crashedRow.error, "Harness restarted while the test was running.");

    assert.equal(
      store.getExperimentRun(queuedRunId)!.status,
      "judging",
      "the queued run was still picked up and driven in the same kick",
    );
  } finally {
    await fake.close();
    _reset();
  }
});

test("runExperiment: calls ensureFreshToken exactly once, before the first Lovable call", async () => {
  const seed = seedCandidate();
  // The run row is created directly (bypassing startExperiment's own budget
  // check) -- this test is about runExperiment's own ensureFreshToken call,
  // not startExperiment, and this suite's shared monthly credit ledger is
  // already tight by the time this (deliberately last) runExperiment test
  // in the file runs -- same reasoning as the kickExperimentRunner tests
  // above, which construct their own fixture rows the same way.
  const { id: runId } = store.createExperimentRun({
    rule_id: seed.ruleId,
    correction_candidate_id: seed.candidateId,
    task_episode_id: seed.episodeId,
    source_project_id: SOURCE,
    request_message_external_id: seed.requestExternalId,
  });
  const fake = startFakeLovable(happyPathScript("prj_copy_tokenrefresh"));
  try {
    const rest = restFor(fake);

    let refreshCalls = 0;
    await runExperiment(runId, {
      rest,
      sleep: noopSleep,
      ensureFreshToken: async () => {
        refreshCalls += 1;
        assert.equal(fake.calls.length, 0, "ensureFreshToken ran before any Lovable REST call");
      },
    });

    assert.equal(refreshCalls, 1);
  } finally {
    await fake.close();
  }
});
