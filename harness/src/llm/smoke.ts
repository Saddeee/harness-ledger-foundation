// Round 4 fix wave item 7: a live smoke test of the real LLM call path --
// no mocks, one real classifier call, run by a human via
// `npm run llm:smoke` (from harness/). This is the ONLY place in the repo
// that is allowed to make a real LLM call; every test (harness/test/*.test.ts)
// injects a fake CallLlm or a fake fetch/exec instead.
//
// Uses a TEMP database (HARNESS_DB_PATH is pointed at a throwaway file
// BEFORE store.js/db.js are ever imported, so this never touches
// harness/data/harness.db) and configures the classifier role to provider
// `claude_code` / model `haiku` -- the local `claude` CLI on the machine's
// own Claude Code subscription, so this needs no API key. Prints the parsed
// JSON and token usage only -- never key material (there is none to print
// here; an API-provider run would still never have one, since
// harness/src/llm-keys.ts's getKey return value never flows into a log
// line anywhere in this codebase).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDbDir = mkdtempSync(join(tmpdir(), "harness-llm-smoke-"));
process.env.HARNESS_DB_PATH = join(tmpDbDir, "harness.db");

const { dbPath } = await import("../db.js");
const store = await import("../store.js");
const { createCallLlm } = await import("./index.js");
const { classifierSystemPrompt, classifierUserPrompt, CLASSIFIER_JSON_SCHEMA } =
  await import("../analysis/classify.js");

// Fixed two-line fixture -- exactly what classify.ts would hand the model
// for one real user message with no prior context.
const FIXTURE_MESSAGE =
  "The login button does nothing when I click it, it's completely broken.\n" +
  "This is blocking the whole signup flow, please fix it now.";

function setClassifierRoleModel(provider: string, model: string): void {
  const models = JSON.parse(store.getSetting("llm_models")) as Record<string, unknown>;
  store.setSettings({
    llm_models: JSON.stringify({ ...models, classifier: { provider, model } }),
  });
}

async function main(): Promise<void> {
  console.log(`Temp DB: ${dbPath()}`);
  setClassifierRoleModel("claude_code", "haiku");

  const callLlm = createCallLlm();
  const result = await callLlm<{ classification: string; tags: string[]; summary: string }>({
    role: "classifier",
    system: classifierSystemPrompt(),
    user: classifierUserPrompt({ content: FIXTURE_MESSAGE }, []),
    schema: CLASSIFIER_JSON_SCHEMA,
    schemaName: "message_classification",
  });

  console.log(`Provider: ${result.provider}  Model: ${result.model}`);
  console.log(`Parsed JSON: ${JSON.stringify(result.json, null, 2)}`);
  console.log(
    `Tokens in/out: ${result.tokensIn}/${result.tokensOut}  Latency: ${result.latencyMs}ms  Cost USD: ${result.costUsd ?? "n/a (claude_code subscription)"}`,
  );
}

main().catch((err) => {
  console.error("llm:smoke failed:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
