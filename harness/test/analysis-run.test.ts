// Round 4 Task A3: analysis runs and the "Analyse now" trigger
// (harness/src/analysis/run.ts). No LLM call is ever made in this file --
// every test injects a fake CallLlm (which, like the real
// harness/src/llm/index.ts, logs every attempt to llm_calls with the run
// id, since that's the table runAnalysis's own tokens/costUsd are summed
// from -- see harness/src/store.ts's sumLlmTokensForRun/sumLlmCostForRun).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "harness-analysis-run-test-"));
process.env.HARNESS_DB_PATH = join(tmp, "harness.db");
// Keep the auth file out of the real data directory: nothing here connects.
process.env.HARNESS_AUTH_PATH = join(tmp, "lovable-auth.json");

const { db } = await import("../src/db.js");
const store = await import("../src/store.js");
const llmKeys = await import("../src/llm-keys.js");
const run = await import("../src/analysis/run.js");
import type { CallLlm, LlmRequest, LlmResult } from "../src/llm/types.js";

// ------------------------------------------------------------------ fakes

type ClassifierCanned = { classification: string; tags: string[]; summary: string };

/**
 * A fake CallLlm covering both roles runAnalysis actually dispatches
 * (classifier, rule_writer -- segmentAllProjects makes no LLM call at all).
 * Classifier responses are keyed by the message text (matching
 * analysis-classify.test.ts's own fake); rule_writer responses are keyed by a
 * substring of the assembled rule writer prompt (matching
 * analysis-propose.test.ts's own fake). Every successful call logs to
 * llm_calls with `run_id` -- exactly the side effect the real
 * harness/src/llm/index.ts's createCallLlm always has, and the one
 * sumLlmTokensForRun/sumLlmCostForRun read back from.
 */
function fakeCallLlm(opts: {
  classify?: Record<string, ClassifierCanned>;
  mine?: { match: string; json: Record<string, unknown> }[];
}): CallLlm {
  return async function callLlm<T>(req: LlmRequest): Promise<LlmResult<T>> {
    let json: unknown;
    if (req.role === "classifier") {
      const marker = "Message to classify:\n";
      const idx = req.user.indexOf(marker);
      const text = idx >= 0 ? req.user.slice(idx + marker.length) : req.user;
      const key = Object.keys(opts.classify ?? {}).find((k) => text.startsWith(k));
      if (!key) throw new Error(`fakeCallLlm: no canned classifier response for "${text}"`);
      json = (opts.classify as Record<string, ClassifierCanned>)[key];
    } else if (req.role === "rule_writer") {
      const entry = (opts.mine ?? []).find((e) => req.user.includes(e.match));
      if (!entry)
        throw new Error(`fakeCallLlm: no canned rule writer response matching:\n${req.user}`);
      json = entry.json;
    } else {
      throw new Error(`fakeCallLlm: unexpected role "${req.role}"`);
    }

    const result: LlmResult<T> = {
      json: json as T,
      provider: "anthropic",
      model: "fake-model",
      tokensIn: 100,
      tokensOut: 50,
      costUsd: 0.01,
      latencyMs: 1,
    };
    store.insertLlmCall({
      role: req.role,
      provider: result.provider,
      model: result.model,
      tokens_in: result.tokensIn,
      tokens_out: result.tokensOut,
      cost_usd: result.costUsd ?? 0,
      estimated_tokens: 0,
      run_id: req.runId ?? null,
    });
    return result;
  };
}

let nextExternalId = 0;
function insertMessage(
  projectId: string,
  role: "user" | "assistant",
  content: string,
  occurredAt: string,
): { id: number; external_id: string } {
  return store.upsertHistoryItem({
    project_id: projectId,
    kind: "message",
    role,
    content,
    occurred_at: occurredAt,
    provenance: "lovable_mcp",
    external_id: `ext-${nextExternalId++}`,
  }) as { id: number; external_id: string };
}

function ts(minute: number): string {
  return `2026-09-02T09:${String(minute).padStart(2, "0")}:00.000Z`;
}

function requestStatus(id: number): string {
  const row = db.prepare(`SELECT status FROM analysis_requests WHERE id = ?`).get(id) as {
    status: string;
  };
  return row.status;
}

// ------------------------------------------------------------------ tests

