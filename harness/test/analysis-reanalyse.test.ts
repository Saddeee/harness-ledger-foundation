// Checkpoint 2026-09-18 WP5 (D7): "Reanalyse history"
// (harness/src/analysis/reanalyse.ts) -- estimate, the (never-coalesced)
// request, and the reanalyse pass itself: a disagreement with a
// human-reviewed decision opens a review item and touches nothing else; an
// unreviewed one is updated in place. No LLM call is ever made in this
// file: a fake CallLlm plays the role harness/test/analysis-classify.test.ts's
// own fake does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "harness-analysis-reanalyse-test-"));
process.env.HARNESS_DB_PATH = join(tmp, "harness.db");
process.env.HARNESS_AUTH_PATH = join(tmp, "lovable-auth.json");

const { db } = await import("../src/db.js");
const store = await import("../src/store.js");
const reanalyse = await import("../src/analysis/reanalyse.js");
const llmKeys = await import("../src/llm-keys.js");
import type { CallLlm, LlmRequest, LlmResult } from "../src/llm/types.js";

// ------------------------------------------------------------------ fakes

type Canned = { classification: string; tags: string[]; summary: string };

function fakeCallLlmFor(canned: Record<string, Canned>): CallLlm {
  return async function callLlm<T>(req: LlmRequest): Promise<LlmResult<T>> {
    const marker = "Message to classify:\n";
    const idx = req.user.indexOf(marker);
    const text = idx >= 0 ? req.user.slice(idx + marker.length) : req.user;
    const key = Object.keys(canned).find((k) => text.startsWith(k));
    if (!key) throw new Error(`fakeCallLlm: no canned response for "${text}"`);
    return {
      json: canned[key] as T,
      provider: "anthropic",
      model: "fake-classifier",
      tokensIn: 10,
      tokensOut: 5,
      costUsd: 0,
      latencyMs: 1,
    };
  };
}

let nextExternalId = 0;
function insertMessage(
  projectId: string,
  content: string,
  occurredAt: string,
): { id: number; external_id: string } {
  return store.upsertHistoryItem({
    project_id: projectId,
    kind: "message",
    role: "user",
    content,
    occurred_at: occurredAt,
    provenance: "lovable_mcp",
    external_id: `reext-${nextExternalId++}`,
  }) as { id: number; external_id: string };
}

/** A full evidence -> episode -> correction candidate -> learning -> rule
 * chain, the same minimal shape harness/test/analysis-classify.test.ts's own
 * "changed mind" fixture builds -- reviewed and, optionally, made live
 * (state beyond 'proposed'). */
function makeCorrectionCandidate(
  projectId: string,
  messageId: number,
  opts: { reviewed?: boolean; ruleState?: string } = {},
): { candidateId: number; ruleId: number } {
  const episode = store.createTaskEpisode({
    project_id: projectId,
    title: "episode",
    provenance: "manual",
    evidence_history_item_ids: [messageId],
  }) as { id: number };
  const cc = store.createCorrectionCandidate({
    task_episode_id: episode.id,
    classification: "constraint_restatement",
    is_correction: true,
    summary: "seed",
    evidence_history_item_ids: [messageId],
  }) as { id: number };
  if (opts.reviewed) {
    db.prepare(
      `UPDATE correction_candidates SET reviewed = 1, reviewed_at = datetime('now') WHERE id = ?`,
    ).run(cc.id);
  }
  const learning = store.createLearning({
    correction_candidate_id: cc.id,
    observed_problem: "p",
    desired_behavior: "Always do the thing.",
    reuse_rationale: "r",
    proposed_scope: "project",
    provenance: "manual",
    created_by: "test",
  }) as { id: number };
  const rule = store.createRule({
    learning_id: learning.id,
    correction_candidate_id: cc.id,
    instruction: "Always do the thing.",
    scope: "project",
    applies_when: "always",
    predicted_failure: "the thing is not done",
    ownership: "harness",
    created_by: "test",
  }) as { id: number };
  if (opts.ruleState) {
    store.updateRule({ id: rule.id, state: opts.ruleState as never, actor: "test" });
  }
  return { candidateId: cc.id, ruleId: rule.id };
}

function ts(minute: number): string {
  return `2026-09-06T09:${String(minute).padStart(2, "0")}:00.000Z`;
}

const SCOPE_FROM = "2026-09-06";
const SCOPE_TO = "2026-09-07";

