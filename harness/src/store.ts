// Pure data-layer functions, independent of the MCP transport, so tests can
// call them directly. mcp-server.ts is a thin wrapper around this module.
import { db, dbPath } from "./db.js";
import { sha256 as knowledgeSha256 } from "./knowledge.js";
// Round 4 A2's listMinableEpisodes needs to render assistant replies the
// same human-visible way classify.ts does -- a pure, dependency-free helper
// (no import back into store.ts's own surface), so pulling it in here is no
// different from the knowledge.js import just above.
import { humanVisibleText } from "./analysis/reply-text.js";

export class NotAllowedProjectError extends Error {
  constructor(projectId: string) {
    super(`Project ${projectId} is not in allowed_projects`);
    this.name = "NotAllowedProjectError";
  }
}

export class LearningLimitError extends Error {
  constructor(correctionCandidateId: number) {
    super(
      `correction_candidate ${correctionCandidateId} already has 3 learnings -- prefer one precise learning over several overlapping ones`,
    );
    this.name = "LearningLimitError";
  }
}

export function isAllowedProject(lovableProjectId: string): boolean {
  return (
    db
      .prepare(`SELECT 1 FROM allowed_projects WHERE lovable_project_id = ?`)
      .get(lovableProjectId) !== undefined
  );
}

function assertAllowedProject(lovableProjectId: string): void {
  if (!isAllowedProject(lovableProjectId)) {
    throw new NotAllowedProjectError(lovableProjectId);
  }
}

export function insertEvent(kind: string, ref?: string | null, payload?: unknown) {
  return db
    .prepare(`INSERT INTO events (kind, ref, payload) VALUES (?, ?, ?) RETURNING *`)
    .get(kind, ref ?? null, payload === undefined ? null : JSON.stringify(payload));
}

export function listEvents(limit = 50) {
  return db.prepare(`SELECT * FROM events ORDER BY id DESC LIMIT ?`).all(limit);
}

// ---- Checkpoint A (unchanged behavior) ----

export function health() {
  return { ok: true, time: new Date().toISOString(), db_path: dbPath() };
}

export function createTestRecord(note?: string) {
  return db.prepare(`INSERT INTO test_records (note) VALUES (?) RETURNING *`).get(note ?? null);
}

export function getAllowedProjects() {
  return db.prepare(`SELECT * FROM allowed_projects ORDER BY added_at`).all();
}

export function upsertProject(input: {
  lovable_project_id: string;
  name?: string;
  status?: string;
  url?: string;
  tech_stack?: string;
  raw_json?: string;
  workspace_id?: string;
}) {
  return db
    .prepare(
      `INSERT INTO projects (lovable_project_id, name, status, url, tech_stack, raw_json, workspace_id, updated_at)
       VALUES (@lovable_project_id, @name, @status, @url, @tech_stack, @raw_json, @workspace_id, datetime('now'))
       ON CONFLICT(lovable_project_id) DO UPDATE SET
         name = COALESCE(excluded.name, projects.name), status = excluded.status, url = excluded.url,
         tech_stack = excluded.tech_stack, raw_json = excluded.raw_json,
         workspace_id = COALESCE(excluded.workspace_id, projects.workspace_id),
         updated_at = excluded.updated_at
       RETURNING *`,
    )
    .get({
      lovable_project_id: input.lovable_project_id,
      name: input.name ?? null,
      status: input.status ?? null,
      url: input.url ?? null,
      tech_stack: input.tech_stack ?? null,
      raw_json: input.raw_json ?? null,
      workspace_id: input.workspace_id ?? null,
    });
}

export function getProjectMeta(lovableProjectId: string) {
  return (db.prepare(`SELECT * FROM projects WHERE lovable_project_id = ?`).get(lovableProjectId) ??
    null) as {
    lovable_project_id: string;
    name: string | null;
    workspace_id: string | null;
  } | null;
}

// ---- Checkpoint B: correction pipeline ----

const PROVENANCE = [
  "lovable_mcp",
  "git_history",
  "build_log",
  "spec",
  "manual",
  "llm_derived",
] as const;
export type Provenance = (typeof PROVENANCE)[number];

export function createProjectSnapshot(input: {
  lovable_project_id: string;
  label?: string;
  snapshot_json: string;
  provenance: Provenance;
  source_ref?: string;
}) {
  assertAllowedProject(input.lovable_project_id);
  const row = db
    .prepare(
      `INSERT INTO project_snapshots (lovable_project_id, label, snapshot_json, provenance, source_ref)
       VALUES (@lovable_project_id, @label, @snapshot_json, @provenance, @source_ref)
       RETURNING *`,
    )
    .get({
      lovable_project_id: input.lovable_project_id,
      label: input.label ?? null,
      snapshot_json: input.snapshot_json,
      provenance: input.provenance,
      source_ref: input.source_ref ?? null,
    });
  insertEvent("project_snapshot.created", input.lovable_project_id, {
    id: (row as { id: number }).id,
  });
  return row;
}

export function upsertHistoryItem(input: {
  project_id?: string;
  kind: "message" | "diff" | "edit" | "build_log_row" | "spec_excerpt" | "manual_note";
  external_id?: string;
  role?: "user" | "assistant" | "system" | "operator";
  content: string;
  occurred_at?: string;
  provenance: Provenance;
  source_ref?: string;
}) {
  if (input.project_id) assertAllowedProject(input.project_id);

  let row: unknown;
  if (input.project_id && input.external_id) {
    row = db
      .prepare(
        `INSERT INTO history_items (project_id, kind, external_id, role, content, occurred_at, provenance, source_ref)
         VALUES (@project_id, @kind, @external_id, @role, @content, @occurred_at, @provenance, @source_ref)
         ON CONFLICT(project_id, kind, external_id) DO UPDATE SET
           role = excluded.role, content = excluded.content, occurred_at = excluded.occurred_at,
           provenance = excluded.provenance, source_ref = excluded.source_ref
         RETURNING *`,
      )
      .get({
        project_id: input.project_id,
        kind: input.kind,
        external_id: input.external_id,
        role: input.role ?? null,
        content: input.content,
        occurred_at: input.occurred_at ?? null,
        provenance: input.provenance,
        source_ref: input.source_ref ?? null,
      });
  } else {
    row = db
      .prepare(
        `INSERT INTO history_items (project_id, kind, external_id, role, content, occurred_at, provenance, source_ref)
         VALUES (@project_id, @kind, @external_id, @role, @content, @occurred_at, @provenance, @source_ref)
         RETURNING *`,
      )
      .get({
        project_id: input.project_id ?? null,
        kind: input.kind,
        external_id: input.external_id ?? null,
        role: input.role ?? null,
        content: input.content,
        occurred_at: input.occurred_at ?? null,
        provenance: input.provenance,
        source_ref: input.source_ref ?? null,
      });
  }
  insertEvent("history_item.upserted", input.project_id ?? null, {
    id: (row as { id: number }).id,
    kind: input.kind,
  });
  return row;
}

export function createTaskEpisode(input: {
  project_id?: string;
  title: string;
  summary?: string;
  provenance: Provenance;
  started_at?: string;
  ended_at?: string;
  evidence_history_item_ids?: number[];
}) {
  if (input.project_id) assertAllowedProject(input.project_id);
  const row = db
    .prepare(
      `INSERT INTO task_episodes (project_id, title, summary, provenance, started_at, ended_at)
       VALUES (@project_id, @title, @summary, @provenance, @started_at, @ended_at)
       RETURNING *`,
    )
    .get({
      project_id: input.project_id ?? null,
      title: input.title,
      summary: input.summary ?? null,
      provenance: input.provenance,
      started_at: input.started_at ?? null,
      ended_at: input.ended_at ?? null,
    }) as { id: number };
  linkEvidence("task_episode_evidence", "task_episode_id", row.id, input.evidence_history_item_ids);
  insertEvent("task_episode.created", input.project_id ?? null, { id: row.id });
  return row;
}

function linkEvidence(
  table: "task_episode_evidence" | "correction_candidate_evidence",
  fk: "task_episode_id" | "correction_candidate_id",
  id: number,
  historyItemIds?: number[],
) {
  if (!historyItemIds?.length) return;
  const stmt = db.prepare(`INSERT OR IGNORE INTO ${table} (${fk}, history_item_id) VALUES (?, ?)`);
  for (const hid of historyItemIds) stmt.run(id, hid);
}

export function updateTaskEpisode(input: {
  id: number;
  title?: string;
  summary?: string;
  status?: "reconstructed" | "reviewed";
  ended_at?: string;
  add_evidence_history_item_ids?: number[];
}) {
  const existing = db.prepare(`SELECT * FROM task_episodes WHERE id = ?`).get(input.id);
  if (!existing) throw new Error(`task_episode ${input.id} not found`);
  db.prepare(
    `UPDATE task_episodes SET
       title = COALESCE(@title, title),
       summary = COALESCE(@summary, summary),
       status = COALESCE(@status, status),
       ended_at = COALESCE(@ended_at, ended_at),
       updated_at = datetime('now')
     WHERE id = @id`,
  ).run({
    id: input.id,
    title: input.title ?? null,
    summary: input.summary ?? null,
    status: input.status ?? null,
    ended_at: input.ended_at ?? null,
  });
  linkEvidence(
    "task_episode_evidence",
    "task_episode_id",
    input.id,
    input.add_evidence_history_item_ids,
  );
  insertEvent("task_episode.updated", null, { id: input.id });
  return db.prepare(`SELECT * FROM task_episodes WHERE id = ?`).get(input.id);
}

const CLASSIFICATIONS = [
  "defect_correction",
  "constraint_restatement",
  "missing_requirement",
  "preference_revision",
  "scope_extension",
  "new_task",
  "question",
  "approval",
  "other",
] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

export type ClassificationMeta = {
  provider: string;
  model: string;
  role: string;
  structured_output: unknown;
};

export function createCorrectionCandidate(input: {
  task_episode_id: number;
  classification: Classification;
  is_correction: boolean;
  reusable?: boolean;
  proposed_scope?: "project" | "workspace" | "one_time";
  summary: string;
  confidence?: number;
  evidence_reason?: string;
  evidence_history_item_ids: number[];
  classification_meta?: ClassificationMeta;
}) {
  const row = db
    .prepare(
      `INSERT INTO correction_candidates
         (task_episode_id, classification, is_correction, reusable, proposed_scope, summary, confidence, evidence_reason)
       VALUES (@task_episode_id, @classification, @is_correction, @reusable, @proposed_scope, @summary, @confidence, @evidence_reason)
       RETURNING *`,
    )
    .get({
      task_episode_id: input.task_episode_id,
      classification: input.classification,
      is_correction: input.is_correction ? 1 : 0,
      reusable: input.reusable === undefined ? null : input.reusable ? 1 : 0,
      proposed_scope: input.proposed_scope ?? null,
      summary: input.summary,
      confidence: input.confidence ?? null,
      evidence_reason: input.evidence_reason ?? null,
    }) as { id: number };
  linkEvidence(
    "correction_candidate_evidence",
    "correction_candidate_id",
    row.id,
    input.evidence_history_item_ids,
  );
  insertEvent("correction_candidate.created", null, { id: row.id });

  if (input.classification_meta) {
    const meta = input.classification_meta;
    db.prepare(
      `INSERT INTO agent_actions (actor, action, target_table, target_id, provider, model, role, structured_output, human_reviewed)
       VALUES ('claude', 'classify_correction', 'correction_candidates', ?, ?, ?, ?, ?, 0)`,
    ).run(row.id, meta.provider, meta.model, meta.role, JSON.stringify(meta.structured_output));
  }
  return row;
}

export type ReviewAction =
  | "confirm"
  | "reclassify"
  | "mark_one_time"
  | "mark_reusable"
  | "change_scope"
  | "exclude"
  | "include";

export function reviewCorrectionCandidate(input: {
  id: number;
  action: ReviewAction;
  classification?: Classification;
  proposed_scope?: "project" | "workspace" | "one_time";
  reviewer?: string;
}) {
  const existing = db.prepare(`SELECT * FROM correction_candidates WHERE id = ?`).get(input.id);
  if (!existing) throw new Error(`correction_candidate ${input.id} not found`);

  const patch: Record<string, unknown> = { reviewed: 1, reviewed_at: new Date().toISOString() };
  switch (input.action) {
    case "confirm":
      break;
    case "reclassify":
      if (!input.classification) throw new Error("reclassify requires classification");
      patch.classification = input.classification;
      break;
    case "mark_one_time":
      patch.proposed_scope = "one_time";
      patch.reusable = 0;
      break;
    case "mark_reusable":
      patch.reusable = 1;
      break;
    case "change_scope":
      if (!input.proposed_scope) throw new Error("change_scope requires proposed_scope");
      patch.proposed_scope = input.proposed_scope;
      break;
    case "exclude":
      patch.excluded_from_learning = 1;
      break;
    case "include":
      patch.excluded_from_learning = 0;
      break;
  }

  const setClauses = Object.keys(patch)
    .map((k) => `${k} = @${k}`)
    .concat("updated_at = datetime('now')")
    .join(", ");
  db.prepare(`UPDATE correction_candidates SET ${setClauses} WHERE id = @id`).run({
    ...patch,
    id: input.id,
  });
  insertEvent("correction_candidate.reviewed", null, {
    id: input.id,
    action: input.action,
    reviewer: input.reviewer ?? null,
  });
  return db.prepare(`SELECT * FROM correction_candidates WHERE id = ?`).get(input.id);
}

// A Claude-proposed reclassification (distinct from a human's "reclassify"
// review action): records the previous classification in agent_actions
// (structured_output holds {previous_classification, proposed_classification,
// reasoning}), changes the stored classification, and resets reviewed=0 so
// the change lands in front of the human again rather than looking final.
export function proposeReclassification(input: {
  id: number;
  new_classification: Classification;
  reasoning: string;
  meta?: ClassificationMeta;
}) {
  const existing = db.prepare(`SELECT * FROM correction_candidates WHERE id = ?`).get(input.id) as
    { classification: string } | undefined;
  if (!existing) throw new Error(`correction_candidate ${input.id} not found`);

  db.prepare(
    `INSERT INTO agent_actions (actor, action, target_table, target_id, provider, model, role, structured_output, human_reviewed)
     VALUES ('claude', 'propose_reclassification', 'correction_candidates', ?, ?, ?, ?, ?, 0)`,
  ).run(
    input.id,
    input.meta?.provider ?? null,
    input.meta?.model ?? null,
    input.meta?.role ?? null,
    JSON.stringify({
      previous_classification: existing.classification,
      proposed_classification: input.new_classification,
      reasoning: input.reasoning,
    }),
  );

  db.prepare(
    `UPDATE correction_candidates SET classification = ?, reviewed = 0, reviewed_at = NULL, updated_at = datetime('now') WHERE id = ?`,
  ).run(input.new_classification, input.id);

  insertEvent("correction_candidate.reclassification_proposed", null, {
    id: input.id,
    previous_classification: existing.classification,
    new_classification: input.new_classification,
  });

  return db.prepare(`SELECT * FROM correction_candidates WHERE id = ?`).get(input.id);
}

