import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Checkpoint 2026-09-18: the replay environment record. A historical replay
// must say which Project Knowledge it started from (and how that was
// chosen), keep the rules that were live at the time, add only the
// candidate, and label how comparable the result is. Pure functions first,
// then the store round-trip and the backfill for runs recorded before the
// column existed.
const tmp = mkdtempSync(join(tmpdir(), "harness-replay-env-test-"));
process.env.HARNESS_DB_PATH = join(tmp, "harness.db");
process.env.HARNESS_AUTH_PATH = join(tmp, "lovable-auth.json");

const store = await import("../src/store.js");
const { db } = await import("../src/db.js");
const { HARNESS_START, HARNESS_END, MANAGED_HEADING } = await import("../src/knowledge.js");
const {
  selectProjectKnowledgeAt,
  composeReplayKnowledge,
  environmentQuality,
  buildReplayEnvironment,
  backfillReplayEnvironments,
  UNCONTROLLED_CONTEXT,
} = await import("../src/executor/replay-environment.js");

const block = (bullets: string[]) =>
  `${HARNESS_START}\n${MANAGED_HEADING}\n${bullets.map((b) => `- ${b}`).join("\n")}\n${HARNESS_END}`;

// ------------------------------------------------- selectProjectKnowledgeAt

test("selectProjectKnowledgeAt: the newest snapshot at or before T is nearest_earlier_version", () => {
  const snaps = [
    { id: 1, content: "a", fetched_at: "2026-09-13 18:33:05" },
    { id: 2, content: "b", fetched_at: "2026-09-13 19:06:23" },
    { id: 3, content: "c", fetched_at: "2026-09-13 23:14:34" },
  ];
  const picked = selectProjectKnowledgeAt(snaps, "2026-09-13T19:13:21Z", "2026-09-13T23:22:23Z");
  assert.equal(picked.source, "nearest_earlier_version");
  assert.equal(picked.snapshot_id, 2);
  assert.equal(picked.content, "b");
});

test("selectProjectKnowledgeAt: a snapshot taken in the same second as T counts as exact_historical", () => {
  const snaps = [{ id: 9, content: "x", fetched_at: "2026-09-13 19:13:21" }];
  const picked = selectProjectKnowledgeAt(snaps, "2026-09-13T19:13:21Z", "2026-09-13T23:00:00Z");
  assert.equal(picked.source, "exact_historical");
  assert.equal(picked.snapshot_id, 9);
});

test("selectProjectKnowledgeAt: no snapshot before T falls back to the newest one known when the run started, labelled current_fallback", () => {
  const snaps = [
    { id: 16, content: "first", fetched_at: "2026-09-13 18:33:05" },
    { id: 42, content: "at run time", fetched_at: "2026-09-13 23:14:34" },
    { id: 45, content: "after the run", fetched_at: "2026-09-14 18:01:32" },
  ];
  const picked = selectProjectKnowledgeAt(snaps, "2026-09-13T18:29:14Z", "2026-09-13T23:16:33Z");
  assert.equal(picked.source, "current_fallback");
  assert.equal(picked.snapshot_id, 42);
  assert.equal(picked.content, "at run time");
});

test("selectProjectKnowledgeAt: nothing on file at all is unavailable, with empty content", () => {
  const picked = selectProjectKnowledgeAt([], "2026-09-13T18:29:14Z", "2026-09-13T23:16:33Z");
  assert.equal(picked.source, "unavailable");
  assert.equal(picked.snapshot_id, null);
  assert.equal(picked.content, "");
});

test("selectProjectKnowledgeAt: without an episode time the choice is current_fallback, never silently 'historical'", () => {
  const snaps = [{ id: 1, content: "a", fetched_at: "2026-09-13 18:33:05" }];
  const picked = selectProjectKnowledgeAt(snaps, null, "2026-09-13T23:16:33Z");
  assert.equal(picked.source, "current_fallback");
});

// --------------------------------------------------- composeReplayKnowledge

test("composeReplayKnowledge: keeps the rules that were live in the historical block and appends the candidate", () => {
  const base = `My own notes\n\n${block(["Use kronor."])}`;
  const out = composeReplayKnowledge(base, { id: 24, instruction: "Use sentence case." });
  assert.equal(out.final_content, `My own notes\n\n${block(["Use kronor.", "Use sentence case."])}`);
  assert.deepEqual(out.other_active_rules, ["Use kronor."]);
  assert.equal(out.candidate_already_present, false);
});

