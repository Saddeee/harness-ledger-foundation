// The user-facing "Improvement" view (checkpoint C.2 + D): one item per piece
// of Lovable feedback, composed from a correction + its learning/rule + its
// proof plan + its Knowledge write history. Pure reads over store.ts plus a
// small action mapper; no Lovable access. Contracts:
// scratchpad/improvement-contract.md and scratchpad/checkpoint-d-contract.md.
import { z } from "zod";
import * as store from "./store.js";
import { composeManagedKnowledge, sha256 } from "./knowledge.js";
import { lineDiff, type DiffLine } from "./diff.js";
import { recomputeRuleHealth } from "./analysis/health.js";

export type StageKey = "found" | "review" | "proof" | "in_lovable";
export type StageState = "complete" | "current" | "future" | "blocked";
export type Stage = { key: StageKey; state: StageState; note: string | null };
export type Message = {
  id: number;
  author: "you" | "lovable";
  sent_at: string | null;
  text: string;
};
// "cancelled" (a staged write superseded by a later decision, e.g. skip,
// reopen, or switching to test-first) never appears as lovable.write_status
// itself -- buildImprovement's "latest" skips cancelled versions when
// deciding it -- but a version entry in lovable.versions can carry it, so
// the history stays honest about what actually happened.
// "reverted" is likewise synthesized, never a raw DB status: it's what
// lovable.write_status reads when the latest non-cancelled version is a
// WRITTEN restore (restored_from_version_id set) -- the rule it undid is no
// longer live in Lovable, so "written" alone would be a false claim. A
// version entry in lovable.versions still carries its raw DB status
// ("written") plus restored_from_version_id.
export type KnowledgeWriteStatus =
  "none" | "pending" | "written" | "stale" | "failed" | "cancelled" | "reverted";
export type KnowledgePreview = {
  target: "project" | "workspace";
  target_label: string;
  based_on_snapshot_at: string | null;
  current_user_text: string;
  managed_block: string;
  final_content: string;
  char_count: number;
  cap: number;
  over_cap: boolean;
  active_rules_count: number;
  over_rules: boolean;
};
// Task C2 / spec §4b: a retirement proposal for a live rule, shown in the
// Inbox as an item of kind "retire" alongside ordinary improvements. Not a
// correction_candidate -- its id space is negative (id = -proposal_id) so it
// never collides with a real improvement's id; the client's search params
// and action bodies pass it through unchanged (see improvementAction below).
export type RetireReason = "hurt" | "contradiction" | "unused";
export type RetireInfo = {
  proposal_id: number;
  rule_id: number;
  reason: RetireReason;
  health: {
    applicable_tasks: number;
    helped: number;
    hurt: number;
    last_applicable_at: string | null;
  };
  since: string | null;
  // Only set for reason "contradiction": the other live rule's instruction
  // text, for "...because it contradicts <other rule text>."
  contradicts_instruction: string | null;
};

// Task C3 / spec §4 (v1-lite) + §4b (display): the same free, no-LLM
// "since added" counters as RetireInfo.health above, but attached to every
// ordinary improvement whose rule is live (state 'active') -- not just the
// ones a retirement proposal has been raised for. `since` is the rule's own
// first_written_at (see store.listLiveRulesWithTargets), separate from
// `last_applicable_at` (the most recent applicable task, which may be
// long after the write, or null if none yet).
export type ImprovementHealth = {
  applicable_tasks: number;
  helped: number;
  hurt: number;
  last_applicable_at: string | null;
  since: string | null;
  // Round 5 Task 7 / spec §5: the other three (free, human, AI) evidence
  // sources for this same rule, alongside the observed counts above --
  // null when there's nothing recorded yet for that source. `sources` says
  // which of observed/adherence/verdicts have any data at all for this
  // rule (regardless of whether Settings › Evidence has them counted
  // towards retirement) -- what the Details paragraph's "has run for this
  // rule"/"hasn't run for this rule yet" reads.
  verdict: { verdict: store.RuleVerdict; created_at: string } | null;
  adherence: {
    followed: number;
    broke: number;
    not_applicable: number;
    quotes: { verdict: store.AdherenceVerdict; quote: string; created_at: string }[];
  } | null;
  sources: { observed: boolean; adherence: boolean; verdicts: boolean };
};

