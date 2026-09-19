// Checkpoint 2026-09-18 2-E: OpenAI's chat-completions parameters differ by
// model family. A newer model (an "o"-series reasoning model, or the
// gpt-5 family) rejects `max_tokens` (it wants `max_completion_tokens`
// instead) and rejects a caller-supplied `temperature` entirely (reasoning
// models only support the API default). This is the ONE place that
// distinction is made -- openai.ts builds its request body from
// openAiParamsFor's answer instead of checking model name substrings
// itself, so there is exactly one table to update when OpenAI ships another
// model family.
//
// 2026-09-19 demo hardening: matching is case-insensitive and
// whitespace-trimmed (Settings input isn't normalized upstream), and
// chatgpt- prefixed aliases are treated as the strict/newer contract too.
export type OpenAiParamStrategy = {
  /** Which token-limit parameter this model's chat-completions call accepts. */
  tokenParam: "max_tokens" | "max_completion_tokens";
  /** Whether a `temperature` field may be sent at all. */
  supportsTemperature: boolean;
};

// Newer/"reasoning" families: o1/o3/o4 (all sizes/dates), gpt-5 (all
// variants -- "gpt-5" as a prefix already covers gpt-5.5, gpt-5.4-mini,
// gpt-5-mini, etc.), and the chatgpt- aliases only accept
// `max_completion_tokens` and reject any caller-supplied `temperature`
// (their sampling temperature is fixed).
const NO_TEMPERATURE_PREFIXES = ["o1", "o3", "o4", "gpt-5", "chatgpt-"];

// Established chat-completions families: still accept the original
// `max_tokens` field and a caller-chosen `temperature`.
const CLASSIC_PREFIXES = ["gpt-4o", "gpt-4.1", "gpt-4", "gpt-3.5"];

/**
 * Returns the parameter strategy openai.ts must build its request body with
 * for `model`. Matching is by prefix (OpenAI model strings carry dated/sized
 * suffixes, e.g. "gpt-4o-2024-08-06" or "o3-mini") -- CLASSIC_PREFIXES and
 * NO_TEMPERATURE_PREFIXES never overlap, so which array is checked first
 * doesn't matter for any prefix on either list today.
 *
 * A model matching neither list (a family this table has never seen) gets
 * the newer, stricter contract: `max_completion_tokens`, no `temperature`.
 * That is the safest default because it is the only strategy that never
 * sends a parameter a model might reject outright -- worst case an unknown
 * *older* model also happens to accept `max_completion_tokens` (OpenAI has
 * kept that field additive across families) and simply ignores the missing
 * `temperature`, running at its own default. The reverse guess (assuming
 * `max_tokens`/`temperature` for an unknown model) risks the exact 400 this
 * checkpoint exists to fix, and would do so silently until openai.ts's
 * one-shot retry catches it -- one wasted request every time versus zero.
 */
export function openAiParamsFor(model: string): OpenAiParamStrategy {
  // 2026-09-19 demo hardening: a user can type a model name into Settings
  // with stray casing/whitespace ("GPT-5.5 ") -- normalize before matching
  // so that still gets the strict contract instead of falling through to
  // the (also-strict, but coincidentally-correct-for-the-wrong-reason)
  // unknown-family default.
  const normalized = model.trim().toLowerCase();
  if (CLASSIC_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return { tokenParam: "max_tokens", supportsTemperature: true };
  }
  if (NO_TEMPERATURE_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return { tokenParam: "max_completion_tokens", supportsTemperature: false };
  }
  return { tokenParam: "max_completion_tokens", supportsTemperature: false };
}
