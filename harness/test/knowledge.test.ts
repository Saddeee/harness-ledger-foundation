import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HARNESS_DB_PATH = join(
  mkdtempSync(join(tmpdir(), "harness-knowledge-test-")),
  "harness.db",
);

const { db, schemaVersion } = await import("../src/db.js");
const store = await import("../src/store.js");
const knowledge = await import("../src/knowledge.js");
const improvements = await import("../src/improvements.js");

const {
  composeManagedKnowledge,
  HARNESS_START,
  HARNESS_END,
  MalformedMarkersError,
  sha256,
  KNOWLEDGE_CAP,
} = knowledge;
const PROJECT = "knowledge-test-project";
const WORKSPACE = "knowledge-test-workspace";

// ---- pure composer ----

test("composer preserves text outside the markers byte-for-byte (before, after, unicode, trailing newlines)", () => {
  const before = "# Mine\n\nKeep this — naïve résumé 日本語 🚀\r\n";
  const after = "\n\nMore of my own text after the block.\n\n\n";
  const current = `${before}${HARNESS_START}\nold stuff\n${HARNESS_END}${after}`;
  const out = composeManagedKnowledge(current, [
    { id: 2, instruction: "B" },
    { id: 1, instruction: "A" },
  ]);
  assert.equal(out.user_text, before + after);
  assert.ok(out.final_content.startsWith(before));
  assert.ok(out.final_content.endsWith(after));
  assert.equal(out.final_content, before + out.managed_block + after);
  assert.equal(
    out.managed_block,
    `${HARNESS_START}\n${knowledge.MANAGED_HEADING}\n- A\n- B\n${HARNESS_END}`,
  );
  assert.ok(!out.final_content.includes("old stuff"));
});

test("composer appends the block when no markers exist, and uses only the block for empty content", () => {
  const out = composeManagedKnowledge("Existing text.", [{ id: 1, instruction: "Do X." }]);
  assert.equal(out.final_content, `Existing text.\n\n${out.managed_block}`);
  assert.equal(out.user_text, "Existing text.");
  const empty = composeManagedKnowledge("", [{ id: 1, instruction: "Do X." }]);
  assert.equal(empty.final_content, empty.managed_block);
  assert.equal(empty.user_text, "");
});

test("composer throws on malformed markers instead of overwriting", () => {
  assert.throws(() => composeManagedKnowledge(`a ${HARNESS_START} b`, []), MalformedMarkersError);
  assert.throws(() => composeManagedKnowledge(`a ${HARNESS_END} b`, []), MalformedMarkersError);
  assert.throws(
    () => composeManagedKnowledge(`${HARNESS_END} x ${HARNESS_START}`, []),
    MalformedMarkersError,
  );
  assert.throws(
    () =>
      composeManagedKnowledge(
        `${HARNESS_START} ${HARNESS_END} ${HARNESS_START} ${HARNESS_END}`,
        [],
      ),
    MalformedMarkersError,
  );
});

test("composer flags the 9,000-character cap", () => {
  const out = composeManagedKnowledge("x".repeat(KNOWLEDGE_CAP - 10), [
    { id: 1, instruction: "y".repeat(50) },
  ]);
  assert.equal(out.over_cap, true);
  assert.equal(out.char_count, out.final_content.length);
  assert.equal(composeManagedKnowledge("short", [{ id: 1, instruction: "y" }]).over_cap, false);
});

test("composer flags over_rules when maxActiveRules is exceeded, and always reports active_rules_count", () => {
  const twoRules = [
    { id: 1, instruction: "First." },
    { id: 2, instruction: "Second." },
  ];
  const withMax1 = composeManagedKnowledge("doc", twoRules, 1);
  assert.equal(withMax1.active_rules_count, 2);
  assert.equal(withMax1.over_rules, true);

  const withMax2 = composeManagedKnowledge("doc", twoRules, 2);
  assert.equal(withMax2.active_rules_count, 2);
  assert.equal(withMax2.over_rules, false);

  // No max given -- never flagged, even with many rules.
  const noMax = composeManagedKnowledge("doc", twoRules);
  assert.equal(noMax.active_rules_count, 2);
  assert.equal(noMax.over_rules, false);
});

// ---- migration ----

test("migrations through v7 applied once; earlier tables and rows intact", () => {
  assert.equal(schemaVersion(), 13);
  const names = new Set(
    (
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]
    ).map((r) => r.name),
  );
  for (const t of [
    "knowledge_snapshots",
    "knowledge_versions",
    "rules",
    "correction_candidates",
    "allowed_projects",
    "settings",
  ])
    assert.ok(names.has(t), t);
  const cols = (db.prepare(`PRAGMA table_info(projects)`).all() as { name: string }[]).map(
    (c) => c.name,
  );
  assert.ok(cols.includes("workspace_id"));
});