test("runAnalysis: provider not ready (no API key) finishes ok:false with the reason, makes no LLM call, and still completes the request", async () => {
  // No key has been stored anywhere in this fresh temp dir yet, and the
  // default llm_provider/llm_models are both "openai" -- providerReady must
  // refuse before classify/segment/mine ever run.
  const { id: requestId } = store.requestAnalysis();

  const result = await run.runAnalysis(fakeCallLlm({}));

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /No API key saved for OpenAI/);
  assert.deepEqual(result.counts, {
    classified: 0,
    failed: 0,
    episodes_created: 0,
    proposed: 0,
    skipped_duplicate: 0,
    rejected: 0,
    auto_accepted: 0,
    judged: 0,
    judge_failed: 0,
  });
  assert.equal(result.tokens, 0);
  assert.equal(result.costUsd, 0);

  const calls = db
    .prepare(`SELECT COUNT(*) as n FROM llm_calls WHERE run_id = ?`)
    .get(result.runId) as { n: number };
  assert.equal(calls.n, 0, "no LLM call was made when the provider was not ready");

  assert.equal(requestStatus(requestId), "done", "the open request is still completed");
});

test("runAnalysis: main path -- consumes an open request, classifies, segments, mines, and sums tokens/cost from logged llm_calls", async () => {
  llmKeys.setKey("openai", "sk-test-not-a-real-key");

  const PROJECT = "proj-run-main";
  store.allowProject(PROJECT, "Run Main");

  const requestMsg = insertMessage(
    PROJECT,
    "user",
    "Build a signup form with email verification.",
    ts(0),
  );
  const correctionMsg = insertMessage(
    PROJECT,
    "user",
    "The signup form never sends the verification email, that's broken.",
    ts(1),
  );

  const { id: requestId } = store.requestAnalysis();
  assert.equal(store.hasOpenAnalysisRequest(), true);

  const callLlm = fakeCallLlm({
    classify: {
      "Build a signup form with email verification.": {
        classification: "new_task",
        tags: ["forms"],
        summary: "Add a signup form with email verification.",
      },
      "The signup form never sends the verification email, that's broken.": {
        classification: "correction",
        tags: ["forms"],
        summary: "Fix missing verification email on signup.",
      },
    },
    mine: [
      {
        match: "Build a signup form with email verification.",
        json: {
          propose: true,
          instruction: "Always send a verification email immediately after signup.",
          scope: "project",
          prediction: "Signup silently skips sending the verification email.",
          failure_signature: "missing-verification-email",
          evidence_message_ids: [correctionMsg.external_id],
          confidence: 0.9,
          contradicts_rule_id: null,
          duplicate_of_rule_id: null,
        },
      },
    ],
  });

  const result = await run.runAnalysis(callLlm);

  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.counts, {
    classified: 2,
    failed: 0,
    episodes_created: 1,
    proposed: 1,
    skipped_duplicate: 0,
    rejected: 0,
    // decision_mode defaults to "ask" -- this run's own proposal is left
    // for the user, never auto-accepted (see the dedicated
    // analysis-auto-accept.test.ts for the automatic-mode path).
    auto_accepted: 0,
    // Round 5 Task 7: no rule is live yet (the one this run just proposed
    // is still 'proposed', not written to Lovable), so the adherence judge
    // finds nothing to score and never calls the LLM at all.
    judged: 0,
    judge_failed: 0,
  });

  // Three real calls were made (2 classify + 1 rule_writer), each logging
  // tokensIn:100/tokensOut:50/costUsd:0.01 -- runAnalysis's tokens/costUsd
  // must equal exactly what's in llm_calls for this run id.
  assert.equal(result.tokens, store.sumLlmTokensForRun(result.runId));
  assert.equal(result.costUsd, store.sumLlmCostForRun(result.runId));
  assert.equal(result.tokens, 3 * (100 + 50));
  assert.ok(Math.abs(result.costUsd - 3 * 0.01) < 1e-9);

  const loggedCalls = db
    .prepare(`SELECT role FROM llm_calls WHERE run_id = ? ORDER BY id`)
    .all(result.runId) as { role: string }[];
  assert.deepEqual(
    loggedCalls.map((c) => c.role).sort(),
    ["classifier", "classifier", "rule_writer"].sort(),
  );

  assert.equal(requestStatus(requestId), "done");
  assert.equal(store.hasOpenAnalysisRequest(), false);

  // The finished analysis_runs row itself carries the same tokens/cost.
  const finished = store.latestAnalysisRun();
  assert.equal(finished?.id, result.runId);
  assert.equal(finished?.ok, true);
  assert.equal(finished?.tokens, result.tokens);

  void requestMsg;
});