export function editCorrectionSummary(id: number, summary: string, reviewer: string) {
  const existing = db.prepare(`SELECT * FROM correction_candidates WHERE id = ?`).get(id);
  if (!existing) throw new Error(`correction_candidate ${id} not found`);
  db.prepare(
    `UPDATE correction_candidates SET summary = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(summary, id);
  insertEvent("correction_candidate.summary_edited", null, { id, reviewer });
  return db.prepare(`SELECT * FROM correction_candidates WHERE id = ?`).get(id);
}

// The human's final call on a correction: distinct from Claude's own
// classify_correction / propose_reclassification agent_actions rows (both
// actor='claude'), this is actor='human' and is what actually sets
// reviewed=1 -- a rule cannot become 'approved' on a correction that hasn't
// gone through this. Never overwrites the earlier Claude-authored rows;
// classification history is append-only.
export function recordHumanCorrectionDecision(input: {
  id: number;
  final_classification: Classification;
  reusable: boolean;
  proposed_scope: "project" | "workspace" | "one_time";
  reviewer: string;
}) {
  const existing = db.prepare(`SELECT * FROM correction_candidates WHERE id = ?`).get(input.id) as
    { classification: string } | undefined;
  if (!existing) throw new Error(`correction_candidate ${input.id} not found`);

  db.prepare(
    `INSERT INTO agent_actions (actor, action, target_table, target_id, structured_output, human_reviewed)
     VALUES ('human', 'human_review_decision', 'correction_candidates', ?, ?, 1)`,
  ).run(
    input.id,
    JSON.stringify({
      final_classification: input.final_classification,
      reusable: input.reusable,
      proposed_scope: input.proposed_scope,
      matched_proposed_classification: input.final_classification === existing.classification,
    }),
  );

  db.prepare(
    `UPDATE correction_candidates SET
       classification = ?, reusable = ?, proposed_scope = ?,
       reviewed = 1, reviewed_at = datetime('now'), updated_at = datetime('now')
     WHERE id = ?`,
  ).run(input.final_classification, input.reusable ? 1 : 0, input.proposed_scope, input.id);

  insertEvent("correction_candidate.human_decision_recorded", null, {
    id: input.id,
    final_classification: input.final_classification,
    reviewer: input.reviewer,
  });

  return db.prepare(`SELECT * FROM correction_candidates WHERE id = ?`).get(input.id);
}

export function getClassificationHistory(correctionCandidateId: number) {
  return db
    .prepare(
      `SELECT * FROM agent_actions
       WHERE target_table = 'correction_candidates' AND target_id = ?
         AND action IN ('classify_correction', 'propose_reclassification', 'human_review_decision')
       ORDER BY created_at ASC, id ASC`,
    )
    .all(correctionCandidateId);
}

export function createLearning(input: {
  correction_candidate_id: number;
  observed_problem: string;
  desired_behavior: string;
  reuse_rationale: string;
  proposed_scope: "project" | "workspace";
  applicability?: string;
  confidence?: number;
  overlap_notes?: string;
  provenance: Provenance;
  created_by: string;
}) {
  const count = (
    db
      .prepare(`SELECT COUNT(*) as n FROM learnings WHERE correction_candidate_id = ?`)
      .get(input.correction_candidate_id) as { n: number }
  ).n;
  if (count >= 3) throw new LearningLimitError(input.correction_candidate_id);

  const row = db
    .prepare(
      `INSERT INTO learnings
         (correction_candidate_id, observed_problem, desired_behavior, reuse_rationale, proposed_scope,
          applicability, confidence, overlap_notes, provenance, created_by)
       VALUES (@correction_candidate_id, @observed_problem, @desired_behavior, @reuse_rationale, @proposed_scope,
               @applicability, @confidence, @overlap_notes, @provenance, @created_by)
       RETURNING *`,
    )
    .get({
      correction_candidate_id: input.correction_candidate_id,
      observed_problem: input.observed_problem,
      desired_behavior: input.desired_behavior,
      reuse_rationale: input.reuse_rationale,
      proposed_scope: input.proposed_scope,
      applicability: input.applicability ?? null,
      confidence: input.confidence ?? null,
      overlap_notes: input.overlap_notes ?? null,
      provenance: input.provenance,
      created_by: input.created_by,
    }) as { id: number };
  insertEvent("learning.created", null, { id: row.id });
  return row;
}

export function createRule(input: {
  learning_id: number;
  correction_candidate_id: number;
  instruction: string;
  scope: "project" | "workspace";
  applies_when: string;
  predicted_failure: string;
  ownership: "user" | "harness";
  overlap_notes?: string;
  created_by: string;
}) {
  const row = db
    .prepare(
      `INSERT INTO rules
         (learning_id, correction_candidate_id, instruction, scope, applies_when, predicted_failure,
          ownership, overlap_notes, created_by)
       VALUES (@learning_id, @correction_candidate_id, @instruction, @scope, @applies_when, @predicted_failure,
               @ownership, @overlap_notes, @created_by)
       RETURNING *`,
    )
    .get({
      learning_id: input.learning_id,
      correction_candidate_id: input.correction_candidate_id,
      instruction: input.instruction,
      scope: input.scope,
      applies_when: input.applies_when,
      predicted_failure: input.predicted_failure,
      ownership: input.ownership,
      overlap_notes: input.overlap_notes ?? null,
      created_by: input.created_by,
    }) as { id: number };
  insertEvent("rule.created", null, { id: row.id, state: "proposed" });
  return row;
}

const RULE_STATES = [
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
] as const;
export type RuleState = (typeof RULE_STATES)[number];

// Approving/rejecting/editing a rule ONLY ever touches this SQLite database.
// This function has no import of, or call into, any Lovable MCP tool --
// there is no code path here that can write Knowledge, touch a Skill, run an
// experiment, or change a Lovable project.
export function updateRule(input: {
  id: number;
  instruction?: string;
  state?: RuleState;
  scope?: "project" | "workspace";
  reason?: string;
  actor: string;
}) {
  const existing = db.prepare(`SELECT * FROM rules WHERE id = ?`).get(input.id) as
    { instruction: string; state: string; scope: string } | undefined;
  if (!existing) throw new Error(`rule ${input.id} not found`);

  // Scope is a destination choice, not a wording/state change: it is
  // updated and audited via an event but does not create a rule_revision.
  if (input.scope && input.scope !== existing.scope) {
    db.prepare(`UPDATE rules SET scope = ?, updated_at = datetime('now') WHERE id = ?`).run(
      input.scope,
      input.id,
    );
    insertEvent("rule.scope_changed", null, {
      id: input.id,
      previous_scope: existing.scope,
      new_scope: input.scope,
      actor: input.actor,
    });
  }

  const newInstruction = input.instruction ?? existing.instruction;
  const newState = input.state ?? existing.state;
  const changed = newInstruction !== existing.instruction || newState !== existing.state;

  if (changed) {
    db.prepare(
      `INSERT INTO rule_revisions (rule_id, previous_instruction, previous_state, new_instruction, new_state, reason, actor)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      existing.instruction,
      existing.state,
      newInstruction,
      newState,
      input.reason ?? null,
      input.actor,
    );

    db.prepare(
      `UPDATE rules SET instruction = ?, state = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(newInstruction, newState, input.id);

    insertEvent("rule.updated", null, {
      id: input.id,
      previous_state: existing.state,
      new_state: newState,
      instruction_changed: newInstruction !== existing.instruction,
    });
  }
  return db.prepare(`SELECT * FROM rules WHERE id = ?`).get(input.id);
}

export function getRule(id: number) {
  const rule = db.prepare(`SELECT * FROM rules WHERE id = ?`).get(id);
  if (!rule) return null;
  const revisions = db
    .prepare(`SELECT * FROM rule_revisions WHERE rule_id = ? ORDER BY id DESC`)
    .all(id);
  const learning = db
    .prepare(`SELECT * FROM learnings WHERE id = ?`)
    .get((rule as { learning_id: number }).learning_id);
  const correction = db
    .prepare(`SELECT * FROM correction_candidates WHERE id = ?`)
    .get((rule as { correction_candidate_id: number }).correction_candidate_id);
  return { rule, revisions, learning, correction_candidate: correction };
}

// ---- Read helpers for the local UI ----

export function listCorrectionCandidates() {
  const rows = db
    .prepare(
      `SELECT cc.*, te.id as episode_id, te.title as episode_title, te.summary as episode_summary,
              te.started_at as episode_started_at, te.ended_at as episode_ended_at,
              te.project_id as project_id, p.name as project_name
       FROM correction_candidates cc
       JOIN task_episodes te ON te.id = cc.task_episode_id
       LEFT JOIN projects p ON p.lovable_project_id = te.project_id
       ORDER BY cc.created_at DESC`,
    )
    .all() as Record<string, unknown>[];
  const evidenceStmt = db.prepare(
    `SELECT hi.* FROM history_items hi
     JOIN correction_candidate_evidence cce ON cce.history_item_id = hi.id
     WHERE cce.correction_candidate_id = ?
     ORDER BY hi.occurred_at, hi.id`,
  );
  return rows.map((r) => ({ ...r, evidence: evidenceStmt.all(r.id) }));
}

export function getCorrectionCandidate(id: number) {
  const cc = db.prepare(`SELECT * FROM correction_candidates WHERE id = ?`).get(id);
  if (!cc) return null;
  const evidence = db
    .prepare(
      `SELECT hi.* FROM history_items hi
       JOIN correction_candidate_evidence cce ON cce.history_item_id = hi.id
       WHERE cce.correction_candidate_id = ?
       ORDER BY hi.occurred_at, hi.id`,
    )
    .all(id);
  return { correction_candidate: cc, evidence };
}

// User-facing evidence is ONLY what was actually exchanged in the Lovable
// chat: kind='message' with provenance='lovable_mcp', verbatim, chronological.
// Everything else linked to the correction (Harness notes, build-log rows,
// spec excerpts, git commits, diffs) is returned separately as hidden.
export function getEvidenceForCorrection(correctionCandidateId: number) {
  const all = db
    .prepare(
      `SELECT hi.* FROM history_items hi
       JOIN correction_candidate_evidence cce ON cce.history_item_id = hi.id
       WHERE cce.correction_candidate_id = ?
       ORDER BY COALESCE(hi.occurred_at, '9999'), hi.id`,
    )
    .all(correctionCandidateId) as { kind: string; provenance: string }[];
  return {
    visible: all.filter((e) => e.kind === "message" && e.provenance === "lovable_mcp"),
    hidden: all.filter((e) => !(e.kind === "message" && e.provenance === "lovable_mcp")),
  };
}

export function listProjectRules(projectId?: string) {
  if (!projectId) {
    return db.prepare(`SELECT r.* FROM rules r ORDER BY r.created_at DESC`).all();
  }
  return db
    .prepare(
      `SELECT DISTINCT r.*
       FROM rules r
       JOIN correction_candidates cc ON cc.id = r.correction_candidate_id
       JOIN task_episodes te ON te.id = cc.task_episode_id
       WHERE te.project_id = ?
       ORDER BY r.created_at DESC`,
    )
    .all(projectId);
}

// ---- Checkpoint C: verification and experiment planning ----
// Nothing here executes an experiment or a verifier -- these are pure
// bookkeeping functions for defining what WOULD be checked and WOULD be run.

const VERIFIER_TYPES = ["structural", "diff_pattern", "ai_rubric", "human_only"] as const;
export type VerifierType = (typeof VERIFIER_TYPES)[number];
const VERIFIER_STATUSES = ["passed", "failed", "unclear", "not_run"] as const;
export type VerifierStatus = (typeof VERIFIER_STATUSES)[number];

export function createVerificationDefinition(input: {
  scope: "project" | "workspace";
  project_id?: string;
  name: string;
  description: string;
  verifier_type: VerifierType;
  configuration: string;
  source: Provenance;
  ownership: "user" | "harness";
  confidence?: number;
  enabled?: boolean;
}) {
  if (input.scope === "project") {
    if (!input.project_id) throw new Error("scope 'project' requires project_id");
    assertAllowedProject(input.project_id);
  } else if (input.project_id) {
    throw new Error("scope 'workspace' must not set project_id");
  }
  const row = db
    .prepare(
      `INSERT INTO verification_definitions
         (scope, project_id, name, description, verifier_type, configuration, source, ownership, confidence, enabled)
       VALUES (@scope, @project_id, @name, @description, @verifier_type, @configuration, @source, @ownership, @confidence, @enabled)
       RETURNING *`,
    )
    .get({
      scope: input.scope,
      project_id: input.project_id ?? null,
      name: input.name,
      description: input.description,
      verifier_type: input.verifier_type,
      configuration: input.configuration,
      source: input.source,
      ownership: input.ownership,
      confidence: input.confidence ?? null,
      enabled: input.enabled === false ? 0 : 1,
    }) as { id: number };
  insertEvent("verification_definition.created", null, {
    id: row.id,
    verifier_type: input.verifier_type,
  });
  return row;
}

export function updateVerificationDefinition(input: {
  id: number;
  name?: string;
  description?: string;
  configuration?: string;
  confidence?: number;
  enabled?: boolean;
}) {
  const existing = db.prepare(`SELECT * FROM verification_definitions WHERE id = ?`).get(input.id);
  if (!existing) throw new Error(`verification_definition ${input.id} not found`);
  db.prepare(
    `UPDATE verification_definitions SET
       name = COALESCE(@name, name),
       description = COALESCE(@description, description),
       configuration = COALESCE(@configuration, configuration),
       confidence = COALESCE(@confidence, confidence),
       enabled = COALESCE(@enabled, enabled),
       version = version + 1,
       updated_at = datetime('now')
     WHERE id = @id`,
  ).run({
    id: input.id,
    name: input.name ?? null,
    description: input.description ?? null,
    configuration: input.configuration ?? null,
    confidence: input.confidence ?? null,
    enabled: input.enabled === undefined ? null : input.enabled ? 1 : 0,
  });
  insertEvent("verification_definition.updated", null, { id: input.id });
  return db.prepare(`SELECT * FROM verification_definitions WHERE id = ?`).get(input.id);
}

export function linkVerificationToRule(ruleId: number, verificationDefinitionId: number) {
  db.prepare(
    `INSERT OR IGNORE INTO rule_verification_links (rule_id, verification_definition_id) VALUES (?, ?)`,
  ).run(ruleId, verificationDefinitionId);
  insertEvent("rule_verification_link.created", null, {
    rule_id: ruleId,
    verification_definition_id: verificationDefinitionId,
  });
  return { rule_id: ruleId, verification_definition_id: verificationDefinitionId };
}

export function createVerificationPlan(input: {
  rule_id: number;
  failure_signature: string;
  failure_condition: string;
  created_by: string;
  verification_definition_ids: number[];
}) {
  const plan = db
    .prepare(
      `INSERT INTO verification_plans (rule_id, failure_signature, failure_condition, created_by)
       VALUES (?, ?, ?, ?) RETURNING *`,
    )
    .get(input.rule_id, input.failure_signature, input.failure_condition, input.created_by) as {
    id: number;
  };

  const itemStmt = db.prepare(
    `INSERT INTO verification_plan_items (verification_plan_id, verification_definition_id) VALUES (?, ?)`,
  );
  for (const vid of input.verification_definition_ids) {
    itemStmt.run(plan.id, vid);
    linkVerificationToRule(input.rule_id, vid);
  }
  insertEvent("verification_plan.created", null, { id: plan.id, rule_id: input.rule_id });
  return plan;
}

export function getVerificationPlan(id: number) {
  const plan = db.prepare(`SELECT * FROM verification_plans WHERE id = ?`).get(id);
  if (!plan) return null;
  const items = db
    .prepare(
      `SELECT vpi.*, vd.name as definition_name, vd.verifier_type, vd.description as definition_description
       FROM verification_plan_items vpi
       JOIN verification_definitions vd ON vd.id = vpi.verification_definition_id
       WHERE vpi.verification_plan_id = ?
       ORDER BY vpi.id`,
    )
    .all(id);
  return { plan, items };
}

export function getVerificationPlanForRule(ruleId: number) {
  const plan = db
    .prepare(`SELECT * FROM verification_plans WHERE rule_id = ? ORDER BY id DESC LIMIT 1`)
    .get(ruleId) as { id: number } | undefined;
  if (!plan) return null;
  return getVerificationPlan(plan.id);
}

export function createExperimentPlan(input: {
  rule_id: number;
  source_project_id: string;
  task_episode_id?: number;
  experiment_type: "treatment_only" | "paired_control_treatment" | "ablation";
  starting_state_quality: "controlled_equivalent" | "approximate" | "historical_only" | "blocked";
  control_configuration: string;
  treatment_configuration: string;
  exact_prompt: string;
  protected_checks: string;
  estimated_credits: number;
  max_permitted_credits: number;
  resource_strategy: string;
  cleanup_requirements: string;
  risks: string;
  success_conditions: string;
  inconclusive_conditions: string;
  stop_conditions: string;
  created_by: string;
  verification_definition_ids: number[];
}) {
  assertAllowedProject(input.source_project_id);
  const plan = db
    .prepare(
      `INSERT INTO experiment_plans
         (rule_id, source_project_id, task_episode_id, experiment_type, starting_state_quality,
          control_configuration, treatment_configuration, exact_prompt, protected_checks,
          estimated_credits, max_permitted_credits, resource_strategy, cleanup_requirements,
          risks, success_conditions, inconclusive_conditions, stop_conditions, created_by)
       VALUES (@rule_id, @source_project_id, @task_episode_id, @experiment_type, @starting_state_quality,
               @control_configuration, @treatment_configuration, @exact_prompt, @protected_checks,
               @estimated_credits, @max_permitted_credits, @resource_strategy, @cleanup_requirements,
               @risks, @success_conditions, @inconclusive_conditions, @stop_conditions, @created_by)
       RETURNING *`,
    )
    .get({ ...input, task_episode_id: input.task_episode_id ?? null }) as { id: number };

  const linkStmt = db.prepare(
    `INSERT OR IGNORE INTO experiment_plan_verification_links (experiment_plan_id, verification_definition_id) VALUES (?, ?)`,
  );
  for (const vid of input.verification_definition_ids) linkStmt.run(plan.id, vid);

  insertEvent("experiment_plan.created", null, {
    id: plan.id,
    rule_id: input.rule_id,
    status: "proposed",
  });
  return plan;
}

export function getExperimentPlan(id: number) {
  const plan = db.prepare(`SELECT * FROM experiment_plans WHERE id = ?`).get(id);
  if (!plan) return null;
  const verifications = db
    .prepare(
      `SELECT vd.* FROM verification_definitions vd
       JOIN experiment_plan_verification_links l ON l.verification_definition_id = vd.id
       WHERE l.experiment_plan_id = ?`,
    )
    .all(id);
  const resources = db
    .prepare(`SELECT * FROM experiment_resources WHERE experiment_plan_id = ? ORDER BY id`)
    .all(id);
  return { plan, verifications, resources };
}

// Never accepts safe_to_delete -- a freshly registered resource is never
// pre-authorized for deletion, no matter what created it or when.
export function registerExperimentResource(input: {
  experiment_plan_id: number;
  resource_type: "remix_project" | "variant" | "skill" | "other";
  experiment_arm: "control" | "treatment" | "ablation";
  source_project_id: string;
  safe_to_modify?: boolean;
  lovable_resource_id?: string;
}) {
  assertAllowedProject(input.source_project_id);
  const row = db
    .prepare(
      `INSERT INTO experiment_resources
         (experiment_plan_id, lovable_resource_id, resource_type, experiment_arm, source_project_id, safe_to_modify)
       VALUES (@experiment_plan_id, @lovable_resource_id, @resource_type, @experiment_arm, @source_project_id, @safe_to_modify)
       RETURNING *`,
    )
    .get({
      experiment_plan_id: input.experiment_plan_id,
      lovable_resource_id: input.lovable_resource_id ?? null,
      resource_type: input.resource_type,
      experiment_arm: input.experiment_arm,
      source_project_id: input.source_project_id,
      safe_to_modify: input.safe_to_modify ? 1 : 0,
    }) as { id: number };
  insertEvent("experiment_resource.registered", null, {
    id: row.id,
    resource_type: input.resource_type,
  });
  return row;
}

// The ONLY place safe_to_delete can become true, and only when the caller
// passes it explicitly -- there is no default or inferred path to true.
export function updateExperimentResourceStatus(input: {
  id: number;
  lovable_resource_id?: string;
  creation_status?: "planned" | "creating" | "created" | "failed";
  cleanup_status?: "not_required" | "pending" | "cleaned" | "failed";
  safe_to_delete?: boolean;
  cleaned_at?: string;
}) {
  const existing = db.prepare(`SELECT * FROM experiment_resources WHERE id = ?`).get(input.id);
  if (!existing) throw new Error(`experiment_resource ${input.id} not found`);
  db.prepare(
    `UPDATE experiment_resources SET
       lovable_resource_id = COALESCE(@lovable_resource_id, lovable_resource_id),
       creation_status = COALESCE(@creation_status, creation_status),
       cleanup_status = COALESCE(@cleanup_status, cleanup_status),
       safe_to_delete = CASE WHEN @safe_to_delete IS NULL THEN safe_to_delete ELSE @safe_to_delete END,
       cleaned_at = COALESCE(@cleaned_at, cleaned_at)
     WHERE id = @id`,
  ).run({
    id: input.id,
    lovable_resource_id: input.lovable_resource_id ?? null,
    creation_status: input.creation_status ?? null,
    cleanup_status: input.cleanup_status ?? null,
    safe_to_delete: input.safe_to_delete === undefined ? null : input.safe_to_delete ? 1 : 0,
    cleaned_at: input.cleaned_at ?? null,
  });
  insertEvent("experiment_resource.status_updated", null, { ...input });
  return db.prepare(`SELECT * FROM experiment_resources WHERE id = ?`).get(input.id);
}

export function listCleanupRequiredResources() {
  return db
    .prepare(
      `SELECT * FROM experiment_resources
       WHERE creation_status = 'created' AND cleanup_status IN ('pending', 'not_required')
       ORDER BY created_at`,
    )
    .all();
}

// Read helpers for the guided UI (checkpoint C.1): pure reads, no new semantics.
export function getLearningForCorrection(correctionCandidateId: number) {
  return (
    db
      .prepare(`SELECT * FROM learnings WHERE correction_candidate_id = ? ORDER BY id ASC LIMIT 1`)
      .get(correctionCandidateId) ?? null
  );
}

export function getRuleForCorrection(correctionCandidateId: number) {
  return (
    db
      .prepare(`SELECT * FROM rules WHERE correction_candidate_id = ? ORDER BY id ASC LIMIT 1`)
      .get(correctionCandidateId) ?? null
  );
}

// Events whose kind starts with one of the prefixes and whose payload
// references this id -- an approximation good enough for an audit panel.
export function listEventsForRecord(kindPrefixes: string[], id: number) {
  const rows = db
    .prepare(`SELECT * FROM events WHERE payload LIKE ? ORDER BY id DESC LIMIT 100`)
    .all(`%"id":${id}%`) as { kind: string }[];
  return rows.filter((r) => kindPrefixes.some((p) => r.kind.startsWith(p)));
}

// ---- Checkpoint D: Knowledge snapshots and versions ----
// The app never writes to Lovable itself. These functions record what the
// UI approved and what the executor (Claude Code over Lovable MCP) then read
// back, so every write has a before/after with hashes and can be restored.

export type KnowledgeTarget = "project" | "workspace";
// "cancelled" -- a decision changed (skip, reopen, switching to
// test-first) before the executor got to a pending write -- see
// markKnowledgeWriteCancelled.
export type KnowledgeWriteStatus = "pending" | "written" | "stale" | "failed" | "cancelled";

export type KnowledgeVersionRow = {
  id: number;
  rule_id: number | null;
  target: KnowledgeTarget;
  project_id: string | null;
  workspace_id: string | null;
  previous_content: string;
  new_content: string;
  previous_sha256: string;
  new_sha256: string;
  rule_ids_json: string;
  status: KnowledgeWriteStatus;
  actor: string;
  reason: string | null;
  restored_from_version_id: number | null;
  created_at: string;
  written_at: string | null;
  verified_at: string | null;
  error: string | null;
};

function targetColumn(target: KnowledgeTarget): "project_id" | "workspace_id" {
  return target === "project" ? "project_id" : "workspace_id";
}

function assertTargetId(target: KnowledgeTarget, projectId?: string, workspaceId?: string) {
  if (target === "project") {
    if (!projectId) throw new Error("target 'project' requires project_id");
    assertAllowedProject(projectId);
  } else if (!workspaceId) {
    throw new Error("target 'workspace' requires workspace_id");
  }
}

export function recordKnowledgeSnapshot(input: {
  target: KnowledgeTarget;
  project_id?: string;
  workspace_id?: string;
  content: string;
  fetched_by: string;
}) {
  assertTargetId(input.target, input.project_id, input.workspace_id);
  const row = db
    .prepare(
      `INSERT INTO knowledge_snapshots (target, project_id, workspace_id, content, sha256, fetched_by)
       VALUES (@target, @project_id, @workspace_id, @content, @sha256, @fetched_by) RETURNING *`,
    )
    .get({
      target: input.target,
      project_id: input.target === "project" ? input.project_id : null,
      workspace_id: input.target === "workspace" ? input.workspace_id : null,
      content: input.content,
      sha256: knowledgeSha256(input.content),
      fetched_by: input.fetched_by,
    }) as { id: number; sha256: string };
  insertEvent("knowledge_snapshot.recorded", null, {
    id: row.id,
    target: input.target,
    target_id: input.target === "project" ? input.project_id : input.workspace_id,
    sha256: row.sha256,
    chars: input.content.length,
  });
  return row;
}

// Round 6 Task 5: `forWrite` excludes demo snapshots (fetched_by = 'demo')
// so a real accept/preview can never compose on demo text (spec §5).
export function latestKnowledgeSnapshot(
  target: KnowledgeTarget,
  targetId: string,
  opts?: { forWrite?: boolean },
) {
  const demoClause = opts?.forWrite ? `AND fetched_by != 'demo'` : "";
  return (db
    .prepare(
      `SELECT * FROM knowledge_snapshots WHERE target = ? AND ${targetColumn(target)} = ? ${demoClause} ORDER BY id DESC LIMIT 1`,
    )
    .get(target, targetId) ?? null) as {
    id: number;
    content: string;
    sha256: string;
    fetched_at: string;
    fetched_by: string;
  } | null;
}

// Rules that belong in the managed block of a given target right now.
export function activeRulesForTarget(target: KnowledgeTarget, targetId: string) {
  if (target === "project") {
    return db
      .prepare(
        `SELECT r.id, r.instruction, r.state, r.scope FROM rules r
         JOIN correction_candidates cc ON cc.id = r.correction_candidate_id
         JOIN task_episodes te ON te.id = cc.task_episode_id
         WHERE r.scope = 'project' AND r.state IN ('approved','supported','active') AND te.project_id = ?
         ORDER BY r.id`,
      )
      .all(targetId) as { id: number; instruction: string; state: string; scope: string }[];
  }
  return db
    .prepare(
      `SELECT r.id, r.instruction, r.state, r.scope FROM rules r
       WHERE r.scope = 'workspace' AND r.state IN ('approved','supported','active')
       ORDER BY r.id`,
    )
    .all() as { id: number; instruction: string; state: string; scope: string }[];
}

export function setRuleEvidenceLevel(ruleId: number, level: string, actor: string) {
  const existing = db.prepare(`SELECT evidence_level FROM rules WHERE id = ?`).get(ruleId) as
    { evidence_level: string } | undefined;
  if (!existing) throw new Error(`rule ${ruleId} not found`);
  if (existing.evidence_level === level) return;
  db.prepare(`UPDATE rules SET evidence_level = ?, updated_at = datetime('now') WHERE id = ?`).run(
    level,
    ruleId,
  );
  insertEvent("rule.evidence_level_changed", null, {
    id: ruleId,
    previous: existing.evidence_level,
    new: level,
    actor,
  });
}

export function createPendingKnowledgeVersion(input: {
  rule_id: number | null;
  target: KnowledgeTarget;
  project_id?: string;
  workspace_id?: string;
  previous_content: string;
  new_content: string;
  rule_ids: number[];
  actor: string;
  reason?: string;
  restored_from_version_id?: number;
}) {
  assertTargetId(input.target, input.project_id, input.workspace_id);
  const row = db
    .prepare(
      `INSERT INTO knowledge_versions
         (rule_id, target, project_id, workspace_id, previous_content, new_content, previous_sha256, new_sha256,
          rule_ids_json, status, actor, reason, restored_from_version_id)
       VALUES (@rule_id, @target, @project_id, @workspace_id, @previous_content, @new_content, @previous_sha256, @new_sha256,
               @rule_ids_json, 'pending', @actor, @reason, @restored_from_version_id)
       RETURNING *`,
    )
    .get({
      rule_id: input.rule_id,
      target: input.target,
      project_id: input.target === "project" ? input.project_id : null,
      workspace_id: input.target === "workspace" ? input.workspace_id : null,
      previous_content: input.previous_content,
      new_content: input.new_content,
      previous_sha256: knowledgeSha256(input.previous_content),
      new_sha256: knowledgeSha256(input.new_content),
      rule_ids_json: JSON.stringify(input.rule_ids),
      actor: input.actor,
      reason: input.reason ?? null,
      restored_from_version_id: input.restored_from_version_id ?? null,
    }) as KnowledgeVersionRow;
  insertEvent("knowledge_version.pending", null, {
    id: row.id,
    rule_id: input.rule_id,
    target: input.target,
    restored_from_version_id: input.restored_from_version_id ?? null,
    actor: input.actor,
  });
  return row;
}

export function getKnowledgeVersion(id: number) {
  return (db.prepare(`SELECT * FROM knowledge_versions WHERE id = ?`).get(id) ??
    null) as KnowledgeVersionRow | null;
}

function requirePendingVersion(id: number): KnowledgeVersionRow {
  const v = getKnowledgeVersion(id);
  if (!v) throw new Error(`knowledge_version ${id} not found`);
  if (v.status !== "pending")
    throw new Error(`knowledge_version ${id} is ${v.status}, not pending`);
  return v;
}

export function markKnowledgeWriteStale(versionId: number, reason: string) {
  requirePendingVersion(versionId);
  db.prepare(`UPDATE knowledge_versions SET status = 'stale', error = ? WHERE id = ?`).run(
    reason,
    versionId,
  );
  insertEvent("knowledge_version.stale", null, { id: versionId, reason });
  return getKnowledgeVersion(versionId);
}

export function markKnowledgeWriteFailed(versionId: number, error: string) {
  requirePendingVersion(versionId);
  db.prepare(`UPDATE knowledge_versions SET status = 'failed', error = ? WHERE id = ?`).run(
    error,
    versionId,
  );
  insertEvent("knowledge_version.failed", null, { id: versionId, error });
  return getKnowledgeVersion(versionId);
}

// The executor calls this with what it read back from Lovable AFTER writing.
// Only a byte-identical read-back counts as written.
export function recordKnowledgeReadback(versionId: number, readBackContent: string) {
  const v = requirePendingVersion(versionId);
  const readBackSha = knowledgeSha256(readBackContent);
  if (readBackSha !== v.new_sha256) {
    db.prepare(`UPDATE knowledge_versions SET status = 'failed', error = ? WHERE id = ?`).run(
      `read-back hash mismatch: expected ${v.new_sha256.slice(0, 12)}…, got ${readBackSha.slice(0, 12)}…`,
      versionId,
    );
    insertEvent("knowledge_version.failed", null, {
      id: versionId,
      error: "read-back hash mismatch",
    });
    return getKnowledgeVersion(versionId);
  }
  db.prepare(
    `UPDATE knowledge_versions SET status = 'written', written_at = datetime('now'), verified_at = datetime('now') WHERE id = ?`,
  ).run(versionId);
  insertEvent("knowledge_version.written", null, {
    id: versionId,
    target: v.target,
    sha256: readBackSha,
  });

  if (v.rule_id != null) {
    if (v.restored_from_version_id != null) {
      // A restore undid this rule's write: the rule is no longer in Lovable.
      updateRule({
        id: v.rule_id,
        state: "rolled_back",
        actor: "harness",
        reason: `restored knowledge version ${v.restored_from_version_id}`,
      });
    } else {
      updateRule({
        id: v.rule_id,
        state: "active",
        actor: "harness",
        reason: `knowledge version ${versionId} written`,
      });
      insertEvent("rule.applied", null, {
        id: v.rule_id,
        knowledge_version_id: versionId,
        target: v.target,
      });
    }
  }
  return getKnowledgeVersion(versionId);
}

export function listPendingKnowledgeWrites() {
  return db
    .prepare(
      // rule_ids_json added for Round 6 Task 5: executeWrites needs it to
      // recognize a retire recompose (rule_id: null) that names a demo rule.
      `SELECT id, rule_id, target, project_id, workspace_id, previous_sha256, new_sha256, new_content, created_at, actor, reason, restored_from_version_id, rule_ids_json
       FROM knowledge_versions WHERE status = 'pending' ORDER BY id`,
    )
    .all();
}

export function listKnowledgeVersions(ruleId?: number) {
  return (
    ruleId == null
      ? db.prepare(`SELECT * FROM knowledge_versions ORDER BY id DESC`).all()
      : db
          .prepare(`SELECT * FROM knowledge_versions WHERE rule_id = ? ORDER BY id DESC`)
          .all(ruleId)
  ) as KnowledgeVersionRow[];
}

// Supersede any still-pending write for a rule (decision changed before the
// executor ran) so the executor never applies an out-of-date decision. Not
// a failure -- see markKnowledgeWriteCancelled below.
export function cancelPendingKnowledgeWrites(ruleId: number, reason: string) {
  const pending = db
    .prepare(`SELECT id FROM knowledge_versions WHERE rule_id = ? AND status = 'pending'`)
    .all(ruleId) as { id: number }[];
  for (const p of pending) markKnowledgeWriteCancelled(p.id, reason);
  return pending.length;
}

// A restore is a new pending write whose new content is the target
// version's previous content. previous_content is what we believe is live
// now (that version's new_content), so the executor's freshness check still
// applies. History is never rewritten.
export function createRestoreVersion(versionId: number, actor: string, reason?: string) {
  const v = getKnowledgeVersion(versionId);
  if (!v) throw new Error(`knowledge_version ${versionId} not found`);
  if (v.status !== "written")
    throw new Error(`only a written version can be restored (version ${versionId} is ${v.status})`);
  return createPendingKnowledgeVersion({
    rule_id: v.rule_id,
    target: v.target,
    ...(v.project_id ? { project_id: v.project_id } : {}),
    ...(v.workspace_id ? { workspace_id: v.workspace_id } : {}),
    previous_content: v.new_content,
    new_content: v.previous_content,
    rule_ids: [],
    actor,
    reason: reason ?? `restore knowledge version ${versionId}`,
    restored_from_version_id: versionId,
  });
}

export function listExperimentPlansForRule(ruleId: number) {
  const plans = db
    .prepare(`SELECT * FROM experiment_plans WHERE rule_id = ? ORDER BY created_at DESC`)
    .all(ruleId) as { id: number }[];
  return plans.map((p) => getExperimentPlan(p.id));
}

// ---- Checkpoint E (v5): executor settings, skill snapshots, sync runs/requests ----
// Local-only bookkeeping for the executor (next checkpoint) and the API
// routes/UI that talk to it. Nothing here calls Lovable MCP or the network.

export type SettingKey =
  | "sync_enabled"
  | "sync_interval_minutes"
  | "sync_window_start_hour"
  | "sync_window_end_hour"
  | "knowledge_char_cap"
  | "require_approval_before_write"
  | "llm_provider"
  | "llm_models"
  | "llm_monthly_token_budget"
  | "rule_unused_after_days"
  | "max_active_rules"
  // Task C3 / spec §5 "new since your last visit": when the Inbox was last
  // opened, as an ISO date string -- "" (never visited) counts as the
  // beginning of time, so a first-ever visit reads every item as new.
  | "inbox_last_seen_at"
  // Round 5 Task 1 / spec §4: whether a correction candidate that clears the
  // auto-accept confidence bar is queued for the user to decide ("ask", the
  // default) or accepted without a prompt ("automatic") -- see
  // decision_auto_confidence below and setCandidateDecidedBy in the Round 5
  // Task 1 block further down this file.
  | "decision_mode"
  // The confidence threshold decision_mode='automatic' requires before it
  // will decide without asking -- a plain fraction in [0.5, 1], never a
  // percentage.
  | "decision_auto_confidence"
  // spec §4b: which evidence sources feed a rule's health/verdict picture --
  // a JSON object of exactly the four booleans EvidenceSources below names.
  | "evidence_sources"
  // Round 6 Task 1: the paired-test experiment spends real Lovable credits
  // (copying a project and replaying a message costs the same as the user
  // doing it themselves) -- a monthly ceiling the runner (a later Round 6
  // task) checks via creditsThisMonth() before starting a new run.
  | "lovable_monthly_credit_budget"
  // Whether a finished experiment's copy project is left in the workspace
  // (for manual inspection) instead of being deleted once judged --
  // listUndeletedCopies below is the executor's cleanup reminder either way.
  | "keep_test_copies";

// AI analysis (Round 4): these keys give the Settings page and the analysis
// pipeline (harness/src/llm/) something to read and validate. Budget is in
// tokens, not USD -- a Claude Code subscription call has no per-call price
// (see llm_monthly_token_budget below and harness/src/llm/budget.ts).
export const LLM_PROVIDERS = ["openai", "anthropic", "google", "claude_code"] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

// Round 5 Task 1: "miner" is renamed "rule_writer" (harness/src/analysis/
// propose.ts, formerly mine.ts) and a fifth role, "judge", is added for the
// adherence/verdict pipeline later Round 5 tasks build. "judge" is the only
// optional role in a stored llm_models value -- see REQUIRED_LLM_ROLES,
// assertLlmModels and getLlmModels below for the fallback an upgraded DB
// (no judge entry yet) resolves through.
export type LlmRole = "classifier" | "rule_writer" | "judge" | "reviewer" | "proposer";
const LLM_ROLES: LlmRole[] = ["classifier", "rule_writer", "judge", "reviewer", "proposer"];
const REQUIRED_LLM_ROLES: LlmRole[] = ["classifier", "rule_writer", "reviewer", "proposer"];
export type LlmModelChoice = { provider: LlmProvider; model: string };
export type LlmModels = Record<LlmRole, LlmModelChoice>;

const DEFAULT_LLM_MODELS: LlmModels = {
  classifier: { provider: "openai", model: "gpt-5.4-mini" },
  rule_writer: { provider: "openai", model: "gpt-5.5" },
  judge: { provider: "openai", model: "gpt-5.4-mini" },
  reviewer: { provider: "openai", model: "gpt-5.5" },
  proposer: { provider: "openai", model: "gpt-5.5" },
};

export const SETTING_DEFAULTS: Record<SettingKey, string> = {
  sync_enabled: "true",
  sync_interval_minutes: "60",
  sync_window_start_hour: "10",
  sync_window_end_hour: "22",
  knowledge_char_cap: "9000",
  require_approval_before_write: "true",
  llm_provider: "openai",
  llm_models: JSON.stringify(DEFAULT_LLM_MODELS),
  llm_monthly_token_budget: "2000000",
  rule_unused_after_days: "60",
  max_active_rules: "12",
  inbox_last_seen_at: "",
  decision_mode: "ask",
  decision_auto_confidence: "0.8",
  evidence_sources: JSON.stringify({
    observed: true,
    adherence: true,
    verdicts: true,
    paired: false,
  }),
  lovable_monthly_credit_budget: "12",
  keep_test_copies: "true",
};

const SETTING_KEYS = Object.keys(SETTING_DEFAULTS) as SettingKey[];
const BOOLEAN_SETTING_KEYS: SettingKey[] = [
  "sync_enabled",
  "require_approval_before_write",
  "keep_test_copies",
];

export function getSetting(key: SettingKey): string {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as
    { value: string } | undefined;
  return row?.value ?? SETTING_DEFAULTS[key];
}

export function getSettings(): Record<SettingKey, string> {
  const out = {} as Record<SettingKey, string>;
  for (const key of SETTING_KEYS) out[key] = getSetting(key);
  return out;
}

function assertIntInRange(key: SettingKey, raw: string, min: number, max: number): void {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max}`);
  }
}

