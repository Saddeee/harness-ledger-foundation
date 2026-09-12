// Round 5 Task 6 / spec §4: harness/src/analysis/auto-accept.ts --
// decision_mode='automatic' accepting the confident, uncontested candidates
// a run of proposeRules just created, and leaving everything else for the
// user exactly as it already was. No LLM call anywhere in this file --
// candidates are seeded directly with the same shape propose.ts itself
// writes (classification_meta role='rule_writer', duplicate_of_rule_id/
// contradicts_rule_id inside structured_output), mirroring
// improvements.test.ts's own mkMinedCandidate fixture.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "harness-analysis-auto-accept-test-"));
process.env.HARNESS_DB_PATH = join(tmp, "harness.db");
// Keep the auth file out of the real data directory: nothing here connects.
process.env.HARNESS_AUTH_PATH = join(tmp, "lovable-auth.json");

const { db } = await import("../src/db.js");
const store = await import("../src/store.js");
const imp = await import("../src/improvements.js");
const autoAccept = await import("../src/analysis/auto-accept.js");

const RUN_ID = 1;

let nextPrefix = 0;

/** Mirrors improvements.test.ts's own mkMinedCandidate: a candidate + rule
 * shaped exactly like a real propose.ts proposal, with the rule writer's
 * confidence and (optionally) its duplicate/contradiction flags recorded in
 * agent_actions.structured_output the same way createCorrectionCandidate's
 * classification_meta writes them. */
function mkMinedCandidate(opts: {
  project: string;
  instruction: string;
  confidence: number;
  scope?: "project" | "workspace";
  duplicateOfRuleId?: number | null;
  contradictsRuleId?: number | null;
}): { ccId: number; ruleId: number } {
  const prefix = `auto-accept-${nextPrefix++}`;
  const scope = opts.scope ?? "project";
  const msg = store.upsertHistoryItem({
    project_id: opts.project,
    kind: "message",
    external_id: `${prefix}-1`,
    role: "user",
    content: "please fix this",
    occurred_at: "2026-09-01T00:00:00Z",
    provenance: "lovable_mcp",
  }) as { id: number };
  const ep = store.createTaskEpisode({
    project_id: opts.project,
    title: prefix,
    provenance: "llm_derived",
    evidence_history_item_ids: [msg.id],
  }) as { id: number };
  const cc = store.createCorrectionCandidate({
    task_episode_id: ep.id,
    classification: "constraint_restatement",
    is_correction: true,
    reusable: true,
    proposed_scope: scope,
    summary: opts.instruction,
    confidence: opts.confidence,
    evidence_reason: "mined from 1 corrections",
    evidence_history_item_ids: [msg.id],
    classification_meta: {
      provider: "openai",
      model: "gpt-5.5",
      role: "rule_writer",
      structured_output: {
        propose: true,
        instruction: opts.instruction,
        scope,
        prediction: "x",
        failure_signature: "x",
        evidence_message_ids: [`${prefix}-1`],
        confidence: opts.confidence,
        duplicate_of_rule_id: opts.duplicateOfRuleId ?? null,
        contradicts_rule_id: opts.contradictsRuleId ?? null,
      },
    },
  }) as { id: number };
  const learning = store.createLearning({
    correction_candidate_id: cc.id,
    observed_problem: "p",
    desired_behavior: opts.instruction,
    reuse_rationale: "r",
    proposed_scope: scope,
    confidence: opts.confidence,
    provenance: "llm_derived",
    created_by: "openai/gpt-5.5 (rule writer)",
  }) as { id: number };
  const rule = store.createRule({
    learning_id: learning.id,
    correction_candidate_id: cc.id,
    instruction: opts.instruction,
    scope,
    applies_when: "always",
    predicted_failure: "x",
    ownership: "harness",
    created_by: "openai/gpt-5.5 (rule writer)",
  }) as { id: number };
  return { ccId: cc.id, ruleId: rule.id };
}

/** A rule already live (state 'approved', so activeRulesForTarget counts
 * it), created directly rather than through improvementAction -- used to
 * fill a project's rule limit or to stand in as "an existing rule" for a
 * duplicate/contradiction fixture. */
