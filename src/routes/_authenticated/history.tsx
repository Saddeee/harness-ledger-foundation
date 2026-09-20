// The History page (Round 5 Task 4 / spec §3b): the owner's "git graph" --
// one vertical timeline per project/workspace target, newest first, of
// every Knowledge write Harness made, every change Lovable saw that Harness
// didn't make, every accept/skip/retire/keep/re-add decision, every Skill
// change, and every rule verdict. The Instructions page's old per-version
// "What changed" list lives here now; Instructions shows only what is
// current. Checkpoint 2 2-C: the selected target's own current Knowledge
// text now has its own "Current Knowledge" box at the top of this page,
// visually separate from the timeline below it (Instructions already shows
// the same text per target; this is the same fact, read here for "what is
// true right now, before I read how it got here"). Only talks to the local
// Harness routes (fetchKnowledge for the target list and its current text,
// fetchTimeline for the selected target's nodes, postKnowledge for "Undo
// this change" / "Go back to before this change").
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ManagedBlockText, Timeline } from "@/components/harness/timeline";
import { ProjectFilter } from "@/components/harness/project-filter";
import {
  formatDate,
  HISTORY_FILTER_LABELS,
  HISTORY_FILTER_ORDER,
  historyNodeMatchesFilter,
  isTestCopyProject,
  type HistoryFilterValue,
} from "@/lib/harness-ux";
import {
  executorQueryOptions,
  fetchKnowledge,
  fetchTimeline,
  postKnowledge,
  toastWriteOutcome,
  type TimelineNode,
} from "@/lib/improvements-client";

type HistorySearch = {
  target?: "project" | "workspace";
  id?: string;
  filter?: HistoryFilterValue;
};

function isHistoryFilterValue(v: unknown): v is HistoryFilterValue {
  return typeof v === "string" && (HISTORY_FILTER_ORDER as string[]).includes(v);
}