test("composeReplayKnowledge: no historical block means a new block holding only the candidate, user text untouched", () => {
  const out = composeReplayKnowledge("Only my text", { id: 1, instruction: "Rule." });
  assert.equal(out.final_content, `Only my text\n\n${block(["Rule."])}`);
  assert.deepEqual(out.other_active_rules, []);
});

test("composeReplayKnowledge: Lovable's '(empty)' placeholder reads as empty Knowledge", () => {
  const out = composeReplayKnowledge("(empty)", { id: 1, instruction: "Rule." });
  assert.equal(out.final_content, block(["Rule."]));
});

test("composeReplayKnowledge: a candidate already in the historical block is not duplicated and is reported", () => {
  const base = block(["Use kronor.", "Use sentence case."]);
  const out = composeReplayKnowledge(base, { id: 24, instruction: "Use sentence case." });
  assert.equal(out.final_content, base);
  assert.equal(out.candidate_already_present, true);
  assert.deepEqual(out.other_active_rules, ["Use kronor."]);
});

test("composeReplayKnowledge: an empty historical block (all rules retired) yields a block with just the candidate", () => {
  const base = `${HARNESS_START}\n${MANAGED_HEADING}\n\n${HARNESS_END}`;
  const out = composeReplayKnowledge(base, { id: 24, instruction: "Use sentence case." });
  assert.equal(out.final_content, block(["Use sentence case."]));
  assert.deepEqual(out.other_active_rules, []);
});

// ------------------------------------------------------ environmentQuality

test("environmentQuality: a historical replay is at best a historical approximation, whatever the Knowledge source", () => {
  for (const source of ["exact_historical", "nearest_earlier_version"] as const) {
    assert.equal(
      environmentQuality({ kind: "historical_replay", project_knowledge_source: source, code_state_ok: true }),
      "historical_approximation",
    );
  }
});

test("environmentQuality: a replay whose Knowledge came from today or is unknown is still a historical approximation, and a missing code state is not comparable", () => {
  assert.equal(
    environmentQuality({
      kind: "historical_replay",
      project_knowledge_source: "current_fallback",
      code_state_ok: true,
    }),
    "historical_approximation",
  );
  assert.equal(
    environmentQuality({
      kind: "historical_replay",
      project_knowledge_source: "exact_historical",
      code_state_ok: false,
    }),
    "not_comparable",
  );
});

test("environmentQuality: a paired comparison with historical Knowledge is partially controlled (memory, workspace Knowledge and Skills stay uncontrolled); with today's Knowledge it is a historical approximation", () => {
  assert.equal(
    environmentQuality({
      kind: "paired_comparison",
      project_knowledge_source: "nearest_earlier_version",
      code_state_ok: true,
    }),
    "partially_controlled",
  );
  assert.equal(
    environmentQuality({
      kind: "paired_comparison",
      project_knowledge_source: "current_fallback",
      code_state_ok: true,
    }),
    "historical_approximation",
  );
});

test("UNCONTROLLED_CONTEXT always names project memory, workspace Knowledge, Skills and the Lovable model", () => {
  assert.deepEqual(UNCONTROLLED_CONTEXT, [
    "lovable_project_memory",
    "workspace_knowledge",
    "skills",
    "lovable_model_version",
  ]);
});

// --------------------------------------------- buildReplayEnvironment + DB

const SOURCE = "prj_env";
store.allowProject(SOURCE, "Env project");
store.upsertProject({ lovable_project_id: SOURCE, name: "Env project", workspace_id: "ws_env" });

function seedSnapshot(content: string, fetchedAt: string): number {
  const { id } = store.recordKnowledgeSnapshot({
    target: "project",
    project_id: SOURCE,
    content,
    fetched_by: "test",
  });
  db.prepare(`UPDATE knowledge_snapshots SET fetched_at = ? WHERE id = ?`).run(fetchedAt, id);
  return id;
}