function assertBooleanSetting(key: SettingKey, raw: string): void {
  if (raw !== "true" && raw !== "false") {
    throw new Error(`${key} must be true or false`);
  }
}

// Task C3: inbox_last_seen_at is either "" (never visited) or a real,
// parseable date/timestamp -- written as new Date().toISOString() by the
// "mark_seen" action, so this only ever rejects a malformed value.
function assertIsoDateOrEmpty(key: SettingKey, raw: string): void {
  if (raw === "") return;
  if (Number.isNaN(new Date(raw).getTime())) {
    throw new Error(`${key} must be an ISO date string or empty`);
  }
}

function assertLlmProvider(raw: string): void {
  if (!(LLM_PROVIDERS as readonly string[]).includes(raw)) {
    throw new Error(`llm_provider must be one of: ${LLM_PROVIDERS.join(", ")}`);
  }
}

// Round 5 Task 1: "judge" is optional -- an upgraded DB's stored llm_models
// value (rewritten miner -> rule_writer by migration v11's UPDATE, since
// rewriting JSON to also insert a new key in SQL is fragile) has no judge
// entry until the user saves one, and getLlmModels/resolveRoleModel
// (harness/src/llm/index.ts) fall back to the rule_writer entry, then the
// global llm_provider, for it. Every other role stays required -- rejecting
// a payload that still uses the old "miner" key (now just an unrecognized
// role name) rather than silently accepting it half-migrated.
function assertLlmModels(raw: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("llm_models must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("llm_models must be a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  const keys = Object.keys(obj);
  for (const role of REQUIRED_LLM_ROLES) {
    if (!(role in obj)) {
      throw new Error(
        `llm_models must define at least the roles: ${REQUIRED_LLM_ROLES.join(", ")} ("judge" is optional -- it falls back to rule_writer)`,
      );
    }
  }
  for (const key of keys) {
    if (!(LLM_ROLES as string[]).includes(key)) {
      throw new Error(
        `llm_models has an unknown role "${key}" -- expected one of: ${LLM_ROLES.join(", ")}`,
      );
    }
  }
  for (const role of keys as LlmRole[]) {
    const choice = obj[role];
    if (typeof choice !== "object" || choice === null || Array.isArray(choice)) {
      throw new Error(`llm_models.${role} must be an object with provider and model`);
    }
    const { provider, model } = choice as Record<string, unknown>;
    if (typeof provider !== "string" || !(LLM_PROVIDERS as readonly string[]).includes(provider)) {
      throw new Error(`llm_models.${role}.provider must be one of: ${LLM_PROVIDERS.join(", ")}`);
    }
    if (typeof model !== "string" || model.length === 0 || model.length > 100) {
      throw new Error(
        `llm_models.${role}.model must be a non-empty string of at most 100 characters`,
      );
    }
  }
}

// ---- Round 6c ----
// Claude Code has no per-call model id the way an API provider does -- only
// the three short aliases a Claude Code subscription accepts: "sonnet",
// "opus", "haiku". The Settings page prefills "sonnet" the moment a role's
// provider switches to Claude Code (local-settings.tsx), but a role saved
// before that existed, or edited by hand, can still arrive here with
// provider "claude_code" and an empty model -- and assertLlmModels rejected
// that outright with an unhelpful "model must be a non-empty string",
// failing the whole save. Substitute the exact same default the UI
// prefills instead, here at save time, so an empty Claude Code model always
// resolves to something callable rather than blocking the save.
const CLAUDE_CODE_DEFAULT_MODEL = "sonnet";

function normalizeLlmModels(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Malformed JSON is still assertLlmModels's job to reject with its own
    // message -- hand the raw string back unchanged.
    return raw;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return raw;
  const obj = parsed as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    const choice = obj[key];
    if (typeof choice !== "object" || choice === null || Array.isArray(choice)) continue;
    const c = choice as Record<string, unknown>;
    if (
      c.provider === "claude_code" &&
      (typeof c.model !== "string" || c.model.trim().length === 0)
    ) {
      c.model = CLAUDE_CODE_DEFAULT_MODEL;
    }
  }
  return JSON.stringify(obj);
}

function assertDecisionMode(raw: string): void {
  if (raw !== "ask" && raw !== "automatic") {
    throw new Error(`decision_mode must be "ask" or "automatic"`);
  }
}

function assertDecisionAutoConfidence(raw: string): void {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0.5 || n > 1) {
    throw new Error("decision_auto_confidence must be a number between 0.5 and 1");
  }
}

// The four sources a rule's health/verdict picture can draw on (spec §4b):
// exactly these keys, all booleans -- an extra/missing key or a non-boolean
// value is rejected rather than silently ignored.
const EVIDENCE_SOURCE_KEYS = ["observed", "adherence", "verdicts", "paired"] as const;