// ------------------------------------------------------------------ tests

test("runReanalysisPass: a human-reviewed candidate whose new classification disagrees opens a disagreement and changes nothing else (candidate and rule rows byte-identical before/after)", async () => {
  const PROJECT = "proj-reanalyse-reviewed";
  store.allowProject(PROJECT, "Reanalyse reviewed");

  const msg = insertMessage(PROJECT, "The button is the wrong color, please fix it.", ts(0));
  store.insertMessageClassification({
    history_item_id: msg.id,
    classification: "correction",
    tags: [],
    summary: "Wrong button color.",
    run_id: null,
  });
  const { candidateId, ruleId } = makeCorrectionCandidate(PROJECT, msg.id, {
    reviewed: true,
    ruleState: "active",
  });

  const candidateBefore = db
    .prepare(`SELECT * FROM correction_candidates WHERE id = ?`)
    .get(candidateId);
  const ruleBefore = db.prepare(`SELECT * FROM rules WHERE id = ?`).get(ruleId);
  const classificationBefore = db
    .prepare(`SELECT * FROM message_classifications WHERE history_item_id = ?`)
    .get(msg.id);

  const runId = store.startAnalysisRun("manual");
  const callLlm = fakeCallLlmFor({
    "The button is the wrong color, please fix it.": {
      classification: "new_task", // disagrees with the stored 'correction'
      tags: [],
      summary: "Change button color.",
    },
  });
  const result = await reanalyse.runReanalysisPass(
    callLlm,
    { project_ids: [PROJECT], from: SCOPE_FROM, to: SCOPE_TO, include_reviewed: true },
    runId,
  );
  assert.deepEqual(result, { updated: 0, disagreements: 1, failed: 0 });

  const candidateAfter = db
    .prepare(`SELECT * FROM correction_candidates WHERE id = ?`)
    .get(candidateId);
  const ruleAfter = db.prepare(`SELECT * FROM rules WHERE id = ?`).get(ruleId);
  const classificationAfter = db
    .prepare(`SELECT * FROM message_classifications WHERE history_item_id = ?`)
    .get(msg.id);
  assert.deepEqual(candidateAfter, candidateBefore, "the reviewed candidate is byte-identical");
  assert.deepEqual(ruleAfter, ruleBefore, "the live rule is byte-identical");
  assert.deepEqual(
    classificationAfter,
    classificationBefore,
    "the existing classification is left untouched, not overwritten",
  );

  const disagreements = reanalyse.listAnalysisDisagreements("open");
  assert.equal(disagreements.length, 1);
  assert.equal(disagreements[0]!.correction_candidate_id, candidateId);
  const previous = JSON.parse(disagreements[0]!.previous_json) as { classification: string };
  const proposed = JSON.parse(disagreements[0]!.proposed_json) as { classification: string };
  assert.equal(previous.classification, "correction");
  assert.equal(proposed.classification, "new_task");
});

test("runReanalysisPass: an unreviewed candidate is updated in place, no disagreement", async () => {
  const PROJECT = "proj-reanalyse-unreviewed";
  store.allowProject(PROJECT, "Reanalyse unreviewed");

  const msg = insertMessage(PROJECT, "Also the header should be sticky.", ts(1));
  store.insertMessageClassification({
    history_item_id: msg.id,
    classification: "other",
    tags: [],
    summary: "old summary",
    run_id: null,
  });
  // Not reviewed, no decided_by, rule left at 'proposed'.
  const { candidateId } = makeCorrectionCandidate(PROJECT, msg.id, {});

  const runId = store.startAnalysisRun("manual");
  const callLlm = fakeCallLlmFor({
    "Also the header should be sticky.": {
      classification: "correction",
      tags: ["layout"],
      summary: "Header should stick.",
    },
  });
  const result = await reanalyse.runReanalysisPass(
    callLlm,
    { project_ids: [PROJECT], from: SCOPE_FROM, to: SCOPE_TO, include_reviewed: true },
    runId,
  );
  assert.deepEqual(result, { updated: 1, disagreements: 0, failed: 0 });
  assert.equal(
    reanalyse
      .listAnalysisDisagreements("open")
      .filter((d) => d.correction_candidate_id === candidateId).length,
    0,
  );

  const row = db
    .prepare(
      `SELECT classification, summary, content_hash, prompt_version FROM message_classifications WHERE history_item_id = ?`,
    )
    .get(msg.id) as {
    classification: string;
    summary: string;
    content_hash: string;
    prompt_version: string;
  };
  assert.equal(row.classification, "correction");
  assert.equal(row.summary, "Header should stick.");
  assert.ok(row.content_hash);
  assert.ok(row.prompt_version);
});