function mkActiveRule(project: string, instruction: string): { ruleId: number } {
  const { ruleId } = mkMinedCandidate({ project, instruction, confidence: 0.9 });
  store.updateRule({ id: ruleId, state: "approved", actor: "test seed" });
  return { ruleId };
}

function decidedBy(ccId: number): "user" | "automatic" | null {
  const found = store.getCorrectionCandidate(ccId) as {
    correction_candidate: { decided_by: "user" | "automatic" | null };
  } | null;
  return found?.correction_candidate.decided_by ?? null;
}

function ruleState(ruleId: number): string {
  return (store.getRule(ruleId) as { rule: { state: string } }).rule.state;
}

// ------------------------------------------------------------------ tests

test("autoAcceptProposals: decision_mode='ask' (default) accepts nothing, leaves every candidate for the user", () => {
  const PROJECT = "auto-accept-ask-mode";
  store.allowProject(PROJECT, "Ask Mode Co");
  store.setSettings({ decision_mode: "ask" });

  const { ccId, ruleId } = mkMinedCandidate({
    project: PROJECT,
    instruction: "Always confirm before deleting a project.",
    confidence: 0.95,
  });

  const result = autoAccept.autoAcceptProposals([ccId], RUN_ID);
  assert.deepEqual(result, { accepted: 0, left_for_user: 1 });
  assert.equal(decidedBy(ccId), null);
  assert.equal(ruleState(ruleId), "proposed");
});

test("autoAcceptProposals: confident, uncontested -> accepted, decided_by='automatic', and a staged Knowledge write when a snapshot exists", () => {
  const PROJECT = "auto-accept-confident";
  store.allowProject(PROJECT, "Confident Co");
  store.setSettings({ decision_mode: "automatic", decision_auto_confidence: "0.8" });
  store.recordKnowledgeSnapshot({
    target: "project",
    project_id: PROJECT,
    content: "# Notes\n\nAlways use the design tokens.\n",
    fetched_by: "test",
  });

  const { ccId, ruleId } = mkMinedCandidate({
    project: PROJECT,
    instruction: "Always confirm before deleting a project.",
    confidence: 0.9,
  });

  const result = autoAccept.autoAcceptProposals([ccId], RUN_ID);
  assert.deepEqual(result, { accepted: 1, left_for_user: 0 });
  assert.equal(decidedBy(ccId), "automatic");
  assert.equal(ruleState(ruleId), "approved");

  const item = imp.getImprovement(ccId)!;
  assert.equal(item.decision.status, "accepted");
  assert.equal(item.lovable.write_status, "pending", "a snapshot existed, so the write is staged");

  const events = store.listEvents(200) as { kind: string; payload: string | null }[];
  const autoEvent = events.find(
    (e) => e.kind === "suggestion.auto_accepted" && JSON.parse(e.payload ?? "{}").id === ccId,
  );
  assert.ok(autoEvent, "expected a suggestion.auto_accepted event");
  const payload = JSON.parse(autoEvent!.payload!) as { run_id: number; confidence: number };
  assert.equal(payload.run_id, RUN_ID);
  assert.equal(payload.confidence, 0.9);
});

test("autoAcceptProposals: below the confidence threshold -> left pending, undecided", () => {
  const PROJECT = "auto-accept-low-confidence";
  store.allowProject(PROJECT, "Low Confidence Co");
  store.setSettings({ decision_mode: "automatic", decision_auto_confidence: "0.8" });

  const { ccId, ruleId } = mkMinedCandidate({
    project: PROJECT,
    instruction: "Always show a toast after saving.",
    confidence: 0.5,
  });

  const result = autoAccept.autoAcceptProposals([ccId], RUN_ID);
  assert.deepEqual(result, { accepted: 0, left_for_user: 1 });
  assert.equal(decidedBy(ccId), null);
  assert.equal(ruleState(ruleId), "proposed");
});

test("autoAcceptProposals: the rule writer flagged a duplicate -> left pending even though confidence clears the bar", () => {
  const PROJECT = "auto-accept-duplicate";
  store.allowProject(PROJECT, "Duplicate Co");
  store.setSettings({ decision_mode: "automatic", decision_auto_confidence: "0.8" });

  const existing = mkActiveRule(PROJECT, "Always require a confirm-password field.");
  const { ccId, ruleId } = mkMinedCandidate({
    project: PROJECT,
    instruction: "Always require a confirm-password field on signup forms.",
    confidence: 0.95,
    duplicateOfRuleId: existing.ruleId,
  });

  const result = autoAccept.autoAcceptProposals([ccId], RUN_ID);
  assert.deepEqual(result, { accepted: 0, left_for_user: 1 });
  assert.equal(decidedBy(ccId), null);
  assert.equal(ruleState(ruleId), "proposed");
});

