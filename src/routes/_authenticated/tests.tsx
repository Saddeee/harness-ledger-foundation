// The Tests page (Round 6c part B, owner's own ask, 2026-09-13: "It is
// better if we have a page dedicated for this so you can see status, and
// actual results, and somewhere we can collect feedback from the user
// about this"). One row per paired-test run ever started, any status,
// newest first -- status in plain words, the measured cost, and a small
// feedback box per row. Reached from NAV (between History and Skills) and
// from every card's "See on Tests" link (improvement.tsx) and the judging
// screen's own "← Tests" link (judge.tsx). Only talks to the local Harness
// routes: fetchTestRuns (GET .../improvements?runs=1, not a seventh
// route), executorQueryOptions (credits + undeleted copies, already the
// same cache key Projects/Settings read from), and postImprovementAction
// for the "feedback" action.
import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDate, formatDay, testsPageCreditsLine } from "@/lib/harness-ux";
import {
  executorQueryOptions,
  fetchTestRuns,
  postImprovementAction as post,
  type ExperimentRunSummary,
} from "@/lib/improvements-client";

export const Route = createFileRoute("/_authenticated/tests")({
  head: () => ({
    meta: [
      { title: "Tests — Harness Ledger" },
      {
        name: "description",
        content: "Every paired test you've run: status, results, and your own notes.",
      },
      { property: "og:title", content: "Tests — Harness Ledger" },
      {
        property: "og:description",
        content: "Every paired test you've run: status, results, and your own notes.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Page,
});

const INTRO_LINE =
  "Each test copies your project at the moment before a real request, adds one rule, sends the same request, and lets you judge both builds.";
const EMPTY_LINE = 'No tests yet. Open a suggestion and press "Test this rule".';
const UNAVAILABLE_LINE = "Tests are available when Harness runs on your machine.";
const IN_PROGRESS_STATUSES = new Set(["copying", "building"]);
const POLL_MS = 10_000;

function statusCell(run: ExperimentRunSummary) {
  switch (run.status) {
    case "queued":
      return <span>Queued</span>;
    case "copying":
      return <span>Copying</span>;
    case "building":
      return <span>Building</span>;
    case "judging":
      return (
        <Link
          to="/judge"
          search={{ run: run.id }}
          className="text-primary underline underline-offset-2"
        >
          Your verdict is needed
        </Link>
      );
    case "judged": {
      const no = Math.round((run.score ?? 0) * run.corrections);
      return (
        <Link
          to="/judge"
          search={{ run: run.id }}
          className="text-primary underline underline-offset-2"
        >
          {`Judged: ${no} of ${run.corrections} correction${run.corrections === 1 ? "" : "s"} no longer needed`}
        </Link>
      );
    }
    case "failed":
      return (
        <Link
          to="/judge"
          search={{ run: run.id }}
          className="text-primary underline underline-offset-2"
        >
          {`Failed: ${run.error ?? "unknown error"} · open`}
        </Link>
      );
    default:
      return <span>Cancelled</span>;
  }
}

function costCell(run: ExperimentRunSummary): string {
  return run.cost_credits == null
    ? "—"
    : `${run.cost_credits} credit${run.cost_credits === 1 ? "" : "s"} · measured`;
}

function FeedbackCell({
  run,
  editing,
  draft,
  busy,
  onStartEdit,
  onChangeDraft,
  onCancel,
  onSave,
}: {
  run: ExperimentRunSummary;
  editing: boolean;
  draft: string;
  busy: boolean;
  onStartEdit: () => void;
  onChangeDraft: (v: string) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  if (editing) {
    return (
      <div className="min-w-[220px] space-y-2">
        <Textarea
          aria-label={`Feedback for ${run.rule_text}`}
          value={draft}
          onChange={(e) => onChangeDraft(e.target.value)}
          maxLength={2000}
          rows={3}
        />
        <div className="flex gap-2">
          <Button size="sm" disabled={busy} onClick={onSave}>
            {busy ? "Saving…" : "Save"}
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <Button size="sm" variant="outline" onClick={onStartEdit}>
        {run.feedback ? "Edit" : "Add feedback"}
      </Button>
      {run.feedback ? (
        <p className="max-w-xs whitespace-pre-wrap text-xs text-muted-foreground">
          {run.feedback}
          <br />
          {`Your note, ${formatDay(run.feedback_at)}`}
        </p>
      ) : null}
    </div>
  );
}

function Page() {
  const qc = useQueryClient();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState("");

  const testsQuery = useQuery({
    queryKey: ["harness-tests"],
    queryFn: fetchTestRuns,
    refetchInterval: (query) => {
      const data = query.state.data;
      const runs = data && data.available ? data.runs : [];
      return runs.some((r) => IN_PROGRESS_STATUSES.has(r.status)) ? POLL_MS : false;
    },
  });
  const executor = useQuery(executorQueryOptions);

  const saveFeedback = useMutation({
    mutationFn: ({ runId, text }: { runId: number; text: string }) =>
      post({ action: "feedback", run_id: runId, text }),
    onSuccess: () => {
      toast.success("Saved your feedback.");
      setEditingId(null);
      void qc.invalidateQueries({ queryKey: ["harness-tests"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not save feedback"),
  });

  if (testsQuery.isLoading) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Tests</h1>
        <div className="rounded-md border p-6 text-sm text-muted-foreground">Loading…</div>
      </div>
    );
  }
  if (testsQuery.isError) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Tests</h1>
        <div
          role="alert"
          className="rounded-md border border-destructive/50 bg-destructive/5 p-6 text-sm text-destructive"
        >
          {testsQuery.error instanceof Error ? testsQuery.error.message : "Failed to load."}
        </div>
      </div>
    );
  }
  if (testsQuery.data && testsQuery.data.available === false) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Tests</h1>
        <p className="text-sm text-muted-foreground">{UNAVAILABLE_LINE}</p>
      </div>
    );
  }

  const runs = testsQuery.data?.available ? testsQuery.data.runs : [];
  const credits = executor.data?.credits;
  const undeletedCopies = executor.data?.undeleted_copies ?? [];

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Tests</h1>
        <p className="text-sm text-muted-foreground">{INTRO_LINE}</p>
        {credits ? (
          <p className="text-sm text-muted-foreground">{testsPageCreditsLine(credits)}</p>
        ) : null}
      </div>

      {runs.length === 0 ? (
        <div className="rounded-md border border-dashed p-10 text-center text-sm text-muted-foreground">
          {EMPTY_LINE}
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Rule</TableHead>
              <TableHead>Started</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Cost</TableHead>
              <TableHead>Feedback</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((run) => (
              <TableRow key={run.id}>
                <TableCell>
                  <Link
                    to="/ledger"
                    search={{ improvement: run.improvement_id }}
                    className="text-primary underline underline-offset-2"
                  >
                    {run.rule_text}
                  </Link>
                </TableCell>
                <TableCell className="whitespace-nowrap">{formatDate(run.started_at)}</TableCell>
                <TableCell>{statusCell(run)}</TableCell>
                <TableCell className="whitespace-nowrap">{costCell(run)}</TableCell>
                <TableCell>
                  <FeedbackCell
                    run={run}
                    editing={editingId === run.id}
                    draft={draft}
                    busy={saveFeedback.isPending && editingId === run.id}
                    onStartEdit={() => {
                      setEditingId(run.id);
                      setDraft(run.feedback ?? "");
                    }}
                    onChangeDraft={setDraft}
                    onCancel={() => setEditingId(null)}
                    onSave={() => saveFeedback.mutate({ runId: run.id, text: draft })}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {undeletedCopies.length > 0 ? (
        <details className="rounded-md border">
          <summary className="cursor-pointer px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {`Test copies to delete by hand (${undeletedCopies.length})`}
          </summary>
          <ul className="space-y-2 border-t p-3 text-sm">
            {undeletedCopies.map((c) => (
              <li key={c.run_id} className="rounded-md border bg-muted/30 p-2">
                <p className="font-mono text-xs">{c.copy_project_id}</p>
                {c.copy_cleanup_note ? (
                  <p className="text-xs text-muted-foreground">{c.copy_cleanup_note}</p>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
