/**
 * Removable demo data: `npm run demo -- --add | --remove | --status`
 * (from the repo root: `npm run harness:demo -- --add | --remove | --status`).
 *
 * `--add` builds a rich set of Improvements end to end through the real
 * store.ts pipeline (history items -> task episode -> correction candidate
 * -> learning -> rule -> knowledge versions) for the first allowed project,
 * so the local UI has something real to show on every screen: pending
 * suggestions (including one the automatic decision mode "wasn't sure"
 * about), an open retirement proposal, rules written into both the
 * project's and the workspace's Knowledge with real rule_health/verdict/
 * adherence data, one accepted automatically, one reverted, one skipped,
 * one needing attention (a stale write), one retired, and one waiting to be
 * tested -- plus workspace Skill snapshots and a Knowledge change made
 * directly in Lovable outside Harness. Every row it creates carries a fixed
 * "Demo:" title/instruction/name (or, for internal actor/reason strings
 * that are never shown as such, the literal string "demo"), so `--add` is
 * idempotent and `--remove` deletes exactly those rows -- nothing a real
 * user created is ever touched.
 *
 * Controller fix round 1 (critical): after `--add`, the demo must leave
 * NOTHING the executor's own beats (harness/src/executor/beats.ts) would
 * act on against the owner's real Lovable project -- no `pending`
 * knowledge_versions row, and `stageApprovedWrites()` (improvements.ts)
 * must return `{ staged: 0 }`. Concretely: every rule this module leaves
 * in state 'approved' either already has a written version (safe) or has
 * an approved, unwritten experiment plan (`test_first`, which
 * stageApprovedWrites skips outright) -- never an 'approved' rule with no
 * pending/written version and no test_first plan, which is exactly what
 * stageApprovedWrites re-stages on the next real sync. This is why
 * "accepted automatically" is demoed as an already-WRITTEN rule (the
 * `decided_by = 'automatic'` marker still shows it apart from a normal
 * accept) rather than a rule left pending, and why the "needing attention"
 * (stale) rule's state is moved to 'testing' once its write goes stale --
 * NOT left 'approved', which would otherwise make stageApprovedWrites
 * silently recompose and re-stage a fresh write for it. As a direct
 * consequence, the "Waiting to be written" IMPROVEMENT_GROUPS value is not
 * demoed at all: there is no way to show it without leaving exactly the
 * pending-write footprint the executor would act on.
 *
 * This module writes nothing to Lovable and makes no LLM call -- it is pure
 * local bookkeeping, exactly like the rest of the store.ts pipeline it
 * drives.
 */
import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";
import { db } from "./db.js";
import * as store from "./store.js";
import { composeManagedKnowledge } from "./knowledge.js";
import { improvementAction } from "./improvements.js";
import { recomputeRuleHealth } from "./analysis/health.js";
import { proposeRetirements } from "./analysis/retire.js";

const EPISODE_TITLE_PENDING = "Demo: keep the sidebar order stable";
const EPISODE_TITLE_WRITTEN = "Demo: never add a cron job without asking";
const RULE_INSTRUCTION_PENDING = "Demo: keep the sidebar order stable.";
const RULE_INSTRUCTION_WRITTEN = "Demo: never add a cron job without asking.";
const RULE_INSTRUCTION_WRITTEN_V2 =
  "Demo: never add a cron job without asking. Always confirm the schedule and frequency with the user first.";
const RULE_INSTRUCTION_WRITTEN_V3 =
  "Demo: never add a cron job without asking. Always confirm the schedule, frequency, and estimated resource cost with the user first.";
const SKILL_NAME = "deploy-checklist";
const SKILL_NAME_2 = "Demo: review-checklist";
const BASE_KNOWLEDGE_DOC =
  "# Project Knowledge\n\nThis project was built with Lovable. Add your own notes above this line.\n";
const WORKSPACE_BASE_KNOWLEDGE_DOC =
  "# Workspace Knowledge\n\nShared across every project in this workspace.\n";

// ---- Round 5 Task 8 additions: richer demo data, every state, spec §7 ----
// (all "Demo:"-prefixed titles/instructions per the global rule; internal
// actor/reason strings that are never shown verbatim stay plain "demo")

const RULE_A_INSTRUCTION = "Demo: always confirm before renaming a public API route.";
const RULE_A_INSTRUCTION_V2 =
  "Demo: always confirm before renaming a public API route. Give existing integrations a deprecation window before removing the old route.";
const RULE_A_PREDICTED_FAILURE =
  "Demo: a client integration silently breaks because a public API route was renamed without warning.";

const RULE_B_INSTRUCTION = "Demo: never skip the onboarding checklist step for new users.";
const RULE_B_INSTRUCTION_V2 =
  "Demo: never skip the onboarding checklist step for new users. Always show it on first login, even after a fast signup path.";
const RULE_B_INSTRUCTION_V3 =
  "Demo: never skip the onboarding checklist step for new users. Always show it on first login, even after a fast signup path, and don't let a page refresh auto-dismiss it.";
const RULE_B_PREDICTED_FAILURE =
  "Demo: a new user reaches the dashboard without ever completing the onboarding checklist step, and gets lost.";

const RULE_P2_INSTRUCTION = "Demo: keep the empty-state illustration visible in dark mode too.";
const RULE_P3_INSTRUCTION = "Demo: use the shared date-formatting helper everywhere.";
const RULE_P3_PREDICTED_FAILURE =
  "Demo: a date is formatted inline instead of using the shared date-formatting helper.";

const RULE_AUTO_INSTRUCTION = "Demo: always use the design system's spacing tokens.";
const RULE_REVERTED_INSTRUCTION =
  "Demo: disable the beta features menu for everyone outside the beta group.";
const RULE_SKIPPED_INSTRUCTION = "Demo: rename the Settings tab to Preferences.";
const RULE_STALE_INSTRUCTION = "Demo: always paginate the activity feed.";
const RULE_RETIRED_INSTRUCTION = "Demo: block deploys whenever the type check is failing.";
const RULE_TESTFIRST_INSTRUCTION = "Demo: switch the primary button color to the brand teal.";

const DEPLOY_CHECKLIST_V1 =
  "# Deploy checklist (demo)\n\n1. Run the test suite.\n2. Check the build.\n3. Confirm environment variables are set.\n4. Deploy and verify the live preview.\n";
const DEPLOY_CHECKLIST_V2 = `${DEPLOY_CHECKLIST_V1}5. Check the error-tracking dashboard for new issues.\n`;
const DEPLOY_CHECKLIST_V3 = `${DEPLOY_CHECKLIST_V2}6. Announce the deploy in the team channel.\n`;
const REVIEW_CHECKLIST_V1 =
  "# Demo: review checklist\n\n1. Read the diff, not just the description.\n2. Check for a test covering the change.\n";
const REVIEW_CHECKLIST_V2 = `${REVIEW_CHECKLIST_V1}3. Confirm the PR follows the naming conventions.\n`;
const REVIEW_CHECKLIST_V3 = `${REVIEW_CHECKLIST_V2}4. Leave a comment if anything is unclear -- don't just approve silently.\n`;

// ---- end Task 8 constants ----

/** Whether the demo's two task episodes exist -- the cheapest reliable "is demo loaded" check. */
export function demoLoaded(): boolean {
  const row = db
    .prepare(`SELECT 1 FROM task_episodes WHERE title IN (?, ?) LIMIT 1`)
    .get(EPISODE_TITLE_PENDING, EPISODE_TITLE_WRITTEN);
  return row !== undefined;
}

