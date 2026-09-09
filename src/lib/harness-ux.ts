// Pure, dependency-free presentation logic for the guided Harness UI.
// No React, no imports -- so it can be unit-tested from harness/test via tsx.
// Nothing here mutates data; it only maps internal state to plain language
// and picks which action to foreground.

// ---- Plain-language labels for internal enum values ----

export const CLASSIFICATION_LABELS: Record<string, string> = {
  constraint_restatement: "Existing expectation was missed",
  preference_revision: "You changed the preferred approach",
  missing_requirement: "Part of the request was missed",
  defect_correction: "Lovable made an implementation mistake",
  scope_extension: "The request grew beyond its original scope",
  new_task: "A new request, not a correction",
  question: "A question, not a correction",
  approval: "An approval, not a correction",
  other: "Other",
};

export const SCOPE_LABELS: Record<string, string> = {
  workspace: "Use across my projects",
  project: "Use only in this project",
  one_time: "One-time decision",
};

export const EVIDENCE_LEVEL_LABELS: Record<string, string> = {
  proposed: "Not tested yet",
  human_grounded: "Confirmed by you",
  verifiable: "Has a defined check",
  historical_support: "Supported by past history",
  controlled_support: "Supported by a controlled test",
  repeated_controlled_support: "Supported by repeated tests",
  field_supported: "Supported in real use",
};

export const VERIFIER_TYPE_LABELS: Record<string, string> = {
  structural: "Automatic check",
  diff_pattern: "Automatic diff check",
  ai_rubric: "AI review",
  human_only: "Your review",
};

export const VERIFIER_STATUS_LABELS: Record<string, string> = {
  not_run: "Not tested",
  passed: "Passed",
  failed: "Failed",
  unclear: "Unclear",
};

export const EXPERIMENT_TYPE_LABELS: Record<string, string> = {
  paired_control_treatment: "Compare with and without the rule",
  treatment_only: "Test with the rule only",
  ablation: "Test what changes when the rule is removed",
};

export const RULE_STATE_LABELS: Record<string, string> = {
  proposed: "Needs review",
  approved: "Approved, not tested",
  testing: "Being tested",
  supported: "Test supported it",
  active: "Active in Lovable",
  questioned: "Questioned",
  disabled: "Disabled",
  retired: "Retired",
  rolled_back: "Rolled back",
  rejected: "Rejected",
};

export const FIELD_LABELS: Record<string, string> = {
  predicted_failure: "Problem this should prevent",
  applies_when: "When this applies",
};

export function label(map: Record<string, string>, value: string | null | undefined): string {
  if (value == null) return "";
  return map[value] ?? value;
}

// ---- Text helpers ----

export function firstSentence(text: string | null | undefined): string {
  if (!text) return "";
  const trimmed = text.trim();
  const match = trimmed.match(/^.*?[.!?](?=\s|$)/);
  return (match ? match[0] : trimmed).trim();
}

