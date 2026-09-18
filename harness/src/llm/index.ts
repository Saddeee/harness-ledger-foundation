// Round 4 Task A0: the only thing harness/src/analysis/* (not yet built)
// ever imports from harness/src/llm/. createCallLlm(deps) wires the four
// provider adapters, the key store, the budget guard and llm_calls logging
// behind the single CallLlm signature (types.ts).
import * as store from "../store.js";
import { getKey } from "../llm-keys.js";
import type { LlmRole as StoreLlmRole } from "../store.js";
import type { CallLlm, LlmProvider, LlmRequest, LlmResult, LlmRole } from "./types.js";
import { LlmKeyMissing, LlmProviderError, type ProviderTestResult } from "./types.js";
import { assertWithinBudget, estimateTokens } from "./budget.js";
import { costUsd } from "./prices.js";
import { callOpenAi } from "./openai.js";
import { callAnthropic } from "./anthropic.js";
import { callGoogle } from "./google.js";
import { callClaudeCode, defaultExec, type Exec } from "./claude-code.js";
import { assertStrictCompatible } from "./schema.js";

export * from "./types.js";
export { priceFor, costUsd, PRICE_TABLE_USD_PER_1M } from "./prices.js";
export { estimateTokens, assertWithinBudget } from "./budget.js";
export { defaultExec, type Exec } from "./claude-code.js";
export { assertStrictCompatible } from "./schema.js";

const DEFAULT_MAX_OUTPUT_TOKENS = 1500;
const RETRY_SUFFIX = "\n\nReturn only JSON matching the schema.";
const TRANSPORT_RETRY_DELAY_MS = 2000;