test("runAnalysis: a step that throws (segment hits corrupted data) finishes ok:false with the message, and still completes the request", async () => {
  llmKeys.setKey("openai", "sk-test-not-a-real-key");

  const PROJECT = "proj-run-throws";
  store.allowProject(PROJECT, "Run Throws");

  const msg = insertMessage(PROJECT, "user", "Add a settings page.", ts(0));
  // Classify it directly (bypassing the LLM) so classifyPending finds
  // nothing pending -- this test is about segmentAllProjects blowing up on
  // bad data, not about the classifier.
  store.insertMessageClassification({
    history_item_id: msg.id,
    classification: "new_task",
    tags: ["general"],
    summary: "Add a settings page.",
    run_id: null,
  });
  // Corrupt tags_json directly via raw SQL (insertMessageClassification
  // always writes valid JSON; a real bug or a hand-edited row is the only
  // way this happens) -- listClassifiedUserMessages does a bare
  // JSON.parse(row.tags_json) with no try/catch, so segmentEpisodes (called
  // directly by runAnalysis, with no per-item try/catch of its own, unlike
  // classify/mine) throws all the way out to runAnalysis's own catch.
  db.prepare(`UPDATE message_classifications SET tags_json = ? WHERE history_item_id = ?`).run(
    "not-json",
    msg.id,
  );

  const { id: requestId } = store.requestAnalysis();

  const result = await run.runAnalysis(fakeCallLlm({}));

  assert.equal(result.ok, false);
  assert.ok(result.error && result.error.length > 0, "error carries the thrown message");
  assert.equal(
    requestStatus(requestId),
    "done",
    "the request is completed even though the run failed",
  );

  const finished = store.latestAnalysisRun();
  assert.equal(finished?.id, result.runId);
  assert.equal(finished?.ok, false);
  assert.equal(finished?.error, result.error);

  // Repair the corrupted row: segmentAllProjects sweeps every allowed
  // project's classified backlog on every future run in this same process
  // (this file's DB is shared across all its tests), so leaving invalid
  // JSON behind would make every later runAnalysis/runAnalyseCommand call
  // in this file fail the same way, for an unrelated reason.
  db.prepare(`UPDATE message_classifications SET tags_json = ? WHERE history_item_id = ?`).run(
    "[]",
    msg.id,
  );
});

test("store.runningAnalysisRun: an unfinished run blocks a second one (15-minute crash window, mirrors runningSyncRun)", () => {
  assert.equal(store.runningAnalysisRun(), null);

  const runId = store.startAnalysisRun("manual");
  const running = store.runningAnalysisRun();
  assert.equal(running?.id, runId, "the scheduler's loop would see this run as blocking a second");

  store.finishAnalysisRun(runId, { ok: true, counts: {}, tokens: 0, cost_usd: 0 });
  assert.equal(store.runningAnalysisRun(), null, "a finished run no longer blocks");
});

const DEFAULT_LLM_MODELS = {
  classifier: { provider: "openai", model: "gpt-5.4-mini" },
  rule_writer: { provider: "openai", model: "gpt-5.5" },
  reviewer: { provider: "openai", model: "gpt-5.5" },
  proposer: { provider: "openai", model: "gpt-5.5" },
};

function setClaudeCodeModels(): void {
  store.setSettings({
    llm_models: JSON.stringify({
      classifier: { provider: "claude_code", model: "sonnet" },
      rule_writer: { provider: "claude_code", model: "sonnet" },
      reviewer: { provider: "claude_code", model: "sonnet" },
      proposer: { provider: "claude_code", model: "sonnet" },
    }),
  });
}

function restoreDefaultModels(): void {
  // Restore the default provider so a settings change can't leak into a
  // later test in this file (each test file gets its own temp DB, but the
  // module-level claude_code check cache below is shared by every test in
  // this process, so leaving llm_models pointed at claude_code would also
  // leak the cached result into an unrelated later test).
  store.setSettings({ llm_models: JSON.stringify(DEFAULT_LLM_MODELS) });
}

