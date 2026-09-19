// Round 4 Task A0: OpenAI adapter. Exact shape per the exploration doc
// (docs/superpowers/specs/explorations/analysis-pipeline.md §1) --
// Structured Outputs (json_schema, strict: true) so the response string is
// guaranteed to parse against the schema when the provider honours it;
// index.ts still JSON.parses (and retries once) defensively regardless.
//
// Checkpoint 2026-09-18 2-E: a newer OpenAI model can reject `max_tokens`
// (it wants `max_completion_tokens`) and reject `temperature` outright. The
// request body is built from capabilities.ts's openAiParamsFor(model)
// instead of always sending both; a 400 that still names one of these
// parameters as unsupported is retried with that parameter swapped or
// removed.
//
// 2026-09-19 demo hardening: up to TWO corrective retries are now allowed
// (three attempts total) -- a classic-family model can reject `max_tokens`
// on attempt 1 and then reject `temperature` on attempt 2 (two independent
// unsupported parameters in the same request), and both need fixing before
// a call from an older/misconfigured client succeeds. Each retry must
// change the strategy from the previous attempt (retryStrategyFor never
// returns an adjustment the current strategy doesn't actually need), so no
// two attempts ever send an identical body, and a third identical/
// unresolvable error still throws rather than retrying a fourth time.
import type { ProviderCallParams, ProviderCallResult } from "./types.js";
import { LlmProviderError, type OpenAiRetryInfo } from "./types.js";
import { openAiParamsFor, type OpenAiParamStrategy } from "./capabilities.js";

type OpenAiResponse = {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

type OpenAiErrorBody = {
  error?: { message?: string; param?: string | null; code?: string | null; type?: string | null };
};

const ENDPOINT = "https://api.openai.com/v1/chat/completions";

// Never let a stored key leak into a thrown message -- the key only ever
// lives in the Authorization header (never echoed by the provider), but a
// provider error body or a caller-composed message could still happen to
// contain something key-shaped, so anything matching this is stripped
// wherever a message text is built below.
const SECRET_PATTERN = /sk-[A-Za-z0-9_-]{6,}/g;

/** Exported for the compat test suite (item g); every message this file throws or logs is passed through it. */
export function redactSecrets(text: string): string {
  return text.replace(SECRET_PATTERN, "sk-***");
}

function tryParseJson(text: string): OpenAiErrorBody | null {
  try {
    return JSON.parse(text) as OpenAiErrorBody;
  } catch {
    return null;
  }
}

function classifyError(
  status: number,
  errObj: OpenAiErrorBody["error"],
  message: string,
): "invalid_parameter" | "invalid_model" | "auth" | "rate_limit" | "server" | "other" {
  if (status === 401) return "auth";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "server";
  if (status === 404) return "invalid_model";

  const text =
    `${errObj?.code ?? ""} ${errObj?.type ?? ""} ${errObj?.param ?? ""} ${message}`.toLowerCase();
  if (
    text.includes("model_not_found") ||
    text.includes("does not exist") ||
    text.includes("model not found")
  ) {
    return "invalid_model";
  }
  if (status === 400) {
    if (
      Boolean(errObj?.param) ||
      text.includes("max_completion_tokens") ||
      text.includes("max_tokens") ||
      text.includes("temperature")
    ) {
      return "invalid_parameter";
    }
    return "other";
  }
  return "other";
}

/**
 * When a 400 names an unsupported parameter, what to retry with -- `null`
 * when the erroring parameter can't be identified (param field absent and
 * the message names nothing recognised), or when the identified parameter
 * doesn't match anything the current strategy actually sent (never retry an
 * identical request). `max_completion_tokens` is checked before
 * `max_tokens` -- today the two substrings never both appear in a real
 * OpenAI error and neither is a substring of the other, but 2026-09-19
 * demo hardening adds an explicit guard on the `max_tokens` branch anyway:
 * when the `param` field is present, it is authoritative, so don't treat a
 * `max_tokens` swap as needed when OpenAI actually named
 * `max_completion_tokens` as the offending parameter.
 */
function retryStrategyFor(
  strategy: OpenAiParamStrategy,
  errObj: OpenAiErrorBody["error"],
  message: string,
): { strategy: OpenAiParamStrategy; info: OpenAiRetryInfo } | null {
  const param = (errObj?.param ?? "").toLowerCase();
  const text = `${param} ${message}`.toLowerCase();

  if (strategy.tokenParam === "max_completion_tokens" && text.includes("max_completion_tokens")) {
    return {
      strategy: { ...strategy, tokenParam: "max_tokens" },
      info: { rejectedParam: "max_completion_tokens", resolution: "max_tokens" },
    };
  }
  if (
    strategy.tokenParam === "max_tokens" &&
    text.includes("max_tokens") &&
    param !== "max_completion_tokens"
  ) {
    return {
      strategy: { ...strategy, tokenParam: "max_completion_tokens" },
      info: { rejectedParam: "max_tokens", resolution: "max_completion_tokens" },
    };
  }
  if (strategy.supportsTemperature && text.includes("temperature")) {
    return {
      strategy: { ...strategy, supportsTemperature: false },
      info: { rejectedParam: "temperature", resolution: "removed" },
    };
  }
  return null;
}

function buildBody(
  model: string,
  system: string,
  user: string,
  maxOutputTokens: number,
  jsonSchema: { name: string; schema: object },
  strategy: OpenAiParamStrategy,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: jsonSchema.name, strict: true, schema: jsonSchema.schema },
    },
  };
  body[strategy.tokenParam] = maxOutputTokens;
  if (strategy.supportsTemperature) body.temperature = 0;
  return body;
}

