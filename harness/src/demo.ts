/**
 * Removable demo data: `npm run demo -- --add | --remove | --status`
 * (from the repo root: `npm run harness:demo -- --add | --remove | --status`).
 *
 * `--add` builds two Improvements end to end through the real store.ts
 * pipeline (history items -> task episode -> correction candidate ->
 * learning -> rule -> knowledge versions) for the first allowed project, so
 * the local UI has something real to show: one still sitting in the Inbox
 * awaiting a decision, one already accepted with its rule written into the
 * project's Knowledge across three realistic versions (so the Instructions
 * page's "What changed" diff view has real history to render), plus one
 * workspace Skill snapshot. Every row it creates is identified by a fixed
 * title/name, so `--add` is idempotent and `--remove` deletes exactly those
 * rows -- nothing a real user created is ever touched.
 *
 * This module writes nothing to Lovable -- it is pure local bookkeeping,
 * exactly like the rest of the store.ts pipeline it drives.
 */
import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";
import { db } from "./db.js";
import * as store from "./store.js";
import { composeManagedKnowledge } from "./knowledge.js";

const EPISODE_TITLE_PENDING = "Demo: keep the sidebar order stable";
const EPISODE_TITLE_WRITTEN = "Demo: never add a cron job without asking";
const RULE_INSTRUCTION_PENDING = "Demo: keep the sidebar order stable.";
const RULE_INSTRUCTION_WRITTEN = "Demo: never add a cron job without asking.";
const RULE_INSTRUCTION_WRITTEN_V2 =
  "Demo: never add a cron job without asking. Always confirm the schedule and frequency with the user first.";
const RULE_INSTRUCTION_WRITTEN_V3 =
  "Demo: never add a cron job without asking. Always confirm the schedule, frequency, and estimated resource cost with the user first.";
const SKILL_NAME = "deploy-checklist";
const BASE_KNOWLEDGE_DOC =
  "# Project Knowledge\n\nThis project was built with Lovable. Add your own notes above this line.\n";

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

/** Stages, "writes" (via recordKnowledgeReadback) and backdates one demo knowledge version. */
function writeDemoVersion(input: {
  projectId: string;
  ruleId: number;
  ruleIds: number[];
  previous: string;
  next: string;
  reason: string;
  hoursAgo: number;
}): number {
  const version = store.createPendingKnowledgeVersion({
    rule_id: input.ruleId,
    target: "project",
    project_id: input.projectId,
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

  // ---- One workspace Skill snapshot ----
  const workspaceId = store.getProjectMeta(projectId)?.workspace_id ?? "demo-workspace";
  store.recordSkillSnapshot({
    workspace_id: workspaceId,
    name: SKILL_NAME,
    description: "Steps to check before deploying (demo).",
    content:
      "# Deploy checklist (demo)\n\n1. Run the test suite.\n2. Check the build.\n3. Confirm environment variables are set.\n4. Deploy and verify the live preview.\n",
    updated_at_remote: null,
    fetched_by: "demo",
  });

  return {
    added: true,
    project_id: projectId,
    message: `Demo data added for project ${projectId}.`,
  };
}

export type RemoveDemoResult = { removed: boolean; counts: Record<string, number> };

export function removeDemoData(): RemoveDemoResult {
  const episodes = db
    .prepare(`SELECT id, project_id FROM task_episodes WHERE title IN (?, ?)`)
    .all(EPISODE_TITLE_PENDING, EPISODE_TITLE_WRITTEN) as {
    id: number;
    project_id: string | null;
  }[];

  const skillCount = (
    db
      .prepare(`SELECT COUNT(*) as n FROM skill_snapshots WHERE name = ? AND fetched_by = 'demo'`)
      .get(SKILL_NAME) as { n: number }
  ).n;

  if (episodes.length === 0 && skillCount === 0) {
    return { removed: false, counts: {} };
  }

  const episodeIds = episodes.map((e) => e.id);
  const projectId = episodes.find((e) => e.project_id)?.project_id ?? null;
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
  const skillSnapshotIds = (
    db
      .prepare(`SELECT id FROM skill_snapshots WHERE name = ? AND fetched_by = 'demo'`)
      .all(SKILL_NAME) as { id: number }[]
  ).map((r) => r.id);

  const counts: Record<string, number> = {};
  const run = db.transaction(() => {
    // 1. knowledge_versions
    counts.knowledge_versions = versionIds.length
      ? db
          .prepare(`DELETE FROM knowledge_versions WHERE id IN (${placeholders(versionIds)})`)
          .run(...versionIds).changes
      : 0;

    // 2. knowledge_snapshots (only the ones this seed fetched, for this project)
    counts.knowledge_snapshots = knowledgeSnapshotIds.length
      ? db
          .prepare(
            `DELETE FROM knowledge_snapshots WHERE id IN (${placeholders(knowledgeSnapshotIds)})`,
          )
          .run(...knowledgeSnapshotIds).changes
      : 0;

    // agent_actions created by recordHumanCorrectionDecision (no FK, but still a demo-created row)
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
    // event's payload is JSON with an "id" field naming the row it's about
    // (see store.ts's insertEvent callers); matched by kind prefix + exact
    // numeric payload.id, never a LIKE substring match, so a demo id can
    // never accidentally sweep up an unrelated real event whose payload.id
    // happens to share a numeric substring.
    const eventIds = eventIdsReferencing([
      { prefixes: ["history_item."], ids: historyIdList },
      { prefixes: ["task_episode."], ids: episodeIds },
      { prefixes: ["correction_candidate."], ids: ccIds },
      { prefixes: ["learning."], ids: learningIds },
      { prefixes: ["rule."], ids: ruleIds },
      { prefixes: ["knowledge_version."], ids: versionIds },
      { prefixes: ["knowledge_snapshot."], ids: knowledgeSnapshotIds },
      { prefixes: ["skill_snapshot."], ids: skillSnapshotIds },
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
// and whose JSON payload's top-level "id" field exactly equals one of that
// group's ids. Reads the whole (small, append-only) table once rather than
// building fragile LIKE patterns -- an exact numeric comparison after
// JSON.parse can't be fooled by a numeric substring the way
// `payload LIKE '%"id":<n>%'` can (e.g. id 12 inside "id":123).
function eventIdsReferencing(groups: { prefixes: string[]; ids: number[] }[]): number[] {
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
    const payloadId = (parsed as { id?: unknown } | null)?.id;
    if (typeof payloadId !== "number") continue;
    for (let i = 0; i < active.length; i += 1) {
      const group = active[i]!;
      if (idSets[i]!.has(payloadId) && group.prefixes.some((p) => row.kind.startsWith(p))) {
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