function assertEvidenceSources(raw: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("evidence_sources must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("evidence_sources must be a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const expected = [...EVIDENCE_SOURCE_KEYS].sort();
  if (keys.length !== expected.length || !keys.every((k, i) => k === expected[i])) {
    throw new Error(
      `evidence_sources must define exactly the keys: ${EVIDENCE_SOURCE_KEYS.join(", ")}`,
    );
  }
  for (const key of EVIDENCE_SOURCE_KEYS) {
    if (typeof obj[key] !== "boolean") {
      throw new Error(`evidence_sources.${key} must be a boolean`);
    }
  }
}

// Validates the whole patch before writing anything, so a rejected patch
// leaves every existing setting untouched (no partial application).
export function setSettings(
  patch: Partial<Record<SettingKey, string>>,
): Record<SettingKey, string> {
  const merged: Record<SettingKey, string> = { ...getSettings() };
  const toWrite: [SettingKey, string][] = [];

  for (const key of Object.keys(patch) as SettingKey[]) {
    let value = patch[key];
    if (value === undefined) continue;
    if (BOOLEAN_SETTING_KEYS.includes(key)) {
      assertBooleanSetting(key, value);
    } else if (key === "sync_interval_minutes") {
      assertIntInRange(key, value, 15, 1440);
    } else if (key === "knowledge_char_cap") {
      assertIntInRange(key, value, 1000, 10000);
    } else if (key === "llm_provider") {
      assertLlmProvider(value);
    } else if (key === "llm_models") {
      // Round 6c: fill in Claude Code's default model before validating,
      // so an empty model on a claude_code role never fails the save.
      value = normalizeLlmModels(value);
      assertLlmModels(value);
    } else if (key === "llm_monthly_token_budget") {
      assertIntInRange(key, value, 100_000, 50_000_000);
    } else if (key === "rule_unused_after_days") {
      assertIntInRange(key, value, 7, 365);
    } else if (key === "max_active_rules") {
      assertIntInRange(key, value, 1, 50);
    } else if (key === "inbox_last_seen_at") {
      assertIsoDateOrEmpty(key, value);
    } else if (key === "decision_mode") {
      assertDecisionMode(value);
    } else if (key === "decision_auto_confidence") {
      assertDecisionAutoConfidence(value);
    } else if (key === "evidence_sources") {
      assertEvidenceSources(value);
    } else if (key === "lovable_monthly_credit_budget") {
      assertIntInRange(key, value, 0, 1000);
    } else {
      // sync_window_start_hour / sync_window_end_hour
      assertIntInRange(key, value, 0, 24);
    }
    merged[key] = value;
    toWrite.push([key, value]);
  }

  if (patch.sync_window_start_hour !== undefined || patch.sync_window_end_hour !== undefined) {
    if (!(Number(merged.sync_window_start_hour) < Number(merged.sync_window_end_hour))) {
      throw new Error("sync_window_start_hour must be before sync_window_end_hour");
    }
  }

  const upsert = db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  const writeAll = db.transaction((entries: [SettingKey, string][]) => {
    for (const [key, value] of entries) upsert.run(key, value);
  });
  writeAll(toWrite);

  if (toWrite.length) insertEvent("settings.updated", null, { keys: toWrite.map(([k]) => k) });
  return getSettings();
}

// Round 5 Task 1: the llm_models setting, fully resolved -- every role
// always has a provider/model, even right after an upgrade whose stored
// value has no "judge" entry yet (migration v11 only renames miner ->
// rule_writer; it never invents a judge entry, since editing JSON in SQL is
// fragile). Fallback chain per role: its own entry, else (judge only) the
// rule_writer entry, else the global llm_provider paired with that role's
// DEFAULT_LLM_MODELS model. harness/src/llm/index.ts's resolveRoleModel
// calls this rather than re-parsing the setting itself, so the fallback
// lives in exactly one place.
export function getLlmModels(): LlmModels {
  let raw: Partial<Record<LlmRole, LlmModelChoice>> = {};
  try {
    raw = JSON.parse(getSetting("llm_models")) as Partial<Record<LlmRole, LlmModelChoice>>;
  } catch {
    raw = {};
  }
  const fallbackProvider = getSetting("llm_provider") as LlmProvider;
  const resolve = (role: LlmRole): LlmModelChoice =>
    raw[role] ?? { provider: fallbackProvider, model: DEFAULT_LLM_MODELS[role].model };
  const ruleWriter = resolve("rule_writer");
  return {
    classifier: resolve("classifier"),
    rule_writer: ruleWriter,
    judge: raw.judge ?? ruleWriter,
    reviewer: resolve("reviewer"),
    proposer: resolve("proposer"),
  };
}

// A verbatim copy of a Lovable Skill, deduped by content hash per
// (workspace_id, name) so re-fetching an unchanged Skill is a no-op.
export function recordSkillSnapshot(input: {
  workspace_id: string;
  name: string;
  description: string | null;
  content: string;
  updated_at_remote: string | null;
  fetched_by: string;
}): { id: number; inserted: boolean } {
  const sha = knowledgeSha256(input.content);
  const latest = db
    .prepare(
      `SELECT id, sha256, deleted FROM skill_snapshots WHERE workspace_id = ? AND name = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(input.workspace_id, input.name) as
    | { id: number; sha256: string; deleted: number }
    | undefined;
  if (latest && latest.sha256 === sha && latest.deleted === 0) {
    return { id: latest.id, inserted: false };
  }
  const row = db
    .prepare(
      `INSERT INTO skill_snapshots (workspace_id, name, description, content, sha256, updated_at_remote, fetched_by)
       VALUES (@workspace_id, @name, @description, @content, @sha256, @updated_at_remote, @fetched_by)
       RETURNING id`,
    )
    .get({
      workspace_id: input.workspace_id,
      name: input.name,
      description: input.description,
      content: input.content,
      sha256: sha,
      updated_at_remote: input.updated_at_remote,
      fetched_by: input.fetched_by,
    }) as { id: number };
  insertEvent("skill_snapshot.recorded", null, {
    id: row.id,
    workspace_id: input.workspace_id,
    name: input.name,
  });
  return { id: row.id, inserted: true };
}

/** Records that a skill Harness knew about is gone from Lovable (Round 7).
 * Returns false when its latest snapshot already says so. */
export function recordSkillDeleted(workspaceId: string, name: string, fetchedBy: string): boolean {
  const latest = db
    .prepare(
      `SELECT deleted FROM skill_snapshots WHERE workspace_id = ? AND name = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(workspaceId, name) as { deleted: number } | undefined;
  if (!latest || latest.deleted === 1) return false;
  db.prepare(
    `INSERT INTO skill_snapshots (workspace_id, name, description, content, sha256, updated_at_remote, fetched_by, deleted)
     VALUES (?, ?, NULL, '', ?, NULL, ?, 1)`,
  ).run(workspaceId, name, knowledgeSha256(""), fetchedBy);
  insertEvent("skill_snapshot.deleted", null, { workspace_id: workspaceId, name });
  return true;
}

export function latestSkillSnapshots(
  workspaceId: string,
  opts: { includeDeleted?: boolean } = {},
): {
  name: string;
  description: string | null;
  content: string;
  sha256: string;
  updated_at_remote: string | null;
  fetched_at: string;
}[] {
  return db
    .prepare(
      `SELECT name, description, content, sha256, updated_at_remote, fetched_at
       FROM skill_snapshots s
       WHERE workspace_id = ?
         AND id = (
           SELECT id FROM skill_snapshots s2
           WHERE s2.workspace_id = s.workspace_id AND s2.name = s.name
           ORDER BY id DESC LIMIT 1
         )
         ${opts.includeDeleted ? "" : "AND s.deleted = 0"}
       ORDER BY name`,
    )
    .all(workspaceId) as {
    name: string;
    description: string | null;
    content: string;
    sha256: string;
    updated_at_remote: string | null;
    fetched_at: string;
  }[];
}

export function startSyncRun(kind: "scheduled" | "manual" | "once"): number {
  const row = db.prepare(`INSERT INTO sync_runs (kind) VALUES (?) RETURNING id`).get(kind) as {
    id: number;
  };
  insertEvent("sync_run.started", null, { id: row.id, kind });
  return row.id;
}

export function finishSyncRun(
  id: number,
  result: { ok: boolean; error?: string | null; counts?: Record<string, number> },
): void {
  db.prepare(
    `UPDATE sync_runs SET finished_at = datetime('now'), ok = ?, error = ?, counts_json = ? WHERE id = ?`,
  ).run(result.ok ? 1 : 0, result.error ?? null, JSON.stringify(result.counts ?? {}), id);
  insertEvent("sync_run.finished", null, { id, ok: result.ok, error: result.error ?? null });
}

export function latestSyncRun(): {
  id: number;
  kind: string;
  started_at: string;
  finished_at: string | null;
  ok: number | null;
  error: string | null;
  counts: Record<string, number>;
} | null {
  const row = db.prepare(`SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1`).get() as
    | {
        id: number;
        kind: string;
        started_at: string;
        finished_at: string | null;
        ok: number | null;
        error: string | null;
        counts_json: string;
      }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    started_at: row.started_at,
    finished_at: row.finished_at,
    ok: row.ok,
    error: row.error,
    counts: JSON.parse(row.counts_json) as Record<string, number>,
  };
}

// finished_at IS NULL and started within the last 15 minutes -- a run that
// has been "running" longer than that is treated as stuck/crashed, not
// blocking a fresh one.
export function runningSyncRun(): { id: number; started_at: string } | null {
  const row = db
    .prepare(
      `SELECT id, started_at FROM sync_runs
       WHERE finished_at IS NULL AND started_at >= datetime('now', '-15 minutes')
       ORDER BY id DESC LIMIT 1`,
    )
    .get() as { id: number; started_at: string } | undefined;
  return row ?? null;
}

// Coalesced "sync now": returns the existing open request instead of
// stacking a second one.
export function requestSync(): { id: number; created: boolean } {
  const existing = db
    .prepare(`SELECT id FROM sync_requests WHERE status = 'requested' ORDER BY id ASC LIMIT 1`)
    .get() as { id: number } | undefined;
  if (existing) return { id: existing.id, created: false };
  const row = db.prepare(`INSERT INTO sync_requests DEFAULT VALUES RETURNING id`).get() as {
    id: number;
  };
  insertEvent("sync_request.created", null, { id: row.id });
  return { id: row.id, created: true };
}

// The scheduler only needs to know that work was asked for; taking the
// request is runAll's job.
export function hasOpenSyncRequest(): boolean {
  return (
    db.prepare(`SELECT 1 FROM sync_requests WHERE status = 'requested' LIMIT 1`).get() !== undefined
  );
}

export function takeSyncRequest(runId: number): number | null {
  const existing = db
    .prepare(`SELECT id FROM sync_requests WHERE status = 'requested' ORDER BY id ASC LIMIT 1`)
    .get() as { id: number } | undefined;
  if (!existing) return null;
  db.prepare(`UPDATE sync_requests SET status = 'running', run_id = ? WHERE id = ?`).run(
    runId,
    existing.id,
  );
  insertEvent("sync_request.taken", null, { id: existing.id, run_id: runId });
  return existing.id;
}

export function completeSyncRequest(id: number): void {
  db.prepare(`UPDATE sync_requests SET status = 'done' WHERE id = ?`).run(id);
  insertEvent("sync_request.completed", null, { id });
}

// A history sync that hit its per-pass page budget parks its next_cursor
// here; the next pass resumes older history from it and clears it when the
// project's history has been read to the end.
export function getSyncCursor(projectId: string): string | null {
  const row = db.prepare(`SELECT cursor FROM sync_cursors WHERE project_id = ?`).get(projectId) as
    { cursor: string } | undefined;
  return row?.cursor ?? null;
}

export function setSyncCursor(projectId: string, cursor: string): void {
  db.prepare(
    `INSERT INTO sync_cursors (project_id, cursor, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(project_id) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
  ).run(projectId, cursor);
}

export function clearSyncCursor(projectId: string): void {
  db.prepare(`DELETE FROM sync_cursors WHERE project_id = ?`).run(projectId);
}

// Round 6c part A / item 4: this used to check task_episode_evidence (a UI
// counter that predates message_classifications, per the comment at "----
// Round 4 A1 ----" below) -- but not every synced user message ever becomes
// task_episode_evidence (that only happens once segmentEpisodes groups it
// into an episode, a later pipeline step), while every synced user message
// does get classified first. A message with no task_episode_evidence row
// read as "not awaiting analysis" even when it had never been classified at
// all -- the owner's four real synced messages, reproduced: none had a
// message_classifications row, yet this reported 0. message_classifications
// is the actual "has analysis looked at this message yet" record (see
// listUnclassifiedUserMessages just below, which classifyPending itself
// works through) -- this now counts the exact same thing that function
// lists, so the two can never disagree again.
export function countHistoryItemsAwaitingAnalysis(): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) as n FROM history_items hi
       WHERE hi.kind = 'message' AND hi.role = 'user'
         AND NOT EXISTS (SELECT 1 FROM message_classifications mc WHERE mc.history_item_id = hi.id)`,
    )
    .get() as { n: number };
  return row.n;
}

export function listHistoryStats(): {
  project_id: string;
  history_count: number;
  last_synced_at: string | null;
}[] {
  return db
    .prepare(
      `SELECT ap.lovable_project_id as project_id,
              COUNT(hi.id) as history_count,
              MAX(hi.created_at) as last_synced_at
       FROM allowed_projects ap
       LEFT JOIN history_items hi ON hi.project_id = ap.lovable_project_id
       GROUP BY ap.lovable_project_id
       ORDER BY ap.lovable_project_id`,
    )
    .all() as { project_id: string; history_count: number; last_synced_at: string | null }[];
}

export function latestHistoryExternalIds(projectId: string, limit: number): Set<string> {
  const rows = db
    .prepare(
      `SELECT external_id FROM history_items
       WHERE project_id = ? AND kind = 'message' AND external_id IS NOT NULL
       ORDER BY id DESC LIMIT ?`,
    )
    .all(projectId, limit) as { external_id: string }[];
  return new Set(rows.map((r) => r.external_id));
}

// Curating allowed_projects from the UI (distinct from the out-of-band
// `npm run seed` flow): insert-or-ignore, never touching history_items.
// Disallow removes only the permission row -- history rows for that project
// are left exactly as they are, so re-allowing the same project later loses
// nothing. Foreign key enforcement is relaxed around the delete only (every
// other table's project_id column deliberately has no ON DELETE action,
// because that history must survive a permission change) and restored
// immediately after.
export function allowProject(lovableProjectId: string, label: string) {
  db.prepare(
    `INSERT OR IGNORE INTO allowed_projects (lovable_project_id, label) VALUES (?, ?)`,
  ).run(lovableProjectId, label);
  insertEvent("allowed_project.allowed", lovableProjectId, { label });
  return db
    .prepare(`SELECT * FROM allowed_projects WHERE lovable_project_id = ?`)
    .get(lovableProjectId);
}

export function disallowProject(lovableProjectId: string): void {
  // Safe only because better-sqlite3 is synchronous: nothing else can run a
  // statement on this connection between the two pragma calls.
  db.pragma("foreign_keys = OFF");
  try {
    db.prepare(`DELETE FROM allowed_projects WHERE lovable_project_id = ?`).run(lovableProjectId);
  } finally {
    db.pragma("foreign_keys = ON");
  }
  insertEvent("allowed_project.disallowed", lovableProjectId, {});
}

// ---- Task 4: experiment plan status ----
// Moves an experiment plan between the three states the schema allows
// (proposed/approved/rejected) -- e.g. when the user chooses "test it
// first" on an Improvement, approving the rule also approves its plan.
export function setExperimentPlanStatus(
  id: number,
  status: "proposed" | "approved" | "rejected",
  actor: string,
) {
  const existing = db.prepare(`SELECT id FROM experiment_plans WHERE id = ?`).get(id);
  if (!existing) throw new Error(`experiment plan ${id} not found`);
  db.prepare(
    `UPDATE experiment_plans SET status = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(status, id);
  insertEvent("experiment_plan.status_changed", null, { id, status, actor });
  return getExperimentPlan(id);
}
// ---- end Task 4 ----

// ---- Task 4 round 2: cancelled writes ----
// A cancelled write is not a failure: it means a decision changed (skip,
// reopen, or switching to test-first) before the executor got to it, not
// that Harness tried and failed to write it. Keeping "cancelled" distinct
// from "failed" stops cancelPendingKnowledgeWrites from making an
// unrelated, ordinary decision change read as "Needs attention: adding
// failed" in the UI.
export function markKnowledgeWriteCancelled(versionId: number, reason: string) {
  requirePendingVersion(versionId);
  db.prepare(`UPDATE knowledge_versions SET status = 'cancelled', error = ? WHERE id = ?`).run(
    reason,
    versionId,
  );
  insertEvent("knowledge_version.cancelled", null, { id: versionId, reason });
  return getKnowledgeVersion(versionId);
}
// ---- end Task 4 round 2 ----

// ---- Task 5: rule → improvement ----
// The inverse of getRuleForCorrection: given a rule, the correction
// candidate id it exists to fix. The Knowledge routes use this to link each
// active rule shown in a managed block back to its Improvement.
export function getCorrectionIdForRule(ruleId: number): number | null {
  const row = db.prepare(`SELECT correction_candidate_id FROM rules WHERE id = ?`).get(ruleId) as
    { correction_candidate_id: number } | undefined;
  return row ? row.correction_candidate_id : null;
}
// ---- end Task 5 ----

// ---- Round 3 (v8): per-project settings ----
// Overrides of the two global defaults that matter per-project: how many
// active rules a project's managed Knowledge block may carry, and whether
// the executor is allowed to write approved changes for it automatically.
// No row for a project means "use the defaults" -- see effectiveMaxActiveRules
// and executeWrites' auto_write check in executor/beats.ts.

export type ProjectSettings = { max_active_rules: number | null; auto_write: boolean };

const PROJECT_SETTINGS_DEFAULT: ProjectSettings = { max_active_rules: null, auto_write: true };

export function getProjectSettings(projectId: string): ProjectSettings {
  const row = db
    .prepare(`SELECT max_active_rules, auto_write FROM project_settings WHERE project_id = ?`)
    .get(projectId) as { max_active_rules: number | null; auto_write: number } | undefined;
  if (!row) return { ...PROJECT_SETTINGS_DEFAULT };
  return { max_active_rules: row.max_active_rules, auto_write: row.auto_write === 1 };
}

function assertMaxActiveRules(value: number | null): void {
  if (value === null) return;
  if (!Number.isInteger(value) || value < 1 || value > 50) {
    throw new Error(
      "max_active_rules must be an integer between 1 and 50, or null to use the default",
    );
  }
}

// Validates before writing anything and only touches the fields present in
// the patch, mirroring setSettings' all-or-nothing behavior.
export function setProjectSettings(
  projectId: string,
  patch: { max_active_rules?: number | null; auto_write?: boolean },
): ProjectSettings {
  assertAllowedProject(projectId);
  if (patch.max_active_rules !== undefined) assertMaxActiveRules(patch.max_active_rules);

  const current = getProjectSettings(projectId);
  const merged: ProjectSettings = {
    max_active_rules:
      patch.max_active_rules === undefined ? current.max_active_rules : patch.max_active_rules,
    auto_write: patch.auto_write === undefined ? current.auto_write : patch.auto_write,
  };

  db.prepare(
    `INSERT INTO project_settings (project_id, max_active_rules, auto_write, updated_at)
     VALUES (@project_id, @max_active_rules, @auto_write, datetime('now'))
     ON CONFLICT(project_id) DO UPDATE SET
       max_active_rules = excluded.max_active_rules, auto_write = excluded.auto_write, updated_at = excluded.updated_at`,
  ).run({
    project_id: projectId,
    max_active_rules: merged.max_active_rules,
    auto_write: merged.auto_write ? 1 : 0,
  });
  insertEvent("project_settings.updated", projectId, { ...merged });
  return merged;
}

// The project's own override when set, else the global default -- what
// knowledge.ts's compose step and improvements.ts's preview should actually
// enforce for a project target.
export function effectiveMaxActiveRules(projectId: string): number {
  const override = getProjectSettings(projectId).max_active_rules;
  return override ?? Number(getSetting("max_active_rules"));
}
// ---- end round 3 per-project settings ----

// ---- Round 3 (v8): LLM calls ----
// Empty until AI analysis ships; insertLlmCall exists now so that feature
// has somewhere to record to, and sumLlmCostThisMonth/listLlmCalls exist now
// so the Settings page's "Spent this month" line and any future calls list
// are real reads from day one, not placeholders swapped in later.

export function insertLlmCall(input: {
  role: LlmRole;
  provider: string;
  model: string;
  tokens_in?: number;
  tokens_out?: number;
  cost_usd?: number;
  estimated_tokens?: number;
  run_id?: number | null;
}) {
  const row = db
    .prepare(
      `INSERT INTO llm_calls (role, provider, model, tokens_in, tokens_out, cost_usd, estimated_tokens, run_id)
       VALUES (@role, @provider, @model, @tokens_in, @tokens_out, @cost_usd, @estimated_tokens, @run_id) RETURNING *`,
    )
    .get({
      role: input.role,
      provider: input.provider,
      model: input.model,
      tokens_in: input.tokens_in ?? 0,
      tokens_out: input.tokens_out ?? 0,
      cost_usd: input.cost_usd ?? 0,
      estimated_tokens: input.estimated_tokens ?? 0,
      run_id: input.run_id ?? null,
    }) as { id: number };
  insertEvent("llm_call.recorded", null, {
    id: row.id,
    role: input.role,
    provider: input.provider,
  });
  return row;
}

// SQLite's datetime('now') (what created_at defaults to) is UTC, so
// strftime('%Y-%m', ...) comparisons here are UTC-month comparisons without
// any extra timezone handling.
export function sumLlmCostThisMonth(): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) as total FROM llm_calls
       WHERE strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')`,
    )
    .get() as { total: number };
  return row.total;
}

// Round 4 (v9): the analysis budget guard is token-based (harness/src/llm/
// budget.ts) -- a Claude Code subscription call has no per-call USD price,
// so tokens are the one number every provider can be metered by.
export function sumLlmTokensThisMonth(): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(tokens_in + tokens_out), 0) as total FROM llm_calls
       WHERE strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')`,
    )
    .get() as { total: number };
  return row.total;
}

export function listLlmCalls(limit = 50) {
  return db.prepare(`SELECT * FROM llm_calls ORDER BY id DESC LIMIT ?`).all(limit);
}
// ---- end round 3 LLM calls ----

// ---- Round 3 Task 2 ----
// Every skill_snapshots row for one (workspace_id, name), oldest first, so
// the Skills route can compute an added/removed line diff between each
// consecutive pair (skills.ts, mirroring the knowledge route's per-version
// diff). latestSkillSnapshots above only ever returns the newest row per
// name; this returns the whole history for one name.
export function listSkillSnapshots(
  workspaceId: string,
  name: string,
): {
  id: number;
  content: string;
  sha256: string;
  updated_at_remote: string | null;
  fetched_at: string;
  deleted: number;
}[] {
  return db
    .prepare(
      `SELECT id, content, sha256, updated_at_remote, fetched_at, deleted
       FROM skill_snapshots
       WHERE workspace_id = ? AND name = ?
       ORDER BY id ASC`,
    )
    .all(workspaceId, name) as {
    id: number;
    content: string;
    sha256: string;
    updated_at_remote: string | null;
    fetched_at: string;
    deleted: number;
  }[];
}
// ---- end round 3 Task 2 ----

// ---- Round 4 C1 ----
// Rule health (spec §4b): applicable/helped/hurt counts and a retirement
// signal for each live rule, recomputed by harness/src/analysis/health.ts
// after every sync/analysis run (see executor/beats.ts runAll). Pure
// data-layer only -- the thresholds and the computation itself live in
// health.ts; this block is CRUD over rule_health plus the two read-shapes
// health.ts needs: live rules with their Knowledge target and first write
// date, and task episodes after a given date with their classification
// tags/corrections.

export type RuleHealthStatus = "healthy" | "watch" | "retire_suggested" | "snoozed";

export type RuleHealthRow = {
  rule_id: number;
  applicable_tasks: number;
  helped: number;
  hurt: number;
  last_applicable_at: string | null;
  contradicted_by_rule_id: number | null;
  unused_since: string | null;
  status: RuleHealthStatus;
  snoozed_until: string | null;
  computed_at: string;
  // Round 4 fix wave item 4 (migration v10): null until a rule is ever
  // "Re-add"ed (improvements.ts's readd action); once set,
  // health.ts's recomputeRuleHealth uses max(first_written_at, baseline_at)
  // as the episode window start, so hurt/contradiction history from before
  // a re-add never counts against the readded rule again.
  baseline_at: string | null;
};

export function getRuleHealth(ruleId: number): RuleHealthRow | null {
  return (db.prepare(`SELECT * FROM rule_health WHERE rule_id = ?`).get(ruleId) ??
    null) as RuleHealthRow | null;
}

export function listRuleHealth(): RuleHealthRow[] {
  return db.prepare(`SELECT * FROM rule_health ORDER BY rule_id`).all() as RuleHealthRow[];
}

export function upsertRuleHealth(row: {
  rule_id: number;
  applicable_tasks: number;
  helped: number;
  hurt: number;
  last_applicable_at: string | null;
  contradicted_by_rule_id: number | null;
  unused_since: string | null;
  status: RuleHealthStatus;
  snoozed_until: string | null;
  // Optional: every existing caller (health.ts's recomputeRuleHealth,
  // snoozeRuleHealth, mine.ts's recordContradiction) omits this and gets the
  // row's current baseline_at carried forward unchanged (null for a
  // brand-new row) -- only rebaselineRuleHealth below ever sets it.
  baseline_at?: string | null;
}): RuleHealthRow {
  const existing = getRuleHealth(row.rule_id);
  const baselineAt =
    row.baseline_at !== undefined ? row.baseline_at : (existing?.baseline_at ?? null);
  const result = db
    .prepare(
      `INSERT INTO rule_health
         (rule_id, applicable_tasks, helped, hurt, last_applicable_at, contradicted_by_rule_id,
          unused_since, status, snoozed_until, baseline_at, computed_at)
       VALUES (@rule_id, @applicable_tasks, @helped, @hurt, @last_applicable_at, @contradicted_by_rule_id,
               @unused_since, @status, @snoozed_until, @baseline_at, datetime('now'))
       ON CONFLICT(rule_id) DO UPDATE SET
         applicable_tasks = excluded.applicable_tasks,
         helped = excluded.helped,
         hurt = excluded.hurt,
         last_applicable_at = excluded.last_applicable_at,
         contradicted_by_rule_id = excluded.contradicted_by_rule_id,
         unused_since = excluded.unused_since,
         status = excluded.status,
         snoozed_until = excluded.snoozed_until,
         baseline_at = excluded.baseline_at,
         computed_at = excluded.computed_at
       RETURNING *`,
    )
    .get({ ...row, baseline_at: baselineAt }) as RuleHealthRow;
  insertEvent("rule_health.upserted", null, { rule_id: row.rule_id, status: row.status });
  return result;
}

// Round 4 fix wave item 4: "Re-add" (Task C2's readd action) resets the
// health window -- sets baseline_at to now and clears unused_since /
// contradicted_by_rule_id immediately (rather than waiting for the next
// recomputeRuleHealth pass to notice), so a re-added rule starts clean.
// applicable_tasks/helped/hurt/status are left for the next
// recomputeRuleHealth call to fill in correctly against the new window --
// same "recomputed after every sync/analysis run" pattern every other
// rule_health field already follows. Upserts a minimal row when the rule
// has never been scored yet, same as snoozeRuleHealth.
export function rebaselineRuleHealth(ruleId: number, baselineAtIso: string): RuleHealthRow {
  const existing = getRuleHealth(ruleId);
  const result = upsertRuleHealth({
    rule_id: ruleId,
    applicable_tasks: existing?.applicable_tasks ?? 0,
    helped: existing?.helped ?? 0,
    hurt: existing?.hurt ?? 0,
    last_applicable_at: existing?.last_applicable_at ?? null,
    contradicted_by_rule_id: null,
    unused_since: null,
    status: existing?.status ?? "healthy",
    snoozed_until: existing?.snoozed_until ?? null,
    baseline_at: baselineAtIso,
  });
  insertEvent("rule_health.rebaselined", null, { rule_id: ruleId, baseline_at: baselineAtIso });
  return result;
}

