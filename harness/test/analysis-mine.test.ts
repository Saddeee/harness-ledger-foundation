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
const mine = await import("../src/analysis/mine.js");
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
function fakeMinerCallLlm(
  entries: { match: string; json?: Canned; throw?: Error }[],
): CallLlm {
  return async function callLlm<T>(req: LlmRequest): Promise<LlmResult<T>> {
    const entry = entries.find((e) => req.user.includes(e.match));
    if (!entry) {
      throw new Error(`fakeMinerCallLlm: no canned response matching request:\n${req.user}`);
    }
    if (entry.throw) throw entry.throw;
    return {
      json: entry.json as T,
      provider: "anthropic",
      model: "fake-miner",
      tokensIn: 100,
      tokensOut: 50,
      costUsd: 0,
      latencyMs: 1,
    };
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
 * plan's signature), so mineEpisodes sweeps every allowed project's backlog
 * in one call -- exactly like A1's classifyPending. A test that
 * deliberately leaves an episode un-mined (skipped-duplicate, propose:false,
 * a rejected proposal, or one never reached before a budget stop) must
 * drain it explicitly, or a later test's mineEpisodes call will pick it up
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

/** A live rule that exists independently of the miner (for dedupe/
 * contradiction fixtures) -- goes through the same createCorrectionCandidate
 * -> createLearning -> createRule chain a human or the miner would use, so
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

test("mineEpisodes proposes a rule from a corrected episode; it renders as a pending Improvement with its evidence and instruction; the same episode is not mined twice", async () => {
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

  const minerJson = {
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
  const callLlm = fakeMinerCallLlm([{ match: seeded.requestExternalId, json: minerJson }]);

  const result = await mine.mineEpisodes(callLlm, { limit: 10 });
  assert.deepEqual(result, { proposed: 1, skippedDuplicate: 0, skippedNoProposal: 0, failed: 0 });

  const items = improvements
    .listImprovements()
    .filter((i) => i.project.id === PROJECT && i.proposed_instruction === minerJson.instruction);
  assert.equal(items.length, 1);
  const item = items[0];
  assert.equal(item.decision.status, "pending");
  assert.equal(item.proposed_instruction, minerJson.instruction);
  assert.deepEqual(
    item.evidence.map((e) => e.text).sort(),
    [...seeded.correctionTexts].sort(),
  );

  // Addendum (C1 review): every mined rule gets a verification_plan carrying
  // the miner's kebab-case failure_signature and its prediction, since C1's
  // rule-health computation reads failure_signature from there.
  const rule = item.developer.rule as { id: number };
  const plan = store.getVerificationPlanForRule(rule.id) as {
    plan: { failure_signature: string; failure_condition: string };
  } | null;
  assert.ok(plan, "expected a verification_plan for the mined rule");
  assert.equal(plan!.plan.failure_signature, "missing-confirm-password-field");
  assert.equal(plan!.plan.failure_condition, minerJson.prediction);

  // Not mined twice: the episode now has a correction_candidates row, so
  // listMinableEpisodes no longer selects it and a second run proposes 0.
  const second = await mine.mineEpisodes(callLlm, { limit: 10 });
  assert.deepEqual(second, { proposed: 0, skippedDuplicate: 0, skippedNoProposal: 0, failed: 0 });
});

test("mineEpisodes skips a near-duplicate of a live rule (dice >= 0.8) and writes nothing", async () => {
  const PROJECT = "proj-mine-dup";
  store.allowProject(PROJECT, "Dup Co");

  createManualRule(PROJECT, "Always require a confirm-password field on signup forms.");
  const rulesBefore = store.listProjectRules(PROJECT).length;

  const seeded = seedEpisode(PROJECT, {
    request: "Build a signup form.",
    corrections: ["Please also require a confirm-password field on signup forms."],
  });

  const minerJson = {
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
  const callLlm = fakeMinerCallLlm([{ match: seeded.requestExternalId, json: minerJson }]);

  const result = await mine.mineEpisodes(callLlm, { limit: 10 });
  assert.deepEqual(result, { proposed: 0, skippedDuplicate: 1, skippedNoProposal: 0, failed: 0 });
  assert.equal(store.listProjectRules(PROJECT).length, rulesBefore);
  drainEpisode(seeded.episodeId);
});

test("mineEpisodes counts propose:false as skippedNoProposal and writes nothing", async () => {
  const PROJECT = "proj-mine-noprop";
  store.allowProject(PROJECT, "NoProp Co");

  const seeded = seedEpisode(PROJECT, {
    request: "Build a settings page.",
    corrections: ["Actually, use a different icon here, no big deal either way."],
  });

  const callLlm = fakeMinerCallLlm([{ match: seeded.requestExternalId, json: { propose: false } }]);
  const result = await mine.mineEpisodes(callLlm, { limit: 10 });
  assert.deepEqual(result, { proposed: 0, skippedDuplicate: 0, skippedNoProposal: 1, failed: 0 });

  // Nothing was written, so the episode is still minable.
  assert.ok(store.listMinableEpisodes(500).some((e) => e.id === seeded.episodeId));
  drainEpisode(seeded.episodeId);
});

test("mineEpisodes rejects and logs an evidence id outside the episode's corrections", async () => {
  const PROJECT = "proj-mine-badevidence";
  store.allowProject(PROJECT, "Bad Evidence Co");

  const seeded = seedEpisode(PROJECT, {
    request: "Build a dashboard.",
    corrections: ["The dashboard chart never finishes loading."],
  });

  const minerJson = {
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
  const callLlm = fakeMinerCallLlm([{ match: seeded.requestExternalId, json: minerJson }]);

  const result = await mine.mineEpisodes(callLlm, { limit: 10 });
  assert.deepEqual(result, { proposed: 0, skippedDuplicate: 0, skippedNoProposal: 0, failed: 1 });

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

test("mineEpisodes records a miner-reported contradiction into rule_health for the contradicted live rule", async () => {
  const PROJECT = "proj-mine-contradict";
  store.allowProject(PROJECT, "Contradict Co");

  // Note: store.listLiveRuleTexts() is deliberately global (no project
  // argument), so this fixture's wording must not accidentally overlap
  // (bigram Dice) with any other test's rule text in this file, or the
  // dedupe check above would (correctly) treat it as a duplicate instead of
  // reaching the contradiction path this test is about.
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

  const minerJson = {
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
  const callLlm = fakeMinerCallLlm([{ match: seeded.requestExternalId, json: minerJson }]);

  const result = await mine.mineEpisodes(callLlm, { limit: 10 });
  assert.equal(result.proposed, 1);

  const minedItem = improvements
    .listImprovements()
    .find((i) => i.project.id === PROJECT && i.proposed_instruction === minerJson.instruction);
  assert.ok(minedItem, "expected the mined rule to appear as an Improvement");
  const newRuleId = (minedItem!.developer.rule as { id: number }).id;

  const health = store.getRuleHealth(contradicted.id);
  assert.ok(health, "expected a rule_health row for the contradicted rule");
  assert.equal(health!.contradicted_by_rule_id, newRuleId);
  assert.equal(health!.status, "retire_suggested");
});

test("mineEpisodes stops the loop on LlmBudgetExceeded, leaving the un-reached episode un-mined", async () => {
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

  const callLlm = fakeMinerCallLlm([
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

  const result = await mine.mineEpisodes(callLlm, { limit: 10 });
  assert.deepEqual(result, { proposed: 1, skippedDuplicate: 0, skippedNoProposal: 0, failed: 0 });

  // The second episode was never reached (not even counted as `failed`) --
  // it remains minable for the next run.
  assert.ok(store.listMinableEpisodes(500).some((e) => e.id === second.episodeId));
  drainEpisode(second.episodeId);
});