function sqliteTimestamp(hoursAgo: number): string {
  return new Date(Date.now() - hoursAgo * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
}

function backdateKnowledgeVersion(versionId: number, hoursAgo: number): void {
  const ts = sqliteTimestamp(hoursAgo);
  db.prepare(
    `UPDATE knowledge_versions SET created_at = ?, written_at = ?, verified_at = ? WHERE id = ?`,
  ).run(ts, ts, ts, versionId);
}

// Task 8: a version that never gets written (stays pending, or is later
// marked stale) has no written_at/verified_at to backdate -- only its
// created_at, so it still shows up in the right place in the 14-day story.
function backdateVersionCreatedAt(versionId: number, hoursAgo: number): void {
  db.prepare(`UPDATE knowledge_versions SET created_at = ? WHERE id = ?`).run(
    sqliteTimestamp(hoursAgo),
    versionId,
  );
}

function backdateSkillSnapshot(id: number, hoursAgo: number): void {
  db.prepare(`UPDATE skill_snapshots SET fetched_at = ? WHERE id = ?`).run(
    sqliteTimestamp(hoursAgo),
    id,
  );
}

function backdateKnowledgeSnapshot(id: number, hoursAgo: number): void {
  db.prepare(`UPDATE knowledge_snapshots SET fetched_at = ? WHERE id = ?`).run(
    sqliteTimestamp(hoursAgo),
    id,
  );
}

/** Stages, "writes" (via recordKnowledgeReadback) and backdates one demo
 * knowledge version, project- or workspace-scoped. */
function writeDemoVersion(input: {
  target: "project" | "workspace";
  projectId?: string;
  workspaceId?: string;
  ruleId: number;
  ruleIds: number[];
  previous: string;
  next: string;
  reason: string;
  hoursAgo: number;
}): number {
  const version = store.createPendingKnowledgeVersion({
    rule_id: input.ruleId,
    target: input.target,
    ...(input.target === "project"
      ? { project_id: input.projectId! }
      : { workspace_id: input.workspaceId! }),
    previous_content: input.previous,
    new_content: input.next,
    rule_ids: input.ruleIds,
    actor: "demo",
    reason: input.reason,
  }) as { id: number };
  store.recordKnowledgeReadback(version.id, input.next);
  backdateKnowledgeVersion(version.id, input.hoursAgo);
  return version.id;
}

// Task 8: the most recently created pending write for a rule -- used right
// after an accept-flow call (improvementAction/stagePendingWrite) staged
// one, so it can be backdated and, for the "needs attention" item, marked
// stale.
function latestPendingVersionId(ruleId: number): number {
  const row = db
    .prepare(
      `SELECT id FROM knowledge_versions WHERE rule_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1`,
    )
    .get(ruleId) as { id: number } | undefined;
  if (!row) throw new Error(`demo: expected a pending knowledge_version for rule ${ruleId}`);
  return row.id;
}

let demoMsgSeq = 0;

function demoMessage(input: {
  projectId: string;
  idBase: string;
  role: "user" | "assistant";
  content: string;
  hoursAgo: number;
}): number {
  const row = store.upsertHistoryItem({
    project_id: input.projectId,
    kind: "message",
    external_id: `demo-${input.idBase}-${input.role}-${(demoMsgSeq += 1)}`,
    role: input.role,
    content: input.content,
    occurred_at: sqliteTimestamp(input.hoursAgo),
    provenance: "lovable_mcp",
    source_ref: "demo-seed",
  }) as { id: number };
  return row.id;
}

/** Builds one full episode -> candidate -> learning -> rule chain from a
 * user/assistant message pair -- the same shape the sidebar/cron
 * improvements below already use, generalized so every Task 8 addition can
 * share it instead of repeating the same five store calls ten times over. */
function demoImprovementSeed(input: {
  projectId: string;
  idBase: string;
  episodeTitle: string;
  episodeSummary: string;
  userText: string;
  assistantText: string;
  hoursAgo: number;
  classification: store.Classification;
  candidateSummary: string;
  confidence: number;
  evidenceReason: string;
  observedProblem: string;
  desiredBehavior: string;
  reuseRationale: string;
  scope: "project" | "workspace";
  instruction: string;
  appliesWhen: string;
  predictedFailure: string;
  createdBy?: string;
  classificationMeta?: store.ClassificationMeta;
}): {
  episodeId: number;
  candidateId: number;
  learningId: number;
  ruleId: number;
  userId: number;
  assistantId: number;
} {
  const userId = demoMessage({
    projectId: input.projectId,
    idBase: input.idBase,
    role: "user",
    content: input.userText,
    hoursAgo: input.hoursAgo,
  });
  const assistantId = demoMessage({
    projectId: input.projectId,
    idBase: input.idBase,
    role: "assistant",
    content: input.assistantText,
    hoursAgo: input.hoursAgo,
  });
  const episode = store.createTaskEpisode({
    project_id: input.projectId,
    title: input.episodeTitle,
    summary: input.episodeSummary,
    provenance: "manual",
    started_at: sqliteTimestamp(input.hoursAgo),
    evidence_history_item_ids: [userId, assistantId],
  }) as { id: number };
  const candidate = store.createCorrectionCandidate({
    task_episode_id: episode.id,
    classification: input.classification,
    is_correction: true,
    reusable: true,
    proposed_scope: input.scope,
    summary: input.candidateSummary,
    confidence: input.confidence,
    evidence_reason: input.evidenceReason,
    evidence_history_item_ids: [userId, assistantId],
    classification_meta: input.classificationMeta,
  }) as { id: number };
  const learning = store.createLearning({
    correction_candidate_id: candidate.id,
    observed_problem: input.observedProblem,
    desired_behavior: input.desiredBehavior,
    reuse_rationale: input.reuseRationale,
    proposed_scope: input.scope,
    confidence: input.confidence,
    provenance: "manual",
    created_by: input.createdBy ?? "demo",
  }) as { id: number };
  const rule = store.createRule({
    learning_id: learning.id,
    correction_candidate_id: candidate.id,
    instruction: input.instruction,
    scope: input.scope,
    applies_when: input.appliesWhen,
    predicted_failure: input.predictedFailure,
    ownership: "harness",
    created_by: input.createdBy ?? "demo",
  }) as { id: number };
  return {
    episodeId: episode.id,
    candidateId: candidate.id,
    learningId: learning.id,
    ruleId: rule.id,
    userId,
    assistantId,
  };
}

let demoHealthSeq = 0;

/** One episode purely for rule_health signal (Task 8): a "new_task" request
 * message, classified with the rule's scope tag, and -- when `hurt` -- a
 * second "correction" message whose classified summary is exactly the
 * rule's predicted_failure text, guaranteeing health.ts's matchesFailure
 * fires (dice("x","x") == 1) without needing a verification_plan at all.
 * Not linked to any correction_candidate -- mirrors rule-health.test.ts's
 * own fixture episodes, which are deliberately separate from the rule's
 * founding candidate. */
function demoHealthEpisode(input: {
  projectId: string;
  title: string;
  hoursAgo: number;
  tags: string[];
  hurt: boolean;
  predictedFailure: string;
}): number {
  const reqId = demoMessage({
    projectId: input.projectId,
    idBase: `health-${(demoHealthSeq += 1)}`,
    role: "user",
    content: `${input.title}.`,
    hoursAgo: input.hoursAgo,
  });
  store.insertMessageClassification({
    history_item_id: reqId,
    classification: "new_task",
    tags: input.tags,
    summary: "",
  });
  const evidenceIds = [reqId];
  if (input.hurt) {
    const corrId = demoMessage({
      projectId: input.projectId,
      idBase: `health-${demoHealthSeq}-correction`,
      role: "user",
      content: `${input.title} -- still happening.`,
      hoursAgo: input.hoursAgo,
    });
    store.insertMessageClassification({
      history_item_id: corrId,
      classification: "correction",
      tags: input.tags,
      summary: input.predictedFailure,
    });
    evidenceIds.push(corrId);
  }
  const episode = store.createTaskEpisode({
    project_id: input.projectId,
    title: input.title,
    summary: "Demo: seeded so recomputeRuleHealth has real signal.",
    provenance: "manual",
    started_at: sqliteTimestamp(input.hoursAgo),
    evidence_history_item_ids: evidenceIds,
  }) as { id: number };
  return episode.id;
}

export type AddDemoResult = { added: boolean; message: string; project_id?: string };

export function addDemoData(): AddDemoResult {
  if (demoLoaded()) {
    return { added: false, message: "Demo data is already loaded." };
  }
  const projects = store.getAllowedProjects() as { lovable_project_id: string }[];
  const project = projects[0];
  if (!project) {
    return {
      added: false,
      message:
        "No allowed project found -- seed one first (npm run seed -- <lovable_project_id> [label]).",
    };
  }
  const projectId = project.lovable_project_id;
  const workspaceId = store.getProjectMeta(projectId)?.workspace_id ?? "demo-workspace";

  // ---- Improvement 1: pending (sidebar order) -- decision never recorded ----
  const sidebarUser = store.upsertHistoryItem({
    project_id: projectId,
    kind: "message",
    external_id: "demo-sidebar-user-1",
    role: "user",
    content:
      "Can you make sure the sidebar keeps the order I set? It resets every time the page reloads.",
    occurred_at: sqliteTimestamp(72),
    provenance: "lovable_mcp",
    source_ref: "demo-seed",
  }) as { id: number };
  const sidebarAssistant = store.upsertHistoryItem({
    project_id: projectId,
    kind: "message",
    external_id: "demo-sidebar-assistant-1",
    role: "assistant",
    content:
      "Got it -- I'll look at how the sidebar order is stored and make sure a reload doesn't resort it.",
    occurred_at: sqliteTimestamp(72),
    provenance: "lovable_mcp",
    source_ref: "demo-seed",
  }) as { id: number };

  const pendingEpisode = store.createTaskEpisode({
    project_id: projectId,
    title: EPISODE_TITLE_PENDING,
    summary: "Demo: the user asked for the sidebar order to stay stable across reloads.",
    provenance: "manual",
    evidence_history_item_ids: [sidebarUser.id, sidebarAssistant.id],
  }) as { id: number };
  const pendingCandidate = store.createCorrectionCandidate({
    task_episode_id: pendingEpisode.id,
    classification: "missing_requirement",
    is_correction: true,
    reusable: true,
    proposed_scope: "project",
    summary: "Demo: keep the sidebar order stable across reloads.",
    confidence: 0.75,
    evidence_reason: "Seeded by npm run harness:demo -- --add to exercise the Inbox pending state.",
    evidence_history_item_ids: [sidebarUser.id, sidebarAssistant.id],
  }) as { id: number };
  const pendingLearning = store.createLearning({
    correction_candidate_id: pendingCandidate.id,
    observed_problem: "The sidebar's item order was not preserved across reloads.",
    desired_behavior:
      "Keep the sidebar's order exactly as the user last set it, across reloads and unrelated edits.",
    reuse_rationale: "Any user-ordered list should stay stable unless the user reorders it.",
    proposed_scope: "project",
    confidence: 0.75,
    provenance: "manual",
    created_by: "demo",
  }) as { id: number };
  const pendingRule = store.createRule({
    learning_id: pendingLearning.id,
    correction_candidate_id: pendingCandidate.id,
    instruction: RULE_INSTRUCTION_PENDING,
    scope: "project",
    applies_when: "rendering or persisting the sidebar's item order",
    predicted_failure: "the sidebar visibly reorders itself after a reload or an unrelated change",
    ownership: "harness",
    created_by: "demo",
  }) as { id: number };
  // Left as-is: the correction candidate is never reviewed, and pendingRule
  // is never passed into composeManagedKnowledge or writeDemoVersion below
  // -- nothing here ever touches Knowledge for it, so it stays a genuine
  // pending decision in the Inbox (decision.status "pending",
  // lovable.write_status "none", zero knowledge_versions). Only the written
  // (cron) rule below ever gets composed or written.
  void pendingRule;

  // ---- Improvement 2: written (cron job) -- decided and its rule active ----
  const cronUser = store.upsertHistoryItem({
    project_id: projectId,
    kind: "message",
    external_id: "demo-cron-user-1",
    role: "user",
    content:
      "Please don't add any cron jobs or scheduled tasks without asking me first -- the last one surprised me.",
    occurred_at: sqliteTimestamp(48),
    provenance: "lovable_mcp",
    source_ref: "demo-seed",
  }) as { id: number };
  const cronAssistant = store.upsertHistoryItem({
    project_id: projectId,
    kind: "message",
    external_id: "demo-cron-assistant-1",
    role: "assistant",
    content:
      "Understood -- I won't schedule any recurring or cron-style job without checking with you first.",
    occurred_at: sqliteTimestamp(48),
    provenance: "lovable_mcp",
    source_ref: "demo-seed",
  }) as { id: number };

  const writtenEpisode = store.createTaskEpisode({
    project_id: projectId,
    title: EPISODE_TITLE_WRITTEN,
    summary: "Demo: the user asked to be consulted before any cron job is added.",
    provenance: "manual",
    evidence_history_item_ids: [cronUser.id, cronAssistant.id],
  }) as { id: number };
  const writtenCandidate = store.createCorrectionCandidate({
    task_episode_id: writtenEpisode.id,
    classification: "constraint_restatement",
    is_correction: true,
    reusable: true,
    proposed_scope: "project",
    summary: "Demo: never add a cron job without asking first.",
    confidence: 0.85,
    evidence_reason:
      "Seeded by npm run harness:demo -- --add to exercise the written-to-Lovable state and the Instructions diff view.",
    evidence_history_item_ids: [cronUser.id, cronAssistant.id],
  }) as { id: number };
  const writtenLearning = store.createLearning({
    correction_candidate_id: writtenCandidate.id,
    observed_problem: "A cron job was added without checking with the user first.",
    desired_behavior: "Always ask before adding any cron job or other recurring scheduled task.",
    reuse_rationale:
      "Recurring jobs spend credits/resources unattended and should always be an explicit, informed choice.",
    proposed_scope: "project",
    confidence: 0.85,
    provenance: "manual",
    created_by: "demo",
  }) as { id: number };
  const writtenRule = store.createRule({
    learning_id: writtenLearning.id,
    correction_candidate_id: writtenCandidate.id,
    instruction: RULE_INSTRUCTION_WRITTEN,
    scope: "project",
    applies_when: "adding a cron job, pg_cron schedule, or any other recurring background trigger",
    predicted_failure:
      "a recurring job starts running unattended and the user is surprised by it later",
    ownership: "harness",
    created_by: "demo",
  }) as { id: number };

  // Records the human decision (reviewed=1) so this improvement reads as
  // "accepted" once its rule goes active below -- distinct from the
  // sidebar improvement above, which never gets this call.
  store.recordHumanCorrectionDecision({
    id: writtenCandidate.id,
    final_classification: "constraint_restatement",
    reusable: true,
    proposed_scope: "project",
    reviewer: "demo",
  });

  // ---- Three knowledge versions for the project target, all written ----
  // All three are built from writtenRule (the cron rule) ONLY -- pendingRule
  // is never passed into composeManagedKnowledge or writeDemoVersion, so its
  // correction candidate staying unreviewed is never contradicted by a
  // Knowledge write that would otherwise flip it to 'active' (see
  // recordKnowledgeReadback). v1 adds the managed block with the rule; v2
  // and v3 each reword it, growing its instruction by one clarifying
  // sentence while keeping the first sentence -- and so the improvement's
  // title -- exactly the same throughout.
  const v1 = composeManagedKnowledge(BASE_KNOWLEDGE_DOC, [
    { id: writtenRule.id, instruction: RULE_INSTRUCTION_WRITTEN },
  ]);
  writeDemoVersion({
    target: "project",
    projectId,
    ruleId: writtenRule.id,
    ruleIds: [writtenRule.id],
    previous: BASE_KNOWLEDGE_DOC,
    next: v1.final_content,
    reason: "demo: initial Knowledge write",
    hoursAgo: 2,
  });

  store.updateRule({
    id: writtenRule.id,
    instruction: RULE_INSTRUCTION_WRITTEN_V2,
    actor: "demo",
    reason: "demo: reworded to also mention the schedule and frequency",
  });
  const v2 = composeManagedKnowledge(v1.final_content, [
    { id: writtenRule.id, instruction: RULE_INSTRUCTION_WRITTEN_V2 },
  ]);
  writeDemoVersion({
    target: "project",
    projectId,
    ruleId: writtenRule.id,
    ruleIds: [writtenRule.id],
    previous: v1.final_content,
    next: v2.final_content,
    reason: "demo: reworded the cron-job rule",
    hoursAgo: 1,
  });

  store.updateRule({
    id: writtenRule.id,
    instruction: RULE_INSTRUCTION_WRITTEN_V3,
    actor: "demo",
    reason: "demo: reworded again to also mention estimated resource cost",
  });
  const v3 = composeManagedKnowledge(v2.final_content, [
    { id: writtenRule.id, instruction: RULE_INSTRUCTION_WRITTEN_V3 },
  ]);
  writeDemoVersion({
    target: "project",
    projectId,
    ruleId: writtenRule.id,
    ruleIds: [writtenRule.id],
    previous: v2.final_content,
    next: v3.final_content,
    reason: "demo: reworded the cron-job rule again",
    hoursAgo: 0,
  });

  // A snapshot of the "latest known Lovable content" so previews elsewhere
  // (the Improvements/Instructions pages) have something to compose against.
  store.recordKnowledgeSnapshot({
    target: "project",
    project_id: projectId,
    content: v3.final_content,
    fetched_by: "demo",
  });

  // ---- One workspace Skill snapshot (deploy-checklist v1) ----
  const deploySnap1 = store.recordSkillSnapshot({
    workspace_id: workspaceId,
    name: SKILL_NAME,
    description: "Steps to check before deploying (demo).",
    content: DEPLOY_CHECKLIST_V1,
    updated_at_remote: null,
    fetched_by: "demo",
  });
  backdateSkillSnapshot(deploySnap1.id, 200);

  // ================= Round 5 Task 8: the rest of spec §7 ==================

  // ---- Rule B: workspace-scoped, written, engineered to rule_health
  // 'retire_suggested' so proposeRetirements() raises exactly one open
  // retirement proposal against it (the "1 open retirement proposal"). ----
  const ruleB = demoImprovementSeed({
    projectId,
    idBase: "ruleb",
    episodeTitle: "Demo: skipped the onboarding checklist step again",
    episodeSummary: "Demo: new users are reaching the dashboard without the onboarding checklist.",
    userText:
      "New users are landing on the dashboard without ever seeing the onboarding checklist -- please don't skip that step.",
    assistantText: "Understood -- I won't skip the onboarding checklist step for new users again.",
    hoursAgo: 330,
    classification: "constraint_restatement",
    candidateSummary: "Demo: never skip the onboarding checklist step for new users.",
    confidence: 0.82,
    evidenceReason:
      "Seeded by npm run harness:demo -- --add to exercise a workspace-scoped rule with real rule_health.",
    observedProblem:
      "New users reached the dashboard without ever seeing the onboarding checklist.",
    desiredBehavior: "Always show the onboarding checklist on first login, for every new user.",
    reuseRationale: "Onboarding applies to every project in the workspace, not just this one.",
    scope: "workspace",
    instruction: RULE_B_INSTRUCTION,
    appliesWhen: "a new user's first login, or any change to the signup/onboarding flow",
    predictedFailure: RULE_B_PREDICTED_FAILURE,
  });
  store.recordHumanCorrectionDecision({
    id: ruleB.candidateId,
    final_classification: "constraint_restatement",
    reusable: true,
    proposed_scope: "workspace",
    reviewer: "demo",
  });
  store.setRuleScopeTags(ruleB.ruleId, ["demo-topic-b"]);

  const ruleBv1 = composeManagedKnowledge(WORKSPACE_BASE_KNOWLEDGE_DOC, [
    { id: ruleB.ruleId, instruction: RULE_B_INSTRUCTION },
  ]);
  writeDemoVersion({
    target: "workspace",
    workspaceId,
    ruleId: ruleB.ruleId,
    ruleIds: [ruleB.ruleId],
    previous: WORKSPACE_BASE_KNOWLEDGE_DOC,
    next: ruleBv1.final_content,
    reason: "demo: initial workspace Knowledge write",
    hoursAgo: 325,
  });
  store.updateRule({
    id: ruleB.ruleId,
    instruction: RULE_B_INSTRUCTION_V2,
    actor: "demo",
    reason: "demo: also cover the fast signup path",
  });
  const ruleBv2 = composeManagedKnowledge(ruleBv1.final_content, [
    { id: ruleB.ruleId, instruction: RULE_B_INSTRUCTION_V2 },
  ]);
  writeDemoVersion({
    target: "workspace",
    workspaceId,
    ruleId: ruleB.ruleId,
    ruleIds: [ruleB.ruleId],
    previous: ruleBv1.final_content,
    next: ruleBv2.final_content,
    reason: "demo: reworded the onboarding rule",
    hoursAgo: 320,
  });
  store.updateRule({
    id: ruleB.ruleId,
    instruction: RULE_B_INSTRUCTION_V3,
    actor: "demo",
    reason: "demo: also cover a page refresh dismissing it",
  });
  const ruleBv3 = composeManagedKnowledge(ruleBv2.final_content, [
    { id: ruleB.ruleId, instruction: RULE_B_INSTRUCTION_V3 },
  ]);
  writeDemoVersion({
    target: "workspace",
    workspaceId,
    ruleId: ruleB.ruleId,
    ruleIds: [ruleB.ruleId],
    previous: ruleBv2.final_content,
    next: ruleBv3.final_content,
    reason: "demo: reworded the onboarding rule again",
    hoursAgo: 315,
  });

  // 4 applicable episodes, all "hurt" (matching correction) -> hurt(4) >
  // helped(0), applicable(4) >= 3 -> retire_suggested.
  const ruleBEpisodeIds: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    ruleBEpisodeIds.push(
      demoHealthEpisode({
        projectId,
        title: `Demo: onboarding checklist skipped (health episode ${i + 1})`,
        hoursAgo: 300 - i * 10,
        tags: ["demo-topic-b"],
        hurt: true,
        predictedFailure: RULE_B_PREDICTED_FAILURE,
      }),
    );
  }
  store.recordRuleAdherence({
    rule_id: ruleB.ruleId,
    task_episode_id: ruleBEpisodeIds[0]!,
    verdict: "broke",
    quote: '"the onboarding checklist never showed up for the new account I just created"',
    llm_call_id: null,
    run_id: null,
  });
  store.recordRuleAdherence({
    rule_id: ruleB.ruleId,
    task_episode_id: ruleBEpisodeIds[1]!,
    verdict: "broke",
    quote: '"still landing straight on the dashboard, no checklist"',
    llm_call_id: null,
    run_id: null,
  });
  store.recordRuleAdherence({
    rule_id: ruleB.ruleId,
    task_episode_id: ruleBEpisodeIds[2]!,
    verdict: "followed",
    quote: '"the checklist showed up correctly on this signup"',
    llm_call_id: null,
    run_id: null,
  });
  store.recordRuleVerdict({
    rule_id: ruleB.ruleId,
    verdict: "did_not_help",
    note: "Demo: still happening despite the rule.",
  });

  // ---- Rule A: project-scoped, written, healthy (mostly "helped"). ----
  const ruleA = demoImprovementSeed({
    projectId,
    idBase: "rulea",
    episodeTitle: "Demo: renamed the export endpoint without asking",
    episodeSummary:
      "Demo: a public API route was renamed without warning and broke an integration.",
    userText:
      "You renamed /api/export to /api/download without telling me -- my Zapier integration broke.",
    assistantText:
      "Sorry about that -- I'll always confirm before renaming a public API route from now on.",
    hoursAgo: 260,
    classification: "defect_correction",
    candidateSummary: "Demo: always confirm before renaming a public API route.",
    confidence: 0.88,
    evidenceReason:
      "Seeded by npm run harness:demo -- --add to exercise a healthy in-Lovable rule with real rule_health.",
    observedProblem:
      "A public API route was renamed without warning, breaking an existing integration.",
    desiredBehavior: "Always confirm with the user before renaming a public API route.",
    reuseRationale: "Any public route rename can break an integration the user doesn't control.",
    scope: "project",
    instruction: RULE_A_INSTRUCTION,
    appliesWhen: "renaming or removing an existing public API route",
    predictedFailure: RULE_A_PREDICTED_FAILURE,
  });
  store.recordHumanCorrectionDecision({
    id: ruleA.candidateId,
    final_classification: "defect_correction",
    reusable: true,
    proposed_scope: "project",
    reviewer: "demo",
  });
  store.setRuleScopeTags(ruleA.ruleId, ["demo-topic-a"]);

  const ruleAv1 = composeManagedKnowledge(BASE_KNOWLEDGE_DOC, [
    { id: ruleA.ruleId, instruction: RULE_A_INSTRUCTION },
  ]);
  writeDemoVersion({
    target: "project",
    projectId,
    ruleId: ruleA.ruleId,
    ruleIds: [ruleA.ruleId],
    previous: BASE_KNOWLEDGE_DOC,
    next: ruleAv1.final_content,
    reason: "demo: initial Knowledge write",
    hoursAgo: 255,
  });
  store.updateRule({
    id: ruleA.ruleId,
    instruction: RULE_A_INSTRUCTION_V2,
    actor: "demo",
    reason: "demo: also promise a deprecation window",
  });
  const ruleAv2 = composeManagedKnowledge(ruleAv1.final_content, [
    { id: ruleA.ruleId, instruction: RULE_A_INSTRUCTION_V2 },
  ]);
  writeDemoVersion({
    target: "project",
    projectId,
    ruleId: ruleA.ruleId,
    ruleIds: [ruleA.ruleId],
    previous: ruleAv1.final_content,
    next: ruleAv2.final_content,
    reason: "demo: reworded the API-route rule",
    hoursAgo: 250,
  });

  // 4 applicable episodes, all "helped" (new_task only, no correction).
  const ruleAEpisodeIds: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    ruleAEpisodeIds.push(
      demoHealthEpisode({
        projectId,
        title: `Demo: routine API work, route naming respected (health episode ${i + 1})`,
        hoursAgo: 240 - i * 10,
        tags: ["demo-topic-a"],
        hurt: false,
        predictedFailure: RULE_A_PREDICTED_FAILURE,
      }),
    );
  }
  store.recordRuleAdherence({
    rule_id: ruleA.ruleId,
    task_episode_id: ruleAEpisodeIds[0]!,
    verdict: "followed",
    quote: '"checked with you before renaming anything"',
    llm_call_id: null,
    run_id: null,
  });
  store.recordRuleAdherence({
    rule_id: ruleA.ruleId,
    task_episode_id: ruleAEpisodeIds[1]!,
    verdict: "followed",
    quote: '"kept the old route working alongside the new one"',
    llm_call_id: null,
    run_id: null,
  });
  store.recordRuleAdherence({
    rule_id: ruleA.ruleId,
    task_episode_id: ruleAEpisodeIds[2]!,
    verdict: "followed",
    quote: '"asked first this time"',
    llm_call_id: null,
    run_id: null,
  });
  store.recordRuleVerdict({
    rule_id: ruleA.ruleId,
    verdict: "helped",
    note: "Demo: no more surprise route renames since this was added.",
  });

  // ---- rule_health + the single open retirement proposal (Rule B only). ----
  recomputeRuleHealth();
  proposeRetirements();

  // ---- Pending #2: ordinary confidence, never decided. ----
  demoImprovementSeed({
    projectId,
    idBase: "p2",
    episodeTitle: "Demo: empty-state illustration disappears in dark mode",
    episodeSummary: "Demo: the empty-state illustration has no dark-mode version.",
    userText: "The empty-state illustration is invisible in dark mode -- it's just a white box.",
    assistantText: "Good catch -- I'll make sure the illustration has a dark-mode version too.",
    hoursAgo: 200,
    classification: "defect_correction",
    candidateSummary: "Demo: keep the empty-state illustration visible in dark mode too.",
    confidence: 0.72,
    evidenceReason:
      "Seeded by npm run harness:demo -- --add to exercise a second, ordinary pending Inbox item.",
    observedProblem: "The empty-state illustration was invisible against the dark-mode background.",
    desiredBehavior: "Give every empty-state illustration a dark-mode-aware version.",
    reuseRationale: "Applies to any empty-state illustration, not just this one screen.",
    scope: "project",
    instruction: RULE_P2_INSTRUCTION,
    appliesWhen: "adding or changing an empty-state illustration",
    predictedFailure: "an empty-state illustration is invisible or illegible in dark mode",
  });

  // ---- Pending #3: low confidence -> the "Harness wasn't sure" line in
  // automatic mode. Rule created_by mirrors propose.ts's own
  // `${provider}/${model} (rule writer)` actor string, and the candidate
  // carries the same agent_actions(role='rule_writer', structured_output)
  // shape propose.ts writes, including the explicit
  // duplicate_of_rule_id/contradicts_rule_id: null fields. ----
  const p3Seed = demoImprovementSeed({
    projectId,
    idBase: "p3",
    episodeTitle: "Demo: formatted a date inline instead of using the shared helper",
    episodeSummary: "Demo: a date was formatted inline instead of through the shared helper.",
    userText: "Please use the shared date formatter instead of formatting dates inline like that.",
    assistantText:
      "Got it -- I'll use the shared date-formatting helper instead of formatting dates inline.",
    hoursAgo: 190,
    classification: "missing_requirement",
    candidateSummary: "Demo: use the shared date-formatting helper everywhere.",
    confidence: 0.55,
    evidenceReason: "mined from 1 corrections",
    observedProblem:
      "A date was formatted inline instead of through the shared date-formatting helper.",
    desiredBehavior:
      "Always use the shared date-formatting helper instead of formatting dates inline.",
    reuseRationale: "Reusable across the workspace: mined from 1 correction.",
    scope: "project",
    instruction: RULE_P3_INSTRUCTION,
    appliesWhen: "displaying any date or timestamp",
    predictedFailure: RULE_P3_PREDICTED_FAILURE,
    createdBy: "demo/demo-writer (rule writer)",
    classificationMeta: {
      provider: "demo",
      model: "demo-writer",
      role: "rule_writer",
      structured_output: {
        propose: true,
        instruction: RULE_P3_INSTRUCTION,
        prediction: RULE_P3_PREDICTED_FAILURE,
        scope: "project",
        confidence: 0.55,
        failure_signature: "inline-date-formatting",
        duplicate_of_rule_id: null,
        contradicts_rule_id: null,
        evidence_message_ids: [],
      },
    },
  });
  // Mirrors propose.ts's own createVerificationPlan call for every mined
  // rule (same failure_signature/failure_condition/created_by shape) --
  // read-only decoration for the Instructions/Improvement detail views;
  // this rule is never written, so it has no effect on rule_health.
  store.createVerificationPlan({
    rule_id: p3Seed.ruleId,
    failure_signature: "inline-date-formatting",
    failure_condition: RULE_P3_PREDICTED_FAILURE,
    created_by: "harness rule writer",
    verification_definition_ids: [],
  });

  // ---- Accepted automatically: decided_by='automatic', confidence 0.91.
  // Controller fix round 1 (critical): WRITTEN, not left staged/pending --
  // a pending version here would be exactly what the executor's
  // executeWrites() picks up and writes to the owner's real Lovable
  // project at the next sync, and stageApprovedWrites() would find an
  // 'approved' rule with no written/pending version and re-stage one on
  // its own. "Accepted automatically" is still distinguishable from a
  // normal accept via decided_by='automatic' on an already-written rule
  // -- see the module header comment for why "Waiting to be written" is
  // therefore not demoed at all. ----
  const autoSeed = demoImprovementSeed({
    projectId,
    idBase: "auto",
    episodeTitle: "Demo: used a hardcoded margin instead of a spacing token",
    episodeSummary: "Demo: a hardcoded margin was used instead of a design-system spacing token.",
    userText: "You used a hardcoded margin again instead of one of our spacing tokens.",
    assistantText:
      "You're right -- I'll use the design system's spacing tokens instead of hardcoded margins.",
    hoursAgo: 180,
    classification: "constraint_restatement",
    candidateSummary: "Demo: always use the design system's spacing tokens.",
    confidence: 0.91,
    evidenceReason:
      "Seeded by npm run harness:demo -- --add to exercise the automatic decision-mode accept path.",
    observedProblem: "A hardcoded margin was used instead of a design-system spacing token.",
    desiredBehavior:
      "Always use one of the design system's spacing tokens instead of a hardcoded margin.",
    reuseRationale: "Applies to any spacing value anywhere in the UI.",
    scope: "project",
    instruction: RULE_AUTO_INSTRUCTION,
    appliesWhen: "setting any margin, padding, or gap value",
    predictedFailure: "spacing drifts away from the design system, one hardcoded value at a time",
  });
  store.recordHumanCorrectionDecision({
    id: autoSeed.candidateId,
    final_classification: "constraint_restatement",
    reusable: true,
    proposed_scope: "project",
    reviewer: "harness (automatic)",
  });
  store.setCandidateDecidedBy(autoSeed.candidateId, "automatic");
  const autoBaseDoc = BASE_KNOWLEDGE_DOC;
  const autoV1 = composeManagedKnowledge(autoBaseDoc, [
    { id: autoSeed.ruleId, instruction: RULE_AUTO_INSTRUCTION },
  ]);
  writeDemoVersion({
    target: "project",
    projectId,
    ruleId: autoSeed.ruleId,
    ruleIds: [autoSeed.ruleId],
    previous: autoBaseDoc,
    next: autoV1.final_content,
    reason: "demo: initial Knowledge write (accepted automatically)",
    hoursAgo: 2,
  });

  // ---- Reverted: written, then restored -> "Reverted". ----
  const revertedSeed = demoImprovementSeed({
    projectId,
    idBase: "reverted",
    episodeTitle: "Demo: shipped the beta features menu to everyone",
    episodeSummary: "Demo: the beta features menu was visible outside the beta group.",
    userText:
      "The beta features menu is showing for every user, not just beta testers -- please turn it off for everyone else.",
    assistantText:
      "On it -- I'll disable the beta features menu for everyone outside the beta group.",
    hoursAgo: 170,
    classification: "defect_correction",
    candidateSummary: "Demo: disable the beta features menu for everyone outside the beta group.",
    confidence: 0.8,
    evidenceReason:
      "Seeded by npm run harness:demo -- --add to exercise a written-then-reverted rule.",
    observedProblem: "The beta features menu was visible to every user, not just beta testers.",
    desiredBehavior: "Only show the beta features menu to users in the beta group.",
    reuseRationale: "One-off narrowing of an existing feature's visibility.",
    scope: "project",
    instruction: RULE_REVERTED_INSTRUCTION,
    appliesWhen: "changing which users can see the beta features menu",
    predictedFailure: "the beta features menu is visible to users outside the beta group",
  });
  store.recordHumanCorrectionDecision({
    id: revertedSeed.candidateId,
    final_classification: "defect_correction",
    reusable: true,
    proposed_scope: "project",
    reviewer: "demo",
  });
  const revertedBaseDoc = BASE_KNOWLEDGE_DOC;
  const revertedV1 = composeManagedKnowledge(revertedBaseDoc, [
    { id: revertedSeed.ruleId, instruction: RULE_REVERTED_INSTRUCTION },
  ]);
  const revertedV1Id = writeDemoVersion({
    target: "project",
    projectId,
    ruleId: revertedSeed.ruleId,
    ruleIds: [revertedSeed.ruleId],
    previous: revertedBaseDoc,
    next: revertedV1.final_content,
    reason: "demo: initial Knowledge write",
    hoursAgo: 165,
  });
  const restoreVersion = store.createRestoreVersion(
    revertedV1Id,
    "demo",
    "demo: reverted -- this ended up hiding the menu for the beta group too",
  ) as { id: number };
  store.recordKnowledgeReadback(restoreVersion.id, revertedBaseDoc);
  backdateKnowledgeVersion(restoreVersion.id, 3);

  // ---- Skipped: excluded, with a skip_reason. ----
  const skippedSeed = demoImprovementSeed({
    projectId,
    idBase: "skipped",
    episodeTitle: "Demo: asked to rename the Settings tab",
    episodeSummary: "Demo: a request to rename the Settings tab to Preferences.",
    userText: "Can you rename the Settings tab to Preferences?",
    assistantText: "Sure -- I'll rename the Settings tab to Preferences.",
    hoursAgo: 160,
    classification: "preference_revision",
    candidateSummary: "Demo: rename the Settings tab to Preferences.",
    confidence: 0.6,
    evidenceReason: "Seeded by npm run harness:demo -- --add to exercise the skipped state.",
    observedProblem: "The user asked for the Settings tab to be renamed.",
    desiredBehavior: "Call the tab Preferences instead of Settings.",
    reuseRationale: "A one-off naming preference, not obviously worth a standing rule.",
    scope: "project",
    instruction: RULE_SKIPPED_INSTRUCTION,
    appliesWhen: "labeling the Settings tab",
    predictedFailure: "the tab is labeled Settings instead of Preferences",
  });
  store.reviewCorrectionCandidate({
    id: skippedSeed.candidateId,
    action: "exclude",
    reviewer: "demo",
  });
  store.setCandidateSkipReason(skippedSeed.candidateId, "wrong_wording");
  store.updateRule({ id: skippedSeed.ruleId, state: "rejected", actor: "demo" });

  // ---- Needs attention: staged, then marked stale. Controller fix round 1
  // (critical): once the version is stale, the rule's state is moved off
  // 'approved' -- an 'approved' rule with no pending/written version is
  // exactly what stageApprovedWrites() recomposes and re-stages a fresh
  // write for on the next real sync (that's its intended recovery
  // behavior for a genuinely live stale write; here it would just write
  // demo text into the owner's real project). 'testing' keeps
  // decision.status "accepted" (so the item still reads "Needs attention"
  // via its write_status) without being in activeRulesForTarget's
  // ('approved','supported','active') set either, so it's never composed
  // into a future real write. ----
  const staleSeed = demoImprovementSeed({
    projectId,
    idBase: "stale",
    episodeTitle: "Demo: loaded the entire activity feed at once",
    episodeSummary: "Demo: the activity feed loads everything at once instead of paginating.",
    userText: "The activity feed loads everything at once -- please paginate it.",
    assistantText: "Understood -- I'll make sure the activity feed is always paginated.",
    hoursAgo: 150,
    classification: "missing_requirement",
    candidateSummary: "Demo: always paginate the activity feed.",
    confidence: 0.78,
    evidenceReason:
      "Seeded by npm run harness:demo -- --add to exercise the needs-attention (stale write) state.",
    observedProblem: "The activity feed loaded every row at once instead of paginating.",
    desiredBehavior: "Always paginate the activity feed rather than loading it all at once.",
    reuseRationale: "Applies to any long, growing list, not just this feed.",
    scope: "project",
    instruction: RULE_STALE_INSTRUCTION,
    appliesWhen: "rendering the activity feed or any similarly unbounded list",
    predictedFailure: "the activity feed loads unboundedly instead of paginating",
  });
  improvementAction(
    { action: "accept", id: staleSeed.candidateId, destination: "project" },
    "demo",
  );
  const stalePendingId = latestPendingVersionId(staleSeed.ruleId);
  backdateVersionCreatedAt(stalePendingId, 4);
  store.markKnowledgeWriteStale(
    stalePendingId,
    "demo: Knowledge changed in Lovable before Harness could write this",
  );
  store.updateRule({
    id: staleSeed.ruleId,
    state: "testing",
    actor: "demo",
    reason: "demo: moved off 'approved' so the executor never auto-retries this stale write",
  });

  // ---- Retired: written, then retired directly (rule.state='retired'). ----
  const retiredSeed = demoImprovementSeed({
    projectId,
    idBase: "retired",
    episodeTitle: "Demo: deployed despite a failing type check",
    episodeSummary: "Demo: a deploy went out even though the type check was failing.",
    userText: "Please don't deploy if the type check is failing.",
    assistantText: "Agreed -- I'll block deploys whenever the type check fails.",
    hoursAgo: 140,
    classification: "constraint_restatement",
    candidateSummary: "Demo: block deploys whenever the type check is failing.",
    confidence: 0.83,
    evidenceReason: "Seeded by npm run harness:demo -- --add to exercise a retired rule.",
    observedProblem: "A deploy went out while the type check was failing.",
    desiredBehavior: "Never deploy while the type check is failing.",
    reuseRationale: "Applies to every deploy, not just this one.",
    scope: "project",
    instruction: RULE_RETIRED_INSTRUCTION,
    appliesWhen: "running a deploy",
    predictedFailure: "a deploy goes out despite a failing type check",
  });
  store.recordHumanCorrectionDecision({
    id: retiredSeed.candidateId,
    final_classification: "constraint_restatement",
    reusable: true,
    proposed_scope: "project",
    reviewer: "demo",
  });
  const retiredBaseDoc = BASE_KNOWLEDGE_DOC;
  const retiredV1 = composeManagedKnowledge(retiredBaseDoc, [
    { id: retiredSeed.ruleId, instruction: RULE_RETIRED_INSTRUCTION },
  ]);
  writeDemoVersion({
    target: "project",
    projectId,
    ruleId: retiredSeed.ruleId,
    ruleIds: [retiredSeed.ruleId],
    previous: retiredBaseDoc,
    next: retiredV1.final_content,
    reason: "demo: initial Knowledge write",
    hoursAgo: 135,
  });
  store.updateRule({
    id: retiredSeed.ruleId,
    state: "retired",
    actor: "demo",
    reason: "demo: turned out to block legitimate hotfixes too often -- retired",
  });

  // ---- Waiting to be tested: accepted with test_first, never written. ----
  const testFirstSeed = demoImprovementSeed({
    projectId,
    idBase: "testfirst",
    episodeTitle: "Demo: asked to test a brand teal primary button before committing",
    episodeSummary: "Demo: a request to try the brand teal primary button as a test first.",
    userText:
      "Before you commit to it everywhere, can we test switching the primary button to the brand teal first?",
    assistantText:
      "Good idea -- I'll set up a test with the brand teal primary button before applying it everywhere.",
    hoursAgo: 130,
    classification: "preference_revision",
    candidateSummary: "Demo: switch the primary button color to the brand teal.",
    confidence: 0.7,
    evidenceReason:
      "Seeded by npm run harness:demo -- --add to exercise the test-first (Waiting to be tested) state.",
    observedProblem:
      "The user wants to try the brand teal primary button before committing to it everywhere.",
    desiredBehavior: "Use the brand teal as the primary button color, once tested.",
    reuseRationale:
      "A visual preference the user wants proven out before it becomes a standing rule.",
    scope: "project",
    instruction: RULE_TESTFIRST_INSTRUCTION,
    appliesWhen: "styling the primary button",
    predictedFailure: "the primary button color drifts away from the brand teal",
  });
  improvementAction(
    {
      action: "accept",
      id: testFirstSeed.candidateId,
      destination: "project",
      test_first: true,
    },
    "demo",
  );

  // ---- One external_change snapshot: Knowledge edited in Lovable outside
  // Harness. Recorded strictly after the project's existing snapshot above,
  // with content that matches no recorded version -- buildTimeline's own
  // sha comparison (listKnowledgeSnapshots orders by id, not fetched_at) is
  // what turns this into an external_change node. ----
  const externalChangeContent = `${v3.final_content}\n<!-- Demo: edited directly in Lovable, outside Harness -->\n`;
  const externalSnapshot = store.recordKnowledgeSnapshot({
    target: "project",
    project_id: projectId,
    content: externalChangeContent,
    fetched_by: "demo",
  }) as { id: number };
  backdateKnowledgeSnapshot(externalSnapshot.id, 1);

  // ---- One workspace Knowledge snapshot, so the workspace target has the
  // same "latest known Lovable content" preview data the project target has. ----
  const workspaceSnapshot = store.recordKnowledgeSnapshot({
    target: "workspace",
    workspace_id: workspaceId,
    content: ruleBv3.final_content,
    fetched_by: "demo",
  }) as { id: number };
  backdateKnowledgeSnapshot(workspaceSnapshot.id, 310);

  // ---- Skills: 2 more deploy-checklist snapshots (3 total with the one
  // above), and a new "Demo: review-checklist" skill with 3 snapshots. ----
  const deploySnap2 = store.recordSkillSnapshot({
    workspace_id: workspaceId,
    name: SKILL_NAME,
    description: "Steps to check before deploying (demo).",
    content: DEPLOY_CHECKLIST_V2,
    updated_at_remote: null,
    fetched_by: "demo",
  });
  backdateSkillSnapshot(deploySnap2.id, 100);
  const deploySnap3 = store.recordSkillSnapshot({
    workspace_id: workspaceId,
    name: SKILL_NAME,
    description: "Steps to check before deploying (demo).",
    content: DEPLOY_CHECKLIST_V3,
    updated_at_remote: null,
    fetched_by: "demo",
  });
  backdateSkillSnapshot(deploySnap3.id, 20);

  const reviewSnap1 = store.recordSkillSnapshot({
    workspace_id: workspaceId,
    name: SKILL_NAME_2,
    description: "Demo: what to check before approving a PR.",
    content: REVIEW_CHECKLIST_V1,
    updated_at_remote: null,
    fetched_by: "demo",
  });
  backdateSkillSnapshot(reviewSnap1.id, 210);
  const reviewSnap2 = store.recordSkillSnapshot({
    workspace_id: workspaceId,
    name: SKILL_NAME_2,
    description: "Demo: what to check before approving a PR.",
    content: REVIEW_CHECKLIST_V2,
    updated_at_remote: null,
    fetched_by: "demo",
  });
  backdateSkillSnapshot(reviewSnap2.id, 90);
  const reviewSnap3 = store.recordSkillSnapshot({
    workspace_id: workspaceId,
    name: SKILL_NAME_2,
    description: "Demo: what to check before approving a PR.",
    content: REVIEW_CHECKLIST_V3,
    updated_at_remote: null,
    fetched_by: "demo",
  });
  backdateSkillSnapshot(reviewSnap3.id, 10);

  return {
    added: true,
    project_id: projectId,
    message: `Demo data added for project ${projectId}.`,
  };
}

