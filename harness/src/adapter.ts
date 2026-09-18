// Transport-agnostic bridge for the TanStack app's local-runtime server
// route (src/routes/api/public/harness/*.ts in the root app) to call into.
// Everything here is plain Node/TS -- no React, no Vite, no browser code
// can reach this file. It re-exports store.ts functions behind validated,
// narrow inputs so the HTTP layer never needs to touch SQLite directly and
// never exposes arbitrary SQL or a generic mutation endpoint.
import { z } from "zod";
import * as store from "./store.js";

// Checkpoint C.2: the single-item "Improvement" view and its actions.
export { listImprovements, getImprovement, improvementAction } from "./improvements.js";
export type { Improvement } from "./improvements.js";

// Round 5 Task 3: the History page's per-target timeline (spec §3b). The
// "verdict" improvement action lives in the actionInput union above, via
// improvementAction -- no separate export needed for it.
export { buildTimeline } from "./improvements.js";
export type { TimelineNode } from "./improvements.js";

// Checkpoint E (v5): settings, skill snapshots, sync coordination, and the
// read helpers the executor and local UI need. Plain re-exports -- store.ts
// already validates ranges/enums itself (setSettings, allowed_projects
// constraints), so no extra zod schema is needed for these narrow functions.
export {
  getAllowedProjects,
  getProjectMeta,
  latestKnowledgeSnapshot,
  listKnowledgeVersions,
  activeRulesForTarget,
  retiredRulesForTarget,
  listPendingKnowledgeWrites,
  createRestoreVersion,
  getKnowledgeVersion,
  listEvents,
  getSettings,
  setSettings,
  latestSkillSnapshots,
  latestSyncRun,
  runningSyncRun,
  requestSync,
  countHistoryItemsAwaitingAnalysis,
  listHistoryStats,
  allowProject,
  disallowProject,
  getCorrectionIdForRule,
  getProjectSettings,
  setProjectSettings,
  effectiveMaxActiveRules,
  sumLlmCostThisMonth,
  sumLlmTokensThisMonth,
  listSkillSnapshots,
  // Task C3: the Inbox badge/notification count (pending improvements + open
  // retirement proposals) and the "new since last visit" setting, read via
  // the getSettings/setSettings above (key "inbox_last_seen_at").
  countInboxItems,
  // Task C3 / spec §4/§4b: the Instructions page's per-rule health line --
  // getRuleHealth for the counts, listLiveRulesWithTargets for each live
  // rule's first_written_at ("since").
  getRuleHealth,
  listLiveRulesWithTargets,
} from "./store.js";

// Round 5 Task 1: skip reasons/decided-by on a correction candidate,
// rule-level verdicts, per-episode rule adherence, and the evidence-source
// setting/feedback-stats read helpers later Round 5 tasks build the
// decision-mode auto-accept path, the judge role, and the Instructions
// page's feedback/evidence panels on top of.
export {
  setCandidateSkipReason,
  setCandidateDecidedBy,
  recordRuleVerdict,
  latestRuleVerdict,
  listRuleVerdicts,
  recordRuleAdherence,
  listRuleAdherence,
  adherenceCounts,
  listUnjudgedEpisodesForRule,
  getEvidenceSources,
  feedbackStats,
  listAcceptedRuleTexts,
  listSkippedSuggestions,
  listWordingEdits,
  tagAcceptanceRates,
  getLlmModels,
  // Round 5 Task 6 / spec §4: the Inbox's own automatic-mode empty-state
  // count ("Harness accepted N suggestions... since your last visit").
  countAutoAcceptedSince,
} from "./store.js";
export type {
  SkipReason,
  RuleVerdict,
  AdherenceVerdict,
  EvidenceSources,
  FeedbackStats,
} from "./store.js";

// Round 6 Task 1: schema v12's experiment_runs/credit_ledger bookkeeping,
// for the paired-test runner and judge UI later Round 6 tasks build on top
// of. recordRuleVerdict's own re-export above now returns { id, changed }
// (see its header comment in store.ts) -- no separate export needed for
// that change.
export {
  createExperimentRun,
  updateExperimentRun,
  getExperimentRun,
  listExperimentRuns,
  runningExperimentRun,
  creditsThisMonth,
  recordCredits,
  lastKnownTestCost,
  listUndeletedCopies,
  episodeRequestExternalId,
  countEditsSince,
} from "./store.js";
export type { ExperimentStatus, ExperimentRunRow } from "./store.js";

