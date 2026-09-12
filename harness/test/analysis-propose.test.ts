import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "harness-analysis-mine-test-"));
process.env.HARNESS_DB_PATH = join(tmp, "harness.db");
// Keep the auth file out of the real data directory: nothing here connects.
process.env.HARNESS_AUTH_PATH = join(tmp, "lovable-auth.json");

const store = await import("../src/store.js");
const segment = await import("../src/analysis/segment.js");
const propose = await import("../src/analysis/propose.js");
const improvements = await import("../src/improvements.js");
import type { CallLlm, LlmRequest, LlmResult } from "../src/llm/types.js";
import { LlmBudgetExceeded } from "../src/llm/types.js";

// ------------------------------------------------------------------ fakes

type Canned = Record<string, unknown>;

/**
 * A fake CallLlm that never makes a network call: each entry matches when
 * `req.user` includes the given substring (in practice, the episode's
 * request external_id, which appears once per episode's prompt and is
 * unique across the whole file), so one array can key several episodes'
 * canned responses by which episode they belong to.
 */
function fakeRuleWriterCallLlm(
  entries: { match: string; json?: Canned; throw?: Error }[],
): CallLlm {
  return async function callLlm<T>(req: LlmRequest): Promise<LlmResult<T>> {
    const entry = entries.find((e) => req.user.includes(e.match));
    if (!entry) {
      throw new Error(`fakeRuleWriterCallLlm: no canned response matching request:\n${req.user}`);
    }
    if (entry.throw) throw entry.throw;
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

/**
 * Round 5 Task 6: a fake CallLlm that always answers `json` (propose:false
 * by default -- these tests care about the prompt sent, not a proposal
 * written back), and records every request's user prompt verbatim so a test
 * can inspect exactly what the Rule writer was shown.
 */
function fakeCapturingCallLlm(json: Canned): { callLlm: CallLlm; prompts: string[] } {
  const prompts: string[] = [];
  const callLlm: CallLlm = async function callLlm<T>(req: LlmRequest): Promise<LlmResult<T>> {
    prompts.push(req.user);
    return {
      json: json as T,
      provider: "anthropic",
      model: "fake-rule-writer",
      tokensIn: 100,
      tokensOut: 50,
      costUsd: 0,
      latencyMs: 1,
    };
  };
  return { callLlm, prompts };
}

// Round 5 Task 6: proposeRules' result gained createdCandidateIds (the
// candidate ids this call created, for autoAcceptProposals to consume) --
// the exact ids created are an auto-increment detail of a shared test-file
// DB, not something worth pinning per test, so every existing count
// assertion below compares just the four original fields via this helper,
// plus a separate assert.equal(...createdCandidateIds.length, proposed)
// checking the new field's own invariant instead.
function counts(r: {
  proposed: number;
  skippedDuplicate: number;
  skippedNoProposal: number;
  failed: number;
}): { proposed: number; skippedDuplicate: number; skippedNoProposal: number; failed: number } {
  return {
    proposed: r.proposed,
    skippedDuplicate: r.skippedDuplicate,
    skippedNoProposal: r.skippedNoProposal,
    failed: r.failed,
  };
}

// ------------------------------------------------------------------ fixture helpers

let nextExternalId = 0;
// A single monotonically increasing clock shared by every insertMessage call
// in this file (not reset per test/project) so two episodes -- even in the
// same project, as Task F's budget-stop test needs -- never get overlapping
// started_at/ended_at windows; listMinableEpisodes' assistant-summary lookup
// is a time-window read scoped only by project_id, so overlapping episodes
// in the same project would otherwise leak each other's assistant replies.
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

/**
 * Builds one classified-and-segmented episode via A1's own store helper
 * (insertMessageClassification) and segment.ts (segmentEpisodes) -- the real
 * production path, minus the LLM call classify.ts would otherwise make --
 * so listMinableEpisodes sees exactly what it would after a real classify+
 * segment pass: one new_task request, N correction messages attached as
 * evidence, and an ended_at pushed to the last correction's time.
 */
function seedEpisode(
  projectId: string,
  opts: {
    request: string;
    corrections: string[];
    assistantAfterRequest?: string;
    assistantAfterCorrection?: string[];
  },
): {
  episodeId: number;
  requestExternalId: string;
  correctionExternalIds: string[];
  correctionTexts: string[];
} {
  const req = insertMessage(projectId, "user", opts.request);
  store.insertMessageClassification({
    history_item_id: req.id,
    classification: "new_task",
    tags: [],
    summary: opts.request.slice(0, 100),
  });
  if (opts.assistantAfterRequest) insertMessage(projectId, "assistant", opts.assistantAfterRequest);

  const correctionExternalIds: string[] = [];
  opts.corrections.forEach((text, i) => {
    const m = insertMessage(projectId, "user", text);
    store.insertMessageClassification({
      history_item_id: m.id,
      classification: "correction",
      tags: ["forms"],
      summary: text.slice(0, 100),
    });
    correctionExternalIds.push(m.external_id);
    const reply = opts.assistantAfterCorrection?.[i];
    if (reply) insertMessage(projectId, "assistant", reply);
  });

  segment.segmentEpisodes(projectId);
  const minable = store.listMinableEpisodes(500).filter((e) => e.project_id === projectId);
  const episode = minable[minable.length - 1];
  if (!episode) throw new Error("seedEpisode: no minable episode found after segmenting");
  return {
    episodeId: episode.id,
    requestExternalId: req.external_id,
    correctionExternalIds,
    correctionTexts: opts.corrections,
  };
}

/**
 * store.listMinableEpisodes has no project filter (by design, matching the
 * plan's signature), so proposeRules sweeps every allowed project's backlog
 * in one call -- exactly like A1's classifyPending. A test that
 * deliberately leaves an episode un-mined (skipped-duplicate, propose:false,
 * a rejected proposal, or one never reached before a budget stop) must
 * drain it explicitly, or a later test's proposeRules call will pick it up
 * too and skew that test's counts (see harness/.superpowers/sdd/2026-09-11-
 * round-4/task-A1-report.md's concern #2, same issue, same fix).
 */
function drainEpisode(episodeId: number): void {
  store.createCorrectionCandidate({
    task_episode_id: episodeId,
    classification: "other",
    is_correction: false,
    summary: "drained by test cleanup",
    evidence_history_item_ids: [],
  });
}

/** A live rule that exists independently of the rule writer (for dedupe/
 * contradiction fixtures) -- goes through the same createCorrectionCandidate
 * -> createLearning -> createRule chain a human or the rule writer would use, so
 * it is a real, fully-formed live rule, not a shortcut insert. */
function createManualRule(projectId: string, instruction: string): { id: number } {
  const episode = store.createTaskEpisode({
    project_id: projectId,
    title: "seed rule episode",
    provenance: "manual",
  }) as { id: number };
  const msg = insertMessage(projectId, "user", "seed correction for a manually-authored rule");
  store.addEpisodeEvidence(episode.id, msg.id, "correction");
  const candidate = store.createCorrectionCandidate({
    task_episode_id: episode.id,
    classification: "constraint_restatement",
    is_correction: true,
    reusable: true,
    proposed_scope: "project",
    summary: "seed rule",
    evidence_history_item_ids: [msg.id],
  }) as { id: number };
  const learning = store.createLearning({
    correction_candidate_id: candidate.id,
    observed_problem: "seed",
    desired_behavior: instruction,
    reuse_rationale: "seed",
    proposed_scope: "project",
    provenance: "manual",
    created_by: "test seed",
  }) as { id: number };
  return store.createRule({
    learning_id: learning.id,
    correction_candidate_id: candidate.id,
    instruction,
    scope: "project",
    applies_when: "seed",
    predicted_failure: "seed",
    ownership: "user",
    created_by: "test seed",
  }) as { id: number };
}

// ------------------------------------------------------------------ tests

test("proposeRules proposes a rule from a corrected episode; it renders as a pending Improvement with its evidence and instruction; the same episode is not mined twice", async () => {
  const PROJECT = "proj-mine-basic";
  store.allowProject(PROJECT, "Basic Co");
  store.upsertProject({ lovable_project_id: PROJECT, name: "Basic Co" });

  const seeded = seedEpisode(PROJECT, {
    request: "Build a signup form with email and password.",
    assistantAfterRequest: "Added the signup form.",
    corrections: [
      "The signup form doesn't require a confirm-password field, please fix.",
      "Also always show a password-strength hint under the field.",
    ],
    assistantAfterCorrection: ["Added confirm-password.", "Added the strength hint."],
  });

  const ruleWriterJson = {
    propose: true,
    instruction: "Always require a confirm-password field with a strength hint on signup forms.",
    scope: "project",
    prediction: "Signup forms ship without confirm-password or a strength hint.",
    failure_signature: "Missing Confirm Password Field",
    evidence_message_ids: seeded.correctionExternalIds,
    confidence: 0.87,
    contradicts_rule_id: null,
    duplicate_of_rule_id: null,
  };
  const callLlm = fakeRuleWriterCallLlm([
    { match: seeded.requestExternalId, json: ruleWriterJson },
  ]);

  const result = await propose.proposeRules(callLlm, { limit: 10 });
  assert.deepEqual(counts(result), {
    proposed: 1,
    skippedDuplicate: 0,
    skippedNoProposal: 0,
    failed: 0,
  });
  assert.equal(
    result.createdCandidateIds.length,
    1,
    "createdCandidateIds carries one id per proposed rule",
  );

  const items = improvements
    .listImprovements()
    .filter(
      (i) => i.project.id === PROJECT && i.proposed_instruction === ruleWriterJson.instruction,
    );
  assert.equal(items.length, 1);
  const item = items[0];
  assert.equal(item.decision.status, "pending");
  assert.equal(item.proposed_instruction, ruleWriterJson.instruction);
  assert.deepEqual(item.evidence.map((e) => e.text).sort(), [...seeded.correctionTexts].sort());

  // Addendum (C1 review): every mined rule gets a verification_plan carrying
  // the rule writer's kebab-case failure_signature and its prediction, since C1's
  // rule-health computation reads failure_signature from there.
  const rule = item.developer.rule as { id: number };
  const plan = store.getVerificationPlanForRule(rule.id) as {
    plan: { failure_signature: string; failure_condition: string };
  } | null;
  assert.ok(plan, "expected a verification_plan for the mined rule");
  assert.equal(plan!.plan.failure_signature, "missing-confirm-password-field");
  assert.equal(plan!.plan.failure_condition, ruleWriterJson.prediction);

  // Not mined twice: the episode now has a correction_candidates row, so
  // listMinableEpisodes no longer selects it and a second run proposes 0.
  const second = await propose.proposeRules(callLlm, { limit: 10 });
  assert.deepEqual(counts(second), {
    proposed: 0,
    skippedDuplicate: 0,
    skippedNoProposal: 0,
    failed: 0,
  });
  assert.equal(
    second.createdCandidateIds.length,
    0,
    "createdCandidateIds carries one id per proposed rule",
  );
});

test("proposeRules skips a near-duplicate of a live rule (dice >= 0.8) and writes nothing", async () => {
  const PROJECT = "proj-mine-dup";
  store.allowProject(PROJECT, "Dup Co");

  createManualRule(PROJECT, "Always require a confirm-password field on signup forms.");
  const rulesBefore = store.listProjectRules(PROJECT).length;

  const seeded = seedEpisode(PROJECT, {
    request: "Build a signup form.",
    corrections: ["Please also require a confirm-password field on signup forms."],
  });

  const ruleWriterJson = {
    propose: true,
    instruction: "Always require a confirm-password field on signup forms.",
    scope: "project",
    prediction: "Signup forms ship without confirm-password.",
    failure_signature: "missing-confirm-password",
    evidence_message_ids: seeded.correctionExternalIds,
    confidence: 0.8,
    contradicts_rule_id: null,
    duplicate_of_rule_id: null,
  };
  const callLlm = fakeRuleWriterCallLlm([
    { match: seeded.requestExternalId, json: ruleWriterJson },
  ]);

  const result = await propose.proposeRules(callLlm, { limit: 10 });
  assert.deepEqual(counts(result), {
    proposed: 0,
    skippedDuplicate: 1,
    skippedNoProposal: 0,
    failed: 0,
  });
  assert.equal(
    result.createdCandidateIds.length,
    0,
    "createdCandidateIds carries one id per proposed rule",
  );
  assert.equal(store.listProjectRules(PROJECT).length, rulesBefore);
  drainEpisode(seeded.episodeId);
});

test("proposeRules counts propose:false as skippedNoProposal and writes nothing", async () => {
  const PROJECT = "proj-mine-noprop";
  store.allowProject(PROJECT, "NoProp Co");

  const seeded = seedEpisode(PROJECT, {
    request: "Build a settings page.",
    corrections: ["Actually, use a different icon here, no big deal either way."],
  });

  const callLlm = fakeRuleWriterCallLlm([
    { match: seeded.requestExternalId, json: { propose: false } },
  ]);
  const result = await propose.proposeRules(callLlm, { limit: 10 });
  assert.deepEqual(counts(result), {
    proposed: 0,
    skippedDuplicate: 0,
    skippedNoProposal: 1,
    failed: 0,
  });
  assert.equal(
    result.createdCandidateIds.length,
    0,
    "createdCandidateIds carries one id per proposed rule",
  );

  // Nothing was written, so the episode is still minable.
  assert.ok(store.listMinableEpisodes(500).some((e) => e.id === seeded.episodeId));
  drainEpisode(seeded.episodeId);
});

test("proposeRules rejects and logs an evidence id outside the episode's corrections", async () => {
  const PROJECT = "proj-mine-badevidence";
  store.allowProject(PROJECT, "Bad Evidence Co");

  const seeded = seedEpisode(PROJECT, {
    request: "Build a dashboard.",
    corrections: ["The dashboard chart never finishes loading."],
  });

  const ruleWriterJson = {
    propose: true,
    instruction: "Always add a loading state to charts.",
    scope: "project",
    prediction: "Charts spin forever with no data.",
    failure_signature: "chart-never-loads",
    evidence_message_ids: ["not-a-real-external-id"],
    confidence: 0.5,
    contradicts_rule_id: null,
    duplicate_of_rule_id: null,
  };
  const callLlm = fakeRuleWriterCallLlm([
    { match: seeded.requestExternalId, json: ruleWriterJson },
  ]);

  const result = await propose.proposeRules(callLlm, { limit: 10 });
  assert.deepEqual(counts(result), {
    proposed: 0,
    skippedDuplicate: 0,
    skippedNoProposal: 0,
    failed: 1,
  });
  assert.equal(
    result.createdCandidateIds.length,
    0,
    "createdCandidateIds carries one id per proposed rule",
  );

  const events = store.listEvents(200) as { kind: string; payload: string | null }[];
  const rejected = events.find((e) => e.kind === "analysis.mine.rejected");
  assert.ok(rejected, "expected an analysis.mine.rejected event");
  const payload = JSON.parse(rejected!.payload!) as { episode_id: number; reason: string };
  assert.equal(payload.episode_id, seeded.episodeId);
  assert.match(payload.reason, /non-empty subset/);

  // Still minable -- nothing was written for it.
  assert.ok(store.listMinableEpisodes(500).some((e) => e.id === seeded.episodeId));
  drainEpisode(seeded.episodeId);
});

test("proposeRules records a rule-writer-reported contradiction into rule_health for the contradicted live rule", async () => {
  const PROJECT = "proj-mine-contradict";
  store.allowProject(PROJECT, "Contradict Co");

  // Note: proposeRules now scopes listLiveRuleTexts to this episode's own
  // project (plus workspace-scoped rules) -- see the per-target dedupe test
  // below -- but createManualRule always creates a project-scoped rule, so
  // this fixture's wording still must not accidentally overlap (bigram
  // Dice) with any other project-scoped rule fixture in THIS SAME project,
  // or the dedupe check above would (correctly) treat it as a duplicate
  // instead of reaching the contradiction path this test is about.
  const contradicted = createManualRule(
    PROJECT,
    "Always skip the delete-confirmation dialog for quick actions.",
  );

  const seeded = seedEpisode(PROJECT, {
    request: "Add a delete button to the settings list.",
    corrections: [
      "Actually, always show a delete-confirmation dialog before removing anything -- skipping it caused data loss.",
    ],
  });

  const ruleWriterJson = {
    propose: true,
    instruction: "Always show a delete-confirmation dialog before removing any item.",
    scope: "project",
    prediction: "Deleting without confirmation destroys data users didn't mean to remove.",
    failure_signature: "accidental-delete-no-confirmation",
    evidence_message_ids: seeded.correctionExternalIds,
    confidence: 0.9,
    contradicts_rule_id: contradicted.id,
    duplicate_of_rule_id: null,
  };
  const callLlm = fakeRuleWriterCallLlm([
    { match: seeded.requestExternalId, json: ruleWriterJson },
  ]);

  const result = await propose.proposeRules(callLlm, { limit: 10 });
  assert.equal(result.proposed, 1);

  const minedItem = improvements
    .listImprovements()
    .find((i) => i.project.id === PROJECT && i.proposed_instruction === ruleWriterJson.instruction);
  assert.ok(minedItem, "expected the mined rule to appear as an Improvement");
  const newRuleId = (minedItem!.developer.rule as { id: number }).id;

  const health = store.getRuleHealth(contradicted.id);
  assert.ok(health, "expected a rule_health row for the contradicted rule");
  assert.equal(health!.contradicted_by_rule_id, newRuleId);
  assert.equal(health!.status, "retire_suggested");
});

test("proposeRules stops the loop on LlmBudgetExceeded, leaving the un-reached episode un-mined", async () => {
  const PROJECT = "proj-mine-budget";
  store.allowProject(PROJECT, "Budget Co");

  const first = seedEpisode(PROJECT, {
    request: "Build page A.",
    corrections: ["Fix A: always validate input before saving."],
  });
  const second = seedEpisode(PROJECT, {
    request: "Build page B.",
    corrections: ["Fix B: always validate output before rendering."],
  });

  const callLlm = fakeRuleWriterCallLlm([
    {
      match: first.requestExternalId,
      json: {
        propose: true,
        instruction: "Always validate input on page A forms before saving.",
        scope: "project",
        prediction: "Bad input crashes page A.",
        failure_signature: "bad-input-page-a",
        evidence_message_ids: first.correctionExternalIds,
        confidence: 0.7,
        contradicts_rule_id: null,
        duplicate_of_rule_id: null,
      },
    },
    { match: second.requestExternalId, throw: new LlmBudgetExceeded(2_000_000, 2_000_000) },
  ]);

  const result = await propose.proposeRules(callLlm, { limit: 10 });
  assert.deepEqual(counts(result), {
    proposed: 1,
    skippedDuplicate: 0,
    skippedNoProposal: 0,
    failed: 0,
  });
  assert.equal(
    result.createdCandidateIds.length,
    1,
    "createdCandidateIds carries one id per proposed rule",
  );

  // The second episode was never reached (not even counted as `failed`) --
  // it remains minable for the next run.
  assert.ok(store.listMinableEpisodes(500).some((e) => e.id === second.episodeId));
  drainEpisode(second.episodeId);
});

// ---- Fix wave item 2: reject a blank instruction/prediction ----

test("proposeRules rejects a propose:true reply with a blank instruction, like an invalid evidence id", async () => {
  const PROJECT = "proj-mine-blank-instruction";
  store.allowProject(PROJECT, "Blank Instruction Co");

  const seeded = seedEpisode(PROJECT, {
    request: "Build a checkout page.",
    corrections: ["The checkout page double-charges sometimes."],
  });

  const ruleWriterJson = {
    propose: true,
    instruction: "   ",
    scope: "project",
    prediction: "Checkout double-charges under load.",
    failure_signature: "checkout-double-charge",
    evidence_message_ids: seeded.correctionExternalIds,
    confidence: 0.6,
    contradicts_rule_id: null,
    duplicate_of_rule_id: null,
  };
  const callLlm = fakeRuleWriterCallLlm([
    { match: seeded.requestExternalId, json: ruleWriterJson },
  ]);

  const result = await propose.proposeRules(callLlm, { limit: 10 });
  assert.deepEqual(counts(result), {
    proposed: 0,
    skippedDuplicate: 0,
    skippedNoProposal: 0,
    failed: 1,
  });
  assert.equal(
    result.createdCandidateIds.length,
    0,
    "createdCandidateIds carries one id per proposed rule",
  );

  const events = store.listEvents(200) as { kind: string; payload: string | null }[];
  const rejected = events.find(
    (e) =>
      e.kind === "analysis.mine.rejected" &&
      JSON.parse(e.payload ?? "{}").episode_id === seeded.episodeId,
  );
  assert.ok(rejected, "expected an analysis.mine.rejected event");
  const payload = JSON.parse(rejected!.payload!) as { reason: string };
  assert.match(payload.reason, /instruction and prediction must both be non-empty/);

  assert.ok(store.listMinableEpisodes(500).some((e) => e.id === seeded.episodeId));
  drainEpisode(seeded.episodeId);
});

test("proposeRules rejects a propose:true reply with a non-string (null) prediction, and nothing is written", async () => {
  const PROJECT = "proj-mine-blank-prediction";
  store.allowProject(PROJECT, "Blank Prediction Co");
  const rulesBefore = store.listProjectRules(PROJECT).length;

  const seeded = seedEpisode(PROJECT, {
    request: "Build a notifications page.",
    corrections: ["Notifications never mark themselves as read."],
  });

  const ruleWriterJson = {
    propose: true,
    instruction: "Always mark a notification read once the user opens it.",
    scope: "project",
    prediction: null,
    failure_signature: "notification-not-marked-read",
    evidence_message_ids: seeded.correctionExternalIds,
    confidence: 0.65,
    contradicts_rule_id: null,
    duplicate_of_rule_id: null,
  };
  const callLlm = fakeRuleWriterCallLlm([
    { match: seeded.requestExternalId, json: ruleWriterJson },
  ]);

  const result = await propose.proposeRules(callLlm, { limit: 10 });
  assert.deepEqual(counts(result), {
    proposed: 0,
    skippedDuplicate: 0,
    skippedNoProposal: 0,
    failed: 1,
  });
  assert.equal(
    result.createdCandidateIds.length,
    0,
    "createdCandidateIds carries one id per proposed rule",
  );
  assert.equal(store.listProjectRules(PROJECT).length, rulesBefore, "nothing was written");

  drainEpisode(seeded.episodeId);
});

// ---- Fix wave item 3: per-target dedupe ----

test("proposeRules dedupes only within the episode's own project (plus workspace-scoped rules) -- an identical-text rule in a different project does not suppress the proposal", async () => {
  const PROJECT_A = "proj-mine-scope-a";
  const PROJECT_B = "proj-mine-scope-b";
  store.allowProject(PROJECT_A, "Scope A");
  store.allowProject(PROJECT_B, "Scope B");

  const SAME_TEXT = "Always show a loading spinner while data is fetching.";
  createManualRule(PROJECT_B, SAME_TEXT); // lives only in project B

  const seeded = seedEpisode(PROJECT_A, {
    request: "Build a data table that fetches from an API.",
    corrections: ["Please show a loading spinner while data is fetching."],
  });

  const ruleWriterJson = {
    propose: true,
    instruction: SAME_TEXT,
    scope: "project",
    prediction: "The table looks broken while data loads with no spinner.",
    failure_signature: "no-loading-spinner",
    evidence_message_ids: seeded.correctionExternalIds,
    confidence: 0.75,
    contradicts_rule_id: null,
    duplicate_of_rule_id: null,
  };
  const callLlm = fakeRuleWriterCallLlm([
    { match: seeded.requestExternalId, json: ruleWriterJson },
  ]);

  const result = await propose.proposeRules(callLlm, { limit: 10 });
  assert.deepEqual(counts(result), {
    proposed: 1,
    skippedDuplicate: 0,
    skippedNoProposal: 0,
    failed: 0,
  });
  assert.equal(
    result.createdCandidateIds.length,
    1,
    "createdCandidateIds carries one id per proposed rule",
  );

  const items = improvements
    .listImprovements()
    .filter((i) => i.project.id === PROJECT_A && i.proposed_instruction === SAME_TEXT);
  assert.equal(
    items.length,
    1,
    "identical wording live only in a different project must not suppress this proposal",
  );
});

test("proposeRules still dedupes against a workspace-scoped live rule regardless of which project the episode is in", async () => {
  const PROJECT_C = "proj-mine-scope-c";
  store.allowProject(PROJECT_C, "Scope C");

  const WORKSPACE_TEXT = "Always confirm destructive actions before executing them.";
  const episodeForWorkspaceRule = store.createTaskEpisode({
    project_id: PROJECT_C,
    title: "seed workspace rule episode",
    provenance: "manual",
  }) as { id: number };
  const seedMsg = insertMessage(PROJECT_C, "user", "seed correction for a workspace rule");
  store.addEpisodeEvidence(episodeForWorkspaceRule.id, seedMsg.id, "correction");
  const seedCandidate = store.createCorrectionCandidate({
    task_episode_id: episodeForWorkspaceRule.id,
    classification: "constraint_restatement",
    is_correction: true,
    reusable: true,
    proposed_scope: "workspace",
    summary: "seed workspace rule",
    evidence_history_item_ids: [seedMsg.id],
  }) as { id: number };
  const seedLearning = store.createLearning({
    correction_candidate_id: seedCandidate.id,
    observed_problem: "seed",
    desired_behavior: WORKSPACE_TEXT,
    reuse_rationale: "seed",
    proposed_scope: "workspace",
    provenance: "manual",
    created_by: "test seed",
  }) as { id: number };
  store.createRule({
    learning_id: seedLearning.id,
    correction_candidate_id: seedCandidate.id,
    instruction: WORKSPACE_TEXT,
    scope: "workspace",
    applies_when: "seed",
    predicted_failure: "seed",
    ownership: "user",
    created_by: "test seed",
  });

  const seeded = seedEpisode(PROJECT_C, {
    request: "Add a bulk-delete button to the admin table.",
    corrections: ["Please confirm before deleting everything."],
  });

  const ruleWriterJson = {
    propose: true,
    instruction: WORKSPACE_TEXT,
    scope: "workspace",
    prediction: "Bulk delete removes everything with no confirmation.",
    failure_signature: "no-delete-confirmation",
    evidence_message_ids: seeded.correctionExternalIds,
    confidence: 0.8,
    contradicts_rule_id: null,
    duplicate_of_rule_id: null,
  };
  const callLlm = fakeRuleWriterCallLlm([
    { match: seeded.requestExternalId, json: ruleWriterJson },
  ]);

  const result = await propose.proposeRules(callLlm, { limit: 10 });
  assert.deepEqual(counts(result), {
    proposed: 0,
    skippedDuplicate: 1,
    skippedNoProposal: 0,
    failed: 0,
  });
  assert.equal(
    result.createdCandidateIds.length,
    0,
    "createdCandidateIds carries one id per proposed rule",
  );
  drainEpisode(seeded.episodeId);
});

// ---- Round 5 Task 6 / spec §4b: the feedback loop ----

test("proposeRules' user prompt carries the user's own feedback -- accepted rules, skipped suggestions with reasons, and wording edits -- each framed as data, never instructions", async () => {
  const PROJECT = "proj-mine-feedback-prompt";
  store.allowProject(PROJECT, "Feedback Prompt Co");

  // An accepted rule (state 'approved'), later reworded -- feeds both the
  // "accepted" block (current wording) and the "wording edits" block (the
  // before -> after pair).
  const acceptedRule = createManualRule(PROJECT, "Always show a confirmation toast after saving.");
  store.updateRule({ id: acceptedRule.id, state: "approved", actor: "test seed" });
  store.updateRule({
    id: acceptedRule.id,
    instruction: "Always show a confirmation toast after every save.",
    actor: "test seed",
    reason: "tighter wording",
  });

  // A skipped suggestion, with a reason.
  const skipEpisode = store.createTaskEpisode({
    project_id: PROJECT,
    title: "skip seed",
    provenance: "manual",
  }) as { id: number };
  const skipMsg = insertMessage(PROJECT, "user", "seed correction for a skipped suggestion");
  store.addEpisodeEvidence(skipEpisode.id, skipMsg.id, "correction");
  const skipCandidate = store.createCorrectionCandidate({
    task_episode_id: skipEpisode.id,
    classification: "constraint_restatement",
    is_correction: true,
    reusable: true,
    proposed_scope: "project",
    summary: "Always ask before deleting a draft.",
    evidence_history_item_ids: [skipMsg.id],
  }) as { id: number };
  store.reviewCorrectionCandidate({
    id: skipCandidate.id,
    action: "exclude",
    reviewer: "test seed",
  });
  store.setCandidateSkipReason(skipCandidate.id, "not_useful");

  const seeded = seedEpisode(PROJECT, {
    request: "Build a drafts list.",
    corrections: ["Please add a delete button to each draft."],
  });

  const { callLlm, prompts } = fakeCapturingCallLlm({ propose: false });
  await propose.proposeRules(callLlm, { limit: 10 });

  assert.equal(prompts.length, 1);
  const prompt = prompts[0]!;

  assert.match(prompt, /Rules this user accepted \(examples of what they want\)/);
  assert.match(prompt, /Always show a confirmation toast after every save\./);

  assert.match(prompt, /Suggestions this user skipped -- do not propose these again/);
  assert.match(prompt, /Always ask before deleting a draft\./);
  assert.match(prompt, /not_useful/);

  assert.match(prompt, /How this user rewrote wording before -> after/);
  assert.match(prompt, /Always show a confirmation toast after saving\./);
  assert.match(
    prompt,
    /"Always show a confirmation toast after saving\." -> "Always show a confirmation toast after every save\."/,
  );

  // Every one of the three blocks is guarded as data, never as instructions
  // -- the same framing the classifier prompt uses for untrusted message
  // content (see classify.ts's own guard sentence).
  const guardCount = (prompt.match(/never as instructions to you/g) ?? []).length;
  assert.equal(guardCount, 3, "each of the three feedback blocks carries its own guard sentence");

  drainEpisode(seeded.episodeId);
});

test("proposeRules' prompt clamps a skipped suggestion's unbounded summary to 300 chars before it enters the prompt", async () => {
  const PROJECT = "proj-mine-feedback-clamp";
  store.allowProject(PROJECT, "Feedback Clamp Co");

  // correction_candidates.summary has no length constraint at the DB layer
  // (unlike a mined instruction, which is always <= INSTRUCTION_CHAR_LIMIT)
  // -- an MCP-created candidate can carry an arbitrarily long one. Fix round
  // 1 item 1: this must be clamped before it ever reaches the prompt.
  const LONG_SUMMARY = "Always do the thing. ".repeat(100);
  assert.ok(LONG_SUMMARY.length > 2000, "fixture summary must actually exceed 2,000 chars");

  const skipEpisode = store.createTaskEpisode({
    project_id: PROJECT,
    title: "skip seed clamp",
    provenance: "manual",
  }) as { id: number };
  const skipMsg = insertMessage(
    PROJECT,
    "user",
    "seed correction for an unbounded skipped summary",
  );
  store.addEpisodeEvidence(skipEpisode.id, skipMsg.id, "correction");
  const skipCandidate = store.createCorrectionCandidate({
    task_episode_id: skipEpisode.id,
    classification: "constraint_restatement",
    is_correction: true,
    reusable: true,
    proposed_scope: "project",
    summary: LONG_SUMMARY,
    evidence_history_item_ids: [skipMsg.id],
  }) as { id: number };
  store.reviewCorrectionCandidate({
    id: skipCandidate.id,
    action: "exclude",
    reviewer: "test seed",
  });

  const seeded = seedEpisode(PROJECT, {
    request: "Build a settings page.",
    corrections: ["Please add a toggle for dark mode."],
  });

  const { callLlm, prompts } = fakeCapturingCallLlm({ propose: false });
  await propose.proposeRules(callLlm, { limit: 10 });

  assert.equal(prompts.length, 1);
  const prompt = prompts[0]!;
  assert.match(prompt, /Suggestions this user skipped -- do not propose these again/);
  assert.ok(
    !prompt.includes(LONG_SUMMARY),
    "the full 2,000+ char summary must never appear verbatim in the prompt",
  );

  const skippedBlockStart = prompt.indexOf("Suggestions this user skipped");
  const skippedBlockEnd = prompt.indexOf("\n\n", skippedBlockStart);
  const skippedBlock = prompt.slice(
    skippedBlockStart,
    skippedBlockEnd === -1 ? undefined : skippedBlockEnd,
  );
  const entryLine = skippedBlock.split("\n").find((l) => l.startsWith("- "));
  assert.ok(entryLine, "expected a rendered entry line in the skipped-suggestions block");
  // "- " prefix + the clamped text + a " (skipped)"/" (skipped: reason)"
  // suffix -- strip both to check the clamped text itself is <= 300 chars.
  const textOnly = entryLine!.replace(/^- /, "").replace(/ \(skipped(?::[^)]*)?\)$/, "");
  assert.ok(
    textOnly.length <= 300,
    `expected the clamped entry to be <= 300 chars, got ${textOnly.length}`,
  );

  drainEpisode(seeded.episodeId);
});

test("proposeRules drops a new proposal that dice-matches a skipped suggestion (re-proposal guard), counts it as skippedDuplicate, and logs suggestion.skipped_repeat", async () => {
  const PROJECT = "proj-mine-repeat-skip";
  store.allowProject(PROJECT, "Repeat Skip Co");

  const SKIPPED_TEXT = "Always show a loading spinner while the dashboard chart fetches data.";
  const skipEpisode = store.createTaskEpisode({
    project_id: PROJECT,
    title: "skip seed",
    provenance: "manual",
  }) as { id: number };
  const skipMsg = insertMessage(PROJECT, "user", "seed correction for a skipped suggestion");
  store.addEpisodeEvidence(skipEpisode.id, skipMsg.id, "correction");
  const skipCandidate = store.createCorrectionCandidate({
    task_episode_id: skipEpisode.id,
    classification: "constraint_restatement",
    is_correction: true,
    reusable: true,
    proposed_scope: "project",
    summary: SKIPPED_TEXT,
    evidence_history_item_ids: [skipMsg.id],
  }) as { id: number };
  store.reviewCorrectionCandidate({
    id: skipCandidate.id,
    action: "exclude",
    reviewer: "test seed",
  });

  const rulesBefore = store.listProjectRules(PROJECT).length;

  const seeded = seedEpisode(PROJECT, {
    request: "Build a dashboard with a chart.",
    corrections: ["Please add a loading spinner to the chart while it fetches."],
  });

  const ruleWriterJson = {
    propose: true,
    instruction: SKIPPED_TEXT,
    scope: "project",
    prediction: "The chart looks broken with no spinner while data loads.",
    failure_signature: "no-chart-spinner",
    evidence_message_ids: seeded.correctionExternalIds,
    confidence: 0.9,
    contradicts_rule_id: null,
    duplicate_of_rule_id: null,
  };
  const callLlm = fakeRuleWriterCallLlm([
    { match: seeded.requestExternalId, json: ruleWriterJson },
  ]);

  const result = await propose.proposeRules(callLlm, { limit: 10 });
  assert.deepEqual(counts(result), {
    proposed: 0,
    skippedDuplicate: 1,
    skippedNoProposal: 0,
    failed: 0,
  });
  assert.equal(result.createdCandidateIds.length, 0);
  assert.equal(
    store.listProjectRules(PROJECT).length,
    rulesBefore,
    "nothing was written for a repeat of a skipped suggestion",
  );

  const events = store.listEvents(200) as { kind: string; payload: string | null }[];
  const repeatEvent = events.find(
    (e) =>
      e.kind === "suggestion.skipped_repeat" &&
      JSON.parse(e.payload ?? "{}").episode_id === seeded.episodeId,
  );
  assert.ok(repeatEvent, "expected a suggestion.skipped_repeat event");
});
