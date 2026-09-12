import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolated temp DB for this test file, set before db.ts is first imported.
process.env.HARNESS_DB_PATH = join(mkdtempSync(join(tmpdir(), "harness-rule-health-test-")), "harness.db");

const { db } = await import("../src/db.js");
const store = await import("../src/store.js");
const { recomputeRuleHealth } = await import("../src/analysis/health.js");

const PROJECT = "rule-health-project";
db.prepare(`INSERT INTO allowed_projects (lovable_project_id, label) VALUES (?, ?)`).run(PROJECT, "test");
store.upsertProject({ lovable_project_id: PROJECT, name: "Test Project" });

// A fixed "now" (today, per the environment) so every day-math in the test
// is exact rather than depending on when the suite happens to run.
const NOW = new Date("2026-09-11T00:00:00Z");
const RULE_WRITTEN_AT = "2026-09-01T00:00:00.000Z"; // 10 days before NOW

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

function episode(startedAt: string, evidenceIds: number[], projectId: string = PROJECT) {
  const row = store.createTaskEpisode({
    project_id: projectId,
    title: `episode at ${startedAt}`,
    provenance: "llm_derived",
    started_at: startedAt,
    evidence_history_item_ids: evidenceIds,
  }) as { id: number };
  return row.id;
}

// Builds a full rule chain (correction_candidate -> learning -> rule),
// exactly as the MCP tools / the miner would, then marks it 'active' with a
// 'written' Knowledge version backdated to `writtenAt` (store.ts has no way
// to backdate a write through recordKnowledgeReadback, which always stamps
// datetime('now'), so the write row is inserted directly here).
function makeLiveRule(input: {
  predictedFailure: string;
  failureSignature: string;
  scopeTags: string[] | null; // null = leave the v9 default '["general"]'
  writtenAt: string;
  projectId?: string;
}) {
  const projectId = input.projectId ?? PROJECT;
  const episodeForRule = episode(input.writtenAt, [], projectId);
  const cc = store.createCorrectionCandidate({
    task_episode_id: episodeForRule,
    classification: "constraint_restatement",
    is_correction: true,
    reusable: true,
    proposed_scope: "project",
    summary: "seed correction for a rule fixture",
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
    instruction: "Use design tokens, not hardcoded colors.",
    scope: "project",
    applies_when: "styling changes",
    predicted_failure: input.predictedFailure,
    ownership: "harness",
    created_by: "test",
  }) as { id: number };

  if (input.scopeTags) {
    db.prepare(`UPDATE rules SET scope_tags_json = ? WHERE id = ?`).run(
      JSON.stringify(input.scopeTags),
      rule.id,
    );
  }

  store.createVerificationPlan({
    rule_id: rule.id,
    failure_signature: input.failureSignature,
    failure_condition: "a styling change hardcodes a color instead of using a design token",
    created_by: "test",
    verification_definition_ids: [],
  });

  store.updateRule({ id: rule.id, state: "active", actor: "test" });

  db.prepare(
    `INSERT INTO knowledge_versions
       (rule_id, target, project_id, previous_content, new_content, previous_sha256, new_sha256, rule_ids_json, status, actor, written_at)
     VALUES (?, 'project', ?, '', '', '', '', '[]', 'written', 'test', ?)`,
  ).run(rule.id, projectId, input.writtenAt);

  return rule.id;
}

// ---- Fixture: one live rule, scope ["styling"], plus four episodes after it ----

const styledRuleId = makeLiveRule({
  predictedFailure: "inline colors instead of design tokens",
  failureSignature: "design-system-bypassed",
  scopeTags: ["styling"],
  writtenAt: RULE_WRITTEN_AT,
});

// Episode A: applicable (styling), hurt via exact kebab-case match on the
// failure signature.
const reqA = message("Make the CTA button blue.", "2026-09-02T00:00:00Z");
classify(reqA, "new_task", ["styling"]);
const corrA = message("You hardcoded a hex color instead of using the design token.", "2026-09-02T01:00:00Z");
classify(corrA, "correction", ["styling"], "design-system-bypassed");
const episodeA = episode("2026-09-02T00:00:00Z", [reqA, corrA]);

// Episode B: applicable (styling), hurt via Dice similarity (>=0.7) against
// the rule's predicted failure rather than an exact signature match.
const reqB = message("Update the card background.", "2026-09-03T00:00:00Z");
classify(reqB, "new_task", ["styling"]);
const corrB = message(
  "Still seeing inline colors used instead of design tokens on the card.",
  "2026-09-03T01:00:00Z",
);
classify(corrB, "correction", ["styling"], "inline colors used instead of design tokens");
const episodeB = episode("2026-09-03T00:00:00Z", [reqB, corrB]);

