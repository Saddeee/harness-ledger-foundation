// Checkpoint 2026-09-18 2-E: OpenAI parameter-compatibility (capabilities.ts's
// openAiParamsFor, openai.ts's build-body + one-shot retry, index.ts's
// error-category routing and testProvider()). No network -- every case runs
// against a fake `fetch`, matching this repo's llm.test.ts conventions
// (isolated temp DB per file).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HARNESS_DB_PATH = join(
  mkdtempSync(join(tmpdir(), "harness-llm-openai-compat-test-")),
  "harness.db",
);

const { db } = await import("../src/db.js");
const store = await import("../src/store.js");
const llmKeys = await import("../src/llm-keys.js");
const llm = await import("../src/llm/index.js");
const openai = await import("../src/llm/openai.js");
const { openAiParamsFor } = await import("../src/llm/capabilities.js");
const { LlmProviderError } = llm;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["classification", "confidence"],
  properties: {
    classification: { type: "string" },
    confidence: { type: "number" },
  },
};

function setRoleModel(provider: string, model: string) {
  const models = JSON.parse(store.getSetting("llm_models"));
  store.setSettings({
    llm_models: JSON.stringify({ ...models, classifier: { provider, model } }),
  });
}

function makeFakeFetch(
  handler: (
    url: string,
    init: RequestInit,
    callIndex: number,
  ) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>,
) {
  const calls: { url: string; init: RequestInit; body: unknown }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const parsedBody = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, init: init ?? {}, body: parsedBody });
    const { status, body } = await handler(url, init ?? {}, calls.length - 1);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fetchFn, calls };
}

