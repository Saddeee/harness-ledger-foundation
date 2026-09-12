// Shared "Analyse now" notice (Round 4 Task A4, spec §2): shown at the top
// of both the Inbox and the Instructions page. Reads the `analysis` block
// from GET /api/public/harness/executor -- an analysis run is independent of
// the Lovable connection, so this reads the same executor query the rest of
// the local UI already uses, never a route of its own. Only ever talks to
// the executor route (executorQueryOptions/postExecutor); nothing here calls
// fetch directly or talks to Lovable.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { executorQueryOptions, postExecutor } from "@/lib/improvements-client";

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
  const executor = useQuery(executorQueryOptions);

  const analyseNow = useMutation({
    mutationFn: () => postExecutor({ action: "analyse_now" }),
    onSuccess: () => {
      toast.success("Analysis requested — it starts within 30 seconds");
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

  const waitingLine =
    awaiting > 0
      ? awaiting === 1
        ? "1 synced message is waiting for analysis."
        : `${awaiting} synced messages are waiting for analysis.`
      : "All synced messages have been analysed.";

  const startedAt = lastRun?.started_at;
  const runningLine = `Analysing… (started ${formatTime(startedAt)})`;

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

  const disabled = running || !providerReady.ok;

  return (
    <div className="space-y-2 rounded-md border bg-muted/30 p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p>{running ? runningLine : waitingLine}</p>
        <Button
          size="sm"
          variant="outline"
          onClick={() => analyseNow.mutate()}
          disabled={disabled || analyseNow.isPending}
        >
          {analyseNow.isPending ? "Requesting…" : "Analyse now"}
        </Button>
      </div>
      {!providerReady.ok ? (
        <p className="text-xs text-muted-foreground">
          {/* The server's own reason already says where to fix it (e.g. "No
              API key saved for openai. Add one in Settings."); the fixed
              prefix is only a fallback for when there's no reason at all. */}
          {providerReady.reason || "Add an API key or install Claude Code in Settings."}
        </p>
      ) : null}
      {!running && lastRunLine ? (
        <p className="text-xs text-muted-foreground">{lastRunLine}</p>
      ) : null}
    </div>
  );
}