// Episode C: applicable (styling), helped -- no correction at all.
const reqC = message("Add a settings tab.", "2026-09-04T00:00:00Z");
classify(reqC, "new_task", ["styling"]);
const episodeC = episode("2026-09-04T00:00:00Z", [reqC]);

// Episode D: NOT applicable to the styling rule (tags don't overlap), even
// though it carries a correction that would otherwise match the signature.
const reqD = message("Fix the webhook retry backoff.", "2026-09-05T00:00:00Z");
classify(reqD, "new_task", ["backend"]);
const corrD = message("The retry still uses the design-system-bypassed color path.", "2026-09-05T01:00:00Z");
classify(corrD, "correction", ["backend"], "design-system-bypassed");
episode("2026-09-05T00:00:00Z", [reqD, corrD]);

test("recomputeRuleHealth: 3 applicable episodes, 2 hurt, 1 helped -> retire_suggested", () => {
  const result = recomputeRuleHealth(NOW);
  assert.equal(result.rules, 1, "only the one live, written rule should be scored so far");
  assert.equal(result.suggested, 1);

  const health = store.getRuleHealth(styledRuleId);
  assert.ok(health);
  assert.equal(health!.applicable_tasks, 3, "episode D's tags don't overlap ['styling']");
  assert.equal(health!.hurt, 2);
  assert.equal(health!.helped, 1);
  assert.equal(health!.status, "retire_suggested");
  assert.equal(health!.last_applicable_at, "2026-09-04T00:00:00Z", "latest APPLICABLE episode is C, not D");
  assert.equal(health!.unused_since, null);
});

// A fully isolated project/episode set (never touched by any rule fixture
// above or below) so this is a pure unit test of the read shape.
const PROJECT2 = "rule-health-project-2";
test("store.listEpisodesAfter: tags are the union of classified messages; corrections carry a summary, falling back to the first 200 chars of the message", () => {
  db.prepare(`INSERT INTO allowed_projects (lovable_project_id, label) VALUES (?, ?)`).run(
    PROJECT2,
    "test2",
  );
  store.upsertProject({ lovable_project_id: PROJECT2, name: "Test Project 2" });

  const since = "2026-01-01T00:00:00.000Z";
  const req = message("A task with two tags across its messages.", "2026-02-01T00:00:00Z");
  classify(req, "new_task", ["alpha"]);
  const explicit = message("A correction with an explicit summary.", "2026-02-01T01:00:00Z");
  classify(explicit, "correction", ["beta"], "explicit-summary-text");
  const longContent = "x".repeat(250);
  const noSummary = message(longContent, "2026-02-01T02:00:00Z");
  classify(noSummary, "correction", ["alpha"], "");
  const ep = episode("2026-02-01T00:00:00Z", [req, explicit, noSummary], PROJECT2);

  // Before the cutoff: must never appear.
  const earlierReq = message("earlier, out of range", "2025-12-01T00:00:00Z");
  classify(earlierReq, "new_task", ["alpha"]);
  episode("2025-12-01T00:00:00Z", [earlierReq], PROJECT2);

  const episodes = store.listEpisodesAfter(PROJECT2, since);
  assert.equal(episodes.length, 1, "the earlier episode must be excluded");
  const found = episodes[0]!;
  assert.equal(found.id, ep);
  assert.deepEqual([...found.tags].sort(), ["alpha", "beta"]);
  assert.equal(found.corrections.length, 2);
  const withExplicit = found.corrections.find((c) => c.history_item_id === explicit)!;
  assert.equal(withExplicit.summary, "explicit-summary-text");
  const withFallback = found.corrections.find((c) => c.history_item_id === noSummary)!;
  assert.equal(withFallback.summary, longContent.slice(0, 200));
  assert.equal(withFallback.summary.length, 200);
});

test("snoozeRuleHealth: status becomes snoozed, and a later recompute keeps it snoozed while still in effect", () => {
  const untilIso = "2026-10-11T00:00:00.000Z"; // 30 days after NOW
  const snoozed = store.snoozeRuleHealth(styledRuleId, untilIso);
  assert.equal(snoozed.status, "snoozed");
  assert.equal(snoozed.snoozed_until, untilIso);

  const recomputed = recomputeRuleHealth(NOW);
  assert.equal(recomputed.suggested, 0, "a snoozed rule must not count toward 'suggested'");
  const health = store.getRuleHealth(styledRuleId)!;
  assert.equal(health.status, "snoozed");
  assert.equal(health.snoozed_until, untilIso, "recompute must carry the snooze forward, not clear it");

  // Once the snooze has expired, the same underlying signal resumes.
  const afterExpiry = new Date("2026-11-15T00:00:00Z");
  recomputeRuleHealth(afterExpiry);
  assert.equal(store.getRuleHealth(styledRuleId)!.status, "retire_suggested");
});

