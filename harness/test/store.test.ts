import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolated temp DB for this test file, set before db.ts is first imported.
process.env.HARNESS_DB_PATH = join(mkdtempSync(join(tmpdir(), "harness-test-")), "harness.db");

const { db, schemaVersion } = await import("../src/db.js");
const store = await import("../src/store.js");

const PROJECT = "test-project-id";

test("schema migration: applies both migrations exactly once, expected tables exist", () => {
  assert.equal(schemaVersion(), 2);
  const rows = db.prepare(`SELECT version FROM schema_migrations ORDER BY version`).all() as {
    version: number;
  }[];
  assert.deepEqual(
    rows.map((r) => r.version),
    [1, 2],
  );
  const tableNames = new Set(
    (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map(
      (r) => r.name,
    ),
  );
  for (const t of [
    "allowed_projects", "projects", "test_records", "events", // checkpoint A
    "project_snapshots", "history_items", "task_episodes", "task_episode_evidence",
    "correction_candidates", "correction_candidate_evidence", "agent_actions",
    "learnings", "rules", "rule_revisions", // checkpoint B
  ]) {
    assert.ok(tableNames.has(t), `expected table ${t} to exist`);
  }
});

test("allowed project validation: rejects unseeded project, accepts seeded one", () => {
  assert.equal(store.isAllowedProject(PROJECT), false);
  assert.throws(
    () =>
      store.createTaskEpisode({
        project_id: PROJECT,
        title: "should fail",
        provenance: "manual",
      }),
    store.NotAllowedProjectError,
  );

  db.prepare(`INSERT INTO allowed_projects (lovable_project_id, label) VALUES (?, ?)`).run(
    PROJECT,
    "test seed",
  );
  assert.equal(store.isAllowedProject(PROJECT), true);
});

let episodeId: number;
test("evidence provenance: enum is enforced, valid values persist", () => {
  assert.throws(() =>
    store.upsertHistoryItem({
      project_id: PROJECT,
      kind: "manual_note",
      content: "bad provenance",
      // @ts-expect-error deliberately invalid
      provenance: "not_a_real_source",
    }),
  );

  const item = store.upsertHistoryItem({
    project_id: PROJECT,
    kind: "manual_note",
    external_id: "operator-quote-1",
    role: "operator",
    content: "the every-minute cron is unacceptable",
    provenance: "manual",
  }) as { id: number; provenance: string };
  assert.equal(item.provenance, "manual");

  const episode = store.createTaskEpisode({
    project_id: PROJECT,
    title: "cron scheduling correction",
    provenance: "llm_derived",
    evidence_history_item_ids: [item.id],
  }) as { id: number };
  episodeId = episode.id;
  const links = db
    .prepare(`SELECT * FROM task_episode_evidence WHERE task_episode_id = ?`)
    .all(episode.id);
  assert.equal(links.length, 1);
});

let correctionId: number;
test("correction review update: each action mutates the expected fields and sets reviewed", () => {
  const item = store.upsertHistoryItem({
    project_id: PROJECT,
    kind: "manual_note",
    content: "evidence for classification",
    provenance: "manual",
  }) as { id: number };

  const cc = store.createCorrectionCandidate({
    task_episode_id: episodeId,
    classification: "other",
    is_correction: true,
    summary: "initial guess",
    evidence_history_item_ids: [item.id],
  }) as { id: number; reviewed: number };
  correctionId = cc.id;
  assert.equal(cc.reviewed, 0);

  let updated = store.reviewCorrectionCandidate({
    id: correctionId,
    action: "reclassify",
    classification: "constraint_restatement",
  }) as Record<string, unknown>;
  assert.equal(updated.classification, "constraint_restatement");
  assert.equal(updated.reviewed, 1);

  updated = store.reviewCorrectionCandidate({ id: correctionId, action: "mark_reusable" }) as Record<
    string,
    unknown
  >;
  assert.equal(updated.reusable, 1);

  updated = store.reviewCorrectionCandidate({
    id: correctionId,
    action: "change_scope",
    proposed_scope: "project",
  }) as Record<string, unknown>;
  assert.equal(updated.proposed_scope, "project");

  updated = store.reviewCorrectionCandidate({ id: correctionId, action: "exclude" }) as Record<
    string,
    unknown
  >;
  assert.equal(updated.excluded_from_learning, 1);
});

let ruleId: number;
test("rule edit creating a revision: instruction change is versioned, no-op change is not", () => {
  const learning = store.createLearning({
    correction_candidate_id: correctionId,
    observed_problem: "background worker polled every minute",
    desired_behavior: "no autonomous schedule without explicit user opt-in",
    reuse_rationale: "same failure mode applies to any future background job",
    proposed_scope: "workspace",
    provenance: "llm_derived",
    created_by: "claude-checkpoint-b",
  }) as { id: number };

  const rule = store.createRule({
    learning_id: learning.id,
    correction_candidate_id: correctionId,
    instruction: "Never schedule a credit- or token-spending job more often than the user explicitly requests.",
    scope: "workspace",
    applies_when: "adding any pg_cron job or other recurring background trigger",
    predicted_failure: "an autonomous high-frequency job runs unattended and the user rejects it after the fact",
    ownership: "harness",
    created_by: "claude-checkpoint-b",
  }) as { id: number; state: string };
  ruleId = rule.id;
  assert.equal(rule.state, "proposed");

  const revisedInstruction = "Never schedule a credit- or token-spending job more often than weekly by default.";
  const edited = store.updateRule({
    id: ruleId,
    instruction: revisedInstruction,
    actor: "operator",
    reason: "tighten wording",
  }) as { instruction: string };
  assert.equal(edited.instruction, revisedInstruction);

  let revisions = db.prepare(`SELECT * FROM rule_revisions WHERE rule_id = ?`).all(ruleId);
  assert.equal(revisions.length, 1);

  // No-op update (same instruction, same state) must not create a second revision.
  store.updateRule({ id: ruleId, instruction: revisedInstruction, actor: "operator" });
  revisions = db.prepare(`SELECT * FROM rule_revisions WHERE rule_id = ?`).all(ruleId);
  assert.equal(revisions.length, 1);
});

test("approval does not produce a Lovable action: local-only by construction, DB reflects it", () => {
  const source = readFileSync(new URL("../src/store.ts", import.meta.url), "utf8");
  const code = source
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  // "lovable_project_id" etc. are plain string/field names, not imports or calls --
  // the real check is that no import statement or network call touches Lovable.
  assert.ok(!/^\s*import.*lovable/im.test(code), "store.ts must not import anything Lovable-related");
  assert.ok(!/fetch\(|http\.request|https\.request/.test(code), "store.ts must not make network calls");

  const approved = store.updateRule({ id: ruleId, state: "approved", actor: "operator" }) as {
    state: string;
  };
  assert.equal(approved.state, "approved");

  const revisions = db.prepare(`SELECT * FROM rule_revisions WHERE rule_id = ?`).all(ruleId) as {
    new_state: string;
  }[];
  assert.equal(revisions.at(-1)?.new_state, "approved");
});

test("idempotent history-item upsert: same (project_id, kind, external_id) updates in place, not duplicates", () => {
  const first = store.upsertHistoryItem({
    project_id: PROJECT,
    kind: "message",
    external_id: "msg-idempotent-1",
    role: "user",
    content: "first version",
    provenance: "lovable_mcp",
  }) as { id: number };

  const second = store.upsertHistoryItem({
    project_id: PROJECT,
    kind: "message",
    external_id: "msg-idempotent-1",
    role: "user",
    content: "second version",
    provenance: "lovable_mcp",
  }) as { id: number; content: string };

  assert.equal(second.id, first.id);
  assert.equal(second.content, "second version");

  const count = (
    db
      .prepare(
        `SELECT COUNT(*) as n FROM history_items WHERE project_id = ? AND kind = 'message' AND external_id = ?`,
      )
      .get(PROJECT, "msg-idempotent-1") as { n: number }
  ).n;
  assert.equal(count, 1);
});

test("get_rule / list_project_rules expose the full chain", () => {
  const full = store.getRule(ruleId) as { rule: { id: number }; learning: unknown; correction_candidate: unknown };
  assert.equal(full.rule.id, ruleId);
  assert.ok(full.learning);
  assert.ok(full.correction_candidate);

  const projectRules = store.listProjectRules(PROJECT) as { id: number }[];
  assert.ok(projectRules.some((r) => r.id === ruleId));
});
