// Round 4 Task A0: shared types and error classes for harness/src/llm/*.
// This is the one file every provider adapter and index.ts import from --
// keeping the public shape (LlmRole/LlmProvider/LlmRequest/LlmResult/
// CallLlm) and the internal shape (ProviderCallParams/ProviderCallResult,
// the three thrown error classes) in one place so nothing drifts.

/** The call sites the analysis pipeline needs a model for (harness/src/analysis/*). Round 5 Task 1 renames "miner" to "rule_writer" (harness/src/analysis/propose.ts, formerly mine.ts) and adds "judge" for the adherence/verdict pipeline -- see harness/src/store.ts's LlmRole/getLlmModels, which this type must stay in sync with. */
export type LlmRole = "classifier" | "rule_writer" | "judge" | "reviewer" | "proposer";

/** The three API providers (plain `fetch`, keyed via harness/src/llm-keys.ts) plus the local CLI subscription provider (no key). */
export type LlmProvider = "openai" | "anthropic" | "google" | "claude_code";

/**
 * One structured-output call. `schema`/`schemaName` describe the JSON the
 * caller wants back (used verbatim as OpenAI's json_schema, Anthropic's
 * tool input_schema, Google's responseSchema); `maxOutputTokens` defaults
 * to 1500 in index.ts when omitted. `runId` ties the resulting `llm_calls`
 * row to an `analysis_runs` row (Task A3) -- optional because a call made
 * outside a run (e.g. a manual test) has none.
 */
export type LlmRequest = {
  role: LlmRole;
  system: string;
  user: string;
  schema: object;
  schemaName: string;
  maxOutputTokens?: number;
  runId?: number;
};

/** What every successful call returns, regardless of provider. `costUsd` is null when the model has no price-table entry, or for `claude_code` (a subscription call has no per-call USD price). */
export type LlmResult<T> = {
  json: T;
  provider: LlmProvider;
  model: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number | null;
  latencyMs: number;
};

export type CallLlm = <T>(req: LlmRequest) => Promise<LlmResult<T>>;

/**
 * Thrown by the budget guard (harness/src/llm/budget.ts) before any provider
 * is called -- `used`/`budget` are both token counts, so the caller (and its
 * error message) can say exactly how far over the guard refused to go
 * without needing to re-read settings/llm_calls itself.
 */
export class LlmBudgetExceeded extends Error {
  public readonly used: number;
  public readonly budget: number;

  constructor(used: number, budget: number) {
    super(`LLM monthly token budget exceeded: used ${used} of ${budget} tokens this month`);
    this.name = "LlmBudgetExceeded";
    this.used = used;
    this.budget = budget;
  }
}

/**
 * Thrown when an API provider (openai/anthropic/google) has no stored key
 * for the resolved role. Names the provider only -- never the key, which
 * this error never even has access to (harness/src/llm-keys.ts's getKey
 * returns null, not the key, when none is stored).
 */
export class LlmKeyMissing extends Error {
  public readonly provider: LlmProvider;

  constructor(provider: LlmProvider) {
    super(`No API key configured for provider "${provider}" -- add one in Settings.`);
    this.name = "LlmKeyMissing";
    this.provider = provider;
  }
}

/** Thrown by the claude_code adapter when the `claude` CLI isn't on PATH / `claude --version` fails. */
export class LlmProviderUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmProviderUnavailable";
  }
}

// ---- Internal to the provider adapters (openai.ts/anthropic.ts/google.ts) ----

/** What each of the three API adapters' `call()` takes -- one shared shape so index.ts can dispatch without a per-provider param list. */
export type ProviderCallParams = {
  apiKey: string;
  model: string;
  system: string;
  user: string;
  maxOutputTokens: number;
  jsonSchema: { name: string; schema: object };
  fetchFn: typeof fetch;
};

/**
 * `raw` is either a JSON string the provider returned (OpenAI/Google -- not
 * yet parsed, so index.ts's uniform "strict parse, retry once" logic applies
 * to every provider the same way) or an already-parsed object (Anthropic's
 * tool-forcing hands back a native value, no string to parse).
 */
export type ProviderCallResult = {
  raw: unknown;
  tokensIn: number;
  tokensOut: number;
};
