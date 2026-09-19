// Checkpoint 2026-09-18 2-E: structural tests for the Settings > AI analysis
// "Test provider" button (item i) and the harness-ux.ts copy it uses, plus a
// lockstep check against harness/src/llm/index.ts's own (necessarily
// duplicated -- harness/src and src/ are separate packages) copy of the same
// three compatibility sentences. Same lightweight readApp/codeOnly pattern
// as ux-round5-evidence.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ux = await import("../../src/lib/harness-ux.ts");

function readApp(rel: string): string {
  return readFileSync(new URL(`../../src/${rel}`, import.meta.url), "utf8");
}
function readHarness(rel: string): string {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}
function codeOnly(source: string): string {
  return source
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return (
        !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*") && !t.startsWith("{/*")
      );
    })
    .join("\n");
}

const SETTINGS = "components/harness/local-settings.tsx";
const EXECUTOR_ROUTE = "routes/api/public/harness/executor.ts";
const LLM_INDEX = "src/llm/index.ts";

// ---- harness-ux.ts: the copy itself ----

test("harness-ux.ts: TEST_PROVIDER_BUTTON_LABEL and the consequence line say what the button does and don't overclaim", () => {
  assert.equal(ux.TEST_PROVIDER_BUTTON_LABEL, "Test provider");
  assert.equal(
    ux.TEST_PROVIDER_CONSEQUENCE_LINE,
    "Sends one tiny request to your AI provider. Uses a few AI tokens. Changes nothing.",
  );
});

test("harness-ux.ts: testProviderSuccessLine matches the spec's example verbatim", () => {
  assert.equal(
    ux.testProviderSuccessLine("gpt-4o", 40),
    "Provider test passed: gpt-4o, about 40 tokens",
  );
});

test("harness-ux.ts: openAiParamRejectedLine names the model, the rejected parameter, and what Harness Ledger retried with", () => {
  assert.equal(
    ux.openAiParamRejectedLine("gpt-5-thing", "max_tokens", "max_completion_tokens"),
    "OpenAI rejected a request parameter for model gpt-5-thing (max_tokens). Harness Ledger retried with max_completion_tokens.",
  );
  assert.equal(
    ux.openAiParamRejectedLine("gpt-5-thing", "temperature", "no temperature parameter"),
    "OpenAI rejected a request parameter for model gpt-5-thing (temperature). Harness Ledger retried with no temperature parameter.",
  );
  // No retry attempted (an unrecognised parameter): no false claim of a retry.
  assert.equal(
    ux.openAiParamRejectedLine("gpt-5-thing", "max_tokens", null),
    "OpenAI rejected a request parameter for model gpt-5-thing (max_tokens).",
  );
});

test("harness-ux.ts: openAiModelNotFoundLine and OPENAI_KEY_REJECTED_LINE match the spec's examples", () => {
  assert.equal(
    ux.openAiModelNotFoundLine("gpt-9-fictional"),
    "The model name gpt-9-fictional was not found at OpenAI.",
  );
  assert.equal(ux.OPENAI_KEY_REJECTED_LINE, "OpenAI rejected the API key.");
});

// ---- local-settings.tsx: the button, wired to test_provider, with the consequence line ----

test("local-settings.tsx: a Test provider button posts action 'test_provider' and shows the consequence line", () => {
  const raw = readApp(SETTINGS);
  const code = codeOnly(raw);

  assert.match(
    code,
    /import\s*\{[^}]*\bTEST_PROVIDER_BUTTON_LABEL\b[^}]*\}\s*from\s*"@\/lib\/harness-ux"/s,
  );
  assert.match(
    code,
    /import\s*\{[^}]*\bTEST_PROVIDER_CONSEQUENCE_LINE\b[^}]*\}\s*from\s*"@\/lib\/harness-ux"/s,
  );
  assert.match(code, /action:\s*"test_provider"/);
  assert.match(code, /:\s*TEST_PROVIDER_BUTTON_LABEL\b/);
  assert.match(code, /\{TEST_PROVIDER_CONSEQUENCE_LINE\}/);

  // The button lives in the AI analysis section, after Save AI analysis.
  // Round 8 Task 1 fix 1: computed from `code` (not `raw`) for all three
  // positions -- the Reanalyse dialog moved into this file added a large,
  // heavily-commented block before this section, and mixing a `raw` offset
  // with `code` (comment-stripped) offsets made this comparison meaningless
  // once the two strings' relative lengths stopped lining up.
  const aiSectionStart = code.indexOf(">AI analysis<");
  const saveButtonAt = code.indexOf('"Save AI analysis"');
  // The import line puts TEST_PROVIDER_BUTTON_LABEL near the top of the
  // file; the JSX usage (what actually renders it) is what must come after
  // the Save AI analysis button.
  const testButtonAt = code.indexOf("TEST_PROVIDER_BUTTON_LABEL", saveButtonAt);
  assert.ok(aiSectionStart >= 0 && saveButtonAt > aiSectionStart && testButtonAt > saveButtonAt);
});

test("local-settings.tsx: the Test provider button never calls fetch directly and never bypasses postExecutor", () => {
  const code = codeOnly(readApp(SETTINGS));
  const idx = code.indexOf("const testProvider = useMutation(");
  assert.ok(idx >= 0, "a testProvider mutation must exist");
  const nextTopLevel = code.indexOf("\n  const ", idx + 1);
  const scope = code.slice(idx, nextTopLevel > idx ? nextTopLevel : idx + 800);
  assert.match(scope, /postExecutor\(\{\s*action:\s*"test_provider"\s*\}\)/);
  assert.ok(!/\bfetch\(/.test(scope), "must go through postExecutor, not fetch directly");
});

// ---- executor.ts: the action itself ----

test("executor.ts: POST action 'test_provider' calls adapter.testProvider() and returns its result", () => {
  const code = codeOnly(readApp(EXECUTOR_ROUTE));
  const idx = code.indexOf('if (action === "test_provider")');
  assert.ok(idx >= 0, "the test_provider action must exist");
  const scope = code.slice(idx, idx + 300);
  assert.match(scope, /adapter\.testProvider\(\)/);
  assert.match(scope, /result/);
});

// ---- lockstep: harness/src/llm/index.ts keeps the same three sentences ----

test("harness/src/llm/index.ts: its own (necessarily duplicated) compatibility sentences match harness-ux.ts's", () => {
  const indexSrc = readHarness(LLM_INDEX);

  // Fixed phrases both files must share verbatim, independent of the
  // interpolated model name.
  assert.ok(indexSrc.includes("was not found at OpenAI."));
  assert.ok(indexSrc.includes("OpenAI rejected the API key."));
  assert.ok(indexSrc.includes("OpenAI rejected a request parameter for model"));
  assert.ok(indexSrc.includes("Harness Ledger retried with"));

  // The harness-ux.ts functions produce exactly those same fixed phrases.
  assert.match(ux.openAiModelNotFoundLine("m"), /was not found at OpenAI\.$/);
  assert.equal(ux.OPENAI_KEY_REJECTED_LINE, "OpenAI rejected the API key.");
  assert.match(
    ux.openAiParamRejectedLine("m", "max_tokens", "x"),
    /^OpenAI rejected a request parameter for model/,
  );
});
