// Shared "Analyse now" notice (Round 4 Task A4, spec §2): shown at the top
// of both the Inbox and the Instructions page. Reads the `analysis` block
// from GET /api/public/harness/executor -- an analysis run is independent of
// the Lovable connection, so this reads the same executor query the rest of
// the local UI already uses, never a route of its own. Only ever talks to
// the executor route (executorQueryOptions/postExecutor); nothing here calls
// fetch directly or talks to Lovable.
import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  executorQueryOptions,
  postExecutor,
  type AnalysisStage,
  type ExecutorAnalysis,
} from "@/lib/improvements-client";

// Round 7: what an analysis run is doing, step by step. The share of the bar
// each step takes is a rough guide to where the time goes (the AI calls in
// reading messages and writing suggestions take most of it).
const STEPS: { stage: AnalysisStage; label: string; from: number; to: number }[] = [
  { stage: "classify", label: "Reading your new messages", from: 0, to: 40 },
  { stage: "group", label: "Grouping them into tasks", from: 40, to: 45 },
  { stage: "rules", label: "Writing suggestions from your corrections", from: 45, to: 80 },
  { stage: "judge", label: "Checking your rules against recent builds", from: 80, to: 95 },
  { stage: "health", label: "Updating rule health", from: 95, to: 100 },
];

function percentFor(stage: AnalysisStage, done: number, total: number | null): number {
  if (stage === "starting") return 2;
  const step = STEPS.find((s) => s.stage === stage);
  if (!step) return 0;
  const within = total && total > 0 ? Math.min(1, done / total) : 0;
  // Never an empty bar while running: it reads as stalled.
  return Math.max(3, Math.round(step.from + (step.to - step.from) * within));
}

