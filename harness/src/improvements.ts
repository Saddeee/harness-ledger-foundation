// The user-facing "Improvement" view (checkpoint C.2): one item per piece of
// Lovable feedback, composed from a correction + its learning/rule + its
// proof plan. Pure reads over store.ts plus a small action mapper; no new
// semantics, no Lovable access. Contract: scratchpad/improvement-contract.md.
import { z } from "zod";
import * as store from "./store.js";

export type StageKey = "found" | "review" | "proof" | "in_lovable";
export type StageState = "complete" | "current" | "future" | "blocked";
export type Stage = { key: StageKey; state: StageState; note: string | null };
export type Message = { id: number; author: "you" | "lovable"; sent_at: string | null; text: string };
export type Improvement = {
  id: number;
  project: { id: string; name: string | null };
  title: string;
  proposed_instruction: string | null;
  destination: "workspace" | "project" | "one_time" | null;
  classification: string;
  decision: { status: "pending" | "accepted" | "skipped"; decided_at: string | null; divergence: string | null };
  stage: StageKey;
  stages: Stage[];
  evidence: Message[];
  proof: {
    exists: boolean;
    runnable: false;
    lovable_credits_max: number | null;
    outcome: "not_run" | "passed" | "failed" | "unclear" | null;
    manual_cleanup: boolean;
  } | null;
  wording_history: { changed_at: string; from: string; to: string; reason: string | null }[];
  developer: {
    correction: unknown;
    learning: unknown | null;
    rule: unknown | null;
    classification_history: unknown[];
    hidden_evidence: unknown[];
    verification_plan: unknown | null;
    experiment_plans: unknown[];
    audit_events: unknown[];
  };
};

type CorrectionRow = {
  id: number;
  project_id: string | null;
  project_name: string | null;
  classification: string;
  reviewed: number;
  reviewed_at: string | null;
  proposed_scope: "workspace" | "project" | "one_time" | null;
  excluded_from_learning: number;
  summary: string;
};
type RuleRow = { id: number; instruction: string; state: string; scope: "workspace" | "project" };
type LearningRow = { id: number; desired_behavior: string };
type EvidenceRow = { id: number; role: string | null; content: string; occurred_at: string | null };
type RevisionRow = {
  previous_instruction: string;
  new_instruction: string;
  reason: string | null;
  created_at: string;
};
type PlanItem = { status: "passed" | "failed" | "unclear" | "not_run" };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "8 Sep" -- day + short month, UTC, for the stage notes only.
export function shortDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

function firstSentence(text: string | null | undefined): string {
  if (!text) return "";
  const t = text.trim();
  const m = t.match(/^.*?[.!?](?=\s|$)/);
  return (m ? m[0] : t).trim();
}

const ACCEPTED_RULE_STATES = new Set(["approved", "testing", "supported", "active"]);
const PROOF_DONE_RULE_STATES = new Set(["supported", "active"]);

function proofOutcome(items: PlanItem[]): Improvement["proof"] extends infer P
  ? P extends { outcome: infer O }
    ? O
    : never
  : never {
  if (items.length === 0) return null;
  if (items.some((i) => i.status === "failed")) return "failed";
  if (items.some((i) => i.status === "unclear")) return "unclear";
  if (items.every((i) => i.status === "passed")) return "passed";
  return "not_run";
}

