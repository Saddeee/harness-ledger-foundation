// Overview (Checkpoint 2 WP2-A): first item in the nav, and the answer to
// three questions a new user actually has -- am I set up, what does Harness
// Ledger want me to look at, and is anything stuck. Reads only the routes
// every other page already reads (improvements, executor, tests, projects)
// through the same query hooks the rest of the app uses; every enum
// comparison (health status, run status, write status) happens once, in
// buildOverviewState (src/lib/onboarding-copy.ts) -- this file only ever
// renders the plain-language result.
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  executorQueryOptions,
  fetchInbox,
  fetchProjects,
  postExecutor,
  syncResultText,
} from "@/lib/improvements-client";
import { formatDate } from "@/lib/harness-ux";
import {
  ANALYSE_NOW_CONSEQUENCE,
  OVERVIEW_MONITOR_TITLE,
  OVERVIEW_STATUS_BUDGETS_TITLE,
  SYNC_NOW_CONSEQUENCE,
  buildOverviewState,
  overviewMonitorRows,
  overviewNextAction,
} from "@/lib/onboarding-copy";

export const Route = createFileRoute("/_authenticated/overview")({
  head: () => ({
    meta: [
      { title: "Overview — Harness Ledger" },
      {
        name: "description",
        content: "What Harness Ledger recommends next, and whether anything is stuck.",
      },
    ],
  }),
  component: OverviewPage,
});

function OverviewPage() {
  const qc = useQueryClient();
  // Checkpoint 3 I2: the same Inbox read the Inbox page itself makes (one
  // read, shared via react-query's cache) -- so Overview's "N decisions"
  // count is always exactly the Inbox's own count, never a second
  // computation of the same thing.
  const inbox = useQuery({ queryKey: ["harness-inbox"], queryFn: fetchInbox });
  const executor = useQuery(executorQueryOptions);
  const projects = useQuery({ queryKey: ["harness-projects"], queryFn: fetchProjects });

  const syncNow = useMutation({
    mutationFn: () => postExecutor({ action: "sync_now" }),
    onSuccess: (data) => {
      toast.success(syncResultText(data));
      void qc.invalidateQueries({ queryKey: executorQueryOptions.queryKey });
      void qc.invalidateQueries({ queryKey: ["harness-improvements"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Sync failed"),
  });

  const analyseNow = useMutation({
    mutationFn: () => postExecutor({ action: "analyse_now" }),
    onSuccess: () => {
      toast.success("Analysis started");
      void qc.invalidateQueries({ queryKey: executorQueryOptions.queryKey });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not request analysis"),
  });

  if (inbox.isLoading || executor.isLoading || projects.isLoading) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Overview</h1>
        <div className="rounded-md border p-6 text-sm text-muted-foreground">Loading…</div>
      </div>
    );
  }

  const state = buildOverviewState({
    inbox: inbox.data,
    executor: executor.data,
    allowedProjectCount: projects.data?.allowed?.length,
  });
  const next = overviewNextAction(state);
  const monitorRows = overviewMonitorRows(state);

  const conn = executor.data?.connection;
  const lastRun = executor.data?.last_run ?? null;
  const nextRunAt = executor.data?.next_run_at ?? null;
  const llm = executor.data?.llm;
  const credits = executor.data?.credits;
  const scheduleHolder = executor.data?.schedule_holder ?? null;
  const scheduleHolderLine = scheduleHolder
    ? scheduleHolder.owner === "app"
      ? "Schedule: running in the app"
      : "Schedule: running in the executor process"
    : "Schedule: not running";

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold">Overview</h1>

      <section className="space-y-3 rounded-md border p-6">
        <p className="text-lg font-medium">{next.headline}</p>
        {next.kind === "sync_now" ? (
          <Button onClick={() => syncNow.mutate()} disabled={syncNow.isPending}>
            {syncNow.isPending ? "Syncing…" : next.actionLabel}
          </Button>
        ) : next.kind === "analyse_now" ? (
          <Button onClick={() => analyseNow.mutate()} disabled={analyseNow.isPending}>
            {analyseNow.isPending ? "Starting…" : next.actionLabel}
          </Button>
        ) : (
          <Button asChild>
            <Link to={next.to}>{next.actionLabel}</Link>
          </Button>
        )}
        <p className="text-xs text-muted-foreground">{next.consequence}</p>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground">{OVERVIEW_MONITOR_TITLE}</h2>
        <ul className="divide-y rounded-md border text-sm">
          {monitorRows.map((row) => (
            <li key={row.label} className="flex items-center justify-between px-4 py-2">
              <Link to={row.to} className="hover:underline">
                {row.label}
              </Link>
              <span className="tabular-nums text-muted-foreground">{row.count}</span>
            </li>
          ))}
        </ul>
      </section>

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
          <p>
            {lastRun
              ? `Last sync: ${formatDate(lastRun.finished_at ?? lastRun.started_at)}`
              : "No sync has run yet"}
          </p>
          <p>{nextRunAt ? `Syncs again at ${formatDate(nextRunAt)}` : "No sync scheduled"}</p>
          <p>
            {llm
              ? `Provider: ${llm.provider}${llm.models.rule_writer.model ? ` (${llm.models.rule_writer.model})` : ""}`
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
          <p>{scheduleHolderLine}</p>
        </div>
      </details>
    </div>
  );
}