export type Improvement = {
  id: number;
  // "retire" items come from an open retire_proposals row, not a
  // correction_candidate -- see buildRetireItem. Every existing item is
  // "improvement".
  kind: "improvement" | "retire";
  // When this item was found -- the correction_candidate's created_at for
  // an ordinary improvement, the retire_proposals row's created_at for a
  // retirement proposal. Task C3: the Inbox page's "New" marker compares
  // this against the inbox_last_seen_at setting from before this visit.
  created_at: string;
  project: { id: string; name: string | null };
  title: string;
  proposed_instruction: string | null;
  destination: "workspace" | "project" | "one_time" | null;
  classification: string;
  decision: {
    status: "pending" | "accepted" | "skipped";
    decided_at: string | null;
    divergence: string | null;
    test_first: boolean;
    // True once the rule behind this improvement has been retired --
    // improvementGroup reads this to group the item under "Retired"
    // regardless of its (unrelated, historical) Knowledge write status.
    retired: boolean;
  };
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
  lovable: {
    write_status: KnowledgeWriteStatus;
    written_at: string | null;
    stale_reason: string | null;
    previews: { project: KnowledgePreview | null; workspace: KnowledgePreview | null };
    versions: {
      id: number;
      target: string;
      status: KnowledgeWriteStatus;
      written_at: string | null;
      created_at: string;
      reason: string | null;
      restored_from_version_id: number | null;
    }[];
    untested: boolean;
    // The project's effective "write approved changes automatically" flag
    // (spec §5) -- workspace-destination items still carry the project's own
    // flag (a workspace write happens alongside the project's own Knowledge
    // sync), but the UI only surfaces it for project-destination items.
    auto_write: boolean;
    // Round 6 Task 3 / spec §3: only set once the rule behind this
    // improvement has been retired (decision.retired) -- the write status
    // of retireRule's own removal rewrite (a target-level write, rule_id
    // null, found by its own reason string; see retirementWriteStatus
    // below), never this rule's OWN write history above. Drives whether the
    // card offers Undo (nothing written yet -- the retirement never
    // actually reached Lovable) or Re-add (the removal was written; the
    // rule really is gone from Lovable's Knowledge now). Null for every
    // non-retired item.
    retirement_write_status: KnowledgeWriteStatus | null;
  };
  // Set only for kind "retire"; null for an ordinary improvement.
  retire: RetireInfo | null;
  // Round 5 Task 7 / spec §5.2: the rule this item is about, once one
  // exists -- what the verdict buttons address directly (the same
  // rule_id-addressed convention improvementAction's "verdict"/"retire"
  // cases already use). Null until a rule has been proposed/created for
  // this correction, and for a "retire" item (RetireInfo.rule_id already
  // carries it there).
  rule_id: number | null;
  // Task C3 / spec §4/§4b: set only for kind "improvement" whose rule is
  // live (state 'active') and has a rule_health row yet (recomputeRuleHealth
  // runs after every sync/analysis run -- a brand-new active rule may not
  // have one until the next one). Null otherwise, including for every
  // "retire" item (which carries the equivalent counts under retire.health).
  health: ImprovementHealth | null;
  // Round 5 Task 5 / spec §4: why decision_mode='automatic' didn't accept
  // this one without asking -- only ever set for a pending "improvement"
  // item whose rule was created by the analysis (see computeUnsure below).
  // Always null in decision_mode='ask' (the user decides everything, so
  // nothing is presented as "not sure"), and always null for "retire" items.
  unsure: string | null;
  // Who decided this item: 'user' via the normal review flow, 'automatic'
  // once Round 5 Task 6's auto-accept path decides it without asking, null
  // while still pending. Read straight from correction_candidates.decided_by
  // (Round 5 Task 1's column) -- this task only reads it, Task 6 sets it.
  // Always null for "retire" items (there is no correction_candidate).
  decided_by: "user" | "automatic" | null;
  // Round 5 Task 5 / spec §4: confidence x tag acceptance rate (see
  // computeRank below) -- used only to order pending items in the Inbox
  // (listImprovements sorts by this, descending); every other view keeps
  // whatever order it already had.
  rank: number;
  developer: {
    correction: unknown;
    learning: unknown | null;
    rule: unknown | null;
    classification_history: unknown[];
    hidden_evidence: unknown[];
    verification_plan: unknown | null;
    experiment_plans: unknown[];
    knowledge_versions: unknown[];
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
  created_at: string;
  // Round 5 Task 5: task_episode_id (a plain column of correction_candidates,
  // already present on every row cc.* returns) drives computeRank's tag
  // lookup; confidence and decided_by (Round 5 Task 1's own columns) drive
  // computeRank and the decided_by passthrough respectively.
  task_episode_id: number;
  confidence: number | null;
  decided_by: "user" | "automatic" | null;
};
type RuleRow = {
  id: number;
  instruction: string;
  state: string;
  scope: "workspace" | "project";
  // Round 5 Task 5: the analysis's own actor string ends "(rule writer)"
  // (see propose.ts's createdBy) -- computeUnsure's isAnalysisCreated below
  // checks this to gate "unsure" to analysis-created items only.
  created_by: string;
};
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

// "rolled_back" belongs here too: the user's decision to accept this
// improvement still stands after a restore undoes its Knowledge write --
// only the write itself was reverted, not the decision. Without it, a
// restored item's decision would read back as "pending" (never decided),
// dropping it out of Improvements and back into the Inbox, which is exactly
// the kind of false read Problem 1 is about.
// "retired" belongs here too, for the same reason as "rolled_back": the
// user's original accept decision still stands after a later Retire -- only
// the rule's own live/dead status changed. Without it, a retired rule's
// improvement would read back as "pending" (never decided), which is wrong
// (and would drop it out of Improvements and back into the Inbox).
const ACCEPTED_RULE_STATES = new Set([
  "approved",
  "testing",
  "supported",
  "active",
  "rolled_back",
  "retired",
]);
const PROOF_DONE_RULE_STATES = new Set(["supported", "active"]);
const TARGET_LABEL: Record<"project" | "workspace", string> = {
  project: "This project's Knowledge in Lovable",
  workspace: "Workspace Knowledge — all your projects",
};

function proofOutcome(items: PlanItem[]): "not_run" | "passed" | "failed" | "unclear" | null {
  if (items.length === 0) return null;
  if (items.some((i) => i.status === "failed")) return "failed";
  if (items.some((i) => i.status === "unclear")) return "unclear";
  if (items.every((i) => i.status === "passed")) return "passed";
  return "not_run";
}

// Task C3 / spec §4/§4b: the "since added" line for a live rule. `versions`
// is the rule's own knowledge_versions (already loaded by buildImprovement
// for the Lovable write history), reused here rather than re-querying --
// `since` is the earliest 'written' version's written_at, the same
// first_written_at definition store.listLiveRulesWithTargets uses for
// rule_health's own live-rule scan. Returns null when rule_health hasn't
// scored this rule yet (recomputeRuleHealth runs after every sync/analysis
// run, so a rule that just went active may have no row until the next one).
function computeHealth(
  ruleId: number,
  versions: { status: string; written_at: string | null }[],
): ImprovementHealth | null {
  const row = store.getRuleHealth(ruleId);
  if (!row) return null;
  let since: string | null = null;
  for (const v of versions) {
    if (v.status !== "written" || !v.written_at) continue;
    if (since === null || v.written_at < since) since = v.written_at;
  }

  // Round 5 Task 7 / spec §5: the other three evidence sources, read
  // straight from their own tables -- always present in the payload
  // (turning a source off in Settings › Evidence only changes what can
  // trigger a retirement suggestion, never what's shown).
  const latestVerdict = store.latestRuleVerdict(ruleId);
  const adherenceRows = store.listRuleAdherence(ruleId);
  const counts = adherenceRows.length > 0 ? store.adherenceCounts(ruleId) : null;

  return {
    applicable_tasks: row.applicable_tasks,
    helped: row.helped,
    hurt: row.hurt,
    last_applicable_at: row.last_applicable_at,
    since,
    verdict: latestVerdict
      ? { verdict: latestVerdict.verdict, created_at: latestVerdict.created_at }
      : null,
    adherence: counts
      ? {
          ...counts,
          quotes: adherenceRows
            .filter((r): r is typeof r & { quote: string } => r.quote != null)
            .map((r) => ({ verdict: r.verdict, quote: r.quote, created_at: r.created_at })),
        }
      : null,
    sources: {
      observed: row.applicable_tasks > 0,
      adherence: adherenceRows.length > 0,
      verdicts: latestVerdict != null,
    },
  };
}

// The rules that would be in the managed block for a target if this rule
// were added: the currently active ones plus this one (regardless of its
// current state -- the preview shows what "Add" would write).
function rulesForPreview(target: "project" | "workspace", targetId: string, rule: RuleRow | null) {
  const active = store
    .activeRulesForTarget(target, targetId)
    .map((r) => ({ id: r.id, instruction: r.instruction }));
  if (rule && !active.some((r) => r.id === rule.id))
    active.push({ id: rule.id, instruction: rule.instruction });
  return active;
}

function buildPreview(
  target: "project" | "workspace",
  targetId: string | null,
  rule: RuleRow | null,
): KnowledgePreview | null {
  if (!targetId) return null;
  // Round 6 Task 5: this preview feeds lovable.previews (the Add dialog) --
  // never compose it on a demo snapshot (spec §5).
  const snapshot = store.latestKnowledgeSnapshot(target, targetId, { forWrite: true });
  if (!snapshot) return null;
  // A project target enforces its own effective max (its override, else the
  // global default); a workspace target has no per-project override to
  // consult, so it always uses the global default directly.
  const maxActiveRules =
    target === "project"
      ? store.effectiveMaxActiveRules(targetId)
      : Number(store.getSetting("max_active_rules"));
  const composed = composeManagedKnowledge(
    snapshot.content,
    rulesForPreview(target, targetId, rule),
    maxActiveRules,
  );
  return {
    target,
    target_label: TARGET_LABEL[target],
    based_on_snapshot_at: snapshot.fetched_at,
    current_user_text: composed.user_text,
    managed_block: composed.managed_block,
    final_content: composed.final_content,
    char_count: composed.char_count,
    cap: Number(store.getSetting("knowledge_char_cap")),
    over_cap: composed.over_cap,
    active_rules_count: composed.active_rules_count,
    over_rules: composed.over_rules,
  };
}

// `rates` (fix round 1 item 1): tagAcceptanceRates()'s result, computed once
// by the caller (listImprovements/getImprovement) and threaded through here
// only to feed computeRank -- see computeRank's own doc comment.
function buildImprovement(
  c: CorrectionRow,
  rates: Record<string, { accepted: number; skipped: number }>,
): Improvement {
  const rule = store.getRuleForCorrection(c.id) as RuleRow | null;
  const learning = store.getLearningForCorrection(c.id) as LearningRow | null;
  const { visible, hidden } = store.getEvidenceForCorrection(c.id) as unknown as {
    visible: EvidenceRow[];
    hidden: unknown[];
  };
  const projectMeta = c.project_id ? store.getProjectMeta(c.project_id) : null;
  const workspaceId = projectMeta?.workspace_id ?? null;
  const verificationPlan = rule ? store.getVerificationPlanForRule(rule.id) : null;
  const experimentPlans = rule ? store.listExperimentPlansForRule(rule.id) : [];
  const experiment = (experimentPlans[0] ?? null) as {
    plan: {
      status: string;
      starting_state_quality: string;
      max_permitted_credits: number;
      cleanup_requirements: string;
    };
  } | null;
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

  // ---- Knowledge write history ----
  const versions = rule ? store.listKnowledgeVersions(rule.id) : [];
  // Cancelling a write (skip, reopen, switching to test-first) is not a
  // failure and must not surface as one -- skip cancelled versions when
  // deciding what the rule's Knowledge status currently is. lovable.versions
  // below still lists every version, cancelled ones included.
  const latest = versions.find((v) => v.status !== "cancelled") ?? null;
  // A restore writes a new version whose content undoes an earlier one; once
  // that write is verified, the rule it undid is no longer live in Lovable
  // (see recordKnowledgeReadback), so surfacing it as plain "written" would
  // read as "added" when the true story is the opposite.
  const isRevert = latest?.status === "written" && latest.restored_from_version_id != null;
  const writeStatus: KnowledgeWriteStatus = latest
    ? isRevert
      ? "reverted"
      : latest.status
    : "none";
  const writtenVersion = versions.find((v) => v.status === "written") ?? null;
  const proofComplete =
    outcome === "passed" || (ruleState != null && PROOF_DONE_RULE_STATES.has(ruleState));
  // "Test it first": the rule and its experiment plan are approved, and
  // nothing is staged or written to Knowledge yet -- see
  // ensureApprovedExperimentPlan. A pending version (a real write the
  // executor will apply at the next sync -- e.g. from switching back to a
  // plain accept) or a written one both mean the item has moved on from
  // "waiting to be tested".
  const hasApprovedExperimentPlan = experimentPlans.some(
    (p) => (p as { plan: { status: string } } | null)?.plan.status === "approved",
  );
  const hasPendingVersion = versions.some((v) => v.status === "pending");
  const testFirst = hasApprovedExperimentPlan && !hasPendingVersion && !writtenVersion;

  // ---- stages ----
  const reviewState: StageState =
    status === "skipped" ? "blocked" : status === "accepted" ? "complete" : "current";
  let proofState: StageState;
  if (reviewState !== "complete") proofState = reviewState === "blocked" ? "blocked" : "future";
  else if (
    experiment?.plan.starting_state_quality === "blocked" ||
    experiment?.plan.status === "rejected"
  )
    proofState = "blocked";
  else if (proofComplete) proofState = "complete";
  else if (writeStatus !== "none")
    proofState = "future"; // user chose to add without a proof
  else proofState = "current";

  let inLovableState: StageState;
  let inLovableNote: string;
  if (writeStatus === "written" && ruleState === "active") {
    inLovableState = "complete";
    const d = shortDate(writtenVersion?.verified_at ?? latest?.verified_at ?? null);
    inLovableNote = d ? `Added to Lovable, ${d}` : "Added to Lovable";
  } else if (writeStatus === "pending") {
    inLovableState = "current";
    inLovableNote = "Waiting for Harness to add it";
  } else if (writeStatus === "stale") {
    inLovableState = "blocked";
    inLovableNote = "Knowledge changed in Lovable — review the text again";
  } else if (writeStatus === "failed") {
    inLovableState = "blocked";
    inLovableNote = "Adding failed — see More detail";
  } else {
    inLovableState =
      proofState === "complete" ? "current" : proofState === "blocked" ? "blocked" : "future";
    inLovableNote = "Not in Lovable yet";
  }

  const foundDate = shortDate(visible[0]?.occurred_at ?? null);
  const decidedDate = shortDate(c.reviewed_at);
  const proofNote =
    outcome === "passed"
      ? "Passed"
      : outcome === "failed"
        ? "Failed"
        : outcome === "unclear"
          ? "Unclear"
          : "Not proven yet";

  const stages: Stage[] = [
    {
      key: "found",
      state: "complete",
      note: foundDate ? `Found in your Lovable chat, ${foundDate}` : "Found in your Lovable chat",
    },
    {
      key: "review",
      state: reviewState,
      note:
        status === "skipped"
          ? "Skipped"
          : status === "accepted" && decidedDate
            ? `You decided on ${decidedDate}`
            : status === "accepted"
              ? "You decided"
              : "Waiting for your decision",
    },
    { key: "proof", state: proofState, note: proofNote },
    { key: "in_lovable", state: inLovableState, note: inLovableNote },
  ];
  const stage: StageKey = (stages.find((s) => s.state !== "complete")?.key ??
    "in_lovable") as StageKey;

  // ---- wording history (instruction changes only, oldest first) ----
  const revisions = ((rule
    ? (store.getRule(rule.id) as { revisions: RevisionRow[] } | null)?.revisions
    : []) ?? []) as RevisionRow[];
  const wording_history = [...revisions]
    .reverse()
    .filter((r) => r.previous_instruction !== r.new_instruction)
    .map((r) => ({
      changed_at: r.created_at,
      from: r.previous_instruction,
      to: r.new_instruction,
      reason: r.reason,
    }));

  const title = rule
    ? firstSentence(rule.instruction)
    : learning
      ? firstSentence(learning.desired_behavior)
      : firstSentence(c.summary);

  const health = rule && ruleState === "active" ? computeHealth(rule.id, versions) : null;

  return {
    id: c.id,
    kind: "improvement",
    created_at: c.created_at,
    project: { id: c.project_id ?? "", name: c.project_name ?? null },
    title: title || c.summary,
    proposed_instruction: rule?.instruction ?? null,
    destination: rule ? rule.scope : (c.proposed_scope ?? null),
    classification: c.classification,
    decision: {
      status,
      decided_at: status === "pending" ? null : c.reviewed_at,
      divergence,
      test_first: testFirst,
      retired: ruleState === "retired",
    },
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
            manual_cleanup: experiment
              ? /manual/i.test(experiment.plan.cleanup_requirements)
              : false,
          }
        : null,
    wording_history,
    lovable: {
      write_status: writeStatus,
      written_at: writtenVersion?.verified_at ?? null,
      stale_reason: latest?.status === "stale" ? latest.error : null,
      previews: {
        project: buildPreview("project", c.project_id, rule),
        workspace: buildPreview("workspace", workspaceId, rule),
      },
      versions: versions.map((v) => ({
        id: v.id,
        target: v.target,
        status: v.status,
        written_at: v.verified_at,
        created_at: v.created_at,
        reason: v.reason,
        restored_from_version_id: v.restored_from_version_id,
      })),
      untested: status === "accepted" && !proofComplete,
      auto_write: c.project_id ? store.getProjectSettings(c.project_id).auto_write : true,
      retirement_write_status:
        rule && ruleState === "retired" ? retirementWriteStatus(rule.id) : null,
    },
    retire: null,
    rule_id: rule?.id ?? null,
    health,
    unsure: computeUnsure(c, rule),
    decided_by: c.decided_by ?? null,
    rank: computeRank(c.confidence, store.episodeScopeTags(c.task_episode_id), rates),
    developer: {
      correction: c,
      learning,
      rule,
      classification_history: store.getClassificationHistory(c.id),
      hidden_evidence: hidden,
      verification_plan: verificationPlan,
      experiment_plans: experimentPlans,
      knowledge_versions: versions,
      audit_events: [
        ...store.listEventsForRecord(["correction_candidate."], c.id),
        ...(rule ? store.listEventsForRecord(["rule."], rule.id) : []),
      ],
    },
  };
}