/** Real default: a plain timer-based sleep. Tests inject their own to assert on the delay without actually waiting. */
function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Reads the `status` an API adapter (openai.ts/anthropic.ts/google.ts) attaches to its thrown Error on a non-2xx response. Undefined for a claude_code failure (no HTTP status) or a network-level throw (no response at all) -- neither is transport-retryable. */
function httpStatusOf(err: unknown): number | undefined {
  if (err && typeof err === "object" && "status" in err) {
    const status = (err as { status?: unknown }).status;
    return typeof status === "number" ? status : undefined;
  }
  return undefined;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

// setSettings validates llm_models to always define classifier/rule_writer/
// reviewer/proposer, so in practice `choice` below is always present for
// those four roles and the llm_provider fallback never fires for them -- it
// exists for defense in depth against a hand-edited settings row or a
// JSON.parse failure, per the plan's "role -> llm_models with llm_provider
// fallback." "judge" is genuinely optional (an upgraded DB has no judge
// entry until the user saves one), so its fallback -- to the rule_writer
// entry, then llm_provider -- is the normal path, not just defense in
// depth. store.getLlmModels() is the one place that fallback chain lives.
function resolveRoleModel(role: LlmRole): { provider: LlmProvider; model: string } {
  const models = store.getLlmModels();
  const choice = models[role as StoreLlmRole];
  const provider = (choice?.provider ?? store.getSetting("llm_provider")) as LlmProvider;
  const model = choice?.model;
  if (!model) {
    throw new Error(`no model configured for role "${role}" -- check the llm_models setting`);
  }
  return { provider, model };
}

/** Parses a provider's raw output into JSON. Providers that already hand back a parsed object (Anthropic's tool-forcing) pass straight through; string outputs (OpenAI/Google/claude_code) are JSON.parsed here, so index.ts's retry-on-parse-failure logic is uniform across every provider. */
function parseJsonResult<T>(raw: unknown): T {
  if (typeof raw === "string") return JSON.parse(raw) as T;
  if (raw === null || raw === undefined) throw new Error("empty response from provider");
  return raw as T;
}

// ---- Checkpoint 2026-09-18 2-E: OpenAI parameter strategy/error logging ----
// llm_calls has no column for a parameter strategy or an error category
// (see harness/src/migrations.ts's llm_calls table -- role/provider/model/
// tokens/cost/estimate/run_id only), and adding one is out of this WP's
// file list. The `events` table already exists for exactly this kind of
// "something worth recording happened" fact with a JSON payload
// (store.insertEvent), so the strategy actually used (and any internal
// retry) and a failed call's error category are recorded there instead --
// never with the API key, request body, or response headers; the message on
// a failure is `LlmProviderError.message`, which openai.ts has already
// redacted before it ever reaches here.
function recordOpenAiStrategyEvent(
  role: LlmRole,
  model: string,
  meta: NonNullable<Awaited<ReturnType<typeof callOpenAi>>["openai"]>,
): void {
  store.insertEvent("llm.call.strategy", null, {
    provider: "openai",
    role,
    model,
    token_param: meta.tokenParam,
    temperature_sent: meta.temperatureSent,
    retried: meta.retried,
    retry: meta.retry ?? null,
  });
}

function recordOpenAiErrorEvent(role: LlmRole, model: string, err: LlmProviderError): void {
  store.insertEvent("llm.call.strategy", null, {
    provider: "openai",
    role,
    model,
    error_category: err.category,
    status: err.status ?? null,
    retry: err.retry ?? null,
    message: err.message,
  });
}
// ---- end Checkpoint 2026-09-18 2-E ----

export function createCallLlm(deps?: {
  fetchFn?: typeof fetch;
  exec?: Exec;
  sleep?: (ms: number) => Promise<void>;
}): CallLlm {
  const fetchFn = deps?.fetchFn ?? fetch;
  const exec = deps?.exec ?? defaultExec;
  const sleep = deps?.sleep ?? realSleep;

  return async function callLlm<T>(req: LlmRequest): Promise<LlmResult<T>> {
    // Fix wave item 1: every schema dispatched through here must already be
    // strict-mode compatible (OpenAI Structured Outputs / Anthropic strict
    // tools both require it) -- checked before anything else so a bad schema
    // fails loudly at the call site, never silently at the provider.
    assertStrictCompatible(req.schema, req.schemaName);

    const { provider, model } = resolveRoleModel(req.role);

    let apiKey = "";
    if (provider !== "claude_code") {
      const key = getKey(provider);
      if (!key) throw new LlmKeyMissing(provider);
      apiKey = key;
    }

    const maxOutputTokens = req.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    const jsonSchema = { name: req.schemaName, schema: req.schema };

    // Exactly one physical call to the resolved provider. ALWAYS logs to
    // llm_calls, success or failure alike: on success with the real
    // tokens/cost, on failure with tokens 0 (a failed call still consumed a
    // request against the provider -- or, for claude_code, an actual `claude`
    // invocation -- and must never look like it never happened; the analysis
    // run's own `error` field is what records *why* it failed, not this
    // table). Always rethrows on failure so the caller (the transport retry
    // below, or callLlm's own JSON-parse retry) decides what to do next.
    async function attemptOnce(userText: string, estimate: number) {
      const t0 = Date.now();
      try {
        let raw: unknown;
        let tokensIn: number;
        let tokensOut: number;

        if (provider === "openai") {
          const openAiResult = await callOpenAi({
            apiKey,
            model,
            system: req.system,
            user: userText,
            maxOutputTokens,
            jsonSchema,
            fetchFn,
          });
          ({ raw, tokensIn, tokensOut } = openAiResult);
          // Checkpoint 2026-09-18 2-E: record the parameter strategy actually
          // used (and any internal retry openai.ts already resolved) so a
          // strategy change is visible without a column on llm_calls -- see
          // recordOpenAiStrategyEvent's own header for why events.
          if (openAiResult.openai) recordOpenAiStrategyEvent(req.role, model, openAiResult.openai);
        } else if (provider === "anthropic") {
          ({ raw, tokensIn, tokensOut } = await callAnthropic({
            apiKey,
            model,
            system: req.system,
            user: userText,
            maxOutputTokens,
            jsonSchema,
            fetchFn,
          }));
        } else if (provider === "google") {
          ({ raw, tokensIn, tokensOut } = await callGoogle({
            apiKey,
            model,
            system: req.system,
            user: userText,
            maxOutputTokens,
            jsonSchema,
            fetchFn,
          }));
        } else {
          ({ raw, tokensIn, tokensOut } = await callClaudeCode({
            model,
            system: req.system,
            user: userText,
            exec,
          }));
        }

        const latencyMs = Date.now() - t0;
        const cost = costUsd(provider, model, tokensIn, tokensOut);
        store.insertLlmCall({
          role: req.role,
          provider,
          model,
          tokens_in: tokensIn,
          tokens_out: tokensOut,
          cost_usd: cost ?? 0,
          estimated_tokens: estimate,
          run_id: req.runId ?? null,
        });
        return { raw, tokensIn, tokensOut, latencyMs, costUsd: cost };
      } catch (err) {
        store.insertLlmCall({
          role: req.role,
          provider,
          model,
          tokens_in: 0,
          tokens_out: 0,
          cost_usd: 0,
          estimated_tokens: estimate,
          run_id: req.runId ?? null,
        });
        // Checkpoint 2026-09-18 2-E: an OpenAI compatibility failure (bad
        // parameter, unknown model, rejected key, ...) is worth recording
        // even though the call failed -- llm_calls' own row above already
        // shows *that* it failed (tokens 0), this event records *why* in a
        // stable category a Settings page or support conversation can act
        // on, without ever repeating the (already-redacted) provider text
        // more than necessary.
        if (provider === "openai" && err instanceof LlmProviderError) {
          recordOpenAiErrorEvent(req.role, model, err);
        }
        throw err;
      }
    }

    // Transport retry (API providers only -- claude_code has no HTTP status
    // to key off): a 429/5xx is usually transient. One retry, after a fixed
    // delay -- not exponential backoff, this isn't an agentic loop, just a
    // short classification/extraction call. Both the failed and the
    // retried physical attempt are logged by attemptOnce above; a second
    // failure propagates as-is (no third try).
    async function dispatchWithTransportRetry(userText: string, estimate: number) {
      try {
        return await attemptOnce(userText, estimate);
      } catch (err) {
        const status = provider === "claude_code" ? undefined : httpStatusOf(err);
        if (status !== undefined && isRetryableStatus(status)) {
          await sleep(TRANSPORT_RETRY_DELAY_MS);
          return await attemptOnce(userText, estimate);
        }
        throw err;
      }
    }

    function toResult(attempt: Awaited<ReturnType<typeof attemptOnce>>): LlmResult<T> {
      const json = parseJsonResult<T>(attempt.raw);
      return {
        json,
        provider,
        model,
        tokensIn: attempt.tokensIn,
        tokensOut: attempt.tokensOut,
        costUsd: attempt.costUsd,
        latencyMs: attempt.latencyMs,
      };
    }

    const firstEstimate = estimateTokens(req.system, req.user, maxOutputTokens);
    assertWithinBudget(firstEstimate);
    const first = await dispatchWithTransportRetry(req.user, firstEstimate);
    try {
      return toResult(first);
    } catch {
      // Strict JSON parse failed -- retry once with a stricter instruction.
      // Re-guard the budget before this second dispatch: the first attempt
      // already logged its real tokens above, so a budget that had room for
      // exactly one call must refuse the retry rather than push the month
      // over. A refusal here throws LlmBudgetExceeded and dispatches
      // nothing -- the retry is never logged.
      const retryUserText = req.user + RETRY_SUFFIX;
      const retryEstimate = estimateTokens(req.system, retryUserText, maxOutputTokens);
      assertWithinBudget(retryEstimate);
      const retried = await dispatchWithTransportRetry(retryUserText, retryEstimate);
      return toResult(retried);
    }
  };
}

// ---- Checkpoint 2026-09-18 2-E: "Test provider" ----
// A tiny, real structured-output call through the configured provider for
// the classifier role -- deliberately NOT routed through createCallLlm/
// callLlm above (that logs llm_calls under the calling role, "classifier",
// which would make a manual connectivity check look like real analysis
// usage). Instead this calls the same provider adapter functions
// attemptOnce above dispatches to -- so an OpenAI call still exercises
// openai.ts's parameter-compatibility retry exactly as a real analysis call
// would -- and logs its own llm_calls/events rows under role
// "provider_test" so Settings' "spent this month" total still includes it
// (a real call really was made) without attributing it to any analysis
// role. Touches nothing else: no correction, rule, or improvement row.
const PROVIDER_TEST_MAX_OUTPUT_TOKENS = 30;
const PROVIDER_TEST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ok"],
  properties: { ok: { type: "boolean" } },
} as const;
const PROVIDER_TEST_SYSTEM = "Reply with only the required JSON.";
const PROVIDER_TEST_USER = 'Reply with {"ok": true} to confirm the connection is working.';

