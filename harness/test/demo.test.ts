import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HARNESS_DB_PATH = join(mkdtempSync(join(tmpdir(), "harness-demo-test-")), "harness.db");

const { db } = await import("../src/db.js");
const store = await import("../src/store.js");
const demo = await import("../src/demo.js");
const improvements = await import("../src/improvements.js");

const REAL_PROJECT = "demo-test-real-project";

// A real, non-demo project + a real rule/episode of its own, created BEFORE
// any demo project is allowed -- proves --add/--remove never touch it.
store.allowProject(REAL_PROJECT, "Real project, not part of the demo");
const realItem = store.upsertHistoryItem({
  project_id: REAL_PROJECT,
  kind: "message",
  external_id: "real-msg-1",
  role: "user",
  content: "a completely real message",
  provenance: "lovable_mcp",
}) as { id: number };
const realEpisode = store.createTaskEpisode({
  project_id: REAL_PROJECT,
  title: "A real episode, not a demo one",
  provenance: "manual",
  evidence_history_item_ids: [realItem.id],
}) as { id: number };
const realCandidate = store.createCorrectionCandidate({
  task_episode_id: realEpisode.id,
  classification: "other",
  is_correction: true,
  summary: "real summary",
  evidence_history_item_ids: [realItem.id],
}) as { id: number };
const realLearning = store.createLearning({
  correction_candidate_id: realCandidate.id,
  observed_problem: "p",
  desired_behavior: "d",
  reuse_rationale: "r",
  proposed_scope: "project",
  provenance: "manual",
  created_by: "real-user",
}) as { id: number };
const realRule = store.createRule({
  learning_id: realLearning.id,
  correction_candidate_id: realCandidate.id,
  instruction: "A real rule instruction.",
  scope: "project",
  applies_when: "always",
  predicted_failure: "f",
  ownership: "harness",
  created_by: "real-user",
}) as { id: number };
store.recordSkillSnapshot({
  workspace_id: "real-workspace",
  name: "a-real-skill",
  description: "not a demo skill",
  content: "real content",
  updated_at_remote: null,
  fetched_by: "real-executor",
});

function tableCount(table: string): number {
  return (db.prepare(`SELECT COUNT(*) as n FROM ${table}`).get() as { n: number }).n;
}

// Every table any insertEvent()-calling function addDemoData reaches can
// touch: history_items, task_episodes, correction_candidates, learnings,
// rules (+ rule_revisions via updateRule), knowledge_versions,
// knowledge_snapshots, skill_snapshots, the two evidence link tables,
// agent_actions (via recordHumanCorrectionDecision), and events itself.
const TABLES = [
  "task_episodes",
  "task_episode_evidence",
  "correction_candidates",
  "correction_candidate_evidence",
  "learnings",
  "rules",
  "rule_revisions",
  "knowledge_versions",
  "knowledge_snapshots",
  "history_items",
  "skill_snapshots",
  "agent_actions",
  "events",
];

test("demoLoaded is false before --add", () => {
  assert.equal(demo.demoLoaded(), false);
  assert.equal(demo.demoStatus().loaded, false);
});

let before: Record<string, number>;

