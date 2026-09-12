// Round 4 Task C2 / spec §4b-§5: retirement proposals and the Retire / Keep
// / Re-add actions. Isolated temp DB for this test file, set before db.ts is
// first imported (same pattern as improvements.test.ts / rule-health.test.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HARNESS_DB_PATH = join(
  mkdtempSync(join(tmpdir(), "harness-retire-test-")),
  "harness.db",
);

const { db } = await import("../src/db.js");
const store = await import("../src/store.js");
const imp = await import("../src/improvements.js");
const { composeManagedKnowledge } = await import("../src/knowledge.js");
const { recomputeRuleHealth } = await import("../src/analysis/health.js");
const { proposeRetirements } = await import("../src/analysis/retire.js");
const { improvementGroup } = await import("../../src/lib/harness-ux.ts");

const PROJECT = "retire-test-project";
db.prepare(`INSERT INTO allowed_projects (lovable_project_id, label) VALUES (?, ?)`).run(
  PROJECT,
  "test",
);
store.upsertProject({ lovable_project_id: PROJECT, name: "Test Project" });

let historyId = 0;
function message(content: string, occurredAt: string, role: "user" | "assistant" = "user") {
  const row = store.upsertHistoryItem({
    project_id: PROJECT,
    kind: "message",
    external_id: `m-${(historyId += 1)}`,
    role,
    content,
    occurred_at: occurredAt,
    provenance: "lovable_mcp",
  }) as { id: number };
  return row.id;
}

function classify(historyItemId: number, classification: string, tags: string[], summary = "") {
  db.prepare(
    `INSERT INTO message_classifications (history_item_id, classification, tags_json, summary) VALUES (?, ?, ?, ?)`,
  ).run(historyItemId, classification, JSON.stringify(tags), summary);
}

function episode(startedAt: string, evidenceIds: number[]) {
  const row = store.createTaskEpisode({
    project_id: PROJECT,
    title: `episode at ${startedAt}`,
    provenance: "llm_derived",
    started_at: startedAt,
    evidence_history_item_ids: evidenceIds,
  }) as { id: number };
  return row.id;
}

// Full correction_candidate -> learning -> rule chain, marked 'active' and
// reviewed/accepted (so buildImprovement's decision.status reads "accepted",
// matching a real accepted-then-retired flow), with a 'written' Knowledge
// version backdated to `writtenAt`.
function makeLiveRule(input: {
  instruction: string;
  predictedFailure: string;
  failureSignature: string;
  writtenAt: string;
}) {
  const episodeForRule = episode(input.writtenAt, []);
  const cc = store.createCorrectionCandidate({
    task_episode_id: episodeForRule,
    classification: "constraint_restatement",
    is_correction: true,
    reusable: true,
    proposed_scope: "project",
    summary: "seed correction for a retire fixture",
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
    predicted_failure: input.predictedFailure,
    ownership: "harness",
    created_by: "test",
  }) as { id: number };

  store.createVerificationPlan({
    rule_id: rule.id,
    failure_signature: input.failureSignature,
    failure_condition: "n/a",
    created_by: "test",
    verification_definition_ids: [],
  });

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

  return { ruleId: rule.id as number, correctionId: cc.id as number };
}

const WRITTEN_AT = "2026-08-01T00:00:00.000Z";
const NOW = new Date("2026-09-11T00:00:00Z");

// ---- Fixture: a rule that really hurt more than it helped, via the real
// recomputeRuleHealth pipeline (same shape as rule-health.test.ts's) ----

const HURT_INSTRUCTION = "Always use design tokens, never hardcoded colors.";
const { ruleId: hurtRuleId, correctionId: hurtCorrectionId } = makeLiveRule({
  instruction: HURT_INSTRUCTION,
  predictedFailure: "inline colors instead of design tokens",
  failureSignature: "design-system-bypassed",
  writtenAt: WRITTEN_AT,
});
db.prepare(`UPDATE rules SET scope_tags_json = ? WHERE id = ?`).run(
  JSON.stringify(["styling"]),
  hurtRuleId,
);