// A human "Keep" decision on a retirement proposal (Task C2): the signal is
// acknowledged but not acted on for a while (30 days, per the spec). C2 can
// call this on a rule rule_health has never scored yet (e.g. right after the
// rule went live, before any recompute has run), so a missing row upserts a
// minimal all-zero one rather than throwing -- the next recomputeRuleHealth
// fills in the real counts while carrying the snooze forward (health.ts
// reads and preserves an existing row's snoozed_until).
export function snoozeRuleHealth(ruleId: number, untilIso: string): RuleHealthRow {
  const existing = getRuleHealth(ruleId);
  const result = upsertRuleHealth({
    rule_id: ruleId,
    applicable_tasks: existing?.applicable_tasks ?? 0,
    helped: existing?.helped ?? 0,
    hurt: existing?.hurt ?? 0,
    last_applicable_at: existing?.last_applicable_at ?? null,
    contradicted_by_rule_id: existing?.contradicted_by_rule_id ?? null,
    unused_since: existing?.unused_since ?? null,
    status: "snoozed",
    snoozed_until: untilIso,
  });
  insertEvent("rule_health.snoozed", null, { rule_id: ruleId, until: untilIso });
  return result;
}

export type LiveRuleWithTarget = {
  id: number;
  instruction: string;
  scope: "project" | "workspace";
  project_id: string | null;
  workspace_id: string | null;
  failure_signature: string;
  prediction: string;
  scope_tags: string[];
  first_written_at: string | null;
};

// Live = state 'active'. A rule with no written Knowledge version (never
// actually landed in Lovable) has no "since added" baseline, so the inner
// join below excludes it rather than health.ts having to special-case a
// null first_written_at. first_written_at/project_id/workspace_id come from
// the EARLIEST 'written' knowledge_versions row for that rule -- SQLite's
// documented bare-column behaviour ("when a query has exactly one min() or
// max(), bare columns in the result take their value from the input row
// that produced it") makes the aggregate below pull project_id/workspace_id
// from that same earliest row, not an arbitrary one in the group.
export function listLiveRulesWithTargets(): LiveRuleWithTarget[] {
  const rows = db
    .prepare(
      `SELECT r.id, r.instruction, r.scope, r.predicted_failure as prediction, r.scope_tags_json,
              kv.project_id, kv.workspace_id, kv.first_written_at
       FROM rules r
       JOIN (
         SELECT rule_id, MIN(written_at) as first_written_at, project_id, workspace_id
         FROM knowledge_versions
         WHERE status = 'written' AND rule_id IS NOT NULL AND written_at IS NOT NULL
         GROUP BY rule_id
       ) kv ON kv.rule_id = r.id
       WHERE r.state = 'active'
       ORDER BY r.id`,
    )
    .all() as {
    id: number;
    instruction: string;
    scope: "project" | "workspace";
    prediction: string;
    scope_tags_json: string;
    project_id: string | null;
    workspace_id: string | null;
    first_written_at: string | null;
  }[];

  const failureSignatureStmt = db.prepare(
    `SELECT failure_signature FROM verification_plans WHERE rule_id = ? ORDER BY id DESC LIMIT 1`,
  );

  return rows.map((r) => {
    const plan = failureSignatureStmt.get(r.id) as { failure_signature: string } | undefined;
    let parsedTags: unknown = null;
    try {
      parsedTags = JSON.parse(r.scope_tags_json);
    } catch {
      parsedTags = null;
    }
    const scopeTags =
      Array.isArray(parsedTags) && parsedTags.length > 0 ? (parsedTags as string[]) : ["general"];
    return {
      id: r.id,
      instruction: r.instruction,
      scope: r.scope,
      project_id: r.project_id,
      workspace_id: r.workspace_id,
      failure_signature: plan?.failure_signature ?? "",
      prediction: r.prediction,
      scope_tags: scopeTags,
      first_written_at: r.first_written_at,
    };
  });
}

export type EpisodeAfter = {
  id: number;
  project_id: string | null;
  started_at: string;
  tags: string[];
  corrections: { history_item_id: number; summary: string }[];
};

// Episodes started strictly after sinceIso, in one project (project scope)
// or every project (workspace scope, projectId === null). tags is the union
// of message_classifications.tags_json across the episode's evidence
// messages; corrections is that same evidence filtered to
// classification = 'correction', with each one's summary taken from
// message_classifications.summary, falling back to the first 200 chars of
// the message itself when the classifier left no summary.
export function listEpisodesAfter(projectId: string | null, sinceIso: string): EpisodeAfter[] {
  const episodes = (
    projectId == null
      ? db
          .prepare(
            `SELECT id, project_id, started_at FROM task_episodes
             WHERE started_at IS NOT NULL AND julianday(started_at) > julianday(?)
             ORDER BY started_at`,
          )
          .all(sinceIso)
      : db
          .prepare(
            `SELECT id, project_id, started_at FROM task_episodes
             WHERE started_at IS NOT NULL AND julianday(started_at) > julianday(?) AND project_id = ?
             ORDER BY started_at`,
          )
          .all(sinceIso, projectId)
  ) as { id: number; project_id: string | null; started_at: string }[];

  const tagsStmt = db.prepare(
    `SELECT mc.tags_json FROM task_episode_evidence tee
     JOIN message_classifications mc ON mc.history_item_id = tee.history_item_id
     WHERE tee.task_episode_id = ?`,
  );
  const correctionsStmt = db.prepare(
    `SELECT hi.id as history_item_id, mc.summary as summary, hi.content as content
     FROM task_episode_evidence tee
     JOIN history_items hi ON hi.id = tee.history_item_id
     JOIN message_classifications mc ON mc.history_item_id = hi.id
     WHERE tee.task_episode_id = ? AND mc.classification = 'correction'
     ORDER BY hi.id`,
  );

  return episodes.map((ep) => {
    const tagRows = tagsStmt.all(ep.id) as { tags_json: string }[];
    const tagSet = new Set<string>();
    for (const row of tagRows) {
      try {
        const parsed = JSON.parse(row.tags_json);
        if (Array.isArray(parsed)) {
          for (const t of parsed) if (typeof t === "string") tagSet.add(t);
        }
      } catch {
        // malformed tags_json contributes no tags rather than failing the whole read
      }
    }
    const correctionRows = correctionsStmt.all(ep.id) as {
      history_item_id: number;
      summary: string;
      content: string;
    }[];
    return {
      id: ep.id,
      project_id: ep.project_id,
      started_at: ep.started_at,
      tags: [...tagSet],
      corrections: correctionRows.map((c) => ({
        history_item_id: c.history_item_id,
        summary: c.summary && c.summary.length > 0 ? c.summary : c.content.slice(0, 200),
      })),
    };
  });
}
// ---- end Round 4 C1 ----

// ---- Round 4 A1 ----
// Data access for harness/src/analysis/classify.ts and segment.ts.
// message_classifications (migration v9) is the pipeline's own per-message
// record, one row per classified user history_item -- the awaiting-analysis
// count above now shares this exact predicate (Round 6c part A / item 4)
// rather than the older, looser task_episode_evidence one.

export type MessageClassificationValue =
  "new_task" | "correction" | "question" | "approval" | "other";

export type UnclassifiedUserMessage = {
  id: number;
  project_id: string | null;
  content: string;
  occurred_at: string | null;
  external_id: string | null;
};

/** Oldest-first, kind='message'/role='user' history_items with no
 * message_classifications row yet -- what classifyPending works through. */
export function listUnclassifiedUserMessages(limit: number): UnclassifiedUserMessage[] {
  return db
    .prepare(
      `SELECT hi.id, hi.project_id, hi.content, hi.occurred_at, hi.external_id
       FROM history_items hi
       WHERE hi.kind = 'message' AND hi.role = 'user'
         AND NOT EXISTS (SELECT 1 FROM message_classifications mc WHERE mc.history_item_id = hi.id)
       ORDER BY hi.occurred_at ASC, hi.id ASC
       LIMIT ?`,
    )
    .all(limit) as UnclassifiedUserMessage[];
}

export type ContextMessage = {
  id: number;
  project_id: string | null;
  role: "user" | "assistant" | "system" | "operator" | null;
  content: string;
  occurred_at: string | null;
};

/** The `n` messages (any role, same project, kind='message') immediately
 * before `historyItemId` in occurred_at/id order, returned oldest-first --
 * the context window classifyPending assembles into the classifier prompt.
 * Row-value comparison on (occurred_at, id) so ties on occurred_at (or a
 * null occurred_at, via `IS`) still resolve strictly by insertion order. */
export function listContextBefore(historyItemId: number, n = 3): ContextMessage[] {
  const target = db
    .prepare(`SELECT project_id, occurred_at, id FROM history_items WHERE id = ?`)
    .get(historyItemId) as
    { project_id: string | null; occurred_at: string | null; id: number } | undefined;
  if (!target) return [];
  const rows = db
    .prepare(
      `SELECT id, project_id, role, content, occurred_at
       FROM history_items
       WHERE kind = 'message'
         AND project_id IS ?
         AND (occurred_at, id) < (?, ?)
       ORDER BY occurred_at DESC, id DESC
       LIMIT ?`,
    )
    .all(target.project_id, target.occurred_at, target.id, n) as ContextMessage[];
  return rows.reverse();
}

/** Inserts one message_classifications row (PK history_item_id -- callers
 * only pass ids from listUnclassifiedUserMessages, so this never conflicts
 * in normal use). `tags` is stored as JSON; validation/clamping of the raw
 * LLM output happens in classify.ts before this is called. */
export function insertMessageClassification(input: {
  history_item_id: number;
  classification: MessageClassificationValue;
  tags: string[];
  summary: string;
  run_id?: number | null;
}) {
  return db
    .prepare(
      `INSERT INTO message_classifications (history_item_id, classification, tags_json, summary, run_id)
       VALUES (@history_item_id, @classification, @tags_json, @summary, @run_id)
       RETURNING *`,
    )
    .get({
      history_item_id: input.history_item_id,
      classification: input.classification,
      tags_json: JSON.stringify(input.tags),
      summary: input.summary,
      run_id: input.run_id ?? null,
    });
}

export type ClassifiedUserMessage = {
  history_item_id: number;
  occurred_at: string | null;
  classification: MessageClassificationValue;
  tags: string[];
  summary: string;
};

/** Every classified user message for a project, oldest first -- what
 * segmentEpisodes walks to reconstruct task episodes. */
export function listClassifiedUserMessages(projectId: string): ClassifiedUserMessage[] {
  const rows = db
    .prepare(
      `SELECT hi.id as history_item_id, hi.occurred_at, mc.classification, mc.tags_json, mc.summary
       FROM history_items hi
       JOIN message_classifications mc ON mc.history_item_id = hi.id
       WHERE hi.project_id = ? AND hi.kind = 'message' AND hi.role = 'user'
       ORDER BY hi.occurred_at ASC, hi.id ASC`,
    )
    .all(projectId) as {
    history_item_id: number;
    occurred_at: string | null;
    classification: MessageClassificationValue;
    tags_json: string;
    summary: string;
  }[];
  return rows.map((row) => ({
    history_item_id: row.history_item_id,
    occurred_at: row.occurred_at,
    classification: row.classification,
    tags: JSON.parse(row.tags_json) as string[],
    summary: row.summary,
  }));
}

/** The task_episode a history_item is already linked to as evidence, or
 * null -- segmentEpisodes' idempotency check (task_episode_evidence, v2,
 * already carries history_item_id; no separate link table needed here). */
export function episodeForHistoryItem(historyItemId: number): number | null {
  const row = db
    .prepare(`SELECT task_episode_id FROM task_episode_evidence WHERE history_item_id = ? LIMIT 1`)
    .get(historyItemId) as { task_episode_id: number } | undefined;
  return row ? row.task_episode_id : null;
}

/** Links a history_item as evidence for a task_episode (insert-or-ignore,
 * so re-running segmentEpisodes is idempotent). task_episode_evidence has no
 * `role` column (v2's shape, unchanged here per the v9 migration note), so
 * `role` is recorded only on the emitted event, for audit/debugging -- the
 * evidence link itself is role-agnostic, matching every other evidence
 * table in this schema. */
export function addEpisodeEvidence(
  episodeId: number,
  historyItemId: number,
  role: "request" | "correction" | "other",
): void {
  db.prepare(
    `INSERT OR IGNORE INTO task_episode_evidence (task_episode_id, history_item_id) VALUES (?, ?)`,
  ).run(episodeId, historyItemId);
  insertEvent("task_episode.evidence_added", null, {
    task_episode_id: episodeId,
    history_item_id: historyItemId,
    role,
  });
}
// ---- end Round 4 A1 ----

// ---- Round 4 A2 ----
// Data access for harness/src/analysis/propose.ts (Task A2): selecting
// corrected-but-unmined task episodes for the rule writer LLM call, and the live
// rule instruction texts it dedupes proposed instructions against.

/** One message the rule writer sees, keyed by external_id (Lovable's own message
 * id, shown in the prompt) rather than the internal numeric history_item_id
 * -- external_id is what evidence_message_ids cites back. */
export type MinableMessage = {
  history_item_id: number;
  external_id: string | null;
  text: string;
};

export type MinableCorrection = MinableMessage & { summary: string };

export type MinableEpisode = {
  id: number;
  project_id: string | null;
  project_name: string | null;
  title: string;
  request: MinableMessage;
  corrections: MinableCorrection[];
  // Round 7: the corrections (history_item ids) no suggestion covers yet and
  // the Rule writer has not been asked about -- one proposal is sought per
  // entry. Oldest first. Always non-empty for a returned episode.
  uncovered_correction_ids: number[];
  assistant_summaries: string[];
};

const MINABLE_TEXT_CHAR_LIMIT = 1500;
const MINABLE_ASSISTANT_SUMMARY_CHAR_LIMIT = 800;

function truncateText(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

/**
 * Episodes with >=1 correction-classified message and no correction_candidates
 * row yet -- Task A2's selection query, oldest-first by started_at/id, what
 * proposeRules works through.
 *
 * `request` is the episode's earliest evidence message (the new_task message
 * segmentEpisodes opened it with -- evidence role isn't a stored column, see
 * addEpisodeEvidence's own note above, so "earliest by occurred_at/id" is
 * how this reconstructs it). `corrections` are its evidence messages
 * classified 'correction', oldest first, each carrying the classifier's own
 * summary. `assistant_summaries` are every assistant reply in the same
 * project strictly after the episode started and at/before it ended --
 * assistant replies are never themselves task_episode_evidence rows
 * (classify.ts only classifies role='user' messages), so this is a
 * time-window read, not an evidence join -- rendered via humanVisibleText
 * and truncated to 800 chars so the rule writer sees what Lovable told the user,
 * never raw tool-use markup.
 */

// An episode's "request" is its first user message. Evidence also holds
// spec excerpts, notes and diffs, often with occurred_at NULL, and SQLite
// sorts NULLs first -- so ordering by time alone picked a spec excerpt as the
// request and the paired test could never find it in Lovable. Shared by every
// lookup that reads the request (or everything after it).
const EPISODE_REQUEST_ORDER = `(hi.kind = 'message' AND hi.role = 'user') DESC,
         hi.occurred_at IS NULL, hi.occurred_at ASC, hi.id ASC`;

// A correction (tee.history_item_id) is uncovered when no suggestion cites
// it as evidence and the Rule writer has not already been asked about it.
const UNCOVERED_CORRECTION_CLAUSE = `NOT EXISTS (
           SELECT 1 FROM correction_candidate_evidence cce WHERE cce.history_item_id = tee.history_item_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM correction_mining cm WHERE cm.history_item_id = tee.history_item_id
         )`;

export function listMinableEpisodes(limit: number): MinableEpisode[] {
  const episodeRows = db
    .prepare(
      `SELECT te.id, te.project_id, te.title, te.started_at, te.ended_at
       FROM task_episodes te
       WHERE EXISTS (
         SELECT 1 FROM task_episode_evidence tee
         JOIN message_classifications mc ON mc.history_item_id = tee.history_item_id
         WHERE tee.task_episode_id = te.id AND mc.classification = 'correction'
           AND ${UNCOVERED_CORRECTION_CLAUSE}
       )
       ORDER BY te.started_at ASC, te.id ASC
       LIMIT ?`,
    )
    .all(limit) as {
    id: number;
    project_id: string | null;
    title: string;
    started_at: string | null;
    ended_at: string | null;
  }[];

  const requestStmt = db.prepare(
    `SELECT hi.id as history_item_id, hi.external_id, hi.content
     FROM task_episode_evidence tee
     JOIN history_items hi ON hi.id = tee.history_item_id
     WHERE tee.task_episode_id = ?
     ORDER BY ${EPISODE_REQUEST_ORDER}
     LIMIT 1`,
  );
  const correctionsStmt = db.prepare(
    `SELECT hi.id as history_item_id, hi.external_id, hi.content, mc.summary as summary
     FROM task_episode_evidence tee
     JOIN history_items hi ON hi.id = tee.history_item_id
     JOIN message_classifications mc ON mc.history_item_id = hi.id
     WHERE tee.task_episode_id = ? AND mc.classification = 'correction'
     ORDER BY hi.occurred_at ASC, hi.id ASC`,
  );
  const assistantStmt = db.prepare(
    `SELECT hi.content as content
     FROM history_items hi
     WHERE hi.project_id IS ? AND hi.kind = 'message' AND hi.role = 'assistant'
       AND hi.occurred_at IS NOT NULL
       AND hi.occurred_at > ?
       AND (? IS NULL OR hi.occurred_at <= ?)
     ORDER BY hi.occurred_at ASC, hi.id ASC`,
  );
  const uncoveredStmt = db.prepare(
    `SELECT tee.history_item_id AS id
     FROM task_episode_evidence tee
     JOIN history_items hi ON hi.id = tee.history_item_id
     JOIN message_classifications mc ON mc.history_item_id = tee.history_item_id
     WHERE tee.task_episode_id = ? AND mc.classification = 'correction'
       AND ${UNCOVERED_CORRECTION_CLAUSE}
     ORDER BY hi.occurred_at ASC, hi.id ASC`,
  );

  return episodeRows.map((ep) => {
    const reqRow = requestStmt.get(ep.id) as
      { history_item_id: number; external_id: string | null; content: string } | undefined;
    const correctionRows = correctionsStmt.all(ep.id) as {
      history_item_id: number;
      external_id: string | null;
      content: string;
      summary: string;
    }[];
    const assistantRows = ep.started_at
      ? (assistantStmt.all(ep.project_id, ep.started_at, ep.ended_at, ep.ended_at) as {
          content: string;
        }[])
      : [];
    const projectMeta = ep.project_id ? getProjectMeta(ep.project_id) : null;

    return {
      id: ep.id,
      project_id: ep.project_id,
      project_name: projectMeta?.name ?? null,
      title: ep.title,
      request: reqRow
        ? {
            history_item_id: reqRow.history_item_id,
            external_id: reqRow.external_id,
            text: truncateText(reqRow.content, MINABLE_TEXT_CHAR_LIMIT),
          }
        : { history_item_id: ep.id, external_id: null, text: "" },
      corrections: correctionRows.map((c) => ({
        history_item_id: c.history_item_id,
        external_id: c.external_id,
        text: truncateText(c.content, MINABLE_TEXT_CHAR_LIMIT),
        summary: c.summary,
      })),
      uncovered_correction_ids: (uncoveredStmt.all(ep.id) as { id: number }[]).map((r) => r.id),
      assistant_summaries: assistantRows.map((a) =>
        truncateText(humanVisibleText(a.content), MINABLE_ASSISTANT_SUMMARY_CHAR_LIMIT),
      ),
    };
  });
}

/** Rule instruction texts the rule writer dedupes proposed instructions against:
 * every rule not yet retired/rejected/rolled_back. Fix wave item 3: scoped
 * per target when `target.project_id` is given -- a project-scoped rule
 * only counts when it belongs to that same project (via the same
 * correction_candidate -> task_episode -> project_id chain
 * activeRulesForTarget/retiredRulesForTarget already use), while a
 * workspace-scoped rule always counts (it applies everywhere). Called with
 * no target, this is the pre-fix global behavior (every live rule,
 * regardless of project) -- kept for callers that genuinely want that. */
export function listLiveRuleTexts(target?: {
  project_id: string;
}): { id: number; instruction: string }[] {
  if (!target) {
    return db
      .prepare(
        `SELECT id, instruction FROM rules
         WHERE state NOT IN ('retired', 'rejected', 'rolled_back')
         ORDER BY id ASC`,
      )
      .all() as { id: number; instruction: string }[];
  }
  return db
    .prepare(
      `SELECT r.id, r.instruction FROM rules r
       JOIN correction_candidates cc ON cc.id = r.correction_candidate_id
       JOIN task_episodes te ON te.id = cc.task_episode_id
       WHERE r.state NOT IN ('retired', 'rejected', 'rolled_back')
         AND (r.scope = 'workspace' OR (r.scope = 'project' AND te.project_id = ?))
       ORDER BY r.id ASC`,
    )
    .all(target.project_id) as { id: number; instruction: string }[];
}

/** Union of message_classifications.tags_json across every evidence message
 * linked to an episode (any classification -- matches listEpisodesAfter's
 * tag-union semantics from Task C1), falling back to ["general"] when the
 * episode has no tags at all. What the rule writer sets a newly-created rule's
 * scope_tags_json to, via setRuleScopeTags below. */
export function episodeScopeTags(episodeId: number): string[] {
  const rows = db
    .prepare(
      `SELECT mc.tags_json as tags_json
       FROM task_episode_evidence tee
       JOIN message_classifications mc ON mc.history_item_id = tee.history_item_id
       WHERE tee.task_episode_id = ?`,
    )
    .all(episodeId) as { tags_json: string }[];
  const tagSet = new Set<string>();
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.tags_json);
      if (Array.isArray(parsed)) {
        for (const t of parsed) if (typeof t === "string") tagSet.add(t);
      }
    } catch {
      // malformed tags_json contributes no tags rather than failing the read
    }
  }
  return tagSet.size > 0 ? [...tagSet] : ["general"];
}

/** createRule (Checkpoint B) has no scope_tags_json parameter -- that column
 * was added later by migration v9 with a DEFAULT of '["general"]' -- so the
 * rule writer sets it in a second, explicit step right after creating the rule,
 * rather than this task reaching into createRule's long-shared insert. */
export function setRuleScopeTags(ruleId: number, tags: string[]): void {
  const normalized = tags.length > 0 ? tags : ["general"];
  db.prepare(`UPDATE rules SET scope_tags_json = ?, updated_at = datetime('now') WHERE id = ?`).run(
    JSON.stringify(normalized),
    ruleId,
  );
  insertEvent("rule.scope_tags_set", null, { id: ruleId, tags: normalized });
}
// ---- end Round 4 A2 ----