test("composer cap is read from settings, not just the KNOWLEDGE_CAP constant", () => {
  store.setSettings({ knowledge_char_cap: "1200" });
  const out = composeManagedKnowledge("x".repeat(1450), [{ id: 1, instruction: "y".repeat(20) }]);
  assert.ok(
    out.final_content.length >= 1500,
    `expected a ~1500-char preview, got ${out.final_content.length}`,
  );
  assert.equal(out.over_cap, true);
  store.setSettings({ knowledge_char_cap: String(KNOWLEDGE_CAP) });
});

// ---- fixture: one improvement with a rule ----

db.prepare(`INSERT INTO allowed_projects (lovable_project_id, label) VALUES (?, ?)`).run(
  PROJECT,
  "test",
);
store.upsertProject({ lovable_project_id: PROJECT, name: "Test Project", workspace_id: WORKSPACE });

function makeImprovement(instruction: string) {
  const item = store.upsertHistoryItem({
    project_id: PROJECT,
    kind: "message",
    external_id: `msg-${Math.random()}`,
    role: "user",
    content: "please fix",
    occurred_at: "2026-09-08T10:00:00Z",
    provenance: "lovable_mcp",
  }) as { id: number };
  const ep = store.createTaskEpisode({
    project_id: PROJECT,
    title: "ep",
    provenance: "manual",
    evidence_history_item_ids: [item.id],
  }) as { id: number };
  const cc = store.createCorrectionCandidate({
    task_episode_id: ep.id,
    classification: "constraint_restatement",
    is_correction: true,
    summary: "s",
    evidence_history_item_ids: [item.id],
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
    instruction,
    scope: "project",
    applies_when: "always",
    predicted_failure: "f",
    ownership: "harness",
    created_by: "test",
  }) as { id: number };
  return { correctionId: cc.id, ruleId: rule.id };
}

const A = makeImprovement("Do not enable recurring background work by default.");

test("accept without a snapshot: choice recorded, write_status stays none, previews null", () => {
  const out = improvements.improvementAction({
    action: "accept",
    id: A.correctionId,
    destination: "project",
  });
  assert.equal(out.decision.status, "accepted");
  assert.equal(out.lovable.write_status, "none");
  assert.equal(out.lovable.previews.project, null);
  assert.equal(out.lovable.untested, true);
  assert.equal(store.listPendingKnowledgeWrites().length, 0);
  const rule = db.prepare(`SELECT evidence_level FROM rules WHERE id = ?`).get(A.ruleId) as {
    evidence_level: string;
  };
  assert.equal(rule.evidence_level, "human_grounded");
});

test("skill destination is rejected with a clear error", () => {
  assert.throws(
    () =>
      improvements.improvementAction({
        action: "accept",
        id: A.correctionId,
        destination: "skill",
      }),
    /Skill isn't available yet/,
  );
});

const USER_KNOWLEDGE = "# My project notes\n\nAlways use the design tokens.\n";
let pendingVersionId: number;

test("accept with a snapshot creates exactly one pending version whose content equals the preview", () => {
  store.recordKnowledgeSnapshot({
    target: "project",
    project_id: PROJECT,
    content: USER_KNOWLEDGE,
    fetched_by: "test",
  });
  const out = improvements.improvementAction({
    action: "accept",
    id: A.correctionId,
    destination: "project",
  });
  const preview = out.lovable.previews.project!;
  assert.equal(preview.current_user_text, USER_KNOWLEDGE);
  assert.ok(
    preview.managed_block.includes("- Do not enable recurring background work by default."),
  );
  assert.equal(preview.final_content, `${USER_KNOWLEDGE}\n\n${preview.managed_block}`);
  assert.equal(out.lovable.write_status, "pending");
  assert.equal(
    out.stages.find((s) => s.key === "in_lovable")!.note,
    "Waiting for Harness to add it",
  );
  assert.equal(out.stages.find((s) => s.key === "proof")!.note, "Not proven yet");
  const pending = store.listPendingKnowledgeWrites() as {
    id: number;
    new_content: string;
    previous_sha256: string;
  }[];
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.new_content, preview.final_content);
  assert.equal(pending[0]!.previous_sha256, sha256(USER_KNOWLEDGE));
  pendingVersionId = pending[0]!.id;
});

test("accepting again supersedes the earlier pending write instead of stacking", () => {
  improvements.improvementAction({ action: "accept", id: A.correctionId, destination: "project" });
  const pending = store.listPendingKnowledgeWrites() as { id: number }[];
  assert.equal(pending.length, 1);
  assert.notEqual(pending[0]!.id, pendingVersionId);
  const old = store.getKnowledgeVersion(pendingVersionId)!;
  assert.equal(old.status, "cancelled");
  assert.match(old.error ?? "", /superseded/);
  pendingVersionId = pending[0]!.id;
});