test("recomputeRuleHealth: a rule scoped 'general' applies to every episode regardless of tags", () => {
  const generalRuleId = makeLiveRule({
    predictedFailure: "an unrelated, generic mistake that shares no wording with any correction below",
    failureSignature: "totally-unrelated-signature",
    scopeTags: null, // keep the v9 default: '["general"]'
    writtenAt: RULE_WRITTEN_AT,
  });

  const result = recomputeRuleHealth(NOW);
  assert.ok(result.rules >= 2);

  const health = store.getRuleHealth(generalRuleId)!;
  // Episodes A, B, C, D all started after RULE_WRITTEN_AT, so a 'general'
  // rule must count all four as applicable -- including D, which the
  // styling-scoped rule above excluded for having no overlapping tag.
  assert.equal(health.applicable_tasks, 4);
  assert.equal(
    health.hurt,
    0,
    "none of the fixture's correction summaries are close to this rule's own signature/prediction",
  );
  assert.equal(health.helped, 4);
  assert.equal(health.status, "healthy");
});

test("recomputeRuleHealth: unused after the configured number of days -> retire_suggested with unused_since", () => {
  const unusedAfterDays = Number(store.getSetting("rule_unused_after_days"));
  assert.ok(unusedAfterDays > 0);

  const writtenAt = "2026-06-01T00:00:00.000Z"; // well over rule_unused_after_days before NOW
  const unusedRuleId = makeLiveRule({
    predictedFailure: "a performance regression that never shows up in any fixture episode",
    failureSignature: "performance-regression",
    scopeTags: ["performance"], // no fixture episode is tagged 'performance'
    writtenAt,
  });

  recomputeRuleHealth(NOW);
  const health = store.getRuleHealth(unusedRuleId)!;
  assert.equal(health.applicable_tasks, 0);
  assert.equal(health.status, "retire_suggested");
  assert.equal(health.unused_since, writtenAt);
});

test("recomputeRuleHealth: hurt but below the retirement threshold -> watch", () => {
  const watchRuleId = makeLiveRule({
    predictedFailure: "a lone infra regression",
    failureSignature: "lone-infra-regression",
    scopeTags: ["infra"], // a tag no other fixture episode uses, for isolation
    writtenAt: RULE_WRITTEN_AT,
  });

  const req = message("Touch the infra queue again.", "2026-09-07T00:00:00Z");
  classify(req, "new_task", ["infra"]);
  const corr = message("Same infra regression as before.", "2026-09-07T01:00:00Z");
  classify(corr, "correction", ["infra"], "lone-infra-regression");
  episode("2026-09-07T00:00:00Z", [req, corr]);

  recomputeRuleHealth(NOW);
  const health = store.getRuleHealth(watchRuleId)!;
  assert.equal(health.applicable_tasks, 1);
  assert.equal(health.hurt, 1);
  assert.equal(health.status, "watch", "hurt but applicable_tasks < 3, so retirement isn't suggested yet");
});

test("listLiveRulesWithTargets / recomputeRuleHealth: a rule with no written Knowledge version is skipped", () => {
  const episodeForRule = episode(RULE_WRITTEN_AT, []);
  const cc = store.createCorrectionCandidate({
    task_episode_id: episodeForRule,
    classification: "constraint_restatement",
    is_correction: true,
    reusable: true,
    proposed_scope: "project",
    summary: "never written",
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
    instruction: "Never written to Lovable.",
    scope: "project",
    applies_when: "n/a",
    predicted_failure: "n/a",
    ownership: "harness",
    created_by: "test",
  }) as { id: number };
  // Approved/active, but never given a 'written' knowledge_versions row.
  store.updateRule({ id: rule.id, state: "active", actor: "test" });

  const live = store.listLiveRulesWithTargets();
  assert.equal(
    live.some((r) => r.id === rule.id),
    false,
  );

  const before = store.listRuleHealth().length;
  recomputeRuleHealth(NOW);
  const after = store.listRuleHealth().length;
  assert.equal(after, before, "no rule_health row should be created for a rule that was never written");
  assert.equal(store.getRuleHealth(rule.id), null);
});