// ---- Round 4 C2 ----
// Retirement proposals (spec §4b/§5): a human-reviewed Inbox item kind,
// separate from correction_candidates, that proposes retiring an existing
// live rule. Written by harness/src/analysis/retire.ts's proposeRetirements
// from `rule_health` rows in status 'retire_suggested'; acted on by
// harness/src/improvements.ts's retire/keep/readd actions. Pure CRUD over
// retire_proposals (migration v9) plus two small read helpers the
// improvements layer needs to render a proposal or a retired rule.

// "changed_mind" (Round 7): the user asked Lovable for the opposite of this
// live rule; evidence is that message's history_item id.
export type RetireReason = "hurt" | "contradiction" | "unused" | "changed_mind";
export type RetireProposalStatus = "open" | "retired" | "kept";

export type RetireProposalRow = {
  id: number;
  rule_id: number;
  reason: RetireReason;
  // Reason 'hurt': up to 5 history_item ids of the hurt corrections.
  // Reason 'contradiction': a single-element array, the contradicting
  // rule's id. Reason 'unused': empty.
  evidence: number[];
  status: RetireProposalStatus;
  created_at: string;
  decided_at: string | null;
};

type RetireProposalDbRow = {
  id: number;
  rule_id: number;
  reason: string;
  evidence_json: string;
  status: string;
  created_at: string;
  decided_at: string | null;
};

function parseRetireProposal(row: RetireProposalDbRow): RetireProposalRow {
  let evidence: number[] = [];
  try {
    const parsed = JSON.parse(row.evidence_json);
    if (Array.isArray(parsed)) evidence = parsed.filter((n): n is number => typeof n === "number");
  } catch {
    evidence = [];
  }
  return {
    id: row.id,
    rule_id: row.rule_id,
    reason: row.reason as RetireReason,
    evidence,
    status: row.status as RetireProposalStatus,
    created_at: row.created_at,
    decided_at: row.decided_at,
  };
}

export function createRetireProposal(input: {
  rule_id: number;
  reason: RetireReason;
  evidence: number[];
}): RetireProposalRow {
  const row = db
    .prepare(
      `INSERT INTO retire_proposals (rule_id, reason, evidence_json)
       VALUES (@rule_id, @reason, @evidence_json)
       RETURNING *`,
    )
    .get({
      rule_id: input.rule_id,
      reason: input.reason,
      evidence_json: JSON.stringify(input.evidence),
    }) as RetireProposalDbRow;
  insertEvent("retire_proposal.created", null, {
    id: row.id,
    rule_id: input.rule_id,
    reason: input.reason,
  });
  return parseRetireProposal(row);
}

export function listOpenRetireProposals(): RetireProposalRow[] {
  return (
    db
      .prepare(`SELECT * FROM retire_proposals WHERE status = 'open' ORDER BY id`)
      .all() as RetireProposalDbRow[]
  ).map(parseRetireProposal);
}

export function getRetireProposal(id: number): RetireProposalRow | null {
  const row = db.prepare(`SELECT * FROM retire_proposals WHERE id = ?`).get(id) as
    RetireProposalDbRow | undefined;
  return row ? parseRetireProposal(row) : null;
}

// The most recent open proposal for a rule, or null -- used both to keep
// proposeRetirements idempotent (skip a rule that already has one open) and
// to resolve the proposal a manual Instructions-page Retire should decide,
// if one happens to be open.
export function openRetireProposalForRule(ruleId: number): RetireProposalRow | null {
  const row = db
    .prepare(
      `SELECT * FROM retire_proposals WHERE rule_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1`,
    )
    .get(ruleId) as RetireProposalDbRow | undefined;
  return row ? parseRetireProposal(row) : null;
}

export function decideRetireProposal(id: number, status: "retired" | "kept"): RetireProposalRow {
  const existing = getRetireProposal(id);
  if (!existing) throw new Error(`retire_proposal ${id} not found`);
  const row = db
    .prepare(
      `UPDATE retire_proposals SET status = ?, decided_at = datetime('now') WHERE id = ? RETURNING *`,
    )
    .get(status, id) as RetireProposalDbRow;
  insertEvent("retire_proposal.decided", null, { id, status });
  return parseRetireProposal(row);
}

// Retired rules for a target's "Retired rules (N)" list on the Instructions
// page -- same shape and join as activeRulesForTarget above, filtered to
// state = 'retired' instead of the live states.
export function retiredRulesForTarget(target: KnowledgeTarget, targetId: string) {
  if (target === "project") {
    return db
      .prepare(
        `SELECT r.id, r.instruction, r.state, r.scope FROM rules r
         JOIN correction_candidates cc ON cc.id = r.correction_candidate_id
         JOIN task_episodes te ON te.id = cc.task_episode_id
         WHERE r.scope = 'project' AND r.state = 'retired' AND te.project_id = ?
         ORDER BY r.id`,
      )
      .all(targetId) as { id: number; instruction: string; state: string; scope: string }[];
  }
  return db
    .prepare(
      `SELECT r.id, r.instruction, r.state, r.scope FROM rules r
       WHERE r.scope = 'workspace' AND r.state = 'retired'
       ORDER BY r.id`,
    )
    .all() as { id: number; instruction: string; state: string; scope: string }[];
}

// history_items by id, in the given ids' occurred_at/id order -- the retire
// item's evidence (the hurt corrections, as messages) is built from this.
export function listHistoryItemsByIds(ids: number[]): {
  id: number;
  role: string | null;
  content: string;
  occurred_at: string | null;
}[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT id, role, content, occurred_at FROM history_items
       WHERE id IN (${placeholders}) ORDER BY occurred_at, id`,
    )
    .all(...ids) as {
    id: number;
    role: string | null;
    content: string;
    occurred_at: string | null;
  }[];
}
// ---- end Round 4 C2 ----

// ---- Round 4 A3 ----
// Analysis runs and the "Analyse now" trigger (harness/src/analysis/run.ts,
// harness/src/executor/schedule.ts, harness/src/executor/cli.ts). Mirrors
// the sync_runs/sync_requests functions above (Checkpoint E) exactly --
// same coalesced-request shape, same "running" crash-window guard -- but
// against migration v9's analysis_runs/analysis_requests tables, which are
// independent of sync_runs/sync_requests and the Lovable connection.

// Coalesced "Analyse now": returns the existing open request instead of
// stacking a second one, exactly like requestSync.
export function requestAnalysis(): { id: number; created: boolean } {
  const existing = db
    .prepare(`SELECT id FROM analysis_requests WHERE status = 'requested' ORDER BY id ASC LIMIT 1`)
    .get() as { id: number } | undefined;
  if (existing) return { id: existing.id, created: false };
  const row = db.prepare(`INSERT INTO analysis_requests DEFAULT VALUES RETURNING id`).get() as {
    id: number;
  };
  insertEvent("analysis_request.created", null, { id: row.id });
  return { id: row.id, created: true };
}

// The scheduler only needs to know that analysis was asked for; taking the
// request is runAnalysis's job (same split as hasOpenSyncRequest).
export function hasOpenAnalysisRequest(): boolean {
  return (
    db.prepare(`SELECT 1 FROM analysis_requests WHERE status = 'requested' LIMIT 1`).get() !==
    undefined
  );
}

export function takeAnalysisRequest(runId: number): number | null {
  const existing = db
    .prepare(`SELECT id FROM analysis_requests WHERE status = 'requested' ORDER BY id ASC LIMIT 1`)
    .get() as { id: number } | undefined;
  if (!existing) return null;
  db.prepare(`UPDATE analysis_requests SET status = 'running', run_id = ? WHERE id = ?`).run(
    runId,
    existing.id,
  );
  insertEvent("analysis_request.taken", null, { id: existing.id, run_id: runId });
  return existing.id;
}

export function completeAnalysisRequest(id: number): void {
  db.prepare(`UPDATE analysis_requests SET status = 'done' WHERE id = ?`).run(id);
  insertEvent("analysis_request.completed", null, { id });
}

export function startAnalysisRun(kind: "manual" | "scheduled" = "manual"): number {
  const row = db.prepare(`INSERT INTO analysis_runs (kind) VALUES (?) RETURNING id`).get(kind) as {
    id: number;
  };
  insertEvent("analysis_run.started", null, { id: row.id, kind });
  return row.id;
}

export function finishAnalysisRun(
  id: number,
  result: {
    ok: boolean;
    error?: string | null;
    counts?: Record<string, number>;
    tokens: number;
    cost_usd: number | null;
  },
): void {
  db.prepare(
    `UPDATE analysis_runs SET finished_at = datetime('now'), ok = ?, error = ?, counts_json = ?, tokens = ?, cost_usd = ? WHERE id = ?`,
  ).run(
    result.ok ? 1 : 0,
    result.error ?? null,
    JSON.stringify(result.counts ?? {}),
    result.tokens,
    result.cost_usd,
    id,
  );
  insertEvent("analysis_run.finished", null, { id, ok: result.ok, error: result.error ?? null });
}

export type AnalysisRunRow = {
  id: number;
  kind: string;
  started_at: string;
  finished_at: string | null;
  ok: boolean | null;
  error: string | null;
  counts: Record<string, number>;
  tokens: number;
  cost_usd: number | null;
};

function parseAnalysisRunRow(row: {
  id: number;
  kind: string;
  started_at: string;
  finished_at: string | null;
  ok: number | null;
  error: string | null;
  counts_json: string;
  tokens: number;
  cost_usd: number | null;
}): AnalysisRunRow {
  return {
    id: row.id,
    kind: row.kind,
    started_at: row.started_at,
    finished_at: row.finished_at,
    ok: row.ok === null ? null : row.ok === 1,
    error: row.error,
    counts: JSON.parse(row.counts_json) as Record<string, number>,
    tokens: row.tokens,
    cost_usd: row.cost_usd,
  };
}

export function latestAnalysisRun(): AnalysisRunRow | null {
  const row = db.prepare(`SELECT * FROM analysis_runs ORDER BY id DESC LIMIT 1`).get() as
    | {
        id: number;
        kind: string;
        started_at: string;
        finished_at: string | null;
        ok: number | null;
        error: string | null;
        counts_json: string;
        tokens: number;
        cost_usd: number | null;
      }
    | undefined;
  return row ? parseAnalysisRunRow(row) : null;
}

// finished_at IS NULL and started within the last 15 minutes -- a run that
// has been "running" longer than that is treated as stuck/crashed, not
// blocking a fresh one. Same crash window as runningSyncRun.
export function runningAnalysisRun(): { id: number; started_at: string } | null {
  const row = db
    .prepare(
      `SELECT id, started_at FROM analysis_runs
       WHERE finished_at IS NULL AND started_at >= datetime('now', '-15 minutes')
       ORDER BY id DESC LIMIT 1`,
    )
    .get() as { id: number; started_at: string } | undefined;
  return row ?? null;
}

// Real tokens/cost actually spent by one analysis run, read back from the
// llm_calls rows it produced (harness/src/llm/index.ts stamps every call,
// success or failure, with run_id) -- independent of analysis_runs.tokens/
// cost_usd, which is only written once at finishAnalysisRun time from
// exactly these two sums.
export function sumLlmTokensForRun(runId: number): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(tokens_in + tokens_out), 0) as total FROM llm_calls WHERE run_id = ?`,
    )
    .get(runId) as { total: number };
  return row.total;
}

export function sumLlmCostForRun(runId: number): number {
  const row = db
    .prepare(`SELECT COALESCE(SUM(cost_usd), 0) as total FROM llm_calls WHERE run_id = ?`)
    .get(runId) as { total: number };
  return row.total;
}
// ---- end Round 4 A3 ----

// ---- Round 4 C3 ----
// Inbox notifications (spec §4b display / §5 "new since your last visit"):
// a single server-computed count for the sidebar badge and the Inbox page,
// so both read the same number the API returns rather than re-deriving it
// from the full listImprovements()/buildImprovement() pass in
// improvements.ts (store.ts has no dependency on that module, by design).
// inbox_last_seen_at itself needs no dedicated read/write helpers -- it is a
// plain SettingKey (see SETTING_DEFAULTS/setSettings above), read via
// getSetting("inbox_last_seen_at")/getSettings() and written via
// setSettings({ inbox_last_seen_at }).
//
// "pending" mirrors improvements.ts's buildImprovement decision.status
// derivation exactly (excluded/rejected -> skipped; reviewed + one of
// ACCEPTED_RULE_STATES -> accepted; anything else -> pending), including its
// "earliest rule per correction_candidate" convention (getRuleForCorrection
// orders by rule id ASC) -- keep the two in sync if either changes.
// "retire" counts open retire_proposals whose rule is still live, matching
// buildRetireItem's own live-rule filter (state 'active' with at least one
// written Knowledge version -- see listLiveRulesWithTargets above) so the
// count never leads the actual Inbox item list.
export function countInboxItems(): { pending: number; retire: number } {
  const pending = (
    db
      .prepare(
        `SELECT COUNT(*) as n
         FROM correction_candidates cc
         LEFT JOIN rules r
           ON r.id = (
             SELECT id FROM rules WHERE correction_candidate_id = cc.id ORDER BY id ASC LIMIT 1
           )
         WHERE cc.excluded_from_learning = 0
           AND (r.state IS NULL OR r.state != 'rejected')
           AND NOT (
             cc.reviewed = 1
             AND r.state IN ('approved','testing','supported','active','rolled_back','retired')
           )`,
      )
      .get() as { n: number }
  ).n;
  const retire = (
    db
      .prepare(
        `SELECT COUNT(*) as n
         FROM retire_proposals rp
         JOIN rules r ON r.id = rp.rule_id
         WHERE rp.status = 'open'
           AND r.state = 'active'
           AND EXISTS (
             SELECT 1 FROM knowledge_versions kv WHERE kv.rule_id = r.id AND kv.status = 'written'
           )`,
      )
      .get() as { n: number }
  ).n;
  return { pending, retire };
}
// ---- end Round 4 C3 ----

// ---- Round 5 Task 1 ----
// Schema/store foundation for round 5 (spec §1/§4/§4b/§5): a correction
// candidate's skip reason and who decided it, rule-level verdicts, per-
// episode rule adherence, and the read helpers later Round 5 tasks (the
// decision-mode auto-accept path, the judge role, the Instructions page's
// feedback/evidence panels) build on. Migration v11
// (harness/src/migrations.ts) owns every table/column this section reads or
// writes.

export type SkipReason = "not_useful" | "wrong_wording" | "one_time" | "already_covered";

/** Records (or clears, with null) why a correction candidate was skipped --
 * spec §4b's skip reasons, shown back on the Improvement and rolled up by
 * tagAcceptanceRates/listSkippedSuggestions below. Independent of the
 * exclude/include review actions in reviewCorrectionCandidate above: this
 * only sets the reason column, never excluded_from_learning itself. */
