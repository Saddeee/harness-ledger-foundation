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
const { IMPROVEMENT_GROUPS, improvementGroup } = await import("../../src/lib/harness-ux.ts");

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
// touch, extended for Round 5 Task 8's richer seed: rule_verdicts,
// rule_adherence, rule_health, retire_proposals, message_classifications,
// experiment_plans (from the "waiting to be tested" accept path) on top of
// the original checkpoint C/D tables.
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
  "message_classifications",
  "rule_verdicts",
  "rule_adherence",
  "rule_health",
  "retire_proposals",
  "experiment_plans",
  "events",
];

test("demoLoaded is false before --add", () => {
  assert.equal(demo.demoLoaded(), false);
  assert.equal(demo.demoStatus().loaded, false);
});

let before: Record<string, number>;

test("addDemoData: counts rise, uses the first allowed project, every state from spec §7 is present", () => {
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
  for (const table of TABLES) {
    assert.ok((after[table] ?? 0) > (before[table] ?? 0), `${table} should have grown`);
  }
  // events: at least one insertEvent() per row created above; removeDemoData
  // must delete every one of them (asserted precisely in the remove test
  // below via the full pre-add/post-remove table comparison).
  assert.ok(after.events! - before.events! > 0, "adding demo data must record events");

  // The original two episodes are still exactly what demoLoaded() checks.
  const legacyVersions = db
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
  assert.equal(legacyVersions.length, 3);
  for (const v of legacyVersions) assert.equal(v.status, "written");

  // The real project's own rows are untouched.
  assert.ok(db.prepare(`SELECT 1 FROM rules WHERE id = ?`).get(realRule.id));
  assert.ok(db.prepare(`SELECT 1 FROM task_episodes WHERE id = ?`).get(realEpisode.id));
  assert.ok(db.prepare(`SELECT 1 FROM correction_candidates WHERE id = ?`).get(realCandidate.id));
});

test("listImprovements(): every demo-created item, every IMPROVEMENT_GROUPS value covered, 'wasn't sure' shown in automatic mode", () => {
  const all = improvements.listImprovements();
  // Retire items are titled "Retire: <rule instruction>" -- still a demo
  // item (the rule instruction itself starts with "Demo:"), just not at
  // the start of the string, so this checks both shapes.
  const demoItems = all.filter(
    (i: { title: string }) =>
      typeof i.title === "string" &&
      (i.title.startsWith("Demo:") || i.title.startsWith("Retire: Demo:")),
  );

  // Pending: the original sidebar item + the two new ones (P2, P3). A
  // retire item's own decision.status is always "pending" too (it hasn't
  // been kept/retired yet), so it's excluded here and counted separately
  // below.
  const pending = demoItems.filter(
    (i: { kind: string; decision: { status: string } }) =>
      i.kind !== "retire" && i.decision.status === "pending",
  );
  assert.equal(pending.length, 3, "3 pending demo items (sidebar, P2, P3)");

  // Exactly one open retirement proposal (kind 'retire'), on the workspace
  // rule engineered to rule_health 'retire_suggested'.
  const retireItems = demoItems.filter((i: { kind: string }) => i.kind === "retire");
  assert.equal(retireItems.length, 1, "exactly one open retirement proposal");
  assert.equal(retireItems[0]!.retire!.reason, "hurt");

  // Every decided (non-pending, non-retire) demo item maps to a real
  // IMPROVEMENT_GROUPS value, and the union of those groups covers all 7.
  const decided = demoItems.filter(
    (i: { kind: string; decision: { status: string } }) =>
      i.kind !== "retire" && i.decision.status !== "pending",
  );
  assert.ok(decided.length >= 8, "at least 8 decided demo items");
  const groups = new Set(
    decided.map(
      (i: {
        decision: { status: string; test_first: boolean; retired: boolean };
        lovable: { write_status: string };
      }) =>
        improvementGroup({
          status: i.decision.status as "pending" | "accepted" | "skipped",
          writeStatus: i.lovable.write_status as never,
          testFirst: i.decision.test_first,
          retired: i.decision.retired,
        }),
    ),
  );
  for (const g of IMPROVEMENT_GROUPS) {
    assert.ok(groups.has(g), `no demo item produced the "${g}" group`);
  }

  // The low-confidence pending item (P3) reads "Harness wasn't sure" once
  // decision_mode is automatic -- computed purely from what's on record,
  // never an LLM call. Flipped via a raw settings UPDATE, not
  // store.setSettings (which logs its own "settings.updated" event) --
  // this is test-only verification scaffolding, not something addDemoData
  // itself does, and it must not perturb the events-table round trip the
  // removal test below checks.
  const setDecisionMode = (mode: string) =>
    db
      .prepare(
        `INSERT INTO settings (key, value) VALUES ('decision_mode', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(mode);
  setDecisionMode("automatic");
  const withUnsure = improvements
    .listImprovements()
    .find((i: { title: string }) =>
      i.title.startsWith("Demo: use the shared date-formatting helper"),
    );
  assert.ok(withUnsure, "the low-confidence pending item should exist");
  assert.ok(
    withUnsure!.unsure && withUnsure!.unsure.includes("wasn't sure"),
    `expected an unsure explanation, got: ${JSON.stringify(withUnsure!.unsure)}`,
  );
  setDecisionMode("ask");
});

test("buildTimeline: project target has >= 12 nodes including one external_change and one restore; workspace target has skill nodes", () => {
  const expectedProjectId = (store.getAllowedProjects() as { lovable_project_id: string }[])[0]!
    .lovable_project_id;
  const workspaceId = store.getProjectMeta(expectedProjectId)?.workspace_id ?? "demo-workspace";

  const projectTimeline = improvements.buildTimeline("project", expectedProjectId);
  assert.ok(
    projectTimeline.length >= 12,
    `expected >= 12 project timeline nodes, got ${projectTimeline.length}`,
  );
  assert.ok(
    projectTimeline.some((n: { kind: string }) => n.kind === "external_change"),
    "expected an external_change node",
  );
  assert.ok(
    projectTimeline.some(
      (n: { kind: string; restored_from: number | null }) =>
        n.kind === "version" && n.restored_from != null,
    ),
    "expected a restore (version node with restored_from set)",
  );

  const workspaceTimeline = improvements.buildTimeline("workspace", workspaceId);
  assert.ok(
    workspaceTimeline.some((n: { kind: string }) => n.kind === "skill"),
    "expected skill nodes on the workspace timeline",
  );
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
  for (const table of TABLES) {
    assert.equal(after[table], before[table], `${table} must return to its exact pre-add count`);
  }

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
  // exact numeric payload field, not a substring that could have swept
  // these up.
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