// The executor's process lock (Round 6 Task 1): the app's own executor loop
// and a manually-run `npm run harness:executor` CLI invocation both claim
// this before driving Lovable, so a paired-test run and a sync/analysis
// pass never race each other.
export {
  acquireLock,
  heartbeat as heartbeatLock,
  releaseLock,
  defaultLockPath,
} from "./executor/lock.js";
export type { LockOwner, LockHolder, LockAcquireResult } from "./executor/lock.js";

// The Lovable REST client (Round 6 Task 1): plain fetch against
// api.lovable.dev, used only by the paired-test runner (later Round 6
// tasks) -- everything else in this app still goes through the Lovable MCP
// client (lovable-mcp.ts). Re-exported here so the web app's local-runtime
// route can construct one the same way it reaches every other executor
// primitive, without importing across the executor/ boundary directly.
export { createLovableRest, LovableRestError } from "./executor/lovable-rest.js";
export type { LovableRest, RestMessage, RestBuildStatus } from "./executor/lovable-rest.js";

// Round 6 Task 2: writes to Lovable immediately when connected (spec §2) --
// improvementActionAndWrite wraps improvements.ts's own improvementAction
// and, for the actions that stage a real Knowledge write, runs it right
// away via executor/beats.ts's executeVersionNow. Lives in beats.ts, not
// improvements.ts, because improvements.ts must never import anything
// Lovable-related (see its own "no Lovable import" test) -- re-exported
// here the same way createLovableRest just above is: adapter.ts's own
// source never imports Lovable code directly, only re-exports factories/
// functions the executor/ modules define.
export { improvementActionAndWrite, retryKnowledgeWrite } from "./executor/beats.js";
export type { WriteOutcome, WriteOutcomeKind } from "./executor/beats.js";

// Round 3: per-provider LLM API keys, stored in their own 0600 file, never in
// SQLite and never returned beyond has_key/last4 (see llm-keys.ts).
export {
  setKey as setLlmKey,
  removeKey as removeLlmKey,
  keyStatus as llmKeyStatus,
} from "./llm-keys.js";

// Round 4 Task A3: "Analyse now" -- the executor route's GET needs the last
// run/running state, the local UI's POST needs to create a request. Mirrors
// the sync re-exports above.
export {
  requestAnalysis,
  hasOpenAnalysisRequest,
  latestAnalysisRun,
  runningAnalysisRun,
  runningAnalysisProgress,
  testCopyProjects,
  setProjectName,
} from "./store.js";

// Round 3: a small, pure line diff for the Instructions page's "What
// changed" view (see diff.ts).
export { lineDiff } from "./diff.js";

// Round 3: removable demo data -- only the read is re-exported here (the
// Instructions page's "Demo data is loaded" notice); --add/--remove stay a
// deliberate CLI-only operation (npm run harness:demo -- --add|--remove).
export { demoLoaded } from "./demo.js";

const classification = z.enum([
  "defect_correction",
  "constraint_restatement",
  "missing_requirement",
  "preference_revision",
  "scope_extension",
  "new_task",
  "question",
  "approval",
  "other",
]);
const proposedScope = z.enum(["project", "workspace", "one_time"]);
const ruleState = z.enum([
  "proposed",
  "approved",
  "testing",
  "supported",
  "active",
  "questioned",
  "disabled",
  "retired",
  "rolled_back",
  "rejected",
]);

// Single-fetch list that already carries everything a detail view needs
// (evidence + classification history per row), matching this app's existing
// convention of one page, no per-item drill-down route (see jobs.tsx).
export function listCorrections() {
  return store.listCorrectionCandidates().map((r) => {
    const id = (r as unknown as { id: number }).id;
    return {
      ...r,
      classification_history: store.getClassificationHistory(id),
      learning: store.getLearningForCorrection(id),
      rule: store.getRuleForCorrection(id),
      audit_events: store.listEventsForRecord(["correction_candidate."], id),
    };
  });
}

