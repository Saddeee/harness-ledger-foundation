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
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { WhatChangedLines } from "@/components/harness/timeline";
import { ConfirmAction, AdvancedDetails } from "@/components/harness/decision-layout";
import { AddConfirm, RemoveFromKnowledgeConfirm, useRun } from "@/components/harness/improvement";
import { ClampedText } from "@/components/harness/clamped-text";
import {
  conclusionDerivationLines,
  conclusionLine,
  copyDeletionLine,
  CORRECTIONS_FROM_FOLLOW_UPS_LINE,
  CORRECTIONS_LIST_LABEL,
  evidenceStrengthLine,
  evidenceStrengthTitle,
  formatDay,
  FULL_TECHNICAL_DETAILS_TITLE,
  HISTORICAL_RESULT_SUBTITLE,
  HISTORICAL_RESULT_TITLE,
  NO_ENVIRONMENT_RECORD_LINE,
  ORIGINAL_CORRECTION_LABEL,
  otherActiveRulesLine,
  REGRESSION_CHECKBOX_LABEL,
  RELEVANT_DIFFERENCE_INTRO,
  RELEVANT_DIFFERENCE_TITLE,
  replayEnvironmentRows,
  REPLAY_VERDICT_QUESTION,
  REPLAY_WITH_RULE_SUBTITLE,
  REPLAY_WITH_RULE_TITLE,
  TEST_A_RULE_PAGE_TITLE,
  testCopyConfounderLine,
  testCostLine,
  testedResultLine,
  testFailedLine,
  TEST_ONE_BUILD_LINE,
  TEST_MEMORY_CONFOUNDER_LINE,
  WHY_APPROXIMATION_TITLE,
} from "@/lib/harness-ux";
import {
  fetchExperimentRun,
  fetchImprovements,
  lovableOf,
  postImprovementAction as post,
  type ExperimentRunView,
  type TestBuildCopy,
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
      { title: `${TEST_A_RULE_PAGE_TITLE} — Harness Ledger` },
      {
        name: "description",
        content: "Your historical result next to a new Lovable build with the rule.",
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
  const [feedbackEditing, setFeedbackEditing] = useState(false);
  const [feedbackDraft, setFeedbackDraft] = useState("");
  // Checkpoint 2 2-D: the judge screen's optional regression checkbox --
  // reset alongside the per-correction verdicts whenever a new run loads.
  const [regression, setRegression] = useState(false);
  const run = runQuery.data && runQuery.data.available ? runQuery.data.run : null;

  useEffect(() => {
    if (run) {
      setVerdicts(run.corrections.map(() => null));
      setRegression(false);
    }
  }, [run]);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["harness-experiment-run", runId] });
    void qc.invalidateQueries({ queryKey: ["harness-improvements"] });
  };

  const { busy: actionBusy, run: runAction } = useRun(invalidate);

  const saveJudge = useMutation({
    mutationFn: (v: Verdict[]) =>
      post({ action: "judge", run_id: runId!, verdicts: v, regression }),
    onSuccess: () => {
      toast.success("Saved your verdicts.");
      invalidate();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not save your verdicts"),
  });

  // Round 6c part B: the same feedback box as the Tests page's own list --
  // a free-text note on this run, any status. `text` is the whole box's
  // current value, not a diff (setExperimentFeedback replaces it wholesale;
  // an empty string clears the note).
  const saveFeedback = useMutation({
    mutationFn: (text: string) => post({ action: "feedback", run_id: runId!, text }),
    onSuccess: () => {
      toast.success("Saved your feedback.");
      setFeedbackEditing(false);
      invalidate();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not save your feedback"),
  });

  if (runId == null) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">{TEST_A_RULE_PAGE_TITLE}</h1>
        <p className="text-sm text-muted-foreground">No test was specified.</p>
      </div>
    );
  }

  if (runQuery.isLoading) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">{TEST_A_RULE_PAGE_TITLE}</h1>
        <div className="rounded-md border p-6 text-sm text-muted-foreground">Loading…</div>
      </div>
    );
  }
  if (runQuery.isError || !runQuery.data?.available) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">{TEST_A_RULE_PAGE_TITLE}</h1>
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
      <div className="flex flex-wrap items-center gap-4">
        <Link
          to="/ledger"
          search={{ improvement: view.improvement_id }}
          className="text-sm text-primary underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          ← Back to the suggestion
        </Link>
        <Link
          to="/tests"
          className="text-sm text-primary underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          ← Tests
        </Link>
      </div>

      <div className="space-y-1">
        {view.project_name ? (
          <p className="text-sm font-semibold text-muted-foreground">{view.project_name}</p>
        ) : null}
        <h1 className="text-2xl font-semibold">{view.rule_text}</h1>
      </div>

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
          {/* (1) The original correction(s) the rule came from -- the
              request and the correction text(s), read-only context for
              everything below. */}
          <section className="space-y-3 rounded-md border p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {ORIGINAL_CORRECTION_LABEL}
            </p>
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">You asked Lovable</p>
              <ClampedText text={view.request_text} />
            </div>
            {view.corrections.length > 0 ? (
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">
                  {CORRECTIONS_LIST_LABEL}
                </p>
                <ul className="list-disc space-y-1 pl-5 text-sm">
                  {view.corrections.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
                {view.corrections_source === "follow_ups" ? (
                  <p className="text-xs text-muted-foreground">
                    {CORRECTIONS_FROM_FOLLOW_UPS_LINE}
                  </p>
                ) : null}
              </div>
            ) : null}
          </section>

          {/* (2)/(3) Historical result / Replay with rule, side by side. */}
          <div className="grid gap-4 md:grid-cols-2">
            <BuildColumn
              id="historical-result"
              title={HISTORICAL_RESULT_TITLE}
              subtitle={HISTORICAL_RESULT_SUBTITLE}
              copy={view.original_copy}
              noCopyLine={
                view.original_copy_error
                  ? `Harness Ledger could not copy your original build: ${view.original_copy_error}`
                  : view.show_original
                    ? null
                    : "No copy of the historical result was made for this test."
              }
              summary={view.original_summary}
              busy={actionBusy}
              onDelete={() =>
                void runAction(
                  { action: "delete_copy", run_id: view.id, which: "original" },
                  "Deleted the copy of your historical result.",
                )
              }
            />
            <BuildColumn
              id="replay-with-rule"
              title={REPLAY_WITH_RULE_TITLE}
              subtitle={REPLAY_WITH_RULE_SUBTITLE}
              copy={view.copy}
              noCopyLine={null}
              summary={view.copy_summary}
              footer={testCostLine(view.cost_credits)}
              busy={actionBusy}
              onDelete={() =>
                void runAction(
                  { action: "delete_copy", run_id: view.id, which: "with_rule" },
                  "Deleted the replay build.",
                )
              }
            />
          </div>

          <div className="space-y-1 rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
            <p>{testCopyConfounderLine(view.edits_since_episode)}</p>
            <p>{TEST_MEMORY_CONFOUNDER_LINE}</p>
            <p>{TEST_ONE_BUILD_LINE}</p>
          </div>

          {/* (4) Relevant visible difference: Lovable's own summary of each
              side, one under the other, plus the diff toggles -- no invented
              automatic verdict on the difference. */}
          <section className="space-y-3 rounded-md border p-4">
            <h2 className="text-lg font-medium">{RELEVANT_DIFFERENCE_TITLE}</h2>
            <p className="text-xs text-muted-foreground">{RELEVANT_DIFFERENCE_INTRO}</p>
            <div className="space-y-1">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {HISTORICAL_RESULT_TITLE}
              </p>
              {view.original_summary ? (
                <ClampedText text={view.original_summary} markdown />
              ) : (
                <p className="text-sm">No summary recorded.</p>
              )}
              <DiffDetails diff={view.original_diff} />
            </div>
            <div className="space-y-1">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {REPLAY_WITH_RULE_TITLE}
              </p>
              {view.copy_summary ? (
                <ClampedText text={view.copy_summary} markdown />
              ) : (
                <p className="text-sm">No summary recorded.</p>
              )}
              <DiffDetails diff={view.copy_diff} />
            </div>
          </section>

          {/* (5) User verdict: per-correction "Still needed?", the optional
              regression checkbox, and Save. */}
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
              <h2 className="text-lg font-medium">{REPLAY_VERDICT_QUESTION}</h2>
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
              <div className="flex items-start gap-2">
                <Checkbox
                  id="regression-flag"
                  checked={regression}
                  onCheckedChange={(v) => setRegression(v === true)}
                  className="mt-0.5"
                />
                <Label htmlFor="regression-flag" className="font-normal">
                  {REGRESSION_CHECKBOX_LABEL}
                </Label>
              </div>
              <Button
                onClick={() => saveJudge.mutate(verdicts as Verdict[])}
                disabled={!allChosen || saveJudge.isPending}
              >
                {saveJudge.isPending ? "Saving…" : "Save"}
              </Button>
            </div>
          )}

          {/* (6) Evidence strength, and (7) "Why this is an approximation"
              collapsed underneath it -- derived from the run's own
              environment record, never a silent fallback. */}
          <section className="space-y-2 rounded-md border p-4">
            {view.environment ? (
              <>
                <h2 className="text-lg font-medium">
                  {evidenceStrengthTitle(view.environment.quality)}
                </h2>
                <p className="text-sm">{evidenceStrengthLine(view.environment.quality)}</p>
                {view.conclusion ? (
                  <p className="text-sm font-medium">{conclusionLine(view.conclusion)}</p>
                ) : null}
                <AdvancedDetails title={WHY_APPROXIMATION_TITLE}>
                  <dl className="space-y-2 text-sm">
                    {replayEnvironmentRows(view.environment).map((row) => (
                      <div key={row.label}>
                        <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                          {row.label}
                        </dt>
                        <dd>{row.text}</dd>
                      </div>
                    ))}
                  </dl>
                </AdvancedDetails>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">{NO_ENVIRONMENT_RECORD_LINE}</p>
            )}
          </section>

          {/* (8) Full technical details, collapsed by default. */}
          <AdvancedDetails title={FULL_TECHNICAL_DETAILS_TITLE}>
            <div className="space-y-4">
              <div className="space-y-1">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {HISTORICAL_RESULT_TITLE}
                </p>
                <p className="text-xs text-muted-foreground">
                  {view.original_copy
                    ? `Project id: ${view.original_copy.project_id}`
                    : "No copy on record."}
                </p>
                <p className="text-xs text-muted-foreground">
                  {`Screenshot: ${view.original_copy?.screenshot_url ?? "none recorded"}`}
                </p>
                {view.original_copy ? (
                  <p className="text-xs text-muted-foreground">
                    {`Cleanup status: ${
                      copyDeletionLine(view.original_copy.deletion_status) ?? "Not deleted."
                    }`}
                  </p>
                ) : null}
                {view.original_reply ? (
                  <ClampedText text={view.original_reply} markdown />
                ) : (
                  <p className="text-sm">No reply recorded.</p>
                )}
              </div>
              <div className="space-y-1">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {REPLAY_WITH_RULE_TITLE}
                </p>
                <p className="text-xs text-muted-foreground">
                  {view.copy ? `Project id: ${view.copy.project_id}` : "No copy on record."}
                </p>
                <p className="text-xs text-muted-foreground">
                  {`Screenshot: ${view.copy?.screenshot_url ?? "none recorded"}`}
                </p>
                {view.copy ? (
                  <p className="text-xs text-muted-foreground">
                    {`Cleanup status: ${
                      copyDeletionLine(view.copy.deletion_status) ?? "Not deleted."
                    }`}
                  </p>
                ) : null}
                {view.copy_reply ? (
                  <ClampedText text={view.copy_reply} markdown />
                ) : (
                  <p className="text-sm">No reply recorded.</p>
                )}
              </div>
              {view.environment?.code_state.request_message_id ? (
                <p className="text-xs text-muted-foreground">
                  {`Request message id: ${view.environment.code_state.request_message_id}`}
                </p>
              ) : null}
              {otherActiveRulesLine(view.environment) ? (
                <p className="text-xs text-muted-foreground">
                  {otherActiveRulesLine(view.environment)}
                </p>
              ) : null}
              <div className="space-y-1">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  How the conclusion was derived
                </p>
                <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                  {conclusionDerivationLines({
                    verdicts: view.verdicts,
                    quality: view.environment?.quality ?? null,
                    regression_flag: view.environment?.regression_flag ?? null,
                  }).map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
              </div>
            </div>
          </AdvancedDetails>
        </>
      )}

      <section className="space-y-2 rounded-md border p-4">
        <h2 className="text-lg font-medium">Your feedback about this test</h2>
        {feedbackEditing ? (
          <div className="space-y-2">
            <Textarea
              aria-label="Your feedback about this test"
              value={feedbackDraft}
              onChange={(e) => setFeedbackDraft(e.target.value)}
              maxLength={2000}
              rows={3}
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={saveFeedback.isPending}
                onClick={() => saveFeedback.mutate(feedbackDraft)}
              >
                {saveFeedback.isPending ? "Saving…" : "Save"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={saveFeedback.isPending}
                onClick={() => setFeedbackEditing(false)}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-1">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setFeedbackDraft(view.feedback ?? "");
                setFeedbackEditing(true);
              }}
            >
              {view.feedback ? "Edit" : "Add feedback"}
            </Button>
            {view.feedback ? (
              <p className="whitespace-pre-wrap text-xs text-muted-foreground">
                {view.feedback}
                <br />
                {`Your note, ${formatDay(view.feedback_at)}`}
              </p>
            ) : null}
          </div>
        )}
      </section>
    </div>
  );
}

