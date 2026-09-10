import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HARNESS_DB_PATH = join(mkdtempSync(join(tmpdir(), "harness-improvements-test-")), "harness.db");

const { db } = await import("../src/db.js");
const store = await import("../src/store.js");
const imp = await import("../src/improvements.js");

const PROJECT = "improvements-test-project";
db.prepare(`INSERT INTO allowed_projects (lovable_project_id, label) VALUES (?, ?)`).run(PROJECT, "test");
store.upsertProject({ lovable_project_id: PROJECT, name: "Test Project" });

const VERBATIM_USER = "Build a queue worker.\n\nSchedule with pg_cron: every minute.";
const VERBATIM_LOVABLE = "<lov-tool-use>...</lov-tool-use>\nThe foundation is live; a background worker now runs every minute.";

function mk(kind: string, role: string | null, content: string, provenance: string, occurred_at: string, external_id: string) {
  return store.upsertHistoryItem({
    project_id: PROJECT,
    kind: kind as never,
    external_id,
    ...(role ? { role: role as never } : {}),
    content,
    occurred_at,
    provenance: provenance as never,
  }) as { id: number };
}

const asked = mk("message", "user", VERBATIM_USER, "lovable_mcp", "2026-09-07T23:29:36Z", "m-user-1");
const built = mk("message", "assistant", VERBATIM_LOVABLE, "lovable_mcp", "2026-09-07T23:35:46Z", "m-agent-1");
const note = mk("manual_note", "operator", "my message to Claude Code", "manual", "2026-09-07T23:47:00Z", "note-1");
const buildLog = mk("build_log_row", null, "build-log row", "build_log", "2026-09-07T23:47:00Z", "bl-1");
const fixed = mk("message", "user", "that cron must NOT be recreated", "lovable_mcp", "2026-09-08T10:31:23Z", "m-user-2");

const episode = store.createTaskEpisode({
  project_id: PROJECT,
  title: "cron episode",
  provenance: "llm_derived",
  evidence_history_item_ids: [asked.id, built.id, note.id, buildLog.id, fixed.id],
}) as { id: number };
const cc = store.createCorrectionCandidate({
  task_episode_id: episode.id,
  classification: "constraint_restatement",
  is_correction: true,
  reusable: true,
  proposed_scope: "workspace",
  summary: "Recurring work was enabled without approval. More words.",
  evidence_history_item_ids: [asked.id, built.id, note.id, buildLog.id, fixed.id],
}) as { id: number };
const learning = store.createLearning({
  correction_candidate_id: cc.id,
  observed_problem: "p",
  desired_behavior: "Do not enable recurring work by default.",
  reuse_rationale: "r",
  proposed_scope: "workspace",
  provenance: "llm_derived",
  created_by: "test",
}) as { id: number };
const rule = store.createRule({
  learning_id: learning.id,
  correction_candidate_id: cc.id,
  instruction: "Do not enable recurring background work by default. Prefer user-triggered execution.",
  scope: "workspace",
  applies_when: "always",
  predicted_failure: "unapproved recurring work",
  ownership: "harness",
  created_by: "test",
}) as { id: number };

