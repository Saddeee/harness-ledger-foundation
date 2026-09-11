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
import { stageApprovedWrites } from "../improvements.js";
import { sha256 } from "../knowledge.js";
import { redact } from "./redact.js";
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

      if (row.target === "project") {
        await lovable.setProjectKnowledge(targetId, row.new_content);
      } else {
        await lovable.setWorkspaceKnowledge(targetId, row.new_content);
      }

      const readBack =
        row.target === "project"
          ? await lovable.getProjectKnowledge(targetId)
          : await lovable.getWorkspaceKnowledge(targetId);

      const after = store.recordKnowledgeReadback(row.id, readBack);
      if (after?.status === "written") counts.written += 1;
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
  } catch (err) {
    ok = false;
    error = errorMessage(err);
    store.insertEvent("executor.sync.error", null, { error });
  }

  store.finishSyncRun(runId, { ok, error: error ?? null, counts });
  for (const id of requestIds) store.completeSyncRequest(id);

  return { runId, ok, counts, ...(error ? { error } : {}) };
}
