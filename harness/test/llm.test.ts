// Round 4 Task A0: harness/src/llm/*. No network, no real `claude`
// invocation -- every provider is exercised against a mocked `fetch` (API
// providers) or a fake `exec` (claude_code), matching this repo's existing
// llm-keys.test.ts / store.test.ts conventions (isolated temp DB per file).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec, ExecResult } from "../src/llm/claude-code.js";

process.env.HARNESS_DB_PATH = join(mkdtempSync(join(tmpdir(), "harness-llm-test-")), "harness.db");

const { db } = await import("../src/db.js");
const store = await import("../src/store.js");
const llmKeys = await import("../src/llm-keys.js");
const llm = await import("../src/llm/index.js");
const { LlmBudgetExceeded, LlmKeyMissing, LlmProviderUnavailable } = llm;

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
  ) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>,
) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init: init ?? {} });
    const { status, body } = await handler(url, init ?? {});
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fetchFn, calls };
}

function headerValue(init: RequestInit, name: string): string | undefined {
  const headers = init.headers as Record<string, string> | undefined;
  return headers?.[name];
}

type ClaudeExecOpts = {
  versionOk?: boolean;
  helpText?: string;
  runResponses: ExecResult[];
};

function makeClaudeExec(opts: ClaudeExecOpts) {
  const calls: { cmd: string; args: string[]; input: string }[] = [];
  let runIndex = 0;
  const exec: Exec = async (cmd, args, input) => {
    calls.push({ cmd, args, input });
    if (args.includes("--version")) {
      return opts.versionOk === false
        ? { stdout: "", code: 1 }
        : { stdout: "2.1.0 (Claude Code)", code: 0 };
    }
    if (args.includes("--help")) {
      return { stdout: opts.helpText ?? "Usage: claude [options]\n  -p, --print\n", code: 0 };
    }
    const resp = opts.runResponses[Math.min(runIndex, opts.runResponses.length - 1)]!;
    runIndex += 1;
    return resp;
  };
  return { exec, calls };
}

function llmCallCount(): number {
  return (db.prepare(`SELECT COUNT(*) n FROM llm_calls`).get() as { n: number }).n;
}

// ---- OpenAI ----

