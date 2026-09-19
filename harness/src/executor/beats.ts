/**
 * The executor's beats: the only code that turns Lovable reads into ledger
 * rows, and the only code that writes Knowledge back.
 *
 * Each beat is idempotent and takes its Lovable dependency as an argument, so
 * tests inject an in-memory fake. Nothing here spends credits: only the eight
 * allowed read/write tools are ever reachable through `LovableReader` /
 * `LovableWriter`.
 */
import * as store from "../store.js";
import {
  getImprovement,
  improvementAction,
  peekActionKind,
  prepareWordingChangeRewrite,
  stageApprovedWrites,
  type Improvement,
} from "../improvements.js";
import {
  composeManagedKnowledge,
  extractManagedBlock,
  sha256,
  normalizeBlockForCompare,
} from "../knowledge.js";
import { redact } from "./redact.js";
import { recomputeRuleHealth } from "../analysis/health.js";
import { proposeRetirements } from "../analysis/retire.js";
import { status } from "./lovable-auth.js";
import { ensureFreshLovableToken, openLovableClient } from "./lovable-mcp.js";
import type { LovableClient, LovableReader, LovableWriter } from "./lovable-mcp.js";
// Round 6 Task 6b: the `test` action's own dispatch (isTestAction/
// testAction) and the background queue's own resume-on-restart call
// (kickExperimentRunner) -- see experiments-actions.ts/experiments-queue.ts
// for why each lives in its own module rather than folded in here.
import {
  deleteCopyAction,
  isDeleteCopyAction,
  isTestAction,
  testAction,
} from "./experiments-actions.js";
import { kickExperimentRunner } from "./experiments-queue.js";
// Checkpoint 2026-09-18 WP5 (D7): the automatic-analysis-after-sync
// setting/reader lives in analysis/context.ts, not store.ts (WP4 owns
// store.ts's SettingKey/SETTING_DEFAULTS this checkpoint) -- see that
// file's header for why.
import { getAutomaticAnalysisSetting } from "../analysis/context.js";
// ---- Checkpoint 3 S1 ----
// publish_skill_proposal's own dispatch, same reason and same pattern as
// isTestAction/testAction above: a Lovable-touching action lives in its own
// module, never in improvements.ts, and is intercepted here before
// peekActionKind ever sees it.
import {
  isPublishSkillProposalAction,
  publishSkillProposalAction,
} from "./skill-publish-action.js";
// ---- end Checkpoint 3 S1 ----

const FETCHED_BY = "executor";
/** Enough recent ids that a page of history cannot step over the known window. */
const KNOWN_ID_WINDOW = 200;
const DEFAULT_PAGE_LIMIT = 50;
/**
 * Page budget for one project in one pass. A project with more history than
 * this is not truncated: the pass parks its `next_cursor` in `sync_cursors`
 * and the following pass resumes older history from there.
 */
const MAX_PAGES_PER_PROJECT = 40;

