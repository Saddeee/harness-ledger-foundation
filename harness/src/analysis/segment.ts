// Round 4 Task A1: segment classified user messages into task episodes
// (step (b) of the analysis pipeline -- see round-4.md Task A1 and
// explorations/analysis-pipeline.md §2(a)+(b)). Deterministic, no LLM call:
// classification alone decides episode boundaries.
//
// Walking classified user messages in occurred_at/id order, per project:
// - `new_task` starts a new episode (createTaskEpisode, provenance
//   "llm_derived", title/summary = the classifier's summary), with the
//   message itself as evidence role "request".
// - `correction` attaches as evidence role "correction" to the currently
//   open episode and pushes its ended_at forward to this message's time.
// - `question` / `approval` / `other` attach as evidence role "other" only
//   while an episode is open; with no open episode they are ignored (no
//   synthetic episode is created for them in this task).
// - A message already linked to an episode (store.episodeForHistoryItem) is
//   skipped for creation/attachment purposes, but its episode still becomes
//   the "open" one going forward, so a re-run that only adds newly
//   classified messages after previously segmented ones attaches correctly
//   instead of spuriously starting a new episode on the next non-new_task
//   message.
import * as store from "../store.js";

type EvidenceRole = "request" | "correction" | "other";

/**
 * Segments one project's classified user messages into task episodes.
 * Idempotent: a message already linked to an episode is never re-attached
 * or double-counted, so running this again with no new classifications
 * reports `{ created: 0, attached: 0 }`.
 */
export function segmentEpisodes(projectId: string): { created: number; attached: number } {
  const messages = store.listClassifiedUserMessages(projectId);
  let created = 0;
  let attached = 0;
  let openEpisodeId: number | null = null;

  for (const message of messages) {
    const existingEpisodeId = store.episodeForHistoryItem(message.history_item_id);
    if (existingEpisodeId !== null) {
      openEpisodeId = existingEpisodeId;
      continue;
    }

    if (message.classification === "new_task") {
      const episode = store.createTaskEpisode({
        project_id: projectId,
        title: message.summary || "(untitled task)",
        summary: message.summary || undefined,
        provenance: "llm_derived",
        started_at: message.occurred_at ?? undefined,
      }) as { id: number };
      store.addEpisodeEvidence(
        episode.id,
        message.history_item_id,
        "request" satisfies EvidenceRole,
      );
      openEpisodeId = episode.id;
      created++;
      continue;
    }

    if (openEpisodeId === null) {
      // question/approval/other with no open episode: ignored per spec --
      // no synthetic "continued from before Harness started reading"
      // episode in this task.
      continue;
    }

    if (message.classification === "correction") {
      store.addEpisodeEvidence(
        openEpisodeId,
        message.history_item_id,
        "correction" satisfies EvidenceRole,
      );
      store.updateTaskEpisode({ id: openEpisodeId, ended_at: message.occurred_at ?? undefined });
    } else {
      store.addEpisodeEvidence(
        openEpisodeId,
        message.history_item_id,
        "other" satisfies EvidenceRole,
      );
    }
    attached++;
  }

  return { created, attached };
}

/** Runs segmentEpisodes over every allowed project, summing the counts. */
export function segmentAllProjects(): { created: number; attached: number } {
  const projects = store.getAllowedProjects() as { lovable_project_id: string }[];
  let created = 0;
  let attached = 0;
  for (const project of projects) {
    const result = segmentEpisodes(project.lovable_project_id);
    created += result.created;
    attached += result.attached;
  }
  return { created, attached };
}