test("stale path: executor reports live content changed; nothing is written", () => {
  const v = store.markKnowledgeWriteStale(pendingVersionId, "live sha differs")!;
  assert.equal(v.status, "stale");
  const out = improvements.getImprovement(A.correctionId)!;
  assert.equal(out.lovable.write_status, "stale");
  assert.equal(out.lovable.stale_reason, "live sha differs");
  assert.equal(out.stages.find((s) => s.key === "in_lovable")!.state, "blocked");
  assert.equal(
    (db.prepare(`SELECT state FROM rules WHERE id = ?`).get(A.ruleId) as { state: string }).state,
    "approved",
  );
});

test("read-back hash mismatch marks the version failed and leaves the rule un-applied", () => {
  const v = store.createPendingKnowledgeVersion({
    rule_id: A.ruleId,
    target: "project",
    project_id: PROJECT,
    previous_content: USER_KNOWLEDGE,
    new_content: "expected",
    rule_ids: [A.ruleId],
    actor: "test",
  });
  const after = store.recordKnowledgeReadback(v.id, "something else")!;
  assert.equal(after.status, "failed");
  assert.match(after.error ?? "", /hash mismatch/);
  assert.equal(
    (db.prepare(`SELECT state FROM rules WHERE id = ?`).get(A.ruleId) as { state: string }).state,
    "approved",
  );
});

let writtenVersionId: number;
test("read-back hash match marks written, activates the rule, and completes In Lovable", () => {
  const out = improvements.improvementAction({
    action: "accept",
    id: A.correctionId,
    destination: "project",
  });
  const pending = store.listPendingKnowledgeWrites() as { id: number; new_content: string }[];
  assert.equal(pending.length, 1);
  const after = store.recordKnowledgeReadback(pending[0]!.id, pending[0]!.new_content)!;
  assert.equal(after.status, "written");
  assert.ok(after.verified_at);
  writtenVersionId = after.id;
  assert.equal(
    (db.prepare(`SELECT state FROM rules WHERE id = ?`).get(A.ruleId) as { state: string }).state,
    "active",
  );
  const refreshed = improvements.getImprovement(A.correctionId)!;
  assert.equal(refreshed.lovable.write_status, "written");
  assert.ok(refreshed.lovable.written_at);
  const stage = refreshed.stages.find((s) => s.key === "in_lovable")!;
  assert.equal(stage.state, "complete");
  assert.match(stage.note ?? "", /^Added to Lovable, \d+ \w{3}$/);
  assert.equal(refreshed.stage, "in_lovable");
  const events = (
    db.prepare(`SELECT kind FROM events WHERE kind = 'rule.applied'`).all() as { kind: string }[]
  ).length;
  assert.ok(events >= 1);
  void out;
});

test("restore creates a NEW pending version pointing at the restored one, with the earlier content; history untouched", () => {
  const before = store.listKnowledgeVersions(A.ruleId).length;
  const out = improvements.improvementAction({
    action: "restore",
    id: A.correctionId,
    version_id: writtenVersionId,
  });
  const versions = store.listKnowledgeVersions(A.ruleId);
  assert.equal(versions.length, before + 1);
  const restore = versions[0]!;
  assert.equal(restore.status, "pending");
  assert.equal(restore.restored_from_version_id, writtenVersionId);
  const original = store.getKnowledgeVersion(writtenVersionId)!;
  assert.equal(restore.new_content, original.previous_content);
  assert.equal(restore.previous_sha256, original.new_sha256);
  assert.equal(original.status, "written", "restoring never rewrites the original row");
  assert.equal(out.lovable.write_status, "pending");
  // executing the restore rolls the rule back
  store.recordKnowledgeReadback(restore.id, restore.new_content);
  assert.equal(
    (db.prepare(`SELECT state FROM rules WHERE id = ?`).get(A.ruleId) as { state: string }).state,
    "rolled_back",
  );
  assert.throws(
    () =>
      improvements.improvementAction({ action: "restore", id: A.correctionId, version_id: 999999 }),
    /does not belong/,
  );
});

test("reopen / skip cancel any pending write so the executor never applies a stale decision", () => {
  const B = makeImprovement("Second rule.");
  improvements.improvementAction({ action: "accept", id: B.correctionId, destination: "project" });
  assert.equal(
    (store.listPendingKnowledgeWrites() as { rule_id: number }[]).filter(
      (p) => p.rule_id === B.ruleId,
    ).length,
    1,
  );
  improvements.improvementAction({ action: "reopen", id: B.correctionId });
  assert.equal(
    (store.listPendingKnowledgeWrites() as { rule_id: number }[]).filter(
      (p) => p.rule_id === B.ruleId,
    ).length,
    0,
  );
  improvements.improvementAction({ action: "accept", id: B.correctionId, destination: "project" });
  improvements.improvementAction({ action: "skip", id: B.correctionId });
  assert.equal(
    (store.listPendingKnowledgeWrites() as { rule_id: number }[]).filter(
      (p) => p.rule_id === B.ruleId,
    ).length,
    0,
  );
});