export function excerpt(text: string | null | undefined, max = 240): string {
  if (!text) return "";
  const t = text.trim().replace(/\s+/g, " ");
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${cut.slice(0, lastSpace > 80 ? lastSpace : max)}…`;
}

// ---- Process progress: Found -> Review -> Test -> Add to Lovable ----

export type StageKey = "found" | "review" | "test" | "add";
export type StageState = "complete" | "current" | "future" | "blocked";
export type Stage = { key: StageKey; label: string; state: StageState };

export type StageInput = {
  reviewed: boolean;
  excludedFromLearning: boolean;
  ruleState: string | null;
  experimentStatus: string | null;
  experimentStartingState: string | null;
  testOutcome: "passed" | "failed" | "unclear" | "not_run" | null;
};

const REVIEW_DONE_RULE_STATES = new Set([
  "approved",
  "testing",
  "supported",
  "active",
  "questioned",
  "retired",
  "rolled_back",
]);
const TEST_DONE_RULE_STATES = new Set(["supported", "active"]);

export function computeStages(input: StageInput): Stage[] {
  const found: Stage = { key: "found", label: "Found", state: "complete" };

  let review: StageState;
  if (input.excludedFromLearning || input.ruleState === "rejected") review = "blocked";
  else if (input.reviewed && input.ruleState && REVIEW_DONE_RULE_STATES.has(input.ruleState))
    review = "complete";
  else review = "current";

  let test: StageState;
  if (review !== "complete") test = review === "blocked" ? "blocked" : "future";
  else if (input.experimentStatus === "rejected" || input.experimentStartingState === "blocked")
    test = "blocked";
  else if (
    input.testOutcome === "passed" ||
    (input.ruleState && TEST_DONE_RULE_STATES.has(input.ruleState))
  )
    test = "complete";
  else test = "current";

  let add: StageState;
  if (input.ruleState === "active") add = "complete";
  else if (test === "complete") add = "current";
  else if (test === "blocked") add = "blocked";
  else add = "future";

  return [
    found,
    { key: "review", label: "Review", state: review },
    { key: "test", label: "Test", state: test },
    { key: "add", label: "Add to Lovable", state: add },
  ];
}

// ---- Primary-action selection from lifecycle state ----

export type Action = {
  kind: string;
  label: string;
  consequence: string;
};

export const NO_LOVABLE_CHANGE = "Nothing will be changed in Lovable.";
export const NO_CREDITS = "No Lovable credits will be used.";

export const APPROVAL_CONFIRMATION = {
  title: "Approve this rule?",
  body: "This confirms that the rule represents a reusable instruction.",
  noLovableChange: NO_LOVABLE_CHANGE,
  noCredits: NO_CREDITS,
  confirmLabel: "Approve rule",
};

export const CONTINUE_CONFIRMATION = {
  title: "Record your decision?",
  body: "This records that the lesson captures what you meant. Harness prepares a rule from it.",
  noLovableChange: NO_LOVABLE_CHANGE,
  noCredits: NO_CREDITS,
  confirmLabel: "Yes, continue",
};

export function correctionPrimaryAction(input: {
  reviewed: boolean;
  excludedFromLearning: boolean;
  hasRule: boolean;
}): Action {
  if (input.excludedFromLearning) {
    return {
      kind: "none",
      label: "Excluded from learning",
      consequence: "Harness will not create a rule from this.",
    };
  }
  if (!input.reviewed) {
    return {
      kind: "confirm",
      label: "Yes, continue",
      consequence: `Harness prepares a rule. ${NO_LOVABLE_CHANGE} ${NO_CREDITS}`,
    };
  }
  if (input.hasRule) {
    return {
      kind: "view_rule",
      label: "View rule",
      consequence: "Opens the rule Harness prepared from this lesson.",
    };
  }
  return {
    kind: "none",
    label: "Waiting for Harness to draft a rule",
    consequence: `${NO_LOVABLE_CHANGE} ${NO_CREDITS}`,
  };
}

export function rulePrimaryAction(state: string | null | undefined): Action {
  switch (state) {
    case "proposed":
      return {
        kind: "approve",
        label: "Approve rule",
        consequence: `${NO_LOVABLE_CHANGE} ${NO_CREDITS}`,
      };
    case "approved":
      return {
        kind: "review_test",
        label: "Review the proposed test",
        consequence:
          "Shows how Harness can check this rule. Running the test is not available yet, so nothing will be executed.",
      };
    case "rejected":
    case "disabled":
    case "retired":
    case "rolled_back":
      return {
        kind: "return_to_proposed",
        label: "Return to proposed",
        consequence: `${NO_LOVABLE_CHANGE} ${NO_CREDITS}`,
      };
    default:
      return { kind: "none", label: "No action needed", consequence: "" };
  }
}

// Plain-language status line for a rule, e.g. "Approved, not tested, not added to Lovable."
export function ruleStatusSentence(
  state: string | null | undefined,
  testOutcome: string | null,
): string {
  const testPart =
    testOutcome === "passed"
      ? "test passed"
      : testOutcome === "failed"
        ? "test failed"
        : "not tested";
  switch (state) {
    case "proposed":
      return "Needs your review. Not tested, not added to Lovable.";
    case "approved":
      return `Approved, ${testPart}, not added to Lovable.`;
    case "testing":
      return "Being tested. Not added to Lovable.";
    case "supported":
      return "Test supported it. Not added to Lovable yet.";
    case "active":
      return "Active in Lovable.";
    case "questioned":
      return "Questioned after a failure. Still in Lovable.";
    case "rejected":
      return "Rejected. Not added to Lovable.";
    default:
      return `${label(RULE_STATE_LABELS, state)}. Not added to Lovable.`;
  }
}

// ---- Episode story derived from evidence items ----

export type EvidenceLike = {
  id: number;
  kind: string;
  role: string | null;
  content: string;
  occurred_at: string | null;
  provenance: string;
};

export type Story = {
  requested: EvidenceLike | null;
  built: EvidenceLike | null;
  feedback: EvidenceLike | null;
  changed: EvidenceLike[];
};

const FEEDBACK_KINDS = new Set(["manual_note", "build_log_row"]);

export function storyFromEvidence(evidence: EvidenceLike[]): Story {
  const sorted = [...evidence].sort((a, b) => {
    const ta = a.occurred_at ?? "9999";
    const tb = b.occurred_at ?? "9999";
    return ta === tb ? a.id - b.id : ta < tb ? -1 : 1;
  });

  const feedbackIdx = sorted.findIndex((e) => e.role === "operator" || FEEDBACK_KINDS.has(e.kind));
  const before = feedbackIdx === -1 ? sorted : sorted.slice(0, feedbackIdx);
  const after = feedbackIdx === -1 ? [] : sorted.slice(feedbackIdx + 1);

  const requested = before.find((e) => e.kind === "message" && e.role === "user") ?? null;
  const built =
    before.find((e) => e.role === "assistant" || e.kind === "diff" || e.kind === "edit") ?? null;
  const feedback = feedbackIdx === -1 ? null : (sorted[feedbackIdx] ?? null);
  const changed = after.filter((e) => e.kind !== "spec_excerpt" || after.length <= 2);

  return { requested, built, feedback, changed };
}

// Rule "title": the first sentence of its instruction.
export function ruleTitle(instruction: string): string {
  return firstSentence(instruction) || instruction;
}
