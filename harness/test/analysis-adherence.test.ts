// Round 5 Task 7 / spec §5 item 3: unit tests for the adherence Judge
// (harness/src/analysis/adherence.ts) -- a fake CallLlm (no network, no real
// LLM) over a real temp SQLite DB, same convention as
// analysis-classify.test.ts / analysis-propose.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "harness-analysis-adherence-test-"));
process.env.HARNESS_DB_PATH = join(tmp, "harness.db");
process.env.HARNESS_AUTH_PATH = join(tmp, "lovable-auth.json");

const { db } = await import("../src/db.js");
const store = await import("../src/store.js");
const adherence = await import("../src/analysis/adherence.js");
import type { CallLlm, LlmRequest, LlmResult } from "../src/llm/types.js";
import { LlmBudgetExceeded } from "../src/llm/types.js";

// ------------------------------------------------------------------ fakes

type Canned = { verdict: string; quote: string | null };

/**
 * A fake CallLlm keyed by a substring of the assembled user prompt (in
 * practice, a unique fragment of the episode's reply text, which
 * judgeUserPrompt always includes) -- so each test controls the judged
 * verdict per episode rather than per call order.
 */
function fakeJudgeCallLlm(entries: { match: string; json?: Canned; throw?: Error }[]): CallLlm {
  return async function callLlm<T>(req: LlmRequest): Promise<LlmResult<T>> {
    const entry = entries.find((e) => req.user.includes(e.match));
    if (!entry) throw new Error(`fakeJudgeCallLlm: no canned response matching:\n${req.user}`);
    if (entry.throw) throw entry.throw;
    return {
      json: entry.json as T,
      provider: "anthropic",
      model: "fake-judge",
      tokensIn: 50,
      tokensOut: 20,
      costUsd: 0,
      latencyMs: 1,
    };
  };
}

// ------------------------------------------------------------------ fixtures

let nextExternalId = 0;
function message(
  projectId: string,
  role: "user" | "assistant",
  content: string,
  occurredAt: string,
) {
  return store.upsertHistoryItem({
    project_id: projectId,
    kind: "message",
    role,
    content,
    occurred_at: occurredAt,
    provenance: "lovable_mcp",
    external_id: `ext-${nextExternalId++}`,
  }) as { id: number };
}

// One episode: a user request (evidence) plus one assistant reply in the
// same time window, so episodeTextForJudge's request/reply reads both
// resolve to real text.
function episode(
  projectId: string,
  startedAt: string,
  endedAt: string,
  requestText: string,
  replyText: string,
): { id: number } {
  const req = message(projectId, "user", requestText, startedAt);
  message(
    projectId,
    "assistant",
    `<lov-tool-use id="x" name="user_messaging--message_user" data="{\\"message\\": \\"${replyText}\\"}">\n</lov-tool-use>`,
    endedAt,
  );
  return store.createTaskEpisode({
    project_id: projectId,
    title: requestText,
    provenance: "llm_derived",
    started_at: startedAt,
    ended_at: endedAt,
    evidence_history_item_ids: [req.id],
  }) as { id: number };
}

// A live rule (state 'active', with a 'written' knowledge_versions row
// backdated to writtenAt), matching rule-health.test.ts's own makeLiveRule
// fixture -- listLiveRulesWithTargets (what judgeAdherence works from)
// requires exactly this shape.
function makeLiveRule(projectId: string, instruction: string, writtenAt: string): number {
  const seedEpisode = store.createTaskEpisode({
    project_id: projectId,
    title: "seed episode",
    provenance: "llm_derived",
    started_at: writtenAt,
    evidence_history_item_ids: [],
  }) as { id: number };
  const cc = store.createCorrectionCandidate({
    task_episode_id: seedEpisode.id,
    classification: "constraint_restatement",
    is_correction: true,
    reusable: true,
    proposed_scope: "project",
    summary: "seed correction for a judge fixture",
    evidence_history_item_ids: [],
  }) as { id: number };
  const learning = store.createLearning({
    correction_candidate_id: cc.id,
    observed_problem: "seed",
    desired_behavior: "seed",
    reuse_rationale: "seed",
    proposed_scope: "project",
    provenance: "llm_derived",
    created_by: "test",
  }) as { id: number };
  const rule = store.createRule({
    learning_id: learning.id,
    correction_candidate_id: cc.id,
    instruction,
    scope: "project",
    applies_when: "n/a",
    predicted_failure: "n/a",
    ownership: "harness",
    created_by: "test",
  }) as { id: number };
  store.updateRule({ id: rule.id, state: "active", actor: "test" });
  db.prepare(
    `INSERT INTO knowledge_versions
       (rule_id, target, project_id, previous_content, new_content, previous_sha256, new_sha256, rule_ids_json, status, actor, written_at)
     VALUES (?, 'project', ?, '', '', '', '', '[]', 'written', 'test', ?)`,
  ).run(rule.id, projectId, writtenAt);
  return rule.id;
}

