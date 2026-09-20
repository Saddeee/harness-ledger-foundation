import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HARNESS_DB_PATH = join(
  mkdtempSync(join(tmpdir(), "harness-improvements-test-")),
  "harness.db",
);

const { db } = await import("../src/db.js");
const store = await import("../src/store.js");
const imp = await import("../src/improvements.js");
// Round 5 fix wave item 1: the verdict action's did_not_help path now
// recomputes rule_health instead of mutating it directly -- one test below
// exercises that same recompute directly, to seed/verify a real row.
const { recomputeRuleHealth } = await import("../src/analysis/health.js");
const { lineDiff: adapterLineDiff } = await import("../src/diff.js");
const { improvementGroup, lovableStatusLine } = await import("../../src/lib/harness-ux.ts");

const PROJECT = "improvements-test-project";
db.prepare(`INSERT INTO allowed_projects (lovable_project_id, label) VALUES (?, ?)`).run(
  PROJECT,
  "test",
);
store.upsertProject({ lovable_project_id: PROJECT, name: "Test Project" });

const VERBATIM_USER = "Build a queue worker.\n\nSchedule with pg_cron: every minute.";
const VERBATIM_LOVABLE =
  "<lov-tool-use>...</lov-tool-use>\nThe foundation is live; a background worker now runs every minute.";

function mk(
  kind: string,
  role: string | null,
  content: string,
  provenance: string,
  occurred_at: string,
  external_id: string,
) {
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

const asked = mk(
  "message",
  "user",
  VERBATIM_USER,
  "lovable_mcp",
  "2026-09-07T23:29:36Z",
  "m-user-1",
);
const built = mk(
  "message",
  "assistant",
  VERBATIM_LOVABLE,
  "lovable_mcp",
  "2026-09-07T23:35:46Z",
  "m-agent-1",
);
const note = mk(
  "manual_note",
  "operator",
  "my message to Claude Code",
  "manual",
  "2026-09-07T23:47:00Z",
  "note-1",
);
const buildLog = mk(
  "build_log_row",
  null,
  "build-log row",
  "build_log",
  "2026-09-07T23:47:00Z",
  "bl-1",
);
const fixed = mk(
  "message",
  "user",
  "that cron must NOT be recreated",
  "lovable_mcp",
  "2026-09-08T10:31:23Z",
  "m-user-2",
);

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
  instruction:
    "Do not enable recurring background work by default. Prefer user-triggered execution.",
  scope: "workspace",
  applies_when: "always",
  predicted_failure: "unapproved recurring work",
  ownership: "harness",
  created_by: "test",
}) as { id: number };