export type RemoveDemoResult = { removed: boolean; counts: Record<string, number> };

export function removeDemoData(): RemoveDemoResult {
  // Task 8: broadened from the original exact two-title match to every
  // "Demo:"-titled episode -- the same "Demo:" prefix every demo row's
  // title/instruction/name carries (global rule), so the cascade below
  // (episodes -> candidates -> learnings -> rules -> versions -> ...) picks
  // up every improvement this module ever seeds, not just the original two.
  //
  // Controller fix round 1 (important): a bare "title starts with Demo:"
  // match is not provenance-checked -- a real user could title their own
  // episode "Demo: ..." and have it swept. Tightened to also require every
  // one of that episode's evidence history items to carry
  // source_ref = 'demo-seed' (every demoMessage() call in this file sets
  // it); a real episode's evidence never does. The two original exact
  // titles are kept as an unconditional OR-branch, with no provenance
  // check, for backward compatibility with a demo already loaded by an
  // older version of this module (before source_ref was relied on here).
  const episodes = db
    .prepare(
      `SELECT id, project_id FROM task_episodes
       WHERE title IN (?, ?)
          OR (
            title LIKE 'Demo:%'
            AND NOT EXISTS (
              SELECT 1 FROM task_episode_evidence tee
              JOIN history_items hi ON hi.id = tee.history_item_id
              WHERE tee.task_episode_id = task_episodes.id
                AND (hi.source_ref IS NULL OR hi.source_ref != 'demo-seed')
            )
          )`,
    )
    .all(EPISODE_TITLE_PENDING, EPISODE_TITLE_WRITTEN) as {
    id: number;
    project_id: string | null;
  }[];

  const skillNames = [SKILL_NAME, SKILL_NAME_2];
  const skillCount = (
    db
      .prepare(
        `SELECT COUNT(*) as n FROM skill_snapshots WHERE fetched_by = 'demo' AND name IN (${skillNames.map(() => "?").join(",")})`,
      )
      .get(...skillNames) as { n: number }
  ).n;

  if (episodes.length === 0 && skillCount === 0) {
    return { removed: false, counts: {} };
  }

  const episodeIds = episodes.map((e) => e.id);
  const projectId = episodes.find((e) => e.project_id)?.project_id ?? null;
  const workspaceId = projectId
    ? (store.getProjectMeta(projectId)?.workspace_id ?? "demo-workspace")
    : "demo-workspace";
  const placeholders = (ids: number[]) => ids.map(() => "?").join(",");

  const ccIds = episodeIds.length
    ? (
        db
          .prepare(
            `SELECT id FROM correction_candidates WHERE task_episode_id IN (${placeholders(episodeIds)})`,
          )
          .all(...episodeIds) as { id: number }[]
      ).map((r) => r.id)
    : [];
  const learningIds = ccIds.length
    ? (
        db
          .prepare(
            `SELECT id FROM learnings WHERE correction_candidate_id IN (${placeholders(ccIds)})`,
          )
          .all(...ccIds) as { id: number }[]
      ).map((r) => r.id)
    : [];
  const ruleIds = ccIds.length
    ? (
        db
          .prepare(`SELECT id FROM rules WHERE correction_candidate_id IN (${placeholders(ccIds)})`)
          .all(...ccIds) as { id: number }[]
      ).map((r) => r.id)
    : [];

  const historyIds = new Set<number>();
  if (episodeIds.length) {
    for (const row of db
      .prepare(
        `SELECT history_item_id FROM task_episode_evidence WHERE task_episode_id IN (${placeholders(episodeIds)})`,
      )
      .all(...episodeIds) as { history_item_id: number }[]) {
      historyIds.add(row.history_item_id);
    }
  }
  if (ccIds.length) {
    for (const row of db
      .prepare(
        `SELECT history_item_id FROM correction_candidate_evidence WHERE correction_candidate_id IN (${placeholders(ccIds)})`,
      )
      .all(...ccIds) as { history_item_id: number }[]) {
      historyIds.add(row.history_item_id);
    }
  }
  const historyIdList = [...historyIds];

  // Gathered up front (not just counted) because events.ts's cleanup below
  // needs the actual ids, not just how many rows matched.
  const versionIds = ruleIds.length
    ? (
        db
          .prepare(`SELECT id FROM knowledge_versions WHERE rule_id IN (${placeholders(ruleIds)})`)
          .all(...ruleIds) as { id: number }[]
      ).map((r) => r.id)
    : [];
  const knowledgeSnapshotIds = projectId
    ? (
        db
          .prepare(
            `SELECT id FROM knowledge_snapshots WHERE fetched_by = 'demo' AND target = 'project' AND project_id = ?`,
          )
          .all(projectId) as { id: number }[]
      ).map((r) => r.id)
    : [];
  const workspaceKnowledgeSnapshotIds = (
    db
      .prepare(
        `SELECT id FROM knowledge_snapshots WHERE fetched_by = 'demo' AND target = 'workspace' AND workspace_id = ?`,
      )
      .all(workspaceId) as { id: number }[]
  ).map((r) => r.id);
  const skillSnapshotIds = (
    db
      .prepare(
        `SELECT id FROM skill_snapshots WHERE fetched_by = 'demo' AND name IN (${skillNames.map(() => "?").join(",")})`,
      )
      .all(...skillNames) as { id: number }[]
  ).map((r) => r.id);

  // Round 5 Task 8: the new tables this seed can touch, gathered the same
  // way -- by the rule ids the cascade above already found. rule_health has
  // no id of its own (rule_id is its primary key), so it's deleted by
  // rule_id directly; the others get their own row ids gathered here (both
  // for the DELETE below and for the events sweep further down).
  const ruleVerdictIds = ruleIds.length
    ? (
        db
          .prepare(`SELECT id FROM rule_verdicts WHERE rule_id IN (${placeholders(ruleIds)})`)
          .all(...ruleIds) as { id: number }[]
      ).map((r) => r.id)
    : [];
  const retireProposalIds = ruleIds.length
    ? (
        db
          .prepare(`SELECT id FROM retire_proposals WHERE rule_id IN (${placeholders(ruleIds)})`)
          .all(...ruleIds) as { id: number }[]
      ).map((r) => r.id)
    : [];
  const experimentPlanIds = ruleIds.length
    ? (
        db
          .prepare(`SELECT id FROM experiment_plans WHERE rule_id IN (${placeholders(ruleIds)})`)
          .all(...ruleIds) as { id: number }[]
      ).map((r) => r.id)
    : [];
  // Fix round 1 (optional minor): the "wasn't sure" item's verification_plan.
  const verificationPlanIds = ruleIds.length
    ? (
        db
          .prepare(`SELECT id FROM verification_plans WHERE rule_id IN (${placeholders(ruleIds)})`)
          .all(...ruleIds) as { id: number }[]
      ).map((r) => r.id)
    : [];

  const counts: Record<string, number> = {};
  const run = db.transaction(() => {
    // Round 5 Task 8: every new table is a CHILD of rules (or, for
    // message_classifications, of history_items) with an enforced foreign
    // key (harness/src/db.ts sets `PRAGMA foreign_keys = ON`), so all of
    // these must be deleted before rules/history_items are -- hence first,
    // ahead of the original steps below.
    counts.rule_adherence = ruleIds.length
      ? db
          .prepare(`DELETE FROM rule_adherence WHERE rule_id IN (${placeholders(ruleIds)})`)
          .run(...ruleIds).changes
      : 0;
    counts.rule_verdicts = ruleVerdictIds.length
      ? db
          .prepare(`DELETE FROM rule_verdicts WHERE id IN (${placeholders(ruleVerdictIds)})`)
          .run(...ruleVerdictIds).changes
      : 0;
    counts.rule_health = ruleIds.length
      ? db
          .prepare(`DELETE FROM rule_health WHERE rule_id IN (${placeholders(ruleIds)})`)
          .run(...ruleIds).changes
      : 0;
    counts.retire_proposals = retireProposalIds.length
      ? db
          .prepare(`DELETE FROM retire_proposals WHERE id IN (${placeholders(retireProposalIds)})`)
          .run(...retireProposalIds).changes
      : 0;
    counts.experiment_plans = experimentPlanIds.length
      ? db
          .prepare(`DELETE FROM experiment_plans WHERE id IN (${placeholders(experimentPlanIds)})`)
          .run(...experimentPlanIds).changes
      : 0;
    // No verification_plan_items are ever created for the demo (every
    // createVerificationPlan call above passes verification_definition_ids:
    // []), so the plan row itself has nothing else pointing at it.
    counts.verification_plans = verificationPlanIds.length
      ? db
          .prepare(
            `DELETE FROM verification_plans WHERE id IN (${placeholders(verificationPlanIds)})`,
          )
          .run(...verificationPlanIds).changes
      : 0;
    counts.message_classifications = historyIdList.length
      ? db
          .prepare(
            `DELETE FROM message_classifications WHERE history_item_id IN (${placeholders(historyIdList)})`,
          )
          .run(...historyIdList).changes
      : 0;

    // 1. knowledge_versions
    counts.knowledge_versions = versionIds.length
      ? db
          .prepare(`DELETE FROM knowledge_versions WHERE id IN (${placeholders(versionIds)})`)
          .run(...versionIds).changes
      : 0;

    // 2. knowledge_snapshots (only the ones this seed fetched, both targets)
    const projectSnapshotsDeleted = knowledgeSnapshotIds.length
      ? db
          .prepare(
            `DELETE FROM knowledge_snapshots WHERE id IN (${placeholders(knowledgeSnapshotIds)})`,
          )
          .run(...knowledgeSnapshotIds).changes
      : 0;
    const workspaceSnapshotsDeleted = workspaceKnowledgeSnapshotIds.length
      ? db
          .prepare(
            `DELETE FROM knowledge_snapshots WHERE id IN (${placeholders(workspaceKnowledgeSnapshotIds)})`,
          )
          .run(...workspaceKnowledgeSnapshotIds).changes
      : 0;
    counts.knowledge_snapshots = projectSnapshotsDeleted + workspaceSnapshotsDeleted;

    // agent_actions created by recordHumanCorrectionDecision and by
    // createCorrectionCandidate's classification_meta handling (no FK, but
    // still a demo-created row)
    counts.agent_actions = ccIds.length
      ? db
          .prepare(
            `DELETE FROM agent_actions WHERE target_table = 'correction_candidates' AND target_id IN (${placeholders(ccIds)})`,
          )
          .run(...ccIds).changes
      : 0;

    // 3. rules (+ their rule_revisions first)
    if (ruleIds.length) {
      db.prepare(`DELETE FROM rule_revisions WHERE rule_id IN (${placeholders(ruleIds)})`).run(
        ...ruleIds,
      );
      counts.rules = db
        .prepare(`DELETE FROM rules WHERE id IN (${placeholders(ruleIds)})`)
        .run(...ruleIds).changes;
    } else {
      counts.rules = 0;
    }

    // 4. learnings
    counts.learnings = learningIds.length
      ? db
          .prepare(`DELETE FROM learnings WHERE id IN (${placeholders(learningIds)})`)
          .run(...learningIds).changes
      : 0;

    // 5. candidates + evidence
    if (ccIds.length) {
      db.prepare(
        `DELETE FROM correction_candidate_evidence WHERE correction_candidate_id IN (${placeholders(ccIds)})`,
      ).run(...ccIds);
      counts.correction_candidates = db
        .prepare(`DELETE FROM correction_candidates WHERE id IN (${placeholders(ccIds)})`)
        .run(...ccIds).changes;
    } else {
      counts.correction_candidates = 0;
    }

    // 6. episodes + evidence
    if (episodeIds.length) {
      db.prepare(
        `DELETE FROM task_episode_evidence WHERE task_episode_id IN (${placeholders(episodeIds)})`,
      ).run(...episodeIds);
      counts.task_episodes = db
        .prepare(`DELETE FROM task_episodes WHERE id IN (${placeholders(episodeIds)})`)
        .run(...episodeIds).changes;
    } else {
      counts.task_episodes = 0;
    }

    // 7. history items
    counts.history_items = historyIdList.length
      ? db
          .prepare(`DELETE FROM history_items WHERE id IN (${placeholders(historyIdList)})`)
          .run(...historyIdList).changes
      : 0;

    // 8. skill snapshots
    counts.skill_snapshots = skillSnapshotIds.length
      ? db
          .prepare(`DELETE FROM skill_snapshots WHERE id IN (${placeholders(skillSnapshotIds)})`)
          .run(...skillSnapshotIds).changes
      : 0;

    // 9. events -- every insertEvent() row the pipeline above created. Each
    // event's payload is JSON with either an "id" field (most kinds) or,
    // for the two kinds whose store.ts writer never included one
    // (rule_adherence.recorded, rule_health.upserted), a "rule_id" field --
    // matched by kind prefix + exact numeric payload field, never a LIKE
    // substring match, so a demo id can never accidentally sweep up an
    // unrelated real event whose payload happens to share a numeric
    // substring.
    const eventIds = eventIdsReferencing([
      { prefixes: ["history_item."], ids: historyIdList },
      { prefixes: ["task_episode."], ids: episodeIds },
      { prefixes: ["correction_candidate."], ids: ccIds },
      { prefixes: ["learning."], ids: learningIds },
      { prefixes: ["rule."], ids: ruleIds },
      { prefixes: ["knowledge_version."], ids: versionIds },
      {
        prefixes: ["knowledge_snapshot."],
        ids: [...knowledgeSnapshotIds, ...workspaceKnowledgeSnapshotIds],
      },
      { prefixes: ["skill_snapshot."], ids: skillSnapshotIds },
      { prefixes: ["rule_verdict."], ids: ruleVerdictIds },
      { prefixes: ["rule_adherence."], ids: ruleIds, field: "rule_id" },
      { prefixes: ["rule_health."], ids: ruleIds, field: "rule_id" },
      { prefixes: ["retire_proposal."], ids: retireProposalIds },
      { prefixes: ["experiment_plan."], ids: experimentPlanIds },
      { prefixes: ["verification_plan."], ids: verificationPlanIds },
    ]);
    counts.events = eventIds.length
      ? db.prepare(`DELETE FROM events WHERE id IN (${placeholders(eventIds)})`).run(...eventIds)
          .changes
      : 0;
  });
  run();

  return { removed: true, counts };
}