// Task C2: renders one open retire_proposals row as a pending Inbox item.
// Reads from store.listLiveRulesWithTargets (the same live-rule shape
// health.ts scores) rather than the correction/rule chain a normal
// improvement builds from -- a retirement proposal is about the rule as it
// stands today, not the correction that originally created it. Returns null
// for a proposal whose rule somehow isn't live any more (e.g. retired or
// rejected by another path between the proposal being written and this
// read) rather than throwing -- listImprovements filters these out.
function buildRetireItem(
  proposal: store.RetireProposalRow,
  rates: Record<string, { accepted: number; skipped: number }>,
): Improvement | null {
  const live = store.listLiveRulesWithTargets().find((r) => r.id === proposal.rule_id);
  if (!live) return null;

  const health = store.getRuleHealth(proposal.rule_id);
  const projectId = live.project_id ?? "";
  const projectName =
    live.scope === "workspace"
      ? "Workspace"
      : projectId
        ? (store.getProjectMeta(projectId)?.name ?? projectId)
        : projectId;

  const evidenceRows =
    proposal.reason === "hurt" ? store.listHistoryItemsByIds(proposal.evidence) : [];

  const contradictsInstruction =
    proposal.reason === "contradiction" && proposal.evidence[0] != null
      ? ((store.getRule(proposal.evidence[0]) as { rule: { instruction: string } } | null)?.rule
          .instruction ?? null)
      : null;

  return {
    id: -proposal.id,
    kind: "retire",
    created_at: proposal.created_at,
    project: { id: projectId, name: projectName },
    title: `Retire: ${live.instruction}`,
    proposed_instruction: null,
    destination: live.scope,
    classification: "retire",
    decision: {
      status: "pending",
      decided_at: null,
      divergence: null,
      test_first: false,
      retired: false,
    },
    stage: "review",
    stages: [],
    evidence: evidenceRows.map((e) => ({
      id: e.id,
      author: e.role === "user" ? "you" : "lovable",
      sent_at: e.occurred_at,
      text: e.content,
    })),
    proof: null,
    wording_history: [],
    lovable: {
      write_status: "none",
      written_at: null,
      stale_reason: null,
      previews: { project: null, workspace: null },
      versions: [],
      untested: false,
      auto_write: true,
      retirement_write_status: null,
    },
    retire: {
      proposal_id: proposal.id,
      rule_id: proposal.rule_id,
      reason: proposal.reason,
      health: health
        ? {
            applicable_tasks: health.applicable_tasks,
            helped: health.helped,
            hurt: health.hurt,
            last_applicable_at: health.last_applicable_at,
          }
        : { applicable_tasks: 0, helped: 0, hurt: 0, last_applicable_at: null },
      since: live.first_written_at,
      contradicts_instruction: contradictsInstruction,
    },
    rule_id: proposal.rule_id,
    health: null,
    // Round 5 Task 5: a retire proposal has no correction_candidate -- never
    // "unsure" (that's an analysis-mined-improvement concept only) and never
    // decided_by a candidate that doesn't exist. Ranked with computeRank's
    // own neutral defaults (see its doc comment) so it still sorts among the
    // rest of the pending items.
    unsure: null,
    decided_by: null,
    rank: computeRank(null, ["general"], rates),
    developer: {
      correction: null,
      learning: null,
      rule: live,
      classification_history: [],
      hidden_evidence: [],
      verification_plan: null,
      experiment_plans: [],
      knowledge_versions: [],
      audit_events: store.listEventsForRecord(["retire_proposal."], proposal.id),
    },
  };
}

export function listImprovements(): Improvement[] {
  // Fix round 1 item 1: computed ONCE for the whole list, not once per item
  // -- see computeRank's doc comment for why a per-item call would be
  // wasteful (tagAcceptanceRates() scans every reviewed candidate).
  const rates = store.tagAcceptanceRates();
  const improvements = (store.listCorrectionCandidates() as unknown as CorrectionRow[]).map((c) =>
    buildImprovement(c, rates),
  );
  const retirements = store
    .listOpenRetireProposals()
    .map((proposal) => buildRetireItem(proposal, rates))
    .filter((item): item is Improvement => item !== null);
  // Round 5 Task 5 / spec §4: pending items ranked highest-first (see
  // sortForInbox below); everything already decided keeps this same order
  // it always had.
  return sortForInbox([...improvements, ...retirements]);
}

export function getImprovement(id: number): Improvement | null {
  const row = (store.listCorrectionCandidates() as unknown as CorrectionRow[]).find(
    (c) => c.id === id,
  );
  // Fix round 1 item 1: a single lookup, so a single tagAcceptanceRates()
  // call here is not the loop the original per-item computeRank call was --
  // still computed once, same as listImprovements above, for consistency.
  return row ? buildImprovement(row, store.tagAcceptanceRates()) : null;
}

const ACTOR = "operator (local UI)";
const actionInput = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("accept"),
    id: z.number().int(),
    destination: z.enum(["workspace", "project", "skill"]),
    test_first: z.boolean().optional(),
  }),
  z.object({
    action: z.literal("skip"),
    id: z.number().int(),
    // Round 5 Task 5 / spec §4b: the optional "why" from SkipConfirm's "Why?
    // (optional)" radiogroup -- mirrors store.SkipReason exactly.
    reason: z.enum(["not_useful", "wrong_wording", "one_time", "already_covered"]).optional(),
  }),
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
  z.object({ action: z.literal("restore"), id: z.number().int(), version_id: z.number().int() }),
  // Task C2 / spec §4b-§5. "retire": either `id` (a retire-proposal item's
  // id, always negative: -proposal_id -- see buildRetireItem) or `rule_id`
  // (the manual path, from the Instructions page's per-rule Retire button,
  // with no proposal necessarily open). "keep" always takes a proposal's
  // negative id. "readd" takes the original improvement's (correction
  // candidate's) id, same convention as every other action above.
  z.object({
    action: z.literal("retire"),
    id: z.number().int().optional(),
    rule_id: z.number().int().optional(),
  }),
  z.object({ action: z.literal("keep"), id: z.number().int() }),
  z.object({ action: z.literal("readd"), id: z.number().int() }),
  // Round 5 Task 3 / spec §5.2: a whole-rule verdict from the Instructions
  // page's verdict buttons -- addressed by rule_id directly (there is no
  // single correction_candidate id that must exist for this to make sense),
  // the same convention as "retire"'s rule_id path above.
  z.object({
    action: z.literal("verdict"),
    rule_id: z.number().int(),
    verdict: z.enum(["helped", "did_not_help", "not_sure"]),
    note: z.string().max(2000).optional(),
  }),
  // ---- Round 6 Task 3 ----
  z.object({ action: z.literal("undo"), id: z.number().int() }),
  z.object({ action: z.literal("cancel_write"), version_id: z.number().int() }),
  // ---- end Round 6 Task 3 ----
]);

