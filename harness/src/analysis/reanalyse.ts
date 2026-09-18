// Checkpoint 2026-09-18 WP5 (D7 / docs/audit/sync-analysis.md §4-6):
// "Reanalyse history" -- a separate, scoped, estimated, confirmed action
// that re-checks already-classified messages without ever silently
// overwriting a human decision. A disagreement with a reviewed decision
// becomes a review item (`analysis_disagreements`), never a mutation of
// `correction_candidates`/`rules`.
//
// Deliberately its own module rather than store.ts (WP4 owns store.ts this
// checkpoint) -- see context.ts's header for the same note. SQL here goes
// straight at `db`, matching harness/src/executor/replay-environment.ts's
// pattern.
import { db } from "../db.js";
import * as store from "../store.js";
import type { CallLlm } from "../llm/types.js";
import { LlmBudgetExceeded } from "../llm/types.js";
import {
  buildContextPacket,
  contentHashOf,
  CONTEXT_STRATEGY_VERSION,
  PROMPT_VERSION,
  recordAnalysisContext,
  stampClassification,
} from "./context.js";
import {
  classifierSystemPrompt,
  classifierUserPrompt,
  rulesInLovable,
  validateClassifierOutput,
  CLASSIFIER_JSON_SCHEMA,
  type RawClassifierOutput,
} from "./classify.js";

// ------------------------------------------------------------------ scope

export type ReanalyseScope = {
  /** Empty = every allowed project. */
  project_ids: string[];
  /** ISO date (YYYY-MM-DD) or full ISO timestamp; inclusive. */
  from: string;
  /** ISO date (YYYY-MM-DD) or full ISO timestamp; inclusive (a bare date is
   * widened to the end of that day). */
  to: string;
  /** Default false: records a person already decided on are excluded from
   * both the estimate and the actual reanalyse pass. */
  include_reviewed: boolean;
};

function resolvedProjectIds(scope: Pick<ReanalyseScope, "project_ids">): string[] {
  if (scope.project_ids.length > 0) return scope.project_ids;
  return (store.getAllowedProjects() as { lovable_project_id: string }[]).map(
    (p) => p.lovable_project_id,
  );
}

function dayBounds(from: string, to: string): { fromIso: string; toIso: string } {
  const fromIso = from.includes("T") ? from : `${from}T00:00:00.000Z`;
  const toIso = to.includes("T") ? to : `${to}T23:59:59.999Z`;
  return { fromIso, toIso };
}

// ------------------------------------------------------- reviewed status

type ReviewInfo = { reviewed: boolean; candidateId: number | null };

/** Whether the message's linked correction (if any) is a decision a human
 * already made: `correction_candidates.reviewed`, `decided_by` set, or a
 * rule exists past the 'proposed' state. When a message links to more than
 * one candidate (rare -- evidence can be shared), the most recently created
 * one wins, matching every other "latest wins" read in this codebase. */
function reviewInfoForMessage(historyItemId: number): ReviewInfo {
  const row = db
    .prepare(
      `SELECT cc.id as candidate_id, cc.reviewed, cc.decided_by, r.state as rule_state
       FROM correction_candidate_evidence cce
       JOIN correction_candidates cc ON cc.id = cce.correction_candidate_id
       LEFT JOIN rules r ON r.correction_candidate_id = cc.id
       WHERE cce.history_item_id = ?
       ORDER BY cc.id DESC LIMIT 1`,
    )
    .get(historyItemId) as
    | {
        candidate_id: number;
        reviewed: number;
        decided_by: string | null;
        rule_state: string | null;
      }
    | undefined;
  if (!row) return { reviewed: false, candidateId: null };
  const reviewed =
    row.reviewed === 1 ||
    row.decided_by != null ||
    (row.rule_state != null && row.rule_state !== "proposed");
  return { reviewed, candidateId: row.candidate_id };
}

// ---------------------------------------------------------------- estimate

const FLAT_OVERHEAD_TOKENS_PER_CALL = 200;
// Reanalyse only re-runs the classifier role (it reclassifies messages; it
// never re-proposes rules or re-judges adherence) -- see runReanalysisPass
// below. If a future checkpoint adds a re-propose pass, this constant (and
// the doc comment on estimateReanalysis) is where that second role's share
// of the estimate would be added.
const ROLES_INVOLVED = 1;

