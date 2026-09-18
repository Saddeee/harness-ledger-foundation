/**
 * Checkpoint 2026-09-18: the replay environment record.
 *
 * A "Test this rule" run is a historical replay: Lovable builds the original
 * request once more in a copy of the project as it was just before that
 * request, with the candidate rule added to the copy's Knowledge. The result
 * is compared with the build that really happened back then. To say honestly
 * what such a replay can and cannot show, every run records:
 *
 * - which Project Knowledge the copy started from and HOW it was chosen
 *   (exact_historical / nearest_earlier_version / current_fallback /
 *   unavailable) -- never a silent fallback to today's Knowledge;
 * - the rules that were live in that Knowledge at the time (kept, not
 *   replaced, so the candidate is the only addition);
 * - every instruction surface Harness Ledger cannot reconstruct (Lovable's
 *   own project memory, workspace Knowledge, Skills, the builder version) --
 *   these are always disclosed, never hidden;
 * - a quality label: a historical replay is at best a historical
 *   approximation; only a paired comparison (two fresh builds, not yet
 *   implemented) with historical Knowledge reaches partially_controlled.
 *
 * Pure functions over plain inputs first (testable without Lovable), then
 * one store-backed builder and a backfill for runs recorded before the
 * environment_json column existed (migration v18).
 */
import * as store from "../store.js";
import { db } from "../db.js";
import {
  HARNESS_END,
  HARNESS_START,
  MANAGED_HEADING,
  extractManagedBlock,
  realKnowledgeText,
  type ManagedRule,
} from "../knowledge.js";

// ------------------------------------------------------------- vocabulary

export type ProjectKnowledgeSource =
  "exact_historical" | "nearest_earlier_version" | "current_fallback" | "unavailable";

export type EnvironmentQuality =
  "controlled" | "partially_controlled" | "historical_approximation" | "not_comparable";

export type ExperimentKind = store.ExperimentKind;

/** The instruction surfaces a replay copy inherits from the present, in the
 * order the judging screen lists them. Lovable copies its own project memory
 * as it is today; workspace Knowledge and workspace Skills apply to every
 * project in the workspace as they are today; the builder version is not
 * exposed by the API. */
export const UNCONTROLLED_CONTEXT = [
  "lovable_project_memory",
  "workspace_knowledge",
  "skills",
  "lovable_model_version",
] as const;

export type ReplayEnvironment = {
  version: 1;
  kind: ExperimentKind;
  code_state: {
    source: "historical_commit_before_request" | "unavailable";
    request_message_id: string | null;
  };
  project_knowledge: {
    source: ProjectKnowledgeSource;
    snapshot_id: number | null;
    snapshot_fetched_at: string | null;
    episode_started_at: string | null;
    char_count: number;
  };
  workspace_knowledge: { source: "current_uncontrolled" };
  skills: { source: "current_uncontrolled" };
  chat_history: { included: boolean };
  candidate_rule: { rule_id: number; instruction: string; already_present: boolean };
  other_active_rules: string[];
  uncontrolled: readonly string[];
  quality: EnvironmentQuality;
  /** The exact Knowledge text sent to the copy (base + candidate). */
  knowledge_for_copy: string;
  /** Set by backfillReplayEnvironments for runs made before this record
   * existed: the run itself replaced the historical block with the
   * candidate alone (the old composer), so the rules listed in
   * other_active_rules were NOT in the copy's Knowledge. */
  backfilled?: boolean;
  historical_rules_dropped_by_run?: boolean;
};

// ---------------------------------------------------------------- helpers

/** SQLite's zone-less "YYYY-MM-DD HH:MM:SS" is UTC; ISO strings parse as
 * they are. Same convention as experiments.ts. */
function parseTimestampMs(iso: string): number {
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(iso)) {
    return Date.parse(iso.replace(" ", "T") + "Z");
  }
  return Date.parse(iso);
}

// ------------------------------------------------ selectProjectKnowledgeAt

export type SnapshotLike = { id: number; content: string; fetched_at: string };

export type KnowledgeSelection = {
  source: ProjectKnowledgeSource;
  snapshot_id: number | null;
  snapshot_fetched_at: string | null;
  content: string;
};

