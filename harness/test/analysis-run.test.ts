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
 * (classifier, miner -- segmentAllProjects makes no LLM call at all).
 * Classifier responses are keyed by the message text (matching
 * analysis-classify.test.ts's own fake); miner responses are keyed by a
 * substring of the assembled miner prompt (matching
 * analysis-mine.test.ts's own fake). Every successful call logs to
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
    } else if (req.role === "miner") {
      const entry = (opts.mine ?? []).find((e) => req.user.includes(e.match));
      if (!entry) throw new Error(`fakeCallLlm: no canned miner response matching:\n${req.user}`);
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
  assert.match(result.error ?? "", /No API key saved for openai/);
  assert.deepEqual(result.counts, {
    classified: 0,
    failed: 0,
    episodes_created: 0,
    proposed: 0,
    skipped_duplicate: 0,
    rejected: 0,
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
  });

  // Three real calls were made (2 classify + 1 miner), each logging
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
    ["classifier", "classifier", "miner"].sort(),
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
});

test("store.runningAnalysisRun: an unfinished run blocks a second one (15-minute crash window, mirrors runningSyncRun)", () => {
  assert.equal(store.runningAnalysisRun(), null);

  const runId = store.startAnalysisRun("manual");
  const running = store.runningAnalysisRun();
  assert.equal(running?.id, runId, "the scheduler's loop would see this run as blocking a second");

  store.finishAnalysisRun(runId, { ok: true, counts: {}, tokens: 0, cost_usd: 0 });
  assert.equal(store.runningAnalysisRun(), null, "a finished run no longer blocks");
});

test("run.providerReady: claude_code checks the CLI via an injectable exec, never spawning the real binary", async () => {
  store.setSettings({
    llm_models: JSON.stringify({
      classifier: { provider: "claude_code", model: "sonnet" },
      miner: { provider: "claude_code", model: "sonnet" },
      reviewer: { provider: "claude_code", model: "sonnet" },
      proposer: { provider: "claude_code", model: "sonnet" },
    }),
  });

  const notFound = await run.providerReady({
    exec: async () => ({ stdout: "", code: 1 }),
  });
  assert.deepEqual(notFound, { ok: false, reason: "Claude Code was not found on this machine." });

  const found = await run.providerReady({
    exec: async () => ({ stdout: "2.1.0", code: 0 }),
  });
  assert.deepEqual(found, { ok: true });

  // Restore the default provider so this test's settings change can't leak
  // into a later test file run against the same process (each test file
  // gets its own temp DB, but this documents the intent regardless).
  store.setSettings({
    llm_models: JSON.stringify({
      classifier: { provider: "openai", model: "gpt-5.4-mini" },
      miner: { provider: "openai", model: "gpt-5.5" },
      reviewer: { provider: "openai", model: "gpt-5.5" },
      proposer: { provider: "openai", model: "gpt-5.5" },
    }),
  });
});