export type ReanalysisEstimate = {
  messages: number;
  corrections: number;
  episodes: number;
  estimated_tokens: number;
  models: {
    classifier: { provider: string; model: string };
    rule_writer: { provider: string; model: string };
    judge: { provider: string; model: string };
  };
  budget_remaining: number;
};

function scopeMessages(
  scope: ReanalyseScope,
): { id: number; project_id: string | null; content: string }[] {
  const projectIds = resolvedProjectIds(scope);
  if (projectIds.length === 0) return [];
  const { fromIso, toIso } = dayBounds(scope.from, scope.to);
  const placeholders = projectIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT id, project_id, content FROM history_items
       WHERE kind = 'message' AND role = 'user' AND project_id IN (${placeholders})
         AND occurred_at >= ? AND occurred_at <= ?
       ORDER BY occurred_at ASC, id ASC`,
    )
    .all(...projectIds, fromIso, toIso) as {
    id: number;
    project_id: string | null;
    content: string;
  }[];
  if (scope.include_reviewed) return rows;
  return rows.filter((r) => !reviewInfoForMessage(r.id).reviewed);
}

/**
 * Candidate counts, an estimated token cost, the provider/model this run
 * would use per role, and the token budget remaining.
 *
 * Formula (documented, not just implemented): for each candidate message,
 * `ceil(chars(message) / 4)` (the same chars/4 approximation
 * harness/src/llm/budget.ts's estimateTokens uses for a call's input) times
 * ROLES_INVOLVED (1 -- reanalyse only reclassifies), plus a flat
 * FLAT_OVERHEAD_TOKENS_PER_CALL (200) per message for the system prompt/
 * schema/formatting overhead a real call also spends tokens on:
 *
 *   estimated_tokens = sum(ceil(chars/4)) * ROLES_INVOLVED
 *                      + FLAT_OVERHEAD_TOKENS_PER_CALL * message_count
 */
export function estimateReanalysis(scope: ReanalyseScope): ReanalysisEstimate {
  const messages = scopeMessages(scope);
  const projectIds = resolvedProjectIds(scope);

  let correctionCount = 0;
  let episodeCount = 0;
  if (messages.length > 0 && projectIds.length > 0) {
    const placeholders = messages.map(() => "?").join(",");
    const ids = messages.map((m) => m.id);
    const candidateRow = db
      .prepare(
        `SELECT COUNT(DISTINCT cce.correction_candidate_id) as n
         FROM correction_candidate_evidence cce
         WHERE cce.history_item_id IN (${placeholders})`,
      )
      .get(...ids) as { n: number };
    correctionCount = candidateRow.n;

    const episodeRow = db
      .prepare(
        `SELECT COUNT(DISTINCT tee.task_episode_id) as n
         FROM task_episode_evidence tee
         WHERE tee.history_item_id IN (${placeholders})`,
      )
      .get(...ids) as { n: number };
    episodeCount = episodeRow.n;
  }

  const chars = messages.reduce((n, m) => n + m.content.length, 0);
  const estimatedTokens =
    Math.ceil(chars / 4) * ROLES_INVOLVED + FLAT_OVERHEAD_TOKENS_PER_CALL * messages.length;

  const models = store.getLlmModels();
  const budget = Number(store.getSetting("llm_monthly_token_budget"));
  const used = store.sumLlmTokensThisMonth();

  return {
    messages: messages.length,
    corrections: correctionCount,
    episodes: episodeCount,
    estimated_tokens: estimatedTokens,
    models: {
      classifier: models.classifier,
      rule_writer: models.rule_writer,
      judge: models.judge,
    },
    budget_remaining: Math.max(0, budget - used),
  };
}

// ---------------------------------------------------------------- request

/**
 * Queues a 'reanalyse' analysis_requests row -- never coalesced with an
 * open incremental request (unlike store.requestAnalysis()), so a scoped
 * reanalyse a person explicitly asked for is never silently absorbed into
 * (or absorbs) an ordinary "Analyse now".
 */
export function requestReanalysis(scope: ReanalyseScope, reason: string): { id: number } {
  const scopeJson = JSON.stringify({ ...scope, reason });
  const row = db
    .prepare(
      `INSERT INTO analysis_requests (mode, scope_json) VALUES ('reanalyse', ?) RETURNING id`,
    )
    .get(scopeJson) as { id: number };
  store.insertEvent("analysis_request.reanalyse_created", null, { id: row.id, scope, reason });
  return { id: row.id };
}

export type AnalysisRequestRow = {
  id: number;
  status: string;
  mode: "incremental" | "reanalyse";
  scope_json: string | null;
};

/** Reads back the mode/scope of a request runAnalysis just took --
 * store.takeAnalysisRequest (owned by WP4 this checkpoint) only returns the
 * id, not these columns. */
export function getAnalysisRequest(id: number): AnalysisRequestRow | null {
  return (
    (db
      .prepare(`SELECT id, status, mode, scope_json FROM analysis_requests WHERE id = ?`)
      .get(id) as AnalysisRequestRow | undefined) ?? null
  );
}

// --------------------------------------------------------- the reanalyse pass

export type ReanalysisPassResult = { updated: number; disagreements: number; failed: number };

/** Shape of `analysis_disagreements.previous_json`/`proposed_json`: enough
 * to show the Inbox card and (for proposed_json) to let acceptDisagreement
 * apply it to message_classifications without re-deriving anything. */
type DisagreementSnapshot = {
  history_item_id: number;
  classification: string;
  tags: string[];
  summary: string;
  content_hash: string | null;
  prompt_version: string | null;
  candidate?: {
    id: number;
    summary: string;
    reviewed: boolean;
    decided_by: string | null;
    rule_state: string | null;
  };
};

function insertDisagreement(
  correctionCandidateId: number,
  runId: number | null,
  previous: DisagreementSnapshot,
  proposed: DisagreementSnapshot,
): number {
  const row = db
    .prepare(
      `INSERT INTO analysis_disagreements (correction_candidate_id, run_id, previous_json, proposed_json)
       VALUES (?, ?, ?, ?) RETURNING id`,
    )
    .get(correctionCandidateId, runId, JSON.stringify(previous), JSON.stringify(proposed)) as {
    id: number;
  };
  store.insertEvent("analysis_disagreement.created", null, {
    id: row.id,
    correction_candidate_id: correctionCandidateId,
  });
  return row.id;
}

/**
 * Reclassifies every message in `scope` even if already classified. For a
 * message linked (via correction_candidate_evidence) to a human-reviewed
 * candidate (reviewed=1, decided_by set, or a linked rule past 'proposed')
 * whose classification the new call disagrees with: inserts an
 * analysis_disagreements row and touches nothing else -- the existing
 * message_classifications/correction_candidates/rules rows are left
 * byte-identical. Otherwise (no existing row, not reviewed, or the
 * classification agrees): writes/updates message_classifications in place,
 * refreshing content_hash/prompt_version/strategy_version/analyzed_at.
 */
export async function runReanalysisPass(
  callLlm: CallLlm,
  scope: ReanalyseScope,
  runId: number,
): Promise<ReanalysisPassResult> {
  const messages = scopeMessages(scope);
  let updated = 0;
  let disagreements = 0;
  let failed = 0;

  for (const message of messages) {
    const existing = db
      .prepare(
        `SELECT classification, tags_json, summary FROM message_classifications WHERE history_item_id = ?`,
      )
      .get(message.id) as
      { classification: string; tags_json: string; summary: string } | undefined;

    const context = store.listContextBefore(message.id, 3);
    const liveRules = message.project_id ? rulesInLovable(message.project_id) : [];
    const contextPacket = buildContextPacket({
      role: "classifier",
      projectId: message.project_id,
      currentMessage: { id: message.id, content: message.content },
      windowMessages: context,
      liveRules,
    });

    let result;
    try {
      result = await callLlm<RawClassifierOutput>({
        role: "classifier",
        system: classifierSystemPrompt(),
        user: classifierUserPrompt({ content: message.content }, context, liveRules, contextPacket),
        schema: CLASSIFIER_JSON_SCHEMA,
        schemaName: "message_classification",
        runId,
      });
    } catch (err) {
      if (err instanceof LlmBudgetExceeded) return { updated, disagreements, failed: failed + 1 };
      failed++;
      continue;
    }

    recordAnalysisContext({
      runId,
      llmCallId: null,
      role: "classifier",
      targetHistoryItemId: message.id,
      packet: contextPacket,
      contentHash: contentHashOf(message.content),
    });

    const validated = validateClassifierOutput(result.json);
    const hash = contentHashOf(message.content);
    const review = reviewInfoForMessage(message.id);
    const differs = existing != null && existing.classification !== validated.classification;

    if (review.reviewed && review.candidateId != null && differs) {
      const previous: DisagreementSnapshot = {
        history_item_id: message.id,
        classification: existing!.classification,
        tags: JSON.parse(existing!.tags_json) as string[],
        summary: existing!.summary,
        content_hash: null,
        prompt_version: null,
      };
      const proposed: DisagreementSnapshot = {
        history_item_id: message.id,
        classification: validated.classification,
        tags: validated.tags,
        summary: validated.summary,
        content_hash: hash,
        prompt_version: PROMPT_VERSION.classifier,
      };
      insertDisagreement(review.candidateId, runId, previous, proposed);
      disagreements++;
      continue;
    }

    if (existing) {
      db.prepare(
        `UPDATE message_classifications
         SET classification = ?, tags_json = ?, summary = ?
         WHERE history_item_id = ?`,
      ).run(
        validated.classification,
        JSON.stringify(validated.tags),
        validated.summary,
        message.id,
      );
    } else {
      store.insertMessageClassification({
        history_item_id: message.id,
        classification: validated.classification,
        tags: validated.tags,
        summary: validated.summary,
        run_id: runId,
      });
    }
    stampClassification(message.id, {
      contentHash: hash,
      promptVersion: PROMPT_VERSION.classifier,
      strategyVersion: CONTEXT_STRATEGY_VERSION,
    });
    updated++;
  }

  return { updated, disagreements, failed };
}

// -------------------------------------------------------------- disagreements

export type AnalysisDisagreementRow = {
  id: number;
  correction_candidate_id: number;
  run_id: number | null;
  previous_json: string;
  proposed_json: string;
  status: "open" | "accepted" | "dismissed";
  created_at: string;
  decided_at: string | null;
};

export function listAnalysisDisagreements(
  status: "open" | "accepted" | "dismissed" = "open",
): AnalysisDisagreementRow[] {
  return db
    .prepare(`SELECT * FROM analysis_disagreements WHERE status = ? ORDER BY id ASC`)
    .all(status) as AnalysisDisagreementRow[];
}

function getDisagreementOrThrow(id: number): AnalysisDisagreementRow {
  const row = db.prepare(`SELECT * FROM analysis_disagreements WHERE id = ?`).get(id) as
    AnalysisDisagreementRow | undefined;
  if (!row) throw new Error(`disagreement ${id} not found`);
  return row;
}

/** Applies the disagreement's proposed classification to the
 * message_classifications row ONLY -- never to the candidate's human
 * decision (reviewed/decided_by/skip_reason) or to a rule. */
export function acceptDisagreement(id: number): void {
  const row = getDisagreementOrThrow(id);
  const proposed = JSON.parse(row.proposed_json) as DisagreementSnapshot;
  db.prepare(
    `UPDATE message_classifications
     SET classification = ?, tags_json = ?, summary = ?, content_hash = ?, prompt_version = ?,
         strategy_version = ?, analyzed_at = datetime('now')
     WHERE history_item_id = ?`,
  ).run(
    proposed.classification,
    JSON.stringify(proposed.tags),
    proposed.summary,
    proposed.content_hash,
    proposed.prompt_version,
    CONTEXT_STRATEGY_VERSION,
    proposed.history_item_id,
  );
  db.prepare(
    `UPDATE analysis_disagreements SET status = 'accepted', decided_at = datetime('now') WHERE id = ?`,
  ).run(id);
  store.insertEvent("analysis_disagreement.accepted", null, { id });
}

export function dismissDisagreement(id: number): void {
  getDisagreementOrThrow(id);
  db.prepare(
    `UPDATE analysis_disagreements SET status = 'dismissed', decided_at = datetime('now') WHERE id = ?`,
  ).run(id);
  store.insertEvent("analysis_disagreement.dismissed", null, { id });
}