const reqA = message("Make the CTA button blue.", "2026-08-02T00:00:00Z");
classify(reqA, "new_task", ["styling"]);
const corrA = message(
  "You hardcoded a hex color instead of using the design token.",
  "2026-08-02T01:00:00Z",
);
classify(corrA, "correction", ["styling"], "design-system-bypassed");
episode("2026-08-02T00:00:00Z", [reqA, corrA]);

const reqB = message("Update the card background.", "2026-08-03T00:00:00Z");
classify(reqB, "new_task", ["styling"]);
const corrB = message("Still hardcoding colors on the card.", "2026-08-03T01:00:00Z");
classify(corrB, "correction", ["styling"], "design-system-bypassed");
episode("2026-08-03T00:00:00Z", [reqB, corrB]);

const reqC = message("Add a settings tab.", "2026-08-04T00:00:00Z");
classify(reqC, "new_task", ["styling"]);
episode("2026-08-04T00:00:00Z", [reqC]);

test("proposeRetirements: a retire_suggested rule gets one proposal (reason 'hurt', evidence = the hurt corrections); a second call creates none", () => {
  const health = recomputeRuleHealth(NOW);
  assert.ok(health.suggested >= 1);
  assert.equal(store.getRuleHealth(hurtRuleId)!.status, "retire_suggested");

  const first = proposeRetirements();
  assert.equal(first.created, 1);

  const open = store.listOpenRetireProposals();
  assert.equal(open.length, 1);
  const proposal = open[0]!;
  assert.equal(proposal.rule_id, hurtRuleId);
  assert.equal(proposal.reason, "hurt");
  assert.deepEqual([...proposal.evidence].sort(), [corrA, corrB].sort());

  // Idempotent: rule_health hasn't changed, so no second proposal.
  const second = proposeRetirements();
  assert.equal(second.created, 0);
  assert.equal(store.listOpenRetireProposals().length, 1);
});

test("listImprovements: the open proposal appears as a kind 'retire' item with a negative id", () => {
  const proposal = store.openRetireProposalForRule(hurtRuleId)!;
  const items = imp.listImprovements();
  const retireItem = items.find((i) => i.id === -proposal.id);
  assert.ok(retireItem, "the retire proposal must appear in listImprovements");
  assert.equal(retireItem!.kind, "retire");
  assert.equal(retireItem!.decision.status, "pending");
  assert.match(retireItem!.title, /^Retire: /);
  assert.ok(retireItem!.title.includes(HURT_INSTRUCTION));
  assert.equal(retireItem!.retire?.reason, "hurt");
  assert.equal(retireItem!.retire?.rule_id, hurtRuleId);
  // Evidence = the hurt corrections, as messages.
  assert.deepEqual([...retireItem!.evidence.map((e) => e.id)].sort(), [corrA, corrB].sort());
});

test("retire: the rule is retired, a pending version is staged whose new_content lacks the rule's text, the proposal is decided, and the original improvement now groups 'Retired'", () => {
  // A prior Knowledge snapshot with this rule already in the managed block,
  // so retire has something to recompose against.
  const before = composeManagedKnowledge("# Knowledge\n\nSome text the user wrote.", [
    { id: hurtRuleId, instruction: HURT_INSTRUCTION },
  ]).final_content;
  store.recordKnowledgeSnapshot({
    target: "project",
    project_id: PROJECT,
    content: before,
    fetched_by: "test",
  });

  const proposal = store.openRetireProposalForRule(hurtRuleId)!;
  const result = imp.improvementAction({ action: "retire", id: -proposal.id });

  // The rule is retired.
  assert.equal((store.getRule(hurtRuleId)!.rule as { state: string }).state, "retired");
  // A pending target-level write exists whose text no longer carries the
  // retired rule's instruction (rule_id is null -- see retireRule's comment
  // in improvements.ts -- so it must not appear under this rule's own
  // knowledge_versions list).
  const pending = (
    store.listPendingKnowledgeWrites() as { new_content: string; rule_id: number | null }[]
  ).find((p) => p.rule_id === null);
  assert.ok(pending, "a target-level recompose write must be staged");
  assert.ok(!pending!.new_content.includes(HURT_INSTRUCTION));
  assert.equal(
    store.listKnowledgeVersions(hurtRuleId).some((v) => v.status === "pending"),
    false,
    "the retire write is target-level (rule_id null), not attached to this rule",
  );
  // The proposal is decided.
  assert.equal(store.getRetireProposal(proposal.id)!.status, "retired");
  assert.equal(store.listOpenRetireProposals().length, 0);
  // The returned/original improvement now groups "Retired".
  assert.equal(result.id, hurtCorrectionId);
  assert.equal(result.decision.retired, true);
  assert.equal(result.decision.status, "accepted");
  assert.equal(
    improvementGroup({
      status: result.decision.status,
      writeStatus: result.lovable.write_status,
      testFirst: result.decision.test_first,
      retired: result.decision.retired,
    }),
    "Retired",
  );
  const refetched = imp.getImprovement(hurtCorrectionId)!;
  assert.equal(refetched.decision.retired, true);
});