test("addDemoData: counts rise by exactly the expected amounts, uses the first allowed project (same project as the real rows)", () => {
  const expectedProjectId = (store.getAllowedProjects() as { lovable_project_id: string }[])[0]!
    .lovable_project_id;
  assert.equal(expectedProjectId, REAL_PROJECT, "REAL_PROJECT was allowed first");

  before = Object.fromEntries(TABLES.map((t) => [t, tableCount(t)]));

  const result = demo.addDemoData();
  assert.equal(result.added, true);
  assert.equal(result.project_id, expectedProjectId);
  assert.equal(demo.demoLoaded(), true);
  assert.equal(demo.demoStatus().loaded, true);

  const after = Object.fromEntries(TABLES.map((t) => [t, tableCount(t)]));
  assert.equal(after.task_episodes! - before.task_episodes!, 2);
  assert.equal(after.correction_candidates! - before.correction_candidates!, 2);
  assert.equal(after.learnings! - before.learnings!, 2);
  assert.equal(after.rules! - before.rules!, 2);
  assert.equal(after.knowledge_versions! - before.knowledge_versions!, 3);
  assert.equal(after.knowledge_snapshots! - before.knowledge_snapshots!, 1);
  assert.equal(after.skill_snapshots! - before.skill_snapshots!, 1);
  assert.equal(after.history_items! - before.history_items!, 4);
  // task_episode_evidence: 2 history items linked per episode, 2 episodes.
  assert.equal(after.task_episode_evidence! - before.task_episode_evidence!, 4);
  // correction_candidate_evidence: same shape as episode evidence.
  assert.equal(after.correction_candidate_evidence! - before.correction_candidate_evidence!, 4);
  // rule_revisions: one automatic (proposed->active, from v1's write) plus
  // two explicit rewords (before v2 and before v3), all on writtenRule only
  // -- pendingRule is never written, so it never revises.
  assert.equal(after.rule_revisions! - before.rule_revisions!, 3);
  // agent_actions: one human_review_decision for the "written" improvement.
  assert.equal(after.agent_actions! - before.agent_actions!, 1);
  // events: at least one insertEvent() per row created above; removeDemoData
  // must delete every one of them (asserted precisely in the remove test
  // below via the full pre-add/post-remove table comparison).
  assert.ok(after.events! - before.events! > 0, "adding demo data must record events");

  // All three knowledge versions are written, spaced an hour apart.
  const versions = db
    .prepare(
      `SELECT status, written_at FROM knowledge_versions WHERE rule_id IN (
         SELECT id FROM rules WHERE correction_candidate_id IN (
           SELECT id FROM correction_candidates WHERE task_episode_id IN (
             SELECT id FROM task_episodes WHERE title IN (?, ?)
           )
         )
       ) ORDER BY written_at ASC`,
    )
    .all("Demo: keep the sidebar order stable", "Demo: never add a cron job without asking") as {
    status: string;
    written_at: string;
  }[];
  assert.equal(versions.length, 3);
  for (const v of versions) assert.equal(v.status, "written");
  const t0 = new Date(versions[0]!.written_at.replace(" ", "T") + "Z").getTime();
  const t1 = new Date(versions[1]!.written_at.replace(" ", "T") + "Z").getTime();
  const t2 = new Date(versions[2]!.written_at.replace(" ", "T") + "Z").getTime();
  assert.ok(t1 - t0 >= 59 * 60 * 1000, "v1->v2 should be about an hour apart");
  assert.ok(t2 - t1 >= 59 * 60 * 1000, "v2->v3 should be about an hour apart");

  // The pending improvement stays undecided; the written one is accepted.
  const pending = improvements
    .listImprovements()
    .find((i) => i.title.startsWith("Demo: keep the sidebar order stable"));
  const written = improvements
    .listImprovements()
    .find((i) => i.title.startsWith("Demo: never add a cron job without asking"));
  assert.ok(pending, "pending demo improvement should exist");
  assert.ok(written, "written demo improvement should exist");

  // The pending (sidebar) improvement is untouched by any Knowledge write:
  // its rule is never passed into composeManagedKnowledge or
  // writeDemoVersion, so it stays exactly "awaiting a decision" on every
  // axis -- not just decision.status, but also lovable.write_status and its
  // version history, which is what an Inbox card and its detail panel both
  // actually render.
  assert.equal(pending!.decision.status, "pending");
  assert.equal(pending!.lovable.write_status, "none");
  assert.equal(pending!.lovable.versions.length, 0);
  const pendingRuleRow = pending!.developer.rule as { state: string } | null;
  assert.equal(pendingRuleRow?.state, "proposed", "never written, so never activated either");

  // The written (cron) improvement is the one that actually went through
  // Knowledge, across all three versions.
  assert.equal(written!.decision.status, "accepted");
  assert.equal(written!.lovable.write_status, "written");
  assert.equal(written!.lovable.versions.length, 3);
  assert.ok(written!.lovable.versions.every((v) => v.status === "written"));

  // The real project's own rows are untouched.
  assert.ok(db.prepare(`SELECT 1 FROM rules WHERE id = ?`).get(realRule.id));
  assert.ok(db.prepare(`SELECT 1 FROM task_episodes WHERE id = ?`).get(realEpisode.id));
  assert.ok(db.prepare(`SELECT 1 FROM correction_candidates WHERE id = ?`).get(realCandidate.id));
});

test("addDemoData again is a no-op: every table count stays exactly the same", () => {
  const beforeSecond = Object.fromEntries(TABLES.map((t) => [t, tableCount(t)]));
  const result = demo.addDemoData();
  assert.equal(result.added, false);
  const afterSecond = Object.fromEntries(TABLES.map((t) => [t, tableCount(t)]));
  assert.deepEqual(afterSecond, beforeSecond);
});

test("removeDemoData: every table returns to its pre-add count; real rows untouched", () => {
  const result = demo.removeDemoData();
  assert.equal(result.removed, true);

  const after = Object.fromEntries(TABLES.map((t) => [t, tableCount(t)]));
  assert.deepEqual(after, before, "every table must return to its exact pre-add count");

  assert.equal(demo.demoLoaded(), false);
  assert.equal(demo.demoStatus().loaded, false);

  // The real project's own rows survive removal untouched.
  assert.ok(db.prepare(`SELECT 1 FROM rules WHERE id = ?`).get(realRule.id));
  assert.ok(db.prepare(`SELECT 1 FROM learnings WHERE id = ?`).get(realLearning.id));
  assert.ok(db.prepare(`SELECT 1 FROM task_episodes WHERE id = ?`).get(realEpisode.id));
  assert.ok(db.prepare(`SELECT 1 FROM correction_candidates WHERE id = ?`).get(realCandidate.id));
  assert.ok(db.prepare(`SELECT 1 FROM history_items WHERE id = ?`).get(realItem.id));
  assert.ok(
    db.prepare(`SELECT 1 FROM skill_snapshots WHERE name = 'a-real-skill'`).get(),
    "the real, non-demo skill snapshot must survive",
  );
  // The real rule's own events (created alongside it, well before any demo
  // row existed) must survive too -- proves the events cleanup matched by
  // exact numeric payload.id, not a substring that could have swept these up.
  const realRuleEvents = db
    .prepare(`SELECT COUNT(*) as n FROM events WHERE kind = 'rule.created' AND payload LIKE ?`)
    .get(`%"id":${realRule.id}%`) as { n: number };
  assert.ok(realRuleEvents.n >= 1, "the real rule's own event must survive removal");
});

test("removeDemoData with nothing loaded is a harmless no-op", () => {
  const result = demo.removeDemoData();
  assert.equal(result.removed, false);
  assert.deepEqual(result.counts, {});
});
