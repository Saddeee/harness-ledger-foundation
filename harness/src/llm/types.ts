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
  /**
   * Checkpoint 2026-09-18 2-E: only openai.ts populates this -- the
   * parameter strategy actually used for the request that succeeded, and
   * whether a first attempt had to be retried with an adjusted strategy
   * after a 400 naming an unsupported parameter (see openAiRetryInfoFor in
   * openai.ts). index.ts reads this to log the strategy without either
   * provider adapter needing to know about llm_calls/events itself.
   */
  openai?: {
    tokenParam: "max_tokens" | "max_completion_tokens";
    temperatureSent: boolean;
    retried: boolean;
    retry?: OpenAiRetryInfo;
  };
};

// ---- Checkpoint 2026-09-18 2-E: OpenAI parameter-compatibility errors ----

/** What a failed OpenAI call is bucketed into, so index.ts/testProvider can react (retry, or not) without re-parsing the message text a second time. */
export type LlmErrorCategory =
  "invalid_parameter" | "invalid_model" | "auth" | "rate_limit" | "server" | "network" | "other";

/** Which request parameter a 400 named as unsupported, and what openai.ts retried with (or `"removed"` for temperature, which has no substitute). Attached to a retried success's `ProviderCallResult.openai.retry` and, when the retry also failed (or none was attempted), to the thrown `LlmProviderError.retry`. */
export type OpenAiRetryInfo = {
  rejectedParam: "max_tokens" | "max_completion_tokens" | "temperature";
  resolution: "max_tokens" | "max_completion_tokens" | "removed";
};

/**
 * What `testProvider()` (index.ts) returns for the Settings "Test provider"
 * button (executor route action `test_provider`) -- `strategy` is only
 * present for an OpenAI call (the other providers have no parameter
 * compatibility question), and only on success (a failed call's `message`
 * already says what went wrong).
 */
export type ProviderTestResult = {
  ok: boolean;
  provider: LlmProvider;
  model: string;
  strategy?: { tokenParam: "max_tokens" | "max_completion_tokens"; temperatureSent: boolean };
  estimated_tokens: number;
  message: string;
};

/**
 * Thrown by openai.ts for any non-2xx response, in place of a plain Error,
 * so index.ts and testProvider can branch on `category`/`status` without
 * parsing `message` -- `message` itself is already redacted (never the
 * Authorization header, request body, or response headers; any
 * `sk-...`-shaped token is stripped) and safe to show a user or log.
 */
export class LlmProviderError extends Error {
  public readonly status?: number;
  public readonly category: LlmErrorCategory;
  public readonly retry?: OpenAiRetryInfo;

  constructor(
    message: string,
    category: LlmErrorCategory,
    status?: number,
    retry?: OpenAiRetryInfo,
  ) {
    super(message);
    this.name = "LlmProviderError";
    this.category = category;
    this.status = status;
    this.retry = retry;
  }
}