test("autoAcceptProposals: the rule writer flagged a contradiction -> left pending", () => {
  const PROJECT = "auto-accept-contradiction";
  store.allowProject(PROJECT, "Contradiction Co");
  store.setSettings({ decision_mode: "automatic", decision_auto_confidence: "0.8" });

  const existing = mkActiveRule(PROJECT, "Always skip the confirmation dialog for quick actions.");
  const { ccId, ruleId } = mkMinedCandidate({
    project: PROJECT,
    instruction: "Always show a confirmation dialog before deleting anything.",
    confidence: 0.95,
    contradictsRuleId: existing.ruleId,
  });

  const result = autoAccept.autoAcceptProposals([ccId], RUN_ID);
  assert.deepEqual(result, { accepted: 0, left_for_user: 1 });
  assert.equal(decidedBy(ccId), null);
  assert.equal(ruleState(ruleId), "proposed");
});

test("autoAcceptProposals: the project is already at its rule limit -> left pending, nothing staged", () => {
  const PROJECT = "auto-accept-rule-limit";
  store.allowProject(PROJECT, "Rule Limit Co");
  store.setSettings({ decision_mode: "automatic", decision_auto_confidence: "0.8" });
  store.setProjectSettings(PROJECT, { max_active_rules: 1 });
  mkActiveRule(PROJECT, "Always use the shared design tokens.");
  // The preview's over_rules is only ever computed against a real snapshot
  // (buildPreview returns null -- and so skips the check -- without one).
  store.recordKnowledgeSnapshot({
    target: "project",
    project_id: PROJECT,
    content: "# Notes\n",
    fetched_by: "test",
  });

  const { ccId, ruleId } = mkMinedCandidate({
    project: PROJECT,
    instruction: "Always confirm before deleting a project.",
    confidence: 0.95,
  });

  const result = autoAccept.autoAcceptProposals([ccId], RUN_ID);
  assert.deepEqual(result, { accepted: 0, left_for_user: 1 });
  assert.equal(decidedBy(ccId), null);
  assert.equal(ruleState(ruleId), "proposed");
  assert.equal(
    store.listPendingKnowledgeWrites().filter((w) => (w as { rule_id: number }).rule_id === ruleId)
      .length,
    0,
  );
});

test("autoAcceptProposals: an empty candidate list is a no-op", () => {
  const result = autoAccept.autoAcceptProposals([], RUN_ID);
  assert.deepEqual(result, { accepted: 0, left_for_user: 0 });
});

test("autoAcceptProposals: mixed confident/unsure candidates in one call -- only the confident one is accepted, counts add up", () => {
  const PROJECT = "auto-accept-mixed";
  store.allowProject(PROJECT, "Mixed Co");
  store.setSettings({ decision_mode: "automatic", decision_auto_confidence: "0.8" });

  const confident = mkMinedCandidate({
    project: PROJECT,
    instruction: "Always paginate long lists.",
    confidence: 0.9,
  });
  const unsure = mkMinedCandidate({
    project: PROJECT,
    instruction: "Always show a skeleton loader while fetching.",
    confidence: 0.4,
  });

  const result = autoAccept.autoAcceptProposals([confident.ccId, unsure.ccId], RUN_ID);
  assert.deepEqual(result, { accepted: 1, left_for_user: 1 });
  assert.equal(decidedBy(confident.ccId), "automatic");
  assert.equal(decidedBy(unsure.ccId), null);
});

// ---- store.countAutoAcceptedSince (feeds the Inbox's own automatic-mode
// empty state, spec §4) ----

// Every countAutoAcceptedSince assertion below is a DELTA against a baseline
// captured for the same cutoff right before this test's own mutation, not
// an absolute count -- this file's DB is shared across every test in it
// (same convention as analysis-propose.test.ts's own drainEpisode comment),
// so earlier tests' own real-"now" automatic accepts already sit in the
// table and must not make a later test's assertion flaky.

