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

// Controller fix round 1 (important): a real user's own episode that merely
// happens to START with "Demo:" -- e.g. asking Lovable to build a demo
// mode. Its evidence carries a real source_ref (not 'demo-seed'), so
// removeDemoData's provenance-checked cascade must never touch it, unlike
// a bare `title LIKE 'Demo:%'` match, which would.
const fakeDemoItem = store.upsertHistoryItem({
  project_id: REAL_PROJECT,
  kind: "message",
  external_id: "real-demo-titled-msg-1",
  role: "user",
  content: "Please add a demo mode toggle to the settings page.",
  provenance: "lovable_mcp",
  source_ref: "lovable_mcp_sync",
}) as { id: number };
const fakeDemoEpisode = store.createTaskEpisode({
  project_id: REAL_PROJECT,
  title: "Demo: real thing",
  provenance: "manual",
  evidence_history_item_ids: [fakeDemoItem.id],
}) as { id: number };
const fakeDemoCandidate = store.createCorrectionCandidate({
  task_episode_id: fakeDemoEpisode.id,
  classification: "other",
  is_correction: true,
  summary: "a real 'Demo:'-titled item, not part of the seed",
  evidence_history_item_ids: [fakeDemoItem.id],
}) as { id: number };
const fakeDemoLearning = store.createLearning({
  correction_candidate_id: fakeDemoCandidate.id,
  observed_problem: "p",
  desired_behavior: "d",
  reuse_rationale: "r",
  proposed_scope: "project",
  provenance: "manual",
  created_by: "real-user",
}) as { id: number };
const fakeDemoRule = store.createRule({
  learning_id: fakeDemoLearning.id,
  correction_candidate_id: fakeDemoCandidate.id,
  // Deliberately does NOT start with "Demo:" -- only the episode's title
  // does (that's the collision under test); the rule's own instruction
  // must stay out of this file's "Demo:"-prefix accounting below, or it
  // would be double-counted as one of the seed's own items.
  instruction: "A real rule for a 'Demo:'-titled episode, not part of the seed.",
  scope: "project",
  applies_when: "always",
  predicted_failure: "f",
  ownership: "harness",
  created_by: "real-user",
}) as { id: number };
const fakeDemoBaseDoc = "# Project Knowledge\n\nReal, user-written content.\n";
const fakeDemoNextDoc = `${fakeDemoBaseDoc}\n<!-- a real user's own managed block -->\n`;
const fakeDemoVersion = store.createPendingKnowledgeVersion({
  rule_id: fakeDemoRule.id,
  target: "project",
  project_id: REAL_PROJECT,
  previous_content: fakeDemoBaseDoc,
  new_content: fakeDemoNextDoc,
  rule_ids: [fakeDemoRule.id],
  actor: "real-user",
  reason: "real: not part of the demo",
}) as { id: number };
store.recordKnowledgeReadback(fakeDemoVersion.id, fakeDemoNextDoc);