test("evidence is Lovable-chat-only, verbatim, chronological; the rest is developer.hidden_evidence", () => {
  const item = imp.getImprovement(cc.id)!;
  assert.deepEqual(item.evidence.map((e) => e.id), [asked.id, built.id, fixed.id]);
  assert.deepEqual(item.evidence.map((e) => e.author), ["you", "lovable", "you"]);
  assert.equal(item.evidence[0]!.text, VERBATIM_USER);
  assert.equal(item.evidence[1]!.text, VERBATIM_LOVABLE); // tool-use XML included, untouched
  const hiddenIds = (item.developer.hidden_evidence as { id: number }[]).map((h) => h.id).sort();
  assert.deepEqual(hiddenIds, [note.id, buildLog.id].sort());
  for (const e of item.evidence) assert.ok(!/manual|build_log|main:user#/.test(JSON.stringify({ a: e.author, s: e.sent_at })));
});

test("shape + initial state: pending, review current, proof future, project name resolved", () => {
  const item = imp.getImprovement(cc.id)!;
  assert.equal(item.project.name, "Test Project");
  assert.equal(item.title, "Do not enable recurring background work by default.");
  assert.equal(item.destination, "workspace");
  assert.equal(item.decision.status, "pending");
  assert.equal(item.decision.decided_at, null);
  assert.equal(item.stage, "review");
  assert.deepEqual(item.stages.map((s) => [s.key, s.state]), [
    ["found", "complete"], ["review", "current"], ["proof", "future"], ["in_lovable", "future"],
  ]);
  assert.equal(item.stages[0]!.note, "Found in your Lovable chat, 7 Sep");
  assert.equal(item.stages[1]!.note, "Waiting for your decision");
  assert.equal(item.stages[2]!.note, "Not proven yet");
  assert.equal(item.proof, null);
});

test("accept: reviewed=1, rule approved, both scopes set to the destination; stage moves to proof", () => {
  const item = imp.improvementAction({ action: "accept", id: cc.id, destination: "project" });
  assert.equal(item.decision.status, "accepted");
  assert.ok(item.decision.decided_at);
  assert.equal(item.destination, "project");
  assert.equal(item.stage, "proof");
  assert.match(item.stages[1]!.note!, /^You decided on \d+ \w{3}$/);
  const c = db.prepare(`SELECT reviewed, proposed_scope FROM correction_candidates WHERE id = ?`).get(cc.id) as { reviewed: number; proposed_scope: string };
  const r = db.prepare(`SELECT state, scope FROM rules WHERE id = ?`).get(rule.id) as { state: string; scope: string };
  assert.equal(c.reviewed, 1);
  assert.equal(c.proposed_scope, "project");
  assert.equal(r.state, "approved");
  assert.equal(r.scope, "project");
  assert.equal(item.decision.divergence, null);
  // scope change is audited but is not a wording revision
  assert.equal((db.prepare(`SELECT count(*) n FROM rule_revisions WHERE rule_id = ?`).get(rule.id) as { n: number }).n, 1);
  assert.ok(db.prepare(`SELECT 1 FROM events WHERE kind = 'rule.scope_changed'`).get());
});

test("proof block derives from plans; runnable is always false; proof note says not runnable", () => {
  const vd = store.createVerificationDefinition({
    scope: "workspace", name: "v", description: "d", verifier_type: "structural", configuration: "{}", source: "manual", ownership: "harness",
  }) as { id: number };
  store.createVerificationPlan({ rule_id: rule.id, failure_signature: "sig", failure_condition: "cond", created_by: "t", verification_definition_ids: [vd.id] });
  store.createExperimentPlan({
    rule_id: rule.id, source_project_id: PROJECT, experiment_type: "paired_control_treatment", starting_state_quality: "controlled_equivalent",
    control_configuration: "c", treatment_configuration: "t", exact_prompt: "p", protected_checks: "[]", estimated_credits: 3, max_permitted_credits: 6,
    resource_strategy: "temp remix", cleanup_requirements: "manual cleanup by the operator", risks: "r", success_conditions: "s",
    inconclusive_conditions: "i", stop_conditions: "s", created_by: "t", verification_definition_ids: [vd.id],
  });
  const item = imp.getImprovement(cc.id)!;
  assert.deepEqual(item.proof, { exists: true, runnable: false, lovable_credits_max: 6, outcome: "not_run", manual_cleanup: true });
  assert.equal(item.stages[2]!.state, "current");
  assert.equal(item.stages[2]!.note, "Not proven yet");
  assert.equal(item.stages[3]!.note, "Not in Lovable yet");
});

test("change_wording creates a rule_revision and appears in wording_history", () => {
  const item = imp.improvementAction({ action: "change_wording", id: cc.id, instruction: "Never enable recurring work by default.", reason: "shorter" });
  assert.equal(item.proposed_instruction, "Never enable recurring work by default.");
  assert.equal(item.wording_history.length, 1);
  assert.equal(item.wording_history[0]!.from, "Do not enable recurring background work by default. Prefer user-triggered execution.");
  assert.equal(item.wording_history[0]!.to, "Never enable recurring work by default.");
  assert.equal(item.wording_history[0]!.reason, "shorter");
});

test("set_destination one_time marks the correction one-time but leaves rule.scope unchanged (and surfaces no false divergence)", () => {
  const item = imp.improvementAction({ action: "set_destination", id: cc.id, destination: "one_time" });
  const c = db.prepare(`SELECT proposed_scope, reusable FROM correction_candidates WHERE id = ?`).get(cc.id) as { proposed_scope: string; reusable: number };
  const r = db.prepare(`SELECT scope FROM rules WHERE id = ?`).get(rule.id) as { scope: string };
  assert.equal(c.proposed_scope, "one_time");
  assert.equal(c.reusable, 0);
  assert.equal(r.scope, "project");
  assert.equal(item.destination, "project"); // rule.scope wins when a rule exists
  assert.equal(item.decision.divergence, null);
  imp.improvementAction({ action: "set_destination", id: cc.id, destination: "workspace" });
  assert.equal((db.prepare(`SELECT scope FROM rules WHERE id = ?`).get(rule.id) as { scope: string }).scope, "workspace");
});

test("skip: excluded + rule rejected -> skipped, review blocked, later stages blocked", () => {
  const item = imp.improvementAction({ action: "skip", id: cc.id });
  assert.equal(item.decision.status, "skipped");
  assert.deepEqual(item.stages.map((s) => s.state), ["complete", "blocked", "blocked", "blocked"]);
  assert.equal(item.stages[1]!.note, "Skipped");
  assert.equal((db.prepare(`SELECT state FROM rules WHERE id = ?`).get(rule.id) as { state: string }).state, "rejected");
  assert.equal((db.prepare(`SELECT excluded_from_learning FROM correction_candidates WHERE id = ?`).get(cc.id) as { excluded_from_learning: number }).excluded_from_learning, 1);
});

test("reopen restores pending / proposed", () => {
  const item = imp.improvementAction({ action: "reopen", id: cc.id });
  assert.equal(item.decision.status, "pending");
  assert.equal(item.stage, "review");
  assert.equal((db.prepare(`SELECT state FROM rules WHERE id = ?`).get(rule.id) as { state: string }).state, "proposed");
  assert.equal((db.prepare(`SELECT excluded_from_learning FROM correction_candidates WHERE id = ?`).get(cc.id) as { excluded_from_learning: number }).excluded_from_learning, 0);
});

test("divergence sentence when the correction is excluded but the rule is approved", () => {
  store.updateRule({ id: rule.id, state: "approved", actor: "test" });
  store.reviewCorrectionCandidate({ id: cc.id, action: "exclude" });
  const item = imp.getImprovement(cc.id)!;
  assert.equal(item.decision.status, "skipped");
  assert.equal(item.decision.divergence, "You skipped this lesson, but a rule based on it is still approved.");
  // restore
  imp.improvementAction({ action: "reopen", id: cc.id });
});

test("validation: unknown action and out-of-enum destination are rejected", () => {
  assert.throws(() => imp.improvementAction({ action: "execute", id: cc.id }));
  assert.throws(() => imp.improvementAction({ action: "accept", id: cc.id, destination: "one_time" }));
  assert.throws(() => imp.improvementAction({ action: "accept", id: 999999, destination: "project" }));
});

test("no Lovable import and no network call in improvements.ts / adapter.ts / store.ts", () => {
  for (const file of ["../src/improvements.ts", "../src/adapter.ts", "../src/store.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    const code = source.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    assert.ok(!/^\s*import.*lovable/im.test(code), `${file} must not import anything Lovable-related`);
    assert.ok(!/fetch\(|http\.request|https\.request/.test(code), `${file} must not make network calls`);
  }
});