// 2026-09-19 demo hardening: at most two corrective retries (three
// attempts total) -- see the header comment for why one is no longer
// always enough.
const MAX_RETRIES = 2;

export async function callOpenAi(params: ProviderCallParams): Promise<ProviderCallResult> {
  const { apiKey, model, system, user, maxOutputTokens, jsonSchema, fetchFn } = params;
  const initialStrategy = openAiParamsFor(model);

  async function attempt(
    strategy: OpenAiParamStrategy,
    attemptNumber: number,
    lastRetryInfo?: OpenAiRetryInfo,
  ): Promise<ProviderCallResult> {
    const body = buildBody(model, system, user, maxOutputTokens, jsonSchema, strategy);

    let res: Response;
    try {
      res = await fetchFn(ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (networkErr) {
      const detail = networkErr instanceof Error ? networkErr.name || networkErr.message : "";
      throw new LlmProviderError(
        redactSecrets(`OpenAI request failed: network error${detail ? ` (${detail})` : ""}`),
        "network",
      );
    }

    if (!res.ok) {
      // Never include headers or the request body in the thrown message --
      // the key lives only in the Authorization header, never echoed by the
      // provider, but redactSecrets below keeps that guarantee true even if
      // a response body ever happened to echo something key-shaped.
      const bodyText = await res.text().catch(() => "");
      const parsed = tryParseJson(bodyText);
      const errObj = parsed?.error;
      const rawMessage = errObj?.message ?? bodyText;
      const message = redactSecrets(String(rawMessage)).slice(0, 500);
      const category = classifyError(res.status, errObj, message);

      if (category === "invalid_parameter" && attemptNumber < MAX_RETRIES) {
        const adjusted = retryStrategyFor(strategy, errObj, message);
        if (adjusted) {
          return attempt(adjusted.strategy, attemptNumber + 1, adjusted.info);
        }
      }

      throw new LlmProviderError(
        redactSecrets(`OpenAI request failed: ${res.status} ${message}`).slice(0, 500),
        category,
        res.status,
        attemptNumber > 0 ? lastRetryInfo : undefined,
      );
    }

    const data = (await res.json()) as OpenAiResponse;
    const content = data.choices?.[0]?.message?.content;
    return {
      raw: content ?? null,
      tokensIn: data.usage?.prompt_tokens ?? 0,
      tokensOut: data.usage?.completion_tokens ?? 0,
      openai: {
        tokenParam: strategy.tokenParam,
        temperatureSent: strategy.supportsTemperature,
        retried: attemptNumber > 0,
        retry: lastRetryInfo,
      },
    };
  }

  return attempt(initialStrategy, 0);
}
