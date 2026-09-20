import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ActionFailedCard,
  ConflictCard,
  DecisionCard,
  NewSkillCard,
  RuleAttentionCard,
  TestResultCard,
  useRun,
  type Improvement,
} from "@/components/harness/improvement";
import { ProjectFilter } from "@/components/harness/project-filter";
import {
  executorQueryOptions,
  fetchImprovements,
  fetchInbox,
  fetchProjects,
  lovableOf,
  postExecutor,
  postImprovementAction,
  syncResultText,
  type AllowedProject,
} from "@/lib/improvements-client";
import { Button } from "@/components/ui/button";
import {
  ANALYSE_NOW_SCOPE_LINE,
  INBOX_INTRO,
  INBOX_TITLE,
  VIEW_PAST_DECISIONS,
  inboxCountLine,
  // ---- Round 8 Task 1 item 8 ----
  analysisStatusLine,
  sidebarSyncLine,
  // ---- end Round 8 Task 1 item 8 ----
  DISAGREEMENT_ACCEPT_BUTTON,
  DISAGREEMENT_DISMISS_BUTTON,
  DISAGREEMENT_TITLE,
  disagreementBodyLine,
  formatDate,
  // ---- Round 8 Task 3 ----
  providerDisplayName,
  scheduleModeLine,
  // ---- end Round 8 Task 3 ----
} from "@/lib/harness-ux";
import {
  OVERVIEW_STATUS_BUDGETS_TITLE,
  buildOverviewState,
  overviewNextAction,
} from "@/lib/onboarding-copy";
import type { InboxItem } from "@/lib/improvements-client";

// Checkpoint 2026-09-18 WP5 (D7): the executor route's GET response gained
// `analysis.disagreements` and the POST route gained `reanalyse_estimate` /
// `reanalyse` / `accept_disagreement` / `dismiss_disagreement` this
// checkpoint -- improvements-client.ts's own ExecutorAnalysis/ExecutorSettings
// types are not part of this WP's editable surface, so these local shapes
// describe just the additional fields, kept structurally compatible with
// what the route actually returns (see executor.ts's GET handler).
type AnalysisDisagreement = {
  id: number;
  correction_candidate_id: number;
  previous_json: string;
  proposed_json: string;
  status: "open" | "accepted" | "dismissed";
};

// Round 8 Task 1 fix 1: the "Reanalyse history" trigger, its confirm dialog
// (`ReanalyseDialog`, with its own scope/estimate/reason state and the
// `reanalyse_estimate`/`reanalyse` mutations) and REANALYSE_TOKENS_NOTE used
// to live here. They now live in local-settings.tsx, rendered directly
// under Settings > AI analysis's <AnalyseNotice /> -- disagreement review
// (DisagreementCard, just below) stays on the Inbox, since a disagreement is
// a decision, not an analysis-run control.

function DisagreementCard({ item }: { item: AnalysisDisagreement }) {
  const qc = useQueryClient();
  const previous = (() => {
    try {
      return JSON.parse(item.previous_json) as { classification?: string };
    } catch {
      return {};
    }
  })();
  const proposed = (() => {
    try {
      return JSON.parse(item.proposed_json) as { classification?: string };
    } catch {
      return {};
    }
  })();

  const respond = useMutation({
    mutationFn: (action: "accept_disagreement" | "dismiss_disagreement") =>
      postExecutor({ action, id: item.id }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: executorQueryOptions.queryKey });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not update"),
  });

  return (
    <div className="space-y-2 rounded-md border bg-card p-4 text-sm">
      <p className="font-medium">{DISAGREEMENT_TITLE}</p>
      <p className="text-muted-foreground">
        {disagreementBodyLine(
          previous.classification ?? "unknown",
          proposed.classification ?? "unknown",
        )}
      </p>
      <div className="flex gap-3">
        <button
          type="button"
          className="text-sm text-primary underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          disabled={respond.isPending}
          onClick={() => respond.mutate("accept_disagreement")}
        >
          {DISAGREEMENT_ACCEPT_BUTTON}
        </button>
        <button
          type="button"
          className="text-sm text-primary underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          disabled={respond.isPending}
          onClick={() => respond.mutate("dismiss_disagreement")}
        >
          {DISAGREEMENT_DISMISS_BUTTON}
        </button>
      </div>
    </div>
  );
}

