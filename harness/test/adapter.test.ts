import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HARNESS_DB_PATH = join(
  mkdtempSync(join(tmpdir(), "harness-adapter-test-")),
  "harness.db",
);

const { db } = await import("../src/db.js");
const store = await import("../src/store.js");
const adapter = await import("../src/adapter.js");

const PROJECT = "adapter-test-project";
db.prepare(`INSERT INTO allowed_projects (lovable_project_id, label) VALUES (?, ?)`).run(
  PROJECT,
  "test",
);

const evidence = store.upsertHistoryItem({
  project_id: PROJECT,
  kind: "message",
  external_id: "m1",
  role: "user",
  content: "evidence content",
  provenance: "lovable_mcp",
}) as { id: number };

const episode = store.createTaskEpisode({
  project_id: PROJECT,
  title: "adapter test episode",
  provenance: "llm_derived",
  evidence_history_item_ids: [evidence.id],
}) as { id: number };

const correction = store.createCorrectionCandidate({
  task_episode_id: episode.id,
  classification: "other",
  is_correction: true,
  summary: "initial",
  evidence_history_item_ids: [evidence.id],
}) as { id: number };

test("local runtime adapter reads: listCorrections / getCorrection return real rows with evidence", () => {
  const list = adapter.listCorrections() as Record<string, unknown>[];
  assert.ok(list.some((r) => r.id === correction.id));

  const detail = adapter.getCorrection(correction.id) as {
    correction_candidate: Record<string, unknown>;
    evidence: Record<string, unknown>[];
  };
  assert.equal(detail.correction_candidate.id, correction.id);
  assert.equal(detail.evidence.length, 1);
});

test("provenance is returned correctly and distinguishable per item", () => {
  const detail = adapter.getCorrection(correction.id) as { evidence: { provenance: string }[] };
  assert.equal(detail.evidence[0].provenance, "lovable_mcp");
});

test("correction mutation validation: rejects an invalid action, accepts a valid one", () => {
  assert.throws(() => adapter.reviewCorrection({ id: correction.id, action: "not_a_real_action" }));
  const updated = adapter.reviewCorrection({ id: correction.id, action: "confirm" }) as {
    reviewed: number;
  };
  assert.equal(updated.reviewed, 1);
});

test("reclassification preserves previous classification in history", () => {
  const before = adapter.getCorrection(correction.id) as {
    correction_candidate: { classification: string };
  };
  assert.equal(before.correction_candidate.classification, "other");

  store.proposeReclassification({
    id: correction.id,
    new_classification: "constraint_restatement",
    reasoning: "test reasoning",
  });

  const after = adapter.getCorrection(correction.id) as {
    correction_candidate: { classification: string; reviewed: number };
    classification_history: { structured_output: string }[];
  };
  assert.equal(after.correction_candidate.classification, "constraint_restatement");
  assert.equal(
    after.correction_candidate.reviewed,
    0,
    "a proposed reclassification must leave it awaiting review",
  );
  assert.equal(after.classification_history.length, 1);
  const parsed = JSON.parse(after.classification_history[0].structured_output);
  assert.equal(parsed.previous_classification, "other");
  assert.equal(parsed.proposed_classification, "constraint_restatement");
});

let ruleId: number;
test("rule editing via the adapter creates a revision", () => {
  const learning = store.createLearning({
    correction_candidate_id: correction.id,
    observed_problem: "p",
    desired_behavior: "d",
    reuse_rationale: "r",
    proposed_scope: "project",
    provenance: "llm_derived",
    created_by: "test",
  }) as { id: number };
  const rule = store.createRule({
    learning_id: learning.id,
    correction_candidate_id: correction.id,
    instruction: "original instruction",
    scope: "project",
    applies_when: "always",
    predicted_failure: "failure",
    ownership: "harness",
    created_by: "test",
  }) as { id: number };
  ruleId = rule.id;

  adapter.updateRuleAction({
    id: ruleId,
    instruction: "revised instruction",
    actor: "operator (local UI)",
  });
  const revisions = db.prepare(`SELECT * FROM rule_revisions WHERE rule_id = ?`).all(ruleId);
  assert.equal(revisions.length, 1);
});

test("approval remains local only: state change through the adapter never leaves this process", () => {
  const approved = adapter.updateRuleAction({
    id: ruleId,
    state: "approved",
    actor: "operator (local UI)",
  }) as {
    state: string;
  };
  assert.equal(approved.state, "approved");

  for (const file of ["../src/adapter.ts", "../src/store.ts"]) {
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

test("no Lovable action is created by correction or rule review (audit trail is entirely local)", () => {
  const events = db.prepare(`SELECT kind FROM events ORDER BY id`).all() as { kind: string }[];
  assert.ok(events.length > 0);
  assert.ok(events.every((e) => !/lovable/i.test(e.kind)));
});

// ---- Round 3 re-exports ----

test("adapter re-exports per-project settings and the effective max reader", () => {
  assert.deepEqual(adapter.getProjectSettings(PROJECT), {
    max_active_rules: null,
    auto_write: true,
  });
  const patched = adapter.setProjectSettings(PROJECT, { max_active_rules: 5 });
  assert.deepEqual(patched, { max_active_rules: 5, auto_write: true });
  assert.equal(adapter.effectiveMaxActiveRules(PROJECT), 5);
});

test("adapter re-exports the LLM cost-this-month reader", () => {
  assert.equal(adapter.sumLlmCostThisMonth(), 0);
});

test("adapter re-exports demoLoaded", () => {
  assert.equal(adapter.demoLoaded(), false);
});

test("adapter re-exports the LLM key store under the documented aliases", () => {
  assert.deepEqual(adapter.llmKeyStatus().openai, { has_key: false, last4: null });
  adapter.setLlmKey("openai", "sk-adapter-test-1234");
  assert.deepEqual(adapter.llmKeyStatus().openai, { has_key: true, last4: "1234" });
  adapter.removeLlmKey("openai");
  assert.deepEqual(adapter.llmKeyStatus().openai, { has_key: false, last4: null });
});

test("adapter re-exports lineDiff", () => {
  assert.deepEqual(adapter.lineDiff("a\nb", "a\nc"), {
    added: 1,
    removed: 1,
    lines: [
      { kind: " ", text: "a" },
      { kind: "-", text: "b" },
      { kind: "+", text: "c" },
    ],
  });
});