test("run.providerReady: claude_code checks the CLI via an injectable exec, never spawning the real binary", async () => {
  setClaudeCodeModels();
  // Each call uses a `now` far enough apart (> the 60s memo window) that
  // the fix-round-1 cache (see the caching test below) never masks one
  // exec's result with the other's -- this test is about providerReady
  // correctly reflecting whatever the CLI check says, not about caching.
  const notFound = await run.providerReady({
    exec: async () => ({ stdout: "", code: 1 }),
    now: () => 0,
  });
  assert.deepEqual(notFound, { ok: false, reason: "Claude Code was not found on this machine." });

  const found = await run.providerReady({
    exec: async () => ({ stdout: "2.1.0", code: 0 }),
    now: () => 61_000,
  });
  assert.deepEqual(found, { ok: true });

  restoreDefaultModels();
});

test("run.providerReady: memoizes the claude_code CLI check for 60 seconds -- two calls within the window invoke the injected exec once", async () => {
  setClaudeCodeModels();
  let execCalls = 0;
  const exec = async () => {
    execCalls++;
    return { stdout: "2.1.0", code: 0 };
  };

  // A `now` base far separated (> 60s) from whatever timestamp the previous
  // test's cache was last written at, so this test's first call is
  // guaranteed a fresh miss regardless of test order/leftover cache state.
  const BASE = 10_000_000;
  const first = await run.providerReady({ exec, now: () => BASE });
  const second = await run.providerReady({ exec, now: () => BASE + 59_000 });
  assert.deepEqual(first, { ok: true });
  assert.deepEqual(second, { ok: true });
  assert.equal(execCalls, 1, "the second call within the 60s window reused the cached result");

  // Past the window, the check runs again.
  const third = await run.providerReady({ exec, now: () => BASE + 60_001 });
  assert.deepEqual(third, { ok: true });
  assert.equal(execCalls, 2, "past the 60s window, the check runs again");

  restoreDefaultModels();
});

test("run.providerReady: key checks (non-claude_code providers) stay live, never cached", async () => {
  // openai has no key stored right now (the earlier tests' keys are for
  // this same file's shared DB, but re-asserting the live behavior here:
  // remove any key, confirm not-ready, save one, confirm ready -- back to
  // back, with no memo window involved at all for API providers).
  llmKeys.removeKey("openai");
  const before = await run.providerReady();
  assert.deepEqual(before, {
    ok: false,
    reason: "No API key saved for OpenAI. Add one in Settings.",
  });

  llmKeys.setKey("openai", "sk-test-not-a-real-key");
  const after = await run.providerReady();
  assert.deepEqual(after, { ok: true }, "a key check reflects the change immediately, uncached");
});

test("runAnalyseCommand: queues an analysis_requests row and runs it, leaving the request done and linked to the run", async () => {
  llmKeys.setKey("openai", "sk-test-not-a-real-key");

  const before = db.prepare(`SELECT COUNT(*) as n FROM analysis_requests`).get() as { n: number };

  const outcome = await run.runAnalyseCommand(fakeCallLlm({}));

  assert.equal(outcome.ran, true);
  if (!outcome.ran) throw new Error("unreachable");
  assert.equal(outcome.result.ok, true, outcome.result.error);

  const after = db.prepare(`SELECT COUNT(*) as n FROM analysis_requests`).get() as { n: number };
  assert.equal(after.n, before.n + 1, "runAnalyseCommand queued exactly one new request");

  const request = db
    .prepare(`SELECT status, run_id FROM analysis_requests ORDER BY id DESC LIMIT 1`)
    .get() as { status: string; run_id: number };
  assert.equal(
    request.status,
    "done",
    "the CLI-queued request left the same audit trail a UI-queued one would",
  );
  assert.equal(
    request.run_id,
    outcome.result.runId,
    "the request is linked to the run that consumed it",
  );
});