/** The Project Knowledge a replay copy should start from, for a request at
 * `episodeStartedAt`, chosen from Harness Ledger's own snapshot history
 * (oldest first, as listKnowledgeSnapshots returns it):
 *
 * - exact_historical: a snapshot fetched in the same second as the request;
 * - nearest_earlier_version: the newest snapshot fetched before the request;
 * - current_fallback: no snapshot precedes the request (or the request time
 *   is unknown), so the newest snapshot known when the run started is used
 *   -- disclosed as such, never silently;
 * - unavailable: no snapshot at all; the copy starts with empty Knowledge.
 *
 * `runStartedAt` bounds the fallback so a backfilled record for an old run
 * reproduces what that run saw, not what is newest today. */
export function selectProjectKnowledgeAt(
  snapshots: SnapshotLike[],
  episodeStartedAt: string | null,
  runStartedAt: string,
): KnowledgeSelection {
  if (snapshots.length === 0) {
    return { source: "unavailable", snapshot_id: null, snapshot_fetched_at: null, content: "" };
  }
  if (episodeStartedAt) {
    const wantMs = parseTimestampMs(episodeStartedAt);
    let picked: SnapshotLike | null = null;
    for (const snap of snapshots) {
      const ms = parseTimestampMs(snap.fetched_at);
      if (ms <= wantMs) picked = snap;
      else break;
    }
    if (picked) {
      const exact =
        Math.floor(parseTimestampMs(picked.fetched_at) / 1000) === Math.floor(wantMs / 1000);
      return {
        source: exact ? "exact_historical" : "nearest_earlier_version",
        snapshot_id: picked.id,
        snapshot_fetched_at: picked.fetched_at,
        content: picked.content,
      };
    }
  }
  const runMs = parseTimestampMs(runStartedAt);
  let latest: SnapshotLike | null = null;
  for (const snap of snapshots) {
    if (parseTimestampMs(snap.fetched_at) <= runMs) latest = snap;
  }
  if (!latest) latest = snapshots[0]!;
  return {
    source: "current_fallback",
    snapshot_id: latest.id,
    snapshot_fetched_at: latest.fetched_at,
    content: latest.content,
  };
}

// -------------------------------------------------- composeReplayKnowledge

/** The bullet lines inside a managed block, without the "- " prefix. */
export function managedBlockBullets(block: string | null): string[] {
  if (!block) return [];
  return block
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2));
}

export type ReplayKnowledge = {
  final_content: string;
  other_active_rules: string[];
  candidate_already_present: boolean;
};

/** Historical Knowledge plus the candidate, and nothing else changed: the
 * rules that were live in the historical managed block stay exactly as they
 * were, the candidate is appended (unless it is already there), and every
 * character outside the block is preserved. Unlike composeManagedKnowledge
 * (which rebuilds the block from today's active rules for a real write),
 * this never drops a historical rule -- a replay whose Knowledge silently
 * lost the rules of the time would not be a replay of the time. */
export function composeReplayKnowledge(rawBase: string, candidate: ManagedRule): ReplayKnowledge {
  const base = realKnowledgeText(rawBase);
  const block = extractManagedBlock(base);
  const historical = managedBlockBullets(block);
  const candidateLine = candidate.instruction.trim();
  const already = historical.includes(candidateLine);
  const bullets = already ? historical : [...historical, candidateLine];
  const newBlock = `${HARNESS_START}\n${MANAGED_HEADING}\n${bullets.map((b) => `- ${b}`).join("\n")}\n${HARNESS_END}`;

  let final_content: string;
  if (block === null) {
    final_content = base === "" ? newBlock : `${base}\n\n${newBlock}`;
  } else {
    const startIdx = base.indexOf(HARNESS_START);
    const endIdx = base.indexOf(HARNESS_END) + HARNESS_END.length;
    final_content = base.slice(0, startIdx) + newBlock + base.slice(endIdx);
  }
  return {
    final_content,
    other_active_rules: historical.filter((b) => b !== candidateLine),
    candidate_already_present: already,
  };
}

// ------------------------------------------------------ environmentQuality

/** How comparable a test's arms are.
 *
 * - controlled: every controllable instruction surface matches across fresh
 *   arms. Not reachable today: Lovable's project memory cannot be reset.
 * - partially_controlled: two fresh arms differ only by the candidate on
 *   the surfaces Harness Ledger controls (code state, Project Knowledge),
 *   while memory, workspace Knowledge and Skills come from the present.
 * - historical_approximation: the historical build is one arm (a different
 *   Lovable environment), or the Project Knowledge came from the present.
 * - not_comparable: the historical code state could not be established. */
export function environmentQuality(input: {
  kind: ExperimentKind;
  project_knowledge_source: ProjectKnowledgeSource;
  code_state_ok: boolean;
}): EnvironmentQuality {
  if (!input.code_state_ok) return "not_comparable";
  if (input.kind === "historical_replay") return "historical_approximation";
  const historicalKnowledge =
    input.project_knowledge_source === "exact_historical" ||
    input.project_knowledge_source === "nearest_earlier_version";
  return historicalKnowledge ? "partially_controlled" : "historical_approximation";
}