function successBody(classification = "correction", confidence = 0.9) {
  return {
    choices: [{ message: { content: JSON.stringify({ classification, confidence }) } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}

// ---- capabilities.ts: the table itself ----

test("openAiParamsFor: classic families (gpt-4o/gpt-4.1/gpt-4/gpt-3.5) get max_tokens + temperature", () => {
  for (const model of [
    "gpt-4o",
    "gpt-4o-mini",
    "gpt-4.1",
    "gpt-4.1-mini",
    "gpt-4-turbo",
    "gpt-3.5-turbo",
  ]) {
    const s = openAiParamsFor(model);
    assert.equal(s.tokenParam, "max_tokens", model);
    assert.equal(s.supportsTemperature, true, model);
  }
});

test("openAiParamsFor: newer families (o1/o3/o4/gpt-5) get max_completion_tokens, no temperature", () => {
  for (const model of [
    "o1-mini",
    "o3",
    "o3-mini",
    "o4-mini",
    "gpt-5",
    "gpt-5.4-mini",
    "gpt-5-turbo",
  ]) {
    const s = openAiParamsFor(model);
    assert.equal(s.tokenParam, "max_completion_tokens", model);
    assert.equal(s.supportsTemperature, false, model);
  }
});

test("openAiParamsFor: an unknown model family defaults to max_completion_tokens with temperature omitted", () => {
  const s = openAiParamsFor("some-future-model-9000");
  assert.equal(s.tokenParam, "max_completion_tokens");
  assert.equal(s.supportsTemperature, false);
});

// ---- (a)/(b)/(c): request body per family ----

test("(a) gpt-4o sends max_tokens and temperature", async () => {
  llmKeys.setKey("openai", "sk-compat-test-a");
  const { fetchFn, calls } = makeFakeFetch(() => ({ status: 200, body: successBody() }));
  await openai.callOpenAi({
    apiKey: "sk-compat-test-a",
    model: "gpt-4o",
    system: "s",
    user: "u",
    maxOutputTokens: 500,
    jsonSchema: { name: "X", schema: SCHEMA },
    fetchFn,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.body.max_tokens, 500);
  assert.equal(calls[0]!.body.max_completion_tokens, undefined);
  assert.equal(calls[0]!.body.temperature, 0);
});

test("(b) gpt-5 sends max_completion_tokens and no temperature", async () => {
  const { fetchFn, calls } = makeFakeFetch(() => ({ status: 200, body: successBody() }));
  await openai.callOpenAi({
    apiKey: "sk-compat-test-b",
    model: "gpt-5",
    system: "s",
    user: "u",
    maxOutputTokens: 500,
    jsonSchema: { name: "X", schema: SCHEMA },
    fetchFn,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.body.max_completion_tokens, 500);
  assert.equal(calls[0]!.body.max_tokens, undefined);
  assert.equal(calls[0]!.body.temperature, undefined);
});

test("(c) an unknown model omits temperature", async () => {
  const { fetchFn, calls } = makeFakeFetch(() => ({ status: 200, body: successBody() }));
  await openai.callOpenAi({
    apiKey: "sk-compat-test-c",
    model: "totally-unknown-model",
    system: "s",
    user: "u",
    maxOutputTokens: 500,
    jsonSchema: { name: "X", schema: SCHEMA },
    fetchFn,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.body.temperature, undefined);
  assert.equal(calls[0]!.body.max_completion_tokens, 500);
});

// ---- (d)/(e): one-shot retry on a 400 naming an unsupported parameter ----

test("(d) a 400 'Unsupported parameter: max_tokens' on a max_tokens model retries once with max_completion_tokens -- no third call", async () => {
  const { fetchFn, calls } = makeFakeFetch((_url, _init, i) => {
    if (i === 0) {
      return {
        status: 400,
        body: {
          error: {
            message: "Unsupported parameter: 'max_tokens' is not supported with this model.",
            param: "max_tokens",
          },
        },
      };
    }
    return { status: 200, body: successBody() };
  });
  const result = await openai.callOpenAi({
    apiKey: "sk-compat-test-d",
    model: "gpt-4o",
    system: "s",
    user: "u",
    maxOutputTokens: 500,
    jsonSchema: { name: "X", schema: SCHEMA },
    fetchFn,
  });
  assert.equal(calls.length, 2, "exactly one retry -- no third call");
  assert.equal(calls[0]!.body.max_tokens, 500);
  assert.equal(calls[1]!.body.max_tokens, undefined);
  assert.equal(calls[1]!.body.max_completion_tokens, 500);
  assert.notDeepEqual(calls[0]!.body, calls[1]!.body, "the retry body must differ from the first");
  assert.equal(result.openai?.retried, true);
  assert.equal(result.openai?.retry?.rejectedParam, "max_tokens");
  assert.equal(result.openai?.retry?.resolution, "max_completion_tokens");
});

test("(e) a 400 naming temperature as unsupported retries once without temperature", async () => {
  const { fetchFn, calls } = makeFakeFetch((_url, _init, i) => {
    if (i === 0) {
      return {
        status: 400,
        body: {
          error: {
            message: "Unsupported value: 'temperature' is not supported.",
            param: "temperature",
          },
        },
      };
    }
    return { status: 200, body: successBody() };
  });
  const result = await openai.callOpenAi({
    apiKey: "sk-compat-test-e",
    model: "gpt-4o",
    system: "s",
    user: "u",
    maxOutputTokens: 500,
    jsonSchema: { name: "X", schema: SCHEMA },
    fetchFn,
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.body.temperature, 0);
  assert.equal(calls[1]!.body.temperature, undefined);
  assert.equal(
    calls[1]!.body.max_tokens,
    500,
    "the token param is untouched by a temperature retry",
  );
  assert.equal(result.openai?.retry?.rejectedParam, "temperature");
  assert.equal(result.openai?.retry?.resolution, "removed");
});

test("a retry that still fails throws, with retry info attached, and never attempts a third call", async () => {
  const { fetchFn, calls } = makeFakeFetch(() => ({
    status: 400,
    body: { error: { message: "Unsupported parameter: 'max_tokens'.", param: "max_tokens" } },
  }));
  await assert.rejects(
    () =>
      openai.callOpenAi({
        apiKey: "sk-compat-test-retry-fail",
        model: "gpt-4o",
        system: "s",
        user: "u",
        maxOutputTokens: 500,
        jsonSchema: { name: "X", schema: SCHEMA },
        fetchFn,
      }),
    (err: unknown) => {
      assert.ok(err instanceof LlmProviderError);
      assert.equal(err.category, "invalid_parameter");
      assert.equal(err.retry?.rejectedParam, "max_tokens");
      return true;
    },
  );
  assert.equal(calls.length, 2, "the first attempt and its one retry -- never a third");
});

test("a 400 that names no recognised parameter is never retried (never an identical request)", async () => {
  const { fetchFn, calls } = makeFakeFetch(() => ({ status: 400, body: "bad request" }));
  await assert.rejects(() =>
    openai.callOpenAi({
      apiKey: "sk-compat-test-unrec",
      model: "gpt-4o",
      system: "s",
      user: "u",
      maxOutputTokens: 500,
      jsonSchema: { name: "X", schema: SCHEMA },
      fetchFn,
    }),
  );
  assert.equal(calls.length, 1);
});

// ---- (f): invalid model ----

test("(f) an invalid/unknown model -> error_category 'invalid_model', no retry", async () => {
  const { fetchFn, calls } = makeFakeFetch(() => ({
    status: 404,
    body: {
      error: { message: "The model 'no-such-model' does not exist", code: "model_not_found" },
    },
  }));
  await assert.rejects(
    () =>
      openai.callOpenAi({
        apiKey: "sk-compat-test-f",
        model: "no-such-model",
        system: "s",
        user: "u",
        maxOutputTokens: 500,
        jsonSchema: { name: "X", schema: SCHEMA },
        fetchFn,
      }),
    (err: unknown) => {
      assert.ok(err instanceof LlmProviderError);
      assert.equal(err.category, "invalid_model");
      assert.equal(err.status, 404);
      return true;
    },
  );
  assert.equal(calls.length, 1, "an invalid model is never retried");
});

test("error categories: 401 -> auth, 429 -> rate_limit, 500 -> server", async () => {
  for (const [status, category] of [
    [401, "auth"],
    [429, "rate_limit"],
    [500, "server"],
  ] as const) {
    const { fetchFn } = makeFakeFetch(() => ({ status, body: { error: { message: "nope" } } }));
    await assert.rejects(
      () =>
        openai.callOpenAi({
          apiKey: "sk-compat-test-cat",
          model: "gpt-4o",
          system: "s",
          user: "u",
          maxOutputTokens: 500,
          jsonSchema: { name: "X", schema: SCHEMA },
          fetchFn,
        }),
      (err: unknown) => {
        assert.ok(err instanceof LlmProviderError);
        assert.equal(err.category, category, `status ${status}`);
        return true;
      },
    );
  }
});

// ---- (g): secrets never leak ----

test("(g) a provider message containing an sk-... token is redacted from the thrown error", async () => {
  const { fetchFn } = makeFakeFetch(() => ({
    status: 401,
    body: { error: { message: "invalid api key sk-abc123456789abcdef" } },
  }));
  await assert.rejects(
    () =>
      openai.callOpenAi({
        apiKey: "sk-abc123456789abcdef",
        model: "gpt-4o",
        system: "s",
        user: "u",
        maxOutputTokens: 500,
        jsonSchema: { name: "X", schema: SCHEMA },
        fetchFn,
      }),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      assert.ok(
        !message.includes("sk-abc123456789abcdef"),
        "the key must not appear in the message",
      );
      assert.ok(message.includes("sk-***"), "a redaction marker should replace it");
      return true;
    },
  );
});

test("(g) redactSecrets strips any sk-... token from arbitrary text", () => {
  const redacted = openai.redactSecrets("key is sk-abc123 and also sk-DEF456ghijk");
  assert.ok(!redacted.includes("sk-abc123"));
  assert.ok(!redacted.includes("sk-DEF456ghijk"));
  assert.ok(redacted.includes("sk-***"));
});

// ---- end-to-end through createCallLlm: the internal retry never trips the transport retry into a third call ----

test("createCallLlm: an invalid-parameter 400 retried successfully by openai.ts logs exactly one llm_calls row (one physical unit of work)", async () => {
  llmKeys.setKey("openai", "sk-compat-e2e");
  setRoleModel("openai", "gpt-4o");
  const { fetchFn, calls } = makeFakeFetch((_url, _init, i) => {
    if (i === 0) {
      return {
        status: 400,
        body: { error: { message: "Unsupported parameter: 'max_tokens'.", param: "max_tokens" } },
      };
    }
    return { status: 200, body: successBody("other", 0.4) };
  });
  const callLlm = llm.createCallLlm({ fetchFn });
  const before = (db.prepare(`SELECT COUNT(*) n FROM llm_calls`).get() as { n: number }).n;
  const result = await callLlm<{ classification: string; confidence: number }>({
    role: "classifier",
    system: "s",
    user: "u",
    schema: SCHEMA,
    schemaName: "X",
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(result.json, { classification: "other", confidence: 0.4 });
  const after = (db.prepare(`SELECT COUNT(*) n FROM llm_calls`).get() as { n: number }).n;
  assert.equal(
    after,
    before + 1,
    "the internal retry is invisible to llm_calls -- one call succeeded",
  );

  const events = db
    .prepare(`SELECT payload FROM events WHERE kind = 'llm.call.strategy' ORDER BY id DESC LIMIT 1`)
    .get() as { payload: string };
  const payload = JSON.parse(events.payload);
  assert.equal(payload.provider, "openai");
  assert.equal(payload.model, "gpt-4o");
  assert.equal(payload.retried, true);
  assert.equal(payload.retry.rejectedParam, "max_tokens");
});

// ---- (h): testProvider ----

test("(h) testProvider: fake happy path returns ok with estimated tokens, writes no correction/rule rows", async () => {
  llmKeys.setKey("openai", "sk-compat-test-provider");
  setRoleModel("openai", "gpt-4o");
  const correctionsBefore = (
    db.prepare(`SELECT COUNT(*) n FROM correction_candidates`).get() as { n: number }
  ).n;
  const rulesBefore = (db.prepare(`SELECT COUNT(*) n FROM rules`).get() as { n: number }).n;

  const { fetchFn, calls } = makeFakeFetch(() => ({
    status: 200,
    body: {
      choices: [{ message: { content: JSON.stringify({ ok: true }) } }],
      usage: { prompt_tokens: 25, completion_tokens: 15 },
    },
  }));

  const result = await llm.testProvider({ fetchFn });
  assert.equal(calls.length, 1);
  assert.equal(result.ok, true);
  assert.equal(result.provider, "openai");
  assert.equal(result.model, "gpt-4o");
  assert.equal(result.estimated_tokens, 40);
  assert.match(result.message, /Provider test passed: gpt-4o, about 40 tokens/);
  assert.equal(result.strategy?.tokenParam, "max_tokens");
  assert.equal(result.strategy?.temperatureSent, true);

  const correctionsAfter = (
    db.prepare(`SELECT COUNT(*) n FROM correction_candidates`).get() as { n: number }
  ).n;
  const rulesAfter = (db.prepare(`SELECT COUNT(*) n FROM rules`).get() as { n: number }).n;
  assert.equal(correctionsAfter, correctionsBefore, "testProvider must not touch project data");
  assert.equal(rulesAfter, rulesBefore, "testProvider must not touch project data");

  const row = db
    .prepare(`SELECT role, provider, model FROM llm_calls ORDER BY id DESC LIMIT 1`)
    .get() as { role: string; provider: string; model: string };
  assert.equal(row.role, "provider_test");
  assert.equal(row.provider, "openai");
  assert.equal(row.model, "gpt-4o");
});

test("testProvider: an invalid-model failure returns ok:false with a compatibility message, still logs a failed llm_calls row", async () => {
  setRoleModel("openai", "no-such-test-model");
  const { fetchFn } = makeFakeFetch(() => ({
    status: 404,
    body: {
      error: { message: "The model 'no-such-test-model' does not exist", code: "model_not_found" },
    },
  }));
  const before = (db.prepare(`SELECT COUNT(*) n FROM llm_calls`).get() as { n: number }).n;
  const result = await llm.testProvider({ fetchFn });
  assert.equal(result.ok, false);
  assert.match(result.message, /no-such-test-model.*was not found at OpenAI/);
  const after = (db.prepare(`SELECT COUNT(*) n FROM llm_calls`).get() as { n: number }).n;
  assert.equal(after, before + 1);
});