test("countAutoAcceptedSince: counts only decided_by='automatic' candidates with reviewed_at after the given ISO timestamp", () => {
  const PROJECT = "auto-accept-since-seen";
  store.allowProject(PROJECT, "Since Seen Co");
  store.setSettings({ decision_mode: "automatic", decision_auto_confidence: "0.8" });

  const sinceIso = "2026-01-01T00:00:00.000Z";
  const baseline = store.countAutoAcceptedSince(sinceIso);

  const before = mkMinedCandidate({
    project: PROJECT,
    instruction: "Always paginate the admin table.",
    confidence: 0.9,
  });
  autoAccept.autoAcceptProposals([before.ccId], RUN_ID);
  // Backdate it well before the "since" cutoff above -- accepted on an
  // earlier visit, so this visit's own count must not include it.
  db.prepare(
    `UPDATE correction_candidates SET reviewed_at = '2020-01-01 00:00:00' WHERE id = ?`,
  ).run(before.ccId);
  assert.equal(
    store.countAutoAcceptedSince(sinceIso),
    baseline,
    "a backdated (before-cutoff) accept adds nothing to the count",
  );

  const after = mkMinedCandidate({
    project: PROJECT,
    instruction: "Always debounce the search input.",
    confidence: 0.9,
  });
  autoAccept.autoAcceptProposals([after.ccId], RUN_ID);
  // reviewed_at is set to "now" by the accept itself, already after
  // sinceIso -- no backdating needed for this one.

  assert.equal(
    store.countAutoAcceptedSince(sinceIso),
    baseline + 1,
    "only the candidate accepted after sinceIso adds to the count",
  );
});

test("countAutoAcceptedSince: an ISO 'since' (T/Z) compares correctly against SQLite's space-separated reviewed_at on the same calendar day", () => {
  // Without normalising sinceIso through SQLite's own datetime() first, a
  // literal string comparison would read every same-day reviewed_at as
  // "before" sinceIso regardless of the actual time (' ' < 'T' always) --
  // this pins that fix, not just the happy path above.
  const PROJECT = "auto-accept-since-format";
  store.allowProject(PROJECT, "Since Format Co");
  store.setSettings({ decision_mode: "automatic", decision_auto_confidence: "0.8" });

  const earlierSinceIso = "2026-09-12T10:10:00.000Z";
  const laterSinceIso = "2026-09-12T10:30:00.000Z";
  const baselineEarlier = store.countAutoAcceptedSince(earlierSinceIso);
  const baselineLater = store.countAutoAcceptedSince(laterSinceIso);

  const candidate = mkMinedCandidate({
    project: PROJECT,
    instruction: "Always confirm before bulk-archiving.",
    confidence: 0.9,
  });
  autoAccept.autoAcceptProposals([candidate.ccId], RUN_ID);
  db.prepare(
    `UPDATE correction_candidates SET reviewed_at = '2026-09-12 10:20:00' WHERE id = ?`,
  ).run(candidate.ccId);

  assert.equal(
    store.countAutoAcceptedSince(earlierSinceIso),
    baselineEarlier + 1,
    "an earlier same-day sinceIso still counts a later same-day reviewed_at",
  );
  assert.equal(
    store.countAutoAcceptedSince(laterSinceIso),
    baselineLater,
    "a later same-day sinceIso excludes an earlier same-day reviewed_at",
  );
});

test("countAutoAcceptedSince: a candidate the user decided (not automatic) never counts", () => {
  const PROJECT = "auto-accept-since-user";
  store.allowProject(PROJECT, "Since User Co");
  store.setSettings({ decision_mode: "ask" });

  const sinceIso = "2000-01-01T00:00:00.000Z";
  const baseline = store.countAutoAcceptedSince(sinceIso);

  const { ccId } = mkMinedCandidate({
    project: PROJECT,
    instruction: "Always show empty states with a call to action.",
    confidence: 0.95,
  });
  imp.improvementAction({ action: "accept", id: ccId, destination: "project" });
  assert.equal(decidedBy(ccId), "user");

  assert.equal(
    store.countAutoAcceptedSince(sinceIso),
    baseline,
    "a user-decided accept must never be counted as automatic",
  );
});