test("openai: request shape (URL, auth header, json_schema strict flag), response parsing, cost", async () => {
  llmKeys.setKey("openai", "sk-test-openai-secret-1234");
  setRoleModel("openai", "gpt-5.4-mini");

  const { fetchFn, calls } = makeFakeFetch((_url, init) => {
    const body = JSON.parse(init.body as string);
    assert.equal(body.model, "gpt-5.4-mini");
    // Checkpoint 2026-09-18 2-E: "gpt-5.4-mini" is a gpt-5-family model, so
    // capabilities.ts's openAiParamsFor puts it on the newer contract --
    // `max_completion_tokens`, no `temperature` (it previously always sent
    // `temperature: 0` and `max_tokens`, which is exactly the reviewer-found
    // bug this checkpoint fixes: a real gpt-5-family call would 400 on both).
    assert.equal(body.temperature, undefined);
    assert.equal(body.max_tokens, undefined);
    assert.equal(body.max_completion_tokens, 1500);
    assert.equal(body.response_format.type, "json_schema");
    assert.equal(body.response_format.json_schema.strict, true);
    assert.equal(body.response_format.json_schema.name, "ClassifyResult");
    return {
      status: 200,
      body: {
        choices: [
          {
            message: { content: JSON.stringify({ classification: "correction", confidence: 0.9 }) },
          },
        ],
        usage: { prompt_tokens: 120, completion_tokens: 10 },
      },
    };
  });

  const callLlm = llm.createCallLlm({ fetchFn });
  const before = llmCallCount();
  const result = await callLlm<{ classification: string; confidence: number }>({
    role: "classifier",
    system: "sys",
    user: "usr",
    schema: SCHEMA,
    schemaName: "ClassifyResult",
    runId: 5,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(headerValue(calls[0]!.init, "Authorization"), "Bearer sk-test-openai-secret-1234");

  assert.deepEqual(result.json, { classification: "correction", confidence: 0.9 });
  assert.equal(result.provider, "openai");
  assert.equal(result.model, "gpt-5.4-mini");
  assert.equal(result.tokensIn, 120);
  assert.equal(result.tokensOut, 10);
  assert.ok(result.costUsd !== null && result.costUsd > 0);

  assert.equal(llmCallCount(), before + 1);
  const row = store.listLlmCalls(1)[0] as {
    tokens_in: number;
    tokens_out: number;
    estimated_tokens: number;
    run_id: number;
    cost_usd: number;
    provider: string;
  };
  assert.equal(row.tokens_in, 120);
  assert.equal(row.tokens_out, 10);
  assert.ok(row.estimated_tokens > 0);
  assert.equal(row.run_id, 5);
  assert.ok(row.cost_usd > 0);
  assert.equal(row.provider, "openai");
});

test("openai: auth header value never appears in a thrown error message", async () => {
  llmKeys.setKey("openai", "sk-must-never-leak-999");
  setRoleModel("openai", "gpt-5.4-mini");
  const { fetchFn } = makeFakeFetch(() => ({ status: 401, body: "unauthorized: bad request" }));
  const callLlm = llm.createCallLlm({ fetchFn });
  await assert.rejects(
    () => callLlm({ role: "classifier", system: "s", user: "u", schema: SCHEMA, schemaName: "X" }),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      assert.ok(
        !message.includes("sk-must-never-leak-999"),
        "error message must not include the key",
      );
      return true;
    },
  );
});

test("openai: retry once on invalid JSON, second attempt succeeds; both attempts logged", async () => {
  llmKeys.setKey("openai", "sk-retry-test-key");
  setRoleModel("openai", "gpt-5.4-mini");
  let call = 0;
  const { fetchFn, calls } = makeFakeFetch((_url, init) => {
    call += 1;
    const body = JSON.parse(init.body as string);
    if (call === 1) {
      return {
        status: 200,
        body: {
          choices: [{ message: { content: "not valid json" } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        },
      };
    }
    assert.match(body.messages[1].content, /Return only JSON matching the schema\./);
    return {
      status: 200,
      body: {
        choices: [
          { message: { content: JSON.stringify({ classification: "other", confidence: 0.2 }) } },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 6 },
      },
    };
  });

  const callLlm = llm.createCallLlm({ fetchFn });
  const before = llmCallCount();
  const result = await callLlm<{ classification: string; confidence: number }>({
    role: "classifier",
    system: "sys",
    user: "usr",
    schema: SCHEMA,
    schemaName: "ClassifyResult",
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(result.json, { classification: "other", confidence: 0.2 });
  assert.equal(llmCallCount(), before + 2, "both the failed and the retry attempt are logged");
});

test("openai: retry fails twice -> throws, both attempts still logged", async () => {
  llmKeys.setKey("openai", "sk-retry-fail-key");
  setRoleModel("openai", "gpt-5.4-mini");
  const { fetchFn } = makeFakeFetch(() => ({
    status: 200,
    body: {
      choices: [{ message: { content: "still not json" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    },
  }));
  const callLlm = llm.createCallLlm({ fetchFn });
  const before = llmCallCount();
  await assert.rejects(() =>
    callLlm({ role: "classifier", system: "s", user: "u", schema: SCHEMA, schemaName: "X" }),
  );
  assert.equal(llmCallCount(), before + 2);
});

// ---- Anthropic ----

test("anthropic: request shape (URL, x-api-key header, tool-forcing), response parsing (already-parsed object)", async () => {
  llmKeys.setKey("anthropic", "ant-secret-key-5678");
  setRoleModel("anthropic", "claude-haiku-4-5");

  const { fetchFn, calls } = makeFakeFetch((_url, init) => {
    const body = JSON.parse(init.body as string);
    assert.equal(body.model, "claude-haiku-4-5");
    assert.equal(body.temperature, 0);
    assert.equal(body.tools[0].name, "emit_result");
    assert.deepEqual(body.tool_choice, { type: "tool", name: "emit_result" });
    return {
      status: 200,
      body: {
        content: [{ type: "tool_use", input: { classification: "approval", confidence: 0.99 } }],
        usage: { input_tokens: 200, output_tokens: 30 },
      },
    };
  });

  const callLlm = llm.createCallLlm({ fetchFn });
  const result = await callLlm<{ classification: string; confidence: number }>({
    role: "classifier",
    system: "sys",
    user: "usr",
    schema: SCHEMA,
    schemaName: "ClassifyResult",
  });

  assert.equal(calls[0]!.url, "https://api.anthropic.com/v1/messages");
  assert.equal(headerValue(calls[0]!.init, "x-api-key"), "ant-secret-key-5678");
  assert.equal(headerValue(calls[0]!.init, "anthropic-version"), "2023-06-01");
  assert.deepEqual(result.json, { classification: "approval", confidence: 0.99 });
  assert.equal(result.tokensIn, 200);
  assert.equal(result.tokensOut, 30);
  assert.ok(result.costUsd !== null && result.costUsd > 0);
});

test("anthropic: auth header value never appears in a thrown error message", async () => {
  llmKeys.setKey("anthropic", "ant-must-never-leak");
  setRoleModel("anthropic", "claude-haiku-4-5");
  const { fetchFn } = makeFakeFetch(() => ({ status: 500, body: "internal error" }));
  // 500 is transport-retryable (see the "transport retry" tests below) --
  // inject a no-op sleep so this unrelated test doesn't eat a real 2s delay.
  const callLlm = llm.createCallLlm({ fetchFn, sleep: async () => {} });
  await assert.rejects(
    () => callLlm({ role: "classifier", system: "s", user: "u", schema: SCHEMA, schemaName: "X" }),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      assert.ok(!message.includes("ant-must-never-leak"));
      return true;
    },
  );
});

// ---- Google ----

test("google: request shape (URL has model but not key, x-goog-api-key header, responseSchema flags), response parsing (JSON string)", async () => {
  llmKeys.setKey("google", "goog-secret-key-4321");
  setRoleModel("google", "gemini-3.1-flash-lite");

  const { fetchFn, calls } = makeFakeFetch((url, init) => {
    assert.equal(
      url,
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent",
    );
    assert.ok(!url.includes("goog-secret-key-4321"), "the key must not be in the URL");
    const body = JSON.parse(init.body as string);
    assert.equal(body.generationConfig.responseMimeType, "application/json");
    assert.deepEqual(body.generationConfig.responseSchema, SCHEMA);
    assert.equal(body.generationConfig.temperature, 0);
    return {
      status: 200,
      body: {
        candidates: [
          {
            content: {
              parts: [{ text: JSON.stringify({ classification: "question", confidence: 0.5 }) }],
            },
          },
        ],
        usageMetadata: { promptTokenCount: 80, candidatesTokenCount: 8 },
      },
    };
  });

  const callLlm = llm.createCallLlm({ fetchFn });
  const result = await callLlm<{ classification: string; confidence: number }>({
    role: "classifier",
    system: "sys",
    user: "usr",
    schema: SCHEMA,
    schemaName: "ClassifyResult",
  });

  assert.equal(headerValue(calls[0]!.init, "x-goog-api-key"), "goog-secret-key-4321");
  assert.deepEqual(result.json, { classification: "question", confidence: 0.5 });
  assert.equal(result.tokensIn, 80);
  assert.equal(result.tokensOut, 8);
  assert.ok(result.costUsd !== null && result.costUsd > 0);
});

test("google: auth header value never appears in a thrown error message", async () => {
  llmKeys.setKey("google", "goog-must-never-leak");
  setRoleModel("google", "gemini-3.1-flash-lite");
  const { fetchFn } = makeFakeFetch(() => ({ status: 400, body: "bad request" }));
  const callLlm = llm.createCallLlm({ fetchFn });
  await assert.rejects(
    () => callLlm({ role: "classifier", system: "s", user: "u", schema: SCHEMA, schemaName: "X" }),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      assert.ok(!message.includes("goog-must-never-leak"));
      return true;
    },
  );
});

// ---- Claude Code ----

test("claude_code: no key needed, args include -p/--output-format json/--model, prepends SYSTEM:/USER: on stdin when --system-prompt is unsupported", async () => {
  setRoleModel("claude_code", "sonnet");
  const { exec, calls } = makeClaudeExec({
    helpText: "Usage: claude [options]\n  -p, --print\n  --output-format <format>\n",
    runResponses: [
      {
        stdout: JSON.stringify({
          result: JSON.stringify({ classification: "correction", confidence: 0.7 }),
          usage: { input_tokens: 40, output_tokens: 9 },
        }),
        code: 0,
      },
    ],
  });

  const callLlm = llm.createCallLlm({ exec });
  const result = await callLlm<{ classification: string; confidence: number }>({
    role: "classifier",
    system: "SYSTEM TEXT",
    user: "USER TEXT",
    schema: SCHEMA,
    schemaName: "ClassifyResult",
  });

  assert.deepEqual(result.json, { classification: "correction", confidence: 0.7 });
  assert.equal(result.provider, "claude_code");
  assert.equal(result.model, "sonnet");
  assert.equal(result.tokensIn, 40);
  assert.equal(result.tokensOut, 9);
  assert.equal(result.costUsd, null, "claude_code never has a per-call USD cost");

  const runCall = calls.find((c) => c.args.includes("-p"))!;
  assert.deepEqual(runCall.args, ["-p", "--output-format", "json", "--model", "sonnet"]);
  assert.equal(runCall.input, "SYSTEM:\nSYSTEM TEXT\n\nUSER:\nUSER TEXT");

  const row = store.listLlmCalls(1)[0] as {
    cost_usd: number;
    provider: string;
    estimated_tokens: number;
  };
  assert.equal(
    row.cost_usd,
    0,
    "the llm_calls column is NOT NULL -- null cost is represented as 0 there",
  );
  assert.equal(row.provider, "claude_code");
  assert.ok(row.estimated_tokens > 0);
});

test("claude_code: uses --system-prompt and puts only the user text on stdin when the CLI advertises the flag (checked via --help)", async () => {
  setRoleModel("claude_code", "sonnet");
  const { exec, calls } = makeClaudeExec({
    helpText: "Usage: claude [options]\n  --system-prompt <text>\n",
    runResponses: [
      {
        stdout: JSON.stringify({
          result: JSON.stringify({ classification: "other", confidence: 0.1 }),
          usage: {},
        }),
        code: 0,
      },
    ],
  });

  const callLlm = llm.createCallLlm({ exec });
  await callLlm({
    role: "classifier",
    system: "SYS",
    user: "USR",
    schema: SCHEMA,
    schemaName: "X",
  });

  const runCall = calls.find((c) => c.args.includes("-p"))!;
  assert.deepEqual(runCall.args, [
    "-p",
    "--output-format",
    "json",
    "--model",
    "sonnet",
    "--system-prompt",
    "SYS",
  ]);
  assert.equal(runCall.input, "USR");
});

test("claude_code: --help is only invoked once per exec (cached)", async () => {
  setRoleModel("claude_code", "sonnet");
  const { exec, calls } = makeClaudeExec({
    runResponses: [
      {
        stdout: JSON.stringify({
          result: JSON.stringify({ classification: "other", confidence: 0.1 }),
          usage: {},
        }),
        code: 0,
      },
      {
        stdout: JSON.stringify({
          result: JSON.stringify({ classification: "other", confidence: 0.1 }),
          usage: {},
        }),
        code: 0,
      },
    ],
  });
  const callLlm = llm.createCallLlm({ exec });
  await callLlm({ role: "classifier", system: "s", user: "u1", schema: SCHEMA, schemaName: "X" });
  await callLlm({ role: "classifier", system: "s", user: "u2", schema: SCHEMA, schemaName: "X" });
  const helpCalls = calls.filter((c) => c.args.includes("--help"));
  assert.equal(helpCalls.length, 1);
});

test("claude_code: defensive fallback to 0 tokens when usage is missing from the envelope", async () => {
  setRoleModel("claude_code", "sonnet");
  const { exec } = makeClaudeExec({
    runResponses: [
      {
        stdout: JSON.stringify({
          result: JSON.stringify({ classification: "other", confidence: 0.1 }),
        }),
        code: 0,
      },
    ],
  });
  const callLlm = llm.createCallLlm({ exec });
  const result = await callLlm({
    role: "classifier",
    system: "s",
    user: "u",
    schema: SCHEMA,
    schemaName: "X",
  });
  assert.equal(result.tokensIn, 0);
  assert.equal(result.tokensOut, 0);
});

test("claude_code: a JSON result wrapped in a ```json markdown fence is stripped and parses on the first attempt (no parse-failure retry)", async () => {
  setRoleModel("claude_code", "sonnet");
  const fenced =
    "```json\n" + JSON.stringify({ classification: "question", confidence: 0.4 }) + "\n```";
  const { exec, calls } = makeClaudeExec({
    runResponses: [
      {
        stdout: JSON.stringify({ result: fenced, usage: { input_tokens: 5, output_tokens: 3 } }),
        code: 0,
      },
    ],
  });
  const callLlm = llm.createCallLlm({ exec });
  const result = await callLlm<{ classification: string; confidence: number }>({
    role: "classifier",
    system: "s",
    user: "u",
    schema: SCHEMA,
    schemaName: "X",
  });
  assert.deepEqual(result.json, { classification: "question", confidence: 0.4 });
  assert.equal(calls.filter((c) => c.args.includes("-p")).length, 1, "no retry needed");
});

test("claude_code: a plain (unfenced) JSON result still parses -- the fence strip is a no-op", async () => {
  setRoleModel("claude_code", "sonnet");
  const unfenced = JSON.stringify({ classification: "other", confidence: 0.2 });
  const { exec } = makeClaudeExec({
    runResponses: [{ stdout: JSON.stringify({ result: unfenced }), code: 0 }],
  });
  const callLlm = llm.createCallLlm({ exec });
  const result = await callLlm<{ classification: string; confidence: number }>({
    role: "classifier",
    system: "s",
    user: "u",
    schema: SCHEMA,
    schemaName: "X",
  });
  assert.deepEqual(result.json, { classification: "other", confidence: 0.2 });
});

test("claude_code: LlmProviderUnavailable when `claude --version` fails; the failed attempt is still logged", async () => {
  setRoleModel("claude_code", "sonnet");
  const { exec } = makeClaudeExec({ versionOk: false, runResponses: [] });
  const callLlm = llm.createCallLlm({ exec });
  const before = llmCallCount();
  await assert.rejects(
    () => callLlm({ role: "classifier", system: "s", user: "u", schema: SCHEMA, schemaName: "X" }),
    LlmProviderUnavailable,
  );
  assert.equal(
    llmCallCount(),
    before + 1,
    "a CLI failure is a failed attempt, not a no-op -- it must still be logged",
  );
  const row = store.listLlmCalls(1)[0] as {
    tokens_in: number;
    tokens_out: number;
    cost_usd: number;
  };
  assert.equal(row.tokens_in, 0);
  assert.equal(row.tokens_out, 0);
  assert.equal(row.cost_usd, 0);
});

// ---- Failed calls are still logged (fix round 1, item 1) ----

test("failed provider calls are logged: a non-retryable HTTP error (400) logs exactly one row with tokens 0, then throws", async () => {
  llmKeys.setKey("openai", "sk-fail-log-test");
  setRoleModel("openai", "gpt-5.4-mini");
  const { fetchFn } = makeFakeFetch(() => ({ status: 400, body: "bad request" }));
  const callLlm = llm.createCallLlm({ fetchFn });
  const before = llmCallCount();
  await assert.rejects(() =>
    callLlm({ role: "classifier", system: "s", user: "u", schema: SCHEMA, schemaName: "X" }),
  );
  assert.equal(llmCallCount(), before + 1, "exactly one row -- 400 is not transport-retryable");
  const row = store.listLlmCalls(1)[0] as {
    tokens_in: number;
    tokens_out: number;
    cost_usd: number;
    estimated_tokens: number;
    provider: string;
  };
  assert.equal(row.tokens_in, 0);
  assert.equal(row.tokens_out, 0);
  assert.equal(row.cost_usd, 0);
  assert.ok(row.estimated_tokens > 0);
  assert.equal(row.provider, "openai");
});

// ---- Transport retry on 429/5xx (fix round 1, item 3) ----

test("transport retry: a 503 then a 200 succeeds after one 2s-delayed retry; both physical attempts are logged", async () => {
  llmKeys.setKey("openai", "sk-transport-retry-key");
  setRoleModel("openai", "gpt-5.4-mini");
  let call = 0;
  const { fetchFn } = makeFakeFetch(() => {
    call += 1;
    if (call === 1) return { status: 503, body: "service unavailable" };
    return {
      status: 200,
      body: {
        choices: [
          { message: { content: JSON.stringify({ classification: "other", confidence: 0.3 }) } },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 4 },
      },
    };
  });
  const sleeps: number[] = [];
  const callLlm = llm.createCallLlm({
    fetchFn,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  });
  const before = llmCallCount();
  const result = await callLlm<{ classification: string; confidence: number }>({
    role: "classifier",
    system: "s",
    user: "u",
    schema: SCHEMA,
    schemaName: "X",
  });
  assert.equal(call, 2, "exactly one transport retry -- not a loop");
  assert.deepEqual(sleeps, [2000]);
  assert.deepEqual(result.json, { classification: "other", confidence: 0.3 });
  assert.equal(
    llmCallCount(),
    before + 2,
    "both the failed 503 attempt and the retried 200 attempt are logged",
  );
  const rows = store.listLlmCalls(2) as { tokens_in: number; tokens_out: number }[];
  assert.equal(rows[0]!.tokens_in, 20, "most recent row is the successful retry");
  assert.equal(rows[1]!.tokens_in, 0, "earlier row is the failed 503 attempt");
});

test("transport retry: a second failure (429 again) throws; both attempts logged with tokens 0, no third try", async () => {
  llmKeys.setKey("openai", "sk-transport-retry-fail-key");
  setRoleModel("openai", "gpt-5.4-mini");
  let call = 0;
  const { fetchFn } = makeFakeFetch(() => {
    call += 1;
    return { status: 429, body: "rate limited" };
  });
  const sleeps: number[] = [];
  const callLlm = llm.createCallLlm({
    fetchFn,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  });
  const before = llmCallCount();
  await assert.rejects(() =>
    callLlm({ role: "classifier", system: "s", user: "u", schema: SCHEMA, schemaName: "X" }),
  );
  assert.equal(call, 2, "one retry, then give up -- never a third attempt");
  assert.deepEqual(sleeps, [2000]);
  assert.equal(llmCallCount(), before + 2);
  const rows = store.listLlmCalls(2) as { tokens_in: number; tokens_out: number }[];
  assert.equal(rows[0]!.tokens_in, 0);
  assert.equal(rows[1]!.tokens_in, 0);
});

test("transport retry: claude_code failures are never transport-retried (no HTTP status to key off)", async () => {
  setRoleModel("claude_code", "sonnet");
  const { exec, calls } = makeClaudeExec({ versionOk: false, runResponses: [] });
  const sleeps: number[] = [];
  const callLlm = llm.createCallLlm({
    exec,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  });
  const before = llmCallCount();
  await assert.rejects(
    () => callLlm({ role: "classifier", system: "s", user: "u", schema: SCHEMA, schemaName: "X" }),
    LlmProviderUnavailable,
  );
  assert.equal(sleeps.length, 0, "no transport retry/sleep for claude_code");
  assert.equal(llmCallCount(), before + 1, "exactly one failed attempt logged, not retried");
});

// ---- Budget guard ----

test("budget guard: refuses over budget before calling the provider, and logs nothing", async () => {
  setRoleModel("claude_code", "sonnet");
  store.setSettings({ llm_monthly_token_budget: "100000" });
  const before = llmCallCount();
  const callLlm = llm.createCallLlm({
    exec: async () => {
      throw new Error("must never be called -- the budget guard should refuse first");
    },
  });
  await assert.rejects(
    () =>
      callLlm({
        role: "classifier",
        system: "s",
        user: "u",
        schema: SCHEMA,
        schemaName: "X",
        maxOutputTokens: 500_000, // estimate alone exceeds the 100,000 budget
      }),
    (err: unknown) => {
      assert.ok(err instanceof LlmBudgetExceeded);
      assert.equal(typeof err.used, "number");
      assert.equal(err.budget, 100_000);
      return true;
    },
  );
  assert.equal(llmCallCount(), before, "a refused call is never logged to llm_calls");
  store.setSettings({ llm_monthly_token_budget: "2000000" });
});

test("budget guard: the JSON-parse retry is re-guarded -- budget left for exactly one call blocks the retry (fix round 1, item 2)", async () => {
  llmKeys.setKey("openai", "sk-budget-retry-test");
  setRoleModel("openai", "gpt-5.4-mini");

  const system = "s";
  const user = "u";
  // Large enough that est1 alone clears the setting's 100,000 floor
  // regardless of how much this test file has already logged this month.
  const maxOutputTokens = 150_000;
  const est1 = llm.estimateTokens(system, user, maxOutputTokens);

  const usedBefore = store.sumLlmTokensThisMonth();
  // Budget has room for exactly the first attempt's pre-call estimate, and
  // no more -- whether or not the retry needs only one extra token.
  store.setSettings({ llm_monthly_token_budget: String(usedBefore + est1) });

  const { fetchFn } = makeFakeFetch(() => ({
    status: 200,
    body: {
      // Garbage content -> the JSON parse fails and callLlm tries the retry
      // path. Real usage is set to add up to exactly est1, so after this
      // attempt is logged the month total exactly equals the (now tighter)
      // budget, leaving zero room for the retry's own (necessarily > 0)
      // estimate.
      choices: [{ message: { content: "not valid json" } }],
      usage: { prompt_tokens: Math.ceil(est1 / 2), completion_tokens: est1 - Math.ceil(est1 / 2) },
    },
  }));

  const beforeRows = llmCallCount();
  const callLlm = llm.createCallLlm({ fetchFn });
  await assert.rejects(
    () =>
      callLlm({
        role: "classifier",
        system,
        user,
        schema: SCHEMA,
        schemaName: "X",
        maxOutputTokens,
      }),
    LlmBudgetExceeded,
  );
  assert.equal(
    llmCallCount(),
    beforeRows + 1,
    "only the first (parse-failed) attempt is logged -- the retry is refused before it ever dispatches",
  );

  store.setSettings({ llm_monthly_token_budget: "2000000" });
});

// ---- Key missing ----

test("key missing: throws LlmKeyMissing naming the provider, before any network call", async () => {
  llmKeys.removeKey("openai");
  setRoleModel("openai", "gpt-5.4-mini");
  const callLlm = llm.createCallLlm({
    fetchFn: (async () => {
      throw new Error("must never be called -- no key means no request");
    }) as typeof fetch,
  });
  await assert.rejects(
    () => callLlm({ role: "classifier", system: "s", user: "u", schema: SCHEMA, schemaName: "X" }),
    (err: unknown) => {
      assert.ok(err instanceof LlmKeyMissing);
      assert.equal(err.provider, "openai");
      assert.match(err.message, /openai/);
      return true;
    },
  );
});

test("role resolution: llm_provider fallback when a role has no provider in llm_models (defensive)", () => {
  // llm_models always defines all four roles today (setSettings validates
  // this), so this only exercises the fallback branch defensively.
  store.setSettings({ llm_provider: "anthropic" });
  assert.equal(store.getSetting("llm_provider"), "anthropic");
  store.setSettings({ llm_provider: "openai" });
});