export function getCorrection(id: number) {
  const parsedId = z.number().int().parse(id);
  const found = store.getCorrectionCandidate(parsedId);
  if (!found) return null;
  return { ...found, classification_history: store.getClassificationHistory(parsedId) };
}

const reviewInput = z.object({
  id: z.number().int(),
  action: z.enum([
    "confirm",
    "reclassify",
    "mark_one_time",
    "mark_reusable",
    "change_scope",
    "exclude",
  ]),
  classification: classification.optional(),
  proposed_scope: proposedScope.optional(),
  reviewer: z.string().default("operator (local UI)"),
});

export function reviewCorrection(input: unknown) {
  const parsed = reviewInput.parse(input);
  return store.reviewCorrectionCandidate(parsed);
}

const humanDecisionInput = z.object({
  id: z.number().int(),
  final_classification: classification,
  reusable: z.boolean(),
  proposed_scope: proposedScope,
  reviewer: z.string().default("operator (local UI)"),
});

export function recordHumanCorrectionDecision(input: unknown) {
  const parsed = humanDecisionInput.parse(input);
  return store.recordHumanCorrectionDecision(parsed);
}

const summaryEditInput = z.object({
  id: z.number().int(),
  summary: z.string().min(1).max(2000),
  reviewer: z.string().default("operator (local UI)"),
});

export function editCorrectionSummary(input: unknown) {
  const parsed = summaryEditInput.parse(input);
  // Reuse the review pathway's audit/event guarantees; a summary edit is not
  // one of the six review actions, so it is written directly here, and still
  // logs its own event -- every mutation creates an audit event.
  return store.editCorrectionSummary(parsed.id, parsed.summary, parsed.reviewer);
}

// Same single-fetch convention as listCorrections: each row already carries
// its revision history, linked learning, linked correction candidate, and
// that correction's evidence (so "evidence provenance" is visible without a
// second fetch).
export function listRules() {
  return store.listProjectRules().map((r) => {
    const ruleId = (r as { id: number }).id;
    const full = store.getRule(ruleId) as {
      correction_candidate: { id: number } | null;
    } & Record<string, unknown>;
    const evidence = full.correction_candidate
      ? (store.getCorrectionCandidate(full.correction_candidate.id)?.evidence ?? [])
      : [];
    const correctionId = full.correction_candidate?.id;
    return {
      ...full,
      correction_evidence: evidence,
      classification_history: correctionId ? store.getClassificationHistory(correctionId) : [],
      verification_plan: store.getVerificationPlanForRule(ruleId),
      experiment_plans: store.listExperimentPlansForRule(ruleId),
      audit_events: store.listEventsForRecord(["rule."], ruleId),
    };
  });
}

export function getRuleDetail(id: number) {
  const parsedId = z.number().int().parse(id);
  return store.getRule(parsedId);
}

const updateRuleInput = z.object({
  id: z.number().int(),
  instruction: z.string().min(1).max(2000).optional(),
  state: ruleState.optional(),
  reason: z.string().max(2000).optional(),
  actor: z.string().default("operator (local UI)"),
});

export function updateRuleAction(input: unknown) {
  const parsed = updateRuleInput.parse(input);
  return store.updateRule(parsed);
}

// ---- Round 6 Task 6a ----
// The paired-test runner (spec §6): startExperiment (refusals, then a
// queued experiment_runs row), runExperiment (the six Run steps over a
// LovableRest client -- copy, Knowledge, build, record, cleanup, hand off
// to the owner; never throws), cleanupCopy (delete the copy unless
// keep_test_copies, else private + a note). Re-exported here the same way
// createLovableRest above is, so the web app's local-runtime route can wire
// "Test this rule" (Task 6b) without importing across the executor/
// boundary directly. No route calls runExperiment except from the owner's
// own button press.
export { startExperiment, runExperiment, cleanupCopy } from "./executor/experiments.js";
// Fix round 1: episodeRequestText (the full, untruncated request text the
// runner replays) and activeExperimentRun (the queued-run-aware guard
// startExperiment now uses) -- both added to store.ts's own
// `// ---- Round 6 Task 6a ----` block, re-exported here the same way the
// rest of this file's store.ts re-exports are.
export { episodeRequestText, activeExperimentRun } from "./store.js";
// ---- end Round 6 Task 6a ----

