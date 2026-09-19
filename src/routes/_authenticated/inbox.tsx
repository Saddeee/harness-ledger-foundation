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
import { AnalyseNotice } from "@/components/harness/analyse-notice";
import {
  executorQueryOptions,
  fetchImprovements,
  fetchInbox,
  fetchProjects,
  lovableOf,
  postExecutor,
  postImprovementAction,
  type AllowedProject,
} from "@/lib/improvements-client";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ALL_PROJECTS_LABEL,
  ANALYSE_NOW_SCOPE_LINE,
  ANALYSED_ALL_LINE,
  INBOX_INTRO,
  INBOX_TITLE,
  INSTRUCTIONS_PROJECT_FILTER_LABEL,
  NEW_ACTIVITY_TITLE,
  REANALYSE_TOKENS_NOTE,
  VIEW_PAST_DECISIONS,
  WORKSPACE_TARGET_LABEL,
  inboxCountLine,
  newActivityLine,
  tokenEstimateLine,
  DISAGREEMENT_ACCEPT_BUTTON,
  DISAGREEMENT_DISMISS_BUTTON,
  DISAGREEMENT_TITLE,
  REANALYSE_BODY,
  REANALYSE_CANCEL_BUTTON,
  REANALYSE_CONFIRM_BUTTON,
  REANALYSE_FROM_LABEL,
  REANALYSE_INCLUDE_REVIEWED_LABEL,
  REANALYSE_PROJECTS_LABEL,
  REANALYSE_REASON_LABEL,
  REANALYSE_REASON_PLACEHOLDER,
  REANALYSE_TITLE,
  REANALYSE_TO_LABEL,
  REANALYSE_TRIGGER_BUTTON,
  disagreementBodyLine,
  reanalyseEstimateLine,
} from "@/lib/harness-ux";
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
type ReanalysisEstimate = {
  messages: number;
  corrections: number;
  episodes: number;
  estimated_tokens: number;
  models: { classifier: { provider: string; model: string } };
  budget_remaining: number;
};

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
function daysAgoIso(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

/** The "Reanalyse history" confirm dialog: scope (projects, date range,
 * whether to include records already decided on), a reason, and the
 * estimate line -- refreshed whenever the scope changes. Confirming posts
 * `reanalyse` to the executor route; it is never coalesced with an ordinary
 * "Analyse now" request. */
function ReanalyseDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const qc = useQueryClient();
  const projects = useQuery({ queryKey: ["harness-projects"], queryFn: fetchProjects });
  const allowed: AllowedProject[] = projects.data?.allowed ?? [];

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [from, setFrom] = useState(() => daysAgoIso(30));
  const [to, setTo] = useState(() => todayIso());
  const [includeReviewed, setIncludeReviewed] = useState(false);
  const [reason, setReason] = useState("");
  const [estimate, setEstimate] = useState<ReanalysisEstimate | null>(null);

  const scopeBody = () => ({
    project_ids: [...selected],
    from,
    to,
    include_reviewed: includeReviewed,
  });

  const estimateMutation = useMutation({
    mutationFn: () => postExecutor({ action: "reanalyse_estimate", ...scopeBody() }),
    onSuccess: (res) => setEstimate((res as { estimate?: ReanalysisEstimate }).estimate ?? null),
  });

  // Re-estimate whenever the scope changes, while the dialog is open.
  useEffect(() => {
    if (!open) return;
    setEstimate(null);
    void estimateMutation.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, from, to, includeReviewed, selected.size]);

  const reanalyse = useMutation({
    mutationFn: () => postExecutor({ action: "reanalyse", ...scopeBody(), reason }),
    onSuccess: () => {
      toast.success("Reanalyse queued");
      void qc.invalidateQueries({ queryKey: executorQueryOptions.queryKey });
      onOpenChange(false);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not queue reanalyse"),
  });

  const toggleProject = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{REANALYSE_TITLE}</DialogTitle>
          <DialogDescription>{REANALYSE_BODY}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>{REANALYSE_PROJECTS_LABEL}</Label>
            <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border p-2">
              {allowed.length === 0 ? (
                <p className="text-xs text-muted-foreground">No projects yet.</p>
              ) : (
                allowed.map((p) => (
                  <label key={p.id} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={selected.has(p.id)}
                      onCheckedChange={() => toggleProject(p.id)}
                    />
                    {p.name}
                  </label>
                ))
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              None checked means every project you've allowed.
            </p>
          </div>
          <div className="flex gap-3">
            <div className="flex-1 space-y-1">
              <Label htmlFor="reanalyse-from">{REANALYSE_FROM_LABEL}</Label>
              <Input
                id="reanalyse-from"
                type="date"
                value={from}
                max={to}
                onChange={(e) => setFrom(e.target.value)}
              />
            </div>
            <div className="flex-1 space-y-1">
              <Label htmlFor="reanalyse-to">{REANALYSE_TO_LABEL}</Label>
              <Input
                id="reanalyse-to"
                type="date"
                value={to}
                min={from}
                onChange={(e) => setTo(e.target.value)}
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={includeReviewed}
              onCheckedChange={(v) => setIncludeReviewed(v === true)}
            />
            {REANALYSE_INCLUDE_REVIEWED_LABEL}
          </label>
          <div className="space-y-1">
            <Label htmlFor="reanalyse-reason">{REANALYSE_REASON_LABEL}</Label>
            <Input
              id="reanalyse-reason"
              value={reason}
              placeholder={REANALYSE_REASON_PLACEHOLDER}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <p className="text-sm text-muted-foreground" role="status">
            {estimate
              ? reanalyseEstimateLine({
                  messages: estimate.messages,
                  estimated_tokens: estimate.estimated_tokens,
                  model: estimate.models.classifier.model,
                  budget_remaining: estimate.budget_remaining,
                })
              : "Estimating…"}
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {REANALYSE_CANCEL_BUTTON}
          </Button>
          <Button
            onClick={() => reanalyse.mutate()}
            disabled={reanalyse.isPending || !reason.trim()}
          >
            {reanalyse.isPending ? "Queuing…" : REANALYSE_CONFIRM_BUTTON}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

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
  // Checkpoint 2026-09-18 WP5 (D7): "Reanalyse history" confirm dialog.
  const [reanalyseOpen, setReanalyseOpen] = useState(false);

  const query = useQuery({ queryKey: ["harness-improvements"], queryFn: fetchImprovements });
  // Checkpoint 3: the queue itself -- every unresolved item, from the one
  // server-side aggregation Overview also counts (listInboxItems).
  const inbox = useQuery({ queryKey: ["harness-inbox"], queryFn: fetchInbox });
  // Owner review round 7 fix 1: the same allowed-projects list Instructions'
  // own filter and the Reanalyse dialog above already read -- react-query
  // dedupes this against theirs, no extra fetch.
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
          {query.data.reason}
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

  // Round 5 Task 6 / spec §4: automatic mode's own empty state -- only once
  // it actually did something since the last visit; otherwise the plain
  // line applies in both modes.
  const autoAcceptedSince = query.data?.counts?.auto_accepted_since_seen ?? 0;
  const nothingPendingLine =
    executor.data?.settings?.decision_mode === "automatic" && autoAcceptedSince > 0
      ? `Nothing needs your decision. Harness Ledger accepted ${autoAcceptedSince} suggestion${autoAcceptedSince === 1 ? "" : "s"} automatically since your last visit; see History.`
      : "Nothing needs your decision. Everything you've decided on is under History.";

  const awaiting = executor.data?.analysis?.awaiting_analysis ?? 0;
  const lastAnalysis = executor.data?.analysis?.last_run?.finished_at ?? null;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">{INBOX_TITLE}</h1>
        <p className="text-sm font-medium">
          {inbox.isLoading ? "Loading…" : inboxCountLine(count)}
        </p>
        <p className="text-xs text-muted-foreground">{INBOX_INTRO}</p>
      </div>

      {/* Owner review round 7 fix 1: same segmented "Show" control as
          Instructions, same copy -- All projects, one button per allowed
          project, and Workspace once an item with no project of its own
          exists. Only narrows what's shown below; the count line and the
          sidebar badge above both keep counting every item. */}
      {showProjectFilter ? (
        <div
          className="flex flex-wrap items-center gap-2"
          role="group"
          aria-label={INSTRUCTIONS_PROJECT_FILTER_LABEL}
        >
          <span className="text-sm font-medium text-muted-foreground">
            {INSTRUCTIONS_PROJECT_FILTER_LABEL}
          </span>
          <Button
            type="button"
            variant={!search.project ? "default" : "outline"}
            size="sm"
            aria-pressed={!search.project}
            onClick={() => navigate({ to: "/inbox", search: {} })}
          >
            {ALL_PROJECTS_LABEL}
          </Button>
          {projectsWithItems.map((p) => (
            <Button
              key={p.id}
              type="button"
              variant={search.project === p.id ? "default" : "outline"}
              size="sm"
              aria-pressed={search.project === p.id}
              onClick={() => navigate({ to: "/inbox", search: { project: p.id } })}
            >
              {p.name}
            </Button>
          ))}
          {hasWorkspaceItem ? (
            <Button
              type="button"
              variant={search.project === "workspace" ? "default" : "outline"}
              size="sm"
              aria-pressed={search.project === "workspace"}
              onClick={() => navigate({ to: "/inbox", search: { project: "workspace" } })}
            >
              {WORKSPACE_TARGET_LABEL}
            </Button>
          ) : null}
        </div>
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
          {activeProjectFilter && items.length > 0
            ? "Nothing to show for this filter."
            : all.length === 0
              ? "Suggestions Harness Ledger finds in your Lovable chats will appear here."
              : nothingPendingLine}
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

      {/* Secondary: analysis status. New activity gets a heading and the
          Analyse now control; otherwise one compact status line. */}
      <section aria-label="Analysis" className="space-y-2 rounded-md border p-4">
        {awaiting > 0 ? (
          <>
            <h2 className="text-base font-medium">{NEW_ACTIVITY_TITLE}</h2>
            <p className="text-sm text-muted-foreground">{newActivityLine(awaiting)}</p>
            <p className="text-xs text-muted-foreground">{tokenEstimateLine(null)}</p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            {ANALYSED_ALL_LINE}
            {lastAnalysis ? ` Last analysis ${new Date(lastAnalysis).toLocaleString()}.` : ""}
          </p>
        )}
        <AnalyseNotice />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">{ANALYSE_NOW_SCOPE_LINE}</p>
          <div className="space-y-1 text-right">
            <Button size="sm" variant="ghost" onClick={() => setReanalyseOpen(true)}>
              {REANALYSE_TRIGGER_BUTTON}
            </Button>
            <p className="text-xs text-muted-foreground">{REANALYSE_TOKENS_NOTE}</p>
          </div>
        </div>
        <ReanalyseDialog open={reanalyseOpen} onOpenChange={setReanalyseOpen} />
      </section>
    </div>
  );
}