function allowedProjectIds(): string[] {
  return (store.getAllowedProjects() as { lovable_project_id: string }[]).map(
    (p) => p.lovable_project_id,
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The workspace every allowed project belongs to: whatever a project row
 * already records, else `get_me`'s first workspace. Persisted onto the project
 * rows so later runs need no extra call.
 */
export async function resolveWorkspaceId(lovable: LovableReader): Promise<string | null> {
  for (const projectId of allowedProjectIds()) {
    const meta = store.getProjectMeta(projectId);
    if (meta?.workspace_id) return meta.workspace_id;
  }
  const me = await lovable.getMe();
  return me.workspaces[0]?.id ?? null;
}

/**
 * Beat 1 — history. Pages newest-first per allowed project and stops at the
 * first page that contains a message we already stored; the unknown messages
 * on that page are still inserted, so a page straddling the boundary loses
 * nothing. Content is redacted before it touches the database.
 */
export async function syncHistory(
  lovable: LovableReader,
  opts: { pageLimit?: number; maxPages?: number } = {},
): Promise<{ messages: number; projects: number; truncated: number }> {
  const pageLimit = opts.pageLimit ?? DEFAULT_PAGE_LIMIT;
  const maxPages = opts.maxPages ?? MAX_PAGES_PER_PROJECT;
  const projects = allowedProjectIds();
  const workspaceId = await resolveWorkspaceId(lovable);
  let messages = 0;
  let truncated = 0;

  const labels = new Map(
    (store.getAllowedProjects() as { lovable_project_id: string; label: string | null }[]).map(
      (r) => [r.lovable_project_id, r.label],
    ),
  );
  for (const projectId of projects) {
    const meta = store.getProjectMeta(projectId);
    const label = labels.get(projectId) ?? undefined;
    // Backfill the workspace id and, for a project allowed from the Projects
    // page, its name -- otherwise cards show the raw project id.
    if ((workspaceId && !meta?.workspace_id) || (label && !meta?.name)) {
      store.upsertProject({
        lovable_project_id: projectId,
        workspace_id: workspaceId ?? undefined,
        name: meta?.name ?? label,
      });
    }

    const known = store.latestHistoryExternalIds(projectId, KNOWN_ID_WINDOW);

    /**
     * Pages from `startCursor` until the caller's stop condition, the end of
     * history, or the page budget. Returns the cursor to resume from when the
     * budget ran out, `null` when history was read to the end.
     */
    const page = async (
      startCursor: string | undefined,
      stopAtKnown: boolean,
    ): Promise<{ parked: string | null }> => {
      let cursor = startCursor;
      for (let i = 0; i < maxPages; i += 1) {
        const result = await lovable.listMessages(projectId, cursor, pageLimit);
        let reachedKnown = false;

        for (const message of result.messages) {
          if (!message.message_id) continue;
          if (known.has(message.message_id)) {
            reachedKnown = true;
            continue;
          }
          store.upsertHistoryItem({
            project_id: projectId,
            kind: "message",
            external_id: message.message_id,
            role: message.role,
            content: redact(message.content).text,
            occurred_at: message.created_at,
            // The ledger's provenance vocabulary is fixed; "executor sync" is
            // the source_ref-level detail, the provenance is still Lovable MCP.
            provenance: "lovable_mcp",
            source_ref: message.edit_id ?? undefined,
          });
          known.add(message.message_id);
          messages += 1;
        }

        if ((stopAtKnown && reachedKnown) || !result.has_more || !result.next_cursor) {
          return { parked: null };
        }
        cursor = result.next_cursor;
      }
      // Budget exhausted with history still to read.
      return { parked: cursor ?? null };
    };

    // Newest-first pass: stops as soon as a page contains something we know.
    const forward = await page(undefined, true);
    if (forward.parked) {
      store.setSyncCursor(projectId, forward.parked);
      store.insertEvent("executor.sync.truncated", projectId, { cursor_parked: true });
      truncated += 1;
      continue;
    }

    // Backfill: resume older history parked by an earlier pass. It runs past
    // known ids by design — everything below the cursor is older than the
    // window the forward pass covers.
    const parked = store.getSyncCursor(projectId);
    if (parked) {
      const back = await page(parked, false);
      if (back.parked) {
        store.setSyncCursor(projectId, back.parked);
        store.insertEvent("executor.sync.truncated", projectId, { cursor_parked: true });
        truncated += 1;
      } else {
        store.clearSyncCursor(projectId);
      }
    }
  }

  return { messages, projects: projects.length, truncated };
}

/**
 * Beat 2 — Knowledge snapshots for every allowed project plus the workspace,
 * skipped when the sha256 matches the latest stored snapshot (no churn).
 */
export async function snapshotKnowledge(
  lovable: LovableReader,
  workspaceId: string,
): Promise<{ snapshots: number }> {
  let snapshots = 0;

  const record = (target: "project" | "workspace", targetId: string, content: string): void => {
    if (store.latestKnowledgeSnapshot(target, targetId)?.sha256 === sha256(content)) return;
    store.recordKnowledgeSnapshot({
      target,
      project_id: target === "project" ? targetId : undefined,
      workspace_id: target === "workspace" ? targetId : undefined,
      content,
      fetched_by: FETCHED_BY,
    });
    snapshots += 1;
  };

  for (const projectId of allowedProjectIds()) {
    record("project", projectId, await lovable.getProjectKnowledge(projectId));
  }
  if (workspaceId)
    record("workspace", workspaceId, await lovable.getWorkspaceKnowledge(workspaceId));

  return { snapshots };
}

/** Beat 3 — verbatim copies of the workspace Skills; deduped by content hash. */
export async function snapshotSkills(
  lovable: LovableReader,
  workspaceId: string,
): Promise<{ skills: number; changed: number }> {
  if (!workspaceId) return { skills: 0, changed: 0 };
  const { skills, complete } = await lovable.listWorkspaceSkills(workspaceId);
  let changed = 0;
  for (const skill of skills) {
    if (!skill.name) continue;
    const result = store.recordSkillSnapshot({
      workspace_id: workspaceId,
      name: skill.name,
      description: skill.description,
      content: skill.content,
      updated_at_remote: skill.updated_at,
      fetched_by: FETCHED_BY,
    });
    if (result.inserted) changed += 1;
  }
  // Round 7: a skill Harness knew about that Lovable no longer lists was
  // deleted there -- record it once, so it stops showing as current.
  // Only from a complete, well-formed answer: an empty or partial one must
  // never mark every skill deleted.
  const seen = new Set(skills.map((s) => s.name));
  for (const known of complete ? store.latestSkillSnapshots(workspaceId) : []) {
    if (!seen.has(known.name) && store.recordSkillDeleted(workspaceId, known.name, FETCHED_BY)) {
      changed += 1;
    }
  }
  return { skills: skills.length, changed };
}

type PendingWrite = {
  id: number;
  rule_id: number | null;
  target: "project" | "workspace";
  project_id: string | null;
  workspace_id: string | null;
  previous_sha256: string;
  new_content: string;
  rule_ids_json: string;
};

/**
 * The write half of the two-beat protocol, shared by `executeWrites` (the
 * per-pass loop below) and `executeVersionNow` (Round 6 Task 2's single-
 * version, request-driven write): send `newContent`, read it back, and let
 * the store decide `written` vs `failed` from the read-back hash. Callers
 * are responsible for the freshness check (and, for executeVersionNow,
 * recomposing `newContent`) before calling this — by the time this runs,
 * the decision to write has already been made.
 */
async function writeAndVerify(
  target: "project" | "workspace",
  targetId: string,
  newContent: string,
  versionId: number,
  lovable: LovableWriter & LovableReader,
): Promise<{ written: boolean }> {
  if (target === "project") {
    await lovable.setProjectKnowledge(targetId, newContent);
  } else {
    await lovable.setWorkspaceKnowledge(targetId, newContent);
  }

  const readBack =
    target === "project"
      ? await lovable.getProjectKnowledge(targetId)
      : await lovable.getWorkspaceKnowledge(targetId);

  const after = store.recordKnowledgeReadback(versionId, readBack);
  const written = after?.status === "written";
  // The read-back is a real read of Lovable: keep it as the latest snapshot,
  // so the next change (Remove right after Add) composes on what Lovable now
  // holds rather than on the pre-write read.
  if (written) {
    store.recordKnowledgeSnapshot({
      target,
      ...(target === "project" ? { project_id: targetId } : { workspace_id: targetId }),
      content: readBack,
      fetched_by: FETCHED_BY,
    });
  }
  return { written };
}

// ---- Round 6 Task 5 ----
// A pending version touches a demo rule either directly (rule_id is the
// demo rule -- a plain accept/readd) or, for a retire recompose (rule_id:
// null per improvements.ts's retireRule), only via rule_ids_json. Both
// executeWrites and executeVersionNow must refuse to write either shape
// (spec §5) -- the demo can never touch a real data path.
function isDemoWrite(row: { rule_id: number | null; rule_ids_json: string }): boolean {
  if (row.rule_id != null) return store.isDemoRuleId(row.rule_id);
  return parseRuleIds(row.rule_ids_json).some((id) => store.isDemoRuleId(id));
}
// ---- end Round 6 Task 5 ----

/**
 * Beat 4 — the two-beat write protocol, per pending `knowledge_versions` row:
 * read live, refuse to overwrite text the user never previewed, write, read
 * back, and let the store decide `written` vs `failed` from the read-back hash.
 */
export async function executeWrites(lovable: LovableReader & LovableWriter): Promise<{
  written: number;
  stale: number;
  failed: number;
  skipped_auto_write: number;
  skipped_demo: number;
}> {
  const counts = { written: 0, stale: 0, failed: 0, skipped_auto_write: 0, skipped_demo: 0 };

  for (const row of store.listPendingKnowledgeWrites() as PendingWrite[]) {
    // Round 6 Task 5: never write a version that touches a demo rule.
    if (isDemoWrite(row)) {
      counts.skipped_demo += 1;
      continue;
    }
    // A project with auto_write off is left entirely alone here: the write
    // stays staged (not stale, not failed) until the user turns it back on.
    // Workspace-target rows have no project_id and are never affected.
    if (
      row.target === "project" &&
      row.project_id &&
      !store.getProjectSettings(row.project_id).auto_write
    ) {
      counts.skipped_auto_write += 1;
      continue;
    }
    const targetId = row.target === "project" ? row.project_id : row.workspace_id;
    try {
      if (!targetId) throw new Error(`knowledge_version ${row.id} has no ${row.target} id`);

      const live =
        row.target === "project"
          ? await lovable.getProjectKnowledge(targetId)
          : await lovable.getWorkspaceKnowledge(targetId);

      if (sha256(live) !== row.previous_sha256) {
        store.markKnowledgeWriteStale(
          row.id,
          "Knowledge changed in Lovable since this was prepared",
        );
        counts.stale += 1;
        continue;
      }

      const { written } = await writeAndVerify(
        row.target,
        targetId,
        row.new_content,
        row.id,
        lovable,
      );
      if (written) counts.written += 1;
      else counts.failed += 1;
    } catch (err) {
      // The row may already have left `pending` (a read-back mismatch); marking
      // it failed again would throw, and this beat must never abort the run.
      try {
        store.markKnowledgeWriteFailed(row.id, errorMessage(err));
      } catch {
        /* already terminal */
      }
      counts.failed += 1;
    }
  }

  return counts;
}

// ---- Round 6 Task 2 ----

/** `WriteOutcome`'s `kind` on a not-written result: why Harness did not
 * finish writing to Lovable, in the one-word form the UI switches on
 * (`src/lib/harness-ux.ts` turns each into the plain-language reason shown
 * on the card/toast — the human-readable text itself travels in `reason`). */
export type WriteOutcomeKind =
  | "not_connected"
  | "stale"
  | "rejected"
  | "no_snapshot"
  | "error"
  // Round 6 Task 5: the version's rule is demo data (spec §5).
  | "demo";

export type WriteOutcome =
  | { written: true; at: string; version_id: number }
  | { written: false; version_id: number | null; reason: string; kind: WriteOutcomeKind };

function parseRuleIds(json: string): number[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((n): n is number => typeof n === "number") : [];
  } catch {
    return [];
  }
}

// ---- Round 6 Task 2 fix 1 ----

/** The instruction text of each rule line in a managed block (one per
 * `- <instruction>` line, in the block's own order) -- the inverse of
 * knowledge.ts's buildManagedBlock. Used to tell which rules a live block
 * actually names, for the "is this a concurrent Harness write or a human
 * edit" check below. */
/** After going back to an older Knowledge text, make each rule's status
 * match what Lovable now holds: a rule that was in Lovable and whose line is
 * gone reads "Reverted" (rolled_back); a reverted or retired rule whose line
 * is back reads active again. Only rules that were ever written are touched. */
function reconcileRulesWithKnowledge(
  target: "project" | "workspace",
  targetId: string,
  content: string,
  versionId: number,
): void {
  const block = extractManagedBlock(content) ?? "";
  for (const rule of store.writtenRulesForTarget(target, targetId)) {
    // Any wording the rule has had counts (undoing a wording change brings
    // the old one back), matched as the rule's own "- " entry in the block
    // so an instruction written over several lines still matches.
    const inKnowledge = store.ruleWordings(rule.id).some((text) => block.includes(`\n- ${text}\n`));
    const live = rule.state === "active" || rule.state === "approved" || rule.state === "supported";
    if (live && !inKnowledge) {
      store.updateRule({
        id: rule.id,
        state: "rolled_back",
        actor: "harness",
        reason: `went back to an earlier Knowledge text (version ${versionId})`,
      });
    } else if (!live && inKnowledge && (rule.state === "rolled_back" || rule.state === "retired")) {
      store.updateRule({
        id: rule.id,
        state: "active",
        actor: "harness",
        reason: `back in Knowledge after going back (version ${versionId})`,
      });
    }
  }
}

function parseManagedBlockLines(block: string): string[] {
  return block
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2));
}