// ---- Round 6 Task 6b ----
// The judging screen's own read (ExperimentRunView, built from an
// experiment_runs row plus the episode/rule text around it -- no Lovable
// access, so it lives in improvements.ts, not an executor/ module). The
// executor route's own `credits`/`undeleted_copies` GET fields are built
// from adapter.getSettings()/creditsThisMonth()/lastKnownTestCost()/
// listUndeletedCopies(), all already re-exported above -- nothing new
// needed for those.
export { buildExperimentRunView } from "./improvements.js";

// Checkpoint 2026-09-18: runs recorded before migration v18 get their
// environment record computed from what was on file when they ran. Runs once
// per process; idempotent.
import { backfillReplayEnvironments } from "./executor/replay-environment.js";
backfillReplayEnvironments();
export { backfillReplayEnvironments };
export type { ExperimentRunView } from "./improvements.js";
// ---- end Round 6 Task 6b ----

// ---- Round 6c ----
// The Tests page's own list read (GET .../improvements?runs=1) -- a pure
// improvements.ts read, same reason buildExperimentRunView lives there and
// is re-exported here rather than in store.ts directly. The "feedback"
// action itself needs no new export: it goes through the existing
// improvementAction re-export above, same as "judge".
export { listTestRunSummaries } from "./improvements.js";
export type { ExperimentRunSummary } from "./improvements.js";
// ---- end Round 6c ----

// ---- Checkpoint 2026-09-18 WP5 ----
// D7: the automatic-analysis-after-sync setting (getSettings/setSettings
// above can't carry it -- store.ts's SettingKey union is owned by WP4 this
// checkpoint; see analysis/context.ts's header), and "Reanalyse history"
// (estimate, request, and the disagreement review-item actions) -- all
// re-exported the same plain way every other executor-route primitive in
// this file is.
export {
  getAutomaticAnalysisSetting,
  setAutomaticAnalysisSetting,
  AUTOMATIC_ANALYSIS_SETTING_KEY,
} from "./analysis/context.js";
export {
  estimateReanalysis,
  requestReanalysis,
  listAnalysisDisagreements,
  acceptDisagreement,
  dismissDisagreement,
} from "./analysis/reanalyse.js";
export type {
  ReanalyseScope,
  ReanalysisEstimate,
  AnalysisDisagreementRow,
} from "./analysis/reanalyse.js";
// ---- end Checkpoint 2026-09-18 WP5 ----

// ---- Checkpoint 2026-09-18 WP6 ----
// harness/src/mcp-server.ts (D5: MCP over the same paths as the UI) needs
// two more plain reads the web app's own routes already had another way to
// reach: store.health() (the web app never needed it -- the dev server
// binding itself is the health signal there) and the "is Harness connected
// to Lovable" flag the improvements/knowledge/executor routes read via
// loadHarnessExecutor().auth.status().connected. That loader lives in the
// TanStack app (src/lib/server/harness-runtime.ts) and cannot be imported
// from harness/src, so mcp-server.ts needs the same underlying, store.ts-
// free status() function directly -- re-exported here under a name that
// says what it is, not just what it wraps, the same convention
// createLovableRest/acquireLock above already follow.
export { health } from "./store.js";
export { status as lovableAuthStatus } from "./executor/lovable-auth.js";
// ---- end Checkpoint 2026-09-18 WP6 ----

// ---- Checkpoint 2026-09-18 WP4 ----
// Skills as a first-class destination (D4): the Skills page's own read
// (src/routes/api/public/harness/skills.ts) needs the local Skill proposals
// list alongside the existing workspace-Skill snapshots already re-exported
// above (latestSkillSnapshots/listSkillSnapshots) -- everything else (the
// destination fields on an Improvement, and every skill-proposal action) is
// already reachable through the existing listImprovements/getImprovement/
// improvementAction re-exports at the top of this file, so no separate
// export is needed for those.
export { listSkillProposalsForSkillsView } from "./store.js";
export type {
  SkillProposalStatus,
  SkillProposalOwnership,
  SkillProposalLovableState,
} from "./store.js";
// ---- end Checkpoint 2026-09-18 WP4 ----