// Controller fix round 2 (important): a real, EVIDENCE-LESS "Demo:"-titled
// episode -- store.createTaskEpisode / the create_task_episode MCP tool
// both allow evidence_history_item_ids: [] -- must also survive removal.
// The old NOT EXISTS(bad evidence)-only check was vacuously true for zero
// evidence rows, so this specifically exercises the added
// EXISTS(demo-seed evidence) requirement.
const noEvidenceEpisode = store.createTaskEpisode({
  project_id: REAL_PROJECT,
  title: "Demo: build a demo mode toggle",
  provenance: "manual",
  evidence_history_item_ids: [],
}) as { id: number };
const noEvidenceCandidate = store.createCorrectionCandidate({
  task_episode_id: noEvidenceEpisode.id,
  classification: "other",
  is_correction: true,
  summary: "a real, evidence-less 'Demo:'-titled item, not part of the seed",
  evidence_history_item_ids: [],
}) as { id: number };
const noEvidenceLearning = store.createLearning({
  correction_candidate_id: noEvidenceCandidate.id,
  observed_problem: "p",
  desired_behavior: "d",
  reuse_rationale: "r",
  proposed_scope: "project",
  provenance: "manual",
  created_by: "real-user",
}) as { id: number };
const noEvidenceRule = store.createRule({
  learning_id: noEvidenceLearning.id,
  correction_candidate_id: noEvidenceCandidate.id,
  instruction: "A real rule for an evidence-less 'Demo:'-titled episode, not part of the seed.",
  scope: "project",
  applies_when: "always",
  predicted_failure: "f",
  ownership: "harness",
  created_by: "real-user",
}) as { id: number };

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
  "verification_plans",
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

  // Controller fix round 1 (critical): the demo must leave NOTHING the
  // executor would act on against the owner's real Lovable project.
  // (a) no pending knowledge_versions row at all --
  const pendingVersions = db
    .prepare(`SELECT id, rule_id FROM knowledge_versions WHERE status = 'pending'`)
    .all() as { id: number; rule_id: number | null }[];
  assert.deepEqual(
    pendingVersions,
    [],
    "no knowledge_versions row may be left 'pending' after --add -- executeWrites would write it to the real project at the next sync",
  );
  // (b) stageApprovedWrites() -- the same function the executor's runAll
  // calls every sync pass -- must find nothing to stage: no rule is left
  // 'approved' with no written/pending version and no test_first plan.
  const stage = improvements.stageApprovedWrites();
  assert.equal(
    stage.staged,
    0,
    "stageApprovedWrites() must stage nothing after --add -- it would compose and stage a fresh write for any 'approved' rule with no written/pending version",
  );
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
  // IMPROVEMENT_GROUPS value. Controller fix round 1 (critical): "Waiting
  // to be written" is deliberately NOT demoed -- that group means an
  // 'approved' rule with a pending (or no) knowledge_version, which is
  // exactly the footprint stageApprovedWrites()/executeWrites() would act
  // on against the owner's real project at the next sync (see the
  // executor-safety assertions in the --add test above, and demo.ts's
  // header comment). Every OTHER group is still covered.
  const decided = demoItems.filter(
    (i: { kind: string; decision: { status: string } }) =>
      i.kind !== "retire" && i.decision.status !== "pending",
  );
  assert.equal(decided.length, 9, "9 decided demo items");
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
  assert.ok(
    !groups.has("Waiting to be written"),
    '"Waiting to be written" must never appear in the demo -- see the executor-safety comment above',
  );
  const expectedGroups = IMPROVEMENT_GROUPS.filter((g) => g !== "Waiting to be written");
  for (const g of expectedGroups) {
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
    // rule_health is handled separately below: addDemoData's one
    // recomputeRuleHealth() call is global (the same thing the real
    // executor's own hourly sync does for every live rule, not just demo
    // ones), so by the time it ran, fakeDemoRule -- a real, non-demo rule
    // this file itself gave a written knowledge_version -- had also become
    // 'active' with a written version and legitimately got its own fresh
    // rule_health row. That's correct, expected behavior (not a demo
    // leftover), so it's excluded from the blanket per-table comparison.
    // events, likewise: upsertRuleHealth logs one "rule_health.upserted"
    // event (payload {rule_id, status}, no "id") per rule it touches,
    // including fakeDemoRule's legitimate one -- same reasoning as
    // rule_health below.
    if (table === "rule_health" || table === "events") continue;
    assert.equal(after[table], before[table], `${table} must return to its exact pre-add count`);
  }
  assert.equal(
    after.rule_health,
    before.rule_health! + 1,
    "every demo rule_health row must be gone, leaving only the real, non-demo fakeDemoRule's own freshly-computed row",
  );
  assert.ok(
    db.prepare(`SELECT 1 FROM rule_health WHERE rule_id = ?`).get(fakeDemoRule.id),
    "fakeDemoRule's own rule_health row (a side effect of addDemoData's global recompute, not a demo row) must survive",
  );
  assert.equal(
    after.events,
    before.events! + 1,
    "every demo event must be gone, leaving only fakeDemoRule's own rule_health.upserted event",
  );
  const fakeDemoRuleHealthEvent = db
    .prepare(
      `SELECT COUNT(*) as n FROM events WHERE kind = 'rule_health.upserted' AND payload LIKE ?`,
    )
    .get(`%"rule_id":${fakeDemoRule.id}%`) as { n: number };
  assert.ok(
    fakeDemoRuleHealthEvent.n >= 1,
    "fakeDemoRule's own rule_health.upserted event must survive removal",
  );

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

  // Controller fix round 1 (important): a user's own "Demo: real thing"
  // episode -- title-collides with the "Demo:" prefix, but its evidence's
  // source_ref is not 'demo-seed' -- survives untouched: episode,
  // candidate, learning, rule, and its knowledge_version are all still
  // present.
  assert.ok(
    db.prepare(`SELECT 1 FROM task_episodes WHERE id = ?`).get(fakeDemoEpisode.id),
    "a real user's own 'Demo:'-titled episode must survive removal",
  );
  assert.ok(
    db.prepare(`SELECT 1 FROM correction_candidates WHERE id = ?`).get(fakeDemoCandidate.id),
  );
  assert.ok(db.prepare(`SELECT 1 FROM learnings WHERE id = ?`).get(fakeDemoLearning.id));
  assert.ok(db.prepare(`SELECT 1 FROM rules WHERE id = ?`).get(fakeDemoRule.id));
  assert.ok(db.prepare(`SELECT 1 FROM knowledge_versions WHERE id = ?`).get(fakeDemoVersion.id));
  assert.ok(db.prepare(`SELECT 1 FROM history_items WHERE id = ?`).get(fakeDemoItem.id));

  // Controller fix round 2 (important): a real, evidence-less "Demo:"-
  // titled episode (and its candidate/learning/rule) survives untouched --
  // the old NOT EXISTS(bad evidence)-only check was vacuously true for
  // zero evidence rows.
  assert.ok(
    db.prepare(`SELECT 1 FROM task_episodes WHERE id = ?`).get(noEvidenceEpisode.id),
    "a real user's own evidence-less 'Demo:'-titled episode must survive removal",
  );
  assert.ok(
    db.prepare(`SELECT 1 FROM correction_candidates WHERE id = ?`).get(noEvidenceCandidate.id),
  );
  assert.ok(db.prepare(`SELECT 1 FROM learnings WHERE id = ?`).get(noEvidenceLearning.id));
  assert.ok(db.prepare(`SELECT 1 FROM rules WHERE id = ?`).get(noEvidenceRule.id));
});

test("removeDemoData with nothing loaded is a harmless no-op", () => {
  const result = demo.removeDemoData();
  assert.equal(result.removed, false);
  assert.deepEqual(result.counts, {});
});