test("workspace preview needs the project's workspace id; composed from the workspace snapshot", () => {
  const C = makeImprovement("Third rule.");
  store.recordKnowledgeSnapshot({
    target: "workspace",
    workspace_id: WORKSPACE,
    content: "",
    fetched_by: "test",
  });
  const out = improvements.getImprovement(C.correctionId)!;
  assert.ok(out.lovable.previews.workspace);
  assert.equal(out.lovable.previews.workspace!.current_user_text, "");
  assert.ok(out.lovable.previews.workspace!.managed_block.includes("- Third rule."));
  assert.equal(
    out.lovable.previews.workspace!.target_label,
    "Workspace Knowledge — all your projects",
  );
});

test("over_rules: preview flags it, accept refuses to stage, stageApprovedWrites skips -- max 1, two approved rules", () => {
  const PROJECT2 = "knowledge-test-project-2";
  db.prepare(`INSERT INTO allowed_projects (lovable_project_id, label) VALUES (?, ?)`).run(
    PROJECT2,
    "test2",
  );
  store.recordKnowledgeSnapshot({
    target: "project",
    project_id: PROJECT2,
    content: "base doc",
    fetched_by: "test",
  });
  store.setProjectSettings(PROJECT2, { max_active_rules: 1 });

  function makeRuleFor(projectId: string, instruction: string) {
    const item = store.upsertHistoryItem({
      project_id: projectId,
      kind: "message",
      external_id: `msg-${Math.random()}`,
      role: "user",
      content: "please fix",
      occurred_at: "2026-09-08T10:00:00Z",
      provenance: "lovable_mcp",
    }) as { id: number };
    const ep = store.createTaskEpisode({
      project_id: projectId,
      title: "ep",
      provenance: "manual",
      evidence_history_item_ids: [item.id],
    }) as { id: number };
    const cc = store.createCorrectionCandidate({
      task_episode_id: ep.id,
      classification: "constraint_restatement",
      is_correction: true,
      summary: "s",
      evidence_history_item_ids: [item.id],
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
      instruction,
      scope: "project",
      applies_when: "always",
      predicted_failure: "f",
      ownership: "harness",
      created_by: "test",
    }) as { id: number };
    return { correctionId: cc.id, ruleId: rule.id };
  }

  const D = makeRuleFor(PROJECT2, "Rule D.");
  const E = makeRuleFor(PROJECT2, "Rule E.");

  // D alone is fine: it would be the project's only active rule (max 1).
  const outD = improvements.improvementAction({
    action: "accept",
    id: D.correctionId,
    destination: "project",
  });
  assert.equal(outD.lovable.write_status, "pending");
  assert.equal(
    (db.prepare(`SELECT state FROM rules WHERE id = ?`).get(D.ruleId) as { state: string }).state,
    "approved",
  );

  // E would make a second active rule for a project capped at 1.
  const previewE = improvements.getImprovement(E.correctionId)!.lovable.previews.project!;
  assert.equal(previewE.active_rules_count, 2);
  assert.equal(previewE.over_rules, true);
  assert.throws(
    () =>
      improvements.improvementAction({
        action: "accept",
        id: E.correctionId,
        destination: "project",
      }),
    /active rules/,
  );
  // The rule itself was already approved before the write-staging refusal,
  // but nothing was staged for it.
  assert.equal(
    (db.prepare(`SELECT state FROM rules WHERE id = ?`).get(E.ruleId) as { state: string }).state,
    "approved",
  );
  assert.equal(
    (store.listPendingKnowledgeWrites() as { rule_id: number }[]).filter(
      (p) => p.rule_id === E.ruleId,
    ).length,
    0,
  );

  // The executor's path (stageApprovedWrites) skips instead of throwing.
  const staged = improvements.stageApprovedWrites();
  assert.ok(staged.skipped >= 1);
  assert.equal(
    (store.listPendingKnowledgeWrites() as { rule_id: number }[]).filter(
      (p) => p.rule_id === E.ruleId,
    ).length,
    0,
  );
});

test("no Lovable import and no network call in the knowledge path", () => {
  for (const file of [
    "../src/knowledge.ts",
    "../src/improvements.ts",
    "../src/store.ts",
    "../src/mcp-server.ts",
  ]) {
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
    assert.ok(
      !/set_project_knowledge|set_workspace_knowledge|setProjectKnowledge|setWorkspaceKnowledge/.test(
        code,
      ),
      `${file} must not write Knowledge itself`,
    );
  }
});