// Finds every `events` row whose kind starts with one of a group's prefixes
// and whose JSON payload's top-level field (payload.id by default, or
// `field` when a group names a different one -- some Round 5 event writers
// never included an "id" at all, only a "rule_id") exactly equals one of
// that group's ids. Reads the whole (small, append-only) table once rather
// than building fragile LIKE patterns -- an exact numeric comparison after
// JSON.parse can't be fooled by a numeric substring the way
// `payload LIKE '%"id":<n>%'` can (e.g. id 12 inside "id":123).
function eventIdsReferencing(
  groups: { prefixes: string[]; ids: number[]; field?: string }[],
): number[] {
  const active = groups.filter((g) => g.ids.length > 0);
  if (!active.length) return [];
  const idSets = active.map((g) => new Set(g.ids));

  const rows = db.prepare(`SELECT id, kind, payload FROM events`).all() as {
    id: number;
    kind: string;
    payload: string | null;
  }[];

  const matched: number[] = [];
  for (const row of rows) {
    if (!row.payload) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.payload);
    } catch {
      continue;
    }
    for (let i = 0; i < active.length; i += 1) {
      const group = active[i]!;
      if (!group.prefixes.some((p) => row.kind.startsWith(p))) continue;
      const fieldValue = (parsed as Record<string, unknown> | null)?.[group.field ?? "id"];
      if (typeof fieldValue === "number" && idSets[i]!.has(fieldValue)) {
        matched.push(row.id);
        break;
      }
    }
  }
  return matched;
}

export function demoStatus(): { loaded: boolean; message: string } {
  const loaded = demoLoaded();
  return {
    loaded,
    message: loaded
      ? "Demo data is loaded. Remove it with: npm run harness:demo -- --remove"
      : "No demo data is loaded.",
  };
}

function main(): void {
  const arg = process.argv[2];
  if (arg === "--add") {
    const result = addDemoData();
    console.log(result.message);
    return;
  }
  if (arg === "--remove") {
    const result = removeDemoData();
    console.log(
      result.removed
        ? `Demo data removed: ${JSON.stringify(result.counts)}`
        : "No demo data found; nothing to remove.",
    );
    return;
  }
  if (arg === "--status") {
    console.log(demoStatus().message);
    return;
  }
  console.error("Usage: npm run demo -- --add | --remove | --status");
  process.exitCode = 1;
}

const isMainModule =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolvePath(process.argv[1]);
if (isMainModule) {
  main();
}