test("stageApprovedWrites and activeRulesForTarget both ignore a retired rule", () => {
  assert.equal(
    store.activeRulesForTarget("project", PROJECT).some((r) => r.id === hurtRuleId),
    false,
  );
  const { staged } = imp.stageApprovedWrites();
  assert.equal(
    staged,
    0,
    "the retired rule's own (still 'accepted') improvement must not be staged",
  );
});

// ---- Fixture: 'keep' ----

const { ruleId: keepRuleId, correctionId: keepCorrectionId } = makeLiveRule({
  instruction: "Keep-me rule.",
  predictedFailure: "n/a",
  failureSignature: "keep-me-signature",
  writtenAt: WRITTEN_AT,
});

test("keep: the proposal is decided 'kept' and the rule's health is snoozed ~30 days out", () => {
  store.upsertRuleHealth({
    rule_id: keepRuleId,
    applicable_tasks: 4,
    helped: 1,
    hurt: 3,
    last_applicable_at: "2026-09-01T00:00:00Z",
    contradicted_by_rule_id: null,
    unused_since: null,
    status: "retire_suggested",
    snoozed_until: null,
  });
  const proposal = store.createRetireProposal({
    rule_id: keepRuleId,
    reason: "hurt",
    evidence: [],
  });

  const before = Date.now();
  const result = imp.improvementAction({ action: "keep", id: -proposal.id });
  assert.equal(result.id, keepCorrectionId);

  assert.equal(store.getRetireProposal(proposal.id)!.status, "kept");
  const health = store.getRuleHealth(keepRuleId)!;
  assert.equal(health.status, "snoozed");
  assert.ok(health.snoozed_until);
  const snoozedUntilMs = new Date(health.snoozed_until!).getTime();
  const daysOut = (snoozedUntilMs - before) / (24 * 60 * 60 * 1000);
  assert.ok(daysOut > 29 && daysOut < 31, `expected ~30 days out, got ${daysOut}`);
  // The rule itself is untouched -- "keep" is a snooze, not a decision.
  assert.equal((store.getRule(keepRuleId)!.rule as { state: string }).state, "active");
});

// ---- Fixture: 'readd' ----

const { ruleId: readdRuleId, correctionId: readdCorrectionId } = makeLiveRule({
  instruction: "Readd-me rule.",
  predictedFailure: "n/a",
  failureSignature: "readd-me-signature",
  writtenAt: WRITTEN_AT,
});

test("readd: the rule is approved again and a Knowledge write is staged", () => {
  store.recordKnowledgeSnapshot({
    target: "project",
    project_id: PROJECT,
    content: "# Knowledge\n\nExisting text.",
    fetched_by: "test",
  });
  imp.improvementAction({ action: "retire", rule_id: readdRuleId });
  assert.equal((store.getRule(readdRuleId)!.rule as { state: string }).state, "retired");
  store.cancelPendingKnowledgeWrites(readdRuleId, "test setup: clear the retire recompose write");

  const result = imp.improvementAction({ action: "readd", id: readdCorrectionId });
  assert.equal(result.id, readdCorrectionId);
  assert.equal((store.getRule(readdRuleId)!.rule as { state: string }).state, "approved");
  const pending = store.listKnowledgeVersions(readdRuleId).filter((v) => v.status === "pending");
  assert.equal(pending.length, 1, "readd must stage a Knowledge write for this rule");
});