test("evidence is Lovable-chat-only, verbatim, chronological; the rest is developer.hidden_evidence", () => {
  const item = imp.getImprovement(cc.id)!;
  assert.deepEqual(
    item.evidence.map((e) => e.id),
    [asked.id, built.id, fixed.id],
  );
  assert.deepEqual(
    item.evidence.map((e) => e.author),
    ["you", "lovable", "you"],
  );
  assert.equal(item.evidence[0]!.text, VERBATIM_USER);
  assert.equal(item.evidence[1]!.text, VERBATIM_LOVABLE); // tool-use XML included, untouched
  const hiddenIds = (item.developer.hidden_evidence as { id: number }[]).map((h) => h.id).sort();
  assert.deepEqual(hiddenIds, [note.id, buildLog.id].sort());
  for (const e of item.evidence)
    assert.ok(!/manual|build_log|main:user#/.test(JSON.stringify({ a: e.author, s: e.sent_at })));
});

test("shape + initial state: pending, review current, proof future, project name resolved", () => {
  const item = imp.getImprovement(cc.id)!;
  assert.equal(item.project.name, "Test Project");
  assert.equal(item.title, "Do not enable recurring background work by default.");
  assert.equal(item.destination, "workspace");
  assert.equal(item.decision.status, "pending");
  assert.equal(item.decision.decided_at, null);
  assert.equal(item.stage, "review");
  assert.deepEqual(
    item.stages.map((s) => [s.key, s.state]),
    [
      ["found", "complete"],
      ["review", "current"],
      ["proof", "future"],
      ["in_lovable", "future"],
    ],
  );
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
  const c = db
    .prepare(`SELECT reviewed, proposed_scope FROM correction_candidates WHERE id = ?`)
    .get(cc.id) as { reviewed: number; proposed_scope: string };
  const r = db.prepare(`SELECT state, scope FROM rules WHERE id = ?`).get(rule.id) as {
    state: string;
    scope: string;
  };
  assert.equal(c.reviewed, 1);
  assert.equal(c.proposed_scope, "project");
  assert.equal(r.state, "approved");
  assert.equal(r.scope, "project");
  assert.equal(item.decision.divergence, null);
  // scope change is audited but is not a wording revision
  assert.equal(
    (
      db.prepare(`SELECT count(*) n FROM rule_revisions WHERE rule_id = ?`).get(rule.id) as {
        n: number;
      }
    ).n,
    1,
  );
  assert.ok(db.prepare(`SELECT 1 FROM events WHERE kind = 'rule.scope_changed'`).get());
});

test("proof block derives from plans; runnable is always false; proof note says not runnable", () => {
  const vd = store.createVerificationDefinition({
    scope: "workspace",
    name: "v",
    description: "d",
    verifier_type: "structural",
    configuration: "{}",
    source: "manual",
    ownership: "harness",
  }) as { id: number };
  store.createVerificationPlan({
    rule_id: rule.id,
    failure_signature: "sig",
    failure_condition: "cond",
    created_by: "t",
    verification_definition_ids: [vd.id],
  });
  store.createExperimentPlan({
    rule_id: rule.id,
    source_project_id: PROJECT,
    experiment_type: "paired_control_treatment",
    starting_state_quality: "controlled_equivalent",
    control_configuration: "c",
    treatment_configuration: "t",
    exact_prompt: "p",
    protected_checks: "[]",
    estimated_credits: 3,
    max_permitted_credits: 6,
    resource_strategy: "temp remix",
    cleanup_requirements: "manual cleanup by the operator",
    risks: "r",
    success_conditions: "s",
    inconclusive_conditions: "i",
    stop_conditions: "s",
    created_by: "t",
    verification_definition_ids: [vd.id],
  });
  const item = imp.getImprovement(cc.id)!;
  assert.deepEqual(item.proof, {
    exists: true,
    runnable: false,
    lovable_credits_max: 6,
    outcome: "not_run",
    manual_cleanup: true,
  });
  assert.equal(item.stages[2]!.state, "current");
  assert.equal(item.stages[2]!.note, "Not proven yet");
  assert.equal(item.stages[3]!.note, "Not in Lovable yet");
});

test("change_wording creates a rule_revision and appears in wording_history", () => {
  const item = imp.improvementAction({
    action: "change_wording",
    id: cc.id,
    instruction: "Never enable recurring work by default.",
    reason: "shorter",
  });
  assert.equal(item.proposed_instruction, "Never enable recurring work by default.");
  assert.equal(item.wording_history.length, 1);
  assert.equal(
    item.wording_history[0]!.from,
    "Do not enable recurring background work by default. Prefer user-triggered execution.",
  );
  assert.equal(item.wording_history[0]!.to, "Never enable recurring work by default.");
  assert.equal(item.wording_history[0]!.reason, "shorter");
});

test("set_destination one_time marks the correction one-time but leaves rule.scope unchanged (and surfaces no false divergence)", () => {
  const item = imp.improvementAction({
    action: "set_destination",
    id: cc.id,
    destination: "one_time",
  });
  const c = db
    .prepare(`SELECT proposed_scope, reusable FROM correction_candidates WHERE id = ?`)
    .get(cc.id) as { proposed_scope: string; reusable: number };
  const r = db.prepare(`SELECT scope FROM rules WHERE id = ?`).get(rule.id) as { scope: string };
  assert.equal(c.proposed_scope, "one_time");
  assert.equal(c.reusable, 0);
  assert.equal(r.scope, "project");
  assert.equal(item.destination, "project"); // rule.scope wins when a rule exists
  assert.equal(item.decision.divergence, null);
  imp.improvementAction({ action: "set_destination", id: cc.id, destination: "workspace" });
  assert.equal(
    (db.prepare(`SELECT scope FROM rules WHERE id = ?`).get(rule.id) as { scope: string }).scope,
    "workspace",
  );
});

test("skip: excluded + rule rejected -> skipped, review blocked, later stages blocked", () => {
  const item = imp.improvementAction({ action: "skip", id: cc.id });
  assert.equal(item.decision.status, "skipped");
  assert.deepEqual(
    item.stages.map((s) => s.state),
    ["complete", "blocked", "blocked", "blocked"],
  );
  assert.equal(item.stages[1]!.note, "Skipped");
  assert.equal(
    (db.prepare(`SELECT state FROM rules WHERE id = ?`).get(rule.id) as { state: string }).state,
    "rejected",
  );
  assert.equal(
    (
      db
        .prepare(`SELECT excluded_from_learning FROM correction_candidates WHERE id = ?`)
        .get(cc.id) as { excluded_from_learning: number }
    ).excluded_from_learning,
    1,
  );
});

test("reopen restores pending / proposed", () => {
  const item = imp.improvementAction({ action: "reopen", id: cc.id });
  assert.equal(item.decision.status, "pending");
  assert.equal(item.stage, "review");
  assert.equal(
    (db.prepare(`SELECT state FROM rules WHERE id = ?`).get(rule.id) as { state: string }).state,
    "proposed",
  );
  assert.equal(
    (
      db
        .prepare(`SELECT excluded_from_learning FROM correction_candidates WHERE id = ?`)
        .get(cc.id) as { excluded_from_learning: number }
    ).excluded_from_learning,
    0,
  );
});

test("divergence sentence when the correction is excluded but the rule is approved", () => {
  store.updateRule({ id: rule.id, state: "approved", actor: "test" });
  store.reviewCorrectionCandidate({ id: cc.id, action: "exclude" });
  const item = imp.getImprovement(cc.id)!;
  assert.equal(item.decision.status, "skipped");
  assert.equal(
    item.decision.divergence,
    "You skipped this lesson, but a rule based on it is still approved.",
  );
  // restore
  imp.improvementAction({ action: "reopen", id: cc.id });
});

test("validation: unknown action and out-of-enum destination are rejected", () => {
  assert.throws(() => imp.improvementAction({ action: "execute", id: cc.id }));
  assert.throws(() =>
    imp.improvementAction({ action: "accept", id: cc.id, destination: "one_time" }),
  );
  assert.throws(() =>
    imp.improvementAction({ action: "accept", id: 999999, destination: "project" }),
  );
});

test("no Lovable import and no network call in improvements.ts / adapter.ts / store.ts", () => {
  for (const file of ["../src/improvements.ts", "../src/adapter.ts", "../src/store.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    const code = source
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    assert.ok(
      !/^\s*import.*lovable/im.test(code),
      `${file} must not import anything Lovable-related`,
    );
    assert.ok(
      !/fetch\(|http\.request|https\.request/.test(code),
      `${file} must not make network calls`,
    );
  }
});

test("switching to test_first cancels any Knowledge write already staged from a plain accept, and a later plain accept re-stages a normal write", () => {
  // Start clean and self-contained: don't depend on state any other test
  // in this file happens to leave behind. This test must run before the
  // one below that marks a version WRITTEN (once that happens, this rule's
  // decision.test_first can never read true again -- see that test).
  imp.improvementAction({ action: "reopen", id: cc.id });
  store.cancelPendingKnowledgeWrites(rule.id, "test setup");
  store.recordKnowledgeSnapshot({
    target: "project",
    project_id: PROJECT,
    content: "# Knowledge\n\nExisting text.",
    fetched_by: "test",
  });

  // 1. A plain accept stages a write the normal way.
  imp.improvementAction({ action: "accept", id: cc.id, destination: "project" });
  assert.equal(
    store.listPendingKnowledgeWrites().length,
    1,
    "plain accept stages one pending write",
  );

  // 2. Switching to test_first (no reopen in between) must cancel that
  // now-stale staged write -- otherwise the executor would still write it
  // at the next sync even though the UI says "nothing is written until the
  // test runs". This reproduces the reported bug.
  const testFirstItem = imp.improvementAction({
    action: "accept",
    id: cc.id,
    destination: "project",
    test_first: true,
  });
  assert.deepEqual(
    store.listPendingKnowledgeWrites(),
    [],
    "switching to test_first cancels the previously staged write",
  );
  assert.equal(testFirstItem.decision.test_first, true);
  // The cancelled write must not read as a failure: write_status ignores
  // it entirely (falls back to "none", not "failed"), so the group and
  // status line are the test-first ones, not "Needs attention".
  assert.equal(
    testFirstItem.lovable.write_status,
    "none",
    "a cancelled write must not surface as failed",
  );
  assert.equal(
    improvementGroup({
      status: testFirstItem.decision.status,
      writeStatus: testFirstItem.lovable.write_status,
      testFirst: testFirstItem.decision.test_first,
    }),
    "Waiting to be tested",
  );
  assert.match(lovableStatusLine(testFirstItem.lovable, { testFirst: true }), /^Saved for testing/);
  // The history stays honest, though: the cancelled version is still
  // listed, just not treated as the current status.
  const cancelledVersions = testFirstItem.lovable.versions.filter((v) => v.status === "cancelled");
  assert.equal(
    cancelledVersions.length,
    1,
    "the superseded write appears in lovable.versions as cancelled",
  );

  // 3. Switching back to a plain accept re-stages a real write the normal
  // way; a pending write genuinely exists again, and decision.test_first
  // must read false immediately -- a pending write is a real write the
  // executor will apply at the next sync, so nothing about this item is
  // "waiting to be tested" any more.
  imp.improvementAction({ action: "accept", id: cc.id, destination: "project" });
  const pendingWrites = store.listPendingKnowledgeWrites() as { id: number }[];
  assert.equal(pendingWrites.length, 1, "the plain accept re-stages exactly one pending write");
  const afterSecondPlainAccept = imp.getImprovement(cc.id)!;
  assert.equal(
    afterSecondPlainAccept.lovable.write_status,
    "pending",
    'write_status shows the real pending write, not "none"',
  );
  assert.equal(
    afterSecondPlainAccept.decision.test_first,
    false,
    "a staged write means the item is no longer waiting to be tested",
  );
  assert.equal(
    improvementGroup({
      status: afterSecondPlainAccept.decision.status,
      writeStatus: afterSecondPlainAccept.lovable.write_status,
      testFirst: afterSecondPlainAccept.decision.test_first,
    }),
    "Waiting to be written",
    "the Improvements page groups it as a normal pending write, not as waiting to be tested",
  );
});

test("accept with test_first: true approves the rule and its experiment plan but stages no Knowledge write; once any version for the rule has been WRITTEN, test_first is false for good", () => {
  // Start from a clean pending state regardless of what earlier tests in
  // this file left behind.
  imp.improvementAction({ action: "reopen", id: cc.id });
  store.cancelPendingKnowledgeWrites(rule.id, "test setup");
  store.recordKnowledgeSnapshot({
    target: "project",
    project_id: PROJECT,
    content: "# Knowledge\n\nExisting text.",
    fetched_by: "test",
  });

  const item = imp.improvementAction({
    action: "accept",
    id: cc.id,
    destination: "project",
    test_first: true,
  });
  assert.equal(item.decision.status, "accepted");
  assert.equal(item.decision.test_first, true);
  assert.deepEqual(
    store.listPendingKnowledgeWrites(),
    [],
    "test_first accept stages no Knowledge write",
  );

  const r = db.prepare(`SELECT state FROM rules WHERE id = ?`).get(rule.id) as { state: string };
  assert.equal(r.state, "approved");
  const plans = store.listExperimentPlansForRule(rule.id) as { plan: { status: string } }[];
  assert.ok(plans.length >= 1, "an experiment plan exists for the rule");
  assert.equal(plans[0]!.plan.status, "approved");

  // Stage and write a Knowledge version directly through the store (not via
  // a plain "accept" action -- that transition, and its immediate effect
  // on decision.test_first, is covered by the "switching to test_first
  // cancels..." test above). This isolates the other half of the contract:
  // once a version has actually been WRITTEN for the rule, test_first is
  // false, and (since the written-version check looks at the rule's whole
  // history, not just the latest version) stays false from then on.
  const pending = store.createPendingKnowledgeVersion({
    rule_id: rule.id,
    target: "project",
    project_id: PROJECT,
    previous_content: "# Knowledge\n\nExisting text.",
    new_content: "# Knowledge\n\nExisting text.\n\nWritten by the test.",
    rule_ids: [rule.id],
    actor: "test",
  }) as { id: number; new_content: string };
  store.recordKnowledgeReadback(pending.id, pending.new_content);
  const afterWrite = imp.getImprovement(cc.id)!;
  assert.equal(afterWrite.decision.test_first, false, "flips false once a written version exists");
});

test("cancelPendingKnowledgeWrites marks a pending write cancelled, not failed", () => {
  store.cancelPendingKnowledgeWrites(rule.id, "test setup");
  store.recordKnowledgeSnapshot({
    target: "project",
    project_id: PROJECT,
    content: "# Knowledge\n\nMore text.",
    fetched_by: "test",
  });
  const version = store.createPendingKnowledgeVersion({
    rule_id: rule.id,
    target: "project",
    project_id: PROJECT,
    previous_content: "# Knowledge\n\nMore text.",
    new_content: "# Knowledge\n\nMore text.\n\nedited.",
    rule_ids: [rule.id],
    actor: "test",
  }) as { id: number };

  const cancelledCount = store.cancelPendingKnowledgeWrites(rule.id, "test: cancel not fail");
  assert.equal(cancelledCount, 1);
  const reloaded = store.getKnowledgeVersion(version.id) as {
    status: string;
    error: string | null;
  } | null;
  assert.equal(reloaded?.status, "cancelled");
  assert.equal(reloaded?.error, "test: cancel not fail");
});

test("v7 migration (checkpoint_g_cancelled_writes) rebuilds knowledge_versions without losing existing rows, and the new status CHECK accepts 'cancelled'", async () => {
  const { default: Database } = await import("better-sqlite3");
  const { MIGRATIONS } = await import("../src/migrations.js");

  const tmpDb = new Database(":memory:");
  tmpDb.pragma("foreign_keys = ON");
  const upToV6 = [...MIGRATIONS]
    .filter((m) => m.version <= 6)
    .sort((a, b) => a.version - b.version);
  for (const m of upToV6) tmpDb.exec(m.sql);

  // Seed one knowledge_versions row under the pre-v7 schema, the way a
  // real deployment would have data sitting there before upgrading.
  tmpDb
    .prepare(`INSERT INTO allowed_projects (lovable_project_id, label) VALUES (?, ?)`)
    .run("v7-test-project", "p");
  tmpDb
    .prepare(
      `INSERT INTO knowledge_versions
         (id, rule_id, target, project_id, previous_content, new_content, previous_sha256, new_sha256, rule_ids_json, status, actor)
       VALUES (1, NULL, 'project', 'v7-test-project', 'a', 'b', 'sha-a', 'sha-b', '[]', 'written', 'test')`,
    )
    .run();
  const before = (tmpDb.prepare(`SELECT COUNT(*) n FROM knowledge_versions`).get() as { n: number })
    .n;
  assert.equal(before, 1);

  const v7 = MIGRATIONS.find((m) => m.version === 7)!;
  tmpDb.exec(v7.sql);

  const after = (tmpDb.prepare(`SELECT COUNT(*) n FROM knowledge_versions`).get() as { n: number })
    .n;
  assert.equal(after, 1, "the v7 rebuild preserves the existing row");
  const row = tmpDb.prepare(`SELECT * FROM knowledge_versions WHERE id = 1`).get() as {
    status: string;
    actor: string;
    new_sha256: string;
  };
  assert.equal(row.status, "written");
  assert.equal(row.actor, "test");
  assert.equal(row.new_sha256, "sha-b");

  // The widened CHECK genuinely accepts 'cancelled' now.
  assert.doesNotThrow(() =>
    tmpDb
      .prepare(
        `INSERT INTO knowledge_versions
           (rule_id, target, project_id, previous_content, new_content, previous_sha256, new_sha256, rule_ids_json, status, actor)
         VALUES (NULL, 'project', 'v7-test-project', 'a', 'b', 'sha-a', 'sha-b', '[]', 'cancelled', 'test')`,
      )
      .run(),
  );
  assert.throws(() =>
    tmpDb
      .prepare(
        `INSERT INTO knowledge_versions
           (rule_id, target, project_id, previous_content, new_content, previous_sha256, new_sha256, rule_ids_json, status, actor)
         VALUES (NULL, 'project', 'v7-test-project', 'a', 'b', 'sha-a', 'sha-b', '[]', 'not-a-real-status', 'test')`,
      )
      .run(),
  );

  tmpDb.close();
});

// Regression: an improvement accepted before Harness ever read the live
// Knowledge could not be composed at accept time, so nothing was staged and
// the item sat in "Waiting to be written" forever. The executor now stages it
// once a snapshot exists.
test("stageApprovedWrites stages accepted writes that had no snapshot at accept time, once", () => {
  const PROJECT2 = "improvements-test-project-2";
  db.prepare(`INSERT INTO allowed_projects (lovable_project_id, label) VALUES (?, ?)`).run(
    PROJECT2,
    "test2",
  );
  store.upsertProject({ lovable_project_id: PROJECT2, name: "Late Snapshot Project" });

  const msg = store.upsertHistoryItem({
    project_id: PROJECT2,
    kind: "message",
    external_id: "m-late-1",
    role: "user",
    content: "never touch the migrations folder",
    occurred_at: "2026-09-09T10:00:00Z",
    provenance: "lovable_mcp",
  }) as { id: number };
  const ep2 = store.createTaskEpisode({
    project_id: PROJECT2,
    title: "late snapshot episode",
    provenance: "llm_derived",
    evidence_history_item_ids: [msg.id],
  }) as { id: number };
  const cc2 = store.createCorrectionCandidate({
    task_episode_id: ep2.id,
    classification: "constraint_restatement",
    is_correction: true,
    reusable: true,
    proposed_scope: "project",
    summary: "Migrations were edited without approval. More words here.",
    evidence_history_item_ids: [msg.id],
  }) as { id: number };
  const l2 = store.createLearning({
    correction_candidate_id: cc2.id,
    observed_problem: "p",
    desired_behavior: "Do not edit migrations without approval.",
    reuse_rationale: "r",
    proposed_scope: "project",
    provenance: "llm_derived",
    created_by: "test",
  }) as { id: number };
  const rule2 = store.createRule({
    learning_id: l2.id,
    correction_candidate_id: cc2.id,
    instruction: "Never edit the migrations folder without asking first.",
    scope: "project",
    applies_when: "always",
    predicted_failure: "silent migration edits",
    ownership: "harness",
    created_by: "test",
  }) as { id: number };

  // Accepted with no snapshot of PROJECT2's Knowledge anywhere: nothing staged.
  const accepted = imp.improvementAction({ action: "accept", id: cc2.id, destination: "project" });
  assert.equal(accepted.decision.status, "accepted");
  assert.deepEqual(
    (store.listPendingKnowledgeWrites() as { rule_id: number }[]).filter(
      (w) => w.rule_id === rule2.id,
    ),
    [],
    "no snapshot means no staged write at accept time",
  );

  // The executor reads Knowledge for the first time, then stages.
  store.recordKnowledgeSnapshot({
    target: "project",
    project_id: PROJECT2,
    content: "# Knowledge\n\nProject two.",
    fetched_by: "test",
  });
  const first = imp.stageApprovedWrites();
  assert.equal(first.staged, 1);
  const staged = (
    store.listPendingKnowledgeWrites() as {
      rule_id: number;
      new_content: string;
      reason: string | null;
    }[]
  ).filter((w) => w.rule_id === rule2.id);
  assert.equal(staged.length, 1);
  assert.match(staged[0]!.new_content, /Never edit the migrations folder without asking first\./);
  assert.equal(staged[0]!.reason, "staged by the executor after Knowledge was read");

  // Idempotent: the pending write it just made stops it staging a second one.
  assert.equal(imp.stageApprovedWrites().staged, 0);
  assert.equal(
    (store.listPendingKnowledgeWrites() as { rule_id: number }[]).filter(
      (w) => w.rule_id === rule2.id,
    ).length,
    1,
  );
});

test('"Add it now" withdraws an earlier "Test it first" request, even before any Knowledge snapshot exists', () => {
  const PROJECT3 = "improvements-test-project-3";
  db.prepare(`INSERT INTO allowed_projects (lovable_project_id, label) VALUES (?, ?)`).run(
    PROJECT3,
    "test3",
  );
  store.upsertProject({ lovable_project_id: PROJECT3, name: "No Snapshot Project" });

  const msg3 = store.upsertHistoryItem({
    project_id: PROJECT3,
    kind: "message",
    external_id: "m-nosnap-1",
    role: "user",
    content: "never delete user uploads",
    occurred_at: "2026-09-10T10:00:00Z",
    provenance: "lovable_mcp",
  }) as { id: number };
  const ep3 = store.createTaskEpisode({
    project_id: PROJECT3,
    title: "no snapshot episode",
    provenance: "llm_derived",
    evidence_history_item_ids: [msg3.id],
  }) as { id: number };
  const cc3 = store.createCorrectionCandidate({
    task_episode_id: ep3.id,
    classification: "constraint_restatement",
    is_correction: true,
    reusable: true,
    proposed_scope: "project",
    summary: "User uploads were deleted without approval. More words here.",
    evidence_history_item_ids: [msg3.id],
  }) as { id: number };
  const l3 = store.createLearning({
    correction_candidate_id: cc3.id,
    observed_problem: "p",
    desired_behavior: "Do not delete user uploads without approval.",
    reuse_rationale: "r",
    proposed_scope: "project",
    provenance: "llm_derived",
    created_by: "test",
  }) as { id: number };
  const rule3 = store.createRule({
    learning_id: l3.id,
    correction_candidate_id: cc3.id,
    instruction: "Never delete user uploads without asking first.",
    scope: "project",
    applies_when: "always",
    predicted_failure: "silent data loss",
    ownership: "harness",
    created_by: "test",
  }) as { id: number };

  // No snapshot of PROJECT3's Knowledge has ever been recorded.

  // 1. "Test it first" approves the rule and its experiment plan.
  const testFirstItem = imp.improvementAction({
    action: "accept",
    id: cc3.id,
    destination: "project",
    test_first: true,
  });
  assert.equal(testFirstItem.decision.test_first, true);

  // 2. Choosing "Add it now" (a plain accept, before any snapshot exists)
  // must withdraw that test request immediately: test_first flips to
  // false right away, even though there is still no snapshot to stage a
  // pending write from.
  const plainAcceptItem = imp.improvementAction({
    action: "accept",
    id: cc3.id,
    destination: "project",
  });
  assert.equal(
    plainAcceptItem.decision.test_first,
    false,
    "plain accept withdraws the test-first request even with no snapshot",
  );
  assert.deepEqual(
    (store.listPendingKnowledgeWrites() as { rule_id: number }[]).filter(
      (w) => w.rule_id === rule3.id,
    ),
    [],
    "still no snapshot to stage a write from",
  );
  const plans3 = store.listExperimentPlansForRule(rule3.id) as { plan: { status: string } }[];
  assert.equal(
    plans3[0]!.plan.status,
    "proposed",
    "the experiment plan is put back to proposed, not left approved",
  );

  // 3. Once a snapshot exists, the executor's next sync picks the item up.
  store.recordKnowledgeSnapshot({
    target: "project",
    project_id: PROJECT3,
    content: "# Knowledge\n\nProject three.",
    fetched_by: "test",
  });
  const result = imp.stageApprovedWrites();
  assert.equal(result.staged, 1);
  const staged3 = (store.listPendingKnowledgeWrites() as { rule_id: number }[]).filter(
    (w) => w.rule_id === rule3.id,
  );
  assert.equal(staged3.length, 1, "exactly one pending write is staged for the rule");
});

test("plain accept on an item that was never test-first does not throw when no experiment plan exists", () => {
  const PROJECT4 = "improvements-test-project-4";
  db.prepare(`INSERT INTO allowed_projects (lovable_project_id, label) VALUES (?, ?)`).run(
    PROJECT4,
    "test4",
  );
  store.upsertProject({ lovable_project_id: PROJECT4, name: "Never Test First Project" });

  const msg4 = store.upsertHistoryItem({
    project_id: PROJECT4,
    kind: "message",
    external_id: "m-plain-1",
    role: "user",
    content: "always confirm before sending emails",
    occurred_at: "2026-09-10T10:00:00Z",
    provenance: "lovable_mcp",
  }) as { id: number };
  const ep4 = store.createTaskEpisode({
    project_id: PROJECT4,
    title: "plain accept episode",
    provenance: "llm_derived",
    evidence_history_item_ids: [msg4.id],
  }) as { id: number };
  const cc4 = store.createCorrectionCandidate({
    task_episode_id: ep4.id,
    classification: "constraint_restatement",
    is_correction: true,
    reusable: true,
    proposed_scope: "project",
    summary: "Emails were sent without confirmation. More words here.",
    evidence_history_item_ids: [msg4.id],
  }) as { id: number };
  const l4 = store.createLearning({
    correction_candidate_id: cc4.id,
    observed_problem: "p",
    desired_behavior: "Always confirm before sending emails.",
    reuse_rationale: "r",
    proposed_scope: "project",
    provenance: "llm_derived",
    created_by: "test",
  }) as { id: number };
  store.createRule({
    learning_id: l4.id,
    correction_candidate_id: cc4.id,
    instruction: "Always confirm before sending emails.",
    scope: "project",
    applies_when: "always",
    predicted_failure: "unwanted emails sent",
    ownership: "harness",
    created_by: "test",
  }) as { id: number };

  assert.doesNotThrow(() => {
    const accepted = imp.improvementAction({
      action: "accept",
      id: cc4.id,
      destination: "project",
    });
    assert.equal(accepted.decision.test_first, false);
  });
});

test("a restored Knowledge version reads as reverted, never as written (added)", () => {
  const PROJECT5 = "improvements-test-project-5";
  db.prepare(`INSERT INTO allowed_projects (lovable_project_id, label) VALUES (?, ?)`).run(
    PROJECT5,
    "test5",
  );
  store.upsertProject({ lovable_project_id: PROJECT5, name: "Restore Test Project" });

  const msg5 = store.upsertHistoryItem({
    project_id: PROJECT5,
    kind: "message",
    external_id: "m-restore-1",
    role: "user",
    content: "never skip the review step",
    occurred_at: "2026-09-10T10:00:00Z",
    provenance: "lovable_mcp",
  }) as { id: number };
  const ep5 = store.createTaskEpisode({
    project_id: PROJECT5,
    title: "restore episode",
    provenance: "llm_derived",
    evidence_history_item_ids: [msg5.id],
  }) as { id: number };
  const cc5 = store.createCorrectionCandidate({
    task_episode_id: ep5.id,
    classification: "constraint_restatement",
    is_correction: true,
    reusable: true,
    proposed_scope: "project",
    summary: "The review step was skipped without approval. More words here.",
    evidence_history_item_ids: [msg5.id],
  }) as { id: number };
  const l5 = store.createLearning({
    correction_candidate_id: cc5.id,
    observed_problem: "p",
    desired_behavior: "Never skip the review step.",
    reuse_rationale: "r",
    proposed_scope: "project",
    provenance: "llm_derived",
    created_by: "test",
  }) as { id: number };
  const rule5 = store.createRule({
    learning_id: l5.id,
    correction_candidate_id: cc5.id,
    instruction: "Never skip the review step without asking first.",
    scope: "project",
    applies_when: "always",
    predicted_failure: "unreviewed changes shipped",
    ownership: "harness",
    created_by: "test",
  }) as { id: number };

  // 1. Accept with a snapshot already present, so the write stages
  // immediately (same pattern as the switching-to-test_first test above).
  store.recordKnowledgeSnapshot({
    target: "project",
    project_id: PROJECT5,
    content: "# Knowledge\n\nProject five.",
    fetched_by: "test",
  });
  imp.improvementAction({ action: "accept", id: cc5.id, destination: "project" });
  const staged5 = (
    store.listPendingKnowledgeWrites() as { id: number; rule_id: number; new_content: string }[]
  ).filter((w) => w.rule_id === rule5.id);
  assert.equal(staged5.length, 1, "the accept stages exactly one pending write");

  // 2. Simulate the executor: it writes to Lovable, then reads back and
  // verifies -- recordKnowledgeReadback marks the version written.
  store.recordKnowledgeReadback(staged5[0]!.id, staged5[0]!.new_content);
  const written5 = imp.getImprovement(cc5.id)!;
  assert.equal(written5.lovable.write_status, "written");
  assert.equal(
    improvementGroup({
      status: written5.decision.status,
      writeStatus: written5.lovable.write_status,
      testFirst: written5.decision.test_first,
    }),
    "In Lovable",
  );

  // 3. The user restores that version: a new pending write whose content
  // undoes it. The executor writes and verifies it the same way.
  const restoreVersion = store.createRestoreVersion(staged5[0]!.id, "test") as {
    id: number;
    new_content: string;
  };
  store.recordKnowledgeReadback(restoreVersion.id, restoreVersion.new_content);

  const reverted5 = imp.getImprovement(cc5.id)!;
  assert.equal(
    reverted5.lovable.write_status,
    "reverted",
    "a written restore must never read as plain 'written'",
  );
  assert.equal(
    improvementGroup({
      status: reverted5.decision.status,
      writeStatus: reverted5.lovable.write_status,
      testFirst: reverted5.decision.test_first,
    }),
    "Reverted",
  );
  assert.match(lovableStatusLine(reverted5.lovable), /^Reverted to an earlier version/);
});

test("lovable.auto_write reflects the project's setting (Round 3 §5): defaults true, flips with the override", () => {
  assert.equal(
    store.getProjectSettings(PROJECT).auto_write,
    true,
    "no override yet -- default is on",
  );
  assert.equal(imp.getImprovement(cc.id)!.lovable.auto_write, true);

  store.setProjectSettings(PROJECT, { auto_write: false });
  assert.equal(imp.getImprovement(cc.id)!.lovable.auto_write, false);

  // restore, so this project's setting is untouched for any test that runs after this one
  store.setProjectSettings(PROJECT, { auto_write: true });
  assert.equal(imp.getImprovement(cc.id)!.lovable.auto_write, true);
});

// ---- Round 5 Task 3: buildTimeline + verdict action ----

function mkRule(input: {
  project: string;
  externalIdPrefix: string;
  content: string;
  summary: string;
  desired: string;
  instruction: string;
  scope: "project" | "workspace";
}) {
  const msg = store.upsertHistoryItem({
    project_id: input.project,
    kind: "message",
    external_id: `${input.externalIdPrefix}-1`,
    role: "user",
    content: input.content,
    occurred_at: "2026-09-01T00:00:00Z",
    provenance: "lovable_mcp",
  }) as { id: number };
  const ep = store.createTaskEpisode({
    project_id: input.project,
    title: input.externalIdPrefix,
    provenance: "llm_derived",
    evidence_history_item_ids: [msg.id],
  }) as { id: number };
  const cc = store.createCorrectionCandidate({
    task_episode_id: ep.id,
    classification: "constraint_restatement",
    is_correction: true,
    reusable: true,
    proposed_scope: input.scope,
    summary: input.summary,
    evidence_history_item_ids: [msg.id],
  }) as { id: number };
  const learning = store.createLearning({
    correction_candidate_id: cc.id,
    observed_problem: "p",
    desired_behavior: input.desired,
    reuse_rationale: "r",
    proposed_scope: input.scope,
    provenance: "llm_derived",
    created_by: "test",
  }) as { id: number };
  const rule = store.createRule({
    learning_id: learning.id,
    correction_candidate_id: cc.id,
    instruction: input.instruction,
    scope: input.scope,
    applies_when: "always",
    predicted_failure: "x",
    ownership: "harness",
    created_by: "test",
  }) as { id: number };
  return { cc, rule, ep };
}

function setAt(table: string, column: string, id: number, at: string) {
  db.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`).run(at, id);
}

// buildTimeline's diff shape adds `truncated` on top of the raw lineDiff
// helper's {added, removed, lines} -- wrap the expected value the same way.
function expectedDiff(before: string, after: string) {
  return { ...adapterLineDiff(before, after), truncated: false };
}

test("buildTimeline: a target with 3 versions (one a restore) + 1 external change + 1 accepted + 1 skipped + 1 verdict, ordered newest first with the right labels/content/diff/restorable", () => {
  const TL_PROJECT = "timeline-test-project";
  db.prepare(`INSERT INTO allowed_projects (lovable_project_id, label) VALUES (?, ?)`).run(
    TL_PROJECT,
    "tl",
  );
  store.upsertProject({ lovable_project_id: TL_PROJECT, name: "Timeline Project" });

  const a = mkRule({
    project: TL_PROJECT,
    externalIdPrefix: "tl-a",
    content: "always run migrations manually",
    summary: "Migrations were run automatically. More words here for length.",
    desired: "Never run migrations automatically.",
    instruction: "Never run migrations automatically.",
    scope: "project",
  });
  const b = mkRule({
    project: TL_PROJECT,
    externalIdPrefix: "tl-b",
    content: "do not touch the billing code",
    summary: "Billing code was touched without approval. More words here.",
    desired: "Never touch billing code without approval.",
    instruction: "Never touch billing code without approval.",
    scope: "project",
  });

  // 1 accepted (no snapshot exists yet, so nothing auto-stages).
  imp.improvementAction({ action: "accept", id: a.cc.id, destination: "project" });
  // 1 skipped.
  imp.improvementAction({ action: "skip", id: b.cc.id });
  setAt("correction_candidates", "reviewed_at", a.cc.id, "2026-09-01 10:00:00");
  setAt("correction_candidates", "reviewed_at", b.cc.id, "2026-09-01 11:00:00");

  const BASELINE = "# Knowledge\n\nBaseline.";
  const V1_CONTENT = "# Knowledge\n\nBaseline.\n\n- Never run migrations automatically.";
  const V2_CONTENT = V1_CONTENT + "\n- One more line.";

  // v1: written, carries both rules (so the skipped rule b is still "a rule
  // with a version for the target", per buildTimeline's rule-union).
  const v1 = store.createPendingKnowledgeVersion({
    rule_id: a.rule.id,
    target: "project",
    project_id: TL_PROJECT,
    previous_content: BASELINE,
    new_content: V1_CONTENT,
    rule_ids: [a.rule.id, b.rule.id],
    actor: "operator (local UI)",
  }) as { id: number };
  store.recordKnowledgeReadback(v1.id, V1_CONTENT);
  setAt("knowledge_versions", "created_at", v1.id, "2026-09-01 12:00:00");
  setAt("knowledge_versions", "written_at", v1.id, "2026-09-01 12:00:00");

  // v2: written, a plain edit.
  const v2 = store.createPendingKnowledgeVersion({
    rule_id: a.rule.id,
    target: "project",
    project_id: TL_PROJECT,
    previous_content: V1_CONTENT,
    new_content: V2_CONTENT,
    rule_ids: [a.rule.id],
    actor: "operator (local UI)",
  }) as { id: number };
  store.recordKnowledgeReadback(v2.id, V2_CONTENT);
  setAt("knowledge_versions", "created_at", v2.id, "2026-09-01 13:00:00");
  setAt("knowledge_versions", "written_at", v2.id, "2026-09-01 13:00:00");

  // A snapshot matching v1's own content: NOT an external change (it's just
  // our own write being read back on the next sync).
  store.recordKnowledgeSnapshot({
    target: "project",
    project_id: TL_PROJECT,
    content: V1_CONTENT,
    fetched_by: "test",
  });
  // A snapshot that genuinely differs, from neither v1 nor v2's content: IS
  // an external change.
  const EXTERNAL_CONTENT = V1_CONTENT + "\n\nSomeone typed this directly in Lovable.";
  store.recordKnowledgeSnapshot({
    target: "project",
    project_id: TL_PROJECT,
    content: EXTERNAL_CONTENT,
    fetched_by: "test",
  });
  const snapshots = store.listKnowledgeSnapshots("project", TL_PROJECT) as { id: number }[];
  setAt("knowledge_snapshots", "fetched_at", snapshots[0]!.id, "2026-09-01 14:00:00"); // matches v1, not flagged (nothing precedes it)
  setAt("knowledge_snapshots", "fetched_at", snapshots[1]!.id, "2026-09-01 15:00:00"); // flagged: differs from the previous snapshot and from every version

  // v3: a restore of v1.
  const v3 = store.createRestoreVersion(v1.id, "operator (local UI)") as {
    id: number;
    new_content: string;
  };
  store.recordKnowledgeReadback(v3.id, v3.new_content);
  setAt("knowledge_versions", "created_at", v3.id, "2026-09-01 16:00:00");
  setAt("knowledge_versions", "written_at", v3.id, "2026-09-01 16:00:00");

  // 1 verdict.
  const verdict = store.recordRuleVerdict({ rule_id: a.rule.id, verdict: "keep" }) as {
    id: number;
  };
  setAt("rule_verdicts", "created_at", verdict.id, "2026-09-01 17:00:00");

  const nodes = imp.buildTimeline("project", TL_PROJECT);
  assert.equal(
    nodes.length,
    7,
    "3 versions + 1 external change + 1 accepted + 1 skipped + 1 verdict",
  );
  assert.deepEqual(
    nodes.map((n) => n.kind),
    ["verdict", "version", "external_change", "version", "version", "decision", "decision"],
  );

  const [nVerdict, nV3, nExternal, nV2, nV1, nSkip, nAccept] = nodes;

  // Round 9 final wave item 9: VERDICT_LABEL says "instruction", not "rule".
  assert.equal(nVerdict!.label, "You said to keep this instruction");
  assert.equal(nVerdict!.actor, "you");
  assert.equal(nVerdict!.content, "Never run migrations automatically.");
  assert.equal(nVerdict!.summary, "Never run migrations automatically.");
  assert.equal(nVerdict!.improvement_id, a.cc.id);
  assert.deepEqual(nVerdict!.rule_ids, [a.rule.id]);
  assert.equal(nVerdict!.diff, null);

  assert.equal(nV3!.label, `Restored Knowledge from version ${v1.id}`);
  assert.equal(nV3!.restored_from_version_id, v1.id);
  assert.ok(Array.isArray(nV3!.rules_added) && Array.isArray(nV3!.rules_removed));
  assert.equal(nV3!.content, v3.new_content);
  assert.equal(nV3!.version_id, v3.id);
  assert.equal(nV3!.restored_from, v1.id);
  // Round 7: the newest change can be undone ("Undo this change").
  assert.equal(nV3!.restorable, true, "the newest written version can be undone");
  assert.equal(nV3!.latest_version, true);
  assert.deepEqual(nV3!.diff, expectedDiff(V2_CONTENT, v3.new_content));

  assert.equal(nExternal!.label, "Changed in Lovable (outside Harness Ledger)");
  assert.equal(nExternal!.actor, "lovable");
  assert.equal(nExternal!.content, EXTERNAL_CONTENT);
  assert.equal(nExternal!.diff, null);

  assert.equal(nV2!.label, "Written to Lovable");
  assert.equal(nV2!.content, V2_CONTENT);
  assert.equal(nV2!.version_id, v2.id);
  assert.equal(nV2!.restored_from, null);
  assert.equal(nV2!.restorable, true, "an older written version is restorable");
  assert.equal(nV2!.latest_version, false, "older versions read 'Go back to before this change'");
  assert.deepEqual(nV2!.diff, expectedDiff(V1_CONTENT, V2_CONTENT));

  assert.equal(nV1!.label, "Written to Lovable");
  assert.equal(nV1!.content, V1_CONTENT);
  assert.equal(nV1!.version_id, v1.id);
  assert.equal(nV1!.restorable, true, "an older written version is restorable");
  assert.equal(
    nV1!.diff,
    null,
    "no earlier version node exists to diff the very first version against",
  );
  assert.deepEqual(nV1!.rule_ids, [a.rule.id, b.rule.id]);

  assert.equal(nSkip!.label, "You skipped");
  assert.equal(nSkip!.actor, "you");
  assert.equal(nSkip!.improvement_id, b.cc.id);
  assert.deepEqual(nSkip!.rule_ids, [b.rule.id]);

  assert.equal(nAccept!.label, "You accepted");
  assert.equal(nAccept!.actor, "you");
  assert.equal(nAccept!.improvement_id, a.cc.id);
  assert.deepEqual(nAccept!.rule_ids, [a.rule.id]);

  // Every node id is unique.
  assert.equal(new Set(nodes.map((n) => n.id)).size, nodes.length);
});

// Round 6 Task 5 review (addendum picked up while fixing Task 3): a demo
// Knowledge snapshot (fetched_by = 'demo') must never surface on the
// History page as "Changed in Lovable (outside Harness)" for a real
// target, and must not silently become "the previous snapshot" a later
// real one is compared against either -- buildTimeline's own
// external_change detection now filters demo snapshots out of the
// sequence entirely before doing either comparison.
test("buildTimeline: a demo snapshot never produces an external_change node, and is not counted as 'the previous snapshot' for the real one that follows it", () => {
  const project = "improvements-test-timeline-demo-snapshot";
  db.prepare(`INSERT INTO allowed_projects (lovable_project_id, label) VALUES (?, ?)`).run(
    project,
    "test",
  );
  store.upsertProject({ lovable_project_id: project, name: "Timeline Demo Snapshot Project" });

  const REAL_CONTENT = "# Knowledge\n\nReal content.";
  store.recordKnowledgeSnapshot({
    target: "project",
    project_id: project,
    content: REAL_CONTENT,
    fetched_by: "test",
  });

  // A demo snapshot, newer, that genuinely differs from the real one.
  const DEMO_CONTENT = `${REAL_CONTENT}\n\n- Demo: always do something fake.`;
  store.recordKnowledgeSnapshot({
    target: "project",
    project_id: project,
    content: DEMO_CONTENT,
    fetched_by: "demo",
  });

  assert.equal(
    imp.buildTimeline("project", project).filter((n) => n.kind === "external_change").length,
    0,
    "a demo snapshot must never surface as an external Lovable change",
  );

  // A later REAL snapshot identical to the first real one (Lovable's actual
  // Knowledge never changed) must not be flagged either -- if the demo
  // snapshot had counted as "the previous one" in the comparison, this
  // would wrongly read as a change back to the earlier text.
  store.recordKnowledgeSnapshot({
    target: "project",
    project_id: project,
    content: REAL_CONTENT,
    fetched_by: "test",
  });
  assert.equal(
    imp.buildTimeline("project", project).filter((n) => n.kind === "external_change").length,
    0,
    "the demo snapshot must not count as the 'previous' real snapshot either",
  );
});

test("buildTimeline: an automatically-accepted candidate reads 'Accepted automatically (confidence 0.86)'", () => {
  const TL_PROJECT2 = "timeline-test-project-auto";
  db.prepare(`INSERT INTO allowed_projects (lovable_project_id, label) VALUES (?, ?)`).run(
    TL_PROJECT2,
    "tl2",
  );
  store.upsertProject({ lovable_project_id: TL_PROJECT2, name: "Timeline Auto Project" });

  const msg = store.upsertHistoryItem({
    project_id: TL_PROJECT2,
    kind: "message",
    external_id: "tl-auto-1",
    role: "user",
    content: "never send marketing emails without approval",
    occurred_at: "2026-09-01T00:00:00Z",
    provenance: "lovable_mcp",
  }) as { id: number };
  const ep = store.createTaskEpisode({
    project_id: TL_PROJECT2,
    title: "auto episode",
    provenance: "llm_derived",
    evidence_history_item_ids: [msg.id],
  }) as { id: number };
  const cc = store.createCorrectionCandidate({
    task_episode_id: ep.id,
    classification: "constraint_restatement",
    is_correction: true,
    reusable: true,
    proposed_scope: "project",
    summary: "Marketing emails were sent without approval. More words here.",
    confidence: 0.864,
    evidence_history_item_ids: [msg.id],
  }) as { id: number };
  const learning = store.createLearning({
    correction_candidate_id: cc.id,
    observed_problem: "p",
    desired_behavior: "Never send marketing emails without approval.",
    reuse_rationale: "r",
    proposed_scope: "project",
    provenance: "llm_derived",
    created_by: "test",
  }) as { id: number };
  store.createRule({
    learning_id: learning.id,
    correction_candidate_id: cc.id,
    instruction: "Never send marketing emails without approval.",
    scope: "project",
    applies_when: "always",
    predicted_failure: "x",
    ownership: "harness",
    created_by: "test",
  });

  imp.improvementAction({ action: "accept", id: cc.id, destination: "project" });
  store.setCandidateDecidedBy(cc.id, "automatic");

  const nodes = imp.buildTimeline("project", TL_PROJECT2);
  const accepted = nodes.find((n) => n.kind === "decision");
  assert.ok(accepted, "an accepted decision node exists");
  assert.equal(accepted!.label, "Accepted automatically (confidence 0.86)");
  assert.equal(accepted!.actor, "harness");
});

test("buildTimeline: retire_proposals create 'Harness Ledger suggested retiring' + 'You retired'/'You kept it', and a re-add shows 'Re-added'", () => {
  const TL_PROJECT3 = "timeline-test-project-retire";
  db.prepare(`INSERT INTO allowed_projects (lovable_project_id, label) VALUES (?, ?)`).run(
    TL_PROJECT3,
    "tl3",
  );
  store.upsertProject({ lovable_project_id: TL_PROJECT3, name: "Timeline Retire Project" });

  const r = mkRule({
    project: TL_PROJECT3,
    externalIdPrefix: "tl-retire",
    content: "always cache API responses",
    summary: "API responses were cached without approval. More words here.",
    desired: "Never cache API responses by default.",
    instruction: "Never cache API responses by default.",
    scope: "project",
  });
  imp.improvementAction({ action: "accept", id: r.cc.id, destination: "project" });

  const proposal = store.createRetireProposal({
    rule_id: r.rule.id,
    reason: "unused",
    evidence: [],
  });
  store.decideRetireProposal(proposal.id, "retired");
  imp.improvementAction({ action: "readd", id: r.cc.id });

  const nodes = imp.buildTimeline("project", TL_PROJECT3);
  const labels = nodes.map((n) => n.label);
  assert.ok(labels.includes("Harness Ledger suggested retiring"), labels.join(", "));
  assert.ok(labels.includes("You retired"), labels.join(", "));
  assert.ok(labels.includes("Re-added"), labels.join(", "));
  for (const n of nodes) {
    if (n.kind === "decision") assert.deepEqual(n.rule_ids, [r.rule.id]);
  }
});

// Fix round 1: listEventsForRecord's `payload LIKE '%"id":<id>%'` is a
// substring match -- rule 3's lookup also matches a "rule.readded" event
// whose payload is {"id":30} (or 300, 31, ...), since "id":3 is a literal
// substring of "id":30. listReaddEventsForRule uses an exact json_extract
// match instead. Ids chosen far apart from any this file's shared DB could
// otherwise produce, so this can't collide with a real rule's own readd.
test("store.listReaddEventsForRule: exact id match, never a payload substring match", () => {
  store.insertEvent("rule.readded", null, { id: 500003 });
  store.insertEvent("rule.readded", null, { id: 500030 });
  store.insertEvent("rule.readded", null, { id: 500300 });
  store.insertEvent("rule.readded", null, { id: 500031 });

  const forShort = store.listReaddEventsForRule(500003);
  assert.equal(forShort.length, 1, "must match only the exact id, not 500030/500300/500031");

  const forLong = store.listReaddEventsForRule(500030);
  assert.equal(forLong.length, 1, "must match only the exact id 500030");
});

test("buildTimeline: 'Re-added' is attributed to the exact rule id, not a substring (rule 3 vs rule 30)", () => {
  const TL_PROJECT_READD_EXACT = "timeline-test-project-readd-exact";
  db.prepare(`INSERT INTO allowed_projects (lovable_project_id, label) VALUES (?, ?)`).run(
    TL_PROJECT_READD_EXACT,
    "tl-readd-exact",
  );
  store.upsertProject({
    lovable_project_id: TL_PROJECT_READD_EXACT,
    name: "Timeline Re-add Exact Project",
  });

  // rule_ids_json carries no foreign key, so this puts literal ids 3 and 30
  // into buildTimeline's per-target rule set without needing 30 real rows
  // in the rules table.
  store.recordKnowledgeSnapshot({
    target: "project",
    project_id: TL_PROJECT_READD_EXACT,
    content: "# Knowledge\n\nBaseline.",
    fetched_by: "test",
  });
  const v = store.createPendingKnowledgeVersion({
    rule_id: null,
    target: "project",
    project_id: TL_PROJECT_READD_EXACT,
    previous_content: "# Knowledge\n\nBaseline.",
    new_content: "# Knowledge\n\nBaseline.\n\n- rule 3.\n- rule 30.",
    rule_ids: [3, 30],
    actor: "test",
  }) as { id: number; new_content: string };
  store.recordKnowledgeReadback(v.id, v.new_content);

  // Only rule 30 is re-added.
  store.insertEvent("rule.readded", null, { id: 30 });

  const nodes = imp.buildTimeline("project", TL_PROJECT_READD_EXACT);
  const readdNodesFor = (ruleId: number) =>
    nodes.filter((n) => n.label === "Re-added" && n.rule_ids.includes(ruleId));

  assert.equal(readdNodesFor(3).length, 0, "rule 3 must not see rule 30's re-add event");
  assert.equal(readdNodesFor(30).length, 1, "rule 30 sees its own re-add event");
});

test("buildTimeline: a workspace timeline includes two skill snapshots for the same name, the second carrying a diff against the first", () => {
  const TL_WORKSPACE = "timeline-test-workspace";
  const first = store.recordSkillSnapshot({
    workspace_id: TL_WORKSPACE,
    name: "release-checklist",
    description: "d",
    content: "1. Build\n2. Test",
    updated_at_remote: null,
    fetched_by: "test",
  }) as { id: number };
  const second = store.recordSkillSnapshot({
    workspace_id: TL_WORKSPACE,
    name: "release-checklist",
    description: "d",
    content: "1. Build\n2. Test\n3. Deploy",
    updated_at_remote: null,
    fetched_by: "test",
  }) as { id: number };
  setAt("skill_snapshots", "fetched_at", first.id, "2026-09-01 09:00:00");
  setAt("skill_snapshots", "fetched_at", second.id, "2026-09-01 10:00:00");

  const nodes = imp.buildTimeline("workspace", TL_WORKSPACE);
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0]!.kind, "skill");
  assert.equal(nodes[0]!.label, "Skill release-checklist changed");
  assert.equal(nodes[0]!.content, "1. Build\n2. Test\n3. Deploy");
  assert.deepEqual(
    nodes[0]!.diff,
    expectedDiff("1. Build\n2. Test", "1. Build\n2. Test\n3. Deploy"),
  );
  assert.equal(nodes[1]!.label, "Skill release-checklist first read");
  assert.equal(nodes[1]!.diff, null);
  assert.equal(nodes[1]!.content, "1. Build\n2. Test");
});

test("buildTimeline: caps at 200 nodes", () => {
  const TL_WORKSPACE_MANY = "timeline-test-workspace-many";
  for (let i = 0; i < 210; i += 1) {
    const row = store.recordSkillSnapshot({
      workspace_id: TL_WORKSPACE_MANY,
      name: `skill-${i}`,
      description: null,
      content: `content ${i}`,
      updated_at_remote: null,
      fetched_by: "test",
    }) as { id: number };
    setAt(
      "skill_snapshots",
      "fetched_at",
      row.id,
      `2026-09-01 09:${String(i % 60).padStart(2, "0")}:00`,
    );
  }
  const nodes = imp.buildTimeline("workspace", TL_WORKSPACE_MANY);
  assert.equal(nodes.length, 200);
});

test("verdict action: records the row; did_not_help feeds rule_health.hurt through recomputeRuleHealth, only when evidence_sources.verdicts is enabled, and only on an existing row (Round 5 fix wave item 1: derived, not mutated)", () => {
  const TL_PROJECT4 = "timeline-test-project-verdict";
  db.prepare(`INSERT INTO allowed_projects (lovable_project_id, label) VALUES (?, ?)`).run(
    TL_PROJECT4,
    "tl4",
  );
  store.upsertProject({ lovable_project_id: TL_PROJECT4, name: "Timeline Verdict Project" });

  const c = mkRule({
    project: TL_PROJECT4,
    externalIdPrefix: "tl-verdict-c",
    content: "always retry failed jobs forever",
    summary: "Failed jobs were retried forever without approval. More words.",
    desired: "Do not retry failed jobs forever.",
    instruction: "Do not retry failed jobs forever.",
    scope: "project",
  });
  // Make rule c genuinely live (active, with a written, backdated Knowledge
  // version) -- the verdict action now calls recomputeRuleHealth
  // internally (Round 5 fix wave item 1), which only ever touches rules
  // store.listLiveRulesWithTargets returns, not whatever a plain "accept"
  // alone leaves (state 'approved', a still-pending write). Backdated well
  // clear of the verdict recorded below (real "now"), and well inside the
  // default 60-day rule_unused_after_days window.
  store.updateRule({ id: c.rule.id, state: "active", actor: "test" });
  db.prepare(
    `INSERT INTO knowledge_versions
       (rule_id, target, project_id, previous_content, new_content, previous_sha256, new_sha256, rule_ids_json, status, actor, written_at)
     VALUES (?, 'project', ?, '', '', '', '', '[]', 'written', 'test', ?)`,
  ).run(c.rule.id, TL_PROJECT4, "2026-09-01T00:00:00.000Z");

  // Seed a real rule_health row via the same recompute the verdict action
  // now uses -- rule c has no episodes at all, so it starts at all zeros.
  recomputeRuleHealth();
  assert.equal(store.getRuleHealth(c.rule.id)!.hurt, 0, "no episodes yet, so hurt starts at 0");

  assert.equal(store.getEvidenceSources().verdicts, true, "default has verdicts enabled");
  const result = imp.improvementAction({
    action: "verdict",
    rule_id: c.rule.id,
    verdict: "review",
    note: "broke the build",
  });
  assert.equal(result.id, c.cc.id);
  assert.equal(
    store.getRuleHealth(c.rule.id)!.hurt,
    1,
    "hurt+1 immediately -- the action records the verdict and recomputes rule_health, which reads it back",
  );
  const verdicts = store.listRuleVerdicts(c.rule.id);
  assert.equal(verdicts[0]!.verdict, "review");
  assert.equal(verdicts[0]!.note, "broke the build");

  // A later, unrelated recompute (an executor sync, an analysis run) does
  // not lose the verdict-driven hurt -- it is a derived input, not a
  // one-off mutation the next recompute would overwrite.
  recomputeRuleHealth();
  assert.equal(
    store.getRuleHealth(c.rule.id)!.hurt,
    1,
    "the verdict-driven hurt survives an unrelated later recompute",
  );

  // Disable verdicts evidence: a second did_not_help must not bump hurt again.
  store.setSettings({
    evidence_sources: JSON.stringify({
      observed: true,
      adherence: true,
      verdicts: false,
      paired: false,
    }),
  });
  imp.improvementAction({ action: "verdict", rule_id: c.rule.id, verdict: "review" });
  assert.equal(
    store.getRuleHealth(c.rule.id)!.hurt,
    1,
    "hurt does not bump while verdicts evidence is disabled",
  );
  store.setSettings({
    evidence_sources: JSON.stringify({
      observed: true,
      adherence: true,
      verdicts: true,
      paired: false,
    }),
  });

  // A rule with no rule_health row yet: did_not_help records the verdict but
  // triggers no recompute, so it creates no row (only bumps "the existing row").
  const d = mkRule({
    project: TL_PROJECT4,
    externalIdPrefix: "tl-verdict-d",
    content: "always disable auth in dev",
    summary: "Auth was disabled in dev without approval. More words here.",
    desired: "Never disable auth, even in dev.",
    instruction: "Never disable auth, even in dev.",
    scope: "project",
  });
  imp.improvementAction({ action: "accept", id: d.cc.id, destination: "project" });
  imp.improvementAction({ action: "verdict", rule_id: d.rule.id, verdict: "review" });
  assert.equal(
    store.getRuleHealth(d.rule.id),
    null,
    "no rule_health row is created just to record a verdict",
  );
});

test("verdict action: helped snoozes for 30 days only when the rule's current health status is retire_suggested", () => {
  const TL_PROJECT5 = "timeline-test-project-helped";
  db.prepare(`INSERT INTO allowed_projects (lovable_project_id, label) VALUES (?, ?)`).run(
    TL_PROJECT5,
    "tl5",
  );
  store.upsertProject({ lovable_project_id: TL_PROJECT5, name: "Timeline Helped Project" });

  const e = mkRule({
    project: TL_PROJECT5,
    externalIdPrefix: "tl-helped-e",
    content: "always log full request bodies",
    summary: "Full request bodies were logged without approval. More words.",
    desired: "Never log full request bodies.",
    instruction: "Never log full request bodies.",
    scope: "project",
  });
  imp.improvementAction({ action: "accept", id: e.cc.id, destination: "project" });
  store.upsertRuleHealth({
    rule_id: e.rule.id,
    applicable_tasks: 5,
    helped: 0,
    hurt: 4,
    last_applicable_at: null,
    contradicted_by_rule_id: null,
    unused_since: null,
    status: "retire_suggested",
    snoozed_until: null,
  });

  imp.improvementAction({ action: "verdict", rule_id: e.rule.id, verdict: "keep" });
  const health = store.getRuleHealth(e.rule.id)!;
  assert.equal(health.status, "snoozed");
  assert.ok(health.snoozed_until, "snoozed_until is set");
  const days = (new Date(health.snoozed_until!).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
  assert.ok(days > 29 && days <= 30, `expected ~30 days out, got ${days}`);

  const f = mkRule({
    project: TL_PROJECT5,
    externalIdPrefix: "tl-helped-f",
    content: "always skip code review for hotfixes",
    summary: "Code review was skipped for a hotfix without approval. Words.",
    desired: "Never skip code review, even for hotfixes.",
    instruction: "Never skip code review, even for hotfixes.",
    scope: "project",
  });
  imp.improvementAction({ action: "accept", id: f.cc.id, destination: "project" });
  store.upsertRuleHealth({
    rule_id: f.rule.id,
    applicable_tasks: 5,
    helped: 4,
    hurt: 0,
    last_applicable_at: null,
    contradicted_by_rule_id: null,
    unused_since: null,
    status: "healthy",
    snoozed_until: null,
  });
  imp.improvementAction({ action: "verdict", rule_id: f.rule.id, verdict: "keep" });
  const healthF = store.getRuleHealth(f.rule.id)!;
  assert.equal(
    healthF.status,
    "healthy",
    "a healthy rule is not snoozed just because the user said it helped",
  );
  assert.equal(healthF.snoozed_until, null);
});

test("verdict action: not_sure just records the verdict, no rule_health side effects", () => {
  const TL_PROJECT6 = "timeline-test-project-notsure";
  db.prepare(`INSERT INTO allowed_projects (lovable_project_id, label) VALUES (?, ?)`).run(
    TL_PROJECT6,
    "tl6",
  );
  store.upsertProject({ lovable_project_id: TL_PROJECT6, name: "Timeline Not Sure Project" });

  const g = mkRule({
    project: TL_PROJECT6,
    externalIdPrefix: "tl-notsure-g",
    content: "always use the staging database in tests",
    summary: "The staging database was used in tests without approval. Words.",
    desired: "Never use the staging database in tests.",
    instruction: "Never use the staging database in tests.",
    scope: "project",
  });
  imp.improvementAction({ action: "accept", id: g.cc.id, destination: "project" });
  store.upsertRuleHealth({
    rule_id: g.rule.id,
    applicable_tasks: 2,
    helped: 1,
    hurt: 0,
    last_applicable_at: null,
    contradicted_by_rule_id: null,
    unused_since: null,
    status: "watch",
    snoozed_until: null,
  });
  const result = imp.improvementAction({
    action: "verdict",
    rule_id: g.rule.id,
    verdict: "not_sure",
  });
  assert.equal(result.id, g.cc.id);
  const health = store.getRuleHealth(g.rule.id)!;
  assert.equal(health.status, "watch");
  assert.equal(health.hurt, 0);
  assert.equal(store.listRuleVerdicts(g.rule.id)[0]!.verdict, "not_sure");
});

// ---- Round 5 Task 5: unsure / rank / skip reason ----

// Like mkRule above, but gives a rule-writer-shaped candidate: a `confidence`
// on the candidate, `created_by` ending "(rule writer)" on its rule (so
// isAnalysisCreated treats it as mined), and (optionally) the raw
// classify_correction/role=rule_writer agent_actions row propose.ts itself
// writes -- the only place duplicate_of_rule_id/contradicts_rule_id survive
// per-candidate (see ruleWriterOutput's doc comment in improvements.ts).
function mkMinedCandidate(input: {
  project: string;
  externalIdPrefix: string;
  content: string;
  summary: string;
  instruction: string;
  scope: "project" | "workspace";
  confidence: number | null;
  structuredOutput?: { duplicate_of_rule_id: number | null; contradicts_rule_id: number | null };
}) {
  const msg = store.upsertHistoryItem({
    project_id: input.project,
    kind: "message",
    external_id: `${input.externalIdPrefix}-1`,
    role: "user",
    content: input.content,
    occurred_at: "2026-09-01T00:00:00Z",
    provenance: "lovable_mcp",
  }) as { id: number };
  const ep = store.createTaskEpisode({
    project_id: input.project,
    title: input.externalIdPrefix,
    provenance: "llm_derived",
    evidence_history_item_ids: [msg.id],
  }) as { id: number };
  const cc = store.createCorrectionCandidate({
    task_episode_id: ep.id,
    classification: "constraint_restatement",
    is_correction: true,
    reusable: true,
    proposed_scope: input.scope,
    summary: input.summary,
    confidence: input.confidence,
    evidence_reason: `mined from 1 corrections`,
    evidence_history_item_ids: [msg.id],
    ...(input.structuredOutput
      ? {
          classification_meta: {
            provider: "openai",
            model: "gpt-5.5",
            role: "rule_writer",
            structured_output: {
              propose: true,
              instruction: input.instruction,
              scope: input.scope,
              prediction: "x",
              failure_signature: "x",
              evidence_message_ids: [`${input.externalIdPrefix}-1`],
              confidence: input.confidence,
              duplicate_of_rule_id: input.structuredOutput.duplicate_of_rule_id,
              contradicts_rule_id: input.structuredOutput.contradicts_rule_id,
            },
          },
        }
      : {}),
  }) as { id: number };
  const learning = store.createLearning({
    correction_candidate_id: cc.id,
    observed_problem: "p",
    desired_behavior: input.instruction,
    reuse_rationale: "r",
    proposed_scope: input.scope,
    confidence: input.confidence,
    provenance: "llm_derived",
    created_by: "openai/gpt-5.5 (rule writer)",
  }) as { id: number };
  const rule = store.createRule({
    learning_id: learning.id,
    correction_candidate_id: cc.id,
    instruction: input.instruction,
    scope: input.scope,
    applies_when: "always",
    predicted_failure: "x",
    ownership: "harness",
    created_by: "openai/gpt-5.5 (rule writer)",
  }) as { id: number };
  return { cc, rule };
}

const UNSURE_PROJECT = "unsure-test-project";
db.prepare(`INSERT INTO allowed_projects (lovable_project_id, label) VALUES (?, ?)`).run(
  UNSURE_PROJECT,
  "unsure",
);
store.upsertProject({ lovable_project_id: UNSURE_PROJECT, name: "Unsure Test Project" });

test("unsure: null in ask mode, even for a mined candidate below the confidence threshold", () => {
  store.setSettings({ decision_mode: "ask" });
  const { cc } = mkMinedCandidate({
    project: UNSURE_PROJECT,
    externalIdPrefix: "unsure-ask",
    content: "please fix the signup flow",
    summary: "signup flow needs a fix",
    instruction: "Always validate the signup form before submit.",
    scope: "project",
    confidence: 0.3,
  });
  assert.equal(imp.getImprovement(cc.id)!.unsure, null);
});

test("unsure: below-confidence text, exact copy with two-decimal confidence and threshold", () => {
  store.setSettings({ decision_mode: "automatic", decision_auto_confidence: "0.8" });
  const { cc } = mkMinedCandidate({
    project: UNSURE_PROJECT,
    externalIdPrefix: "unsure-lowconf",
    content: "please fix the checkout flow",
    summary: "checkout flow needs a fix",
    instruction: "Always validate the checkout form before submit.",
    scope: "project",
    confidence: 0.62,
  });
  assert.equal(
    imp.getImprovement(cc.id)!.unsure,
    "Harness Ledger wasn't sure: confidence 0.62 is below your automatic threshold (0.80).",
  );
  store.setSettings({ decision_mode: "ask" });
});

test("unsure: a flagged (but not auto-rejected) duplicate reads as 'similar to an existing rule'", () => {
  store.setSettings({ decision_mode: "automatic", decision_auto_confidence: "0.8" });
  const { cc } = mkMinedCandidate({
    project: UNSURE_PROJECT,
    externalIdPrefix: "unsure-dup",
    content: "please fix the login flow",
    summary: "login flow needs a fix",
    instruction: "Always validate the login form before submit.",
    scope: "project",
    confidence: 0.95,
    structuredOutput: { duplicate_of_rule_id: 999999, contradicts_rule_id: null },
  });
  assert.equal(
    imp.getImprovement(cc.id)!.unsure,
    "Harness Ledger wasn't sure: similar to an existing rule.",
  );
  store.setSettings({ decision_mode: "ask" });
});

test("unsure: a flagged contradiction names the other rule's text, clamped to 80 characters", () => {
  const longInstruction =
    "Always require the user to re-authenticate before changing billing details or payment methods on file.";
  assert.ok(
    longInstruction.length > 80,
    "fixture instruction must exceed 80 chars to test the clamp",
  );
  const other = mkRule({
    project: UNSURE_PROJECT,
    externalIdPrefix: "unsure-other-rule",
    content: "always require re-auth for billing changes",
    summary: "billing changes need re-auth",
    desired: longInstruction,
    instruction: longInstruction,
    scope: "project",
  });

  store.setSettings({ decision_mode: "automatic", decision_auto_confidence: "0.8" });
  const { cc } = mkMinedCandidate({
    project: UNSURE_PROJECT,
    externalIdPrefix: "unsure-contradict",
    content: "please skip re-auth for billing changes",
    summary: "billing changes should skip re-auth",
    instruction: "Never require re-authentication for billing changes.",
    scope: "project",
    confidence: 0.95,
    structuredOutput: { duplicate_of_rule_id: null, contradicts_rule_id: other.rule.id },
  });
  assert.equal(
    imp.getImprovement(cc.id)!.unsure,
    `Harness Ledger wasn't sure: may conflict with "${longInstruction.slice(0, 80)}".`,
  );
  store.setSettings({ decision_mode: "ask" });
});

test("unsure: null once confidence clears the bar and nothing was flagged", () => {
  store.setSettings({ decision_mode: "automatic", decision_auto_confidence: "0.8" });
  const { cc } = mkMinedCandidate({
    project: UNSURE_PROJECT,
    externalIdPrefix: "unsure-clean",
    content: "please fix the profile flow",
    summary: "profile flow needs a fix",
    instruction: "Always validate the profile form before submit.",
    scope: "project",
    confidence: 0.95,
    structuredOutput: { duplicate_of_rule_id: null, contradicts_rule_id: null },
  });
  assert.equal(imp.getImprovement(cc.id)!.unsure, null);
  store.setSettings({ decision_mode: "ask" });
});

test("unsure: null for a low-confidence candidate whose rule was NOT created by the analysis", () => {
  store.setSettings({ decision_mode: "automatic", decision_auto_confidence: "0.8" });
  // A human-authored candidate, via createCorrectionCandidate directly (the
  // MCP path) rather than mkMinedCandidate -- confidence is set low, but the
  // rule's created_by never ends "(rule writer)", so isAnalysisCreated must
  // gate this out regardless of confidence.
  const msg = store.upsertHistoryItem({
    project_id: UNSURE_PROJECT,
    kind: "message",
    external_id: "unsure-human-1",
    role: "user",
    content: "please fix the export flow",
    occurred_at: "2026-09-01T00:00:00Z",
    provenance: "lovable_mcp",
  }) as { id: number };
  const ep = store.createTaskEpisode({
    project_id: UNSURE_PROJECT,
    title: "unsure-human",
    provenance: "llm_derived",
    evidence_history_item_ids: [msg.id],
  }) as { id: number };
  const cc = store.createCorrectionCandidate({
    task_episode_id: ep.id,
    classification: "constraint_restatement",
    is_correction: true,
    reusable: true,
    proposed_scope: "project",
    summary: "export flow needs a fix",
    confidence: 0.1,
    evidence_history_item_ids: [msg.id],
  }) as { id: number };
  const learning = store.createLearning({
    correction_candidate_id: cc.id,
    observed_problem: "p",
    desired_behavior: "Always validate the export form before submit.",
    reuse_rationale: "r",
    proposed_scope: "project",
    provenance: "manual",
    created_by: "operator (local UI)",
  }) as { id: number };
  store.createRule({
    learning_id: learning.id,
    correction_candidate_id: cc.id,
    instruction: "Always validate the export form before submit.",
    scope: "project",
    applies_when: "always",
    predicted_failure: "x",
    ownership: "user",
    created_by: "operator (local UI)",
  });
  assert.equal(imp.getImprovement(cc.id)!.unsure, null);
  store.setSettings({ decision_mode: "ask" });
});

test("rank: higher confidence x tag acceptance rate ranks first among pending items", () => {
  const RANK_PROJECT = "rank-test-project";
  db.prepare(`INSERT INTO allowed_projects (lovable_project_id, label) VALUES (?, ?)`).run(
    RANK_PROJECT,
    "rank",
  );
  store.upsertProject({ lovable_project_id: RANK_PROJECT, name: "Rank Test Project" });

  // Seeds a decided (accepted/skipped) history for a tag, so
  // tagAcceptanceRates()[tag] reads a real rate rather than the <3-decisions
  // fallback -- each seed candidate is immediately accepted or skipped so it
  // counts, and tagged via insertMessageClassification on its own evidence
  // message (episodeScopeTags' source).
  function seedDecision(tag: string, idx: number, outcome: "accept" | "skip") {
    const msg = store.upsertHistoryItem({
      project_id: RANK_PROJECT,
      kind: "message",
      external_id: `rank-seed-${tag}-${idx}`,
      role: "user",
      content: `seed message ${tag} ${idx}`,
      occurred_at: "2026-09-01T00:00:00Z",
      provenance: "lovable_mcp",
    }) as { id: number };
    store.insertMessageClassification({
      history_item_id: msg.id,
      classification: "correction",
      tags: [tag],
      summary: "seed",
    });
    const ep = store.createTaskEpisode({
      project_id: RANK_PROJECT,
      title: `rank-seed-${tag}-${idx}`,
      provenance: "llm_derived",
      evidence_history_item_ids: [msg.id],
    }) as { id: number };
    const cc = store.createCorrectionCandidate({
      task_episode_id: ep.id,
      classification: "constraint_restatement",
      is_correction: true,
      reusable: true,
      proposed_scope: "project",
      summary: `seed ${tag} ${idx}`,
      evidence_history_item_ids: [msg.id],
    }) as { id: number };
    if (outcome === "accept") {
      imp.improvementAction({ action: "accept", id: cc.id, destination: "project" });
    } else {
      imp.improvementAction({ action: "skip", id: cc.id });
    }
    return cc.id;
  }

  // "billing": 3 accepted, 1 skipped -> rate 0.75 (>=3 decisions, real rate).
  seedDecision("billing", 1, "accept");
  seedDecision("billing", 2, "accept");
  seedDecision("billing", 3, "accept");
  seedDecision("billing", 4, "skip");
  // "ui": 1 accepted, 2 skipped -> rate 1/3 (>=3 decisions, real rate).
  seedDecision("ui", 1, "accept");
  seedDecision("ui", 2, "skip");
  seedDecision("ui", 3, "skip");
  // "rare": 1 accepted only -> fewer than 3 decisions, falls back to 0.5.
  seedDecision("rare", 1, "accept");

  // Three NEW pending candidates, same confidence, one tag each -- isolates
  // rank to the tag's acceptance rate alone.
  function mkPending(tag: string) {
    const msg = store.upsertHistoryItem({
      project_id: RANK_PROJECT,
      kind: "message",
      external_id: `rank-pending-${tag}`,
      role: "user",
      content: `pending message ${tag}`,
      occurred_at: "2026-09-02T00:00:00Z",
      provenance: "lovable_mcp",
    }) as { id: number };
    store.insertMessageClassification({
      history_item_id: msg.id,
      classification: "correction",
      tags: [tag],
      summary: "pending",
    });
    const ep = store.createTaskEpisode({
      project_id: RANK_PROJECT,
      title: `rank-pending-${tag}`,
      provenance: "llm_derived",
      evidence_history_item_ids: [msg.id],
    }) as { id: number };
    const cc = store.createCorrectionCandidate({
      task_episode_id: ep.id,
      classification: "constraint_restatement",
      is_correction: true,
      reusable: true,
      proposed_scope: "project",
      summary: `pending ${tag}`,
      confidence: 0.9,
      evidence_history_item_ids: [msg.id],
    }) as { id: number };
    return cc.id;
  }

  const billingId = mkPending("billing");
  const uiId = mkPending("ui");
  const rareId = mkPending("rare");

  // billing: 0.9 * (0.5 + 0.75) = 1.125
  // rare:    0.9 * (0.5 + 0.5)  = 0.9
  // ui:      0.9 * (0.5 + 1/3)  = 0.75
  const all = imp.listImprovements();
  const rank = (id: number) => all.find((i) => i.id === id)!.rank;
  assert.ok(Math.abs(rank(billingId) - 1.125) < 1e-9, `billing rank was ${rank(billingId)}`);
  assert.ok(Math.abs(rank(rareId) - 0.9) < 1e-9, `rare rank was ${rank(rareId)}`);
  assert.ok(Math.abs(rank(uiId) - 0.75) < 1e-9, `ui rank was ${rank(uiId)}`);

  // The three land in rank-desc order among themselves, regardless of where
  // other pending items from earlier tests fall in the full list.
  const orderedIds = all.map((i) => i.id).filter((id) => [billingId, rareId, uiId].includes(id));
  assert.deepEqual(orderedIds, [billingId, rareId, uiId]);
});

test("rank: non-pending items keep their existing (created_at desc) relative order, unaffected by ranking", () => {
  const ORDER_PROJECT = "rank-order-test-project";
  db.prepare(`INSERT INTO allowed_projects (lovable_project_id, label) VALUES (?, ?)`).run(
    ORDER_PROJECT,
    "rank-order",
  );
  store.upsertProject({ lovable_project_id: ORDER_PROJECT, name: "Rank Order Test Project" });

  const older = mkRule({
    project: ORDER_PROJECT,
    externalIdPrefix: "rank-order-older",
    content: "always do the older thing",
    summary: "the older thing needs doing. More words for length here.",
    desired: "Always do the older thing.",
    instruction: "Always do the older thing.",
    scope: "project",
  });
  const newer = mkRule({
    project: ORDER_PROJECT,
    externalIdPrefix: "rank-order-newer",
    content: "always do the newer thing",
    summary: "the newer thing needs doing. More words for length here.",
    desired: "Always do the newer thing.",
    instruction: "Always do the newer thing.",
    scope: "project",
  });
  imp.improvementAction({ action: "accept", id: older.cc.id, destination: "project" });
  imp.improvementAction({ action: "accept", id: newer.cc.id, destination: "project" });
  setAt("correction_candidates", "created_at", older.cc.id, "2026-09-01 09:00:00");
  setAt("correction_candidates", "created_at", newer.cc.id, "2026-09-01 10:00:00");

  // store.listCorrectionCandidates orders by created_at DESC -- the same raw
  // order buildImprovement's caller (listImprovements) starts from, and
  // sortForInbox must leave untouched for non-pending items.
  const rawOrder = (store.listCorrectionCandidates() as { id: number }[])
    .map((r) => r.id)
    .filter((id) => id === older.cc.id || id === newer.cc.id);
  assert.deepEqual(rawOrder, [newer.cc.id, older.cc.id], "sanity: raw order is newest first");

  const listedOrder = imp
    .listImprovements()
    .map((i) => i.id)
    .filter((id) => id === older.cc.id || id === newer.cc.id);
  assert.deepEqual(listedOrder, [newer.cc.id, older.cc.id]);
});

test("skip: an optional reason is stored via setCandidateSkipReason, readable back off the candidate row", () => {
  const REASON_PROJECT = "skip-reason-test-project";
  db.prepare(`INSERT INTO allowed_projects (lovable_project_id, label) VALUES (?, ?)`).run(
    REASON_PROJECT,
    "skip-reason",
  );
  store.upsertProject({ lovable_project_id: REASON_PROJECT, name: "Skip Reason Test Project" });

  const a = mkRule({
    project: REASON_PROJECT,
    externalIdPrefix: "skip-reason-a",
    content: "always do the skip-reason thing",
    summary: "the skip-reason thing needs doing. More words for length.",
    desired: "Always do the skip-reason thing.",
    instruction: "Always do the skip-reason thing.",
    scope: "project",
  });
  const result = imp.improvementAction({ action: "skip", id: a.cc.id, reason: "wrong_wording" });
  assert.equal(result.decision.status, "skipped");
  const row = store.getCorrectionCandidate(a.cc.id) as {
    correction_candidate: { skip_reason: string | null };
  };
  assert.equal(row.correction_candidate.skip_reason, "wrong_wording");

  // A second skip with no reason clears it (setCandidateSkipReason(id, null)).
  imp.improvementAction({ action: "reopen", id: a.cc.id });
  imp.improvementAction({ action: "skip", id: a.cc.id });
  const row2 = store.getCorrectionCandidate(a.cc.id) as {
    correction_candidate: { skip_reason: string | null };
  };
  assert.equal(row2.correction_candidate.skip_reason, null);
});

// ---- Fix round 1 item 1: tagAcceptanceRates() computed once per list, not
// once per item ----

// store.tagAcceptanceRates() is a full scan of every reviewed
// correction_candidate (SELECT task_episode_id, reusable,
// excluded_from_learning FROM correction_candidates WHERE reviewed = 1),
// with a per-row episodeScopeTags subquery. computeRank must never call it
// itself -- listImprovements/getImprovement compute it once and thread the
// map down through buildImprovement/buildRetireItem instead. `store` is an
// ES module namespace object (import * as store from "./store.js"), which
// is read-only at runtime -- reassigning store.tagAcceptanceRates directly
// throws ("Cannot assign to read only property"), so this spies one level
// down, on db.prepare itself (a plain instance method, not a module
// namespace export), counting exactly how many times the SQL text unique to
// tagAcceptanceRates gets prepared.
type PatchablePrepare = { prepare: (sql: string, ...rest: unknown[]) => unknown };

function countTagAcceptanceRatesPrepares(run: () => void): number {
  const patchable = db as unknown as PatchablePrepare;
  const original = patchable.prepare.bind(db);
  let count = 0;
  patchable.prepare = (sql: string, ...rest: unknown[]) => {
    if (sql.includes("task_episode_id, reusable, excluded_from_learning")) count++;
    return original(sql, ...rest);
  };
  try {
    run();
  } finally {
    patchable.prepare = original;
  }
  return count;
}

test("performance: listImprovements() calls tagAcceptanceRates exactly once, however many items are in the list", () => {
  // The shared test DB already carries many pending + decided items from
  // every earlier test in this file -- if tagAcceptanceRates were still
  // called per item (the pre-fix bug), this count would be in the dozens,
  // not 1.
  const before = imp.listImprovements();
  assert.ok(before.length > 5, "sanity: the shared test DB has more than a handful of items");

  const count = countTagAcceptanceRatesPrepares(() => {
    imp.listImprovements();
  });
  assert.equal(
    count,
    1,
    "tagAcceptanceRates must be prepared exactly once per listImprovements() call",
  );
});

test("performance: getImprovement(id) calls tagAcceptanceRates exactly once", () => {
  const anyItem = imp.listImprovements()[0]!;
  const count = countTagAcceptanceRatesPrepares(() => {
    imp.getImprovement(anyItem.id);
  });
  assert.equal(
    count,
    1,
    "tagAcceptanceRates must be prepared exactly once per getImprovement() call",
  );
});

// ---- Round 6 Task 2: peekActionKind / prepareWordingChangeRewrite ----
// The write-wiring itself (improvementActionAndWrite) lives in
// executor/beats.ts and is tested there (harness/test/executor.test.ts) --
// this file only owns the two small, Lovable-free exports that wrapper
// calls into (see the "no Lovable import" test above, which is exactly why
// the wrapper cannot live in this file).

test("peekActionKind: reads the action name, and test_first only for accept", () => {
  const project = "improvements-test-peek";
  db.prepare(`INSERT INTO allowed_projects (lovable_project_id, label) VALUES (?, ?)`).run(
    project,
    "test",
  );
  store.upsertProject({ lovable_project_id: project, name: "Peek Project" });
  const { cc } = mkRule({
    project,
    externalIdPrefix: "peek",
    content: "please always do P",
    summary: "s",
    desired: "d",
    instruction: "Always do P.",
    scope: "project",
  });

  assert.deepEqual(imp.peekActionKind({ action: "accept", id: cc.id, destination: "project" }), {
    kind: "accept",
    testFirst: false,
  });
  assert.deepEqual(
    imp.peekActionKind({
      action: "accept",
      id: cc.id,
      destination: "project",
      test_first: true,
    }),
    { kind: "accept", testFirst: true },
  );
  assert.deepEqual(imp.peekActionKind({ action: "skip", id: cc.id }), {
    kind: "skip",
    testFirst: false,
  });
  assert.deepEqual(imp.peekActionKind({ action: "retire", rule_id: 1 }), {
    kind: "retire",
    testFirst: false,
  });
  assert.throws(() => imp.peekActionKind({ action: "not_a_real_action" }));
});

test("prepareWordingChangeRewrite: a no-op thunk for every action but change_wording, and for change_wording of an unwritten rule", () => {
  const project = "improvements-test-wording-noop";
  db.prepare(`INSERT INTO allowed_projects (lovable_project_id, label) VALUES (?, ?)`).run(
    project,
    "test",
  );
  store.upsertProject({ lovable_project_id: project, name: "Wording Noop Project" });
  const { cc, rule } = mkRule({
    project,
    externalIdPrefix: "wording-noop",
    content: "please always do Q",
    summary: "s",
    desired: "d",
    instruction: "Always do Q.",
    scope: "project",
  });
  // Scoped to this test's own rule -- the shared test DB already carries
  // pending versions from earlier tests in this file.
  const pendingForRule = () =>
    store.listKnowledgeVersions(rule.id).filter((v) => v.status === "pending").length;

  // Not change_wording at all.
  const thunk1 = imp.prepareWordingChangeRewrite({ action: "skip", id: cc.id });
  imp.improvementAction({ action: "skip", id: cc.id });
  thunk1();
  assert.equal(pendingForRule(), 0);
  imp.improvementAction({ action: "reopen", id: cc.id });

  // change_wording, but this rule has never been written -- nothing to
  // rewrite yet (stageApprovedWrites/an ordinary accept picks it up later).
  const thunk2 = imp.prepareWordingChangeRewrite({
    action: "change_wording",
    id: cc.id,
    instruction: "Always do Q, differently.",
  });
  imp.improvementAction({
    action: "change_wording",
    id: cc.id,
    instruction: "Always do Q, differently.",
  });
  thunk2();
  assert.equal(pendingForRule(), 0);
});

test("prepareWordingChangeRewrite: stages a rewrite when the rule being reworded was already written", () => {
  const project = "improvements-test-wording-written";
  db.prepare(`INSERT INTO allowed_projects (lovable_project_id, label) VALUES (?, ?)`).run(
    project,
    "test",
  );
  store.upsertProject({ lovable_project_id: project, name: "Wording Written Project" });
  store.recordKnowledgeSnapshot({
    target: "project",
    project_id: project,
    content: "Existing Knowledge.",
    fetched_by: "test",
  });
  const { cc, rule } = mkRule({
    project,
    externalIdPrefix: "wording-written",
    content: "please always do R",
    summary: "s",
    desired: "d",
    instruction: "Always do R.",
    scope: "project",
  });
  store.updateRule({ id: rule.id, state: "active", actor: "test" });
  const v = store.createPendingKnowledgeVersion({
    rule_id: rule.id,
    target: "project",
    project_id: project,
    previous_content: "Existing Knowledge.",
    new_content: "Existing Knowledge.\n\n- Always do R.",
    rule_ids: [rule.id],
    actor: "test",
  });
  store.recordKnowledgeReadback(v.id, "Existing Knowledge.\n\n- Always do R.");
  assert.equal(imp.getImprovement(cc.id)!.lovable.write_status, "written");

  const thunk = imp.prepareWordingChangeRewrite({
    action: "change_wording",
    id: cc.id,
    instruction: "Always do R, updated.",
  });
  imp.improvementAction({
    action: "change_wording",
    id: cc.id,
    instruction: "Always do R, updated.",
  });
  thunk();

  const versions = store.listKnowledgeVersions(rule.id);
  assert.equal(versions[0]!.status, "pending", "change_wording's own rewrite was re-staged");
  assert.match(versions[0]!.new_content, /Always do R, updated\./);
});

// ---- Round 6 Task 5: demo isolation (spec §5 / spec §0's incident) ----
// A demo Knowledge snapshot is recorded with fetched_by = 'demo' under the
// SAME real project/workspace id the demo uses (harness/src/demo.ts) -- so
// without latestKnowledgeSnapshot's forWrite guard, a real rule's own
// preview/accept could silently compose on demo text just by being newer.
// Separately, a demo rule's own retire/re-add/restore must stage nothing at
// all (stagePendingWrite's created_by = 'demo' guard, and the matching
// guard in retireRule/the "restore" case) -- that is exactly the poisoned
// recompose (rule_id: null, rule_ids_json naming demo rules) spec §0 found.

test("buildPreview/stagePendingWrite: a real rule's preview and staged write use the newest NON-demo Knowledge snapshot, even when a demo snapshot is newer", () => {
  const project = "improvements-test-demo-isolation-preview";
  db.prepare(`INSERT INTO allowed_projects (lovable_project_id, label) VALUES (?, ?)`).run(
    project,
    "test",
  );
  store.upsertProject({ lovable_project_id: project, name: "Demo Isolation Preview Project" });

  store.recordKnowledgeSnapshot({
    target: "project",
    project_id: project,
    content: "# Real Knowledge\n\nReal content.\n",
    fetched_by: "executor",
  });
  // Recorded AFTER the real one (a higher id -- "newer" by
  // latestKnowledgeSnapshot's own ORDER BY id DESC) but must still be
  // ignored by any real preview/write.
  store.recordKnowledgeSnapshot({
    target: "project",
    project_id: project,
    content: "# Demo Knowledge\n\nDemo content, never real.\n",
    fetched_by: "demo",
  });

  const { cc, rule } = mkRule({
    project,
    externalIdPrefix: "demo-isolation-real-rule",
    content: "please always do Z",
    summary: "s",
    desired: "Always do Z.",
    instruction: "Always do Z.",
    scope: "project",
  });

  const preview = imp.getImprovement(cc.id)!.lovable.previews.project;
  assert.ok(preview, "a preview must exist once a real snapshot has been recorded");
  assert.match(preview!.final_content, /Real Knowledge/);
  assert.doesNotMatch(preview!.final_content, /Demo Knowledge/);

  imp.improvementAction({ action: "accept", id: cc.id, destination: "project" });

  const versions = store.listKnowledgeVersions(rule.id);
  assert.equal(versions.length, 1);
  assert.equal(versions[0]!.status, "pending");
  assert.match(versions[0]!.previous_content, /Real Knowledge/);
  assert.doesNotMatch(versions[0]!.previous_content, /Demo Knowledge/);
  assert.match(versions[0]!.new_content, /Real Knowledge/);
  assert.doesNotMatch(versions[0]!.new_content, /Demo Knowledge/);
});

function mkDemoRule(project: string, externalIdPrefix: string) {
  // Hand-built rather than via mkRule -- mkRule hardcodes created_by:
  // "test", and this needs created_by: "demo" on both the learning and the
  // rule (improvements.ts's stagePendingWrite/retireRule/"restore" guards
  // all key off the rule's own created_by).
  const msg = store.upsertHistoryItem({
    project_id: project,
    kind: "message",
    external_id: `${externalIdPrefix}-1`,
    role: "user",
    content: "Demo: a demo request",
    occurred_at: "2026-09-01T00:00:00Z",
    provenance: "lovable_mcp",
  }) as { id: number };
  const ep = store.createTaskEpisode({
    project_id: project,
    title: "Demo: episode",
    provenance: "manual",
    evidence_history_item_ids: [msg.id],
  }) as { id: number };
  const cc = store.createCorrectionCandidate({
    task_episode_id: ep.id,
    classification: "constraint_restatement",
    is_correction: true,
    reusable: true,
    proposed_scope: "project",
    summary: "Demo: summary",
    evidence_history_item_ids: [msg.id],
  }) as { id: number };
  const learning = store.createLearning({
    correction_candidate_id: cc.id,
    observed_problem: "p",
    desired_behavior: "Demo: desired",
    reuse_rationale: "r",
    proposed_scope: "project",
    provenance: "manual",
    created_by: "demo",
  }) as { id: number };
  const rule = store.createRule({
    learning_id: learning.id,
    correction_candidate_id: cc.id,
    instruction: "Demo: always do W.",
    scope: "project",
    applies_when: "always",
    predicted_failure: "x",
    ownership: "harness",
    created_by: "demo",
  }) as { id: number };
  return { cc, rule };
}

test("improvementAction 'retire' on a demo rule stages nothing -- not even the target-level (rule_id: null) recompose spec §0 found", () => {
  const project = "improvements-test-demo-isolation-retire";
  db.prepare(`INSERT INTO allowed_projects (lovable_project_id, label) VALUES (?, ?)`).run(
    project,
    "test",
  );
  store.upsertProject({ lovable_project_id: project, name: "Demo Isolation Retire Project" });
  store.recordKnowledgeSnapshot({
    target: "project",
    project_id: project,
    content: "# Real Knowledge\n\nReal content.\n",
    fetched_by: "executor",
  });

  const { rule } = mkDemoRule(project, "demo-isolation-retire");
  store.updateRule({ id: rule.id, state: "active", actor: "demo" });

  imp.improvementAction({ action: "retire", rule_id: rule.id });

  assert.equal((store.getRule(rule.id) as { rule: { state: string } }).rule.state, "retired");
  assert.equal(
    store.listKnowledgeVersions(rule.id).length,
    0,
    "retiring a demo rule must stage no knowledge_version tied to its own id",
  );
  const targetLevelRecompose = db
    .prepare(
      `SELECT COUNT(*) as n FROM knowledge_versions WHERE rule_id IS NULL AND project_id = ?`,
    )
    .get(project) as { n: number };
  assert.equal(
    targetLevelRecompose.n,
    0,
    "retiring a demo rule must not stage the target-level recompose either -- that recompose's rule_ids_json would have named a demo rule",
  );
});

test("improvementAction 'readd' and 'restore' on a demo rule stage nothing (stagePendingWrite's and 'restore' case's created_by = 'demo' guards)", () => {
  const project = "improvements-test-demo-isolation-readd-restore";
  db.prepare(`INSERT INTO allowed_projects (lovable_project_id, label) VALUES (?, ?)`).run(
    project,
    "test",
  );
  store.upsertProject({
    lovable_project_id: project,
    name: "Demo Isolation Readd/Restore Project",
  });

  const { cc, rule } = mkDemoRule(project, "demo-isolation-readd-restore");
  const base = "# Real Knowledge\n\nReal content.\n";
  const written = `${base}\n- Demo: always do W.`;
  const v0 = store.createPendingKnowledgeVersion({
    rule_id: rule.id,
    target: "project",
    project_id: project,
    previous_content: base,
    new_content: written,
    rule_ids: [rule.id],
    actor: "demo",
  }) as { id: number };
  store.recordKnowledgeReadback(v0.id, written);
  store.updateRule({ id: rule.id, state: "retired", actor: "demo" });

  imp.improvementAction({ action: "readd", id: cc.id });
  assert.equal((store.getRule(rule.id) as { rule: { state: string } }).rule.state, "approved");
  assert.equal(
    store.listKnowledgeVersions(rule.id).filter((v) => v.status === "pending").length,
    0,
    "re-adding a demo rule must stage nothing",
  );

  imp.improvementAction({ action: "restore", id: cc.id, version_id: v0.id });
  assert.equal(
    store.listKnowledgeVersions(rule.id).filter((v) => v.status === "pending").length,
    0,
    "restoring a demo rule's written version must stage nothing",
  );
});

// ---- Round 6 Task 3 / spec §3: Undo, Cancel, Remove from Knowledge ----
// Undo (a plain, no-dialog reversal of any decided-but-unwritten item) and
// cancel_write (the Instructions page's own pending-write banner); Remove
// from Knowledge is just the existing "retire" action wired through
// executor/beats.ts's improvementActionAndWrite (already write-eligible),
// so it needs no new backend test here.

test("undo: reopens an accepted-but-unwritten item back to pending, cancelling the staged write", () => {
  const project = "improvements-test-undo-unwritten";
  db.prepare(`INSERT INTO allowed_projects (lovable_project_id, label) VALUES (?, ?)`).run(
    project,
    "test",
  );
  store.upsertProject({ lovable_project_id: project, name: "Undo Unwritten Project" });
  store.recordKnowledgeSnapshot({
    target: "project",
    project_id: project,
    content: "# Knowledge\n\nExisting text.",
    fetched_by: "test",
  });

  const { cc, rule } = mkRule({
    project,
    externalIdPrefix: "undo-unwritten",
    content: "please always do U",
    summary: "s",
    desired: "d",
    instruction: "Always do U.",
    scope: "project",
  });

  imp.improvementAction({ action: "accept", id: cc.id, destination: "project" });
  const stagedBefore = (
    store.listPendingKnowledgeWrites() as { id: number; rule_id: number | null }[]
  ).filter((w) => w.rule_id === rule.id);
  assert.equal(stagedBefore.length, 1, "accept stages one pending write");
  const beforeUndo = imp.getImprovement(cc.id)!;
  assert.equal(beforeUndo.lovable.can_undo, true, "not live -- Undo is available");
  assert.equal(beforeUndo.lovable.can_cancel_write, true, "a pending write exists to cancel");

  const item = imp.improvementAction({ action: "undo", id: cc.id });
  assert.equal(item.decision.status, "pending");
  assert.equal(item.stage, "review");
  assert.equal(
    (store.getRule(rule.id) as { rule: { state: string } }).rule.state,
    "proposed",
    "undo puts the rule back to proposed, same as reopen",
  );
  assert.equal(
    store.listKnowledgeVersions(rule.id).some((v) => v.status === "pending"),
    false,
    "undo cancels the staged write",
  );
  assert.equal(
    store.listKnowledgeVersions(rule.id).find((v) => v.id === stagedBefore[0]!.id)!.status,
    "cancelled",
  );
});

test("undo: a retired rule whose removal was never written comes back to 'active' (not 'proposed'), and the removal rewrite is cancelled", () => {
  const project = "improvements-test-undo-retired-unwritten";
  db.prepare(`INSERT INTO allowed_projects (lovable_project_id, label) VALUES (?, ?)`).run(
    project,
    "test",
  );
  store.upsertProject({ lovable_project_id: project, name: "Undo Retired Unwritten Project" });
  store.recordKnowledgeSnapshot({
    target: "project",
    project_id: project,
    content: "# Knowledge\n\nExisting text.",
    fetched_by: "test",
  });

  const { cc, rule } = mkRule({
    project,
    externalIdPrefix: "undo-retired-unwritten",
    content: "please always do V",
    summary: "s",
    desired: "d",
    instruction: "Always do V.",
    scope: "project",
  });

  // Get the rule written for real first (undo-while-retired only makes
  // sense for a rule that really was live in Lovable).
  imp.improvementAction({ action: "accept", id: cc.id, destination: "project" });
  const staged = (
    store.listPendingKnowledgeWrites() as {
      id: number;
      rule_id: number | null;
      new_content: string;
    }[]
  ).find((w) => w.rule_id === rule.id)!;
  store.recordKnowledgeReadback(staged.id, staged.new_content);
  assert.equal(imp.getImprovement(cc.id)!.lovable.write_status, "written");

  // Retire it (the manual, rule_id path -- no proposal involved). This
  // stages the removal rewrite (rule_id: null) but never writes it -- same
  // as improvementAction always does; only executor/beats.ts's
  // improvementActionAndWrite attempts an actual Lovable write.
  imp.improvementAction({ action: "retire", rule_id: rule.id });
  assert.equal((store.getRule(rule.id) as { rule: { state: string } }).rule.state, "retired");
  const retiredItem = imp.getImprovement(cc.id)!;
  assert.equal(retiredItem.decision.retired, true);
  assert.equal(
    retiredItem.lovable.retirement_write_status,
    "pending",
    "the removal rewrite is staged but not yet written",
  );
  assert.equal(retiredItem.lovable.can_undo, true, "the removal never reached Lovable");
  assert.equal(retiredItem.lovable.can_cancel_write, true, "the removal rewrite is still pending");

  const undone = imp.improvementAction({ action: "undo", id: cc.id });
  assert.equal(
    (store.getRule(rule.id) as { rule: { state: string } }).rule.state,
    "active",
    "undo brings the rule straight back to active -- it was never actually removed from Lovable",
  );
  assert.equal(undone.decision.retired, false);
  assert.equal(undone.decision.status, "accepted");
  const rewrite = (
    store.listKnowledgeVersions() as {
      rule_id: number | null;
      reason: string | null;
      status: string;
    }[]
  ).find((v) => v.rule_id === null && v.reason === `retired rule ${rule.id}`);
  assert.ok(rewrite, "the removal rewrite version must still exist, now cancelled");
  assert.equal(rewrite!.status, "cancelled");
});

test("cancel_write: cancels the staged version and reopens the item it belongs to", () => {
  const project = "improvements-test-cancel-write";
  db.prepare(`INSERT INTO allowed_projects (lovable_project_id, label) VALUES (?, ?)`).run(
    project,
    "test",
  );
  store.upsertProject({ lovable_project_id: project, name: "Cancel Write Project" });
  store.recordKnowledgeSnapshot({
    target: "project",
    project_id: project,
    content: "# Knowledge\n\nExisting text.",
    fetched_by: "test",
  });

  const { cc, rule } = mkRule({
    project,
    externalIdPrefix: "cancel-write",
    content: "please always do X",
    summary: "s",
    desired: "d",
    instruction: "Always do X.",
    scope: "project",
  });

  // Same starting shape as a real accept that never got its inline write
  // (Harness disconnected, or the write failed) -- a plain pending version,
  // exactly what the Instructions page's own pending-write banner shows.
  imp.improvementAction({ action: "accept", id: cc.id, destination: "project" });
  const staged = (
    store.listPendingKnowledgeWrites() as { id: number; rule_id: number | null }[]
  ).find((w) => w.rule_id === rule.id)!;
  assert.equal(imp.getImprovement(cc.id)!.lovable.can_cancel_write, true);

  const item = imp.improvementAction({ action: "cancel_write", version_id: staged.id });
  assert.equal(item.id, cc.id);
  assert.equal(item.decision.status, "pending");
  assert.equal((store.getRule(rule.id) as { rule: { state: string } }).rule.state, "proposed");
  assert.equal(store.getKnowledgeVersion(staged.id)!.status, "cancelled");

  // A version that's already terminal (stale/failed) is reopened first,
  // not thrown on -- same tolerance executeVersionNow's own retry path has.
  imp.improvementAction({ action: "accept", id: cc.id, destination: "project" });
  const stagedAgain = (
    store.listPendingKnowledgeWrites() as { id: number; rule_id: number | null }[]
  ).find((w) => w.rule_id === rule.id)!;
  store.markKnowledgeWriteFailed(stagedAgain.id, "simulated failure");
  const afterFailedCancel = imp.improvementAction({
    action: "cancel_write",
    version_id: stagedAgain.id,
  });
  assert.equal(afterFailedCancel.decision.status, "pending");
  assert.equal(store.getKnowledgeVersion(stagedAgain.id)!.status, "cancelled");
});

test("undo: refused for a written (not retired) rule, with a clear reason pointing at Remove from Knowledge", () => {
  const project = "improvements-test-undo-refused-written";
  db.prepare(`INSERT INTO allowed_projects (lovable_project_id, label) VALUES (?, ?)`).run(
    project,
    "test",
  );
  store.upsertProject({ lovable_project_id: project, name: "Undo Refused Written Project" });
  store.recordKnowledgeSnapshot({
    target: "project",
    project_id: project,
    content: "# Knowledge\n\nExisting text.",
    fetched_by: "test",
  });

  const { cc, rule } = mkRule({
    project,
    externalIdPrefix: "undo-refused-written",
    content: "please always do Z",
    summary: "s",
    desired: "d",
    instruction: "Always do Z.",
    scope: "project",
  });

  imp.improvementAction({ action: "accept", id: cc.id, destination: "project" });
  const staged = (
    store.listPendingKnowledgeWrites() as {
      id: number;
      rule_id: number | null;
      new_content: string;
    }[]
  ).find((w) => w.rule_id === rule.id)!;
  store.recordKnowledgeReadback(staged.id, staged.new_content);
  const written = imp.getImprovement(cc.id)!;
  assert.equal(written.lovable.write_status, "written");
  assert.equal(written.lovable.can_undo, false, "live -- Undo is not offered");
  assert.equal(written.lovable.can_cancel_write, false, "nothing pending to cancel");

  assert.throws(
    () => imp.improvementAction({ action: "undo", id: cc.id }),
    /This rule is live in Lovable — use Remove from Knowledge instead\./,
  );

  // Refused cleanly -- nothing about the item changed.
  const after = imp.getImprovement(cc.id)!;
  assert.equal(after.decision.status, "accepted");
  assert.equal(after.lovable.write_status, "written");
  assert.equal((store.getRule(rule.id) as { rule: { state: string } }).rule.state, "active");
});

// ---- Round 6 Task 3 fix 1: liveness (isRuleLive), not write_status, gates
// undo/cancel_write. write_status reads the LATEST version for a rule --
// once a live rule's wording is changed while Harness is disconnected, that
// latest version is pending/stale/failed even though the rule's earlier
// write is still exactly what's live in Lovable; the old check let Undo
// demote it to "proposed" (and drop it out of Instructions), while a
// recompose for any OTHER rule would then silently write Lovable's
// Knowledge without it. ----

// Shared setup for both fixtures below: a rule accepted, written for real,
// then reworded through the exact production path (executor/beats.ts's own
// prepareWordingChangeRewrite + improvementAction + the returned thunk) --
// the same sequence a live "Change wording" press makes, staging a fresh
// pending rewrite for the SAME rule without ever touching rule.state.
function mkLiveRuleWithPendingRewrite(idPrefix: string) {
  const project = `improvements-test-${idPrefix}`;
  db.prepare(`INSERT INTO allowed_projects (lovable_project_id, label) VALUES (?, ?)`).run(
    project,
    "test",
  );
  store.upsertProject({ lovable_project_id: project, name: idPrefix });
  store.recordKnowledgeSnapshot({
    target: "project",
    project_id: project,
    content: "# Knowledge\n\nExisting text.",
    fetched_by: "test",
  });

  const { cc, rule } = mkRule({
    project,
    externalIdPrefix: idPrefix,
    content: "please always do the thing",
    summary: "s",
    desired: "d",
    instruction: "Always do the thing.",
    scope: "project",
  });

  imp.improvementAction({ action: "accept", id: cc.id, destination: "project" });
  const firstWrite = (
    store.listPendingKnowledgeWrites() as {
      id: number;
      rule_id: number | null;
      new_content: string;
    }[]
  ).find((w) => w.rule_id === rule.id)!;
  store.recordKnowledgeReadback(firstWrite.id, firstWrite.new_content);
  assert.equal((store.getRule(rule.id) as { rule: { state: string } }).rule.state, "active");

  const thunk = imp.prepareWordingChangeRewrite({
    action: "change_wording",
    id: cc.id,
    instruction: "Always do the thing, updated.",
  });
  imp.improvementAction({
    action: "change_wording",
    id: cc.id,
    instruction: "Always do the thing, updated.",
  });
  thunk();

  const rewrite = (store.listKnowledgeVersions(rule.id) as { id: number; status: string }[]).find(
    (v) => v.status === "pending",
  )!;
  assert.ok(rewrite, "the reworded rule must have a freshly staged rewrite");
  return { cc, rule, rewriteVersionId: rewrite.id };
}

test("undo: refused for a live rule even though its later wording-change rewrite is only pending (fix 1)", () => {
  const { cc, rule } = mkLiveRuleWithPendingRewrite("undo-live-pending-rewrite");

  const midway = imp.getImprovement(cc.id)!;
  assert.equal(midway.lovable.write_status, "pending", "the rewrite itself reads pending");
  assert.equal(
    (store.getRule(rule.id) as { rule: { state: string } }).rule.state,
    "active",
    "the rule is still live -- only a later rewrite is unwritten",
  );
  assert.equal(midway.lovable.can_undo, false, "isRuleLive must win over write_status");
  assert.equal(midway.lovable.can_cancel_write, true, "the pending rewrite can still be cancelled");

  assert.throws(
    () => imp.improvementAction({ action: "undo", id: cc.id }),
    /This rule is live in Lovable — use Remove from Knowledge instead\./,
  );
  assert.equal(
    (store.getRule(rule.id) as { rule: { state: string } }).rule.state,
    "active",
    "undo must never demote a rule that is still live",
  );
  assert.equal(
    store.listKnowledgeVersions(rule.id).some((v) => v.status === "pending"),
    true,
    "the refused undo must not touch the staged rewrite either",
  );
});

test("undo: refused for a live rule when its wording-change rewrite has gone failed instead of pending (fix 1)", () => {
  const { cc, rule, rewriteVersionId } = mkLiveRuleWithPendingRewrite("undo-live-failed-rewrite");
  store.markKnowledgeWriteFailed(rewriteVersionId, "simulated failure");

  const midway = imp.getImprovement(cc.id)!;
  assert.equal(midway.lovable.write_status, "failed");
  assert.equal(midway.lovable.can_undo, false);
  assert.equal(midway.lovable.can_cancel_write, true);

  assert.throws(
    () => imp.improvementAction({ action: "undo", id: cc.id }),
    /This rule is live in Lovable — use Remove from Knowledge instead\./,
  );
  assert.equal((store.getRule(rule.id) as { rule: { state: string } }).rule.state, "active");
});

test("cancel_write: on a live rule's own pending rewrite, drops only the rewrite -- the rule stays 'active' and the response carries the kept-live toast text (fix 2)", () => {
  const { cc, rule, rewriteVersionId } = mkLiveRuleWithPendingRewrite("cancel-write-live-rewrite");

  const result = imp.improvementAction({ action: "cancel_write", version_id: rewriteVersionId });
  assert.equal(
    (store.getRule(rule.id) as { rule: { state: string } }).rule.state,
    "active",
    "the rule stays active -- only the staged rewrite is dropped",
  );
  assert.equal(store.getKnowledgeVersion(rewriteVersionId)!.status, "cancelled");
  assert.equal(
    result.lovable.write_status,
    "written",
    "the item reads back to its earlier written version",
  );
  assert.equal(
    (result as { cancel_note?: string }).cancel_note,
    "Cancelled — the staged change was dropped; the rule stays as written",
  );

  // The correction itself is still "accepted", never bounced back to
  // pending -- cancel_write only reopens the rule's decision when the rule
  // is NOT live (see the plain cancel_write test above).
  const after = imp.getImprovement(cc.id)!;
  assert.equal(after.decision.status, "accepted");
  assert.equal(after.lovable.can_undo, false);
  assert.equal(after.lovable.can_cancel_write, false, "nothing left to cancel");
});
// ---- end Round 6 Task 3 fix 1 ----
// ---- end Round 6 Task 3 ----

// ---- Round 6 Task 6b ----
// Improvement.test (TestInfo): available/unavailable, `run`/`credits`
// reflect real store state, the `judge` action, and the History timeline's
// new `test` node kind. Never touches Lovable (no fake server needed here
// -- the actual runner is tested against one in experiments.test.ts); a
// `test` action's own queued-run creation is simulated directly via
// store.createExperimentRun, the same convention experiments.test.ts's own
// fixtures use for a row that isn't meant to run through the real
// remix/build flow.

function mkRuleNoRequest(prefix: string) {
  const ep = store.createTaskEpisode({
    project_id: PROJECT,
    title: prefix,
    provenance: "llm_derived",
    evidence_history_item_ids: [],
  }) as { id: number };
  const cc = store.createCorrectionCandidate({
    task_episode_id: ep.id,
    classification: "constraint_restatement",
    is_correction: true,
    reusable: true,
    proposed_scope: "project",
    summary: "no request behind this one",
    evidence_history_item_ids: [],
  }) as { id: number };
  const learning = store.createLearning({
    correction_candidate_id: cc.id,
    observed_problem: "p",
    desired_behavior: "d",
    reuse_rationale: "r",
    proposed_scope: "project",
    provenance: "llm_derived",
    created_by: "test",
  }) as { id: number };
  const rule = store.createRule({
    learning_id: learning.id,
    correction_candidate_id: cc.id,
    instruction: "A rule with no request to replay.",
    scope: "project",
    applies_when: "always",
    predicted_failure: "x",
    ownership: "harness",
    created_by: "test",
  }) as { id: number };
  return { cc, rule, ep };
}

/** A rule whose episode carries `correctionSummaries.length` classified
 * correction messages (message_classifications, Round 4 A1's own table --
 * inserted directly, the same convention rule-health.test.ts's own
 * `classify` helper uses; store.ts exposes no writer for it, it's the
 * classifier pipeline's own output) alongside the request that opened it --
 * what episodeCorrections/TestInfo.run.corrections/the judge action's own
 * `corrections` count all read. */
function mkRuleWithCorrections(prefix: string, correctionSummaries: string[]) {
  const reqMsg = store.upsertHistoryItem({
    project_id: PROJECT,
    kind: "message",
    external_id: `${prefix}-req`,
    role: "user",
    content: "Add a signup form.",
    occurred_at: "2026-09-01T00:00:00Z",
    provenance: "lovable_mcp",
  }) as { id: number };
  const evidenceIds = [reqMsg.id];
  correctionSummaries.forEach((summary, i) => {
    const msg = store.upsertHistoryItem({
      project_id: PROJECT,
      kind: "message",
      external_id: `${prefix}-corr-${i}`,
      role: "user",
      content: summary,
      occurred_at: `2026-09-01T00:0${i + 1}:00Z`,
      provenance: "lovable_mcp",
    }) as { id: number };
    db.prepare(
      `INSERT INTO message_classifications (history_item_id, classification, tags_json, summary) VALUES (?, 'correction', '[]', ?)`,
    ).run(msg.id, summary);
    evidenceIds.push(msg.id);
  });
  const ep = store.createTaskEpisode({
    project_id: PROJECT,
    title: prefix,
    provenance: "llm_derived",
    evidence_history_item_ids: evidenceIds,
  }) as { id: number };
  const cc = store.createCorrectionCandidate({
    task_episode_id: ep.id,
    classification: "defect_correction",
    is_correction: true,
    reusable: true,
    proposed_scope: "project",
    summary: "seed correction for a paired-test fixture",
    evidence_history_item_ids: evidenceIds,
  }) as { id: number };
  const learning = store.createLearning({
    correction_candidate_id: cc.id,
    observed_problem: "p",
    desired_behavior: "d",
    reuse_rationale: "r",
    proposed_scope: "project",
    provenance: "llm_derived",
    created_by: "test",
  }) as { id: number };
  const rule = store.createRule({
    learning_id: learning.id,
    correction_candidate_id: cc.id,
    instruction: "Always validate the signup form before submit.",
    scope: "project",
    applies_when: "always",
    predicted_failure: "x",
    ownership: "harness",
    created_by: "test",
  }) as { id: number };
  return { cc, rule, ep };
}

/** Round 6 fix wave item C: a rule whose episode carries NO classified
 * correction messages (no message_classifications rows at all -- unlike
 * mkRuleWithCorrections above) but does carry `followUpTexts.length`
 * evidence messages after the opening request, each authored with the
 * given `role` ("user" or "operator" -- store.episodeFollowUpCorrections'
 * own fallback source). Mirrors the owner's own real first episode: hand-
 * built, so nothing was ever run through the classifier. */
function mkRuleWithFollowUps(
  prefix: string,
  followUpTexts: string[],
  role: "user" | "operator" = "user",
) {
  const reqMsg = store.upsertHistoryItem({
    project_id: PROJECT,
    kind: "message",
    external_id: `${prefix}-req`,
    role: "user",
    content: "Add a signup form.",
    occurred_at: "2026-09-01T00:00:00Z",
    provenance: "lovable_mcp",
  }) as { id: number };
  const evidenceIds = [reqMsg.id];
  followUpTexts.forEach((text, i) => {
    const msg = store.upsertHistoryItem({
      project_id: PROJECT,
      kind: "message",
      external_id: `${prefix}-followup-${i}`,
      role,
      content: text,
      occurred_at: `2026-09-01T00:0${i + 1}:00Z`,
      provenance: "lovable_mcp",
    }) as { id: number };
    evidenceIds.push(msg.id);
  });
  const ep = store.createTaskEpisode({
    project_id: PROJECT,
    title: prefix,
    provenance: "manual",
    evidence_history_item_ids: evidenceIds,
  }) as { id: number };
  const cc = store.createCorrectionCandidate({
    task_episode_id: ep.id,
    classification: "defect_correction",
    is_correction: true,
    reusable: true,
    proposed_scope: "project",
    summary: "hand-built candidate, no classifier ever ran",
    evidence_history_item_ids: evidenceIds,
  }) as { id: number };
  const learning = store.createLearning({
    correction_candidate_id: cc.id,
    observed_problem: "p",
    desired_behavior: "d",
    reuse_rationale: "r",
    proposed_scope: "project",
    provenance: "manual",
    created_by: "test",
  }) as { id: number };
  const rule = store.createRule({
    learning_id: learning.id,
    correction_candidate_id: cc.id,
    instruction: "Always validate the signup form before submit.",
    scope: "project",
    applies_when: "always",
    predicted_failure: "x",
    ownership: "harness",
    created_by: "test",
  }) as { id: number };
  return { cc, rule, ep };
}

// ---- TestInfo: available ----

test("Improvement.test: available when connected, a request to replay exists, nothing else is running, and within budget", () => {
  const { cc } = mkRule({
    project: PROJECT,
    externalIdPrefix: "test-avail",
    content: "Add a login form.",
    summary: "s",
    desired: "d",
    instruction: "Always validate emails on login forms.",
    scope: "project",
  });
  const item = imp.getImprovement(cc.id, { connected: true })!;
  assert.ok(item.test, "a rule exists, so test is not null");
  assert.equal(item.test!.available, true);
  assert.equal(item.test!.unavailable_reason, null);
  assert.equal(item.test!.run, null, "no run has ever been started for this rule");
  assert.deepEqual(item.test!.credits, {
    used_this_month: store.creditsThisMonth(),
    budget: Number(store.getSetting("lovable_monthly_credit_budget")),
  });
});

test("Improvement.test: null when the correction has no rule yet", () => {
  const cc = store.createCorrectionCandidate({
    task_episode_id: episode.id,
    classification: "constraint_restatement",
    is_correction: true,
    reusable: true,
    proposed_scope: "project",
    summary: "no rule yet",
    evidence_history_item_ids: [],
  }) as { id: number };
  const item = imp.getImprovement(cc.id, { connected: true })!;
  assert.equal(item.test, null);
});

// ---- TestInfo: unavailable reasons ----

test("Improvement.test: unavailable -- not connected (the default when `connected` isn't passed)", () => {
  const { cc } = mkRule({
    project: PROJECT,
    externalIdPrefix: "test-notconnected",
    content: "Add a checkout page.",
    summary: "s",
    desired: "d",
    instruction: "Always show a loading state on checkout.",
    scope: "project",
  });
  const item = imp.getImprovement(cc.id)!;
  assert.equal(item.test!.available, false);
  assert.equal(
    item.test!.unavailable_reason,
    "Harness Ledger is not connected — connect on the Projects page.",
  );
});

test("Improvement.test: unavailable -- no original request to replay", () => {
  const { cc } = mkRuleNoRequest("test-norequest");
  const item = imp.getImprovement(cc.id, { connected: true })!;
  assert.equal(item.test!.available, false);
  assert.equal(item.test!.unavailable_reason, "This suggestion has no original request to replay.");
});

test("Improvement.test: unavailable -- a test is already running (checked across every rule)", () => {
  const busy = mkRule({
    project: PROJECT,
    externalIdPrefix: "test-busy-owner",
    content: "Add a settings page.",
    summary: "s",
    desired: "d",
    instruction: "Always confirm before deleting an account.",
    scope: "project",
  });
  const other = mkRule({
    project: PROJECT,
    externalIdPrefix: "test-busy-other",
    content: "Add a billing page.",
    summary: "s",
    desired: "d",
    instruction: "Always show the next billing date.",
    scope: "project",
  });
  const { id: runId } = store.createExperimentRun({
    rule_id: busy.rule.id,
    correction_candidate_id: busy.cc.id,
    task_episode_id: busy.ep.id,
    source_project_id: PROJECT,
    request_message_external_id: "test-busy-owner-1",
  });
  try {
    const item = imp.getImprovement(other.cc.id, { connected: true })!;
    assert.equal(item.test!.available, false);
    assert.equal(item.test!.unavailable_reason, "A test is already running; one runs at a time.");
  } finally {
    store.updateExperimentRun(runId, { status: "cancelled" });
  }
});

test("Improvement.test: unavailable -- exceeds the monthly credit budget, exact sentence", () => {
  const { cc, rule, ep } = mkRule({
    project: PROJECT,
    externalIdPrefix: "test-budget",
    content: "Add a pricing page.",
    summary: "s",
    desired: "d",
    instruction: "Always show currency alongside price.",
    scope: "project",
  });
  store.setSettings({ lovable_monthly_credit_budget: "1" });
  try {
    // A finished (non-active) run's own credit_ledger row is what
    // creditsThisMonth() sums -- create and immediately terminate one so it
    // counts towards this month's usage without itself blocking as "active".
    const { id: runId } = store.createExperimentRun({
      rule_id: rule.id,
      correction_candidate_id: cc.id,
      task_episode_id: ep.id,
      source_project_id: PROJECT,
      request_message_external_id: "test-budget-1",
    });
    store.recordCredits(runId, 5);
    store.updateExperimentRun(runId, {
      status: "judged",
      score: 1,
      judged_at: "2026-09-01T00:00:00Z",
    });

    const usedThisMonth = store.creditsThisMonth();
    assert.ok(usedThisMonth >= 5);
    const item = imp.getImprovement(cc.id, { connected: true })!;
    assert.equal(item.test!.available, false);
    assert.equal(
      item.test!.unavailable_reason,
      `This would exceed your monthly Lovable credit budget (${usedThisMonth} of 1 used).`,
    );
  } finally {
    store.setSettings({ lovable_monthly_credit_budget: "12" });
  }
});

// ---- TestInfo.run reflects the latest experiment_runs row ----

test("Improvement.test.run: reflects the latest run for this rule, whatever its status, alongside the episode's own corrections count", () => {
  const { cc, rule, ep } = mkRuleWithCorrections("test-run-reflect", [
    "The email field accepted invalid addresses.",
    "The submit button stayed enabled while the request was in flight.",
  ]);
  const { id: runId } = store.createExperimentRun({
    rule_id: rule.id,
    correction_candidate_id: cc.id,
    task_episode_id: ep.id,
    source_project_id: PROJECT,
    request_message_external_id: "test-run-reflect-req",
  });
  store.updateExperimentRun(runId, {
    status: "building",
    stage_note: "Building in the copy",
    cost_credits: null,
    edits_since_episode: null,
  });

  const item = imp.getImprovement(cc.id, { connected: true })!;
  assert.ok(item.test!.run);
  assert.equal(item.test!.run!.id, runId);
  assert.equal(item.test!.run!.status, "building");
  assert.equal(item.test!.run!.stage_note, "Building in the copy");
  assert.equal(item.test!.run!.corrections, 2, "the episode's own two classified corrections");
  assert.equal(item.test!.run!.score, null);

  // A run that's mid-flight is itself the "already running" refusal for a
  // DIFFERENT rule -- but this rule's own available flips back to true once
  // it's terminal (a fresh "Test this rule" can sit next to the old run's
  // own result line on the card).
  store.updateExperimentRun(runId, {
    status: "judged",
    score: 0.5,
    judged_at: "2026-09-02T00:00:00Z",
    verdicts_json: JSON.stringify(["no", "yes"]),
  });
  const afterJudged = imp.getImprovement(cc.id, { connected: true })!;
  assert.equal(afterJudged.test!.available, true);
  assert.equal(afterJudged.test!.run!.status, "judged");
  assert.equal(afterJudged.test!.run!.score, 0.5);
});

// ---- the `judge` action ----

test("judge: verdicts.length must match the episode's own corrections count", () => {
  const { cc, rule, ep } = mkRuleWithCorrections("judge-count", [
    "Corrected once.",
    "Corrected twice.",
  ]);
  const { id: runId } = store.createExperimentRun({
    rule_id: rule.id,
    correction_candidate_id: cc.id,
    task_episode_id: ep.id,
    source_project_id: PROJECT,
    request_message_external_id: "judge-count-req",
  });
  store.updateExperimentRun(runId, { status: "judging" });

  assert.throws(
    () => imp.improvementAction({ action: "judge", run_id: runId, verdicts: ["yes"] }),
    /expected 2 verdicts.*got 1/,
  );
});

test("judge: unknown run id throws", () => {
  assert.throws(
    () => imp.improvementAction({ action: "judge", run_id: 999999, verdicts: [] }),
    /experiment run 999999 not found/,
  );
});

// ---- Round 6 fix wave item 2: judge refuses a run that isn't waiting for a verdict ----

test("judge: a run that's still building (not judging yet) throws, not silently judged", () => {
  const { cc, rule, ep } = mkRuleWithCorrections("judge-guard-building", ["Corrected once."]);
  const { id: runId } = store.createExperimentRun({
    rule_id: rule.id,
    correction_candidate_id: cc.id,
    task_episode_id: ep.id,
    source_project_id: PROJECT,
    request_message_external_id: "judge-guard-building-req",
  });
  store.updateExperimentRun(runId, { status: "building" });

  assert.throws(
    () => imp.improvementAction({ action: "judge", run_id: runId, verdicts: ["yes"] }),
    /This test is not waiting for a verdict\./,
  );
});

test("judge: an already-judged run refuses a second verdict, not a silent re-judge", () => {
  const { cc, rule, ep } = mkRuleWithCorrections("judge-guard-rejudge", ["Corrected once."]);
  const { id: runId } = store.createExperimentRun({
    rule_id: rule.id,
    correction_candidate_id: cc.id,
    task_episode_id: ep.id,
    source_project_id: PROJECT,
    request_message_external_id: "judge-guard-rejudge-req",
  });
  store.updateExperimentRun(runId, { status: "judging" });
  imp.improvementAction({ action: "judge", run_id: runId, verdicts: ["yes"] });

  assert.throws(
    () => imp.improvementAction({ action: "judge", run_id: runId, verdicts: ["no"] }),
    /This test is not waiting for a verdict\./,
  );
});

test("judge: computes score (no ÷ corrections), marks the run judged with judged_at, and returns the refreshed improvement", () => {
  const { cc, rule, ep } = mkRuleWithCorrections("judge-score", [
    "The email field accepted invalid addresses.",
    "The password field had no minimum length.",
    "The confirm-password field was never compared.",
  ]);
  const { id: runId } = store.createExperimentRun({
    rule_id: rule.id,
    correction_candidate_id: cc.id,
    task_episode_id: ep.id,
    source_project_id: PROJECT,
    request_message_external_id: "judge-score-req",
  });
  store.updateExperimentRun(runId, { status: "judging" });

  const result = imp.improvementAction({
    action: "judge",
    run_id: runId,
    verdicts: ["no", "no", "unclear"],
  });

  assert.equal(result.id, cc.id, "judge returns the run's own improvement");
  const run = store.getExperimentRun(runId)!;
  assert.equal(run.status, "judged");
  assert.ok(run.judged_at);
  assert.equal(run.score, 2 / 3);
  assert.deepEqual(JSON.parse(run.verdicts_json!), ["no", "no", "unclear"]);
});

test("judge: score is 0, not NaN, when the episode has no classified corrections at all", () => {
  const { cc } = mkRuleNoRequest("judge-zero-corrections");
  // mkRuleNoRequest's own episode has no evidence, but createExperimentRun
  // only needs a valid task_episode_id/correction_candidate_id -- the point
  // here is exercising episodeCorrections() returning [] on an unrelated,
  // otherwise-fine run, not the "no request" refusal path (that's
  // startExperiment's own, tested in experiments.test.ts).
  const found = imp.getImprovement(cc.id)!;
  const { id: runId } = store.createExperimentRun({
    rule_id: found.rule_id!,
    correction_candidate_id: cc.id,
    task_episode_id: (found.developer.correction as { task_episode_id: number }).task_episode_id,
    source_project_id: PROJECT,
    request_message_external_id: "judge-zero-corrections-req",
  });
  store.updateExperimentRun(runId, { status: "judging" });

  const result = imp.improvementAction({ action: "judge", run_id: runId, verdicts: [] });
  assert.equal(result.id, cc.id);
  assert.equal(store.getExperimentRun(runId)!.score, 0);
});

// ---- Round 6 fix wave item C: corrections fallback (classified vs follow_ups) ----

test("buildExperimentRunView: corrections_source is 'classified' when the episode has message_classifications rows", () => {
  const { cc, rule, ep } = mkRuleWithCorrections("runview-classified", [
    "The email field accepted invalid addresses.",
    "The password field had no minimum length.",
  ]);
  const { id: runId } = store.createExperimentRun({
    rule_id: rule.id,
    correction_candidate_id: cc.id,
    task_episode_id: ep.id,
    source_project_id: PROJECT,
    request_message_external_id: "runview-classified-req",
  });
  const view = imp.buildExperimentRunView(runId)!;
  assert.equal(view.corrections_source, "classified");
  assert.deepEqual(view.corrections, [
    "The email field accepted invalid addresses.",
    "The password field had no minimum length.",
  ]);
});

test("buildExperimentRunView: falls back to follow-up messages (corrections_source 'follow_ups') when the episode has no classified corrections", () => {
  const { cc, rule, ep } = mkRuleWithFollowUps("runview-followups", [
    "Actually, also require a confirm-password field.",
    "And show an inline error, not an alert box.",
  ]);
  const { id: runId } = store.createExperimentRun({
    rule_id: rule.id,
    correction_candidate_id: cc.id,
    task_episode_id: ep.id,
    source_project_id: PROJECT,
    request_message_external_id: "runview-followups-req",
  });
  const view = imp.buildExperimentRunView(runId)!;
  assert.equal(view.corrections_source, "follow_ups");
  assert.deepEqual(view.corrections, [
    "Actually, also require a confirm-password field.",
    "And show an inline error, not an alert box.",
  ]);
});

test("buildExperimentRunView: an 'operator' role follow-up message counts too, an 'assistant' reply in between does not", () => {
  const reqMsg = store.upsertHistoryItem({
    project_id: PROJECT,
    kind: "message",
    external_id: "runview-operator-req",
    role: "user",
    content: "Add a signup form.",
    occurred_at: "2026-09-01T00:00:00Z",
    provenance: "lovable_mcp",
  }) as { id: number };
  const reply = store.upsertHistoryItem({
    project_id: PROJECT,
    kind: "message",
    external_id: "runview-operator-reply",
    role: "assistant",
    content: "Sure -- adding a signup form now.",
    occurred_at: "2026-09-01T00:01:00Z",
    provenance: "lovable_mcp",
  }) as { id: number };
  const operatorNote = store.upsertHistoryItem({
    project_id: PROJECT,
    kind: "manual_note",
    external_id: "runview-operator-note",
    role: "operator",
    content: "Operator note: also needs a captcha.",
    occurred_at: "2026-09-01T00:02:00Z",
    provenance: "manual",
  }) as { id: number };
  const ep = store.createTaskEpisode({
    project_id: PROJECT,
    title: "runview-operator",
    provenance: "manual",
    evidence_history_item_ids: [reqMsg.id, reply.id, operatorNote.id],
  }) as { id: number };
  const cc = store.createCorrectionCandidate({
    task_episode_id: ep.id,
    classification: "defect_correction",
    is_correction: true,
    reusable: true,
    proposed_scope: "project",
    summary: "operator-authored follow-up",
    evidence_history_item_ids: [reqMsg.id, reply.id, operatorNote.id],
  }) as { id: number };
  const learning = store.createLearning({
    correction_candidate_id: cc.id,
    observed_problem: "p",
    desired_behavior: "d",
    reuse_rationale: "r",
    proposed_scope: "project",
    provenance: "manual",
    created_by: "test",
  }) as { id: number };
  const rule = store.createRule({
    learning_id: learning.id,
    correction_candidate_id: cc.id,
    instruction: "Always add a captcha to signup forms.",
    scope: "project",
    applies_when: "always",
    predicted_failure: "x",
    ownership: "harness",
    created_by: "test",
  }) as { id: number };
  const { id: runId } = store.createExperimentRun({
    rule_id: rule.id,
    correction_candidate_id: cc.id,
    task_episode_id: ep.id,
    source_project_id: PROJECT,
    request_message_external_id: "runview-operator-req",
  });

  const view = imp.buildExperimentRunView(runId)!;
  assert.equal(view.corrections_source, "follow_ups");
  assert.deepEqual(view.corrections, ["Operator note: also needs a captcha."]);
});

test("judge: verdicts.length is validated against the follow-up fallback count when the episode has no classified corrections", () => {
  const { cc, rule, ep } = mkRuleWithFollowUps("judge-followups-count", [
    "Also require a confirm-password field.",
  ]);
  const { id: runId } = store.createExperimentRun({
    rule_id: rule.id,
    correction_candidate_id: cc.id,
    task_episode_id: ep.id,
    source_project_id: PROJECT,
    request_message_external_id: "judge-followups-count-req",
  });
  store.updateExperimentRun(runId, { status: "judging" });

  assert.throws(
    () => imp.improvementAction({ action: "judge", run_id: runId, verdicts: [] }),
    /expected 1 verdict.*got 0/,
  );

  const result = imp.improvementAction({ action: "judge", run_id: runId, verdicts: ["no"] });
  assert.equal(result.id, cc.id);
  assert.equal(store.getExperimentRun(runId)!.score, 1);
});

test("Improvement.test.run.corrections: counts follow-up messages when the episode has no classified corrections", () => {
  const { cc, rule, ep } = mkRuleWithFollowUps("testinfo-followups", [
    "One follow-up.",
    "Another follow-up.",
  ]);
  const { id: runId } = store.createExperimentRun({
    rule_id: rule.id,
    correction_candidate_id: cc.id,
    task_episode_id: ep.id,
    source_project_id: PROJECT,
    request_message_external_id: "testinfo-followups-req",
  });
  store.updateExperimentRun(runId, {
    status: "judged",
    score: 0.5,
    judged_at: "2026-09-02T00:00:00Z",
  });

  const item = imp.getImprovement(cc.id, { connected: true })!;
  assert.equal(item.test!.run!.corrections, 2);
});

// ---- History timeline: the `test` node kind ----

test("buildTimeline: a judged run renders a `test` node with the exact label, actor, content (both the original build and the with-the-rule build), improvement_id, and run_id; a failed run renders its own", () => {
  const TL2_PROJECT = "timeline-test-project-6b";
  db.prepare(`INSERT INTO allowed_projects (lovable_project_id, label) VALUES (?, ?)`).run(
    TL2_PROJECT,
    "tl6b",
  );
  store.upsertProject({ lovable_project_id: TL2_PROJECT, name: "Timeline Project 6b" });

  const { cc, rule, ep } = mkRuleWithCorrections("timeline-test-node", [
    "One correction.",
    "Another correction.",
  ]);
  // mkRuleWithCorrections seeds its history/episode under the module-level
  // PROJECT constant -- the knowledge_versions row below is what actually
  // puts this rule on TL2_PROJECT's own timeline (buildTimeline reads
  // targets from versions/active-rules-for-target, not from the rule's
  // originating project).
  db.prepare(
    `INSERT INTO knowledge_versions
       (rule_id, target, project_id, previous_content, new_content, previous_sha256, new_sha256, rule_ids_json, status, actor, written_at)
     VALUES (?, 'project', ?, '', '', '', '', ?, 'written', 'test', '2026-08-25T00:00:00Z')`,
  ).run(rule.id, TL2_PROJECT, JSON.stringify([rule.id]));
  store.updateRule({ id: rule.id, state: "active", actor: "test" });

  const { id: judgedRunId } = store.createExperimentRun({
    rule_id: rule.id,
    correction_candidate_id: cc.id,
    task_episode_id: ep.id,
    source_project_id: PROJECT,
    request_message_external_id: "timeline-test-node-req",
  });
  store.updateExperimentRun(judgedRunId, {
    status: "judged",
    verdicts_json: JSON.stringify(["no", "yes"]),
    judged_at: "2026-09-03T00:00:00Z",
    copy_summary: "Added client-side validation.",
    copy_reply: "Added validation to the signup form.",
  });

  const {
    cc: cc2,
    rule: rule2,
    ep: ep2,
  } = mkRuleWithCorrections("timeline-test-node-fail", ["One correction."]);
  db.prepare(
    `INSERT INTO knowledge_versions
       (rule_id, target, project_id, previous_content, new_content, previous_sha256, new_sha256, rule_ids_json, status, actor, written_at)
     VALUES (?, 'project', ?, '', '', '', '', ?, 'written', 'test', '2026-08-26T00:00:00Z')`,
  ).run(rule2.id, TL2_PROJECT, JSON.stringify([rule2.id]));
  store.updateRule({ id: rule2.id, state: "active", actor: "test" });
  const { id: failedRunId } = store.createExperimentRun({
    rule_id: rule2.id,
    correction_candidate_id: cc2.id,
    task_episode_id: ep2.id,
    source_project_id: PROJECT,
    request_message_external_id: "timeline-test-node-fail-req",
  });
  store.updateExperimentRun(failedRunId, {
    status: "failed",
    error: "Lovable stopped without finishing the build in the copy.",
    finished_at: "2026-09-04T00:00:00Z",
  });

  const nodes = imp.buildTimeline("project", TL2_PROJECT);
  const judgedNode = nodes.find((n) => n.id === `test:${judgedRunId}`);
  assert.ok(judgedNode);
  assert.equal(judgedNode!.kind, "test");
  // Round 9 final wave item 9: testedLabel says "instruction", not "rule".
  assert.equal(
    judgedNode!.label,
    "Tested with the instruction: 1 of 2 corrections no longer needed",
  );
  assert.equal(judgedNode!.actor, "harness");
  assert.equal(judgedNode!.at, "2026-09-03T00:00:00Z");
  assert.equal(judgedNode!.improvement_id, cc.id);
  assert.equal(
    judgedNode!.run_id,
    judgedRunId,
    "the node carries the run it's about (fix wave item 3)",
  );
  // Fixture's episode never got an assistant reply recorded -- exercises
  // the "(not recorded)" fallback for the original-build half.
  assert.equal(
    judgedNode!.content,
    "Original build:\n(not recorded)\n\nWith the rule:\nAdded client-side validation.\n\nAdded validation to the signup form.",
  );

  const failedNode = nodes.find((n) => n.id === `test:${failedRunId}`);
  assert.ok(failedNode);
  assert.equal(failedNode!.kind, "test");
  assert.equal(
    failedNode!.label,
    "Test failed: Lovable stopped without finishing the build in the copy.",
  );
  assert.equal(failedNode!.improvement_id, cc2.id);
  assert.equal(failedNode!.run_id, failedRunId);
  assert.match(failedNode!.content ?? "", /^Original build:\n\(not recorded\)\n\nWith the rule:\n/);
});
// ---- end Round 6 Task 6b ----

// ---- Round 6c part B: the Tests page ----
// The "feedback" action (store.setExperimentFeedback, addressed by run_id
// directly, same convention as "judge") and listTestRunSummaries (the Tests
// page's own list read, GET .../improvements?runs=1 in the web app --
// exercised here straight against the store function it's built on).

test("feedback: unknown run id throws", () => {
  assert.throws(
    () => imp.improvementAction({ action: "feedback", run_id: 999999, text: "hello" }),
    /experiment run 999999 not found/,
  );
});

test("feedback: saves text on a run, stamps feedback_at, and returns the run's own improvement", () => {
  const { cc, rule, ep } = mkRule({
    project: PROJECT,
    externalIdPrefix: "feedback-save",
    content: "Add a checkout page.",
    summary: "s",
    desired: "d",
    instruction: "Always show the order total before payment.",
    scope: "project",
  });
  const { id: runId } = store.createExperimentRun({
    rule_id: rule.id,
    correction_candidate_id: cc.id,
    task_episode_id: ep.id,
    source_project_id: PROJECT,
    request_message_external_id: "feedback-save-req",
  });

  const before = store.getExperimentRun(runId)!;
  assert.equal(before.feedback, null);
  assert.equal(before.feedback_at, null);

  const result = imp.improvementAction({
    action: "feedback",
    run_id: runId,
    text: "This looked right to me.",
  });
  assert.equal(result.id, cc.id, "feedback returns the run's own improvement");

  const after = store.getExperimentRun(runId)!;
  assert.equal(after.feedback, "This looked right to me.");
  assert.ok(after.feedback_at);
});

test("feedback: an empty string clears a previously saved note (feedback_at still updated)", () => {
  const { cc, rule, ep } = mkRule({
    project: PROJECT,
    externalIdPrefix: "feedback-clear",
    content: "Add a refund flow.",
    summary: "s",
    desired: "d",
    instruction: "Always log refunds to the audit table.",
    scope: "project",
  });
  const { id: runId } = store.createExperimentRun({
    rule_id: rule.id,
    correction_candidate_id: cc.id,
    task_episode_id: ep.id,
    source_project_id: PROJECT,
    request_message_external_id: "feedback-clear-req",
  });
  imp.improvementAction({ action: "feedback", run_id: runId, text: "First note." });
  const firstSavedAt = store.getExperimentRun(runId)!.feedback_at;
  assert.ok(firstSavedAt);

  imp.improvementAction({ action: "feedback", run_id: runId, text: "" });
  const cleared = store.getExperimentRun(runId)!;
  assert.equal(cleared.feedback, null, "an empty string is stored as null, not ''");
  assert.ok(cleared.feedback_at, "feedback_at is still stamped on a clear");
});

test("listTestRunSummaries: every run, newest first, with the rule's own text, the episode's own corrections count, and the feedback fields", () => {
  const older = mkRule({
    project: PROJECT,
    externalIdPrefix: "runs-list-older",
    content: "Add a login page.",
    summary: "s",
    desired: "d",
    instruction: "Always show a 'forgot password' link.",
    scope: "project",
  });
  const { id: olderRunId } = store.createExperimentRun({
    rule_id: older.rule.id,
    correction_candidate_id: older.cc.id,
    task_episode_id: older.ep.id,
    source_project_id: PROJECT,
    request_message_external_id: "runs-list-older-req",
  });
  store.updateExperimentRun(olderRunId, {
    status: "failed",
    error: "Copying the project timed out.",
  });

  const { cc, rule, ep } = mkRuleWithCorrections("runs-list-newer", [
    "The confirm link never expired.",
  ]);
  const { id: newerRunId } = store.createExperimentRun({
    rule_id: rule.id,
    correction_candidate_id: cc.id,
    task_episode_id: ep.id,
    source_project_id: PROJECT,
    request_message_external_id: "runs-list-newer-req",
  });
  store.updateExperimentRun(newerRunId, {
    status: "judged",
    score: 1,
    judged_at: "2026-09-05T00:00:00Z",
    cost_credits: 4,
  });
  imp.improvementAction({ action: "feedback", run_id: newerRunId, text: "Matched expectations." });

  const summaries = imp.listTestRunSummaries();
  const newerIdx = summaries.findIndex((s) => s.id === newerRunId);
  const olderIdx = summaries.findIndex((s) => s.id === olderRunId);
  assert.ok(newerIdx >= 0 && olderIdx >= 0);
  assert.ok(newerIdx < olderIdx, "newest run first");

  const newerSummary = summaries[newerIdx]!;
  assert.equal(newerSummary.rule_id, rule.id);
  assert.equal(newerSummary.improvement_id, cc.id);
  assert.equal(newerSummary.rule_text, "Always validate the signup form before submit.");
  assert.equal(newerSummary.project_id, PROJECT);
  assert.equal(newerSummary.status, "judged");
  assert.equal(newerSummary.cost_credits, 4);
  assert.equal(newerSummary.score, 1);
  assert.equal(newerSummary.corrections, 1, "the episode's own single classified correction");
  assert.equal(newerSummary.copy_deleted, 0);
  assert.equal(newerSummary.feedback, "Matched expectations.");
  assert.ok(newerSummary.feedback_at);

  const olderSummary = summaries[olderIdx]!;
  assert.equal(olderSummary.status, "failed");
  assert.equal(olderSummary.error, "Copying the project timed out.");
  assert.equal(olderSummary.feedback, null);
  assert.equal(olderSummary.feedback_at, null);
});
// ---- end Round 6c part B ----

test("titleFor: a long single-sentence instruction gets a clipped heading, so the card doesn't repeat it word for word", () => {
  const one =
    'In this app, display all monetary amounts in Swedish kronor as a whole number followed by "kr" (e.g., "125 kr") — never dollars or decimals — for every feature.';
  assert.equal(
    imp.titleFor(one),
    "In this app, display all monetary amounts in Swedish kronor as a whole…",
  );
  assert.equal(
    imp.titleFor(
      "Do not enable recurring background work by default. Prefer user-triggered execution.",
    ),
    "Do not enable recurring background work by default.",
  );
  assert.equal(imp.titleFor("Use kr for money."), "Use kr for money.");
});

test("unsure: a proposal with no confidence says so, instead of a made-up 0.00", () => {
  // Live: the Rule writer (Claude Code) left confidence out; it was stored as
  // 0 and the Inbox read "confidence 0.00 is below your automatic threshold".
  store.setSettings({ decision_mode: "automatic", decision_auto_confidence: "0.8" });
  const { cc } = mkMinedCandidate({
    project: UNSURE_PROJECT,
    externalIdPrefix: "unsure-noconf",
    content: "reset should reset everything",
    summary: "reset everything",
    instruction: "Make Reset restore every input to its default.",
    scope: "project",
    confidence: null,
  });
  assert.equal(
    imp.getImprovement(cc.id)!.unsure,
    "Harness Ledger wasn't sure: the analysis gave no confidence for this rule.",
  );
  store.setSettings({ decision_mode: "ask" });
});

test("buildTimeline: a stale or failed attempt is not the baseline for the next version's '+N −M lines'", () => {
  const P = "timeline-stale-baseline";
  store.allowProject(P, "Stale baseline");
  const mk = (prev: string, next: string) =>
    store.createPendingKnowledgeVersion({
      rule_id: null,
      target: "project",
      project_id: P,
      previous_content: prev,
      new_content: next,
      rule_ids: [],
      actor: "test",
    }) as { id: number; new_content: string };
  const v1 = mk("", "one\ntwo");
  store.recordKnowledgeReadback(v1.id, v1.new_content);
  const refused = mk("one\ntwo", "one\ntwo\nthree");
  store.markKnowledgeWriteStale(refused.id, "changed in Lovable");
  const v3 = mk("one\ntwo", "one\ntwo\nthree");
  store.recordKnowledgeReadback(v3.id, v3.new_content);
  const node = imp.buildTimeline("project", P).find((n) => n.version_id === v3.id)!;
  assert.equal(node.summary, "+1 −0 lines");
});

// ---- Checkpoint 2 2-D: derived conclusion, exposed on judge + the two reads ----
// judgeRun's own regression_flag write (merged into environment_json), and
// buildExperimentRunView/listTestRunSummaries both exposing `conclusion`
// (computed on read via executor/replay-environment.ts's replayConclusion --
// the arithmetic itself is table-tested in replay-conclusion.test.ts; this
// only checks the wiring: does judging actually store the flag, and do both
// reads actually surface the derived value).

function mkEnvironmentJson(overrides: Partial<{ quality: string; regression_flag: boolean }> = {}) {
  return JSON.stringify({
    version: 1,
    kind: "historical_replay",
    quality: overrides.quality ?? "historical_approximation",
    ...(overrides.regression_flag !== undefined
      ? { regression_flag: overrides.regression_flag }
      : {}),
  });
}

test("judge: conclusion is null before judging, and buildExperimentRunView/listTestRunSummaries agree", () => {
  const { cc, rule, ep } = mkRuleWithCorrections("conclusion-not-judged", ["Corrected once."]);
  const { id: runId } = store.createExperimentRun({
    rule_id: rule.id,
    correction_candidate_id: cc.id,
    task_episode_id: ep.id,
    source_project_id: PROJECT,
    request_message_external_id: "conclusion-not-judged-req",
  });
  store.updateExperimentRun(runId, { status: "judging", environment_json: mkEnvironmentJson() });

  assert.equal(imp.buildExperimentRunView(runId)!.conclusion, null);
  const summary = imp.listTestRunSummaries().find((r) => r.id === runId)!;
  assert.equal(summary.conclusion, null);
});

test("judge: a unanimous 'no' verdict derives historical_support on both reads once judged", () => {
  const { cc, rule, ep } = mkRuleWithCorrections("conclusion-support", ["Corrected once."]);
  const { id: runId } = store.createExperimentRun({
    rule_id: rule.id,
    correction_candidate_id: cc.id,
    task_episode_id: ep.id,
    source_project_id: PROJECT,
    request_message_external_id: "conclusion-support-req",
  });
  store.updateExperimentRun(runId, { status: "judging", environment_json: mkEnvironmentJson() });

  imp.improvementAction({ action: "judge", run_id: runId, verdicts: ["no"] });

  assert.equal(imp.buildExperimentRunView(runId)!.conclusion, "historical_support");
  const summary = imp.listTestRunSummaries().find((r) => r.id === runId)!;
  assert.equal(summary.conclusion, "historical_support");
});

test("judge: a unanimous 'yes' verdict derives not_supported", () => {
  const { cc, rule, ep } = mkRuleWithCorrections("conclusion-not-supported", ["Corrected once."]);
  const { id: runId } = store.createExperimentRun({
    rule_id: rule.id,
    correction_candidate_id: cc.id,
    task_episode_id: ep.id,
    source_project_id: PROJECT,
    request_message_external_id: "conclusion-not-supported-req",
  });
  store.updateExperimentRun(runId, { status: "judging", environment_json: mkEnvironmentJson() });

  imp.improvementAction({ action: "judge", run_id: runId, verdicts: ["yes"] });

  assert.equal(imp.buildExperimentRunView(runId)!.conclusion, "not_supported");
});

test("judge: the `regression` flag is folded into environment_json as regression_flag, and forces the conclusion to possibly_harmful regardless of the verdicts", () => {
  const { cc, rule, ep } = mkRuleWithCorrections("conclusion-regression", ["Corrected once."]);
  const { id: runId } = store.createExperimentRun({
    rule_id: rule.id,
    correction_candidate_id: cc.id,
    task_episode_id: ep.id,
    source_project_id: PROJECT,
    request_message_external_id: "conclusion-regression-req",
  });
  store.updateExperimentRun(runId, { status: "judging", environment_json: mkEnvironmentJson() });

  imp.improvementAction({ action: "judge", run_id: runId, verdicts: ["no"], regression: true });

  const run = store.getExperimentRun(runId)!;
  const env = JSON.parse(run.environment_json!) as { regression_flag?: boolean };
  assert.equal(env.regression_flag, true);
  assert.equal(imp.buildExperimentRunView(runId)!.conclusion, "possibly_harmful");
  const summary = imp.listTestRunSummaries().find((r) => r.id === runId)!;
  assert.equal(summary.conclusion, "possibly_harmful");
});

test("judge: regression left unset (older/programmatic caller) leaves environment_json untouched", () => {
  const { cc, rule, ep } = mkRuleWithCorrections("conclusion-no-regression-arg", [
    "Corrected once.",
  ]);
  const { id: runId } = store.createExperimentRun({
    rule_id: rule.id,
    correction_candidate_id: cc.id,
    task_episode_id: ep.id,
    source_project_id: PROJECT,
    request_message_external_id: "conclusion-no-regression-arg-req",
  });
  const before = mkEnvironmentJson();
  store.updateExperimentRun(runId, { status: "judging", environment_json: before });

  imp.improvementAction({ action: "judge", run_id: runId, verdicts: ["no"] });

  assert.equal(store.getExperimentRun(runId)!.environment_json, before);
});

test("judge: regression true on a run with no environment record at all does not throw, and stays unrecorded", () => {
  const { cc, rule, ep } = mkRuleWithCorrections("conclusion-no-environment", ["Corrected once."]);
  const { id: runId } = store.createExperimentRun({
    rule_id: rule.id,
    correction_candidate_id: cc.id,
    task_episode_id: ep.id,
    source_project_id: PROJECT,
    request_message_external_id: "conclusion-no-environment-req",
  });
  store.updateExperimentRun(runId, { status: "judging" });

  const result = imp.improvementAction({
    action: "judge",
    run_id: runId,
    verdicts: ["no"],
    regression: true,
  });
  assert.equal(result.id, cc.id);
  assert.equal(store.getExperimentRun(runId)!.environment_json, null);
  // No environment -> no quality -> replayConclusion's own honesty rule:
  // null rather than a guess (see replay-conclusion.test.ts).
  assert.equal(imp.buildExperimentRunView(runId)!.conclusion, null);
});

test("judge: not_comparable quality derives inconclusive, not a made-up support/not-supported", () => {
  const { cc, rule, ep } = mkRuleWithCorrections("conclusion-not-comparable", [
    "Corrected once.",
    "Corrected twice.",
  ]);
  const { id: runId } = store.createExperimentRun({
    rule_id: rule.id,
    correction_candidate_id: cc.id,
    task_episode_id: ep.id,
    source_project_id: PROJECT,
    request_message_external_id: "conclusion-not-comparable-req",
  });
  store.updateExperimentRun(runId, {
    status: "judging",
    environment_json: mkEnvironmentJson({ quality: "not_comparable" }),
  });

  imp.improvementAction({ action: "judge", run_id: runId, verdicts: ["no", "yes"] });

  assert.equal(imp.buildExperimentRunView(runId)!.conclusion, "inconclusive");
});
// ---- end Checkpoint 2 2-D ----
