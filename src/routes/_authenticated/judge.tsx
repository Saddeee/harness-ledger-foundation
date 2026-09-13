// The judging screen (Round 6 Task 6b / spec §6): "Test this rule"'s own
// result -- your original build next to the same request replayed in a
// temporary copy with the rule added, side by side, with a per-correction
// "Still needed?" verdict. Reached only from a card's own "Your verdict is
// needed" link or a card's judged/failed result line -- not in NAV. Data
// comes from the same /api/public/harness/improvements route as everything
// else in this app (?run=<id> for the run itself, the plain GET -- already
// cached from Suggestions/Inbox -- for the improvement's own destination/
// write status that "Add it now"/"Remove from Knowledge" need).
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { WhatChangedLines } from "@/components/harness/timeline";
import { AddConfirm, RemoveFromKnowledgeConfirm, useRun } from "@/components/harness/improvement";
import {
  CORRECTIONS_FROM_FOLLOW_UPS_LINE,
  testCopyConfounderLine,
  testCostLine,
  testedResultLine,
  testFailedLine,
  TEST_ONE_BUILD_LINE,
} from "@/lib/harness-ux";
import {
  fetchExperimentRun,
  fetchImprovements,
  lovableOf,
  postImprovementAction as post,
  type ExperimentRunView,
} from "@/lib/improvements-client";
import { toast } from "sonner";

type JudgeSearch = { run?: number };

export const Route = createFileRoute("/_authenticated/judge")({
  validateSearch: (search: Record<string, unknown>): JudgeSearch => {
    const raw = search["run"];
    const run = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : undefined;
    return run != null && Number.isFinite(run) ? { run } : {};
  },
  head: () => ({
    meta: [
      { title: "Judge a test — Harness Ledger" },
      {
        name: "description",
        content: "Your original build next to the same request with the rule.",
      },
      { property: "og:type", content: "website" },
    ],
  }),
  component: Page,
});

const POLL_MS = 10_000;
const IN_PROGRESS_STATUSES = new Set(["queued", "copying", "building"]);

type Verdict = "yes" | "no" | "unclear";

const VERDICT_OPTIONS: { value: Verdict; label: string }[] = [
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
  { value: "unclear", label: "Unclear" },
];

// One correction's own roving-tabindex radiogroup -- same pattern as
// AddConfirm/SkipConfirm's own two/four-choice groups (improvement.tsx):
// arrows move between the three options, only the selected one (or the
// first, before anything is chosen) is tabbable.
function CorrectionVerdictRow({
  text,
  value,
  onChange,
}: {
  text: string;
  value: Verdict | null;
  onChange: (v: Verdict) => void;
}) {
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    const step =
      e.key === "ArrowDown" || e.key === "ArrowRight"
        ? 1
        : e.key === "ArrowUp" || e.key === "ArrowLeft"
          ? -1
          : 0;
    if (step === 0) return;
    e.preventDefault();
    const order = VERDICT_OPTIONS.map((o) => o.value);
    const from = value == null ? 0 : order.indexOf(value);
    const next = order[(from + step + order.length) % order.length]!;
    onChange(next);
    optionRefs.current[order.indexOf(next)]?.focus();
  };
  return (
    <li className="space-y-1 rounded-md border p-2">
      <p className="text-sm">{text}</p>
      <div
        role="radiogroup"
        aria-label={`Still needed? ${text}`}
        className="flex flex-wrap items-center gap-1"
      >
        <span className="mr-1 text-xs text-muted-foreground">Still needed?</span>
        {VERDICT_OPTIONS.map((opt, i) => (
          <Button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={value === opt.value}
            tabIndex={value == null ? (i === 0 ? 0 : -1) : value === opt.value ? 0 : -1}
            ref={(el) => {
              optionRefs.current[i] = el;
            }}
            onKeyDown={onKeyDown}
            variant={value === opt.value ? "default" : "outline"}
            size="sm"
            onClick={() => onChange(opt.value)}
          >
            {opt.label}
          </Button>
        ))}
      </div>
    </li>
  );
}