// ---- Manual retire (Instructions page path): rule_id, no open proposal ----

const { ruleId: manualRuleId } = makeLiveRule({
  instruction: "Manually retired rule.",
  predictedFailure: "n/a",
  failureSignature: "manual-signature",
  writtenAt: WRITTEN_AT,
});

test("retire via rule_id (no open proposal): the rule is retired all the same", () => {
  assert.equal(store.openRetireProposalForRule(manualRuleId), null);
  imp.improvementAction({ action: "retire", rule_id: manualRuleId });
  assert.equal((store.getRule(manualRuleId)!.rule as { state: string }).state, "retired");
});

// ---- Reason derivation: contradiction / unused, via a hand-set rule_health
// row (no episode pipeline needed -- proposeRetirements only reads
// rule_health's own fields to pick a reason). ----

const { ruleId: contradictionRuleId } = makeLiveRule({
  instruction: "Contradicted rule.",
  predictedFailure: "n/a",
  failureSignature: "contradicted-signature",
  writtenAt: WRITTEN_AT,
});
const { ruleId: contradictingRuleId } = makeLiveRule({
  instruction: "The newer, contradicting rule.",
  predictedFailure: "n/a",
  failureSignature: "contradicting-signature",
  writtenAt: WRITTEN_AT,
});

test("proposeRetirements: reason 'contradiction' when contradicted_by_rule_id is set (hurt not > helped)", () => {
  store.upsertRuleHealth({
    rule_id: contradictionRuleId,
    applicable_tasks: 0,
    helped: 0,
    hurt: 0,
    last_applicable_at: null,
    contradicted_by_rule_id: contradictingRuleId,
    unused_since: null,
    status: "retire_suggested",
    snoozed_until: null,
  });
  proposeRetirements();
  const proposal = store.openRetireProposalForRule(contradictionRuleId)!;
  assert.equal(proposal.reason, "contradiction");
  assert.deepEqual(proposal.evidence, [contradictingRuleId]);

  const item = imp.listImprovements().find((i) => i.id === -proposal.id)!;
  assert.equal(item.retire?.contradicts_instruction, "The newer, contradicting rule.");
});

const { ruleId: unusedRuleId } = makeLiveRule({
  instruction: "Unused rule.",
  predictedFailure: "n/a",
  failureSignature: "unused-signature",
  writtenAt: WRITTEN_AT,
});

test("proposeRetirements: reason 'unused' when neither hurt nor contradicted", () => {
  store.upsertRuleHealth({
    rule_id: unusedRuleId,
    applicable_tasks: 0,
    helped: 0,
    hurt: 0,
    last_applicable_at: null,
    contradicted_by_rule_id: null,
    unused_since: WRITTEN_AT,
    status: "retire_suggested",
    snoozed_until: null,
  });
  proposeRetirements();
  const proposal = store.openRetireProposalForRule(unusedRuleId)!;
  assert.equal(proposal.reason, "unused");
  assert.deepEqual(proposal.evidence, []);
});

// ---- Fix wave item 4: readd resets the rule_health baseline window ----

const { ruleId: rebaselineRuleId, correctionId: rebaselineCorrectionId } = makeLiveRule({
  instruction: "Always sanitize file uploads before storing them.",
  predictedFailure: "uploaded files are stored without sanitization",
  failureSignature: "unsanitized-file-upload",
  writtenAt: WRITTEN_AT,
});
db.prepare(`UPDATE rules SET scope_tags_json = ? WHERE id = ?`).run(
  JSON.stringify(["uploads"]),
  rebaselineRuleId,
);

