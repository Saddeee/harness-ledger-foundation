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
import { composeManagedKnowledge, extractManagedBlock, sha256 } from "../knowledge.js";
import { redact } from "./redact.js";
import { recomputeRuleHealth } from "../analysis/health.js";
import { proposeRetirements } from "../analysis/retire.js";
import { status } from "./lovable-auth.js";
import { openLovableClient } from "./lovable-mcp.js";
import type { LovableClient, LovableReader, LovableWriter } from "./lovable-mcp.js";

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

  for (const projectId of projects) {
    if (workspaceId && !store.getProjectMeta(projectId)?.workspace_id) {
      store.upsertProject({ lovable_project_id: projectId, workspace_id: workspaceId });
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
  const skills = await lovable.listWorkspaceSkills(workspaceId);
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
  return { skills: skills.length, changed };
}

type PendingWrite = {
  id: number;
  target: "project" | "workspace";
  project_id: string | null;
  workspace_id: string | null;
  previous_sha256: string;
  new_content: string;
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
  return { written: after?.status === "written" };
}

/**
 * Beat 4 — the two-beat write protocol, per pending `knowledge_versions` row:
 * read live, refuse to overwrite text the user never previewed, write, read
 * back, and let the store decide `written` vs `failed` from the read-back hash.
 */
export async function executeWrites(
  lovable: LovableReader & LovableWriter,
): Promise<{ written: number; stale: number; failed: number; skipped_auto_write: number }> {
  const counts = { written: 0, stale: 0, failed: 0, skipped_auto_write: 0 };

  for (const row of store.listPendingKnowledgeWrites() as PendingWrite[]) {
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
export type WriteOutcomeKind = "not_connected" | "stale" | "rejected" | "no_snapshot" | "error";

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
): Promise<WriteOutcome> {
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

  try {
    const live =
      row.target === "project"
        ? await lovable.getProjectKnowledge(targetId)
        : await lovable.getWorkspaceKnowledge(targetId);

    // A fresh read is snapshotted regardless of what happens next — it's a
    // real read of Lovable's Knowledge, same as any sync-beat snapshot.
    store.recordKnowledgeSnapshot({
      target: row.target,
      ...(row.target === "project" ? { project_id: targetId } : { workspace_id: targetId }),
      content: live,
      fetched_by: FETCHED_BY,
    });

    let newContent = row.new_content;

    if (sha256(live) !== row.previous_sha256) {
      const knownBlock = extractManagedBlock(row.previous_content);
      const liveBlock = extractManagedBlock(live);
      if (knownBlock !== liveBlock) {
        const reason = "Knowledge changed in Lovable since Harness read it — re-check the preview";
        store.markKnowledgeWriteStale(versionId, reason);
        return { written: false, version_id: versionId, reason, kind: "stale" };
      }

      const ruleIds = parseRuleIds(row.rule_ids_json);
      const rules = ruleIds
        .map(
          (id) => (store.getRule(id) as { rule: { id: number; instruction: string } } | null)?.rule,
        )
        .filter((r): r is { id: number; instruction: string } => r != null)
        .map((r) => ({ id: r.id, instruction: r.instruction }));
      const maxActiveRules =
        row.target === "project"
          ? store.effectiveMaxActiveRules(targetId)
          : Number(store.getSetting("max_active_rules"));

      newContent = composeManagedKnowledge(live, rules, maxActiveRules).final_content;
      store.updatePendingKnowledgeVersionContent(versionId, newContent);
    }

    const { written } = await writeAndVerify(row.target, targetId, newContent, versionId, lovable);
    const after = store.getKnowledgeVersion(versionId);
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
      reason: after?.error ?? "Lovable's copy didn't match what Harness wrote",
      kind: "rejected",
    };
  } catch (err) {
    try {
      store.markKnowledgeWriteFailed(versionId, errorMessage(err));
    } catch {
      /* already terminal */
    }
    return { written: false, version_id: versionId, reason: errorMessage(err), kind: "error" };
  }
}

/**
 * "Sync now" run inline, from the request itself: refuses (without opening
 * a client) when Harness is not connected or a sync is already running,
 * else opens its own Lovable client, runs the full pass (`runAll`, kind
 * "manual"), and always closes the client again.
 */
export async function syncNow(): Promise<{
  ok: boolean;
  counts: Record<string, number>;
  error?: string;
}> {
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
      error: "Harness is not connected — connect on the Projects page.",
    };
  }

  let client: LovableClient;
  try {
    client = await openLovableClient();
  } catch (err) {
    return { ok: false, counts: {}, error: errorMessage(err) };
  }
  try {
    const result = await runAll(client, "manual");
    return {
      ok: result.ok,
      counts: result.counts,
      ...(result.error ? { error: result.error } : {}),
    };
  } finally {
    await client.close().catch(() => {});
  }
}
// ---- end Round 6 Task 2 ----

/**
 * One full pass: takes any open "Sync now" requests, runs every beat in order,
 * and always finishes the `sync_runs` row. A beat that throws stops the pass
 * and is recorded as the run's error — it never escapes to the caller.
 */
export async function runAll(
  lovable: LovableClient,
  kind: "scheduled" | "manual" | "once",
): Promise<{ runId: number; ok: boolean; counts: Record<string, number>; error?: string }> {
  const runId = store.startSyncRun(kind);
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

  return { runId, ok, counts, ...(error ? { error } : {}) };
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

const NOT_CONNECTED_REASON = "Harness is not connected — connect on the Projects page.";

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
    return {
      ...result,
      write: {
        written: false,
        version_id: null,
        reason:
          "Harness hasn't read this project's Knowledge from Lovable yet — run Sync now first.",
        kind: "no_snapshot",
      },
    };
  }

  const write = await runVersionNow(stagedId);
  const refreshed = getImprovement(result.id) ?? result;
  return { ...refreshed, write };
}
// ---- end Round 6 Task 2 (continued) ----