// ----------------------------------------------------- buildReplayEnvironment

/** The full record for one run, from the store's snapshot history. Pure
 * apart from the snapshot read; the runner calls it before writing Knowledge
 * to the copy and sends `knowledge_for_copy` verbatim. */
export function buildReplayEnvironment(input: {
  kind: ExperimentKind;
  source_project_id: string;
  episode_started_at: string | null;
  run_started_at: string;
  candidate: ManagedRule;
  request_rest_message_id: string | null;
  chat_history_included: boolean;
}): ReplayEnvironment {
  const snapshots = store.listKnowledgeSnapshots("project", input.source_project_id);
  const selection = selectProjectKnowledgeAt(
    snapshots,
    input.episode_started_at,
    input.run_started_at,
  );
  const composed = composeReplayKnowledge(selection.content, input.candidate);
  const codeStateOk = input.request_rest_message_id !== null;
  return {
    version: 1,
    kind: input.kind,
    code_state: {
      source: codeStateOk ? "historical_commit_before_request" : "unavailable",
      request_message_id: input.request_rest_message_id,
    },
    project_knowledge: {
      source: selection.source,
      snapshot_id: selection.snapshot_id,
      snapshot_fetched_at: selection.snapshot_fetched_at,
      episode_started_at: input.episode_started_at,
      char_count: realKnowledgeText(selection.content).length,
    },
    workspace_knowledge: { source: "current_uncontrolled" },
    skills: { source: "current_uncontrolled" },
    chat_history: { included: input.chat_history_included },
    candidate_rule: {
      rule_id: input.candidate.id,
      instruction: input.candidate.instruction,
      already_present: composed.candidate_already_present,
    },
    other_active_rules: composed.other_active_rules,
    uncontrolled: UNCONTROLLED_CONTEXT,
    quality: environmentQuality({
      kind: input.kind,
      project_knowledge_source: selection.source,
      code_state_ok: codeStateOk,
    }),
    knowledge_for_copy: composed.final_content,
  };
}

export function parseReplayEnvironment(json: string | null): ReplayEnvironment | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as ReplayEnvironment;
    return parsed && parsed.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------- backfillReplayEnvironments

/** Gives every run recorded before migration v18 an environment computed
 * from what was on file when that run started (the snapshot history is
 * append-only, so this reproduces the old runner's own choice). Those runs
 * used the old composer, which replaced the historical block with the
 * candidate alone, so the record also says that the historical rules were
 * dropped by the run. Idempotent: runs that already have a record are left
 * alone. Called once at startup by the adapter. */
export function backfillReplayEnvironments(): { backfilled: number[] } {
  const rows = db
    .prepare(`SELECT * FROM experiment_runs WHERE environment_json IS NULL ORDER BY id ASC`)
    .all() as store.ExperimentRunRow[];
  const backfilled: number[] = [];
  for (const run of rows) {
    const rule = store.getRule(run.rule_id) as { rule: { instruction: string } } | null;
    const episode = db
      .prepare(`SELECT started_at FROM task_episodes WHERE id = ?`)
      .get(run.task_episode_id) as { started_at: string | null } | undefined;
    const resolved = db
      .prepare(
        `SELECT payload FROM events WHERE kind = 'experiment.resolved_request'
           AND json_extract(payload, '$.run_id') = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(run.id) as { payload: string } | undefined;
    let restId: string | null = null;
    if (resolved) {
      try {
        restId = (JSON.parse(resolved.payload) as { rest_id?: string }).rest_id ?? null;
      } catch {
        restId = null;
      }
    }
    const env = buildReplayEnvironment({
      kind: "historical_replay",
      source_project_id: run.source_project_id,
      episode_started_at: episode?.started_at ?? null,
      run_started_at: run.started_at,
      candidate: { id: run.rule_id, instruction: rule?.rule.instruction ?? "" },
      request_rest_message_id:
        restId ?? (run.copy_project_id ? run.request_message_external_id : null),
      chat_history_included: false,
    });
    env.backfilled = true;
    env.historical_rules_dropped_by_run = env.other_active_rules.length > 0;
    store.updateExperimentRun(run.id, {
      kind: "historical_replay",
      environment_json: JSON.stringify(env),
    });
    backfilled.push(run.id);
  }
  return { backfilled };
}
