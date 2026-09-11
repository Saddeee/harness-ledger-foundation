// The user-facing "Improvement" view (checkpoint C.2 + D): one item per piece
// of Lovable feedback, composed from a correction + its learning/rule + its
// proof plan + its Knowledge write history. Pure reads over store.ts plus a
// small action mapper; no Lovable access. Contracts:
// scratchpad/improvement-contract.md and scratchpad/checkpoint-d-contract.md.
import { z } from "zod";
import * as store from "./store.js";
import { composeManagedKnowledge } from "./knowledge.js";

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
export type KnowledgeWriteStatus =
  "none" | "pending" | "written" | "stale" | "failed" | "cancelled";
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
};
export type Improvement = {
  id: number;
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
  };
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
  const snapshot = store.latestKnowledgeSnapshot(target, targetId);
  if (!snapshot) return null;
  const composed = composeManagedKnowledge(
    snapshot.content,
    rulesForPreview(target, targetId, rule),
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
  };
}

function buildImprovement(c: CorrectionRow): Improvement {
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
  const writeStatus: KnowledgeWriteStatus = latest ? latest.status : "none";
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

  return {
    id: c.id,
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
    },
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

export function listImprovements(): Improvement[] {
  return (store.listCorrectionCandidates() as unknown as CorrectionRow[]).map(buildImprovement);
}

export function getImprovement(id: number): Improvement | null {
  const row = (store.listCorrectionCandidates() as unknown as CorrectionRow[]).find(
    (c) => c.id === id,
  );
  return row ? buildImprovement(row) : null;
}

const ACTOR = "operator (local UI)";
const actionInput = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("accept"),
    id: z.number().int(),
    destination: z.enum(["workspace", "project", "skill"]),
    test_first: z.boolean().optional(),
  }),
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
  z.object({ action: z.literal("restore"), id: z.number().int(), version_id: z.number().int() }),
]);

// After the user approves "Add", stage the exact write for the executor --
// only when a snapshot of the live Knowledge exists to compose from.
function stagePendingWrite(
  improvement: Improvement,
  rule: RuleRow,
  target: "project" | "workspace",
  reason?: string,
) {
  const preview = improvement.lovable.previews[target];
  if (!preview) return;
  if (preview.over_cap)
    throw new Error(
      "This would exceed the Knowledge limit — shorten the instruction or your existing Knowledge first",
    );
  const snapshot = store.latestKnowledgeSnapshot(
    target,
    target === "project"
      ? improvement.project.id
      : (store.getProjectMeta(improvement.project.id)?.workspace_id ?? ""),
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
    if (!preview || preview.over_cap) {
      skipped += 1;
      continue;
    }
    stagePendingWrite(improvement, rule, target, "staged by the executor after Knowledge was read");
    staged += 1;
  }
  return { staged, skipped };
}

export function improvementAction(input: unknown): Improvement {
  const a = actionInput.parse(input);
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
        reviewer: ACTOR,
      });
      if (rule) {
        store.updateRule({ id: rule.id, state: "approved", scope: destination, actor: ACTOR });
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
      store.createRestoreVersion(a.version_id, ACTOR);
      break;
    }
  }
  const refreshed = getImprovement(a.id);
  if (!refreshed) throw new Error(`improvement ${a.id} not found after update`);
  return refreshed;
}