// Owner review round 7 fix 1: "Inbox could reuse the new project filter so
// the Quick Tip Calculator leftovers stop crowding the demo project." Same
// shape and copy as Instructions' own ?project=<id|"workspace"> filter
// (instructions.tsx) -- narrows which already-fetched inbox items are shown,
// fetches nothing of its own.
type InboxSearch = { project?: string };

export const Route = createFileRoute("/_authenticated/inbox")({
  validateSearch: (search: Record<string, unknown>): InboxSearch => {
    const raw = search["project"];
    const project = typeof raw === "string" && raw ? raw : undefined;
    return project ? { project } : {};
  },
  head: () => ({
    meta: [
      { title: "Inbox — Harness Ledger" },
      { name: "description", content: "Everything that needs your attention." },
      { property: "og:title", content: "Inbox — Harness Ledger" },
      { property: "og:description", content: "Everything that needs your attention." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Page,
});

// A just-decided item stays where it was, but as a compact one-line
// confirmation instead of a full card: the Inbox holds only what still needs
// a decision, so once it's decided it isn't "in the Inbox" any more -- it
// just hasn't left the screen yet. Kept in component state only, so a reload
// shows a clean Inbox (the item is simply gone -- it lives under
// Improvements now).
function ConfirmationRow({
  item,
  message,
  busy,
  onUndo,
  onView,
}: {
  item: Improvement;
  message: string;
  busy: boolean;
  onUndo: () => void;
  onView: () => void;
}) {
  // Round 6 Task 3 fix 1: Accept can write to Lovable inline (Round 6 Task
  // 2), so a just-decided item shown here may already be live by the time
  // this row renders (or become live later, from a background refetch) --
  // Undo must never be offered for a live item (posting it would demote a
  // rule that's still in Lovable's Knowledge; see improvements.ts's own
  // "undo" guard, which lovable.can_undo mirrors exactly, computed
  // server-side so this page never re-derives it). `message` is whatever
  // the toast said at decision time; once the item reads back "written",
  // that live status wins over that possibly-stale text.
  const lovable = lovableOf(item);
  const written = lovable.write_status === "written";
  const canUndo = item.kind !== "retire" && lovable.can_undo;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-card p-4">
      <p className="min-w-0 flex-1 text-sm">
        <span className="font-medium">{item.title}</span>
        {" — "}
        {written ? "Written to Lovable" : message}
      </p>
      <div className="flex items-center gap-3">
        {!written && canUndo ? (
          <button
            type="button"
            disabled={busy}
            className="text-sm text-primary underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            onClick={onUndo}
          >
            Undo
          </button>
        ) : null}
        <button
          type="button"
          className="text-sm text-primary underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onView}
        >
          Open
        </button>
      </div>
    </div>
  );
}

function Page() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const search = Route.useSearch();
  // Items decided this visit: id -> the exact toast text, so the
  // confirmation row says the same thing the toast said. Cleared by "Undo"
  // or by leaving the page (component state only -- a reload starts clean).
  const [confirmed, setConfirmed] = useState<Map<number, string>>(new Map());
  const [undoing, setUndoing] = useState<Set<number>>(new Set());

  const query = useQuery({ queryKey: ["harness-improvements"], queryFn: fetchImprovements });
  // Checkpoint 3: the queue itself -- every unresolved item, from the one
  // server-side aggregation Overview also counts (listInboxItems).
  const inbox = useQuery({ queryKey: ["harness-inbox"], queryFn: fetchInbox });
  // Owner review round 7 fix 1: the same allowed-projects list Instructions'
  // own filter reads -- react-query dedupes this against theirs, no extra
  // fetch. Round 8 Task 1 fix 1: the Reanalyse dialog that used to also read
  // this moved to local-settings.tsx, with its own fetchProjects query.
  const projectsQuery = useQuery({ queryKey: ["harness-projects"], queryFn: fetchProjects });
  const allowedProjects: AllowedProject[] = projectsQuery.data?.allowed ?? [];
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["harness-inbox"] });
    return qc.invalidateQueries({ queryKey: ["harness-improvements"] });
  };
  const { busy: cardBusy, run: cardRun } = useRun((msg) => {
    toast.success(msg);
    void refresh();
  });
  // Round 5 Task 6 / spec §4: same executor query every DecisionCard
  // already reads (react-query dedupes/caches it) -- only decision_mode is
  // needed here, to pick the empty-state copy below.
  const executor = useQuery(executorQueryOptions);
  // Round 8 Task 1 item 8: the Inbox's own "Analyse now" button -- same
  // mutation and disabled/pending states AnalyseNotice always had (that
  // component itself moved to Settings > AI analysis, with its progress
  // display and per-run token figures; "Reanalyse history" stays here).
  const analyseNow = useMutation({
    mutationFn: () => postExecutor({ action: "analyse_now" }),
    onSuccess: () => {
      toast.success("Analysis started");
      void qc.invalidateQueries({ queryKey: executorQueryOptions.queryKey });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not request analysis"),
  });
  // Round 8 Task 3: Overview's own "Sync now" mutation, reused here verbatim
  // (same action, same invalidations) now that its next-action block moved
  // onto the top of this page.
  const syncNow = useMutation({
    mutationFn: () => postExecutor({ action: "sync_now" }),
    onSuccess: (data) => {
      toast.success(syncResultText(data));
      void qc.invalidateQueries({ queryKey: executorQueryOptions.queryKey });
      void qc.invalidateQueries({ queryKey: ["harness-improvements"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Sync failed"),
  });

  // Task C3 / spec §5 "new since your last visit": read the *previous*
  // last_seen_at from the first successful load of this visit, before
  // marking the Inbox seen (which updates that same setting to now) --
  // frozen in a ref for the rest of this visit, so later refetches (the
  // sidebar's 60s poll shares this query) don't move the goalposts while
  // the page stays open. "" (never visited) has no "since" to compare
  // against, so a first-ever visit marks nothing as New (see isNew below).
  const previousLastSeenAt = useRef<string | null>(null);
  const markedSeen = useRef(false);
  useEffect(() => {
    if (markedSeen.current) return;
    if (!query.data || query.data.available === false) return;
    previousLastSeenAt.current = query.data.last_seen_at ?? null;
    markedSeen.current = true;
    void postImprovementAction({ action: "mark_seen" });
  }, [query.data]);
  const isNew = (item: Improvement): boolean => {
    const previous = previousLastSeenAt.current;
    // Never visited before -- there is no "since your last visit" to compare
    // against, so nothing is New (a first-ever visit shouldn't flag the
    // entire backlog).
    if (!previous) return false;
    const createdAt = new Date(item.created_at).getTime();
    const previousAt = new Date(previous).getTime();
    return !Number.isNaN(createdAt) && !Number.isNaN(previousAt) && createdAt > previousAt;
  };
  // Round 5 Task 5 / spec §2: clicking an item -- the compact card's title,
  // or a confirmation row's "Open" -- always goes to Suggestions (/ledger)
  // with the item preselected. The Inbox itself has no detail view.
  const onOpen = (id: number) => navigate({ to: "/ledger", search: { improvement: id } });
  const confirmDecision = (id: number, msg: string) => {
    refresh();
    setConfirmed((prev) => {
      const next = new Map(prev);
      next.set(id, msg);
      return next;
    });
  };
  // Round 6 Task 3 fix 1: "undo", never the plain "reopen" -- reopen has no
  // guard against demoting a rule that Accept already wrote to Lovable
  // inline (Round 6 Task 2). The row itself only ever offers this button
  // when lovable.can_undo said it was safe, but the action here must still
  // be the guarded one, in case the item went live between that check and
  // this click. Waits for the refetch to land before dropping the
  // confirmation row -- so the item turns straight into a pending card
  // instead of briefly disappearing.
  const undo = async (id: number) => {
    setUndoing((prev) => new Set(prev).add(id));
    try {
      await postImprovementAction({ action: "undo", id });
      await refresh();
      setConfirmed((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "action failed");
    } finally {
      setUndoing((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  if (query.isLoading) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Inbox</h1>
        <div className="rounded-md border p-6 text-sm text-muted-foreground">Loading…</div>
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Inbox</h1>
        <div
          role="alert"
          className="rounded-md border border-destructive/50 bg-destructive/5 p-6 text-sm text-destructive"
        >
          {query.error instanceof Error ? query.error.message : "Failed to load."}
        </div>
      </div>
    );
  }
  if (query.data && query.data.available === false) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Inbox</h1>
        <div className="rounded-md border border-dashed p-10 text-center text-sm text-muted-foreground">
          <p>{query.data.reason}</p>
          <Link to="/" hash="start-here" className="mt-2 inline-block underline underline-offset-2">
            How to run it
          </Link>
        </div>
      </div>
    );
  }

  const all = query.data?.improvements ?? [];
  const items = inbox.data && inbox.data.available ? inbox.data.items : [];
  const count = inbox.data && inbox.data.available ? inbox.data.count : items.length;
  const inboxUnavailable = inbox.data && inbox.data.available === false;
  // Items decided this visit stay visible as confirmation rows (with Undo)
  // until the page is left, in the order they had.
  const confirmedItems = all.filter((i) => confirmed.has(i.id));

  // ---- Owner review round 7 fix 1: per-project filter (?project=) ----
  // A null project_id is workspace-level or has no project of its own (see
  // InboxItem's own doc comment) -- it gets its own "Workspace" bucket
  // rather than disappearing, same honesty rule as Instructions' filter.
  const itemProjectValue = (it: InboxItem): string => it.project_id ?? "workspace";
  const hasWorkspaceItem = items.some((it) => it.project_id === null);
  // Only projects that currently have an item get a button: six allowed
  // projects (test copies included) for three items is noise, and a button
  // that filters to nothing helps nobody. Items name their own project, so
  // the buttons need no project the allowed list lacks.
  const projectsWithItems: AllowedProject[] = allowedProjects.filter((p) =>
    items.some((it) => it.project_id === p.id),
  );
  const showProjectFilter =
    projectsWithItems.length >= 2 || (projectsWithItems.length >= 1 && hasWorkspaceItem);
  const activeProjectFilter = search.project ? search.project : null;
  const visibleItems = activeProjectFilter
    ? items.filter((it) => itemProjectValue(it) === activeProjectFilter)
    : items;
  // ---- end fix 1 ----

  // Checkpoint 2026-09-18 WP5 (D7): open review items where a newer
  // analysis disagreed with a decision already made are Inbox "Conflict"
  // items; the server lists them, the card here is the existing one.
  const disagreements =
    (executor.data?.analysis as unknown as { disagreements?: AnalysisDisagreement[] } | undefined)
      ?.disagreements ?? [];
  const disagreementById = new Map(disagreements.map((d) => [`disagreement:${d.id}`, d]));

  // Round 8 Task 3 (review item 5): Overview merged into the Inbox -- the
  // same buildOverviewState/overviewNextAction the old /overview page used,
  // reading the same Inbox and executor data this page already fetches
  // (nothing new to read). The plain "Nothing needs your decision. …" empty
  // state (including the automatic-mode nuance it used to carry) is
  // replaced below by the single honest "Nothing waiting for you." line --
  // see the empty-state block further down.
  const overviewState = buildOverviewState({
    inbox: inbox.data,
    executor: executor.data,
    allowedProjectCount: projectsQuery.data?.allowed?.length,
  });
  const nextAction = overviewNextAction(overviewState);
  // Only these five kinds get the headline + button + consequence block at
  // the top of the page -- the other four (review_blocked/review_suggestions/
  // review_rules/judge_replay) mean the Inbox list itself is already the
  // action, so rendering this block too would just repeat it.
  const TOP_ACTION_KINDS = new Set([
    "connect",
    "choose_projects",
    "choose_provider",
    "analyse_now",
    "sync_now",
  ]);
  const showNextAction = TOP_ACTION_KINDS.has(nextAction.kind);

  const awaiting = executor.data?.analysis?.awaiting_analysis ?? 0;
  const lastAnalysis = executor.data?.analysis?.last_run?.finished_at ?? null;
  // Round 8 Task 1 item 8: the same executor query above, reused rather than
  // a fetch of its own (the UI's six /api/public/harness/* routes are a
  // closed set) -- running/queued and provider_ready feed the "Analyse now"
  // button's disabled state, same as AnalyseNotice's own logic.
  const analysisRunning = Boolean(
    executor.data?.analysis?.running || executor.data?.analysis?.queued,
  );
  const providerReady = executor.data?.analysis?.provider_ready;
  // Round 8 Task 3: the "Status and budgets" fold's own reads, moved here
  // verbatim from the old /overview page (same executor query, nothing new
  // fetched).
  const conn = executor.data?.connection;
  const lastRun = executor.data?.last_run ?? null;
  const nextRunAt = executor.data?.next_run_at ?? null;
  const llm = executor.data?.llm;
  const credits = executor.data?.credits;
  const scheduleHolder = executor.data?.schedule_holder ?? null;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">{INBOX_TITLE}</h1>
        <p className="text-sm font-medium">
          {inbox.isLoading ? "Loading…" : inboxCountLine(count)}
        </p>
        <p className="text-xs text-muted-foreground">{INBOX_INTRO}</p>
      </div>

      {/* Round 8 Task 3 (review item 5): Overview's own primary-action
          block, moved here verbatim (same headline/button/consequence,
          same mutations) -- shown only for the five kinds that aren't
          already the Inbox list itself (connect/choose_projects/
          choose_provider/analyse_now/sync_now). */}
      {showNextAction ? (
        <section className="space-y-3 rounded-md border p-6">
          <p className="text-lg font-medium">{nextAction.headline}</p>
          {nextAction.kind === "sync_now" ? (
            <Button onClick={() => syncNow.mutate()} disabled={syncNow.isPending}>
              {syncNow.isPending ? "Syncing…" : nextAction.actionLabel}
            </Button>
          ) : nextAction.kind === "analyse_now" ? (
            <Button onClick={() => analyseNow.mutate()} disabled={analyseNow.isPending}>
              {analyseNow.isPending ? "Starting…" : nextAction.actionLabel}
            </Button>
          ) : (
            <Button asChild>
              <Link to={nextAction.to}>{nextAction.actionLabel}</Link>
            </Button>
          )}
          <p className="text-xs text-muted-foreground">{nextAction.consequence}</p>
        </section>
      ) : null}

      {/* Round 9 Task 2: the shared ProjectFilter, same "Show" control
          Instructions uses -- All projects, one chip per allowed project
          with an item, and the workspace chip once an item with no project
          of its own exists. Only narrows what's shown below; the count
          line and the sidebar badge above both keep counting every item. */}
      {showProjectFilter ? (
        <ProjectFilter
          options={projectsWithItems}
          value={search.project ?? "all"}
          onChange={(v) => navigate({ to: "/inbox", search: v === "all" ? {} : { project: v } })}
          includeWorkspace={hasWorkspaceItem}
        />
      ) : null}

      {inboxUnavailable ? (
        <div className="rounded-md border border-dashed p-10 text-center text-sm text-muted-foreground">
          {(inbox.data as { reason?: string }).reason}
        </div>
      ) : null}

      {confirmedItems.length > 0 ? (
        <ul className="space-y-3">
          {confirmedItems.map((i) => (
            <li key={`confirmed:${i.id}`}>
              <ConfirmationRow
                item={i}
                message={confirmed.get(i.id)!}
                busy={undoing.has(i.id)}
                onUndo={() => void undo(i.id)}
                onView={() => onOpen(i.id)}
              />
            </li>
          ))}
        </ul>
      ) : null}

      {visibleItems.length === 0 &&
      confirmedItems.length === 0 &&
      !inbox.isLoading &&
      !inboxUnavailable ? (
        <div className="rounded-md border border-dashed p-10 text-center text-sm text-muted-foreground">
          {/* Round 8 Task 3 (review item 5): one honest empty state,
              replacing both the "Suggestions Harness Ledger finds…" first-run
              copy and the automatic-mode-specific "Harness Ledger accepted N
              suggestions…" wording -- the project-filter mismatch case below
              is unchanged. */}
          {activeProjectFilter && items.length > 0
            ? "Nothing to show for this filter."
            : "Nothing waiting for you."}
        </div>
      ) : null}

      {visibleItems.length > 0 ? (
        <ul className="space-y-3">
          {visibleItems
            .filter((it) => !(it.improvement && confirmed.has(it.improvement.id)))
            .map((it) => (
              <li key={it.id}>
                {it.type === "new_instruction" && it.improvement ? (
                  <DecisionCard
                    compact
                    item={it.improvement}
                    onChanged={(msg) => confirmDecision(it.improvement!.id, msg)}
                    onOpen={onOpen}
                    isNew={isNew(it.improvement)}
                    conclusion={it.conclusion}
                  />
                ) : it.type === "new_skill" && it.improvement ? (
                  <NewSkillCard
                    item={it.improvement}
                    onOpen={onOpen}
                    busy={cardBusy}
                    run={cardRun}
                  />
                ) : it.type === "test_result" ? (
                  <TestResultCard item={it} />
                ) : it.type === "rule_attention" && it.improvement ? (
                  <DecisionCard
                    compact
                    item={it.improvement}
                    onChanged={(msg) => confirmDecision(it.improvement!.id, msg)}
                    onOpen={onOpen}
                  />
                ) : it.type === "rule_attention" ? (
                  <RuleAttentionCard item={it} />
                ) : it.type === "conflict" && disagreementById.has(it.id) ? (
                  <DisagreementCard item={disagreementById.get(it.id)!} />
                ) : it.type === "conflict" ? (
                  <ConflictCard item={it} />
                ) : (
                  <ActionFailedCard item={it} busy={cardBusy} run={cardRun} />
                )}
              </li>
            ))}
        </ul>
      ) : null}

      <p className="text-sm">
        <Link
          to="/history"
          search={{ filter: "suggestions" }}
          className="text-primary underline underline-offset-2"
        >
          {VIEW_PAST_DECISIONS}
        </Link>
      </p>

      {/* Secondary: analysis status. Round 8 Task 1 item 8: one status line
          (analysisStatusLine) plus its own "Analyse now" button, replacing
          the "New activity"/"Everything synced" pair and the shared notice
          this page used to mount. Round 8 Task 1 fix 1: "Reanalyse
          history"'s own trigger, dialog and token figures moved to
          Settings > AI analysis too -- this section is only ever the one
          status line and the plain "Analyse now" button now. */}
      <section aria-label="Analysis" className="space-y-2 rounded-md border p-4">
        <p className="text-sm text-muted-foreground">
          {analysisStatusLine(lastAnalysis, awaiting)}
        </p>
        <Button
          size="sm"
          variant="outline"
          onClick={() => analyseNow.mutate()}
          disabled={analysisRunning || !providerReady?.ok || analyseNow.isPending}
        >
          {analyseNow.isPending ? "Starting…" : analysisRunning ? "Analysing…" : "Analyse now"}
        </Button>
        {providerReady && !providerReady.ok ? (
          <p className="text-xs text-muted-foreground">
            {providerReady.reason || "Add an API key or install Claude Code in Settings."}{" "}
            <Link to="/settings" className="underline underline-offset-2 hover:no-underline">
              Open Settings
            </Link>
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">{ANALYSE_NOW_SCOPE_LINE}</p>
      </section>

      {/* Round 8 Task 3 (review item 5): Overview's own collapsed "Status
          and budgets" fold, moved here verbatim -- same lines, same executor
          query, nothing new fetched. Collapsed by default (no `open`). */}
      <details className="group rounded-md border">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
          {OVERVIEW_STATUS_BUDGETS_TITLE}
        </summary>
        <div className="space-y-1 border-t px-4 py-4 text-sm text-muted-foreground">
          <p>
            {conn?.connected
              ? `Connected to Lovable${conn.email ? ` as ${conn.email}` : ""}`
              : "Not connected to Lovable"}
          </p>
          <p>{sidebarSyncLine(lastRun, nextRunAt) ?? "No sync has run yet"}</p>
          {lastRun && lastRun.ok === false && lastRun.error ? (
            // The one place outside Technical details this raw text may
            // appear -- and it's inside a collapsed fold.
            <p className="text-xs">Lovable said: {lastRun.error}</p>
          ) : null}
          <p>{nextRunAt ? `Syncs again at ${formatDate(nextRunAt)}` : "No sync scheduled"}</p>
          <p>
            {llm
              ? `AI: ${providerDisplayName(llm.provider)}${llm.models.rule_writer.model ? ` (${llm.models.rule_writer.model})` : ""}`
              : "No provider configured"}
          </p>
          <p>
            {credits
              ? `Credits used: ${credits.used_this_month} of ${credits.budget}`
              : "Credits: unavailable"}
          </p>
          <p>
            {llm
              ? `Tokens used: ${llm.tokens_this_month.toLocaleString()} of ${llm.monthly_token_budget.toLocaleString()}`
              : "Tokens: unavailable"}
          </p>
          <p>{scheduleModeLine(scheduleHolder?.owner ?? null)}</p>
        </div>
      </details>
    </div>
  );
}