// After the user approves "Add", stage the exact write for the executor --
// only when a snapshot of the live Knowledge exists to compose from.
function stagePendingWrite(
  improvement: Improvement,
  rule: RuleRow,
  target: "project" | "workspace",
  reason?: string,
) {
  // Round 6 Task 5: a demo rule's retire/re-add/restore is accepted but
  // never stages a write (spec §5) -- there is no real decision to compose.
  if (rule.created_by === "demo") return;
  const preview = improvement.lovable.previews[target];
  if (!preview) return;
  if (preview.over_cap)
    throw new Error(
      "This would exceed the Knowledge limit — shorten the instruction or your existing Knowledge first",
    );
  if (preview.over_rules)
    throw new Error(
      `This project already has ${preview.active_rules_count} active rules — retire one on the Instructions page first`,
    );
  const snapshot = store.latestKnowledgeSnapshot(
    target,
    target === "project"
      ? improvement.project.id
      : (store.getProjectMeta(improvement.project.id)?.workspace_id ?? ""),
    { forWrite: true },
  );
  if (!snapshot) return;
  store.cancelPendingKnowledgeWrites(rule.id, "superseded by a newer decision");
  const ruleIds = rulesForPreview(
    target,
    target === "project"
      ? improvement.project.id
      : (store.getProjectMeta(improvement.project.id)?.workspace_id ?? ""),
    rule,
  ).map((r) => r.id);
  store.createPendingKnowledgeVersion({
    rule_id: rule.id,
    target,
    ...(target === "project"
      ? { project_id: improvement.project.id }
      : { workspace_id: store.getProjectMeta(improvement.project.id)?.workspace_id ?? undefined }),
    previous_content: snapshot.content,
    new_content: preview.final_content,
    rule_ids: ruleIds,
    actor: ACTOR,
    reason: reason ?? `user chose "${preview.target_label}" in the Inbox`,
  });
}

// After the user approves "Test it first", the rule is approved but no
// Knowledge write is staged -- instead, its experiment plan is approved so
// the plan is ready to run. A rule may already have a plan (e.g. from an
// earlier proof pass); reuse and approve it rather than creating a second
// one. Only a "proposed" plan is moved to "approved" here -- a rejected
// plan is left alone.
function ensureApprovedExperimentPlan(rule: RuleRow, improvement: Improvement) {
  const plans = store.listExperimentPlansForRule(rule.id) as unknown as {
    plan: { id: number; status: string };
  }[];
  const existing = plans[0] ?? null;
  if (existing) {
    if (existing.plan.status === "proposed")
      store.setExperimentPlanStatus(existing.plan.id, "approved", ACTOR);
    return;
  }
  const exactPrompt = improvement.evidence.find((e) => e.author === "you")?.text ?? "";
  const created = store.createExperimentPlan({
    rule_id: rule.id,
    source_project_id: improvement.project.id,
    experiment_type: "paired_control_treatment",
    starting_state_quality: "historical_only",
    control_configuration:
      "Not yet defined — saved for testing before a full experiment plan is written.",
    treatment_configuration:
      "Not yet defined — saved for testing before a full experiment plan is written.",
    exact_prompt: exactPrompt,
    protected_checks: "[]",
    estimated_credits: 0,
    max_permitted_credits: 0,
    resource_strategy: "Not yet defined.",
    cleanup_requirements: "Not yet defined.",
    risks: "Not yet defined.",
    success_conditions: "Not yet defined.",
    inconclusive_conditions: "Not yet defined.",
    stop_conditions: "Not yet defined.",
    created_by: "owner via UI",
    verification_definition_ids: [],
  }) as { id: number };
  store.setExperimentPlanStatus(created.id, "approved", ACTOR);
}

// Writes accepted before Harness had ever read the live Knowledge: at accept
// time `stagePendingWrite` had no snapshot to compose against and returned
// without staging anything, so the improvement sat in "Waiting to be written"
// with no pending version. The executor calls this after the snapshot beats,
// when a snapshot does exist, and stages exactly what accept would have.
export function stageApprovedWrites(): { staged: number; skipped: number } {
  let staged = 0;
  let skipped = 0;
  for (const improvement of listImprovements()) {
    if (improvement.decision.status !== "accepted") continue;
    if (improvement.decision.test_first) continue;
    const target = improvement.destination;
    if (target !== "project" && target !== "workspace") continue;
    const rule = store.getRuleForCorrection(improvement.id) as RuleRow | null;
    if (!rule || rule.state !== "approved") continue;
    // Cancelled/stale/failed versions do not count as "already handled" --
    // only a live pending write or a completed one does.
    const versions = store.listKnowledgeVersions(rule.id);
    if (versions.some((v) => v.status === "pending" || v.status === "written")) continue;

    const preview = improvement.lovable.previews[target];
    if (!preview || preview.over_cap || preview.over_rules) {
      skipped += 1;
      continue;
    }
    stagePendingWrite(improvement, rule, target, "staged by the executor after Knowledge was read");
    staged += 1;
  }
  return { staged, skipped };
}

// Task C2 "Retire": sets the rule retired, cancels anything still staged for
// it, recomposes its target's managed block without it and stages that as a
// new pending Knowledge version, and decides the open proposal (if any).
// Returns the ORIGINAL improvement (the rule's correction candidate), now
// grouped "Retired" -- not a synthetic item, since after this the proposal
// (if it came from one) no longer exists as an open Inbox item.
//
// The recompose write's rule_id is deliberately null, not this rule's id:
// recordKnowledgeReadback (store.ts) sets `state: "active"` on a written
// version's rule_id once the executor confirms the write, which would
// silently un-retire this rule the moment the recompose lands. null makes
// it a plain target-level write, exactly like any other Knowledge sync.
function retireRule(ruleId: number): Improvement {
  const wrapped = store.getRule(ruleId) as { rule: RuleRow } | null;
  if (!wrapped) throw new Error(`rule ${ruleId} not found`);
  const rule = wrapped.rule;
  const proposal = store.openRetireProposalForRule(ruleId);

  store.updateRule({
    id: ruleId,
    state: "retired",
    actor: ACTOR,
    reason: proposal ? `retired: ${proposal.reason}` : "retired manually",
  });
  store.cancelPendingKnowledgeWrites(ruleId, "cancelled: rule retired");

  const correctionId = store.getCorrectionIdForRule(ruleId);
  if (correctionId == null) throw new Error(`rule ${ruleId} has no linked improvement`);
  const original = getImprovement(correctionId);
  const target = rule.scope;
  const targetId =
    target === "project"
      ? (original?.project.id ?? null)
      : original?.project.id
        ? (store.getProjectMeta(original.project.id)?.workspace_id ?? null)
        : null;

  // Round 6 Task 5: a demo rule's retire stages nothing -- this is exactly
  // the poisoned recompose from spec §0 (rule_id: null, rule_ids_json
  // naming demo rules) if left unguarded. forWrite: true also keeps a REAL
  // rule's retire recompose off a demo snapshot recorded under this same
  // target id.
  if (targetId && rule.created_by !== "demo") {
    const snapshot = store.latestKnowledgeSnapshot(target, targetId, { forWrite: true });
    // No snapshot yet to compose against -- nothing staged; the rule is
    // still retired and the proposal still decided, same as a normal
    // accept before Harness has ever read Knowledge (stagePendingWrite).
    if (snapshot) {
      const activeRules = store.activeRulesForTarget(target, targetId) as {
        id: number;
        instruction: string;
      }[];
      const maxActiveRules =
        target === "project"
          ? store.effectiveMaxActiveRules(targetId)
          : Number(store.getSetting("max_active_rules"));
      const composed = composeManagedKnowledge(
        snapshot.content,
        activeRules.map((r) => ({ id: r.id, instruction: r.instruction })),
        maxActiveRules,
      );
      store.createPendingKnowledgeVersion({
        rule_id: null,
        target,
        ...(target === "project" ? { project_id: targetId } : { workspace_id: targetId }),
        previous_content: snapshot.content,
        new_content: composed.final_content,
        rule_ids: activeRules.map((r) => r.id),
        actor: ACTOR,
        reason: `retired rule ${ruleId}`,
      });
    }
  }

  if (proposal) store.decideRetireProposal(proposal.id, "retired");

  const refreshed = getImprovement(correctionId);
  if (!refreshed)
    throw new Error(`improvement ${correctionId} not found after retiring rule ${ruleId}`);
  return refreshed;
}

// Task C2 "Keep": acknowledges the signal without acting on it, snoozing it
// for 30 days (store.snoozeRuleHealth upserts a rule_health row if one
// doesn't exist yet, so this never throws even for a brand-new rule).
const KEEP_SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;

function keepProposal(proposalId: number): Improvement {
  const proposal = store.getRetireProposal(proposalId);
  if (!proposal) throw new Error(`retire proposal ${proposalId} not found`);
  store.decideRetireProposal(proposalId, "kept");
  store.snoozeRuleHealth(proposal.rule_id, new Date(Date.now() + KEEP_SNOOZE_MS).toISOString());

  const correctionId = store.getCorrectionIdForRule(proposal.rule_id);
  const refreshed = correctionId != null ? getImprovement(correctionId) : null;
  if (!refreshed) throw new Error(`improvement for rule ${proposal.rule_id} not found after keep`);
  return refreshed;
}

