import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Round 6 fix wave item D: the API route (src/routes/api/public/harness/
// improvements.ts, in the root app) relays a thrown Error's own `message`
// verbatim as a 400 `{ error }` body -- testAction (experiments-actions.ts)
// is the function that throws it for a refused `test` action, and no test
// in this repo (Task 6b's own suite included) previously exercised it
// directly. These tests cover exactly that contract.
//
// Only refusal paths are exercised here: testAction's own success path
// calls kickExperimentRunner() fire-and-forget behind a REAL, non-injectable
// createLovableRest() (no deps parameter of its own) -- driving it far
// enough to succeed would risk a real Lovable network call, which no test
// in this repo may ever make. Every refusal below is a pure local read
// (connected/candidate/rule/budget checks), so nothing here ever reaches
// Lovable -- startExperiment's own refusal-order tests (experiments.test.ts)
// already establish that with a fake server watching for exactly that.
const tmp = mkdtempSync(join(tmpdir(), "harness-experiments-actions-test-"));
process.env.HARNESS_DB_PATH = join(tmp, "harness.db");
process.env.HARNESS_AUTH_PATH = join(tmp, "lovable-auth.json");

const store = await import("../src/store.js");
const { isTestAction, testAction } = await import("../src/executor/experiments-actions.js");

const SOURCE = "prj_source";
store.allowProject(SOURCE, "Source project");
store.upsertProject({ lovable_project_id: SOURCE, name: "Source project", workspace_id: "ws_1" });

/** Marks lovable-auth.ts#status().connected true via a plain local file
 * write -- that check only ever reads the auth file's own shape (an
 * access_token is present), never verifies it against a real server, so
 * this makes every refusal PAST "not connected" reachable without an actual
 * OAuth grant or any network call. */
function markConnected(): void {
  writeFileSync(
    process.env.HARNESS_AUTH_PATH!,
    JSON.stringify({
      tokens: { access_token: "fake-local-token", token_type: "Bearer", expires_in: 999_999_999 },
      tokens_saved_at: Date.now(),
    }),
  );
}

let seedSeq = 0;

/** A minimal candidate -> learning -> rule chain with a real request
 * message behind it -- the same shape experiments.test.ts's own
 * seedCandidate builds, trimmed to just what testAction's refusal checks
 * read. */
function seedCandidateWithRule(): {
  candidateId: number;
  ruleId: number;
  episodeId: number;
  requestExternalId: string;
} {
  seedSeq += 1;
  const requestExternalId = `aimsg_req_${seedSeq}`;
  const userRow = store.upsertHistoryItem({
    project_id: SOURCE,
    kind: "message",
    external_id: requestExternalId,
    role: "user",
    content: "Add a contact form to the landing page.",
    occurred_at: "2026-09-01 10:00:00",
    provenance: "lovable_mcp",
  }) as { id: number };
  const episode = store.createTaskEpisode({
    project_id: SOURCE,
    title: `Episode ${seedSeq}`,
    provenance: "manual",
    started_at: "2026-09-01 10:00:00",
    evidence_history_item_ids: [userRow.id],
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
    evidence_history_item_ids: [userRow.id],
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
    instruction: "Always validate email fields on contact forms before allowing submit.",
    scope: "project",
    applies_when: "a contact form is added or edited",
    predicted_failure: "invalid emails get submitted silently",
    ownership: "harness",
    created_by: "test",
  }) as { id: number };
  return { candidateId: candidate.id, ruleId: rule.id, episodeId: episode.id, requestExternalId };
}

test("isTestAction: true only for a plain {action:'test'} shape", () => {
  assert.equal(isTestAction({ action: "test", id: 1 }), true);
  assert.equal(isTestAction({ action: "accept", id: 1 }), false);
  assert.equal(isTestAction(null), false);
  assert.equal(isTestAction(undefined), false);
  assert.equal(isTestAction("test"), false);
  assert.equal(isTestAction({}), false);
});

test("testAction: not connected -- throws the exact sentence the route relays verbatim as a 400 body", async () => {
  // HARNESS_AUTH_PATH points at a file that was never written in this
  // process yet, so status().connected is false -- the very first check.
  await assert.rejects(
    () => testAction({ action: "test", id: 999_999 }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal(err.message, "Harness Ledger is not connected — connect on the Projects page.");
      return true;
    },
  );
});

test("testAction: no original request -- throws the exact sentence", async () => {
  markConnected();
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

  await assert.rejects(
    () => testAction({ action: "test", id: candidate.id }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal(err.message, "This suggestion has no original request to replay.");
      return true;
    },
  );
});

test("testAction: budget refusal -- throws the exact sentence with current usage and budget", async () => {
  markConnected();
  const { candidateId } = seedCandidateWithRule();
  store.setSettings({ lovable_monthly_credit_budget: "1" });
  try {
    const usedBefore = store.creditsThisMonth();
    await assert.rejects(
      () => testAction({ action: "test", id: candidateId }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(
          err.message,
          `This would exceed your monthly Lovable credit budget (${usedBefore} of 1 used).`,
        );
        return true;
      },
    );
  } finally {
    store.setSettings({ lovable_monthly_credit_budget: "12" });
  }
});

test("testAction: already running -- throws the exact sentence, and no new run is queued", async () => {
  markConnected();
  const running = seedCandidateWithRule();
  const { id: runningRunId } = store.createExperimentRun({
    rule_id: running.ruleId,
    correction_candidate_id: running.candidateId,
    task_episode_id: running.episodeId,
    source_project_id: SOURCE,
    request_message_external_id: running.requestExternalId,
  });
  store.updateExperimentRun(runningRunId, { status: "building" });

  const other = seedCandidateWithRule();
  try {
    await assert.rejects(
      () => testAction({ action: "test", id: other.candidateId }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(err.message, "A test is already running; one runs at a time.");
        return true;
      },
    );
    assert.equal(
      store.listExperimentRuns({ rule_id: other.ruleId }).length,
      0,
      "a refused test action never queues a run",
    );
  } finally {
    store.updateExperimentRun(runningRunId, { status: "cancelled" });
  }
});
