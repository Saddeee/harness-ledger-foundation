// Round 4 Task A0: the only thing harness/src/analysis/* (not yet built)
// ever imports from harness/src/llm/. createCallLlm(deps) wires the four
// provider adapters, the key store, the budget guard and llm_calls logging
// behind the single CallLlm signature (types.ts).
import * as store from "../store.js";
import { getKey } from "../llm-keys.js";
import type { LlmModels, LlmRole as StoreLlmRole } from "../store.js";
import type { CallLlm, LlmProvider, LlmRequest, LlmResult, LlmRole } from "./types.js";
import { LlmKeyMissing } from "./types.js";
import { assertWithinBudget, estimateTokens } from "./budget.js";
import { costUsd } from "./prices.js";
import { callOpenAi } from "./openai.js";
import { callAnthropic } from "./anthropic.js";
import { callGoogle } from "./google.js";
import { callClaudeCode, defaultExec, type Exec } from "./claude-code.js";

export * from "./types.js";
export { priceFor, costUsd, PRICE_TABLE_USD_PER_1M } from "./prices.js";
export { estimateTokens, assertWithinBudget } from "./budget.js";
export { defaultExec, type Exec } from "./claude-code.js";

const DEFAULT_MAX_OUTPUT_TOKENS = 1500;
const RETRY_SUFFIX = "\n\nReturn only JSON matching the schema.";

// setSettings validates llm_models to always define all four roles, so in
// practice `choice` below is always present and the llm_provider fallback
// never fires -- it exists for defense in depth against a hand-edited
// settings row or a JSON.parse failure, per the plan's "role -> llm_models
// with llm_provider fallback."
function resolveRoleModel(role: LlmRole): { provider: LlmProvider; model: string } {
  let models: Partial<LlmModels> = {};
  try {
    models = JSON.parse(store.getSetting("llm_models")) as Partial<LlmModels>;
  } catch {
    models = {};
  }
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

export function createCallLlm(deps?: { fetchFn?: typeof fetch; exec?: Exec }): CallLlm {
  const fetchFn = deps?.fetchFn ?? fetch;
  const exec = deps?.exec ?? defaultExec;

  return async function callLlm<T>(req: LlmRequest): Promise<LlmResult<T>> {
    const { provider, model } = resolveRoleModel(req.role);

    let apiKey = "";
    if (provider !== "claude_code") {
      const key = getKey(provider);
      if (!key) throw new LlmKeyMissing(provider);
      apiKey = key;
    }

    const maxOutputTokens = req.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    const estimate = estimateTokens(req.system, req.user, maxOutputTokens);
    assertWithinBudget(estimate);

    const jsonSchema = { name: req.schemaName, schema: req.schema };

    // One attempt at the provider: dispatch, log to llm_calls (every
    // attempt is logged, success or JSON-parse failure alike -- tokens were
    // spent either way), and return the raw result for the caller to try
    // to parse.
    async function dispatchOnce(userText: string) {
      const t0 = Date.now();
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
    }

    function toResult(attempt: Awaited<ReturnType<typeof dispatchOnce>>): LlmResult<T> {
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

    const first = await dispatchOnce(req.user);
    try {
      return toResult(first);
    } catch {
      // Strict JSON parse failed -- retry once with a stricter instruction.
      // Logged again above (a call that burned tokens but returned garbage
      // still cost money). If this second attempt also fails to parse, the
      // error propagates to the caller uncaught.
      const retried = await dispatchOnce(req.user + RETRY_SUFFIX);
      return toResult(retried);
    }
  };
}