// Round 5 Task 6 / spec §4: `actor` overrides ACTOR for the "accept" case's
// own recordHumanCorrectionDecision/updateRule calls only -- autoAcceptProposals
// (harness/src/analysis/auto-accept.ts) passes "harness (automatic)" so the
// accept is attributed correctly wherever these two calls already made it
// visible (the human_decision_recorded event's reviewer field, and the
// rule_revisions/rule.scope_changed actor). Every other action, and every
// other call inside "accept" itself (setRuleEvidenceLevel, the experiment
// plan status calls), still uses the plain ACTOR -- the brief scopes this to
// exactly those two calls, not a blanket "who is calling" override.
export function improvementAction(input: unknown, actor: string = ACTOR): Improvement {
  const a = actionInput.parse(input);

  // "retire"/"keep" address a retire-proposal id (always negative) or a
  // rule_id directly -- neither is a correction_candidate id, so they must
  // be resolved before the generic getImprovement/getRuleForCorrection
  // lookup below (which every other action uses).
  if (a.action === "retire") {
    let ruleId: number;
    if (a.rule_id !== undefined) {
      ruleId = a.rule_id;
    } else if (a.id !== undefined) {
      const proposalId = -a.id;
      const proposal = store.getRetireProposal(proposalId);
      if (!proposal) throw new Error(`retire proposal ${proposalId} not found`);
      ruleId = proposal.rule_id;
    } else {
      throw new Error("retire requires an id (a retire proposal) or a rule_id");
    }
    return retireRule(ruleId);
  }
  if (a.action === "keep") {
    return keepProposal(-a.id);
  }
  // "verdict" (Round 5 Task 3) addresses a rule_id directly too, same reason
  // as "retire"'s rule_id path -- see recordVerdict in the delimited block
  // at the end of this file.
  if (a.action === "verdict") {
    return recordVerdict(a.rule_id, a.verdict, a.note);
  }
  // Round 6 Task 3 / spec §3: "cancel_write" (the Instructions page's
  // pending-write banner) addresses a knowledge_versions id directly, not a
  // correction_candidate -- see cancelPendingVersion in the delimited block
  // at the end of this file.
  if (a.action === "cancel_write") {
    return cancelPendingVersion(a.version_id);
  }

  const current = getImprovement(a.id);
  if (!current) throw new Error(`improvement ${a.id} not found`);
  const rule = store.getRuleForCorrection(a.id) as RuleRow | null;

  switch (a.action) {
    case "accept": {
      if (a.destination === "skill")
        throw new Error(
          "Adding as a Skill isn't available yet — choose this project's Knowledge or Workspace Knowledge",
        );
      const destination = a.destination;
      store.recordHumanCorrectionDecision({
        id: a.id,
        final_classification: current.classification as never,
        reusable: true,
        proposed_scope: destination,
        reviewer: actor,
      });
      // Round 5 Task 6 / spec §4: who decided this -- 'user' for this plain
      // accept path; autoAcceptProposals overwrites it to 'automatic' right
      // after calling this same action with actor="harness (automatic)"
      // (see auto-accept.ts), so the final value on record is always
      // whichever one actually decided.
      store.setCandidateDecidedBy(a.id, "user");
      if (rule) {
        store.updateRule({ id: rule.id, state: "approved", scope: destination, actor });
        // Added without a completed proof: grounded in the user's own decision only.
        if (!(current.proof?.outcome === "passed"))
          store.setRuleEvidenceLevel(rule.id, "human_grounded", ACTOR);
        if (a.test_first) {
          // Test it first: approve the rule and its experiment plan, but
          // stage no Knowledge write -- nothing is written until the test
          // runs (and the user later accepts for real). Cancel any write
          // that was already staged from an earlier plain accept, so the
          // executor never writes what the user just switched away from.
          store.cancelPendingKnowledgeWrites(rule.id, "cancelled: switched to test-first");
          ensureApprovedExperimentPlan({ ...rule, scope: destination, state: "approved" }, current);
        } else {
          // "Add it now" withdraws an earlier "Test it first" request. If
          // the rule's experiment plan is still approved and nothing has
          // ever been written for this rule, put the plan back to proposed
          // -- otherwise decision.test_first keeps reading true (see
          // ensureApprovedExperimentPlan / the testFirst derivation above)
          // even though the user just chose to add it now. This matters
          // most when no Knowledge snapshot exists yet: stagePendingWrite
          // below then has nothing to compose against and stages no write,
          // so without this, the item would sit at test_first: true forever
          // and stageApprovedWrites (which skips test_first items) would
          // never pick it up once a snapshot finally arrives.
          const plans = store.listExperimentPlansForRule(rule.id) as unknown as {
            plan: { id: number; status: string };
          }[];
          const hasWrittenVersion = store
            .listKnowledgeVersions(rule.id)
            .some((v) => v.status === "written");
          if (!hasWrittenVersion)
            for (const p of plans)
              if (p.plan.status === "approved")
                store.setExperimentPlanStatus(p.plan.id, "proposed", ACTOR);

          const refreshedForPreview = getImprovement(a.id);
          if (refreshedForPreview)
            stagePendingWrite(
              refreshedForPreview,
              { ...rule, scope: destination, state: "approved" },
              destination,
            );
        }
      }
      break;
    }
    case "skip":
      store.reviewCorrectionCandidate({ id: a.id, action: "exclude", reviewer: ACTOR });
      // Round 5 Task 5 / spec §4b: independent of the exclude review action
      // above (setCandidateSkipReason's own doc comment) -- always called,
      // clearing any earlier reason when none was chosen this time.
      store.setCandidateSkipReason(a.id, a.reason ?? null);
      if (rule) {
        store.cancelPendingKnowledgeWrites(rule.id, "cancelled: improvement skipped");
        store.updateRule({ id: rule.id, state: "rejected", actor: ACTOR });
      }
      break;
    case "reopen":
      store.reviewCorrectionCandidate({ id: a.id, action: "include", reviewer: ACTOR });
      if (rule) {
        store.cancelPendingKnowledgeWrites(rule.id, "cancelled: decision reopened");
        store.updateRule({ id: rule.id, state: "proposed", actor: ACTOR });
      }
      break;
    case "change_wording":
      if (!rule) throw new Error("This improvement has no rule wording to change yet");
      store.cancelPendingKnowledgeWrites(rule.id, "cancelled: wording changed after approval");
      store.updateRule({
        id: rule.id,
        instruction: a.instruction,
        actor: ACTOR,
        ...(a.reason ? { reason: a.reason } : {}),
      });
      break;
    case "set_destination":
      if (a.destination === "one_time") {
        store.reviewCorrectionCandidate({ id: a.id, action: "mark_one_time", reviewer: ACTOR });
      } else {
        store.reviewCorrectionCandidate({
          id: a.id,
          action: "change_scope",
          proposed_scope: a.destination,
          reviewer: ACTOR,
        });
        if (rule) store.updateRule({ id: rule.id, scope: a.destination, actor: ACTOR });
      }
      break;
    case "restore": {
      if (!rule) throw new Error("This improvement has no rule to restore");
      const version = store.getKnowledgeVersion(a.version_id);
      if (!version || version.rule_id !== rule.id)
        throw new Error(`knowledge version ${a.version_id} does not belong to this improvement`);
      // Round 6 Task 5: a demo rule's restore is accepted but stages nothing.
      if (rule.created_by !== "demo") store.createRestoreVersion(a.version_id, ACTOR);
      break;
    }
    case "readd": {
      // Task C2 "Re-add": the inverse of Retire, from a decided ("Retired")
      // improvement's own id -- approve the rule again and stage the write
      // the normal accept path would have staged.
      if (!rule) throw new Error("This improvement has no rule to re-add");
      store.updateRule({ id: rule.id, state: "approved", actor: ACTOR });
      // Round 5 Task 3: a durable, queryable record of the re-add itself --
      // updateRule's own "rule.updated" event only carries previous/new
      // state, not a stable "this was a re-add" marker, and the History
      // timeline (buildTimeline below) needs one to render "Re-added".
      store.insertEvent("rule.readded", null, { id: rule.id });
      // Fix wave item 4: reset the health window -- whatever hurt/
      // contradicted this rule before it was retired must not count against
      // it again now that it's live again (health.ts's recomputeRuleHealth
      // uses max(first_written_at, baseline_at) as the window start).
      store.rebaselineRuleHealth(rule.id, new Date().toISOString());
      const refreshedForPreview = getImprovement(a.id);
      if (refreshedForPreview)
        stagePendingWrite(
          refreshedForPreview,
          { ...rule, state: "approved" },
          rule.scope,
          `re-added rule ${rule.id}`,
        );
      break;
    }
    // ---- Round 6 Task 3 ----
    // "Undo": a plain, no-dialog reversal of any decided-but-unwritten item
    // (spec §3). Reopen semantics (rule back to "proposed", staged write
    // cancelled, decision pending) for the ordinary case; for a rule that
    // was retired but whose removal was never actually written to Lovable,
    // there is nothing to "review" again -- the rule is still live exactly
    // as it was, so Undo instead brings it straight back to "active" and
    // cancels the not-yet-written removal rewrite (undoRetirement, in the
    // delimited block at the end of this file). Refused, with a clear
    // reason, once the rule (or its removal) really has been written --
    // "Remove from Knowledge" / "Re-add" are the levers from there.
    case "undo": {
      // Same "no rule yet" tolerance as "reopen" above -- a correction can
      // be skipped before any rule exists for it (rule-writing hasn't run
      // yet), and Undo must reopen that just as plainly.
      if (rule && current.decision.retired) {
        if (retirementWriteStatus(rule.id) === "written") {
          throw new Error(
            "This rule was already removed from Lovable — Undo isn't available; use Re-add instead.",
          );
        }
        undoRetirement(rule.id);
        break;
      }
      if (
        rule &&
        (current.lovable.write_status === "written" || current.lovable.write_status === "reverted")
      ) {
        throw new Error(
          "This rule is already written to Lovable — Undo isn't available; use Remove from Knowledge instead.",
        );
      }
      store.reviewCorrectionCandidate({ id: a.id, action: "include", reviewer: ACTOR });
      if (rule) {
        store.cancelPendingKnowledgeWrites(rule.id, "cancelled: undone");
        store.updateRule({ id: rule.id, state: "proposed", actor: ACTOR });
      }
      break;
    }
    // ---- end Round 6 Task 3 ----
  }
  const refreshed = getImprovement(a.id);
  if (!refreshed) throw new Error(`improvement ${a.id} not found after update`);
  return refreshed;
}