/** Rule rows for a set of ids, dropping any id that no longer resolves
 * (deleted, or simply not found) -- the shared lookup both recompose
 * branches in executeVersionNow need. */
function ruleObjectsFor(ids: number[]): { id: number; instruction: string }[] {
  return ids
    .map((id) => (store.getRule(id) as { rule: { id: number; instruction: string } } | null)?.rule)
    .filter((r): r is { id: number; instruction: string } => r != null)
    .map((r) => ({ id: r.id, instruction: r.instruction }));
}

/** Signals `withTimeout` below hit its deadline -- distinguished from any
 * other rejection so callers can turn it into the one honest, generic
 * reason ("Lovable did not answer in time") rather than whatever the SDK's
 * own half-finished retry loop happened to throw. */
class TimeoutError extends Error {}

/** Races `promise` against a `ms` deadline. `promise` itself is never
 * cancelled (JS has no such thing) -- if it settles after the timeout, its
 * `.then` here still runs and quietly does nothing (the outer promise has
 * already settled), so nothing is left unhandled. Used to bound the wall-
 * clock time an inline route can spend waiting on Lovable, independent of
 * how long the MCP SDK's own per-call retry/backoff takes underneath. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err as Error);
      },
    );
  });
}

const DEFAULT_VERSION_TIMEOUT_MS = 45_000;
const DEFAULT_SYNC_TIMEOUT_MS = 5 * 60_000;
const TIMEOUT_REASON = "Lovable did not answer in time — try again";
const TOKEN_REFRESH_WAIT_MS = 15_000;
// ---- end Round 6 Task 2 fix 1 ----

/**
 * Writes one pending `knowledge_versions` row right now, from the request
 * that staged it — accept/retire/re-add/restore/change-wording, and the
 * "Try again" action on a stale/failed one (reopened first via
 * store.reopenKnowledgeVersionForRetry). Unlike `executeWrites` above, a
 * drifted base is not automatically staled: Knowledge is read fresh first,
 * and if only the user's own text (outside the Harness-managed block)
 * changed since this version was composed, the SAME rule set is recomposed
 * on that fresh base and written instead — the whole point of doing this
 * inline is that "Harness hasn't looked in a while" must not block a press
 * the user is watching. Only when the managed block ITSELF no longer
 * matches what Harness last wrote there (someone edited inside the
 * markers, on Lovable's side) does this refuse and report `stale` — that
 * text was never previewed by the user, and overwriting it would destroy
 * an edit Harness doesn't know about.
 */
