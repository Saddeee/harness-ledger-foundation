// Round 4 Task A0: Anthropic adapter. JSON via tool-forcing (exploration
// doc §1) -- reliable across models, no beta header, and the parsed object
// comes back as a native JS value under content[].input, not a string to
// re-parse.
import type { ProviderCallParams, ProviderCallResult } from "./types.js";

type AnthropicContentBlock = { type: string; input?: unknown };
type AnthropicResponse = {
  content?: AnthropicContentBlock[];
  usage?: { input_tokens?: number; output_tokens?: number };
};

const ENDPOINT = "https://api.anthropic.com/v1/messages";
const TOOL_NAME = "emit_result";

export async function callAnthropic(params: ProviderCallParams): Promise<ProviderCallResult> {
  const { apiKey, model, system, user, maxOutputTokens, jsonSchema, fetchFn } = params;

  const res = await fetchFn(ENDPOINT, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxOutputTokens,
      temperature: 0,
      system,
      messages: [{ role: "user", content: user }],
      tools: [
        {
          name: TOOL_NAME,
          description: "Return the structured result.",
          input_schema: jsonSchema.schema,
          strict: true,
        },
      ],
      tool_choice: { type: "tool", name: TOOL_NAME },
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    // Never include headers/request body -- the key lives only in the
    // x-api-key header, never echoed by the provider. `status` is attached
    // (not just embedded in the message) so index.ts's transport retry can
    // tell a 429/5xx apart from any other failure without parsing text.
    const bodyText = await res.text().catch(() => "");
    const error = new Error(
      `Anthropic request failed: ${res.status} ${bodyText}`.slice(0, 500),
    ) as Error & {
      status?: number;
    };
    error.status = res.status;
    throw error;
  }

  const data = (await res.json()) as AnthropicResponse;
  const block = (data.content ?? []).find((b) => b.type === "tool_use");
  return {
    raw: block?.input ?? null,
    tokensIn: data.usage?.input_tokens ?? 0,
    tokensOut: data.usage?.output_tokens ?? 0,
  };
}