function elapsedLabel(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** The progress display while a run is queued or running: a bar, the step
 * list with the current step's "N of M", and the time it has been running. */
export function AnalysisProgress({ analysis }: { analysis: ExecutorAnalysis }) {
  const run = analysis.progress ?? null;
  const current = run?.progress ?? null;
  const stage: AnalysisStage = current?.stage ?? "starting";
  const startedMs = run ? Date.parse(run.started_at.replace(" ", "T") + "Z") : null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const seconds = startedMs ? Math.max(0, Math.round((now - startedMs) / 1000)) : 0;
  const currentIndex = STEPS.findIndex((s) => s.stage === stage);

  if (!run) {
    return (
      <div className="space-y-2" role="status" aria-live="polite">
        <p>Analysis is about to start…</p>
        <Progress value={1} aria-label="Analysis progress" />
      </div>
    );
  }

  return (
    <div className="space-y-2" role="status" aria-live="polite">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium">Analysing…</p>
        <p className="text-xs text-muted-foreground">{`Running for ${elapsedLabel(seconds)}`}</p>
      </div>
      <Progress
        value={percentFor(stage, current?.done ?? 0, current?.total ?? null)}
        aria-label="Analysis progress"
      />
      <ol className="space-y-1 text-xs">
        {STEPS.map((step, i) => {
          const state =
            currentIndex < 0
              ? "upcoming"
              : i < currentIndex
                ? "done"
                : i === currentIndex
                  ? "current"
                  : "upcoming";
          const count =
            state === "current" && current?.total != null && current.total > 0
              ? ` · ${Math.min(current.done + 1, current.total)} of ${current.total}`
              : "";
          return (
            <li
              key={step.stage}
              className={
                state === "current"
                  ? "font-medium text-foreground"
                  : state === "done"
                    ? "text-muted-foreground line-through decoration-muted-foreground/40"
                    : "text-muted-foreground"
              }
            >
              <span aria-hidden="true" className="mr-2 inline-block w-3 text-center">
                {state === "done" ? "✓" : state === "current" ? "•" : "○"}
              </span>
              {`${step.label}${count}`}
            </li>
          );
        })}
      </ol>
      <p className="text-xs text-muted-foreground">
        Only new messages and corrections are analysed. You can leave this page; the run keeps
        going.
      </p>
    </div>
  );
}

// SQLite's datetime('now') is UTC without a zone marker, same convention as
// the rest of the local UI (see executor.ts's parseSyncStartedAt).
function formatTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const withZone = iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`;
  const parsed = new Date(withZone);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function AnalyseNotice() {
  const qc = useQueryClient();
  // Round 7: poll every 2 s while a run is queued or running, so progress
  // moves on screen; otherwise the shared executor query's normal cadence.
  const executor = useQuery({
    ...executorQueryOptions,
    refetchInterval: (query) => {
      const a = query.state.data?.analysis;
      return a && (a.running || a.queued) ? 2_000 : false;
    },
  });

  // When a run finishes, refresh the lists it may have changed.
  const wasActive = useRef(false);
  const active = Boolean(executor.data?.analysis?.running || executor.data?.analysis?.queued);
  useEffect(() => {
    if (wasActive.current && !active) {
      void qc.invalidateQueries({ queryKey: ["harness-improvements"] });
      void qc.invalidateQueries({ queryKey: ["harness-knowledge"] });
    }
    wasActive.current = active;
  }, [active, qc]);

  const analyseNow = useMutation({
    mutationFn: () => postExecutor({ action: "analyse_now" }),
    onSuccess: () => {
      toast.success("Analysis started");
      void qc.invalidateQueries({ queryKey: executorQueryOptions.queryKey });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not request analysis"),
  });

  const analysis = executor.data?.analysis;
  if (!analysis) return null;

  const {
    awaiting_analysis: awaiting,
    running,
    provider_ready: providerReady,
    last_run: lastRun,
  } = analysis;

  // Nothing has ever synced and nothing has ever run -- there is nothing
  // useful to say yet, so stay out of the way entirely.
  if (awaiting <= 0 && lastRun == null) return null;

  // Round 8 Task 1 item 8: "All synced messages have been analysed." is
  // dropped -- the Inbox's own analysisStatusLine (harness-ux.ts) already
  // says this, wherever this notice is mounted (now Settings > AI
  // analysis). null omits the line the same way `awaiting > 0` already did
  // for the "inProgress" case below.
  const waitingLine =
    awaiting > 0
      ? awaiting === 1
        ? "1 synced message is waiting for analysis."
        : `${awaiting} synced messages are waiting for analysis.`
      : null;

  const lastRunLine = (() => {
    // Only ever describes a *finished* run: while running, the "last run"
    // row read back is the in-flight one itself (ok null, zero counts), so
    // showing it here would print a fake "0 messages classified" summary
    // right under "Analysing…". ok === null (crashed/never finished) is
    // treated the same as ok === false -- never as success.
    if (running || !lastRun) return null;
    if (lastRun.ok !== true) {
      return `Last analysis failed: ${lastRun.error ?? "unknown error"}`;
    }
    const counts = lastRun.counts ?? {};
    const classified = counts["classified"] ?? 0;
    const proposed = counts["proposed"] ?? 0;
    const when = formatTime(lastRun.finished_at ?? lastRun.started_at);
    return `Last analysis ${when}: ${plural(classified, "message")} classified, ${plural(
      proposed,
      "proposal",
    )}, ${lastRun.tokens.toLocaleString()} tokens`;
  })();

  const inProgress = running || analysis.queued === true;
  const disabled = inProgress || !providerReady.ok;

  return (
    <div className="space-y-2 rounded-md border bg-muted/30 p-3 text-sm">
      {inProgress ? <AnalysisProgress analysis={analysis} /> : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        {inProgress ? <span /> : waitingLine ? <p>{waitingLine}</p> : <span />}
        <Button
          size="sm"
          variant="outline"
          onClick={() => analyseNow.mutate()}
          disabled={disabled || analyseNow.isPending}
        >
          {analyseNow.isPending ? "Starting…" : inProgress ? "Analysing…" : "Analyse now"}
        </Button>
      </div>
      {!providerReady.ok ? (
        <p className="text-xs text-muted-foreground">
          {/* The server's own reason already says where to fix it (e.g. "No
              API key saved for openai. Add one in Settings."); the fixed
              prefix is only a fallback for when there's no reason at all.
              Round 6c part A / item 4: "Add one in Settings" alone was just
              text -- a real Link gets you there in one click. */}
          {providerReady.reason || "Add an API key or install Claude Code in Settings."}{" "}
          <Link to="/settings" className="underline underline-offset-2 hover:no-underline">
            Open Settings
          </Link>
        </p>
      ) : null}
      {!running && lastRunLine ? (
        <p className="text-xs text-muted-foreground">{lastRunLine}</p>
      ) : null}
    </div>
  );
}
