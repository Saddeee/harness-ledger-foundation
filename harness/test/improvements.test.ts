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
  return { cc, rule };
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
  const verdict = store.recordRuleVerdict({ rule_id: a.rule.id, verdict: "helped" }) as {
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

  assert.equal(nVerdict!.label, "You said this rule helped");
  assert.equal(nVerdict!.actor, "you");
  assert.equal(nVerdict!.content, "Never run migrations automatically.");
  assert.equal(nVerdict!.summary, "Never run migrations automatically.");
  assert.equal(nVerdict!.improvement_id, a.cc.id);
  assert.deepEqual(nVerdict!.rule_ids, [a.rule.id]);
  assert.equal(nVerdict!.diff, null);

  assert.equal(nV3!.label, `Restored to version #${v1.id}`);
  assert.equal(nV3!.content, v3.new_content);
  assert.equal(nV3!.version_id, v3.id);
  assert.equal(nV3!.restored_from, v1.id);
  assert.equal(nV3!.restorable, false, "the newest written version is never restorable");
  assert.deepEqual(nV3!.diff, expectedDiff(V2_CONTENT, v3.new_content));

  assert.equal(nExternal!.label, "Changed in Lovable (outside Harness)");
  assert.equal(nExternal!.actor, "lovable");
  assert.equal(nExternal!.content, EXTERNAL_CONTENT);
  assert.equal(nExternal!.diff, null);

  assert.equal(nV2!.label, "Written to Lovable");
  assert.equal(nV2!.content, V2_CONTENT);
  assert.equal(nV2!.version_id, v2.id);
  assert.equal(nV2!.restored_from, null);
  assert.equal(nV2!.restorable, true, "an older written version is restorable");
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

test("buildTimeline: retire_proposals create 'Harness suggested retiring' + 'You retired'/'You kept it', and a re-add shows 'Re-added'", () => {
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
  assert.ok(labels.includes("Harness suggested retiring"), labels.join(", "));
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

test("verdict action: records the row; did_not_help bumps rule_health.hurt only when evidence_sources.verdicts is enabled, and only on an existing row", () => {
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
  imp.improvementAction({ action: "accept", id: c.cc.id, destination: "project" });
  store.upsertRuleHealth({
    rule_id: c.rule.id,
    applicable_tasks: 5,
    helped: 2,
    hurt: 1,
    last_applicable_at: null,
    contradicted_by_rule_id: null,
    unused_since: null,
    status: "healthy",
    snoozed_until: null,
  });

  assert.equal(store.getEvidenceSources().verdicts, true, "default has verdicts enabled");
  const result = imp.improvementAction({
    action: "verdict",
    rule_id: c.rule.id,
    verdict: "did_not_help",
    note: "broke the build",
  });
  assert.equal(result.id, c.cc.id);
  assert.equal(
    store.getRuleHealth(c.rule.id)!.hurt,
    2,
    "hurt bumps by one when verdicts evidence is enabled",
  );
  const verdicts = store.listRuleVerdicts(c.rule.id);
  assert.equal(verdicts[0]!.verdict, "did_not_help");
  assert.equal(verdicts[0]!.note, "broke the build");

  // Disable verdicts evidence: a second did_not_help must not bump hurt again.
  store.setSettings({
    evidence_sources: JSON.stringify({
      observed: true,
      adherence: true,
      verdicts: false,
      paired: false,
    }),
  });
  imp.improvementAction({ action: "verdict", rule_id: c.rule.id, verdict: "did_not_help" });
  assert.equal(
    store.getRuleHealth(c.rule.id)!.hurt,
    2,
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
  // creates no row (only bumps "the existing row").
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
  imp.improvementAction({ action: "verdict", rule_id: d.rule.id, verdict: "did_not_help" });
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

  imp.improvementAction({ action: "verdict", rule_id: e.rule.id, verdict: "helped" });
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
  imp.improvementAction({ action: "verdict", rule_id: f.rule.id, verdict: "helped" });
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