// ------------------------------------------------------------------ tests

test("judgeAdherence: writes a judged row per episode; an invalid quote (not a substring of the reply) is stored as null; a repeat run does not re-judge", async () => {
  const PROJECT = "judge-project-a";
  store.allowProject(PROJECT, "Judge Project A");
  const ruleId = makeLiveRule(
    PROJECT,
    "Always use design tokens, not hardcoded colors.",
    "2026-09-01T00:00:00Z",
  );

  const epFollowed = episode(
    PROJECT,
    "2026-09-02T00:00:00Z",
    "2026-09-02T01:00:00Z",
    "Make the CTA button blue.",
    "Updated the button to use the primary design token instead of a hardcoded color.",
  );
  const epBroke = episode(
    PROJECT,
    "2026-09-03T00:00:00Z",
    "2026-09-03T01:00:00Z",
    "Update the card background.",
    "Set the card background to a plain hex color for now.",
  );

  const result = await adherence.judgeAdherence(
    fakeJudgeCallLlm([
      {
        match: "primary design token",
        json: {
          verdict: "followed",
          quote: "use the primary design token instead of a hardcoded color",
        },
      },
      {
        // The model's quote does not appear verbatim in the reply text --
        // must be stored as null, not the model's paraphrase.
        match: "plain hex color",
        json: { verdict: "broke", quote: "used a hardcoded hex value, breaking the rule" },
      },
    ]),
    { limit: 10, runId: 1 },
  );
  assert.deepEqual(result, { judged: 2, failed: 0 });

  const rows = store.listRuleAdherence(ruleId);
  assert.equal(rows.length, 2);

  const followedRow = rows.find((r) => r.task_episode_id === epFollowed.id)!;
  assert.equal(followedRow.verdict, "followed");
  assert.equal(followedRow.quote, "use the primary design token instead of a hardcoded color");

  const brokeRow = rows.find((r) => r.task_episode_id === epBroke.id)!;
  assert.equal(brokeRow.verdict, "broke");
  assert.equal(brokeRow.quote, null, "a quote not found verbatim in the reply must be null");

  // Idempotent: both episodes already have a rule_adherence row, so a
  // second call finds nothing left to judge for this rule.
  const second = await adherence.judgeAdherence(
    fakeJudgeCallLlm([]), // no canned response needed -- must never be called
    { limit: 10, runId: 2 },
  );
  assert.deepEqual(second, { judged: 0, failed: 0 });
  assert.equal(store.listRuleAdherence(ruleId).length, 2, "no duplicate rows from the repeat run");
});

test("judgeAdherence: an unrecognized verdict falls back to not_applicable, and not_applicable never carries a quote", async () => {
  const PROJECT = "judge-project-fallback";
  store.allowProject(PROJECT, "Judge Project Fallback");
  const ruleId = makeLiveRule(PROJECT, "Always paginate long lists.", "2026-09-01T00:00:00Z");

  const ep = episode(
    PROJECT,
    "2026-09-02T00:00:00Z",
    "2026-09-02T01:00:00Z",
    "Add a settings tab.",
    "Added a dark mode toggle to settings.",
  );

  const result = await adherence.judgeAdherence(
    fakeJudgeCallLlm([
      {
        match: "dark mode toggle",
        json: { verdict: "maybe", quote: "dark mode toggle to settings" },
      },
    ]),
    { limit: 10, runId: 3 },
  );
  assert.deepEqual(result, { judged: 1, failed: 0 });

  const row = store.listRuleAdherence(ruleId).find((r) => r.task_episode_id === ep.id)!;
  assert.equal(row.verdict, "not_applicable");
  assert.equal(row.quote, null);
});

