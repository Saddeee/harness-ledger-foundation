// Checkpoint 2026-09-18 WP I3: exception-aware Rule writer guidance.
// Scenario tests for the three new Rule writer fields -- applicability,
// exceptions, scope_confidence -- and the proposal-time scope-downgrade
// safeguard (a "workspace" scope answer with scope_confidence < 0.5 is
// narrowed to "project" before anything is written). Storage decision (see
// harness/src/analysis/propose.ts's comment above the createRule call):
// exceptions is folded into rules.applies_when as a second sentence,
// scope_confidence (plus any downgrade note) into rules.overlap_notes --
// there is no dedicated column for either this checkpoint.
//
// Fixture helpers below are a trimmed copy of test/analysis-propose.test
// .ts's own (insertMessage/seedEpisode/fakeRuleWriterCallLlm): each test
// file in this suite seeds its own tmp DB, so sharing helpers across files
// isn't possible without a new shared module this task's brief doesn't ask
// for.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "harness-rule-writer-scope-test-"));
process.env.HARNESS_DB_PATH = join(tmp, "harness.db");
process.env.HARNESS_AUTH_PATH = join(tmp, "lovable-auth.json");

const store = await import("../src/store.js");
const segment = await import("../src/analysis/segment.js");
const propose = await import("../src/analysis/propose.js");
const improvements = await import("../src/improvements.js");
import type { CallLlm, LlmRequest, LlmResult } from "../src/llm/types.js";

type Canned = Record<string, unknown>;

function fakeRuleWriterCallLlm(entries: { match: string; json: Canned }[]): CallLlm {
  return async function callLlm<T>(req: LlmRequest): Promise<LlmResult<T>> {
    const entry = entries.find((e) => req.user.includes(e.match));
    if (!entry) {
      throw new Error(`fakeRuleWriterCallLlm: no canned response matching request:\n${req.user}`);
    }
    return {
      json: entry.json as T,
      provider: "anthropic",
      model: "fake-rule-writer",
      tokensIn: 100,
      tokensOut: 50,
      costUsd: 0,
      latencyMs: 1,
    };
  };
}

let nextExternalId = 0;
let clockMinutes = 0;
function nextTimestamp(): string {
  const n = clockMinutes++;
  const hour = 10 + Math.floor(n / 60);
  const minute = n % 60;
  return `2026-09-01T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`;
}

function insertMessage(
  projectId: string,
  role: "user" | "assistant",
  content: string,
): { id: number; external_id: string } {
  return store.upsertHistoryItem({
    project_id: projectId,
    kind: "message",
    role,
    content,
    occurred_at: nextTimestamp(),
    provenance: "lovable_mcp",
    external_id: `ext-${nextExternalId++}`,
  }) as { id: number; external_id: string };
}

function seedEpisode(
  projectId: string,
  opts: { request: string; corrections: string[] },
): { episodeId: number; requestExternalId: string; correctionExternalIds: string[] } {
  const req = insertMessage(projectId, "user", opts.request);
  store.insertMessageClassification({
    history_item_id: req.id,
    classification: "new_task",
    tags: [],
    summary: opts.request.slice(0, 100),
  });

  const correctionExternalIds: string[] = [];
  opts.corrections.forEach((text) => {
    const m = insertMessage(projectId, "user", text);
    store.insertMessageClassification({
      history_item_id: m.id,
      classification: "correction",
      tags: [],
      summary: text.slice(0, 100),
    });
    correctionExternalIds.push(m.external_id);
  });

  segment.segmentEpisodes(projectId);
  const minable = store.listMinableEpisodes(500).filter((e) => e.project_id === projectId);
  const episode = minable[minable.length - 1];
  if (!episode) throw new Error("seedEpisode: no minable episode found after segmenting");
  return { episodeId: episode.id, requestExternalId: req.external_id, correctionExternalIds };
}

function ruleFor(
  projectId: string,
  instruction: string,
): {
  id: number;
  instruction: string;
  scope: "project" | "workspace";
  applies_when: string;
  overlap_notes: string | null;
} {
  const items = improvements
    .listImprovements()
    .filter((i) => i.project.id === projectId && i.proposed_instruction === instruction);
  assert.equal(items.length, 1, `expected exactly one improvement for "${instruction}"`);
  const rule = items[0].developer.rule as {
    id: number;
    instruction: string;
    scope: "project" | "workspace";
    applies_when: string;
    overlap_notes: string | null;
  };
  assert.ok(rule, "expected the improvement to carry its rule");
  return rule;
}

// ------------------------------------------------------------------ (a)