// ---- Round 5 Task 3 ----
// The History page's timeline (spec §3b): every Knowledge write Harness
// made for a target, every change Lovable saw that Harness didn't make,
// every accept/skip/retire/keep/re-add decision behind a rule that belongs
// to the target, every Skill change (workspace targets only), and every
// whole-rule verdict -- merged into one feed, newest first. Pure reads over
// store.ts; nothing here writes Knowledge or talks to Lovable. Also: the
// "verdict" improvement action (spec §5.2), which the Instructions page's
// per-rule "did this help" buttons call.

export type TimelineChanges = {
  added: number;
  removed: number;
  lines: DiffLine[];
  truncated: boolean;
};

export type TimelineNode = {
  id: string;
  kind: "version" | "external_change" | "decision" | "skill" | "verdict";
  at: string;
  label: string;
  actor: "you" | "harness" | "lovable";
  summary: string | null;
  content: string | null;
  diff: TimelineChanges | null;
  rule_ids: number[];
  restored_from: number | null;
  improvement_id: number | null;
  version_id: number | null;
  restorable: boolean;
};

const TIMELINE_MAX_DIFF_LINES = 400;
// The History page caps how much it ever shows at once, same spirit as the
// Instructions page's "What changed" diff cap just below.
const TIMELINE_MAX_NODES = 200;

function timelineDiff(before: string, after: string): TimelineChanges {
  const d = lineDiff(before, after);
  const truncated = d.lines.length > TIMELINE_MAX_DIFF_LINES;
  return {
    added: d.added,
    removed: d.removed,
    lines: truncated ? d.lines.slice(0, TIMELINE_MAX_DIFF_LINES) : d.lines,
    truncated,
  };
}

// datetime('now') timestamps ("YYYY-MM-DD HH:MM:SS") and
// correction_candidates.reviewed_at (a plain JS `new Date().toISOString()`,
// "YYYY-MM-DDTHH:MM:SS.sssZ" -- see reviewCorrectionCandidate in store.ts)
// are NOT the same shape, so plain string comparison sorts them wrong (a
// space sorts before "T"). shortDate above already parses both; reuse the
// same trick here rather than a raw string comparison.
function timelineAtMs(at: string): number {
  const d = new Date(at.includes("T") ? at : at.replace(" ", "T") + "Z");
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

function timelineActor(raw: string): "you" | "harness" | "lovable" {
  return /harness/i.test(raw) ? "harness" : "you";
}

function versionLabel(v: {
  status: store.KnowledgeWriteStatus;
  restored_from_version_id: number | null;
}): string {
  switch (v.status) {
    case "pending":
      return "Staged";
    case "stale":
      return "Needs attention";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "written":
      return v.restored_from_version_id != null
        ? `Restored to version #${v.restored_from_version_id}`
        : "Written to Lovable";
  }
}

function parseRuleIds(json: string): number[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((n): n is number => typeof n === "number") : [];
  } catch {
    return [];
  }
}

const VERDICT_LABEL: Record<store.RuleVerdict, string> = {
  helped: "You said this rule helped",
  did_not_help: "You said this rule didn't help",
  not_sure: "You said you're not sure this rule helped",
};

type CorrectionDecisionRow = {
  id: number;
  reviewed: number;
  reviewed_at: string | null;
  excluded_from_learning: number;
  decided_by: string | null;
  confidence: number | null;
};

// version/external_change/decision/skill/verdict nodes for one target,
// newest first, capped at TIMELINE_MAX_NODES. See the block comment above
// for what each source table contributes.
export function buildTimeline(target: "project" | "workspace", targetId: string): TimelineNode[] {
  const nodes: TimelineNode[] = [];
  const ruleIds = new Set<number>();

  // ---- version nodes: knowledge_versions for this target, oldest first so
  // each one's diff can be computed against the immediately preceding
  // version node (not the version's own stored previous_content, which may
  // not be what the timeline showed as the prior version's content) ----
  const versionsForTarget = (store.listKnowledgeVersions() as store.KnowledgeVersionRow[])
    .filter(
      (v) =>
        v.target === target &&
        (target === "project" ? v.project_id === targetId : v.workspace_id === targetId),
    )
    .sort((a, b) => timelineAtMs(a.created_at) - timelineAtMs(b.created_at));

  const newestWrittenId = versionsForTarget
    .filter((v) => v.status === "written")
    .reduce<number | null>((max, v) => (max === null || v.id > max ? v.id : max), null);

  let prevVersionContent: string | null = null;
  for (const v of versionsForTarget) {
    if (v.rule_id != null) ruleIds.add(v.rule_id);
    const versionRuleIds = parseRuleIds(v.rule_ids_json);
    for (const rid of versionRuleIds) ruleIds.add(rid);

    let diff: TimelineChanges | null = null;
    let summary: string | null;
    if (prevVersionContent != null) {
      const d = timelineDiff(prevVersionContent, v.new_content);
      diff = d;
      summary = `+${d.added} −${d.removed} lines`;
    } else {
      // The very first version this target ever had: there is no earlier
      // version node to diff against, so describe it by what it added
      // instead of a line count.
      summary = `${versionRuleIds.length} rule${versionRuleIds.length === 1 ? "" : "s"} added`;
    }

    nodes.push({
      id: `version:${v.id}`,
      kind: "version",
      at: v.created_at,
      label: versionLabel(v),
      actor: timelineActor(v.actor),
      summary,
      content: v.new_content,
      diff,
      rule_ids: versionRuleIds,
      restored_from: v.restored_from_version_id,
      improvement_id: null,
      version_id: v.id,
      restorable: v.status === "written" && v.id !== newestWrittenId,
    });
    prevVersionContent = v.new_content;
  }

  // ---- external_change nodes: knowledge_snapshots for this target, oldest
  // first -- a snapshot whose content differs from both the previous
  // snapshot's and every version's new_content was a change Lovable saw
  // that Harness itself never wrote ----
  const versionShas = new Set(versionsForTarget.map((v) => sha256(v.new_content)));
  const snapshots = store.listKnowledgeSnapshots(target, targetId);
  let prevSnapshotSha: string | null = null;
  snapshots.forEach((s, i) => {
    const shaNow = sha256(s.content);
    if (i > 0 && shaNow !== prevSnapshotSha && !versionShas.has(shaNow)) {
      nodes.push({
        id: `external_change:${s.id}`,
        kind: "external_change",
        at: s.fetched_at,
        label: "Changed in Lovable (outside Harness)",
        actor: "lovable",
        summary: null,
        content: s.content,
        diff: null,
        rule_ids: [],
        restored_from: null,
        improvement_id: null,
        version_id: null,
        restorable: false,
      });
    }
    prevSnapshotSha = shaNow;
  });

  // ---- rules for this target: activeRulesForTarget ∪ retiredRulesForTarget
  // ∪ every rule any of the versions above belongs to (ruleIds already has
  // that third set from the version loop) ----
  for (const r of store.activeRulesForTarget(target, targetId) as { id: number }[])
    ruleIds.add(r.id);
  for (const r of store.retiredRulesForTarget(target, targetId) as { id: number }[])
    ruleIds.add(r.id);

  for (const ruleId of ruleIds) {
    const wrapped = store.getRule(ruleId) as { rule: { instruction: string } } | null;
    const instruction = wrapped?.rule.instruction ?? "";
    const correctionId = store.getCorrectionIdForRule(ruleId);

    // ---- decision nodes: accept/skip, from correction_candidates ----
    if (correctionId != null) {
      const found = store.getCorrectionCandidate(correctionId) as {
        correction_candidate: CorrectionDecisionRow;
      } | null;
      const cc = found?.correction_candidate;
      if (cc && cc.reviewed === 1 && cc.reviewed_at) {
        const skipped = cc.excluded_from_learning === 1;
        const label = skipped
          ? "You skipped"
          : cc.decided_by === "automatic"
            ? `Accepted automatically (confidence ${(cc.confidence ?? 0).toFixed(2)})`
            : "You accepted";
        nodes.push({
          id: `decision:cc-${cc.id}`,
          kind: "decision",
          at: cc.reviewed_at,
          label,
          actor: skipped || cc.decided_by !== "automatic" ? "you" : "harness",
          summary: instruction,
          content: instruction,
          diff: null,
          rule_ids: [ruleId],
          restored_from: null,
          improvement_id: correctionId,
          version_id: null,
          restorable: false,
        });
      }
    }

    // ---- decision nodes: retire_proposals (created, and once decided) ----
    for (const rp of store.listRetireProposalsForRule(ruleId)) {
      nodes.push({
        id: `decision:rp-${rp.id}-created`,
        kind: "decision",
        at: rp.created_at,
        label: "Harness suggested retiring",
        actor: "harness",
        summary: instruction,
        content: instruction,
        diff: null,
        rule_ids: [ruleId],
        restored_from: null,
        improvement_id: correctionId,
        version_id: null,
        restorable: false,
      });
      if (rp.decided_at && (rp.status === "retired" || rp.status === "kept")) {
        nodes.push({
          id: `decision:rp-${rp.id}-decided`,
          kind: "decision",
          at: rp.decided_at,
          label: rp.status === "retired" ? "You retired" : "You kept it",
          actor: "you",
          summary: instruction,
          content: instruction,
          diff: null,
          rule_ids: [ruleId],
          restored_from: null,
          improvement_id: correctionId,
          version_id: null,
          restorable: false,
        });
      }
    }

    // ---- decision nodes: re-adds (the "rule.readded" event the readd
    // action above writes). Fix round 1: listEventsForRecord's payload
    // substring match false-positives across rules once ids overlap as
    // substrings (rule 3 also matches {"id":30}, {"id":300}, ...) --
    // listReaddEventsForRule uses an exact json_extract match instead. ----
    for (const ev of store.listReaddEventsForRule(ruleId)) {
      nodes.push({
        id: `decision:readd-${ev.id}`,
        kind: "decision",
        at: ev.created_at,
        label: "Re-added",
        actor: "you",
        summary: instruction,
        content: instruction,
        diff: null,
        rule_ids: [ruleId],
        restored_from: null,
        improvement_id: correctionId,
        version_id: null,
        restorable: false,
      });
    }

    // ---- verdict nodes ----
    for (const v of store.listRuleVerdicts(ruleId)) {
      nodes.push({
        id: `verdict:${v.id}`,
        kind: "verdict",
        at: v.created_at,
        label: VERDICT_LABEL[v.verdict],
        actor: "you",
        summary: instruction,
        content: instruction,
        diff: null,
        rule_ids: [ruleId],
        restored_from: null,
        improvement_id: correctionId,
        version_id: null,
        restorable: false,
      });
    }
  }

  // ---- skill nodes: skill_snapshots, workspace targets only (skills have
  // no per-project scope) -- skill_snapshots is already deduped at insert
  // time (recordSkillSnapshot skips an unchanged sha), so every row after
  // the first genuinely changed ----
  if (target === "workspace") {
    const names = (store.latestSkillSnapshots(targetId) as { name: string }[]).map((s) => s.name);
    for (const name of names) {
      const snaps = store.listSkillSnapshots(targetId, name);
      let prevContent: string | null = null;
      snaps.forEach((s, i) => {
        let diff: TimelineChanges | null = null;
        let summary: string | null = null;
        if (i > 0 && prevContent != null) {
          const d = timelineDiff(prevContent, s.content);
          diff = d;
          summary = `+${d.added} −${d.removed} lines`;
        }
        nodes.push({
          id: `skill:${s.id}`,
          kind: "skill",
          at: s.fetched_at,
          label: i === 0 ? `Skill ${name} first read` : `Skill ${name} changed`,
          actor: "lovable",
          summary,
          content: s.content,
          diff,
          rule_ids: [],
          restored_from: null,
          improvement_id: null,
          version_id: null,
          restorable: false,
        });
        prevContent = s.content;
      });
    }
  }

  nodes.sort((a, b) => timelineAtMs(b.at) - timelineAtMs(a.at));
  return nodes.slice(0, TIMELINE_MAX_NODES);
}

