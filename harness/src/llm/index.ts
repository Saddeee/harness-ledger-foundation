// Round 4 Task A0: the only thing harness/src/analysis/* (not yet built)
// ever imports from harness/src/llm/. createCallLlm(deps) wires the four
// provider adapters, the key store, the budget guard and llm_calls logging
// behind the single CallLlm signature (types.ts).
import * as store from "../store.js";
import { getKey } from "../llm-keys.js";
import type { LlmRole as StoreLlmRole } from "../store.js";
import type { CallLlm, LlmProvider, LlmRequest, LlmResult, LlmRole } from "./types.js";
import { LlmKeyMissing } from "./types.js";
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
          ({ raw, tokensIn, tokensOut } = await callOpenAi({
            apiKey,
            model,
            system: req.system,
            user: userText,
            maxOutputTokens,
            jsonSchema,
            fetchFn,
          }));
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