test("(a) a currency-preference correction with an explicit exception is stored verbatim, with the exception preserved in applies_when", async () => {
  const PROJECT = "wpi3-currency-exception";
  store.allowProject(PROJECT, "Currency Co");

  const seeded = seedEpisode(PROJECT, {
    request: "Build a checkout summary showing the order total.",
    corrections: ["No, not dollars -- use kronor for the total."],
  });

  const instruction =
    'Show money amounts in kronor (e.g. "125 kr") unless the user explicitly requests otherwise.';
  const exceptionsText = "unless the user explicitly requests a different currency or format";
  const ruleWriterJson = {
    propose: true,
    instruction,
    scope: "project",
    applicability: "When displaying a monetary amount on the checkout summary.",
    exceptions: exceptionsText,
    prediction: "The checkout summary shows dollars instead of kronor.",
    failure_signature: "checkout-summary-shows-dollars",
    evidence_message_ids: seeded.correctionExternalIds,
    confidence: 0.85,
    scope_confidence: 0.8,
    contradicts_rule_id: null,
    duplicate_of_rule_id: null,
    destination: "knowledge",
    destination_reason: "A short, stable display preference.",
    destination_alternative: "Could be a Skill, but there is no multi-step procedure here.",
    skill_draft: null,
  };

  const callLlm = fakeRuleWriterCallLlm([
    { match: seeded.requestExternalId, json: ruleWriterJson },
  ]);
  const result = await propose.proposeRules(callLlm, { limit: 10 });
  assert.equal(result.proposed, 1);

  const rule = ruleFor(PROJECT, instruction);
  assert.equal(rule.instruction, instruction, "the instruction is stored verbatim");
  assert.equal(rule.scope, "project", "high scope_confidence: no downgrade");
  assert.ok(
    rule.applies_when.includes(exceptionsText),
    `applies_when must preserve the exception verbatim; got: ${rule.applies_when}`,
  );
  assert.ok(rule.overlap_notes?.includes("scope_confidence=0.8"));
});

// ------------------------------------------------------------------ (b)

test("(b) a one-feature correction over-generalized to workspace-wide 'never' is downgraded to project scope, with scope_confidence and a downgrade note recorded", async () => {
  const PROJECT = "wpi3-overbroad-currency";
  store.allowProject(PROJECT, "Overbroad Co");

  const seeded = seedEpisode(PROJECT, {
    request: "Build the order summary card.",
    corrections: ["The summary card should show kronor, not dollars."],
  });

  const instruction =
    "Never use dollars anywhere in any project: show every money amount in kronor.";
  const ruleWriterJson = {
    propose: true,
    instruction,
    scope: "workspace",
    applicability: "When displaying any monetary amount in any app.",
    exceptions: "",
    prediction: "Money amounts show as dollars instead of kronor.",
    failure_signature: "money-shown-as-dollars",
    evidence_message_ids: seeded.correctionExternalIds,
    confidence: 0.8,
    scope_confidence: 0.3,
    contradicts_rule_id: null,
    duplicate_of_rule_id: null,
    destination: "knowledge",
    destination_reason: "A short, stable display preference.",
    destination_alternative: "Could be a Skill, but there is no multi-step procedure here.",
    skill_draft: null,
  };

  const callLlm = fakeRuleWriterCallLlm([
    { match: seeded.requestExternalId, json: ruleWriterJson },
  ]);
  const result = await propose.proposeRules(callLlm, { limit: 10 });
  assert.equal(result.proposed, 1);

  const rule = ruleFor(PROJECT, instruction);
  // Safeguard: workspace requested with scope_confidence < 0.5 is downgraded
  // to project at proposal time -- this is not a rewrite of any existing
  // rule, just what THIS new proposal is stored as.
  assert.equal(rule.scope, "project", "low scope_confidence downgrades workspace -> project");
  assert.ok(rule.overlap_notes?.includes("scope_confidence=0.3"));
  assert.ok(
    rule.overlap_notes?.includes("scope downgraded: workspace requested with confidence 0.3"),
    `overlap_notes must record the downgrade; got: ${rule.overlap_notes}`,
  );

  // The system prompt itself carries the minimal-sufficiency principle that
  // should have discouraged this over-generalization in the first place.
  assert.match(
    propose.ruleWriterSystemPrompt(),
    /Write the minimally sufficient standing instruction/,
  );
});

// ------------------------------------------------------------------ (c)

test("(c) a security invariant correction keeps strict 'never' wording and its requested scope, unmodified", async () => {
  const PROJECT = "wpi3-security-invariant";
  store.allowProject(PROJECT, "Security Co");

  const seeded = seedEpisode(PROJECT, {
    request: "Add a client-side widget that calls our internal API.",
    corrections: ["Never expose the service key in client code -- that's a security hole."],
  });

  const instruction = "Never expose the service key in client-side code.";
  const ruleWriterJson = {
    propose: true,
    instruction,
    scope: "workspace",
    applicability: "When any client-side code needs to call an authenticated API.",
    exceptions: "",
    prediction: "The service key ships inside client-side code, exposed to anyone.",
    failure_signature: "service-key-exposed-client-side",
    evidence_message_ids: seeded.correctionExternalIds,
    confidence: 0.95,
    scope_confidence: 0.95,
    contradicts_rule_id: null,
    duplicate_of_rule_id: null,
    destination: "knowledge",
    destination_reason: "A short, stable security invariant.",
    destination_alternative: "Could be a Skill, but this is a one-line invariant, not a procedure.",
    skill_draft: null,
  };

  const callLlm = fakeRuleWriterCallLlm([
    { match: seeded.requestExternalId, json: ruleWriterJson },
  ]);
  const result = await propose.proposeRules(callLlm, { limit: 10 });
  assert.equal(result.proposed, 1);

  const rule = ruleFor(PROJECT, instruction);
  assert.equal(rule.instruction, instruction, "strict 'never' wording is stored verbatim");
  assert.equal(rule.scope, "workspace", "high scope_confidence: no downgrade for a real invariant");
  assert.ok(rule.overlap_notes?.includes("scope_confidence=0.95"));
  assert.ok(
    !rule.overlap_notes?.includes("scope downgraded"),
    "a high-confidence invariant must not be downgraded",
  );
});