// spec §5.2: a whole-rule verdict from the Instructions page's verdict
// buttons. did_not_help is fed into rule_health.hurt as a derived input by
// health.ts's recomputeRuleHealth (Round 5 fix wave item 1 -- it used to be
// written straight into the stored row right here, which the very next
// recompute then silently overwrote); this function's job for that verdict
// is just to trigger that recompute, so the stored row is immediately
// consistent rather than waiting for the next executor sync or analysis
// run. Only when the user's own verdicts are configured as an evidence
// source (spec §4b), and only on a rule_health row that already exists -- a
// verdict alone never creates one. helped snoozes a rule Harness had
// suggested retiring (the user's word overrides the signal for 30 days,
// the same snooze keepProposal above already uses), but leaves any other
// status alone.
function recordVerdict(ruleId: number, verdict: store.RuleVerdict, note?: string): Improvement {
  // Round 6 Task 1: recordRuleVerdict now returns { id, changed } (an
  // upsert -- see its own header comment in store.ts). `changed` is false
  // only when this is the exact same verdict already on file, in which case
  // there is no new signal and the health-effects below (which exist to
  // react to a *new* did_not_help/helped) are skipped -- recomputing or
  // re-snoozing off a click that changed nothing would be redundant, not
  // wrong, but every other call site already treats "no new row" as "no new
  // event" (recordRuleAdherence's insert-or-ignore, above).
  const { changed } = store.recordRuleVerdict({ rule_id: ruleId, verdict, note: note ?? null });

  const health = changed ? store.getRuleHealth(ruleId) : null;
  if (health) {
    if (verdict === "did_not_help" && store.getEvidenceSources().verdicts) {
      recomputeRuleHealth();
    } else if (verdict === "helped" && health.status === "retire_suggested") {
      store.upsertRuleHealth({
        rule_id: health.rule_id,
        applicable_tasks: health.applicable_tasks,
        helped: health.helped,
        hurt: health.hurt,
        last_applicable_at: health.last_applicable_at,
        contradicted_by_rule_id: health.contradicted_by_rule_id,
        unused_since: health.unused_since,
        status: "snoozed",
        snoozed_until: new Date(Date.now() + KEEP_SNOOZE_MS).toISOString(),
        baseline_at: health.baseline_at,
      });
    }
  }

  const correctionId = store.getCorrectionIdForRule(ruleId);
  const refreshed = correctionId != null ? getImprovement(correctionId) : null;
  if (!refreshed) throw new Error(`improvement for rule ${ruleId} not found after verdict`);
  return refreshed;
}
// ---- end Round 5 Task 3 ----

// ---- Round 5 Task 5 ----
// Inbox ranking + "wasn't sure" explanations (spec §4), and the "skip"
// action's optional reason (spec §4b, actionInput/the switch above). Pure
// reads over store.ts; nothing here writes anything new.

// The analysis's own actor string, set once at rule creation and never
// touched again (createRule/updateRule -- see propose.ts's `createdBy =
// \`${provider}/${model} (rule writer)\``). Checking the *suffix* rather
// than the whole string is deliberate: provider/model vary by run, but only
// propose.ts ever writes a rule created_by ending this way (mcp-server.ts's
// human create_rule handler and demo.ts's scripted rules both pass their own
// plain strings -- see harness/src/analysis/propose.ts's own header comment
// for the full list of createRule call sites this task audited).
const ANALYSIS_CREATED_BY_SUFFIX = "(rule writer)";

function isAnalysisCreated(rule: RuleRow | null): boolean {
  return rule != null && rule.created_by.endsWith(ANALYSIS_CREATED_BY_SUFFIX);
}

function clamp80(text: string): string {
  return text.length <= 80 ? text : text.slice(0, 80);
}

// propose.ts's own raw model output for this candidate (RawRuleWriterOutput,
// unvalidated): stored once, at candidate-creation time, as
// agent_actions.structured_output (role='rule_writer', action=
// 'classify_correction' -- see store.createCorrectionCandidate's
// classification_meta handling). This is where duplicate_of_rule_id and
// contradicts_rule_id actually live for a *specific* candidate -- neither
// has its own column on correction_candidates (evidence_reason is a fixed
// "mined from N corrections" string, not JSON), and a rule_health reverse
// lookup (contradicted_by_rule_id) would only ever reflect the *latest*
// contradiction recorded against the older rule, silently going stale for
// an earlier mined candidate once a second one contradicts the same rule.
// Reading the per-candidate row instead never has that problem. Only ever
// non-null for a candidate propose.ts itself created (role='rule_writer');
// every other candidate (human-authored, demo, classifier-derived) has no
// such row and this returns null.
function ruleWriterOutput(
  correctionCandidateId: number,
): { duplicate_of_rule_id: number | null; contradicts_rule_id: number | null } | null {
  const rows = store.getClassificationHistory(correctionCandidateId) as {
    role: string | null;
    structured_output: string | null;
  }[];
  const row = rows.find((r) => r.role === "rule_writer" && r.structured_output);
  if (!row?.structured_output) return null;
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
    return null;
  }
}

// spec §4: the reason decision_mode='automatic' didn't auto-accept this
// pending item without asking -- computed at list time, purely from what's
// already on record (never an LLM call). Gated to decision_mode='automatic'
// (in 'ask' mode the user decides everything, so nothing is ever "not
// sure") and to a rule the analysis itself created (a human-authored or
// demo item was never a candidate for auto-accept in the first place, so
// there is nothing to explain). First match wins, in the order spec'd:
// low confidence, then a flagged duplicate, then a flagged contradiction.
function computeUnsure(c: CorrectionRow, rule: RuleRow | null): string | null {
  if (store.getSetting("decision_mode") !== "automatic") return null;
  if (!isAnalysisCreated(rule)) return null;

  const threshold = Number(store.getSetting("decision_auto_confidence"));
  if (c.confidence != null && c.confidence < threshold) {
    return `Harness wasn't sure: confidence ${c.confidence.toFixed(2)} is below your automatic threshold (${threshold.toFixed(2)}).`;
  }

  const writerOutput = ruleWriterOutput(c.id);
  if (writerOutput?.duplicate_of_rule_id != null) {
    return "Harness wasn't sure: similar to an existing rule.";
  }

  if (writerOutput?.contradicts_rule_id != null) {
    const contradicted = store.getRule(writerOutput.contradicts_rule_id) as {
      rule: { instruction: string };
    } | null;
    if (contradicted) {
      return `Harness wasn't sure: may conflict with "${clamp80(contradicted.rule.instruction)}".`;
    }
  }

  return null;
}