export async function executeVersionNow(
  versionId: number,
  lovable: LovableReader & LovableWriter,
  opts: { timeoutMs?: number } = {},
): Promise<WriteOutcome> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_VERSION_TIMEOUT_MS;
  let row = store.getKnowledgeVersion(versionId);
  if (!row) {
    return {
      written: false,
      version_id: versionId,
      reason: `Knowledge version ${versionId} not found`,
      kind: "error",
    };
  }

  if (row.status === "written") {
    return {
      written: true,
      at: row.verified_at ?? row.written_at ?? new Date().toISOString(),
      version_id: versionId,
    };
  }

  if (row.status === "stale" || row.status === "failed") {
    row = store.reopenKnowledgeVersionForRetry(versionId);
  }

  if (row.status !== "pending") {
    return {
      written: false,
      version_id: versionId,
      reason: row.error ?? `Knowledge version ${versionId} is ${row.status}, not pending`,
      kind: "error",
    };
  }

  // Round 6 Task 5: defense in depth -- stagePendingWrite/retireRule/restore
  // should never have staged this for a demo rule, but this beat is the
  // last thing standing between any staged version and a real Lovable
  // write, so it refuses too (spec §5).
  if (isDemoWrite(row)) {
    const reason = "This rule is demo data — Harness Ledger never writes it to Lovable";
    const cancelled = store.markKnowledgeWriteCancelled(versionId, reason);
    return {
      written: false,
      version_id: versionId,
      reason: cancelled?.error ?? reason,
      kind: "demo",
    };
  }

  const targetId = row.target === "project" ? row.project_id : row.workspace_id;
  if (!targetId) {
    const failed = store.markKnowledgeWriteFailed(
      versionId,
      `knowledge_version ${versionId} has no ${row.target} id`,
    );
    return {
      written: false,
      version_id: versionId,
      reason: failed?.error ?? "missing target id",
      kind: "error",
    };
  }

  const targetIdForRun = targetId;
  const rowForRun = row;

  const run = async (): Promise<WriteOutcome> => {
    const live =
      rowForRun.target === "project"
        ? await lovable.getProjectKnowledge(targetIdForRun)
        : await lovable.getWorkspaceKnowledge(targetIdForRun);

    // A fresh read is snapshotted regardless of what happens next — it's a
    // real read of Lovable's Knowledge, same as any sync-beat snapshot.
    store.recordKnowledgeSnapshot({
      target: rowForRun.target,
      ...(rowForRun.target === "project"
        ? { project_id: targetIdForRun }
        : { workspace_id: targetIdForRun }),
      content: live,
      fetched_by: FETCHED_BY,
    });

    let newContent = rowForRun.new_content;

    // Round 7: "Undo this change" / "Go back to before this change" writes
    // exactly the text the user picked -- never a recompose of today's rules
    // (which silently turned an older go-back into a no-op). Safe only when
    // Lovable still holds what Harness last wrote there; otherwise someone
    // changed Knowledge outside Harness and that edit would be lost.
    const isGoBack = rowForRun.restored_from_version_id != null;
    if (isGoBack && sha256(live) !== rowForRun.previous_sha256) {
      const lastWritten = store.latestWrittenKnowledgeContent(rowForRun.target, targetIdForRun);
      if (lastWritten == null || sha256(live) !== sha256(lastWritten)) {
        const reason =
          "Your Knowledge changed in Lovable since Harness Ledger last wrote it — press Sync now, then try again from History";
        store.markKnowledgeWriteStale(versionId, reason);
        return { written: false, version_id: versionId, reason, kind: "stale" };
      }
    }

    if (!isGoBack && sha256(live) !== rowForRun.previous_sha256) {
      const liveBlock = extractManagedBlock(live);
      const knownBlock = extractManagedBlock(rowForRun.previous_content);
      const intendedBlock = extractManagedBlock(rowForRun.new_content);

      // Fix round 1 item 1: this version's OWN write already landed --
      // most likely an earlier attempt's write succeeded but its own
      // read-back comparison mismatched for an unrelated reason (the
      // surrounding text moved again in between, or a transient read).
      // Only meaningful when this version's write would actually have
      // CHANGED the block (`intendedBlock !== knownBlock`) and the live
      // block already shows exactly that change -- a version that never
      // touches the block at all (only the surrounding text differs, the
      // ordinary ongoing case just below) would trivially satisfy a
      // plain "live matches intended" check too, without anything having
      // ever been written. Never re-stale a write that's already there:
      // accept `live` as the verified truth and record it written,
      // without writing anything again.
      if (intendedBlock != null && intendedBlock !== knownBlock && intendedBlock === liveBlock) {
        store.updatePendingKnowledgeVersionContent(versionId, live);
        const landed = store.recordKnowledgeReadback(versionId, live);
        if (landed?.status === "written") {
          return {
            written: true,
            at: landed.verified_at ?? new Date().toISOString(),
            version_id: versionId,
          };
        }
        // Vanishingly unlikely (recordKnowledgeReadback just compared
        // `live` against the hash of that same `live`) -- fall through to
        // the ordinary drift handling below rather than assume success.
      }
      const maxActiveRules =
        rowForRun.target === "project"
          ? store.effectiveMaxActiveRules(targetIdForRun)
          : Number(store.getSetting("max_active_rules"));

      let rules: { id: number; instruction: string }[];

      // The block Harness itself last wrote to this target, verified by
      // read-back. A live block equal to it is Harness's own text even when
      // its rules have since been retired (Remove marks the rule retired
      // before the write) -- not a human edit inside the markers.
      const lastWrittenBlock = extractManagedBlock(
        store.latestWrittenKnowledgeContent(rowForRun.target, targetIdForRun) ?? "",
      );

      const activeNow = store.activeRulesForTarget(rowForRun.target, targetIdForRun) as {
        id: number;
        instruction: string;
      }[];
      const isActiveNow = (id: number) => activeNow.some((r) => r.id === id);

      // Checkpoint 2026-09-18: blocks are compared by their bullet lines, so
      // a block Harness Ledger wrote under an earlier heading is still its
      // own after the heading changed (knowledge.ts LEGACY_HEADINGS).
      const sameBlock = (a: string | null, b: string | null) =>
        a != null && b != null && normalizeBlockForCompare(a) === normalizeBlockForCompare(b);
      if (knownBlock === liveBlock || sameBlock(knownBlock, liveBlock)) {
        // Only the user's own text outside the block changed -- recompose
        // the exact same rule set this version already carries.
        rules = ruleObjectsFor(parseRuleIds(rowForRun.rule_ids_json));
      } else if (liveBlock != null && sameBlock(liveBlock, lastWrittenBlock)) {
        // Harness's own newer write is live (e.g. Remove right after Add, or
        // "Try again" on an older failed version). Merge, like the concurrent
        // write case below: this version's rules plus the live block's rules,
        // limited to rules still active -- so a newer rule is never dropped
        // and a rule retired since (Remove marks it retired before writing)
        // is never put back.
        const liveIds = parseManagedBlockLines(liveBlock)
          .map((line) => activeNow.find((r) => r.instruction === line)?.id)
          .filter((id): id is number => id != null);
        rules = ruleObjectsFor(
          Array.from(new Set([...parseRuleIds(rowForRun.rule_ids_json), ...liveIds])).filter(
            isActiveNow,
          ),
        );
      } else {
        // Fix round 1 item 2: the managed block itself drifted. Tell a
        // concurrent Harness write (another pass composed a different, but
        // recognized, active-rule set in between) apart from a human edit
        // inside the markers: only when every live rule line is one of
        // Harness's own current active rules for this target is it safe to
        // reconcile automatically, by recomposing on the union of this
        // version's own rule set and whatever is live now. A single
        // unrecognized line means someone edited inside the markers on
        // Lovable's side -- that text was never previewed and must not be
        // silently overwritten.
        const activeRules = store.activeRulesForTarget(rowForRun.target, targetIdForRun) as {
          id: number;
          instruction: string;
        }[];
        const liveLines = liveBlock != null ? parseManagedBlockLines(liveBlock) : null;
        const allLinesKnown =
          liveLines != null &&
          liveLines.every((line) => activeRules.some((r) => r.instruction === line));

        if (!allLinesKnown) {
          const reason =
            "Someone edited the Harness Ledger block in Lovable — re-check the preview";
          store.markKnowledgeWriteStale(versionId, reason);
          return { written: false, version_id: versionId, reason, kind: "stale" };
        }

        const liveRuleIds = liveLines!
          .map((line) => activeRules.find((r) => r.instruction === line)?.id)
          .filter((id): id is number => id != null);
        const unionIds = Array.from(
          new Set([...parseRuleIds(rowForRun.rule_ids_json), ...liveRuleIds]),
        ).filter(isActiveNow);
        rules = ruleObjectsFor(unionIds);
      }

      const composed = composeManagedKnowledge(live, rules, maxActiveRules);
      if (composed.over_cap || composed.over_rules) {
        const reason = composed.over_cap
          ? "This would exceed the Knowledge limit — shorten the instruction or your existing Knowledge first"
          : `This project already has ${composed.active_rules_count} active rules — retire one on the Instructions page first`;
        store.markKnowledgeWriteFailed(versionId, reason);
        return { written: false, version_id: versionId, reason, kind: "rejected" };
      }

      newContent = composed.final_content;
      store.updatePendingKnowledgeVersionContent(versionId, newContent);
    }

    const { written } = await writeAndVerify(
      rowForRun.target,
      targetIdForRun,
      newContent,
      versionId,
      lovable,
    );
    const after = store.getKnowledgeVersion(versionId);
    if (written && isGoBack) {
      reconcileRulesWithKnowledge(rowForRun.target, targetIdForRun, newContent, versionId);
    }
    if (written) {
      return {
        written: true,
        at: after?.verified_at ?? new Date().toISOString(),
        version_id: versionId,
      };
    }
    return {
      written: false,
      version_id: versionId,
      reason: after?.error ?? "Lovable's copy didn't match what Harness Ledger wrote",
      kind: "rejected",
    };
  };

  try {
    return await withTimeout(run(), timeoutMs, TIMEOUT_REASON);
  } catch (err) {
    const reason = err instanceof TimeoutError ? err.message : errorMessage(err);
    try {
      store.markKnowledgeWriteFailed(versionId, reason);
    } catch {
      /* already terminal */
    }
    return { written: false, version_id: versionId, reason, kind: "error" };
  }
}