export function setCandidateSkipReason(id: number, reason: SkipReason | null): void {
  db.prepare(
    `UPDATE correction_candidates SET skip_reason = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(reason, id);
  insertEvent("correction_candidate.skip_reason_set", null, { id, skip_reason: reason });
}

/** Records who decided a correction candidate: a human ("user") via the
 * normal review flow, or the decision_mode='automatic' path deciding
 * without asking. feedbackStats below counts 'automatic' decisions
 * separately so the Settings page can show how often auto-accept fired. */
export function setCandidateDecidedBy(id: number, by: "user" | "automatic"): void {
  db.prepare(
    `UPDATE correction_candidates SET decided_by = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(by, id);
  insertEvent("correction_candidate.decided_by_set", null, { id, decided_by: by });
}

export type RuleVerdict = "helped" | "did_not_help" | "not_sure";

/** A whole-rule verdict ("did this actually help") -- newest one wins on the
 * Instructions page (latestRuleVerdict below). Distinct from rule_adherence,
 * which is per-episode ("did this task follow the rule"), not a judgment on
 * the rule overall.
 *
 * Round 6 Task 1 (migration v12): upsert, not a plain INSERT. Recording the
 * *same* verdict as the current one is a no-op (`changed: false`, the
 * existing row's id comes back, its note is not rewritten) -- clicking
 * "helped" again is not a new signal. A *different* verdict supersedes the
 * current row (superseded=1, kept forever as history) and inserts a new
 * current row, satisfying the partial unique index
 * idx_rule_verdicts_current (rule_id WHERE superseded = 0). Comparison is by
 * verdict value only, per the brief -- a same-verdict call with a different
 * note still counts as unchanged. */
export function recordRuleVerdict(input: {
  rule_id: number;
  verdict: RuleVerdict;
  note?: string | null;
}): { id: number; changed: boolean } {
  const current = db
    .prepare(`SELECT id, verdict FROM rule_verdicts WHERE rule_id = ? AND superseded = 0`)
    .get(input.rule_id) as { id: number; verdict: RuleVerdict } | undefined;

  if (current && current.verdict === input.verdict) {
    return { id: current.id, changed: false };
  }

  const write = db.transaction(() => {
    if (current) {
      db.prepare(`UPDATE rule_verdicts SET superseded = 1 WHERE id = ?`).run(current.id);
    }
    return db
      .prepare(
        `INSERT INTO rule_verdicts (rule_id, verdict, note) VALUES (@rule_id, @verdict, @note) RETURNING id`,
      )
      .get({ rule_id: input.rule_id, verdict: input.verdict, note: input.note ?? null }) as {
      id: number;
    };
  });
  const row = write();
  insertEvent("rule_verdict.recorded", null, {
    id: row.id,
    rule_id: input.rule_id,
    verdict: input.verdict,
  });
  return { id: row.id, changed: true };
}

export function latestRuleVerdict(
  ruleId: number,
): { id: number; verdict: RuleVerdict; note: string | null; created_at: string } | null {
  const row = db
    .prepare(
      `SELECT id, verdict, note, created_at FROM rule_verdicts WHERE rule_id = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(ruleId) as
    { id: number; verdict: RuleVerdict; note: string | null; created_at: string } | undefined;
  return row ?? null;
}

export function listRuleVerdicts(
  ruleId: number,
): { id: number; verdict: RuleVerdict; note: string | null; created_at: string }[] {
  return db
    .prepare(
      `SELECT id, verdict, note, created_at FROM rule_verdicts WHERE rule_id = ? ORDER BY id DESC`,
    )
    .all(ruleId) as { id: number; verdict: RuleVerdict; note: string | null; created_at: string }[];
}

export type AdherenceVerdict = "followed" | "broke" | "not_applicable";

/** One (rule, task_episode) adherence judgment -- insert-or-ignore on the
 * migration's UNIQUE (rule_id, task_episode_id), so re-judging the same
 * pair (a re-run of the judge role over an already-judged episode) never
 * double-counts adherenceCounts below. Silently a no-op on the ignored
 * duplicate, matching addEpisodeEvidence's own insert-or-ignore
 * convention -- no event is logged for a duplicate that changed nothing. */
export function recordRuleAdherence(input: {
  rule_id: number;
  task_episode_id: number;
  verdict: AdherenceVerdict;
  quote: string | null;
  llm_call_id: number | null;
  run_id: number | null;
}): void {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO rule_adherence (rule_id, task_episode_id, verdict, quote, llm_call_id, run_id)
       VALUES (@rule_id, @task_episode_id, @verdict, @quote, @llm_call_id, @run_id)`,
    )
    .run(input);
  if (result.changes > 0) {
    insertEvent("rule_adherence.recorded", null, {
      rule_id: input.rule_id,
      task_episode_id: input.task_episode_id,
      verdict: input.verdict,
    });
  }
}

export function listRuleAdherence(ruleId: number): {
  task_episode_id: number;
  verdict: AdherenceVerdict;
  quote: string | null;
  created_at: string;
}[] {
  return db
    .prepare(
      `SELECT task_episode_id, verdict, quote, created_at FROM rule_adherence
       WHERE rule_id = ? ORDER BY id DESC`,
    )
    .all(ruleId) as {
    task_episode_id: number;
    verdict: AdherenceVerdict;
    quote: string | null;
    created_at: string;
  }[];
}

export function adherenceCounts(ruleId: number): {
  followed: number;
  broke: number;
  not_applicable: number;
} {
  const rows = db
    .prepare(`SELECT verdict, COUNT(*) as n FROM rule_adherence WHERE rule_id = ? GROUP BY verdict`)
    .all(ruleId) as { verdict: AdherenceVerdict; n: number }[];
  const counts = { followed: 0, broke: 0, not_applicable: 0 };
  for (const row of rows) counts[row.verdict] = row.n;
  return counts;
}

/** Episodes started strictly after sinceIso (same started_at/project_id
 * filter as listEpisodesAfter above) that have no rule_adherence row yet
 * for this rule -- what the judge role works through so it never re-judges
 * an episode it already has a verdict for. */
export function listUnjudgedEpisodesForRule(
  ruleId: number,
  sinceIso: string,
  projectId: string | null,
  limit: number,
): { id: number; project_id: string | null; started_at: string }[] {
  const notYetJudged = `NOT EXISTS (
    SELECT 1 FROM rule_adherence ra WHERE ra.rule_id = ? AND ra.task_episode_id = task_episodes.id
  )`;
  return (
    projectId == null
      ? db
          .prepare(
            `SELECT id, project_id, started_at FROM task_episodes
             WHERE started_at IS NOT NULL AND julianday(started_at) > julianday(?) AND ${notYetJudged}
             ORDER BY started_at ASC
             LIMIT ?`,
          )
          .all(sinceIso, ruleId, limit)
      : db
          .prepare(
            `SELECT id, project_id, started_at FROM task_episodes
             WHERE started_at IS NOT NULL AND julianday(started_at) > julianday(?) AND project_id = ? AND ${notYetJudged}
             ORDER BY started_at ASC
             LIMIT ?`,
          )
          .all(sinceIso, projectId, ruleId, limit)
  ) as { id: number; project_id: string | null; started_at: string }[];
}

export type EvidenceSources = {
  observed: boolean;
  adherence: boolean;
  verdicts: boolean;
  paired: boolean;
};

const EVIDENCE_SOURCES_DEFAULT: EvidenceSources = {
  observed: true,
  adherence: true,
  verdicts: true,
  paired: false,
};

/** The parsed evidence_sources setting -- falls back to the same default
 * SETTING_DEFAULTS.evidence_sources encodes whenever the stored value fails
 * to parse or is missing one of the four keys (defense in depth: setSettings
 * already validates this shape via assertEvidenceSources above). */
export function getEvidenceSources(): EvidenceSources {
  try {
    const parsed = JSON.parse(getSetting("evidence_sources")) as Record<string, unknown>;
    if (
      typeof parsed.observed === "boolean" &&
      typeof parsed.adherence === "boolean" &&
      typeof parsed.verdicts === "boolean" &&
      typeof parsed.paired === "boolean"
    ) {
      return {
        observed: parsed.observed,
        adherence: parsed.adherence,
        verdicts: parsed.verdicts,
        paired: parsed.paired,
      };
    }
  } catch {
    // fall through to the default below
  }
  return { ...EVIDENCE_SOURCES_DEFAULT };
}

export type FeedbackStats = {
  accepted: number;
  skipped: number;
  verdicts: number;
  automatic: number;
};

/** A workspace-wide feedback summary for the Settings/Instructions pages:
 * accepted/skipped correction candidates, total rule verdicts ever
 * recorded, and how many candidates decision_mode='automatic' decided
 * without asking. */
export function feedbackStats(): FeedbackStats {
  const accepted = (
    db
      .prepare(
        `SELECT COUNT(*) as n FROM correction_candidates
         WHERE reviewed = 1 AND reusable = 1 AND excluded_from_learning = 0`,
      )
      .get() as { n: number }
  ).n;
  const skipped = (
    db
      .prepare(`SELECT COUNT(*) as n FROM correction_candidates WHERE excluded_from_learning = 1`)
      .get() as { n: number }
  ).n;
  const verdicts = (db.prepare(`SELECT COUNT(*) as n FROM rule_verdicts`).get() as { n: number }).n;
  const automatic = (
    db
      .prepare(`SELECT COUNT(*) as n FROM correction_candidates WHERE decided_by = 'automatic'`)
      .get() as { n: number }
  ).n;
  return { accepted, skipped, verdicts, automatic };
}

/** Live, accepted rule instructions (state active/approved), newest first --
 * a compact "what's already in force" list for a prompt (e.g. the judge
 * role's context), not the full listLiveRuleTexts audience-filtered set. */
export function listAcceptedRuleTexts(
  limit: number,
): { instruction: string; scope: "project" | "workspace" }[] {
  return db
    .prepare(
      `SELECT instruction, scope FROM rules WHERE state IN ('active','approved') ORDER BY id DESC LIMIT ?`,
    )
    .all(limit) as { instruction: string; scope: "project" | "workspace" }[];
}

/** Skipped suggestions (excluded_from_learning = 1), newest first, each
 * carrying its own rule's instruction when one was created before the
 * candidate was excluded (the earliest rule per candidate, matching
 * getRuleForCorrection's own "order by rule id ASC" convention) -- null when
 * no rule was ever created for it. */
export function listSkippedSuggestions(
  limit: number,
): { instruction: string | null; summary: string; skip_reason: SkipReason | null }[] {
  return db
    .prepare(
      `SELECT cc.summary as summary, cc.skip_reason as skip_reason,
              (SELECT r.instruction FROM rules r
               WHERE r.correction_candidate_id = cc.id ORDER BY r.id ASC LIMIT 1) as instruction
       FROM correction_candidates cc
       WHERE cc.excluded_from_learning = 1
       ORDER BY cc.id DESC
       LIMIT ?`,
    )
    .all(limit) as {
    instruction: string | null;
    summary: string;
    skip_reason: SkipReason | null;
  }[];
}

/** Instruction wording changes only (rule_revisions rows where the
 * instruction actually changed, not a bare state change), newest first --
 * the same source improvements.ts's buildImprovement reads for a single
 * rule's wording_history, but across every rule. */
export function listWordingEdits(limit: number): { from: string; to: string }[] {
  const rows = db
    .prepare(
      `SELECT previous_instruction, new_instruction FROM rule_revisions
       WHERE previous_instruction != new_instruction
       ORDER BY id DESC
       LIMIT ?`,
    )
    .all(limit) as { previous_instruction: string; new_instruction: string }[];
  return rows.map((r) => ({ from: r.previous_instruction, to: r.new_instruction }));
}

/** Acceptance/skip counts per scope tag, decided candidates only (reviewed =
 * 1): a candidate's tags are episodeScopeTags(candidate.task_episode_id)
 * (the union of its episode's evidence messages' classification tags,
 * falling back to ["general"] -- the same tag source setRuleScopeTags
 * seeds a mined rule's scope_tags_json from). A candidate that is neither
 * accepted (reusable = 1, not excluded) nor skipped (excluded_from_learning
 * = 1) -- e.g. reviewed but marked one-time -- contributes to neither
 * bucket. */
export function tagAcceptanceRates(): Record<string, { accepted: number; skipped: number }> {
  const rows = db
    .prepare(
      `SELECT task_episode_id, reusable, excluded_from_learning
       FROM correction_candidates WHERE reviewed = 1`,
    )
    .all() as {
    task_episode_id: number;
    reusable: number | null;
    excluded_from_learning: number;
  }[];

  const out: Record<string, { accepted: number; skipped: number }> = {};
  for (const c of rows) {
    const accepted = c.reusable === 1 && c.excluded_from_learning === 0;
    const skipped = c.excluded_from_learning === 1;
    if (!accepted && !skipped) continue;
    for (const tag of episodeScopeTags(c.task_episode_id)) {
      if (!out[tag]) out[tag] = { accepted: 0, skipped: 0 };
      if (accepted) out[tag].accepted++;
      if (skipped) out[tag].skipped++;
    }
  }
  return out;
}
// ---- end Round 5 Task 1 ----

// ---- Round 5 Task 3 ----
// Two small additional read helpers the History timeline (buildTimeline in
// improvements.ts) needs, beyond what's already exposed above: every
// knowledge_snapshots row for a target (not just the latest), and every
// retire_proposals row for a rule regardless of status (not just an open
// one -- openRetireProposalForRule/listOpenRetireProposals above only ever
// surface open proposals).

/** Every snapshot ever recorded for a target, oldest first. Unlike
 * skill_snapshots, knowledge_snapshots rows are NOT deduped at insert time
 * (recordKnowledgeSnapshot always inserts), so a routine re-fetch that found
 * no change still appends an identical row here -- the History timeline
 * compares consecutive rows' sha256 itself to detect a genuine change made
 * directly in Lovable, outside Harness. */
export function listKnowledgeSnapshots(
  target: KnowledgeTarget,
  targetId: string,
): { id: number; content: string; sha256: string; fetched_at: string; fetched_by: string }[] {
  return db
    .prepare(
      `SELECT id, content, sha256, fetched_at, fetched_by FROM knowledge_snapshots
       WHERE target = ? AND ${targetColumn(target)} = ? ORDER BY id ASC`,
    )
    .all(target, targetId) as {
    id: number;
    content: string;
    sha256: string;
    fetched_at: string;
    fetched_by: string;
  }[];
}

/** Every retire_proposals row for a rule, any status, oldest first -- the
 * History timeline shows both a proposal's creation ("Harness suggested
 * retiring") and, once decided, its outcome ("You retired"/"You kept it"). */
export function listRetireProposalsForRule(ruleId: number): RetireProposalRow[] {
  return (
    db
      .prepare(`SELECT * FROM retire_proposals WHERE rule_id = ? ORDER BY id ASC`)
      .all(ruleId) as RetireProposalDbRow[]
  ).map(parseRetireProposal);
}

/** Fix round 1: every "rule.readded" event for exactly this rule, oldest
 * first -- listEventsForRecord's `payload LIKE '%"id":<id>%'` is only an
 * approximation (good enough for an audit panel), and a substring match
 * false-positives across rules once ids overlap as substrings (rule 3 also
 * matches payloads {"id":30}, {"id":300}, {"id":31}, ...). The History
 * timeline needs an exact match, so this reads the same column with
 * json_extract instead of scanning payload text. */
export function listReaddEventsForRule(ruleId: number): { id: number; created_at: string }[] {
  return db
    .prepare(
      `SELECT id, created_at FROM events
       WHERE kind = 'rule.readded' AND json_extract(payload, '$.id') = ?
       ORDER BY id ASC`,
    )
    .all(ruleId) as { id: number; created_at: string }[];
}
// ---- end Round 5 Task 3 ----

// ---- Round 5 Task 6 ----
// spec §4: the Inbox's own automatic-mode empty state ("Harness accepted N
// suggestions automatically since your last visit") -- a single read helper
// the improvements route composes with the inbox_last_seen_at setting it
// already reads for last_seen_at.

/** How many candidates decision_mode='automatic' accepted without asking
 * (correction_candidates.decided_by = 'automatic', set by
 * harness/src/analysis/auto-accept.ts) since sinceIso, exclusive. Compared
 * against reviewed_at (set the moment the accept itself ran -- see
 * store.recordHumanCorrectionDecision, called by improvementAction's
 * "accept" case for both the human and the automatic path), not
 * created_at, so a candidate the analysis proposed earlier but only
 * auto-accepted later still counts against the right visit.
 *
 * inbox_last_seen_at is written as a JS `Date#toISOString()` value
 * ("...T...Z"); reviewed_at is written by SQLite's own datetime('now')
 * ("... ..." -- a space, no zone marker). Comparing those two string shapes
 * directly would sort wrong (' ' < 'T' in every case, regardless of the
 * actual instants), so `sinceIso` is normalised through SQLite's own
 * datetime() first -- the same "YYYY-MM-DD HH:MM:SS" shape reviewed_at
 * already has -- before the string comparison. Callers pass a non-empty,
 * already-validated ISO date (see setSettings' assertIsoDateOrEmpty for
 * inbox_last_seen_at); "" (never visited) is the caller's job to treat as
 * "0 automatic accepts", not this function's -- datetime('') is not a valid
 * instant.
 */
export function countAutoAcceptedSince(sinceIso: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) as n FROM correction_candidates
         WHERE decided_by = 'automatic' AND reviewed_at IS NOT NULL AND reviewed_at > datetime(?)`,
      )
      .get(sinceIso) as { n: number }
  ).n;
}
// ---- end Round 5 Task 6 ----

// ---- Round 5 Task 7 ----
// spec §5 item 3: the adherence Judge needs one episode's request text and
// Lovable's human-visible reply, for an arbitrary episode (not just the
// corrected/uncandidated ones listMinableEpisodes selects -- the Judge works
// through every applicable-since-written episode, corrected or not). Mirrors
// listMinableEpisodes' own request/reply reads above (same "earliest
// evidence message" and "assistant replies in the episode's own time
// window" queries), just for one episode id instead of a batch, and without
// listMinableEpisodes' "has a correction, no candidate yet" selection filter.

const JUDGE_TEXT_CHAR_LIMIT = 1500;

/** One episode's request text and Lovable's human-visible reply, each
 * clamped to 1500 characters -- what harness/src/analysis/adherence.ts's
 * judgeAdherence shows the judge role alongside the rule text. Empty strings
 * for an episode with no evidence message (defensive; every real episode
 * has at least the request that opened it). */
export function episodeTextForJudge(episodeId: number): { request: string; reply: string } {
  const episode = db
    .prepare(`SELECT id, project_id, started_at, ended_at FROM task_episodes WHERE id = ?`)
    .get(episodeId) as
    | { id: number; project_id: string | null; started_at: string | null; ended_at: string | null }
    | undefined;
  if (!episode) return { request: "", reply: "" };

  const reqRow = db
    .prepare(
      `SELECT hi.id, hi.content FROM task_episode_evidence tee
       JOIN history_items hi ON hi.id = tee.history_item_id
       WHERE tee.task_episode_id = ?
       ORDER BY ${EPISODE_REQUEST_ORDER}
       LIMIT 1`,
    )
    .get(episodeId) as { id: number; content: string } | undefined;

  // Lovable's reply to the request ends where the user's first follow-up
  // (a correction) begins -- replies after that answer the correction, not
  // the request, and must not be shown as "your original build".
  const firstFollowUp = reqRow
    ? (db
        .prepare(
          `SELECT MIN(hi.occurred_at) AS at FROM task_episode_evidence tee
           JOIN history_items hi ON hi.id = tee.history_item_id
           WHERE tee.task_episode_id = ? AND hi.id != ? AND hi.role IN ('user', 'operator')
             AND hi.occurred_at IS NOT NULL AND hi.occurred_at > ?`,
        )
        .get(episodeId, reqRow.id, episode.started_at ?? "") as { at: string | null })
    : { at: null };
  const replyEnd = firstFollowUp.at;

  const assistantRows = episode.started_at
    ? (db
        .prepare(
          `SELECT hi.content FROM history_items hi
           WHERE hi.project_id IS ? AND hi.kind = 'message' AND hi.role = 'assistant'
             AND hi.occurred_at IS NOT NULL
             AND hi.occurred_at > ?
             AND (? IS NULL OR hi.occurred_at <= ?)
             AND (? IS NULL OR hi.occurred_at < ?)
           ORDER BY hi.occurred_at ASC, hi.id ASC`,
        )
        .all(
          episode.project_id,
          episode.started_at,
          episode.ended_at,
          episode.ended_at,
          replyEnd,
          replyEnd,
        ) as {
        content: string;
      }[])
    : [];
  const reply = assistantRows.map((a) => humanVisibleText(a.content)).join("\n\n");

  return {
    request: truncateText(reqRow?.content ?? "", JUDGE_TEXT_CHAR_LIMIT),
    reply: truncateText(reply, JUDGE_TEXT_CHAR_LIMIT),
  };
}
// ---- end Round 5 Task 7 ----

// ---- Round 6 Task 1 ----
// Schema v12 (migrations.ts): experiment_runs + credit_ledger. The
// bookkeeping the paired-test runner (a later Round 6 task) reads and
// writes as it copies a project, replays a rule against the copy, and
// leaves the run for a human to judge -- nothing here calls Lovable itself.

export type ExperimentStatus =
  "queued" | "copying" | "building" | "judging" | "judged" | "failed" | "cancelled";

export type ExperimentRunRow = {
  id: number;
  rule_id: number;
  correction_candidate_id: number;
  task_episode_id: number;
  source_project_id: string;
  copy_project_id: string | null;
  request_message_external_id: string;
  status: ExperimentStatus;
  stage_note: string | null;
  copy_message_id: string | null;
  copy_thread_id: string | null;
  copy_commit_sha: string | null;
  copy_summary: string | null;
  copy_reply: string | null;
  copy_diff_json: string | null;
  original_commit_sha: string | null;
  original_diff_json: string | null;
  cost_credits: number | null;
  copy_deleted: number;
  copy_cleanup_note: string | null;
  edits_since_episode: number | null;
  score: number | null;
  verdicts_json: string | null;
  error: string | null;
  started_at: string;
  heartbeat_at: string | null;
  finished_at: string | null;
  judged_at: string | null;
  // Migration v13 (Round 6c part B): the Tests page's / judging screen's own
  // feedback box -- see setExperimentFeedback in this file's own Round 6c
  // block below.
  feedback: string | null;
  feedback_at: string | null;
  // Migration v14 (Round 7): both builds as real Lovable projects.
  show_original: number;
  original_copy_project_id: string | null;
  original_copy_deleted: number;
  original_copy_error: string | null;
  original_summary: string | null;
  copy_screenshot_url: string | null;
  original_screenshot_url: string | null;
  judged_corrections_json: string | null;
};

/** Opens a new attempt at rule_id's paired test, queued and unstarted --
 * copying/building/judging are driven by later updateExperimentRun calls.
 * source_project_id/request_message_external_id are fixed at creation (the
 * "what are we remixing, and from where" never changes mid-run); everything
 * else about the run is a patch away. */
export function createExperimentRun(input: {
  rule_id: number;
  correction_candidate_id: number;
  task_episode_id: number;
  source_project_id: string;
  request_message_external_id: string;
  show_original?: boolean;
}): { id: number } {
  const row = db
    .prepare(
      `INSERT INTO experiment_runs
         (rule_id, correction_candidate_id, task_episode_id, source_project_id, request_message_external_id, show_original)
       VALUES (@rule_id, @correction_candidate_id, @task_episode_id, @source_project_id, @request_message_external_id, @show_original)
       RETURNING id`,
    )
    .get({ ...input, show_original: input.show_original ? 1 : 0 }) as { id: number };
  insertEvent("experiment_run.created", null, {
    id: row.id,
    rule_id: input.rule_id,
    source_project_id: input.source_project_id,
  });
  return { id: row.id };
}

const EXPERIMENT_RUN_COLUMNS = new Set<string>([
  "rule_id",
  "correction_candidate_id",
  "task_episode_id",
  "source_project_id",
  "copy_project_id",
  "request_message_external_id",
  "status",
  "stage_note",
  "copy_message_id",
  "copy_thread_id",
  "copy_commit_sha",
  "copy_summary",
  "copy_reply",
  "copy_diff_json",
  "original_commit_sha",
  "original_diff_json",
  "cost_credits",
  "copy_deleted",
  "copy_cleanup_note",
  "edits_since_episode",
  "show_original",
  "original_copy_project_id",
  "original_copy_deleted",
  "original_copy_error",
  "original_summary",
  "copy_screenshot_url",
  "original_screenshot_url",
  "judged_corrections_json",
  "score",
  "verdicts_json",
  "error",
  "started_at",
  "heartbeat_at",
  "finished_at",
  "judged_at",
]);

/** Patches any column except id, and always bumps heartbeat_at to now --
 * every call is itself proof of life for the run, whether or not the patch
 * touches heartbeat_at explicitly (a caller-supplied heartbeat_at in patch
 * is overwritten by this same "now", not silently ignored: there is exactly
 * one writer of heartbeat_at, this function, on every call). */
export function updateExperimentRun(id: number, patch: Partial<ExperimentRunRow>): void {
  const entries = Object.entries(patch).filter(
    ([k, v]) =>
      k !== "id" && k !== "heartbeat_at" && v !== undefined && EXPERIMENT_RUN_COLUMNS.has(k),
  );
  const setClauses = entries
    .map(([k]) => `${k} = @${k}`)
    .concat("heartbeat_at = datetime('now')")
    .join(", ");
  const params: Record<string, unknown> = { id };
  for (const [k, v] of entries) params[k] = v;
  db.prepare(`UPDATE experiment_runs SET ${setClauses} WHERE id = @id`).run(params);
}

export function getExperimentRun(id: number): ExperimentRunRow | null {
  return (
    (db.prepare(`SELECT * FROM experiment_runs WHERE id = ?`).get(id) as
      ExperimentRunRow | undefined) ?? null
  );
}

export function listExperimentRuns(filter?: {
  rule_id?: number;
  status?: ExperimentStatus[];
}): ExperimentRunRow[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter?.rule_id !== undefined) {
    clauses.push("rule_id = ?");
    params.push(filter.rule_id);
  }
  if (filter?.status?.length) {
    clauses.push(`status IN (${filter.status.map(() => "?").join(", ")})`);
    params.push(...filter.status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return db
    .prepare(`SELECT * FROM experiment_runs ${where} ORDER BY id DESC`)
    .all(...params) as ExperimentRunRow[];
}

/** The one run (if any) still actively being driven: status copying or
 * building, with a heartbeat inside the crash window. A run whose heartbeat
 * has gone quiet for longer than that is presumed crashed -- not "running"
 * even though its status column was never updated to say so -- so the
 * executor's own resume logic (a later task) knows to mark it failed and
 * start clean rather than wait forever. */
export function runningExperimentRun(crashWindowMinutes = 20): ExperimentRunRow | null {
  const candidates = db
    .prepare(
      `SELECT * FROM experiment_runs WHERE status IN ('copying','building') AND heartbeat_at IS NOT NULL
       ORDER BY id DESC`,
    )
    .all() as ExperimentRunRow[];
  const cutoffMs = Date.now() - crashWindowMinutes * 60_000;
  for (const run of candidates) {
    // SQLite's datetime('now') is UTC without a zone marker.
    const heartbeatMs = new Date(run.heartbeat_at!.replace(" ", "T") + "Z").getTime();
    if (!Number.isNaN(heartbeatMs) && heartbeatMs >= cutoffMs) return run;
  }
  return null;
}

// ---- Round 6 fix wave item 3 (queue crash recovery) ----
/** The inverse of runningExperimentRun's freshness filter: a copying/
 * building row whose heartbeat has gone quiet (missing, or older than the
 * crash window) -- a run that was still in flight when the process died and
 * was never picked back up, because runningExperimentRun (by design) treats
 * it as "not running" rather than "running". kickExperimentRunner uses this
 * to close that row out (status: failed) before it looks for the next queued
 * run to drive, so a crashed run doesn't sit on the card/judging screen
 * forever reading "Testing… copying the project". Newest first, same as
 * runningExperimentRun; returns at most one row per call (kickExperimentRunner
 * loops if more than one is ever found, which in practice is at most one --
 * only one run is ever driven at a time). */
export function staleExperimentRun(crashWindowMinutes = 20): ExperimentRunRow | null {
  const candidates = db
    .prepare(
      `SELECT * FROM experiment_runs WHERE status IN ('copying','building') ORDER BY id DESC`,
    )
    .all() as ExperimentRunRow[];
  const cutoffMs = Date.now() - crashWindowMinutes * 60_000;
  for (const run of candidates) {
    if (!run.heartbeat_at) return run;
    const heartbeatMs = new Date(run.heartbeat_at.replace(" ", "T") + "Z").getTime();
    if (Number.isNaN(heartbeatMs) || heartbeatMs < cutoffMs) return run;
  }
  return null;
}
// ---- end Round 6 fix wave item 3 ----

/** Every credited call an experiment makes gets its own credit_ledger row
 * (migration v12's own comment explains why: per-call attribution, not a
 * running total on experiment_runs). cost is in Lovable credits. */
export function recordCredits(runId: number, cost: number): void {
  db.prepare(`INSERT INTO credit_ledger (run_id, cost_credits) VALUES (?, ?)`).run(runId, cost);
  insertEvent("credit_ledger.recorded", null, { run_id: runId, cost_credits: cost });
}

/** Total credits spent since the first of the current calendar month --
 * what the runner (a later task) checks against the
 * lovable_monthly_credit_budget setting before starting a new run. */
export function creditsThisMonth(): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(cost_credits), 0) as total FROM credit_ledger
       WHERE created_at >= strftime('%Y-%m-01 00:00:00', 'now')`,
    )
    .get() as { total: number };
  // Rounded to cents: 0.6 + 0.3 + 2.3 summed as floats read
  // "3.6999999999999997 credits" on the Tests page.
  return Math.round(row.total * 100) / 100;
}

