// Round 6c part A: the four things the owner reported on 2026-09-13.
//   1. Suggestions holding "In Lovable"/"Reverted" items -- own pins live in
//      the existing ux*.test.ts files (rewritten with intent alongside the
//      page change); this file covers the rest.
//   2. "What is Workspace?" on the Instructions page.
//   3. AI model save failing for Claude Code with an empty model.
//   4. "Analyse now" greyed out with no visible reason, and
//      countHistoryItemsAwaitingAnalysis undercounting.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolated temp DB for this file only -- never harness/data/harness.db.
process.env.HARNESS_DB_PATH = join(mkdtempSync(join(tmpdir(), "harness-test-")), "harness.db");
const store = await import("../src/store.ts");
const ux = await import("../../src/lib/harness-ux.ts");

function readApp(rel: string): string {
  return readFileSync(new URL(`../../src/${rel}`, import.meta.url), "utf8");
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

const INSTRUCTIONS = "routes/_authenticated/instructions.tsx";
const SETTINGS = "components/harness/local-settings.tsx";
const ANALYSE_NOTICE = "components/harness/analyse-notice.tsx";

// ---- item 2: "What is Workspace?" ----

// Round 9 Task 5 / spec §2: the retitled heading and its explanation moved
// into harness-ux.ts constants (WORKSPACE_TARGET_LABEL/
// WORKSPACE_TARGET_EXPLANATION, Round 9 Task 2 and Task 5) and the
// explanation itself now says "instructions", never "rules" -- this test
// pins the constants/usage instead of the old literal strings, which are
// gone.
test("instructions.tsx: the workspace target is retitled with a muted explanation, shown only when it has content", () => {
  const raw = readApp(INSTRUCTIONS);
  const code = codeOnly(raw);

  assert.match(code, /const isWorkspace = target\.target === "workspace";/);
  assert.match(code, /WORKSPACE_TARGET_LABEL/, "the retitled heading uses the shared label");
  assert.equal(ux.WORKSPACE_TARGET_LABEL, "All my projects");
  assert.match(code, /WORKSPACE_TARGET_EXPLANATION/, "the muted explanation line");
  assert.match(ux.WORKSPACE_TARGET_EXPLANATION, /instructions/i);
  assert.match(
    code,
    /NO_WORKSPACE_INSTRUCTIONS_LINE/,
    "the bottom fallback note is the shared constant",
  );
  assert.match(
    ux.NO_WORKSPACE_INSTRUCTIONS_LINE,
    /No workspace-wide instructions yet\. Choose "Add to all my projects" on a suggestion to create one\./,
  );
  assert.match(
    code,
    /const workspaceHasContent =\s+workspaceTarget != null &&/,
    "content check gates whether the section (vs. the fallback note) renders",
  );
  // "Workspace" alone (the old, unexplained heading) is gone as a literal
  // JSX string -- it only ever appears now inside the retitled string.
  assert.ok(
    !code.includes('"Workspace"'),
    "no bare literal 'Workspace' string anywhere in the page",
  );
});

// ---- item 3: AI model save fails for Claude Code ----

test("store.setSettings: llm_models accepts provider claude_code with an empty model, and stores the default 'sonnet'", () => {
  const REQUIRED = ["classifier", "rule_writer", "reviewer", "proposer"] as const;
  const payload = Object.fromEntries(
    REQUIRED.map((role) => [role, { provider: "claude_code", model: "" }]),
  );
  // Must not throw -- this was the reproduced bug: assertLlmModels rejected
  // an empty model outright, failing the whole settings save.
  const saved = store.setSettings({ llm_models: JSON.stringify(payload) });
  const stored = JSON.parse(saved.llm_models) as Record<
    string,
    { provider: string; model: string }
  >;
  for (const role of REQUIRED) {
    assert.equal(stored[role]!.provider, "claude_code");
    assert.equal(stored[role]!.model, "sonnet", `${role}.model should default to "sonnet"`);
  }
  const resolved = store.getLlmModels();
  assert.equal(resolved.classifier.model, "sonnet");
  assert.equal(resolved.rule_writer.model, "sonnet");
});

test("store.setSettings: llm_models leaves a non-empty claude_code model (e.g. 'opus') untouched, and never touches an API provider's model", () => {
  const payload = {
    classifier: { provider: "claude_code", model: "opus" },
    rule_writer: { provider: "openai", model: "" },
    reviewer: { provider: "claude_code", model: "" },
    proposer: { provider: "openai", model: "gpt-5.5" },
  };
  // rule_writer (an API provider) with an empty model must still be
  // rejected -- normalizeLlmModels only ever substitutes for claude_code.
  assert.throws(() => store.setSettings({ llm_models: JSON.stringify(payload) }));

  payload.rule_writer.model = "gpt-5.5";
  const saved = store.setSettings({ llm_models: JSON.stringify(payload) });
  const stored = JSON.parse(saved.llm_models) as Record<
    string,
    { provider: string; model: string }
  >;
  assert.equal(stored.classifier!.model, "opus", "an explicit alias is left alone");
  assert.equal(stored.reviewer!.model, "sonnet", "the empty claude_code model still defaults");
  assert.equal(stored.proposer!.model, "gpt-5.5");
});

test("local-settings.tsx: switching a role's provider to Claude Code prefills the model, switching away clears a Claude Code alias, and the hint is shown", () => {
  const code = codeOnly(readApp(SETTINGS));
  assert.match(code, /const CLAUDE_CODE_ALIASES = \["sonnet", "opus", "haiku"\];/);
  assert.match(code, /const CLAUDE_CODE_DEFAULT_MODEL = "sonnet";/);
  // Round 8 Task 6 (review item 10): was "Claude Code model alias: sonnet,
  // opus or haiku" -- shortened to "Model: ..." (see
  // harness/test/ux-round8-task6.test.ts).
  assert.ok(code.includes("Model: sonnet, opus or haiku"));
  assert.match(
    code,
    /function nextModelOnProviderChange\(currentModel: string, nextProvider: LlmProvider\): string \{/,
  );
  assert.match(code, /if \(nextProvider === "claude_code"\) return CLAUDE_CODE_DEFAULT_MODEL;/);
  assert.match(code, /CLAUDE_CODE_ALIASES\.includes\(currentModel\) \? "" : currentModel;/);
  // Wired into the "Key for" select (which moves the analysis provider with
  // it), the primary (rule_writer) provider select and every per-role
  // Advanced provider select -- not just computed and unused.
  assert.equal(
    (code.match(/model: nextModelOnProviderChange\(/g) ?? []).length,
    3,
    "key-for + primary + per-role provider selects all call it",
  );
  // The hint renders next to both the primary and the per-role model input.
  assert.equal((code.match(/\{CLAUDE_CODE_MODEL_HINT\}/g) ?? []).length, 2);
});

test("local-settings.tsx: the AI-analysis mutation's onError shows e.message in a toast", () => {
  const code = codeOnly(readApp(SETTINGS));
  const idx = code.indexOf("const saveAiAnalysis = useMutation");
  const nextMutation = code.indexOf("useMutation", code.indexOf("onError", idx) + 1);
  const scope = code.slice(idx, nextMutation > idx ? nextMutation : idx + 2000);
  assert.match(scope, /onError: \(e\) => \{/);
  assert.match(scope, /toast\.error\(e instanceof Error \? e\.message : /);
});

// ---- item 4: "Analyse now" is grey with no visible reason; undercount ----

test("analyse-notice.tsx: the not-ready reason links to Settings, and the button stays enabled at awaiting_analysis === 0 when the provider is ready", () => {
  const raw = readApp(ANALYSE_NOTICE);
  const code = codeOnly(raw);
  assert.match(code, /import \{ Link \} from "@tanstack\/react-router";/);
  assert.match(code, /<Link to="\/settings"[^>]*>/);
  assert.ok(raw.includes("Open Settings"));
  // The Link sits inside the same not-ready reason paragraph, not gated by
  // anything else -- it is always offered whenever the reason is shown.
  const readyBranchStart = code.indexOf("!providerReady.ok ? (");
  const readyBranchEnd = code.indexOf(") : null}", readyBranchStart);
  assert.ok(readyBranchStart >= 0 && readyBranchEnd > readyBranchStart);
  const readyBranch = code.slice(readyBranchStart, readyBranchEnd);
  assert.match(readyBranch, /<Link to="\/settings"/);

  // disabled must depend only on `running` and `!providerReady.ok` -- never
  // on `awaiting` -- so the button stays enabled at awaiting_analysis === 0
  // whenever the provider is ready (the analysis also re-judges adherence
  // and proposes from unclassified messages, so there is always something
  // useful for it to do).
  // Round 7: a requested-but-not-started run also disables it (progress shows).
  assert.match(code, /const inProgress = running \|\| analysis\.queued === true;/);
  assert.match(code, /const disabled = inProgress \|\| !providerReady\.ok;/);
});

test("countHistoryItemsAwaitingAnalysis: counts a user message with no message_classifications row even once it's already task_episode_evidence -- reproduces the owner's 'four real synced messages read as 0' report", () => {
  const hi = store.upsertHistoryItem({
    kind: "message",
    external_id: "round6c-awaiting-1",
    role: "user",
    content: "please fix the button color",
    occurred_at: "2026-09-13T09:00:00Z",
    provenance: "manual",
  }) as { id: number };

  const before = store.countHistoryItemsAwaitingAnalysis();
  assert.ok(before >= 1, "an unclassified message must count as awaiting analysis");

  // Segment it into a task episode -- the OLD (buggy) predicate checked
  // task_episode_evidence, so this alone used to make the message stop
  // counting even though it had never been classified.
  store.createTaskEpisode({
    title: "fix button color",
    provenance: "manual",
    evidence_history_item_ids: [hi.id],
  });
  const afterEpisode = store.countHistoryItemsAwaitingAnalysis();
  assert.equal(
    afterEpisode,
    before,
    "gaining a task_episode_evidence row must not change the awaiting-analysis count -- only classification does",
  );

  // Now actually classify it -- this is the real "no longer awaiting
  // analysis" signal.
  store.insertMessageClassification({
    history_item_id: hi.id,
    classification: "other",
    tags: [],
    summary: "s",
  });
  const afterClassify = store.countHistoryItemsAwaitingAnalysis();
  assert.equal(
    afterClassify,
    before - 1,
    "classifying the message must drop the count by exactly one",
  );
});

test("analyse-notice.tsx: shows step-by-step progress while analysis is queued or running, polling every 2 s", () => {
  const code = codeOnly(readApp("components/harness/analyse-notice.tsx"));
  for (const label of [
    "Reading your new messages",
    "Grouping them into tasks",
    "Writing suggestions from your corrections",
    // Round 9 Task 7 / spec §2 vocabulary: "rule" -> "instruction".
    "Checking your instructions against recent builds",
    "Updating instruction health",
  ]) {
    assert.ok(code.includes(label), `missing step: ${label}`);
  }
  assert.match(code, /<Progress/);
  assert.match(code, /a && \(a\.running \|\| a\.queued\) \? 2_000 : false/);
  assert.match(code, /role="status"/);
});
