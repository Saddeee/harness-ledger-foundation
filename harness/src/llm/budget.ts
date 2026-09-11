// Round 4 Task A0: the token budget guard. Budget is in tokens, not USD --
// a Claude Code subscription call has no per-call price, so tokens are the
// one number every provider can be metered by. The guard is a hard cap
// enforced BEFORE the call: the real cost is only known after the response
// comes back, so this estimates a conservative upper bound (input from
// `text.length / 4` rounded up, output from the literal `maxOutputTokens`
// cap the provider is told not to exceed) and refuses when
// `sumLlmTokensThisMonth() + estimate > budget`.
import * as store from "../store.js";
import { LlmBudgetExceeded } from "./types.js";

/** `ceil((system+user).length / 4) + maxOutputTokens` -- a cheap, conservative pre-call estimate, not the real post-call token count. */
export function estimateTokens(system: string, user: string, maxOutputTokens: number): number {
  return Math.ceil((system.length + user.length) / 4) + maxOutputTokens;
}

/** Throws LlmBudgetExceeded(used, budget) when `used + estimate` would exceed this month's `llm_monthly_token_budget` setting. Never itself logs anything -- a refused call costs nothing and is never written to llm_calls. */
export function assertWithinBudget(estimate: number): void {
  const used = store.sumLlmTokensThisMonth();
  const budget = Number(store.getSetting("llm_monthly_token_budget"));
  if (used + estimate > budget) {
    throw new LlmBudgetExceeded(used, budget);
  }
}
