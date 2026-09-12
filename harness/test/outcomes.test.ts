// Round 4 Task C3 / spec §4 (v1-lite) + §4b (display) + §5 ("new since your
// last visit"): data-layer tests for the outcome-tracking health line on an
// ordinary Improvement item, the Inbox count (pending improvements + open
// retire proposals), and the inbox_last_seen_at setting. Isolated temp DB,
// set before db.ts is first imported (same pattern as retire.test.ts /
// rule-health.test.ts). No LLM.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HARNESS_DB_PATH = join(
  mkdtempSync(join(tmpdir(), "harness-outcomes-test-")),
  "harness.db",
);

const { db } = await import("../src/db.js");
const store = await import("../src/store.js");
const imp = await import("../src/improvements.js");

const PROJECT = "outcomes-test-project";
db.prepare(`INSERT INTO allowed_projects (lovable_project_id, label) VALUES (?, ?)`).run(
  PROJECT,
  "test",
);
store.upsertProject({ lovable_project_id: PROJECT, name: "Test Project" });

// A full correction_candidate -> learning -> rule chain. When `writtenAt` is
// given, the rule is accepted and made 'active' with one 'written' Knowledge
// version backdated to it (a live rule, per store.listLiveRulesWithTargets);
// otherwise it's left 'proposed' (not live) -- the "no health on a
// not-live rule" case.
function makeCorrection(input: { instruction: string; writtenAt?: string }) {
  const episode = store.createTaskEpisode({
    project_id: PROJECT,
    title: "episode",
    provenance: "llm_derived",
    started_at: input.writtenAt ?? "2026-08-01T00:00:00Z",
    evidence_history_item_ids: [],
  }) as { id: number };
  const cc = store.createCorrectionCandidate({
    task_episode_id: episode.id,
    classification: "constraint_restatement",
    is_correction: true,
    reusable: true,
    proposed_scope: "project",
    summary: "seed correction",
    evidence_history_item_ids: [],
  }) as { id: number };
  const learning = store.createLearning({
    correction_candidate_id: cc.id,
    observed_problem: "seed",
    desired_behavior: "seed",
    reuse_rationale: "seed",
    proposed_scope: "project",
    provenance: "llm_derived",
    created_by: "test",
  }) as { id: number };
  const rule = store.createRule({
    learning_id: learning.id,
    correction_candidate_id: cc.id,
    instruction: input.instruction,
    scope: "project",
    applies_when: "n/a",
    predicted_failure: "n/a",
    ownership: "harness",
    created_by: "test",
  }) as { id: number };

  if (input.writtenAt) {
    store.recordHumanCorrectionDecision({
      id: cc.id,
      final_classification: "constraint_restatement",
      reusable: true,
      proposed_scope: "project",
      reviewer: "test",
    });
    store.updateRule({ id: rule.id, state: "approved", scope: "project", actor: "test" });
    store.updateRule({ id: rule.id, state: "active", actor: "test" });
    db.prepare(
      `INSERT INTO knowledge_versions
         (rule_id, target, project_id, previous_content, new_content, previous_sha256, new_sha256, rule_ids_json, status, actor, written_at)
       VALUES (?, 'project', ?, '', '', '', '', '[]', 'written', 'test', ?)`,
    ).run(rule.id, PROJECT, input.writtenAt);
  }

  return { ruleId: rule.id, correctionId: cc.id };
}

test("buildImprovement: a live rule with a rule_health row carries health, `since` from the written version", () => {
  const { ruleId, correctionId } = makeCorrection({
    instruction: "Always use design tokens.",
    writtenAt: "2026-08-01T00:00:00.000Z",
  });
  store.upsertRuleHealth({
    rule_id: ruleId,
    applicable_tasks: 4,
    helped: 2,
    hurt: 2,
    last_applicable_at: "2026-08-10T00:00:00Z",
    contradicted_by_rule_id: null,
    unused_since: null,
    status: "watch",
    snoozed_until: null,
  });

  const item = imp.getImprovement(correctionId);
  assert.ok(item);
  assert.deepEqual(item!.health, {
    applicable_tasks: 4,
    helped: 2,
    hurt: 2,
    last_applicable_at: "2026-08-10T00:00:00Z",
    since: "2026-08-01T00:00:00.000Z",
  });
});

test("buildImprovement: a live rule with no rule_health row yet has health: null", () => {
  const { correctionId } = makeCorrection({
    instruction: "No health row yet.",
    writtenAt: "2026-08-05T00:00:00.000Z",
  });
  const item = imp.getImprovement(correctionId);
  assert.equal(item!.health, null);
});

test("buildImprovement: a proposed (not live) rule has health: null, even with a stray rule_health row", () => {
  const { ruleId, correctionId } = makeCorrection({ instruction: "Not live yet." });
  store.upsertRuleHealth({
    rule_id: ruleId,
    applicable_tasks: 9,
    helped: 9,
    hurt: 0,
    last_applicable_at: null,
    contradicted_by_rule_id: null,
    unused_since: null,
    status: "healthy",
    snoozed_until: null,
  });
  const item = imp.getImprovement(correctionId);
  assert.equal(item!.health, null);
});

test("countInboxItems: counts one more pending improvement and one more open retire proposal", () => {
  const before = store.countInboxItems();

  // A brand-new correction with no rule at all is pending.
  const episode = store.createTaskEpisode({
    project_id: PROJECT,
    title: "episode",
    provenance: "llm_derived",
    started_at: "2026-08-06T00:00:00Z",
    evidence_history_item_ids: [],
  }) as { id: number };
  store.createCorrectionCandidate({
    task_episode_id: episode.id,
    classification: "constraint_restatement",
    is_correction: true,
    reusable: true,
    proposed_scope: "project",
    summary: "a pending correction",
    evidence_history_item_ids: [],
  });

  // A live rule with one open retire proposal.
  const { ruleId } = makeCorrection({
    instruction: "Retire me.",
    writtenAt: "2026-08-07T00:00:00.000Z",
  });
  store.createRetireProposal({ rule_id: ruleId, reason: "unused", evidence: [] });

  const after = store.countInboxItems();
  assert.equal(after.pending, before.pending + 1);
  assert.equal(after.retire, before.retire + 1);
});

test("countInboxItems: a decided (accepted, no open proposal) live rule counts as neither pending nor retire", () => {
  const before = store.countInboxItems();
  makeCorrection({
    instruction: "Already accepted, nothing open.",
    writtenAt: "2026-08-08T00:00:00.000Z",
  });
  const after = store.countInboxItems();
  assert.equal(after.pending, before.pending);
  assert.equal(after.retire, before.retire);
});

test("inbox_last_seen_at: defaults to empty; mark_seen's setSettings stores an ISO date and reads it back", () => {
  assert.equal(store.getSetting("inbox_last_seen_at"), "");
  const now = new Date().toISOString();
  const updated = store.setSettings({ inbox_last_seen_at: now });
  assert.equal(updated.inbox_last_seen_at, now);
  assert.equal(store.getSetting("inbox_last_seen_at"), now);
});

test("inbox_last_seen_at: rejects a non-date value; empty string is always valid", () => {
  assert.throws(() => store.setSettings({ inbox_last_seen_at: "not-a-date" }));
  const updated = store.setSettings({ inbox_last_seen_at: "" });
  assert.equal(updated.inbox_last_seen_at, "");
});