test("readd resets the rule_health baseline: hurt episodes from before the re-add no longer count, and contradicted_by_rule_id/unused_since are cleared", () => {
  const reqX = message("Add a file upload widget.", "2026-08-05T00:00:00Z");
  classify(reqX, "new_task", ["uploads"]);
  const corrX = message(
    "You stored the uploaded file without sanitizing it.",
    "2026-08-05T01:00:00Z",
  );
  classify(corrX, "correction", ["uploads"], "unsanitized-file-upload");
  episode("2026-08-05T00:00:00Z", [reqX, corrX]);

  const reqY = message("Add another upload field.", "2026-08-06T00:00:00Z");
  classify(reqY, "new_task", ["uploads"]);
  const corrY = message("Still not sanitizing uploads.", "2026-08-06T01:00:00Z");
  classify(corrY, "correction", ["uploads"], "unsanitized-file-upload");
  episode("2026-08-06T00:00:00Z", [reqY, corrY]);

  // A third applicable-but-not-hurting episode, so applicable_tasks reaches
  // MIN_APPLICABLE_FOR_RETIRE (3) and hurt(2) > helped(1) actually triggers
  // retire_suggested (same shape as the file's top hurtRuleId fixture).
  const reqW = message("Add a settings toggle for uploads.", "2026-08-07T00:00:00Z");
  classify(reqW, "new_task", ["uploads"]);
  episode("2026-08-07T00:00:00Z", [reqW]);

  recomputeRuleHealth(new Date("2026-08-10T00:00:00Z"));
  const before = store.getRuleHealth(rebaselineRuleId)!;
  assert.equal(before.hurt, 2);
  assert.equal(before.status, "retire_suggested");
  assert.equal(before.baseline_at, null);

  // Force a contradiction signal too, so readd's reset can be observed.
  store.upsertRuleHealth({ ...before, contradicted_by_rule_id: 999999 });

  // Retire, then re-add -- readd resets the baseline to "now".
  imp.improvementAction({ action: "retire", rule_id: rebaselineRuleId });
  store.cancelPendingKnowledgeWrites(
    rebaselineRuleId,
    "test setup: clear the retire recompose write",
  );
  const beforeReadd = Date.now();
  imp.improvementAction({ action: "readd", id: rebaselineCorrectionId });

  const afterReadd = store.getRuleHealth(rebaselineRuleId)!;
  assert.equal(
    afterReadd.contradicted_by_rule_id,
    null,
    "contradicted_by_rule_id is cleared on readd",
  );
  assert.equal(afterReadd.unused_since, null, "unused_since is cleared on readd");
  assert.ok(afterReadd.baseline_at, "baseline_at is set on readd");
  assert.ok(new Date(afterReadd.baseline_at!).getTime() >= beforeReadd);

  // readd only approves the rule -- it goes back to 'active' (and so back
  // into recomputeRuleHealth's live-rule sweep) once the executor actually
  // finishes writing it to Knowledge (beat 2). Simulate that completing,
  // same as makeLiveRule's own setup, without touching first_written_at (it
  // must stay the ORIGINAL write date -- baseline_at, not a rewritten
  // first_written_at, is what moves the window).
  store.updateRule({ id: rebaselineRuleId, state: "active", actor: "test" });

  // A new episode dated after the re-add, applicable but not hurting -- only
  // 1 applicable task (MIN_APPLICABLE_FOR_RETIRE is 3), so this alone proves
  // the two pre-readd hurt episodes are excluded from the new window.
  const reqZ = message("Add a third upload field.", "2026-09-15T00:00:00Z");
  classify(reqZ, "new_task", ["uploads"]);
  episode("2026-09-15T00:00:00Z", [reqZ]);

  recomputeRuleHealth(new Date("2026-09-20T00:00:00Z"));
  const afterRecompute = store.getRuleHealth(rebaselineRuleId)!;
  assert.equal(afterRecompute.hurt, 0, "the pre-readd hurt episodes no longer count");
  assert.equal(
    afterRecompute.applicable_tasks,
    1,
    "only the post-readd episode is in the new window",
  );
  assert.equal(afterRecompute.status, "healthy");
});