/**
 * "Sync now" run inline, from the request itself: refuses (without opening
 * a client) when Harness is not connected or a sync is already running,
 * else opens its own Lovable client, runs the full pass (`runAll`, kind
 * "manual"), and always closes the client again.
 *
 * `openClient` is overridable only for tests (`runAll` itself needs no
 * override -- it takes the opened client directly); production callers
 * always get the real `openLovableClient`.
 *
 * Fix round 1 items 3 and 4: the early `runningSyncRun()` check below is a
 * fast path only (avoids opening a client for the common case) -- the
 * actual single-run guarantee is `runAll`'s own atomic
 * `store.tryStartSyncRun`, which is what actually closes the await-gap
 * race between this request and the in-app scheduler's own tick. A wall-
 * clock `timeoutMs` (default 5 minutes) bounds the whole pass so a stuck
 * Lovable call can't hold the request open indefinitely.
 */
export async function syncNow(
  openClient: () => Promise<LovableClient> = openLovableClient,
  opts: { timeoutMs?: number } = {},
): Promise<{
  ok: boolean;
  counts: Record<string, number>;
  error?: string;
}> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS;
  const running = store.runningSyncRun();
  if (running) {
    return {
      ok: false,
      counts: {},
      error: `A sync is already running (run ${running.id}, started ${running.started_at}).`,
    };
  }
  if (!status().connected) {
    return {
      ok: false,
      counts: {},
      error: "Harness Ledger is not connected — connect on the Projects page.",
    };
  }

  let client: LovableClient;
  try {
    client = await openClient();
  } catch (err) {
    return { ok: false, counts: {}, error: errorMessage(err) };
  }
  try {
    const result = await withTimeout(runAll(client, "manual"), timeoutMs, TIMEOUT_REASON);
    if (!result.ran) {
      return { ok: false, counts: {}, error: result.error ?? "A sync is already running." };
    }
    return {
      ok: result.ok,
      counts: result.counts,
      ...(result.error ? { error: result.error } : {}),
    };
  } catch (err) {
    const reason = err instanceof TimeoutError ? err.message : errorMessage(err);
    return { ok: false, counts: {}, error: reason };
  } finally {
    await client.close().catch(() => {});
  }
}
// ---- end Round 6 Task 2 ----