test("runReanalysisPass: a message with no existing classification is classified fresh, in scope", async () => {
  const PROJECT = "proj-reanalyse-fresh";
  store.allowProject(PROJECT, "Reanalyse fresh");
  const msg = insertMessage(PROJECT, "The export button downloads an empty file.", ts(2));

  const runId = store.startAnalysisRun("manual");
  const callLlm = fakeCallLlmFor({
    "The export button downloads an empty file.": {
      classification: "correction",
      tags: [],
      summary: "Export produces an empty file.",
    },
  });
  const result = await reanalyse.runReanalysisPass(
    callLlm,
    { project_ids: [PROJECT], from: SCOPE_FROM, to: SCOPE_TO, include_reviewed: true },
    runId,
  );
  assert.deepEqual(result, { updated: 1, disagreements: 0, failed: 0 });
  const row = db
    .prepare(`SELECT classification FROM message_classifications WHERE history_item_id = ?`)
    .get(msg.id) as { classification: string };
  assert.equal(row.classification, "correction");
});

test("estimateReanalysis: candidate counts and the documented token formula (sum(ceil(chars/4)) * roles + 200/message)", () => {
  const PROJECT = "proj-reanalyse-estimate";
  store.allowProject(PROJECT, "Reanalyse estimate");
  llmKeys.setKey("openai", "sk-test-not-a-real-key");

  const a = insertMessage(PROJECT, "a".repeat(40), ts(3));
  const b = insertMessage(PROJECT, "b".repeat(80), ts(4));
  void a;
  void b;

  const estimate = reanalyse.estimateReanalysis({
    project_ids: [PROJECT],
    from: SCOPE_FROM,
    to: SCOPE_TO,
    include_reviewed: true,
  });
  assert.equal(estimate.messages, 2);
  // formula: ceil(40/4) + ceil(80/4) = 10 + 20 = 30, times 1 role, plus
  // 200 * 2 messages = 400 -- total 430.
  assert.equal(estimate.estimated_tokens, 30 + 200 * 2);
  assert.equal(estimate.models.classifier.provider, "openai");
  assert.ok(estimate.budget_remaining >= 0);
});

test("estimateReanalysis: include_reviewed=false excludes messages linked to a reviewed candidate; empty project_ids means every allowed project", () => {
  const PROJECT = "proj-reanalyse-estimate-reviewed";
  store.allowProject(PROJECT, "Reanalyse estimate reviewed");

  const reviewedMsg = insertMessage(PROJECT, "Reviewed already.", ts(5));
  store.insertMessageClassification({
    history_item_id: reviewedMsg.id,
    classification: "correction",
    tags: [],
    summary: "s",
    run_id: null,
  });
  makeCorrectionCandidate(PROJECT, reviewedMsg.id, { reviewed: true });
  insertMessage(PROJECT, "Not reviewed yet.", ts(6));

  const excludeReviewed = reanalyse.estimateReanalysis({
    project_ids: [PROJECT],
    from: SCOPE_FROM,
    to: SCOPE_TO,
    include_reviewed: false,
  });
  assert.equal(excludeReviewed.messages, 1, "the reviewed message is excluded by default");

  const includeReviewed = reanalyse.estimateReanalysis({
    project_ids: [PROJECT],
    from: SCOPE_FROM,
    to: SCOPE_TO,
    include_reviewed: true,
  });
  assert.equal(includeReviewed.messages, 2);

  // Empty project_ids resolves to every allowed project -- at least this one.
  const allProjects = reanalyse.estimateReanalysis({
    project_ids: [],
    from: SCOPE_FROM,
    to: SCOPE_TO,
    include_reviewed: true,
  });
  assert.ok(allProjects.messages >= 2);
});