/** The most recently recorded credit_ledger cost, else null -- a rough
 * "what did the last test cost" estimate the Settings page can show
 * alongside the monthly budget, without averaging across runs of very
 * different sizes. */
export function lastKnownTestCost(): number | null {
  const row = db
    .prepare(`SELECT cost_credits FROM credit_ledger ORDER BY id DESC LIMIT 1`)
    .get() as { cost_credits: number } | undefined;
  return row?.cost_credits ?? null;
}

/** Copy projects (real, credit-bearing Lovable projects) that still exist
 * and have not been swept yet -- the executor's own reminder to clean them
 * up, independent of the keep_test_copies setting (which only decides
 * whether cleanup happens automatically; a kept copy still shows up here
 * until someone -- or a future sweep -- deletes it). */
export function listUndeletedCopies(): {
  run_id: number;
  copy_project_id: string;
  copy_cleanup_note: string | null;
}[] {
  return db
    .prepare(
      `SELECT id as run_id, copy_project_id, copy_cleanup_note FROM experiment_runs
       WHERE copy_project_id IS NOT NULL AND copy_deleted = 0
       ORDER BY id ASC`,
    )
    .all() as { run_id: number; copy_project_id: string; copy_cleanup_note: string | null }[];
}

/** The external_id of the episode's earliest evidence message -- the same
 * "earliest by occurred_at/id" reconstruction listMinableEpisodes and
 * episodeTextForJudge above use for "the message that opened this episode"
 * (task_episode_evidence carries no role column of its own; see
 * addEpisodeEvidence's note). This is what remixInit's message_id argument
 * (lovable-rest.ts) is resolved from: the paired test replays the rule
 * starting at the exact message the user actually sent. null when the
 * episode has no evidence at all. */
export function episodeRequestExternalId(episodeId: number): string | null {
  const row = db
    .prepare(
      `SELECT hi.external_id FROM task_episode_evidence tee
       JOIN history_items hi ON hi.id = tee.history_item_id
       WHERE tee.task_episode_id = ?
       ORDER BY ${EPISODE_REQUEST_ORDER}
       LIMIT 1`,
    )
    .get(episodeId) as { external_id: string | null } | undefined;
  return row?.external_id ?? null;
}

// ---- Round 6 fix wave item A ----
/** The occurred_at of the episode's earliest evidence message (the same row
 * episodeRequestExternalId/episodeRequestText resolve) -- what the paired-
 * test runner's REST-message-id resolver (experiments.ts#resolveRequestMessageId)
 * uses for its own "within 90 seconds" fallback match, alongside content.
 * null when the episode has no evidence at all. */
export function episodeRequestOccurredAt(episodeId: number): string | null {
  const row = db
    .prepare(
      `SELECT hi.occurred_at FROM task_episode_evidence tee
       JOIN history_items hi ON hi.id = tee.history_item_id
       WHERE tee.task_episode_id = ?
       ORDER BY ${EPISODE_REQUEST_ORDER}
       LIMIT 1`,
    )
    .get(episodeId) as { occurred_at: string | null } | undefined;
  return row?.occurred_at ?? null;
}
// ---- end Round 6 fix wave item A ----

/** Pure helper for "N edits since" -- how many of editsIsoDates are strictly
 * after iso. No DB access: the runner passes it Lovable REST edit
 * timestamps (listEdits) so this stays trivially testable without a fake
 * server. */
export function countEditsSince(iso: string, editsIsoDates: string[]): number {
  const cutoff = new Date(iso).getTime();
  return editsIsoDates.filter((d) => new Date(d).getTime() > cutoff).length;
}
// ---- end Round 6 Task 1 ----

// ---- Round 6 Task 2 ----
// Support for executeVersionNow (executor/beats.ts): writing a pending
// version immediately, from the request that staged it, rather than waiting
// for the next sync pass.

// A pending version was composed against `previous_content`; when the live
// Knowledge has drifted only outside the Harness-managed block,
// executeVersionNow recomposes the same rule set on the fresh base and
// needs to write THAT text, not the one recorded when the version was
// staged. recordKnowledgeReadback verifies a write against new_sha256, so
// the stored new_content/new_sha256 must be updated first, or a genuinely
// successful write would read back as a hash mismatch.
export function updatePendingKnowledgeVersionContent(versionId: number, newContent: string) {
  requirePendingVersion(versionId);
  db.prepare(`UPDATE knowledge_versions SET new_content = ?, new_sha256 = ? WHERE id = ?`).run(
    newContent,
    knowledgeSha256(newContent),
    versionId,
  );
  return getKnowledgeVersion(versionId);
}

// "Try again" (the improvement card's action for a stale/failed write):
// reopens a terminal stale/failed version back to pending so
// executeVersionNow can attempt it fresh -- a full re-read, and a recompose
// if the base has moved on again. A no-op on an already-pending version (so
// a caller never has to check status first); refuses on any other status,
// since only stale/failed are meant to be retried this way (a written
// version is done, a cancelled one was deliberately superseded).
export function reopenKnowledgeVersionForRetry(versionId: number): KnowledgeVersionRow {
  const v = getKnowledgeVersion(versionId);
  if (!v) throw new Error(`knowledge_version ${versionId} not found`);
  if (v.status === "pending") return v;
  if (v.status !== "stale" && v.status !== "failed") {
    throw new Error(
      `knowledge_version ${versionId} is ${v.status}; only a stale or failed version can be retried`,
    );
  }
  db.prepare(`UPDATE knowledge_versions SET status = 'pending', error = NULL WHERE id = ?`).run(
    versionId,
  );
  insertEvent("knowledge_version.pending", null, { id: versionId, retried: true });
  return getKnowledgeVersion(versionId)!;
}

/**
 * Fix round 1 item 3: `runningSyncRun()` (a plain SELECT) followed by
 * `startSyncRun()` (a plain INSERT) as two separate calls left an
 * await-gap race -- `syncNow()` (a request-driven inline sync) and the
 * in-app scheduler's own tick both check "is one already running?" with a
 * network `await` in between the check and the actual insert, so two
 * concurrent callers can both see "no" and both start a `runAll` pass.
 * This runs the same check-and-insert as a single `db.transaction`, so
 * nothing else can observe the database between the SELECT and the
 * INSERT -- better-sqlite3 transactions serialize even across the two
 * separate Node processes (app + `npm run harness:executor`) that can
 * share this same SQLite file, not just within one process. Returns the
 * new run's id, or `null` when a run is already in flight (finished_at IS
 * NULL, started within the 15-minute crash window) -- a caller receiving
 * `null` must treat it as "someone else already has this," not retry in a
 * loop. `startSyncRun` is kept as-is for any caller that must start
 * unconditionally (there is none today; removing it would be an unrelated
 * refactor of every existing call site).
 */
export function tryStartSyncRun(kind: "scheduled" | "manual" | "once"): number | null {
  const attempt = db.transaction((k: "scheduled" | "manual" | "once") => {
    const running = db
      .prepare(
        `SELECT id FROM sync_runs
         WHERE finished_at IS NULL AND started_at >= datetime('now', '-15 minutes')
         ORDER BY id DESC LIMIT 1`,
      )
      .get() as { id: number } | undefined;
    if (running) return null;
    const row = db.prepare(`INSERT INTO sync_runs (kind) VALUES (?) RETURNING id`).get(k) as {
      id: number;
    };
    return row.id;
  });
  const id = attempt(kind);
  if (id != null) insertEvent("sync_run.started", null, { id, kind });
  return id;
}
// ---- end Round 6 Task 2 ----

// ---- Round 6 Task 5 ----
// executeWrites/executeVersionNow (executor/beats.ts) must never write a
// version that touches a demo rule -- spec §5. A plain accept/readd write
// names the demo rule as its own rule_id; the retire recompose (rule_id:
// null, per improvements.ts's retireRule doc comment) instead names it
// somewhere in rule_ids_json, so both beats check this per id, not just
// row.rule_id.
export function isDemoRuleId(ruleId: number): boolean {
  const row = db.prepare(`SELECT created_by FROM rules WHERE id = ?`).get(ruleId) as
    { created_by: string } | undefined;
  return row?.created_by === "demo";
}
// ---- end Round 6 Task 5 ----

// ---- Round 6 Task 6a ----
// Fix round 1: the paired-test runner (experiments.ts) needs the episode's
// full, untruncated request text (episodeTextForJudge's own 1500-char cap
// is for the judge role's on-screen text, not for what actually gets
// replayed into the copy) and a queued-run guard broader than
// runningExperimentRun (Task 1) checks -- a run that's merely `queued`
// (startExperiment already created the row, but runExperiment hasn't been
// kicked off for it yet) is invisible to that function, since it only looks
// at copying/building.

/** The full text of the episode's earliest evidence message (the request
 * that opened it) -- unlike episodeTextForJudge's `request` (capped at 1500
 * chars for the judge screen), this is what the paired-test runner sends
 * back to Lovable verbatim, so a long original request replays in full
 * rather than truncated. Mirrors episodeTextForJudge's own "earliest by
 * occurred_at/id" reconstruction (task_episode_evidence carries no role
 * column of its own). null when the episode has no evidence at all. */
export function episodeRequestText(episodeId: number): string | null {
  const row = db
    .prepare(
      `SELECT hi.content FROM task_episode_evidence tee
       JOIN history_items hi ON hi.id = tee.history_item_id
       WHERE tee.task_episode_id = ?
       ORDER BY ${EPISODE_REQUEST_ORDER}
       LIMIT 1`,
    )
    .get(episodeId) as { content: string } | undefined;
  return row?.content ?? null;
}

/** Whether a paired test is active enough that a second startExperiment
 * should be refused: either mid-flight (copying/building with a live
 * heartbeat -- delegates to runningExperimentRun, Task 1, unchanged) or
 * merely queued but recent enough that runExperiment almost certainly
 * hasn't been kicked off for it yet. Closes the gap runningExperimentRun
 * alone leaves open (a `queued` row is invisible to it, since it only
 * checks copying/building). windowMinutes is the same crash-window
 * convention runningExperimentRun already uses. */
export function activeExperimentRun(windowMinutes: number): ExperimentRunRow | null {
  const running = runningExperimentRun(windowMinutes);
  if (running) return running;
  const cutoffMs = Date.now() - windowMinutes * 60_000;
  const queued = db
    .prepare(`SELECT * FROM experiment_runs WHERE status = 'queued' ORDER BY id DESC`)
    .all() as ExperimentRunRow[];
  for (const run of queued) {
    // SQLite's datetime('now') default is UTC without a zone marker, same
    // parsing convention runningExperimentRun uses for heartbeat_at.
    const startedMs = new Date(run.started_at.replace(" ", "T") + "Z").getTime();
    if (!Number.isNaN(startedMs) && startedMs >= cutoffMs) return run;
  }
  return null;
}
// ---- end Round 6 Task 6a ----

// ---- Round 6 Task 6b ----
// One store addition the judging screen and Improvement.test (TestInfo) both
// need: the "corrections" an episode's evidence actually names, reusing the
// exact query listEpisodesAfter's own correctionsStmt already uses (Round 4
// C1) -- a message_classifications row with classification = 'correction'
// for one of the episode's evidence messages, summary falling back to the
// first 200 chars of the message itself. Scoped to one episode id instead of
// "every episode after some date" -- a plain reuse of the same table shape,
// not a new concept.

/** The corrections an episode's own evidence names -- what the judging
 * screen lists as "each correction you made" and what a paired test's score
 * (no ÷ corrections) divides by. Oldest first. [] for an episode with no
 * classified correction message (a candidate created by hand, or one whose
 * episode predates the classifier pipeline) -- callers treat that as "no
 * corrections to judge" rather than an error. */
export function episodeCorrections(episodeId: number): string[] {
  const rows = db
    .prepare(
      `SELECT mc.summary as summary, hi.content as content
       FROM task_episode_evidence tee
       JOIN history_items hi ON hi.id = tee.history_item_id
       JOIN message_classifications mc ON mc.history_item_id = hi.id
       WHERE tee.task_episode_id = ? AND mc.classification = 'correction'
       ORDER BY hi.occurred_at IS NULL, hi.occurred_at, hi.id`,
    )
    .all(episodeId) as { summary: string | null; content: string }[];
  return rows.map((r) => (r.summary && r.summary.length > 0 ? r.summary : r.content.slice(0, 200)));
}
// ---- end Round 6 Task 6b ----

// ---- Round 6 fix wave item C ----
/** The corrections fallback for an episode with no message_classifications
 * rows (episodeCorrections above returns [] for it) -- typically a
 * hand-built episode from before, or outside, the classifier pipeline (the
 * owner's own real first episode was exactly this). Every evidence message
 * AFTER the opening request (the same first-user-message row
 * episodeRequestText/episodeRequestExternalId resolve) whose role is 'user'
 * or 'operator' -- the owner's own follow-up/correction messages, never
 * Lovable's replies. humanVisibleText's own excerpt fallback (these are
 * plain user-authored messages, never lov-tool-use blobs, so that fallback
 * is always what runs) caps each one at 600 characters. Oldest first, same
 * order as episodeCorrections. [] when the episode has no follow-up
 * messages either (nothing to judge either way). */
export function episodeFollowUpCorrections(episodeId: number): string[] {
  const rows = db
    .prepare(
      `SELECT hi.id as id, hi.content as content, hi.role as role
       FROM task_episode_evidence tee
       JOIN history_items hi ON hi.id = tee.history_item_id
       WHERE tee.task_episode_id = ?
       ORDER BY ${EPISODE_REQUEST_ORDER}`,
    )
    .all(episodeId) as { id: number; content: string; role: string | null }[];
  // rows[0] is the request; the rest are read in time order (the
  // request-first ordering puts user messages ahead of operator notes).
  const requestId = rows[0]?.id;
  const timeOrder = db
    .prepare(
      `SELECT hi.id FROM task_episode_evidence tee
       JOIN history_items hi ON hi.id = tee.history_item_id
       WHERE tee.task_episode_id = ?
       ORDER BY hi.occurred_at IS NULL, hi.occurred_at, hi.id`,
    )
    .all(episodeId) as { id: number }[];
  const rank = new Map(timeOrder.map((r, i) => [r.id, i]));
  return rows
    .filter((r) => r.id !== requestId)
    .sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0))
    .filter((r) => r.role === "user" || r.role === "operator")
    .map((r) => humanVisibleText(r.content));
}
// ---- end Round 6 fix wave item C ----

// ---- Round 6c ----
// The Tests page (spec: "a page dedicated for this so you can see status,
// and actual results, and somewhere we can collect feedback from the user
// about this"). Two additions: a free-text note on any run (any status),
// and the page's own list read -- every run joined with the rule text and
// project id its table needs, without a second query per row.

/** Saves (or, given null, clears) the owner's own free-text note on one
 * paired-test run -- the Tests page's and the judging screen's shared
 * feedback box. Unlike updateExperimentRun (the runner's own stage-write
 * path, which stamps heartbeat_at on every call), this stamps feedback_at
 * -- "when the owner last saved a note" -- on every call including a
 * clear, so the page can show "Your note, <day>" against the save itself,
 * not some unrelated run activity. */
export function setExperimentFeedback(runId: number, text: string | null): void {
  db.prepare(
    `UPDATE experiment_runs SET feedback = ?, feedback_at = datetime('now') WHERE id = ?`,
  ).run(text, runId);
  insertEvent("experiment_run.feedback_saved", null, { run_id: runId, cleared: text === null });
}

/** Every experiment_runs row, any status, newest first, joined with the
 * rule's own instruction text and the episode's project_id -- the Tests
 * page's own list read (improvements.ts#listTestRunSummaries reshapes this
 * further, adding the episode's own corrections count via
 * correctionsForEpisode, a pure function that belongs there, not here). */
export function listExperimentRunsWithRules(): (ExperimentRunRow & {
  rule_text: string;
  correction_candidate_id: number;
  project_id: string | null;
})[] {
  return db
    .prepare(
      `SELECT er.*, r.instruction as rule_text, te.project_id as project_id
       FROM experiment_runs er
       JOIN rules r ON r.id = er.rule_id
       JOIN correction_candidates cc ON cc.id = er.correction_candidate_id
       JOIN task_episodes te ON te.id = cc.task_episode_id
       ORDER BY er.id DESC`,
    )
    .all() as (ExperimentRunRow & {
    rule_text: string;
    correction_candidate_id: number;
    project_id: string | null;
  })[];
}
// ---- end Round 6c ----

// ---- Round 7: end-to-end test fixes ----
/** new_content of the newest verified-written Knowledge version for a
 * target, or null -- what Harness itself last put in Lovable there
 * (executeVersionNow uses it to recognise its own managed block). */
export function latestWrittenKnowledgeContent(
  target: KnowledgeTarget,
  targetId: string,
): string | null {
  const row = db
    .prepare(
      `SELECT new_content FROM knowledge_versions
       WHERE target = ? AND ${targetColumn(target)} = ? AND status = 'written'
       ORDER BY id DESC LIMIT 1`,
    )
    .get(target, targetId) as { new_content: string } | undefined;
  return row?.new_content ?? null;
}

/** Every rule that was ever written to this target's Knowledge, with its
 * current state -- what going back to an older text reconciles. */
export function writtenRulesForTarget(
  target: KnowledgeTarget,
  targetId: string,
): { id: number; instruction: string; state: string }[] {
  return db
    .prepare(
      `SELECT DISTINCT r.id, r.instruction, r.state FROM rules r
       JOIN knowledge_versions kv ON kv.rule_id = r.id
       WHERE kv.status = 'written' AND kv.target = ? AND ${targetColumn(target).replace(/^/, "kv.")} = ?`,
    )
    .all(target, targetId) as { id: number; instruction: string; state: string }[];
}

/** Every wording a rule has had: its current instruction and each earlier
 * or later one from rule_revisions. */
export function ruleWordings(ruleId: number): string[] {
  const current = db.prepare(`SELECT instruction FROM rules WHERE id = ?`).get(ruleId) as
    | { instruction: string }
    | undefined;
  const revisions = db
    .prepare(`SELECT previous_instruction AS a, new_instruction AS b FROM rule_revisions WHERE rule_id = ?`)
    .all(ruleId) as { a: string; b: string }[];
  return Array.from(
    new Set([current?.instruction, ...revisions.flatMap((r) => [r.a, r.b])].filter((t): t is string => !!t)),
  );
}

// ---- Analysis progress (Round 7) ----
export type AnalysisStage = "starting" | "classify" | "group" | "rules" | "judge" | "health";
export type AnalysisProgress = { stage: AnalysisStage; done: number; total: number | null };

export function setAnalysisProgress(runId: number, progress: AnalysisProgress): void {
  db.prepare(`UPDATE analysis_runs SET progress_json = ? WHERE id = ?`).run(
    JSON.stringify(progress),
    runId,
  );
}

/** The run in flight (same crash window as runningAnalysisRun) with its
 * progress, or null. */
export function runningAnalysisProgress(): {
  id: number;
  started_at: string;
  progress: AnalysisProgress | null;
} | null {
  const row = db
    .prepare(
      `SELECT id, started_at, progress_json FROM analysis_runs
       WHERE finished_at IS NULL AND started_at >= datetime('now', '-15 minutes')
       ORDER BY id DESC LIMIT 1`,
    )
    .get() as { id: number; started_at: string; progress_json: string | null } | undefined;
  if (!row) return null;
  let progress: AnalysisProgress | null = null;
  try {
    progress = row.progress_json ? (JSON.parse(row.progress_json) as AnalysisProgress) : null;
  } catch {
    progress = null;
  }
  return { id: row.id, started_at: row.started_at, progress };
}

/** Projects that are Harness Ledger's own test copies, keyed by project id,
 * with the test number -- the Projects page labels them. */
export function testCopyProjects(): Record<string, number> {
  const rows = db
    .prepare(`SELECT id, copy_project_id, original_copy_project_id FROM experiment_runs`)
    .all() as { id: number; copy_project_id: string | null; original_copy_project_id: string | null }[];
  const out: Record<string, number> = {};
  for (const r of rows) {
    if (r.copy_project_id) out[r.copy_project_id] = r.id;
    if (r.original_copy_project_id) out[r.original_copy_project_id] = r.id;
  }
  return out;
}

/** Keeps a known project's name in step with Lovable (a rename there). */
export function setProjectName(lovableProjectId: string, name: string): void {
  db.prepare(
    `UPDATE projects SET name = ?, updated_at = datetime('now') WHERE lovable_project_id = ? AND (name IS NULL OR name != ?)`,
  ).run(name, lovableProjectId, name);
}
// ---- end Round 7 (projects) ----

// ---- Round 7: one suggestion per correction ----
export type CorrectionMiningOutcome = "proposed" | "no_proposal" | "duplicate" | "skipped_repeat";

/** Records that the Rule writer was asked about these corrections, so they
 * are not mined again. Idempotent per correction (first outcome wins). */
export function recordCorrectionMining(
  historyItemIds: number[],
  outcome: CorrectionMiningOutcome,
  opts: { correction_candidate_id?: number | null; run_id?: number | null } = {},
): void {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO correction_mining (history_item_id, outcome, correction_candidate_id, run_id)
     VALUES (?, ?, ?, ?)`,
  );
  for (const id of historyItemIds) {
    stmt.run(id, outcome, opts.correction_candidate_id ?? null, opts.run_id ?? null);
  }
}

/** The correction texts a suggestion was made from (its own cited evidence
 * classified as corrections, oldest first) -- [] for a suggestion whose
 * evidence carries no classified correction (e.g. hand-built ones). */
export function candidateCorrections(correctionCandidateId: number): string[] {
  const rows = db
    .prepare(
      `SELECT mc.summary AS summary, hi.content AS content
       FROM correction_candidate_evidence cce
       JOIN history_items hi ON hi.id = cce.history_item_id
       JOIN message_classifications mc ON mc.history_item_id = hi.id
       WHERE cce.correction_candidate_id = ? AND mc.classification = 'correction'
       ORDER BY hi.occurred_at IS NULL, hi.occurred_at, hi.id`,
    )
    .all(correctionCandidateId) as { summary: string | null; content: string }[];
  return rows.map((r) => (r.summary && r.summary.length > 0 ? r.summary : r.content.slice(0, 200)));
}
// ---- end Round 7 ----