/**
 * One full pass: takes any open "Sync now" requests, runs every beat in order,
 * and always finishes the `sync_runs` row. A beat that throws stops the pass
 * and is recorded as the run's error — it never escapes to the caller.
 *
 * Fix round 1 item 3: starting the run is one atomic DB transaction
 * (`store.tryStartSyncRun`), not the previous plain `startSyncRun` insert
 * -- two concurrent callers (a request-driven `syncNow()` and the in-app
 * scheduler's own tick both racing an `await` gap before either had
 * inserted a row) could otherwise both see "nothing running" and both
 * start a pass. `ran: false` (with `runId: null`) means this call was
 * refused because another run already holds the field; callers must not
 * treat that as a failure of their own -- see `error` for who holds it.
 */
export async function runAll(
  lovable: LovableClient,
  kind: "scheduled" | "manual" | "once",
): Promise<{
  runId: number | null;
  ok: boolean;
  ran: boolean;
  counts: Record<string, number>;
  error?: string;
}> {
  const runId = store.tryStartSyncRun(kind);
  if (runId == null) {
    const running = store.runningSyncRun();
    const error = running
      ? `A sync is already running (run ${running.id}, started ${running.started_at}).`
      : "A sync is already running.";
    return { runId: null, ok: true, ran: false, counts: {}, error };
  }
  const requestIds: number[] = [];
  for (;;) {
    const id = store.takeSyncRequest(runId);
    if (id === null) break;
    requestIds.push(id);
  }

  const counts: Record<string, number> = {};
  let ok = true;
  let error: string | undefined;

  try {
    const history = await syncHistory(lovable);
    counts.messages = history.messages;
    counts.projects = history.projects;
    counts.truncated = history.truncated;
    store.insertEvent("executor.sync.history", null, history);

    const workspaceId = (await resolveWorkspaceId(lovable)) ?? "";

    const knowledge = await snapshotKnowledge(lovable, workspaceId);
    counts.knowledge_snapshots = knowledge.snapshots;
    store.insertEvent("executor.sync.knowledge", null, knowledge);

    const skills = await snapshotSkills(lovable, workspaceId);
    counts.skills = skills.skills;
    counts.skills_changed = skills.changed;
    store.insertEvent("executor.sync.skills", null, skills);

    // Anything the user accepted before Harness had ever read the live
    // Knowledge could not be composed at accept time; now that the snapshots
    // above exist, stage those writes so this same pass can apply them.
    const stage = stageApprovedWrites();
    counts.staged = stage.staged;
    if (stage.staged > 0) store.insertEvent("executor.stage.staged", null, stage);

    const writes = await executeWrites(lovable);
    counts.written = writes.written;
    counts.stale = writes.stale;
    counts.failed = writes.failed;
    counts.skipped_auto_write = writes.skipped_auto_write;
    counts.skipped_demo = writes.skipped_demo;
    store.insertEvent("executor.sync.writes", null, writes);

    // Round 4 Task C1 / spec §4b: outcome tracking, recomputed after every
    // run so "Since added" and retirement suggestions stay current without
    // needing their own schedule. Isolated in its own try/catch: a bug here
    // must never fail an otherwise-successful sync (history/knowledge/write
    // beats already ran and should still be recorded as ok).
    try {
      const health = recomputeRuleHealth();
      counts.health_suggested = health.suggested;
      store.insertEvent("executor.sync.health", null, health);

      // Task C2: turn any freshly-suggested retirement into a proposal the
      // Inbox can show. Idempotent -- a rule with an open proposal already
      // is skipped -- and deliberately inside the same try/catch as the
      // recompute it depends on.
      const retirement = proposeRetirements();
      counts.retire_proposed = retirement.created;
      if (retirement.created > 0) {
        store.insertEvent("executor.sync.retire_proposed", null, retirement);
      }
    } catch (healthErr) {
      counts.health_error = 1;
      store.insertEvent("executor.sync.health_error", null, { error: errorMessage(healthErr) });
    }
  } catch (err) {
    ok = false;
    error = errorMessage(err);
    store.insertEvent("executor.sync.error", null, { error });
  }

  store.finishSyncRun(runId, { ok, error: error ?? null, counts });
  for (const id of requestIds) store.completeSyncRequest(id);

  // Round 6 Task 6b: resumes a `queued` paired-test run that was still
  // waiting when the process last died (a `test` action's own kick fired,
  // but the process exited before runExperiment got to it) -- fire-and-
  // forget, same as the `test` action's own call; a crash here must never
  // fail an otherwise-successful sync.
  try {
    void kickExperimentRunner();
  } catch (err) {
    store.insertEvent("executor.sync.kick_experiment_error", null, { error: errorMessage(err) });
  }

  // ---- Checkpoint 2026-09-18 WP5: automatic analysis after sync (D7) ----
  // Default off. Only a SUCCESSFUL sync ever queues an analysis request,
  // and only via the existing coalescing store.requestAnalysis() -- this
  // never calls an LLM itself; the scheduler's own analysis path (already
  // gated on an open request, see executor/schedule.ts's maybeRunAnalysis)
  // does the real work later, exactly as if a person had pressed
  // "Analyse now". Isolated in its own try/catch, same convention as the
  // health recompute and kickExperimentRunner above: a bug here must never
  // flip an otherwise-successful sync to ok:false.
  if (ok && getAutomaticAnalysisSetting()) {
    try {
      store.requestAnalysis();
    } catch (err) {
      store.insertEvent("executor.sync.automatic_analysis_error", null, {
        error: errorMessage(err),
      });
    }
  }
  // ---- end Checkpoint 2026-09-18 WP5 ----

  return { runId, ok, ran: true, counts, ...(error ? { error } : {}) };
}

