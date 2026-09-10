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

const classification = z.enum([
  "defect_correction", "constraint_restatement", "missing_requirement",
  "preference_revision", "scope_extension", "new_task", "question", "approval", "other",
]);
const proposedScope = z.enum(["project", "workspace", "one_time"]);
const ruleState = z.enum([
  "proposed", "approved", "testing", "supported", "active", "questioned",
  "disabled", "retired", "rolled_back", "rejected",
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
  action: z.enum(["confirm", "reclassify", "mark_one_time", "mark_reusable", "change_scope", "exclude"]),
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
