// Round 4 Task A0: Google (Gemini) adapter. The key goes in the
// x-goog-api-key header, not the `?key=` query string the docs also
// support -- the exploration doc calls out the header explicitly so a key
// never lands in a URL that might get logged.
import type { ProviderCallParams, ProviderCallResult } from "./types.js";

type GoogleResponse = {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
};

function endpointFor(model: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
}

export async function callGoogle(params: ProviderCallParams): Promise<ProviderCallResult> {
  const { apiKey, model, system, user, maxOutputTokens, jsonSchema, fetchFn } = params;

  const res = await fetchFn(endpointFor(model), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens,
        responseMimeType: "application/json",
        responseSchema: jsonSchema.schema,
      },
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    // Never include headers/request body -- the key lives only in the
    // x-goog-api-key header, never echoed by the provider. `status` is
    // attached (not just embedded in the message) so index.ts's transport
    // retry can tell a 429/5xx apart from any other failure without parsing
    // text.
    const bodyText = await res.text().catch(() => "");
    const error = new Error(
      `Google request failed: ${res.status} ${bodyText}`.slice(0, 500),
    ) as Error & {
      status?: number;
    };
    error.status = res.status;
    throw error;
  }

  const data = (await res.json()) as GoogleResponse;
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  return {
    raw: text ?? null,
    tokensIn: data.usageMetadata?.promptTokenCount ?? 0,
    tokensOut: data.usageMetadata?.candidatesTokenCount ?? 0,
  };
}