// A tag's acceptance rate for computeRank below: accepted / (accepted +
// skipped) from tagAcceptanceRates(), falling back to a neutral 0.5 when
// the tag has no rate at all yet, or fewer than 3 decided candidates ever
// carried it (spec §4 -- too little history to trust the signal).
function acceptanceRateFor(
  tag: string,
  rates: Record<string, { accepted: number; skipped: number }>,
): number {
  const r = rates[tag];
  if (!r) return 0.5;
  const total = r.accepted + r.skipped;
  return total < 3 ? 0.5 : r.accepted / total;
}

// spec §4: rank = confidence x (0.5 + acceptanceRate(tag)), averaged across
// every tag the item carries (episodeScopeTags -- the same union
// tagAcceptanceRates itself scores by; a retire item has no episode of its
// own, so listImprovements passes ["general"], matching episodeScopeTags'
// own fallback for an untagged episode). A candidate with no confidence on
// record (e.g. hand-authored via the MCP tools, or demo data -- never a
// rule-writer proposal, which always sets one) is treated as fully
// confident (1) rather than penalized for a signal it was never given.
//
// Fix round 1 item 1 (performance): `rates` is `tagAcceptanceRates()`'s
// result, computed ONCE by the caller (listImprovements/getImprovement) --
// never inside this function, and never per item. tagAcceptanceRates()
// itself scans every reviewed correction_candidate (with a per-row
// episodeScopeTags subquery); calling it once per item in a list would make
// listImprovements O(n^2) against candidate history for no reason, since
// the map is identical for every item in the same call.
function computeRank(
  confidence: number | null,
  tags: string[],
  rates: Record<string, { accepted: number; skipped: number }>,
): number {
  const effectiveConfidence = confidence ?? 1;
  const effectiveTags = tags.length > 0 ? tags : ["general"];
  const sum = effectiveTags.reduce(
    (total, tag) => total + effectiveConfidence * (0.5 + acceptanceRateFor(tag, rates)),
    0,
  );
  return sum / effectiveTags.length;
}

// spec §4: pending items ranked highest-rank-first; everything already
// decided (accepted/skipped) keeps its own relative order exactly as
// buildImprovement/buildRetireItem produced it (Array.prototype.sort is
// stable, so ties within the pending group keep their relative order too).
function sortForInbox(items: Improvement[]): Improvement[] {
  const pending = items.filter((i) => i.decision.status === "pending");
  const rest = items.filter((i) => i.decision.status !== "pending");
  pending.sort((a, b) => b.rank - a.rank);
  return [...pending, ...rest];
}
// ---- end Round 5 Task 5 ----

// ---- Round 6 Task 2 ----
// The actual wiring to Lovable (spec §2: a decision the user just pressed
// writes immediately, not "at the next sync") lives in
// executor/beats.ts's improvementActionAndWrite -- this file must never
// import anything Lovable-related (enforced by the "no Lovable import"
// test just above). The two small exports below are everything that
// wrapper needs from here: which action a request names (without exposing
// the full internal action schema), and change_wording's own re-stage
// (which needs stagePendingWrite, private to this file) for a rule that
// was already written.

export type ActionKind = z.infer<typeof actionInput>["action"];

/** Reads which action a POST body names, and (for "accept") whether
 * test_first was set -- everything executor/beats.ts's
 * improvementActionAndWrite needs to decide whether this action writes to
 * Lovable, without this file exposing its full action schema. Throws
 * exactly like improvementAction does on invalid input; a caller always
 * calls improvementAction with the same input right after, so an invalid
 * body fails in the same place either way. */
export function peekActionKind(input: unknown): { kind: ActionKind; testFirst: boolean } {
  const parsed = actionInput.parse(input);
  return {
    kind: parsed.action,
    testFirst: parsed.action === "accept" ? Boolean(parsed.test_first) : false,
  };
}

/**
 * improvementAction's own "change_wording" case cancels any pending write
 * for the rule but never stages a fresh one (a rule that was never written
 * has nothing live to rewrite yet, and stageApprovedWrites picks it back up
 * on the next sync either way -- see that case's own comment). Only a rule
 * that was already WRITTEN needs its live Knowledge rewritten right now,
 * the same way accept/readd already stage via stagePendingWrite.
 *
 * Must be called with the SAME raw input, BEFORE improvementAction runs (it
 * reads the rule's current write_status, which improvementAction is about
 * to change) -- returns a thunk that stages the rewrite if it turns out to
 * be needed; call it AFTER improvementAction returns. A no-op thunk for
 * every action other than change_wording, and for change_wording when the
 * rule wasn't written yet.
 */
export function prepareWordingChangeRewrite(input: unknown): () => void {
  const parsed = actionInput.parse(input);
  if (parsed.action !== "change_wording") return () => {};
  const wasWritten = getImprovement(parsed.id)?.lovable.write_status === "written";
  return () => {
    if (!wasWritten) return;
    const rule = store.getRuleForCorrection(parsed.id) as RuleRow | null;
    const refreshed = getImprovement(parsed.id);
    if (rule && refreshed) {
      stagePendingWrite(refreshed, rule, rule.scope, "wording changed after it was written");
    }
  };
}
// ---- end Round 6 Task 2 ----

// ---- Round 6 Task 3 ----
// Undo, Cancel, and Remove from Knowledge (spec §3): "anything not yet
// written to Lovable gets a plain Undo (no dialog); anything written gets
// Remove from Knowledge (retire + immediate rewrite) instead of Restore;
// Cancel lives on the Instructions pending-write banner; Restore lives on
// the History page only." Remove needs no new code of its own here -- it IS
// the existing "retire" action (called through executor/beats.ts's
// improvementActionAndWrite, already write-eligible for "retire", so it
// writes immediately). The two pieces this block adds are what "undo"'s own
// switch case above needs for the retired-not-yet-removed case, and
// "cancel_write"'s own top-level handler.

// retireRule's own removal rewrite carries rule_id: null (deliberately --
// see retireRule's own comment above) and this exact reason string, so it's
// found by reason rather than rule_id. "none" once nothing matches: already
// written, already cancelled, or never staged in the first place (no
// snapshot existed to compose against at retire time -- the same edge case
// stagePendingWrite's own "no snapshot" path leaves an ordinary accept in).
function retirementWriteStatus(ruleId: number): KnowledgeWriteStatus {
  const reason = `retired rule ${ruleId}`;
  const latest =
    (store.listKnowledgeVersions() as store.KnowledgeVersionRow[]).find(
      (v) => v.rule_id === null && v.reason === reason && v.status !== "cancelled",
    ) ?? null;
  return latest ? latest.status : "none";
}

// The inverse of retireRule, for a retirement whose removal never actually
// reached Lovable: cancels the not-yet-written rewrite (reopening a
// stale/failed one first, the same tolerance executeVersionNow's own retry
// path already has) and brings the rule straight back to "active" -- not
// "proposed": this rule was already live and reviewed; only its removal is
// being undone, there is nothing new here for the user to decide.
function undoRetirement(ruleId: number): void {
  const reason = `retired rule ${ruleId}`;
  const rewrite = (store.listKnowledgeVersions() as store.KnowledgeVersionRow[]).find(
    (v) => v.rule_id === null && v.reason === reason && v.status !== "cancelled",
  );
  if (rewrite && rewrite.status !== "written") {
    const pending =
      rewrite.status === "pending" ? rewrite : store.reopenKnowledgeVersionForRetry(rewrite.id);
    store.markKnowledgeWriteCancelled(
      pending.id,
      "cancelled: retirement undone before it was written",
    );
  }
  store.updateRule({
    id: ruleId,
    state: "active",
    actor: ACTOR,
    reason: "retirement undone before it was written",
  });
}

// The Instructions page's pending-write banner "Cancel": cancels the one
// staged version (reopening a stale/failed one first, so this always ends
// on a genuinely cancelled row rather than throwing) and reopens whatever
// decision staged it. A rule-scoped write (accept/readd/restore/
// change_wording) reopens that rule's own improvement, the same plain
// reopen "undo" itself falls back to above; retireRule's own target-level
// rewrite (rule_id null) has no single rule's *decision* to reopen that way
// -- it undoes the retirement that staged it instead, bringing the rule
// back to "active" (never written, so there is nothing to roll back in
// Lovable itself).
function cancelPendingVersion(versionId: number): Improvement {
  let row = store.getKnowledgeVersion(versionId);
  if (!row) throw new Error(`knowledge version ${versionId} not found`);
  if (row.status === "stale" || row.status === "failed") {
    row = store.reopenKnowledgeVersionForRetry(versionId);
  }
  if (row.status !== "pending")
    throw new Error(`knowledge version ${versionId} is ${row.status}, not staged`);
  store.markKnowledgeWriteCancelled(versionId, "cancelled: write cancelled by the owner");

  let correctionId: number | null = null;
  if (row.rule_id != null) {
    store.updateRule({ id: row.rule_id, state: "proposed", actor: ACTOR });
    correctionId = store.getCorrectionIdForRule(row.rule_id);
    if (correctionId != null)
      store.reviewCorrectionCandidate({ id: correctionId, action: "include", reviewer: ACTOR });
  } else {
    const match = row.reason?.match(/^retired rule (\d+)$/);
    const retiredRuleId = match?.[1] != null ? Number(match[1]) : null;
    if (retiredRuleId != null) {
      store.updateRule({
        id: retiredRuleId,
        state: "active",
        actor: ACTOR,
        reason: "retirement's write cancelled before it was written",
      });
      correctionId = store.getCorrectionIdForRule(retiredRuleId);
    }
  }

  if (correctionId == null)
    throw new Error(`knowledge version ${versionId} was cancelled, but has no linked improvement`);
  const refreshed = getImprovement(correctionId);
  if (!refreshed) throw new Error(`improvement ${correctionId} not found after cancel_write`);
  return refreshed;
}
// ---- end Round 6 Task 3 ----