function buildImprovement(c: CorrectionRow): Improvement {
  const rule = store.getRuleForCorrection(c.id) as RuleRow | null;
  const learning = store.getLearningForCorrection(c.id) as LearningRow | null;
  const { visible, hidden } = store.getEvidenceForCorrection(c.id) as unknown as {
    visible: EvidenceRow[];
    hidden: unknown[];
  };
  const verificationPlan = rule ? store.getVerificationPlanForRule(rule.id) : null;
  const experimentPlans = rule ? store.listExperimentPlansForRule(rule.id) : [];
  const experiment = (experimentPlans[0] ?? null) as
    | { plan: { status: string; starting_state_quality: string; max_permitted_credits: number; cleanup_requirements: string } }
    | null;
  const planItems = ((verificationPlan as { items: PlanItem[] } | null)?.items ?? []) as PlanItem[];
  const outcome = proofOutcome(planItems);

  const excluded = c.excluded_from_learning === 1;
  const reviewed = c.reviewed === 1;
  const ruleState = rule?.state ?? null;

  // ---- decision ----
  let status: Improvement["decision"]["status"];
  if (excluded || ruleState === "rejected") status = "skipped";
  else if (reviewed && ruleState && ACCEPTED_RULE_STATES.has(ruleState)) status = "accepted";
  else status = "pending";

  let divergence: string | null = null;
  if (excluded && ruleState && ACCEPTED_RULE_STATES.has(ruleState)) {
    divergence = "You skipped this lesson, but a rule based on it is still approved.";
  } else if (!excluded && reviewed && ruleState === "rejected") {
    divergence = "You confirmed this lesson, but the rule based on it was rejected.";
  } else if (
    rule &&
    (c.proposed_scope === "project" || c.proposed_scope === "workspace") &&
    rule.scope !== c.proposed_scope
  ) {
    const lay = { project: "this project only", workspace: "all your projects" } as const;
    divergence = `You chose ${lay[c.proposed_scope]} for the lesson, but the rule is set to ${lay[rule.scope]}.`;
  }

  // ---- stages ----
  const reviewState: StageState = status === "skipped" ? "blocked" : status === "accepted" ? "complete" : "current";
  let proofState: StageState;
  if (reviewState !== "complete") proofState = reviewState === "blocked" ? "blocked" : "future";
  else if (experiment?.plan.starting_state_quality === "blocked" || experiment?.plan.status === "rejected") proofState = "blocked";
  else if (outcome === "passed" || (ruleState && PROOF_DONE_RULE_STATES.has(ruleState))) proofState = "complete";
  else proofState = "current";
  let inLovableState: StageState;
  if (ruleState === "active") inLovableState = "complete";
  else if (proofState === "complete") inLovableState = "current";
  else if (proofState === "blocked") inLovableState = "blocked";
  else inLovableState = "future";

  const foundDate = shortDate(visible[0]?.occurred_at ?? null);
  const decidedDate = shortDate(c.reviewed_at);
  const proofNote =
    outcome === "passed" ? "Passed"
    : outcome === "failed" ? "Failed"
    : outcome === "unclear" ? "Unclear"
    : experiment ? "Proof proposed — running it isn't available yet"
    : "Not proposed yet";

  const stages: Stage[] = [
    { key: "found", state: "complete", note: foundDate ? `Found in your Lovable chat, ${foundDate}` : "Found in your Lovable chat" },
    {
      key: "review",
      state: reviewState,
      note: status === "skipped" ? "Skipped" : status === "accepted" && decidedDate ? `You decided on ${decidedDate}` : status === "accepted" ? "You decided" : "Waiting for your decision",
    },
    { key: "proof", state: proofState, note: proofNote },
    { key: "in_lovable", state: inLovableState, note: ruleState === "active" ? "Added" : "Nothing added yet" },
  ];
  const stage: StageKey = (stages.find((s) => s.state !== "complete")?.key ?? "in_lovable") as StageKey;

  // ---- wording history (instruction changes only, oldest first) ----
  const revisions = ((rule ? (store.getRule(rule.id) as { revisions: RevisionRow[] } | null)?.revisions : []) ?? []) as RevisionRow[];
  const wording_history = [...revisions]
    .reverse()
    .filter((r) => r.previous_instruction !== r.new_instruction)
    .map((r) => ({ changed_at: r.created_at, from: r.previous_instruction, to: r.new_instruction, reason: r.reason }));

  const title = rule ? firstSentence(rule.instruction) : learning ? firstSentence(learning.desired_behavior) : firstSentence(c.summary);

  return {
    id: c.id,
    project: { id: c.project_id ?? "", name: c.project_name ?? null },
    title: title || c.summary,
    proposed_instruction: rule?.instruction ?? null,
    destination: rule ? rule.scope : (c.proposed_scope ?? null),
    classification: c.classification,
    decision: { status, decided_at: status === "pending" ? null : c.reviewed_at, divergence },
    stage,
    stages,
    evidence: visible.map((e) => ({
      id: e.id,
      author: e.role === "user" ? "you" : "lovable",
      sent_at: e.occurred_at,
      text: e.content,
    })),
    proof:
      experiment || verificationPlan
        ? {
            exists: !!experiment && !!verificationPlan,
            runnable: false,
            lovable_credits_max: experiment?.plan.max_permitted_credits ?? null,
            outcome,
            manual_cleanup: experiment ? /manual/i.test(experiment.plan.cleanup_requirements) : false,
          }
        : null,
    wording_history,
    developer: {
      correction: c,
      learning,
      rule,
      classification_history: store.getClassificationHistory(c.id),
      hidden_evidence: hidden,
      verification_plan: verificationPlan,
      experiment_plans: experimentPlans,
      audit_events: [
        ...store.listEventsForRecord(["correction_candidate."], c.id),
        ...(rule ? store.listEventsForRecord(["rule."], rule.id) : []),
      ],
    },
  };
}

