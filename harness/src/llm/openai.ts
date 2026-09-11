// Round 4 Task A0: OpenAI adapter. Exact shape per the exploration doc
// (docs/superpowers/specs/explorations/analysis-pipeline.md §1) --
// Structured Outputs (json_schema, strict: true) so the response string is
// guaranteed to parse against the schema when the provider honours it;
// index.ts still JSON.parses (and retries once) defensively regardless.
import type { ProviderCallParams, ProviderCallResult } from "./types.js";

type OpenAiResponse = {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

const ENDPOINT = "https://api.openai.com/v1/chat/completions";

export async function callOpenAi(params: ProviderCallParams): Promise<ProviderCallResult> {
  const { apiKey, model, system, user, maxOutputTokens, jsonSchema, fetchFn } = params;

  const res = await fetchFn(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: maxOutputTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: jsonSchema.name, strict: true, schema: jsonSchema.schema },
      },
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    // Never include headers/request body in the thrown message -- the key
    // lives only in the Authorization header, never echoed by the provider,
    // but this keeps that guarantee obviously true by construction. `status`
    // is attached (not just embedded in the message) so index.ts's transport
    // retry can tell a 429/5xx apart from any other failure without parsing
    // the message text.
    const bodyText = await res.text().catch(() => "");
    const error = new Error(
      `OpenAI request failed: ${res.status} ${bodyText}`.slice(0, 500),
    ) as Error & {
      status?: number;
    };
    error.status = res.status;
    throw error;
  }

  const data = (await res.json()) as OpenAiResponse;
  const content = data.choices?.[0]?.message?.content;
  return {
    raw: content ?? null,
    tokensIn: data.usage?.prompt_tokens ?? 0,
    tokensOut: data.usage?.completion_tokens ?? 0,
  };
}
