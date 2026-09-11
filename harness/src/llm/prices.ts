import type { LlmProvider } from "./types.js";

// Round 4 Task A0: the ONE place pricing changes ever need to be made.
// USD per 1,000,000 tokens, keyed by the exact model string a settings.
// llm_models role entry names. An unknown model string (a typo, or a
// brand-new release not added here yet) is not a silent free call -- it
// just means priceFor/costUsd return null and the Settings page shows
// tokens only for that call, same as claude_code always does (a
// subscription call has no per-call USD price at all). The token budget
// guard (budget.ts) never depends on this table, so an unpriced model is
// never blocked from running.
export type Price = { in: number; out: number };

export const PRICE_TABLE_USD_PER_1M: Record<string, Price> = {
  // Anthropic -- a few current models.
  "claude-haiku-4-5": { in: 1.0, out: 5.0 },
  "claude-sonnet-5": { in: 2.0, out: 10.0 },
  // OpenAI -- matches this repo's DEFAULT_LLM_MODELS in store.ts.
  "gpt-5.4-mini": { in: 0.25, out: 1.0 },
  "gpt-5.5": { in: 1.25, out: 5.0 },
  // Google -- a couple of current Gemini tiers.
  "gemini-3.1-flash-lite": { in: 0.1, out: 0.4 },
  "gemini-3.7-flash": { in: 0.3, out: 1.2 },
};

/** `claude_code` (a subscription, not a metered API) always has no price. Any other unknown model string also returns null rather than a guessed number. */
export function priceFor(provider: LlmProvider, model: string): Price | null {
  if (provider === "claude_code") return null;
  return PRICE_TABLE_USD_PER_1M[model] ?? null;
}

/** null when the model has no price-table entry (or the provider is claude_code) -- never a guessed $0. */
export function costUsd(
  provider: LlmProvider,
  model: string,
  tokensIn: number,
  tokensOut: number,
): number | null {
  const price = priceFor(provider, model);
  if (!price) return null;
  return (tokensIn * price.in + tokensOut * price.out) / 1_000_000;
}