test("buildReplayEnvironment: records every surface, the Knowledge choice, the kept rules and the quality label", () => {
  const before = seedSnapshot(block(["Use kronor."]), "2026-09-13 19:06:23");
  seedSnapshot(block(["Use sentence case."]), "2026-09-13 23:14:34");
  const env = buildReplayEnvironment({
    kind: "historical_replay",
    source_project_id: SOURCE,
    episode_started_at: "2026-09-13T19:13:21Z",
    run_started_at: "2026-09-13T23:22:23Z",
    candidate: { id: 24, instruction: "Use sentence case." },
    request_rest_message_id: "umsg_1",
    chat_history_included: false,
  });
  assert.equal(env.version, 1);
  assert.equal(env.kind, "historical_replay");
  assert.equal(env.project_knowledge.source, "nearest_earlier_version");
  assert.equal(env.project_knowledge.snapshot_id, before);
  assert.deepEqual(env.other_active_rules, ["Use kronor."]);
  assert.equal(env.candidate_rule.instruction, "Use sentence case.");
  assert.equal(env.code_state.source, "historical_commit_before_request");
  assert.equal(env.code_state.request_message_id, "umsg_1");
  assert.equal(env.workspace_knowledge.source, "current_uncontrolled");
  assert.equal(env.skills.source, "current_uncontrolled");
  assert.equal(env.chat_history.included, false);
  assert.deepEqual(env.uncontrolled, UNCONTROLLED_CONTEXT);
  assert.equal(env.quality, "historical_approximation");
  assert.equal(env.knowledge_for_copy, block(["Use kronor.", "Use sentence case."]));
});

test("backfillReplayEnvironments: an older run gets an environment computed from what was on file when it ran, and is marked historical_replay", () => {
  db.prepare(`DELETE FROM knowledge_snapshots WHERE project_id = ?`).run(SOURCE);
  seedSnapshot(block(["Use kronor."]), "2026-09-13 19:06:23");
  seedSnapshot(block(["Use sentence case."]), "2026-09-13 23:14:34");

  // Episode → candidate → rule chain, then a run recorded before the column existed.
  const ep = store.createTaskEpisode({
    project_id: SOURCE,
    title: "Add a tip line",
    provenance: "manual",
    started_at: "2026-09-13T19:13:21Z",
  });
  const cc = store.createCorrectionCandidate({
    task_episode_id: ep.id,
    classification: "preference_revision",
    is_correction: true,
    reusable: true,
    proposed_scope: "project",
    summary: "sentence case",
    confidence: 0.9,
    evidence_reason: "test",
    evidence_history_item_ids: [],
  });
  const learning = store.createLearning({
    correction_candidate_id: cc.id,
    observed_problem: "caps",
    desired_behavior: "sentence case",
    reuse_rationale: "test",
    proposed_scope: "project",
    provenance: "manual",
    created_by: "test",
  });
  const rule = store.createRule({
    learning_id: learning.id,
    correction_candidate_id: cc.id,
    instruction: "Use sentence case.",
    scope: "project",
    applies_when: "always",
    predicted_failure: "caps",
    ownership: "harness",
    created_by: "test",
  });
  const { id: runId } = store.createExperimentRun({
    rule_id: rule.id,
    correction_candidate_id: cc.id,
    task_episode_id: ep.id,
    source_project_id: SOURCE,
    request_message_external_id: "main:user#1",
  });
  db
    .prepare(`UPDATE experiment_runs SET started_at = ?, environment_json = NULL WHERE id = ?`)
    .run("2026-09-13 23:22:23", runId);

  const { backfilled } = backfillReplayEnvironments();
  assert.ok(backfilled.includes(runId));
  const row = store.getExperimentRun(runId)!;
  assert.equal(row.kind, "historical_replay");
  const env = JSON.parse(row.environment_json!);
  assert.equal(env.project_knowledge.source, "nearest_earlier_version");
  assert.deepEqual(env.other_active_rules, ["Use kronor."]);
  assert.equal(env.backfilled, true);
  // Note: the run really sent "rule 24 only" (the old composer replaced the
  // block), so a backfilled record says what the base was and that the
  // historical rules were dropped by the run itself.
  assert.equal(env.historical_rules_dropped_by_run, true);

  // Idempotent: a second pass touches nothing.
  assert.deepEqual(backfillReplayEnvironments().backfilled, []);
});