// Checkpoint 2026-09-18 2-E: mirrors src/lib/harness-ux.ts's own
// openAiParamRejectedLine/openAiModelNotFoundLine/OPENAI_KEY_REJECTED_LINE
// word for word -- kept as a local literal rather than imported (like
// AUTOMATIC_ANALYSIS_SETTING_KEY in analysis/context.ts) because harness/src
// and src/ are separate packages; a structural test
// (ux-provider-test.test.ts) keeps the two in lockstep.
function openAiCompatibilityMessage(model: string, err: LlmProviderError): string {
  if (err.category === "invalid_model") return `The model name ${model} was not found at OpenAI.`;
  if (err.category === "auth") return "OpenAI rejected the API key.";
  if (err.category === "invalid_parameter" && err.retry) {
    const retriedWith =
      err.retry.resolution === "removed" ? "no temperature parameter" : err.retry.resolution;
    return `OpenAI rejected a request parameter for model ${model} (${err.retry.rejectedParam}). Harness Ledger retried with ${retriedWith}.`;
  }
  return err.message;
}

export async function testProvider(deps?: {
  fetchFn?: typeof fetch;
  exec?: Exec;
}): Promise<ProviderTestResult> {
  const fetchFn = deps?.fetchFn ?? fetch;
  const exec = deps?.exec ?? defaultExec;

  // "for the classifier role" (2-E brief): the same provider/model the
  // classifier is actually configured to use, so the test reflects what
  // analysis will really call.
  const { provider, model } = resolveRoleModel("classifier");

  let apiKey = "";
  if (provider !== "claude_code") {
    const key = getKey(provider);
    if (!key) throw new LlmKeyMissing(provider);
    apiKey = key;
  }

  const jsonSchema = { name: "provider_test", schema: PROVIDER_TEST_SCHEMA };
  const estimate = estimateTokens(
    PROVIDER_TEST_SYSTEM,
    PROVIDER_TEST_USER,
    PROVIDER_TEST_MAX_OUTPUT_TOKENS,
  );
  // Same guard a real call goes through -- a provider test never bypasses
  // the monthly token cap.
  assertWithinBudget(estimate);

  function logResult(tokensIn: number, tokensOut: number, cost: number | null): void {
    store.insertLlmCall({
      // llm_calls.role has no CHECK constraint (a plain TEXT column;
      // migrations.ts's llm_calls table); "provider_test" is deliberately
      // not one of LlmRole's five analysis roles (types.ts), cast through
      // StoreLlmRole the same way every other insertLlmCall caller in this
      // file already narrows `req.role`.
      role: "provider_test" as unknown as StoreLlmRole,
      provider,
      model,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      cost_usd: cost ?? 0,
      estimated_tokens: estimate,
      run_id: null,
    });
  }

  try {
    let raw: unknown;
    let tokensIn = 0;
    let tokensOut = 0;
    let strategy:
      { tokenParam: "max_tokens" | "max_completion_tokens"; temperatureSent: boolean } | undefined;

    if (provider === "openai") {
      const result = await callOpenAi({
        apiKey,
        model,
        system: PROVIDER_TEST_SYSTEM,
        user: PROVIDER_TEST_USER,
        maxOutputTokens: PROVIDER_TEST_MAX_OUTPUT_TOKENS,
        jsonSchema,
        fetchFn,
      });
      ({ raw, tokensIn, tokensOut } = result);
      if (result.openai) {
        strategy = {
          tokenParam: result.openai.tokenParam,
          temperatureSent: result.openai.temperatureSent,
        };
        recordOpenAiStrategyEvent("classifier", model, result.openai);
      }
    } else if (provider === "anthropic") {
      ({ raw, tokensIn, tokensOut } = await callAnthropic({
        apiKey,
        model,
        system: PROVIDER_TEST_SYSTEM,
        user: PROVIDER_TEST_USER,
        maxOutputTokens: PROVIDER_TEST_MAX_OUTPUT_TOKENS,
        jsonSchema,
        fetchFn,
      }));
    } else if (provider === "google") {
      ({ raw, tokensIn, tokensOut } = await callGoogle({
        apiKey,
        model,
        system: PROVIDER_TEST_SYSTEM,
        user: PROVIDER_TEST_USER,
        maxOutputTokens: PROVIDER_TEST_MAX_OUTPUT_TOKENS,
        jsonSchema,
        fetchFn,
      }));
    } else {
      ({ raw, tokensIn, tokensOut } = await callClaudeCode({
        model,
        system: PROVIDER_TEST_SYSTEM,
        user: PROVIDER_TEST_USER,
        exec,
      }));
    }

    parseJsonResult<{ ok?: boolean }>(raw);
    const cost = costUsd(provider, model, tokensIn, tokensOut);
    logResult(tokensIn, tokensOut, cost);
    const totalTokens = tokensIn + tokensOut || estimate;

    return {
      ok: true,
      provider,
      model,
      strategy,
      estimated_tokens: totalTokens,
      message: `Provider test passed: ${model}, about ${totalTokens} tokens`,
    };
  } catch (err) {
    logResult(0, 0, 0);
    if (provider === "openai" && err instanceof LlmProviderError) {
      recordOpenAiErrorEvent("classifier", model, err);
      return {
        ok: false,
        provider,
        model,
        estimated_tokens: estimate,
        message: openAiCompatibilityMessage(model, err),
      };
    }
    return {
      ok: false,
      provider,
      model,
      estimated_tokens: estimate,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
// ---- end Checkpoint 2026-09-18 2-E ----