test("judgeAdherence: limit is respected across a rule's own episodes", async () => {
  const PROJECT = "judge-project-limit";
  store.allowProject(PROJECT, "Judge Project Limit");
  const ruleId = makeLiveRule(
    PROJECT,
    "Always confirm destructive actions.",
    "2026-09-01T00:00:00Z",
  );

  episode(
    PROJECT,
    "2026-09-02T00:00:00Z",
    "2026-09-02T01:00:00Z",
    "Delete the draft posts.",
    "Deleted the draft posts after confirmation.",
  );
  episode(
    PROJECT,
    "2026-09-03T00:00:00Z",
    "2026-09-03T01:00:00Z",
    "Clear the cache.",
    "Cleared the cache after confirmation.",
  );
  const thirdEpisode = episode(
    PROJECT,
    "2026-09-04T00:00:00Z",
    "2026-09-04T01:00:00Z",
    "Reset the demo data.",
    "Reset the demo data after confirmation.",
  );

  const result = await adherence.judgeAdherence(
    fakeJudgeCallLlm([
      {
        match: "draft posts after confirmation",
        json: { verdict: "followed", quote: "after confirmation" },
      },
      {
        match: "cache after confirmation",
        json: { verdict: "followed", quote: "after confirmation" },
      },
      {
        match: "demo data after confirmation",
        json: { verdict: "followed", quote: "after confirmation" },
      },
    ]),
    { limit: 2, runId: 4 },
  );
  assert.deepEqual(result, { judged: 2, failed: 0 });
  assert.equal(store.listRuleAdherence(ruleId).length, 2, "only 2 of the 3 episodes were judged");

  // Drain the deliberately-unjudged third episode (same convention as
  // analysis-classify.test.ts's own budget-stop test) so it doesn't leak
  // into a later test's judgeAdherence call in this same shared-DB file --
  // judgeAdherence sweeps every live rule, not just the one under test.
  store.recordRuleAdherence({
    rule_id: ruleId,
    task_episode_id: thirdEpisode.id,
    verdict: "not_applicable",
    quote: null,
    llm_call_id: null,
    run_id: null,
  });
});

test("judgeAdherence: a budget-exceeded error stops the whole run and counts as one failure", async () => {
  const PROJECT = "judge-project-budget";
  store.allowProject(PROJECT, "Judge Project Budget");
  const ruleId = makeLiveRule(PROJECT, "Always keep the footer visible.", "2026-09-01T00:00:00Z");

  const first = episode(
    PROJECT,
    "2026-09-02T00:00:00Z",
    "2026-09-02T01:00:00Z",
    "Redesign the footer.",
    "This build should blow the token budget.",
  );
  const second = episode(
    PROJECT,
    "2026-09-03T00:00:00Z",
    "2026-09-03T01:00:00Z",
    "Add a footer newsletter signup.",
    "This message must never be reached.",
  );

  const result = await adherence.judgeAdherence(
    fakeJudgeCallLlm([
      { match: "blow the token budget", throw: new LlmBudgetExceeded(2_000_000, 2_000_000) },
      {
        match: "must never be reached",
        json: { verdict: "followed", quote: "must never be reached" },
      },
    ]),
    { limit: 10, runId: 5 },
  );
  assert.deepEqual(result, { judged: 0, failed: 1 });
  assert.equal(
    store.listRuleAdherence(ruleId).length,
    0,
    "the loop must stop before the second episode",
  );

  // Neither episode was ever attempted (the budget stop returns before the
  // second one), so both stay unjudged forever -- drain them directly so
  // they don't leak into a later test's judgeAdherence call in this same
  // shared-DB file.
  for (const ep of [first, second]) {
    store.recordRuleAdherence({
      rule_id: ruleId,
      task_episode_id: ep.id,
      verdict: "not_applicable",
      quote: null,
      llm_call_id: null,
      run_id: null,
    });
  }
});

test("judgeAdherence: a non-budget provider error is counted as failed and the loop continues", async () => {
  const PROJECT = "judge-project-errors";
  store.allowProject(PROJECT, "Judge Project Errors");
  const ruleId = makeLiveRule(PROJECT, "Always use semantic HTML.", "2026-09-01T00:00:00Z");

  const failing = episode(
    PROJECT,
    "2026-09-02T00:00:00Z",
    "2026-09-02T01:00:00Z",
    "Add a banner.",
    "This one fails with a generic provider error.",
  );
  const ok = episode(
    PROJECT,
    "2026-09-03T00:00:00Z",
    "2026-09-03T01:00:00Z",
    "Add a footer.",
    "Used a semantic footer element.",
  );

  const result = await adherence.judgeAdherence(
    fakeJudgeCallLlm([
      { match: "generic provider error", throw: new Error("simulated provider failure") },
      {
        match: "semantic footer element",
        json: { verdict: "followed", quote: "semantic footer element" },
      },
    ]),
    { limit: 10, runId: 6 },
  );
  assert.deepEqual(result, { judged: 1, failed: 1 });

  const rows = store.listRuleAdherence(ruleId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.task_episode_id, ok.id);

  // No row was ever written for the failed episode (same convention as
  // classifyPending/proposeRules on a non-budget error) -- it stays
  // "unjudged" and is picked up again on a later run.
  const stillUnjudged = store
    .listUnjudgedEpisodesForRule(ruleId, "2026-09-01T00:00:00Z", PROJECT, 10)
    .map((e) => e.id);
  assert.deepEqual(stillUnjudged, [failing.id]);
});