// ---- Round 6 Task 2 (continued): improvementActionAndWrite ----
// Wires the free actions to Lovable immediately (spec §2): "the owner
// pressed Add to this project several times and nothing reached Lovable,
// because Knowledge writes only ran inside a separate executor process
// that had never been started." improvements.ts's improvementAction still
// does exactly what it always did -- stage the right pending version, or
// nothing when there's no snapshot to compose against yet -- but it must
// never import anything Lovable-related itself (see its own "no Lovable
// import" test), so the actual write happens here, the one place this
// beat's write protocol already lives.
//
// Write-eligible: accept (unless test_first), retire, readd, restore, and
// change_wording of a rule that was already written (see
// prepareWordingChangeRewrite's own doc comment in improvements.ts).
// A decision the user just pressed writes even when the project's
// auto_write is off -- that flag only ever governs AUTOMATIC decisions
// (executeWrites' own auto_write check above, run from the periodic
// pass); pressing a button here IS the approval.

const NOT_CONNECTED_REASON = "Harness Ledger is not connected — connect on the Projects page.";

function notConnectedOutcome(versionId: number | null): WriteOutcome {
  return {
    written: false,
    version_id: versionId,
    reason: NOT_CONNECTED_REASON,
    kind: "not_connected",
  };
}

/** Opens (and always closes) its own Lovable client to run one version now
 * -- the shared open/execute/close shape `improvementActionAndWrite` and
 * `retryKnowledgeWrite` both need. */