// Round 7 / Checkpoint 2026-09-18: one build, laid out the same way on both
// sides -- a look at it (screenshot, open in Lovable, open the preview) and
// Lovable's own summary, clamped with "See more" (owner review round 7 fix
// 2) rather than cut off for good. The full reply and the diff still live in
// the shared "Full technical details" and "Key difference" sections below;
// both sides are real Lovable projects the owner can keep building on, or
// delete from here.
function BuildColumn({
  id,
  title,
  subtitle,
  copy,
  noCopyLine,
  summary,
  footer,
  busy,
  onDelete,
}: {
  id: string;
  title: string;
  subtitle: string;
  copy: TestBuildCopy | null;
  noCopyLine: string | null;
  summary: string | null;
  footer?: string;
  busy: boolean;
  onDelete: () => void;
}) {
  return (
    <section aria-labelledby={id} className="space-y-3 rounded-md border p-4">
      <div>
        <h2 id={id} className="text-lg font-medium">
          {title}
        </h2>
        <p className="text-xs text-muted-foreground">{subtitle}</p>
      </div>

      {copy?.screenshot_url ? (
        copy.deleted ? (
          <img
            src={copy.screenshot_url}
            alt={`Screenshot: ${title.toLowerCase()}`}
            className="w-full rounded-md border"
          />
        ) : (
          <a href={copy.preview_url} target="_blank" rel="noreferrer">
            <img
              src={copy.screenshot_url}
              alt={`Screenshot: ${title.toLowerCase()}`}
              className="w-full rounded-md border"
            />
          </a>
        )
      ) : copy && !copy.deleted ? (
        <p className="text-xs text-muted-foreground">
          No screenshot yet. Open the build to look at it.
        </p>
      ) : null}

      {copy && !copy.deleted ? (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <a
            href={copy.preview_url}
            target="_blank"
            rel="noreferrer"
            className="text-primary underline underline-offset-2"
          >
            Open the app
          </a>
          <a
            href={copy.editor_url}
            target="_blank"
            rel="noreferrer"
            className="text-primary underline underline-offset-2"
          >
            Open in Lovable
          </a>
          <ConfirmAction
            trigger="Delete copy"
            variant="ghost"
            size="sm"
            title="Delete this copy in Lovable?"
            body="The project is deleted from your Lovable workspace. This can't be undone."
            consequences={["Your own project is not touched."]}
            confirmLabel="Delete copy"
            disabled={busy}
            onConfirm={onDelete}
          />
        </div>
      ) : copy?.deleted ? (
        <p className="text-xs text-muted-foreground">
          The project copy was deleted; the screenshot above is what it looked like.
        </p>
      ) : noCopyLine ? (
        <p className="text-xs text-muted-foreground">{noCopyLine}</p>
      ) : null}

      {summary ? (
        <div className="space-y-1">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Lovable's summary of the change
          </p>
          <ClampedText text={summary} markdown lines={3} />
        </div>
      ) : null}
      {footer ? <p className="text-xs text-muted-foreground">{footer}</p> : null}
    </section>
  );
}