export const Route = createFileRoute("/_authenticated/history")({
  validateSearch: (search: Record<string, unknown>): HistorySearch => {
    const rawTarget = search["target"];
    const target = rawTarget === "project" || rawTarget === "workspace" ? rawTarget : undefined;
    const rawId = search["id"];
    const id = typeof rawId === "string" && rawId ? rawId : undefined;
    // Checkpoint 3 I2: the filter is independent of target/id -- a bare
    // ?filter=suggestions (the Inbox's own "View past decisions" link) is
    // valid with no target selected yet (the default target still applies).
    const rawFilter = search["filter"];
    const filter = isHistoryFilterValue(rawFilter) ? rawFilter : undefined;
    return { ...(target && id ? { target, id } : {}), ...(filter ? { filter } : {}) };
  },
  head: () => ({
    meta: [
      { title: "History — Harness Ledger" },
      {
        name: "description",
        content: "Everything Harness Ledger has done to your Lovable Knowledge, per project.",
      },
      { property: "og:title", content: "History — Harness Ledger" },
      {
        property: "og:description",
        content: "Everything Harness Ledger has done to your Lovable Knowledge, per project.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Page,
});

const DEMO_REMOVE_COMMAND = "npm run harness:demo -- --remove";

// ---- Checkpoint 3 UX fix 3: "Current Knowledge" collapses by default ----
// The owner reported this box always taking up space above the timeline
// even though it's rarely what they came to History to read. Persisted per
// browser only (localStorage), never sent anywhere; try/catch around every
// access so a private window or blocked storage never breaks the page.
const CURRENT_KNOWLEDGE_OPEN_KEY = "harness-history-current-knowledge-open";

function readCurrentKnowledgeOpen(): boolean {
  try {
    return window.localStorage.getItem(CURRENT_KNOWLEDGE_OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

function writeCurrentKnowledgeOpen(open: boolean): void {
  try {
    if (open) window.localStorage.setItem(CURRENT_KNOWLEDGE_OPEN_KEY, "1");
    else window.localStorage.removeItem(CURRENT_KNOWLEDGE_OPEN_KEY);
  } catch {
    // per-browser convenience only -- never block on storage failing
  }
}

// Same managed-block markers as timeline.tsx's own (unexported) constants --
// duplicated locally rather than imported, the same convention timeline.tsx
// already uses for its own copy of these two strings.
const CURRENT_KNOWLEDGE_HARNESS_START = "<!-- harness:start -->";
const CURRENT_KNOWLEDGE_HARNESS_END = "<!-- harness:end -->";

/** How many rules the managed block's own bullet lines carry, or null when
 * there's no managed block to count (cheap, client-side, no new read). */
function countManagedRules(content: string, managedBlockPresent: boolean): number | null {
  if (!managedBlockPresent) return null;
  const start = content.indexOf(CURRENT_KNOWLEDGE_HARNESS_START);
  const end = content.indexOf(CURRENT_KNOWLEDGE_HARNESS_END);
  if (start === -1 || end === -1 || end < start) return null;
  const managed = content.slice(start + CURRENT_KNOWLEDGE_HARNESS_START.length, end);
  return managed.split("\n").filter((line) => /^\s*-\s+/.test(line)).length;
}

/** The collapsed summary's own one-line hint: target name, character count,
 * and "N rules" when that's cheap to know (omitted otherwise). */
function currentKnowledgeHint(
  targetName: string,
  content: string,
  managedBlockPresent: boolean,
): string {
  const parts = [targetName, `${content.length.toLocaleString()} characters`];
  const rules = countManagedRules(content, managedBlockPresent);
  if (rules != null) parts.push(rules === 1 ? "1 rule" : `${rules} rules`);
  return parts.join(" · ");
}
// ---- end Checkpoint 3 UX fix 3 ----
// Checkpoint 3 I2: skipped suggestions are inspectable right here now --
// every decision (including a skip) is its own "decision" timeline node,
// filterable under Suggestions -- so this no longer points at a separate
// Suggestions page.
const EMPTY_LINE =
  "Nothing has happened here yet. Rules you add, changes Harness Ledger writes, and your decisions about those rules will show up here.";
const EMPTY_FILTERED_LINE = "Nothing matches this filter yet.";

function Page() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const search = Route.useSearch();
  const filter: HistoryFilterValue = search.filter ?? "all";
  // Checkpoint 3 UX fix 3: closed unless this browser remembers it open.
  const [knowledgeOpen, setKnowledgeOpen] = useState<boolean>(readCurrentKnowledgeOpen);

  const knowledge = useQuery({ queryKey: ["harness-knowledge"], queryFn: fetchKnowledge });
  const executor = useQuery(executorQueryOptions);

  // Derived before the loading/error returns below so every hook here is
  // called on every render, never skipped -- selected is undefined while
  // knowledge is still loading, which just keeps the timeline query disabled.
  const targets = knowledge.data?.targets ?? [];
  const defaultTarget = targets.find((t) => t.target === "project") ?? targets[0];
  const selected =
    search.target && search.id
      ? (targets.find((t) => t.target === search.target && t.id === search.id) ?? defaultTarget)
      : defaultTarget;

  const target = selected?.target;
  const id = selected?.id;
  // Round 9 Task 2: ProjectFilter's own "All projects" chip -- no explicit
  // ?target=/?id= means every allowed project's timeline, merged. Test-copy
  // projects (isTestCopyProject) are never fetched for this -- they are
  // never real projects to show history for.
  const isAllProjects = !(search.target && search.id);
  const projectTargets = targets.filter(
    (t) => t.target === "project" && !isTestCopyProject(t.name),
  );
  const workspaceTarget = targets.find((t) => t.target === "workspace");

  const timeline = useQuery({
    queryKey: ["harness-timeline", target, id],
    queryFn: () => fetchTimeline(target!, id!),
    enabled: !isAllProjects && !!target && !!id,
  });
  const allProjectTimelines = useQueries({
    queries: isAllProjects
      ? projectTargets.map((t) => ({
          queryKey: ["harness-timeline", "project", t.id],
          queryFn: () => fetchTimeline("project", t.id),
        }))
      : [],
  });
  const allProjectsLoading = isAllProjects && allProjectTimelines.some((q) => q.isLoading);
  const allProjectsError = isAllProjects
    ? allProjectTimelines.find((q) => q.isError)?.error
    : undefined;
  const allProjectsNodes: TimelineNode[] = isAllProjects
    ? allProjectTimelines
        .flatMap((q) => q.data?.nodes ?? [])
        .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    : [];
  const rawNodes = isAllProjects ? allProjectsNodes : (timeline.data?.nodes ?? []);
  const timelineIsLoading = isAllProjects ? allProjectsLoading : timeline.isLoading;
  const timelineIsError = isAllProjects ? allProjectsError != null : timeline.isError;
  const timelineErrorValue = isAllProjects ? allProjectsError : timeline.error;

  const restore = useMutation({
    mutationFn: (versionId: number) => postKnowledge({ action: "restore", version_id: versionId }),
    onSuccess: (data) => {
      // Round 6 Task 2 / spec §2: restore writes immediately when Harness
      // is connected -- the toast reads the real outcome.
      toastWriteOutcome(data.write, "Change undone.");
      void qc.invalidateQueries({ queryKey: ["harness-knowledge"] });
      void qc.invalidateQueries({ queryKey: ["harness-timeline"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Restore failed"),
  });

  // Checkpoint 3 I2: the selected filter, applied client-side to the
  // already-fetched timeline -- no new route or query (harness-ux.ts's
  // historyNodeMatchesFilter is the one place a node's kind is compared
  // against a filter value).
  const filteredNodes = rawNodes.filter((n) => historyNodeMatchesFilter(n, filter));

  if (knowledge.isLoading) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">History</h1>
        <div className="rounded-md border p-6 text-sm text-muted-foreground">Loading…</div>
      </div>
    );
  }
  if (knowledge.isError) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">History</h1>
        <div
          role="alert"
          className="rounded-md border border-destructive/50 bg-destructive/5 p-6 text-sm text-destructive"
        >
          {knowledge.error instanceof Error ? knowledge.error.message : "Failed to load."}
        </div>
      </div>
    );
  }
  if (knowledge.data && knowledge.data.available === false) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">History</h1>
        <p className="text-sm text-muted-foreground">
          Knowledge is available when Harness Ledger runs on your machine.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">History</h1>
      </div>

      {knowledge.data?.demo_loaded ? (
        <div className="rounded-md border bg-muted/30 p-3 text-sm">
          <p>
            Demo data is loaded so you can see how history looks. Remove it with{" "}
            <code className="rounded bg-background px-1 py-0.5 text-xs">{DEMO_REMOVE_COMMAND}</code>
            .
          </p>
        </div>
      ) : null}

      {targets.length === 0 ? (
        <div className="rounded-md border border-dashed p-10 text-center text-sm text-muted-foreground">
          {executor.data?.connection?.connected === false
            ? "Connect Lovable on the Projects page, then press Sync now."
            : "Nothing to show yet. Allow a project on the Projects page, then press Sync now."}
        </div>
      ) : (
        <>
          {/* Round 9 Task 2: the shared ProjectFilter -- "All projects"
              merges every allowed project's timeline (below) by date; a
              specific project or the workspace target narrows to that one,
              same as before. */}
          <ProjectFilter
            options={projectTargets.map((t) => ({ id: t.id, name: t.name }))}
            value={isAllProjects ? "all" : search.target === "workspace" ? "workspace" : id!}
            onChange={(v) =>
              navigate({
                to: "/history",
                search: {
                  ...(v === "all"
                    ? {}
                    : v === "workspace"
                      ? { target: "workspace", id: workspaceTarget!.id }
                      : { target: "project", id: v }),
                  ...(search.filter ? { filter: search.filter } : {}),
                },
              })
            }
            includeWorkspace={workspaceTarget != null}
          />

          {/* Checkpoint 3 I2: the History kind filter -- All activity /
              Suggestions / Knowledge / Skills / Tests / Restores, driven by
              ?filter= (the Inbox's "View past decisions" link opens
              straight into ?filter=suggestions). Filters the already-fetched
              timeline client-side (harness-ux.ts's historyNodeMatchesFilter)
              -- no new route or query. */}
          <div className="flex flex-wrap gap-2" role="group" aria-label="Filter">
            {HISTORY_FILTER_ORDER.map((f) => (
              <Button
                key={f}
                type="button"
                variant={filter === f ? "default" : "outline"}
                size="sm"
                aria-pressed={filter === f}
                onClick={() =>
                  navigate({
                    to: "/history",
                    search: {
                      ...(selected ? { target: selected.target, id: selected.id } : {}),
                      ...(f === "all" ? {} : { filter: f }),
                    },
                  })
                }
              >
                {HISTORY_FILTER_LABELS[f]}
              </Button>
            ))}
          </div>

          {/* Checkpoint 2 2-C: "Current Knowledge" -- the newest written
              version or latest snapshot for the selected target, visually
              separate from the event timeline below it. Checkpoint 3 UX fix
              3: collapsed by default (a <details>, not a <section>) -- the
              summary alone carries the target name, character count and
              rule count, so collapsed is still informative; expanding shows
              the same ManagedBlockText as before. Open state is remembered
              per browser (CURRENT_KNOWLEDGE_OPEN_KEY), not on the server.
              Round 9 Task 2 fix 3: this box belongs to exactly one target --
              when "All projects" is selected there is no single Knowledge
              text to show, so the fold is not rendered at all rather than
              showing some arbitrary target's text next to a merged
              timeline. */}
          {isAllProjects ? null : (
            <details
              className="space-y-2 rounded-md border p-4"
              open={knowledgeOpen}
              onToggle={(e) => {
                const open = e.currentTarget.open;
                setKnowledgeOpen(open);
                writeCurrentKnowledgeOpen(open);
              }}
            >
              <summary
                id="current-knowledge"
                className="cursor-pointer text-lg font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Current Knowledge
                {selected ? (
                  <span className="ml-2 text-sm font-normal text-muted-foreground">
                    {currentKnowledgeHint(
                      selected.name,
                      selected.current?.content ?? "",
                      selected.managed_block_present,
                    )}
                  </span>
                ) : null}
              </summary>
              <div className="space-y-2 pt-2">
                <p className="text-sm text-muted-foreground">
                  {selected?.current
                    ? `Read from Lovable at ${formatDate(selected.current.fetched_at)}`
                    : "Not read yet — press Sync now on the Instructions page."}
                </p>
                {selected?.current?.content ? (
                  <ManagedBlockText
                    content={selected.current.content}
                    managedBlockPresent={selected.managed_block_present}
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">Nothing here yet.</p>
                )}
              </div>
            </details>
          )}

          {timelineIsLoading ? (
            <div className="rounded-md border p-6 text-sm text-muted-foreground">Loading…</div>
          ) : timelineIsError ? (
            <div
              role="alert"
              className="rounded-md border border-destructive/50 bg-destructive/5 p-6 text-sm text-destructive"
            >
              {timelineErrorValue instanceof Error ? timelineErrorValue.message : "Failed to load."}
            </div>
          ) : rawNodes.length === 0 ? (
            <p className="text-sm text-muted-foreground">{EMPTY_LINE}</p>
          ) : filteredNodes.length === 0 ? (
            <p className="text-sm text-muted-foreground">{EMPTY_FILTERED_LINE}</p>
          ) : (
            <Timeline
              nodes={filteredNodes}
              onRestore={(versionId) => restore.mutate(versionId)}
              restoreDisabled={restore.isPending}
            />
          )}
        </>
      )}
    </div>
  );
}
