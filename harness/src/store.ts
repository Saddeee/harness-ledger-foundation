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
  | "confirm" | "reclassify" | "mark_one_time" | "mark_reusable" | "change_scope" | "exclude" | "include";

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
    | { classification: string }
    | undefined;
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
  scope?: "project" | "workspace";
  reason?: string;
  actor: string;
}) {
  const existing = db.prepare(`SELECT * FROM rules WHERE id = ?`).get(input.id) as
    | { instruction: string; state: string; scope: string }
    | undefined;
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
  insertEvent("verification_definition.created", null, { id: row.id, verifier_type: input.verifier_type });
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
  insertEvent("rule_verification_link.created", null, { rule_id: ruleId, verification_definition_id: verificationDefinitionId });
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
    .get(input.rule_id, input.failure_signature, input.failure_condition, input.created_by) as { id: number };

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

  insertEvent("experiment_plan.created", null, { id: plan.id, rule_id: input.rule_id, status: "proposed" });
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
  insertEvent("experiment_resource.registered", null, { id: row.id, resource_type: input.resource_type });
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
  return db
    .prepare(`SELECT * FROM learnings WHERE correction_candidate_id = ? ORDER BY id ASC LIMIT 1`)
    .get(correctionCandidateId) ?? null;
}

export function getRuleForCorrection(correctionCandidateId: number) {
  return db
    .prepare(`SELECT * FROM rules WHERE correction_candidate_id = ? ORDER BY id ASC LIMIT 1`)
    .get(correctionCandidateId) ?? null;
}

// Events whose kind starts with one of the prefixes and whose payload
// references this id -- an approximation good enough for an audit panel.
export function listEventsForRecord(kindPrefixes: string[], id: number) {
  const rows = db
    .prepare(`SELECT * FROM events WHERE payload LIKE ? ORDER BY id DESC LIMIT 100`)
    .all(`%"id":${id}%`) as { kind: string }[];
  return rows.filter((r) => kindPrefixes.some((p) => r.kind.startsWith(p)));
}

export function listExperimentPlansForRule(ruleId: number) {
  const plans = db
    .prepare(`SELECT * FROM experiment_plans WHERE rule_id = ? ORDER BY created_at DESC`)
    .all(ruleId) as { id: number }[];
  return plans.map((p) => getExperimentPlan(p.id));
}