export function listImprovements(): Improvement[] {
  return (store.listCorrectionCandidates() as unknown as CorrectionRow[]).map(buildImprovement);
}

export function getImprovement(id: number): Improvement | null {
  const row = (store.listCorrectionCandidates() as unknown as CorrectionRow[]).find((c) => c.id === id);
  return row ? buildImprovement(row) : null;
}

const ACTOR = "operator (local UI)";
const destination = z.enum(["workspace", "project"]);
const actionInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("accept"), id: z.number().int(), destination }),
  z.object({ action: z.literal("skip"), id: z.number().int() }),
  z.object({ action: z.literal("reopen"), id: z.number().int() }),
  z.object({
    action: z.literal("change_wording"),
    id: z.number().int(),
    instruction: z.string().min(1).max(2000),
    reason: z.string().max(2000).optional(),
  }),
  z.object({
    action: z.literal("set_destination"),
    id: z.number().int(),
    destination: z.enum(["workspace", "project", "one_time"]),
  }),
]);

export function improvementAction(input: unknown): Improvement {
  const a = actionInput.parse(input);
  const current = getImprovement(a.id);
  if (!current) throw new Error(`improvement ${a.id} not found`);
  const rule = store.getRuleForCorrection(a.id) as RuleRow | null;

  switch (a.action) {
    case "accept":
      store.recordHumanCorrectionDecision({
        id: a.id,
        final_classification: current.classification as never,
        reusable: true,
        proposed_scope: a.destination,
        reviewer: ACTOR,
      });
      if (rule) store.updateRule({ id: rule.id, state: "approved", scope: a.destination, actor: ACTOR });
      break;
    case "skip":
      store.reviewCorrectionCandidate({ id: a.id, action: "exclude", reviewer: ACTOR });
      if (rule) store.updateRule({ id: rule.id, state: "rejected", actor: ACTOR });
      break;
    case "reopen":
      store.reviewCorrectionCandidate({ id: a.id, action: "include", reviewer: ACTOR });
      if (rule) store.updateRule({ id: rule.id, state: "proposed", actor: ACTOR });
      break;
    case "change_wording":
      if (!rule) throw new Error("This improvement has no rule wording to change yet");
      store.updateRule({ id: rule.id, instruction: a.instruction, actor: ACTOR, ...(a.reason ? { reason: a.reason } : {}) });
      break;
    case "set_destination":
      if (a.destination === "one_time") {
        store.reviewCorrectionCandidate({ id: a.id, action: "mark_one_time", reviewer: ACTOR });
      } else {
        store.reviewCorrectionCandidate({ id: a.id, action: "change_scope", proposed_scope: a.destination, reviewer: ACTOR });
        if (rule) store.updateRule({ id: rule.id, scope: a.destination, actor: ACTOR });
      }
      break;
  }
  const refreshed = getImprovement(a.id);
  if (!refreshed) throw new Error(`improvement ${a.id} not found after update`);
  return refreshed;
}