test("runAnalyseCommand: refuses to overlap a run already in flight, without calling the LLM", async () => {
  const runningId = store.startAnalysisRun("manual");
  let callLlmInvoked = false;
  const callLlm: CallLlm = async () => {
    callLlmInvoked = true;
    throw new Error("must never be called while a run is in flight");
  };

  const before = db.prepare(`SELECT COUNT(*) as n FROM analysis_requests`).get() as { n: number };
  const outcome = await run.runAnalyseCommand(callLlm);
  const after = db.prepare(`SELECT COUNT(*) as n FROM analysis_requests`).get() as { n: number };

  assert.equal(outcome.ran, false);
  assert.equal(callLlmInvoked, false, "the LLM is never called when a run is already in flight");
  assert.equal(
    after.n,
    before.n + 1,
    "a request is still queued (coalesced by a later run) even though this call didn't run it",
  );

  store.finishAnalysisRun(runningId, { ok: true, counts: {}, tokens: 0, cost_usd: 0 });
});

// ---- Fix round 1 item 3 (controller ruling): runAnalysis must recompute
// rule_health (and propose retirements) at the end of a run, exactly as
// executor/beats.ts's runAll does at the end of a sync -- otherwise a fresh
// rule_adherence row the judge just wrote wouldn't affect health until the
// next sync happened to run. ----

test("runAnalysis: recomputes rule_health at the end of a run, for a live rule that had none before", async () => {
  llmKeys.setKey("openai", "sk-test-not-a-real-key");

  const PROJECT = "proj-run-health-recompute";
  store.allowProject(PROJECT, "Run Health Recompute");

  // A live rule (active, with a written Knowledge version), built the same
  // way rule-health.test.ts's own makeLiveRule fixture does -- with no
  // rule_health row yet.
  const seedEpisode = store.createTaskEpisode({
    project_id: PROJECT,
    title: "seed episode",
    provenance: "llm_derived",
    started_at: "2026-08-01T00:00:00Z",
    evidence_history_item_ids: [],
  }) as { id: number };
  const cc = store.createCorrectionCandidate({
    task_episode_id: seedEpisode.id,
    classification: "constraint_restatement",
    is_correction: true,
    reusable: true,
    proposed_scope: "project",
    summary: "seed correction",
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
    instruction: "Always confirm before deleting data.",
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
  ).run(rule.id, PROJECT, "2026-08-01T00:00:00Z");

  assert.equal(store.getRuleHealth(rule.id), null, "precondition: no rule_health row yet");

  const result = await run.runAnalysis(fakeCallLlm({}));
  assert.equal(result.ok, true, result.error);

  const health = store.getRuleHealth(rule.id);
  assert.ok(health, "runAnalysis must recompute rule_health for the live rule before it finishes");
  assert.equal(health!.rule_id, rule.id);
});

test("runAnalysis: records its step and counts while it runs, for the Inbox's progress display", async () => {
  llmKeys.setKey("openai", "sk-test-not-a-real-key");
  const PROJECT = "proj-run-progress";
  store.allowProject(PROJECT, "Run Progress");
  insertMessage(PROJECT, "user", "Build a pricing page.", ts(20));
  const correction = insertMessage(
    PROJECT,
    "user",
    "No, prices must include VAT everywhere.",
    ts(21),
  );
  store.requestAnalysis();

  const inner = fakeCallLlm({
    classify: {
      "Build a pricing page.": {
        classification: "new_task",
        tags: ["copy"],
        summary: "Pricing page.",
      },
      "No, prices must include VAT everywhere.": {
        classification: "correction",
        tags: ["copy"],
        summary: "Include VAT.",
      },
    },
    mine: [
      {
        match: "Build a pricing page.",
        json: {
          propose: true,
          instruction: "Show prices including VAT.",
          scope: "project",
          prediction: "Prices shown without VAT.",
          failure_signature: "no-vat",
          evidence_message_ids: [correction.external_id],
          confidence: 0.9,
          contradicts_rule_id: null,
          duplicate_of_rule_id: null,
        },
      },
    ],
  });
  const seen: string[] = [];
  const callLlm: typeof inner = async (req) => {
    const p = store.runningAnalysisProgress()?.progress;
    if (p) seen.push(`${p.stage} ${p.done}/${p.total}`);
    return inner(req);
  };
  const result = await run.runAnalysis(callLlm);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(seen, ["classify 0/2", "classify 1/2", "rules 0/1"]);
  assert.equal(store.runningAnalysisProgress(), null, "nothing is running afterwards");
  const last = db
    .prepare(`SELECT progress_json FROM analysis_runs WHERE id = ?`)
    .get(result.runId) as { progress_json: string };
  assert.equal(JSON.parse(last.progress_json).stage, "health");
});
