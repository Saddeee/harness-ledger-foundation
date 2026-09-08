// Pure data-layer functions, independent of the MCP transport, so tests can
// call them directly. mcp-server.ts is a thin wrapper around this module.
import { db, dbPath } from "./db.js";

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
}) {
  return db
    .prepare(
      `INSERT INTO projects (lovable_project_id, name, status, url, tech_stack, raw_json, updated_at)
       VALUES (@lovable_project_id, @name, @status, @url, @tech_stack, @raw_json, datetime('now'))
       ON CONFLICT(lovable_project_id) DO UPDATE SET
         name = excluded.name, status = excluded.status, url = excluded.url,
         tech_stack = excluded.tech_stack, raw_json = excluded.raw_json, updated_at = excluded.updated_at
       RETURNING *`,
    )
    .get({
      lovable_project_id: input.lovable_project_id,
      name: input.name ?? null,
      status: input.status ?? null,
      url: input.url ?? null,
      tech_stack: input.tech_stack ?? null,
      raw_json: input.raw_json ?? null,
    });
}

// ---- Checkpoint B: correction pipeline ----

const PROVENANCE = ["lovable_mcp", "git_history", "build_log", "spec", "manual", "llm_derived"] as const;
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
  insertEvent("project_snapshot.created", input.lovable_project_id, { id: (row as { id: number }).id });
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
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO ${table} (${fk}, history_item_id) VALUES (?, ?)`,
  );
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
  linkEvidence("task_episode_evidence", "task_episode_id", input.id, input.add_evidence_history_item_ids);
  insertEvent("task_episode.updated", null, { id: input.id });
  return db.prepare(`SELECT * FROM task_episodes WHERE id = ?`).get(input.id);
}

const CLASSIFICATIONS = [
  "defect_correction", "constraint_restatement", "missing_requirement",
  "preference_revision", "scope_extension", "new_task", "question", "approval", "other",
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
  linkEvidence("correction_candidate_evidence", "correction_candidate_id", row.id, input.evidence_history_item_ids);
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
  | "confirm" | "reclassify" | "mark_one_time" | "mark_reusable" | "change_scope" | "exclude";

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
    | { classification: string }
    | undefined;
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

export function getClassificationHistory(correctionCandidateId: number) {
  return db
    .prepare(
      `SELECT * FROM agent_actions
       WHERE target_table = 'correction_candidates' AND target_id = ?
         AND action IN ('classify_correction', 'propose_reclassification')
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
  "proposed", "approved", "testing", "supported", "active", "questioned",
  "disabled", "retired", "rolled_back", "rejected",
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
  reason?: string;
  actor: string;
}) {
  const existing = db.prepare(`SELECT * FROM rules WHERE id = ?`).get(input.id) as
    | { instruction: string; state: string }
    | undefined;
  if (!existing) throw new Error(`rule ${input.id} not found`);

  const newInstruction = input.instruction ?? existing.instruction;
  const newState = input.state ?? existing.state;
  const changed = newInstruction !== existing.instruction || newState !== existing.state;

  if (changed) {
    db.prepare(
      `INSERT INTO rule_revisions (rule_id, previous_instruction, previous_state, new_instruction, new_state, reason, actor)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(input.id, existing.instruction, existing.state, newInstruction, newState, input.reason ?? null, input.actor);

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
              te.project_id as project_id
       FROM correction_candidates cc
       JOIN task_episodes te ON te.id = cc.task_episode_id
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

export function listProjectRules(projectId?: string) {
  if (!projectId) {
    return db
      .prepare(
        `SELECT r.* FROM rules r ORDER BY r.created_at DESC`,
      )
      .all();
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
