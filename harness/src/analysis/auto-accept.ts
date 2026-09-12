// Round 5 Task 6 / spec §4: decision_mode='automatic' -- accept the
// confident, uncontested proposals a run of proposeRules just wrote,
// without waiting for the owner, and leave the rest exactly where they
// already are (the Inbox). Never touches a retirement proposal (there is no
// automatic path for those -- round-4's decision stands): the candidate ids
// this consumes always come from proposeRules, which never creates one.
//
// "Confident" (spec §4's exact wording, echoed in the Settings help text)
// means: confidence >= decision_auto_confidence, the rule writer flagged no
// duplicate and no contradiction for it, and the accept preconditions the
// "accept" action itself enforces still hold -- the project is under its
// Knowledge character cap and its rule limit. That last check is read off
// the same preview getImprovement/buildImprovement computes for the Inbox's
// own "Add" confirmation (KnowledgePreview.over_cap/over_rules) rather than
// re-implemented here, so automatic mode can never accept something a human
// clicking "Add" would have been blocked from.
import * as store from "../store.js";
import { getImprovement, improvementAction } from "../improvements.js";

export type AutoAcceptResult = { accepted: number; left_for_user: number };

const AUTO_ACTOR = "harness (automatic)";

type RuleWriterFlags = { duplicate_of_rule_id: number | null; contradicts_rule_id: number | null };

// Mirrors improvements.ts's own private ruleWriterOutput reader exactly (the
// rule writer's raw duplicate_of_rule_id/contradicts_rule_id live only in
// agent_actions.structured_output for this candidate, role='rule_writer' --
// see propose.ts's classification_meta and improvements.ts's own doc
// comment on ruleWriterOutput for why there is no dedicated column for
// either). Kept as its own small read here rather than exporting
// improvements.ts's private helper, since this is the only other caller.
function ruleWriterFlags(correctionCandidateId: number): RuleWriterFlags {
  const rows = store.getClassificationHistory(correctionCandidateId) as {
    role: string | null;
    structured_output: string | null;
  }[];
  const row = rows.find((r) => r.role === "rule_writer" && r.structured_output);
  if (!row?.structured_output) return { duplicate_of_rule_id: null, contradicts_rule_id: null };
  try {
    const parsed = JSON.parse(row.structured_output) as {
      duplicate_of_rule_id?: unknown;
      contradicts_rule_id?: unknown;
    };
    return {
      duplicate_of_rule_id:
        typeof parsed.duplicate_of_rule_id === "number" ? parsed.duplicate_of_rule_id : null,
      contradicts_rule_id:
        typeof parsed.contradicts_rule_id === "number" ? parsed.contradicts_rule_id : null,
    };
  } catch {
    return { duplicate_of_rule_id: null, contradicts_rule_id: null };
  }
}

/** True when accepting this candidate at `scope` would exceed the target's
 * Knowledge character cap or its rule limit -- the same two preconditions
 * improvements.ts's stagePendingWrite refuses an "accept" for, read off the
 * same preview (no snapshot yet means neither can be evaluated, so this
 * reads false: the rule is still approved, exactly like a plain accept with
 * no snapshot -- the write is simply staged later, once one exists). */
function wouldExceedLimits(correctionCandidateId: number, scope: "project" | "workspace"): boolean {
  const improvement = getImprovement(correctionCandidateId);
  if (!improvement) return true;
  const preview = improvement.lovable.previews[scope];
  if (!preview) return false;
  return preview.over_cap || preview.over_rules;
}

function tryAutoAccept(correctionCandidateId: number, runId: number, threshold: number): boolean {
  const found = store.getCorrectionCandidate(correctionCandidateId) as {
    correction_candidate: {
      confidence: number | null;
      proposed_scope: "project" | "workspace" | "one_time" | null;
    };
  } | null;
  if (!found) return false;
  const { confidence, proposed_scope } = found.correction_candidate;
  if (confidence == null || confidence < threshold) return false;

  const flags = ruleWriterFlags(correctionCandidateId);
  if (flags.duplicate_of_rule_id != null || flags.contradicts_rule_id != null) return false;

  // propose.ts only ever writes "project" or "workspace" (never "one_time")
  // for a rule-writer-created candidate -- see RULE_WRITER_JSON_SCHEMA's
  // scope enum -- but the type is shared with the human accept path, so it
  // is still narrowed defensively here rather than assumed.
  const scope: "project" | "workspace" = proposed_scope === "workspace" ? "workspace" : "project";
  if (wouldExceedLimits(correctionCandidateId, scope)) return false;

  // Fix round 1 item 3: the whole accept + mark-decided + log sequence is
  // one try/catch, not just the accept itself -- a failure in any of the
  // three (e.g. setCandidateDecidedBy or insertEvent) must still leave this
  // one candidate for the user instead of throwing out of the loop and
  // aborting every candidate after it in this run.
  try {
    improvementAction(
      { action: "accept", id: correctionCandidateId, destination: scope },
      AUTO_ACTOR,
    );
    store.setCandidateDecidedBy(correctionCandidateId, "automatic");
    store.insertEvent("suggestion.auto_accepted", null, {
      id: correctionCandidateId,
      run_id: runId,
      confidence,
      destination: scope,
    });
  } catch {
    return false;
  }
  return true;
}

/**
 * Walks the correction candidates one run of proposeRules just created and,
 * only while decision_mode='automatic', accepts the confident ones
 * (destination = the rule writer's own proposed scope, actor "harness
 * (automatic)") -- everything else (including every candidate when
 * decision_mode='ask') is simply left alone for the Inbox to show, counted
 * as left_for_user. Never throws: a single candidate's accept failing (a
 * precondition or a store error) just leaves that one for the user instead
 * of aborting the rest of the run.
 */
export function autoAcceptProposals(candidateIds: number[], runId: number): AutoAcceptResult {
  let accepted = 0;
  if (candidateIds.length > 0 && store.getSetting("decision_mode") === "automatic") {
    const threshold = Number(store.getSetting("decision_auto_confidence"));
    for (const id of candidateIds) {
      if (tryAutoAccept(id, runId, threshold)) accepted++;
    }
  }
  return { accepted, left_for_user: candidateIds.length - accepted };
}