function DiffDetails({ diff }: { diff: ExperimentRunView["original_diff"] }) {
  if (!diff || diff.lines.length === 0) {
    return <p className="text-xs text-muted-foreground">No diff recorded.</p>;
  }
  return (
    <details className="rounded-md border">
      <summary className="cursor-pointer px-2 py-1 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        Show diff
      </summary>
      <div className="border-t p-2">
        <WhatChangedLines changes={diff} />
      </div>
    </details>
  );
}

function StageLine({ run }: { run: ExperimentRunView }) {
  const note = run.stage_note ?? "Working…";
  return (
    <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
      Testing… {note}
    </div>
  );
}

function FailedLine({
  run,
  busy,
  onTryAgain,
}: {
  run: ExperimentRunView;
  busy: boolean;
  onTryAgain: () => void;
}) {
  return (
    <div className="space-y-3 rounded-md border border-destructive/50 bg-destructive/5 p-6 text-sm">
      <p role="alert" className="text-destructive">
        {testFailedLine(run.error)}
      </p>
      <Button onClick={onTryAgain} disabled={busy}>
        {busy ? "Starting…" : "Try again"}
      </Button>
    </div>
  );
}

function Page() {
  const qc = useQueryClient();
  const search = Route.useSearch();
  const runId = search.run;

  const runQuery = useQuery({
    queryKey: ["harness-experiment-run", runId],
    queryFn: () => fetchExperimentRun(runId!),
    enabled: runId != null,
    refetchInterval: (query) => {
      const data = query.state.data;
      const status = data && data.available ? data.run.status : undefined;
      return status && IN_PROGRESS_STATUSES.has(status) ? POLL_MS : false;
    },
  });
  // The full improvements list -- already the same cache key every other
  // page (Suggestions, Inbox) reads from -- for the matching item's own
  // destination/write status ("Add it now" / "Remove from Knowledge").
  const improvementsQuery = useQuery({
    queryKey: ["harness-improvements"],
    queryFn: fetchImprovements,
  });

  const [verdicts, setVerdicts] = useState<(Verdict | null)[]>([]);
  const run = runQuery.data && runQuery.data.available ? runQuery.data.run : null;

  useEffect(() => {
    if (run) setVerdicts(run.corrections.map(() => null));
  }, [run]);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["harness-experiment-run", runId] });
    void qc.invalidateQueries({ queryKey: ["harness-improvements"] });
  };

  const { busy: actionBusy, run: runAction } = useRun(invalidate);

  const saveJudge = useMutation({
    mutationFn: (v: Verdict[]) => post({ action: "judge", run_id: runId!, verdicts: v }),
    onSuccess: () => {
      toast.success("Saved your verdicts.");
      invalidate();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not save your verdicts"),
  });

  if (runId == null) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Judge a test</h1>
        <p className="text-sm text-muted-foreground">No test was specified.</p>
      </div>
    );
  }

  if (runQuery.isLoading) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Judge a test</h1>
        <div className="rounded-md border p-6 text-sm text-muted-foreground">Loading…</div>
      </div>
    );
  }
  if (runQuery.isError || !runQuery.data?.available) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Judge a test</h1>
        <div
          role="alert"
          className="rounded-md border border-destructive/50 bg-destructive/5 p-6 text-sm text-destructive"
        >
          {runQuery.isError
            ? runQuery.error instanceof Error
              ? runQuery.error.message
              : "Failed to load."
            : (runQuery.data as { reason?: string } | undefined)?.reason ||
              "This test was not found."}
        </div>
      </div>
    );
  }

  const view = runQuery.data.run;
  const improvement = improvementsQuery.data?.improvements?.find(
    (i) => i.id === view.improvement_id,
  );
  const written = improvement ? lovableOf(improvement).write_status === "written" : false;

  const allChosen = verdicts.length > 0 ? verdicts.every((v) => v !== null) : true;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link
          to="/ledger"
          search={{ improvement: view.improvement_id }}
          className="text-sm text-primary underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          ← Suggestion
        </Link>
      </div>

      <h1 className="text-2xl font-semibold">{view.rule_text}</h1>

      {IN_PROGRESS_STATUSES.has(view.status) ? (
        <StageLine run={view} />
      ) : view.status === "failed" ? (
        <FailedLine
          run={view}
          busy={actionBusy}
          onTryAgain={() =>
            void runAction({ action: "test", id: view.improvement_id }, "Testing started.")
          }
        />
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            <section aria-labelledby="original-build" className="space-y-3 rounded-md border p-4">
              <h2 id="original-build" className="text-lg font-medium">
                Your original build
              </h2>
              <div className="space-y-1">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  You asked
                </p>
                <p className="whitespace-pre-wrap text-sm">{view.request_text}</p>
              </div>
              <div className="space-y-1">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Lovable replied
                </p>
                <p className="whitespace-pre-wrap text-sm">{view.original_reply}</p>
              </div>
              <DiffDetails diff={view.original_diff} />
              {view.corrections.length > 0 ? (
                <div className="space-y-1">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Corrections you made
                  </p>
                  {view.corrections_source === "follow_ups" ? (
                    <p className="text-xs text-muted-foreground">
                      {CORRECTIONS_FROM_FOLLOW_UPS_LINE}
                    </p>
                  ) : null}
                  <ul className="list-disc space-y-1 pl-5 text-sm">
                    {view.corrections.map((c, i) => (
                      <li key={i}>{c}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </section>

            <section aria-labelledby="with-the-rule" className="space-y-3 rounded-md border p-4">
              <h2 id="with-the-rule" className="text-lg font-medium">
                With the rule
              </h2>
              {view.copy_summary ? (
                <div className="space-y-1">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Summary
                  </p>
                  <p className="whitespace-pre-wrap text-sm">{view.copy_summary}</p>
                </div>
              ) : null}
              <div className="space-y-1">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Lovable replied
                </p>
                <p className="whitespace-pre-wrap text-sm">{view.copy_reply}</p>
              </div>
              <DiffDetails diff={view.copy_diff} />
              <p className="text-xs text-muted-foreground">{testCostLine(view.cost_credits)}</p>
            </section>
          </div>

          <div className="space-y-1 rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
            <p>{testCopyConfounderLine(view.edits_since_episode)}</p>
            <p>{TEST_ONE_BUILD_LINE}</p>
          </div>

          {view.status === "judged" ? (
            <div className="space-y-3 rounded-md border p-4">
              <p className="text-sm font-medium">
                {testedResultLine({ score: view.score, corrections: view.corrections.length })}
              </p>
              {improvement ? (
                <div className="flex flex-wrap items-center gap-2">
                  {!written ? (
                    <AddConfirm
                      item={improvement}
                      destination="project"
                      busy={actionBusy}
                      run={runAction}
                      trigger="Add it now"
                    />
                  ) : improvement.rule_id != null ? (
                    <RemoveFromKnowledgeConfirm
                      ruleId={improvement.rule_id}
                      busy={actionBusy}
                      run={runAction}
                    />
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="space-y-3 rounded-md border p-4">
              <h2 className="text-lg font-medium">Still needed?</h2>
              {view.corrections.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Nothing on record for this episode to judge.
                </p>
              ) : (
                <ul className="space-y-2">
                  {view.corrections.map((c, i) => (
                    <CorrectionVerdictRow
                      key={i}
                      text={c}
                      value={verdicts[i] ?? null}
                      onChange={(v) =>
                        setVerdicts((prev) => prev.map((p, idx) => (idx === i ? v : p)))
                      }
                    />
                  ))}
                </ul>
              )}
              <Button
                onClick={() => saveJudge.mutate(verdicts as Verdict[])}
                disabled={!allChosen || saveJudge.isPending}
              >
                {saveJudge.isPending ? "Saving…" : "Save"}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