async function runVersionNow(versionId: number): Promise<WriteOutcome> {
  if (!status().connected) return notConnectedOutcome(versionId);
  // Refresh a token that is about to expire before the fresh read, the way
  // the paired test already does -- bounded, so a stalled connect can never
  // hold up the write (the write's own 45 s limit starts after this).
  await Promise.race([
    ensureFreshLovableToken(),
    new Promise<void>((resolve) => setTimeout(resolve, TOKEN_REFRESH_WAIT_MS).unref?.()),
  ]);
  const client = await openLovableClient();
  try {
    return await executeVersionNow(versionId, client);
  } finally {
    await client.close().catch(() => {});
  }
}

/** "Try again" (a not-written outcome's own action on the card): re-runs
 * executeVersionNow on the exact version that didn't write, reopening a
 * stale/failed one first (executeVersionNow itself does the reopen -- see
 * its own doc comment). Addressed by version id alone -- there is no new
 * decision here, only another attempt at writing the one already made. */
export async function retryKnowledgeWrite(versionId: number): Promise<WriteOutcome> {
  return runVersionNow(versionId);
}

/** The id of the newest `knowledge_versions` row that is pending right now
 * but was not already pending in `beforeIds` -- i.e. whatever
 * `improvementAction` (already run by the time this is called) staged.
 * Diffing a before/after snapshot, rather than assuming which internal
 * function did the staging, works uniformly across every action's own
 * staging path (stagePendingWrite, retireRule's direct
 * createPendingKnowledgeVersion with a null rule_id, createRestoreVersion). */
function newlyStagedVersionId(beforeIds: Set<number>): number | null {
  let newest: number | null = null;
  for (const p of store.listPendingKnowledgeWrites() as { id: number }[]) {
    if (beforeIds.has(p.id)) continue;
    if (newest === null || p.id > newest) newest = p.id;
  }
  return newest;
}

export async function improvementActionAndWrite(
  input: unknown,
  actor?: string,
): Promise<Improvement & { write?: WriteOutcome }> {
  // Round 6 Task 6b / spec §6: "test" is a pass-through to
  // executor/experiments.ts's startExperiment -- no Knowledge write, so no
  // `write` field on the result (matching every other non-write-eligible
  // action's own response shape). Checked before peekActionKind, which
  // doesn't recognize "test" at all (see improvements.ts's own comment on
  // why it's deliberately absent from that schema).
  if (isTestAction(input)) {
    return testAction(input);
  }
  if (isDeleteCopyAction(input)) {
    return deleteCopyAction(input);
  }
  // Checkpoint 3 S1: publish_skill_proposal is a Lovable create, never a
  // Knowledge write -- no `write` field on the result, same as "test" above,
  // and never reached from the automatic sync loop (see
  // skill-publish-action.ts's own header comment).
  if (isPublishSkillProposalAction(input)) {
    return publishSkillProposalAction(input, actor);
  }

  const { kind, testFirst } = peekActionKind(input);
  const writeEligible =
    (kind === "accept" && !testFirst) ||
    kind === "retire" ||
    kind === "readd" ||
    kind === "restore" ||
    kind === "change_wording";

  if (!writeEligible) return improvementAction(input, actor);

  // Must run BEFORE improvementAction (it reads the rule's current
  // write_status, which improvementAction is about to change) -- see its
  // own doc comment in improvements.ts.
  const applyWordingRewrite = prepareWordingChangeRewrite(input);
  const beforePendingIds = new Set(
    (store.listPendingKnowledgeWrites() as { id: number }[]).map((p) => p.id),
  );

  const result = improvementAction(input, actor);
  applyWordingRewrite();

  const stagedId = newlyStagedVersionId(beforePendingIds);

  if (kind === "change_wording" && stagedId == null) {
    // Nothing was live to rewrite, and nothing new was staged (change_wording
    // never stages on its own for a rule that hasn't been written yet) --
    // there is genuinely no write to report.
    return result;
  }

  if (!status().connected) {
    return { ...result, write: notConnectedOutcome(stagedId) };
  }

  if (stagedId == null) {
    // Round 6 Task 5 fix round 1 (B1): a demo rule's retire/re-add/restore
    // (and accept, in principle) is accepted but stages nothing at all
    // (stagePendingWrite's/retireRule's own created_by = 'demo' guard) --
    // that is not "no snapshot yet", and must not be reported as if a Sync
    // now would fix it.
    if (result.rule_id != null && store.isDemoRuleId(result.rule_id)) {
      return {
        ...result,
        write: {
          written: false,
          version_id: null,
          reason: "Demo data is never written to Lovable.",
          kind: "demo",
        },
      };
    }
    return {
      ...result,
      write: {
        written: false,
        version_id: null,
        reason:
          "Harness Ledger hasn't read this project's Knowledge from Lovable yet — run Sync now first.",
        kind: "no_snapshot",
      },
    };
  }

  const write = await runVersionNow(stagedId);
  const refreshed = getImprovement(result.id) ?? result;
  return { ...refreshed, write };
}
// ---- end Round 6 Task 2 (continued) ----