test("requestReanalysis: inserts a mode='reanalyse' request that is never coalesced (two calls create two rows)", () => {
  const before = db
    .prepare(`SELECT COUNT(*) as n FROM analysis_requests WHERE mode = 'reanalyse'`)
    .get() as { n: number };

  const scope = {
    project_ids: ["proj-x"],
    from: SCOPE_FROM,
    to: SCOPE_TO,
    include_reviewed: false,
  };
  const first = reanalyse.requestReanalysis(scope, "checking a hunch");
  const second = reanalyse.requestReanalysis(scope, "checking again");
  assert.notEqual(first.id, second.id, "not coalesced -- two distinct rows");

  const after = db
    .prepare(`SELECT COUNT(*) as n FROM analysis_requests WHERE mode = 'reanalyse'`)
    .get() as { n: number };
  assert.equal(after.n, before.n + 2);

  const row = reanalyse.getAnalysisRequest(first.id)!;
  assert.equal(row.mode, "reanalyse");
  assert.ok(row.scope_json);
  const parsed = JSON.parse(row.scope_json!) as { reason: string; from: string };
  assert.equal(parsed.reason, "checking a hunch");
  assert.equal(parsed.from, SCOPE_FROM);
  assert.equal(row.status, "requested");
});

test("acceptDisagreement applies the proposed classification to message_classifications only, and dismissDisagreement leaves it untouched", async () => {
  const PROJECT = "proj-reanalyse-accept";
  store.allowProject(PROJECT, "Reanalyse accept");
  const msg1 = insertMessage(PROJECT, "First disputed message.", ts(7));
  const msg2 = insertMessage(PROJECT, "Second disputed message.", ts(8));
  store.insertMessageClassification({
    history_item_id: msg1.id,
    classification: "correction",
    tags: [],
    summary: "s1",
    run_id: null,
  });
  store.insertMessageClassification({
    history_item_id: msg2.id,
    classification: "correction",
    tags: [],
    summary: "s2",
    run_id: null,
  });
  const { candidateId: cand1 } = makeCorrectionCandidate(PROJECT, msg1.id, { reviewed: true });
  const { candidateId: cand2, ruleId: rule2 } = makeCorrectionCandidate(PROJECT, msg2.id, {
    reviewed: true,
  });

  const runId = store.startAnalysisRun("manual");
  const callLlm = fakeCallLlmFor({
    "First disputed message.": { classification: "new_task", tags: [], summary: "changed 1" },
    "Second disputed message.": { classification: "question", tags: [], summary: "changed 2" },
  });
  await reanalyse.runReanalysisPass(
    callLlm,
    { project_ids: [PROJECT], from: SCOPE_FROM, to: SCOPE_TO, include_reviewed: true },
    runId,
  );
  const disagreements = reanalyse.listAnalysisDisagreements("open");
  const d1 = disagreements.find((d) => d.correction_candidate_id === cand1)!;
  const d2 = disagreements.find((d) => d.correction_candidate_id === cand2)!;
  assert.ok(d1);
  assert.ok(d2);

  const candidateBefore = db.prepare(`SELECT * FROM correction_candidates WHERE id = ?`).get(cand2);
  const ruleBefore = db.prepare(`SELECT * FROM rules WHERE id = ?`).get(rule2);

  reanalyse.acceptDisagreement(d1.id);
  reanalyse.dismissDisagreement(d2.id);

  const row1 = db
    .prepare(`SELECT classification FROM message_classifications WHERE history_item_id = ?`)
    .get(msg1.id) as { classification: string };
  assert.equal(
    row1.classification,
    "new_task",
    "accepted disagreement applied to the classification",
  );

  const row2 = db
    .prepare(`SELECT classification FROM message_classifications WHERE history_item_id = ?`)
    .get(msg2.id) as { classification: string };
  assert.equal(
    row2.classification,
    "correction",
    "dismissed disagreement leaves the classification alone",
  );

  assert.deepEqual(
    db.prepare(`SELECT * FROM correction_candidates WHERE id = ?`).get(cand2),
    candidateBefore,
    "accept/dismiss never touch the candidate row",
  );
  assert.deepEqual(
    db.prepare(`SELECT * FROM rules WHERE id = ?`).get(rule2),
    ruleBefore,
    "accept/dismiss never touch the rule row",
  );

  const statuses = db
    .prepare(`SELECT id, status FROM analysis_disagreements WHERE id IN (?, ?)`)
    .all(d1.id, d2.id) as { id: number; status: string }[];
  assert.deepEqual(Object.fromEntries(statuses.map((s) => [s.id, s.status])), {
    [d1.id]: "accepted",
    [d2.id]: "dismissed",
  });
});
