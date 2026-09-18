// Checkpoint 2026-09-18 2-E: OpenAI's chat-completions parameters differ by
// model family. A newer model (an "o"-series reasoning model, or the
// gpt-5 family) rejects `max_tokens` (it wants `max_completion_tokens`
// instead) and rejects a caller-supplied `temperature` entirely (reasoning
// models only support the API default). This is the ONE place that
// distinction is made -- openai.ts builds its request body from
// openAiParamsFor's answer instead of checking model name substrings
// itself, so there is exactly one table to update when OpenAI ships another
// model family.
export type OpenAiParamStrategy = {
  /** Which token-limit parameter this model's chat-completions call accepts. */
  tokenParam: "max_tokens" | "max_completion_tokens";
  /** Whether a `temperature` field may be sent at all. */
  supportsTemperature: boolean;
};

// Newer/"reasoning" families: o1/o3/o4 (all sizes/dates) and gpt-5 (all
// variants) only accept `max_completion_tokens` and reject any
// caller-supplied `temperature` (their sampling temperature is fixed).
const NO_TEMPERATURE_PREFIXES = ["o1", "o3", "o4", "gpt-5"];

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
  if (CLASSIC_PREFIXES.some((prefix) => model.startsWith(prefix))) {
    return { tokenParam: "max_tokens", supportsTemperature: true };
  }
  if (NO_TEMPERATURE_PREFIXES.some((prefix) => model.startsWith(prefix))) {
    return { tokenParam: "max_completion_tokens", supportsTemperature: false };
  }
  return { tokenParam: "max_completion_tokens", supportsTemperature: false };
}
