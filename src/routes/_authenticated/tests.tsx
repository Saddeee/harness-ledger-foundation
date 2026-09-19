// The Tests page (Round 6c part B, owner's own ask, 2026-09-13: "It is
// better if we have a page dedicated for this so you can see status, and
// actual results, and somewhere we can collect feedback from the user
// about this"). One card per test run ever started, any status, newest
// first -- status in plain words, the measured cost, and a small feedback
// box per card. Reached from NAV (between History and Skills) and from
// every card's "See on Tests" link (improvement.tsx) and the judging
// screen's own "← Tests" link (judge.tsx). Only talks to the local Harness
// routes: fetchTestRuns (GET .../improvements?runs=1, not a seventh
// route), executorQueryOptions (credits + undeleted copies, already the
// same cache key Projects/Settings read from), and postImprovementAction
// for the "feedback" action.
//
// Round 8 Task 5 (review item 9): the 8-column table became a card list --
// one <article> per run instead of one row, the Kind/Evidence columns are
// gone (the card's own status phrase already names the outcome once
// judged), and a failed run's raw Lovable error moves into a collapsed
// "Technical details" fold instead of showing inline.
//
// Fix round 2, 2026-09-19 (owner feedback, final demo round): "fix tests so
// it uses cards because I don't like the Open button; also ... text stops
// in the middle of the screen and continues on the next row." The whole
// card is now the click target to the judging screen -- same
// onClick-container/stopPropagation-on-interactive-children pattern as
// instructions.tsx's RuleRow -- and the small "Open" text link is gone; the
// rule title is a real Link so the card stays keyboard-reachable. The
// feedback note is no longer capped to a narrow fixed width -- it spans
// the card's full width instead of wrapping at ~320px inside a 1000px card.
import { useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  COPY_CREDITS_LINE,
  // ---- Round 8 Task 2 ----
  failedSummaryParts,
  // ---- end Round 8 Task 2 ----
  formatDate,
  formatDay,
  HISTORICAL_RESULT_TITLE,
  REPLAY_WITH_RULE_TITLE,
  TEST_A_RULE_PAGE_TITLE,
  testsPageCreditsLine,
  // ---- Round 8 Task 5 ----
  ruleTitle,
  testStatusPhrase,
  // ---- end Round 8 Task 5 ----
} from "@/lib/harness-ux";
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
        content: "Every replay you've run: status, results, and your own notes.",
      },
      { property: "og:title", content: "Tests — Harness Ledger" },
      {
        property: "og:description",
        content: "Every replay you've run: status, results, and your own notes.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Page,
});

const INTRO_LINE = `${TEST_A_RULE_PAGE_TITLE}: each test shows your project's historical result at the moment before a real request, next to one new Lovable build made from that same point with a candidate rule added, and lets you say whether the original correction would still be needed.`;
const EMPTY_LINE = 'No tests yet. Open a suggestion and press "Test this rule".';
const UNAVAILABLE_LINE = "Tests are available when Harness Ledger runs on your machine.";
const IN_PROGRESS_STATUSES = new Set(["copying", "building"]);
const POLL_MS = 10_000;

// Round 7: the test's builds are real Lovable projects -- open them from
// the list without going through the comparison. Round 8 Task 5 fix 3: both
// link labels now reuse the judge page's own HISTORICAL_RESULT_TITLE/
// REPLAY_WITH_RULE_TITLE constants instead of a second, separately-worded
// pair of strings.
function buildLinks(run: ExperimentRunSummary) {
  const links = [
    run.original_copy && !run.original_copy.deleted
      ? { label: HISTORICAL_RESULT_TITLE, href: run.original_copy.editor_url }
      : null,
    run.copy && !run.copy.deleted
      ? { label: REPLAY_WITH_RULE_TITLE, href: run.copy.editor_url }
      : null,
  ].filter((l): l is { label: string; href: string } => l !== null);
  if (links.length === 0) return null;
  return (
    <span className="mt-1 flex flex-wrap gap-3 text-xs" onClick={(e) => e.stopPropagation()}>
      {links.map((l) => (
        <a
          key={l.label}
          href={l.href}
          target="_blank"
          rel="noreferrer"
          className="text-muted-foreground underline underline-offset-2"
        >
          {`${l.label} in Lovable`}
        </a>
      ))}
    </span>
  );
}

function costCell(run: ExperimentRunSummary): string {
  return run.cost_credits == null
    ? "—"
    : `${run.cost_credits} credit${run.cost_credits === 1 ? "" : "s"} · measured`;
}

// Fix round 2, 2026-09-19: Started and the measured cost collapse onto one
// compact line ("Started <date> · N credits · measured") instead of two --
// when there's no cost yet, this reads as just the Started half.
function startedCostLine(run: ExperimentRunSummary): string {
  const started = `Started ${formatDate(run.started_at)}`;
  const cost = costCell(run);
  return cost === "—" ? started : `${started} · ${cost}`;
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
      <div className="w-full min-w-[220px] space-y-2">
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
        <p className="whitespace-pre-wrap text-xs text-muted-foreground">
          {run.feedback}
          <br />
          {`Your note, ${formatDay(run.feedback_at)}`}
        </p>
      ) : null}
    </div>
  );
}

// Round 8 Task 5 (review item 9): one <article> per run -- project name
// (small), the rule's title (medium weight; ruleTitle -- fix 2: the
// frontend-safe equivalent of harness/src/improvements.ts's own titleFor,
// bounded at 72 chars instead of an unbounded firstSentence), the
// plain-word status phrase, a failed run's own collapsed technical fold,
// a combined Started/cost line, and the existing feedback control.
//
// Fix round 2, 2026-09-19: the whole card is the click target to the
// judging screen -- no more separate "Open" link. Same pattern as
// instructions.tsx's RuleRow: onClick + cursor-pointer on the container,
// e.stopPropagation() on each interactive child (build links, the
// Technical details fold, the feedback control), and the rule title kept
// as a real Link (RULE_LINK_CLASS) so the card stays keyboard-reachable.
const RULE_LINK_CLASS =
  "text-left hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function TestCard({
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
  const navigate = useNavigate();
  const failed = run.status === "failed" ? failedSummaryParts(run.error) : null;
  return (
    <article
      onClick={() => navigate({ to: "/judge", search: { run: run.id } })}
      className="cursor-pointer space-y-2 rounded-md border p-4 hover:bg-muted/40"
    >
      <p className="text-xs font-medium text-muted-foreground">{run.project_name ?? "—"}</p>
      <p className="text-base font-medium">
        <Link to="/judge" search={{ run: run.id }} className={RULE_LINK_CLASS}>
          {ruleTitle(run.rule_text)}
        </Link>
      </p>
      <p className="text-sm">{testStatusPhrase(run)}</p>
      {failed ? (
        <div className="space-y-1" onClick={(e) => e.stopPropagation()}>
          <p className="text-xs text-muted-foreground">{failed.plain}</p>
          {failed.technical ? (
            <details className="rounded-md border">
              <summary className="cursor-pointer px-2 py-1 text-xs font-medium text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                Technical details
              </summary>
              <p className="border-t p-2 text-xs text-muted-foreground">{failed.technical}</p>
            </details>
          ) : null}
        </div>
      ) : null}
      <p className="text-xs text-muted-foreground">{startedCostLine(run)}</p>
      {buildLinks(run)}
      <div onClick={(e) => e.stopPropagation()}>
        <FeedbackCell
          run={run}
          editing={editing}
          draft={draft}
          busy={busy}
          onStartEdit={onStartEdit}
          onChangeDraft={onChangeDraft}
          onCancel={onCancel}
          onSave={onSave}
        />
      </div>
    </article>
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
        <p className="text-sm text-muted-foreground">{COPY_CREDITS_LINE}</p>
        {credits ? (
          <p className="text-sm text-muted-foreground">{testsPageCreditsLine(credits)}</p>
        ) : null}
      </div>

      {runs.length === 0 ? (
        <div className="rounded-md border border-dashed p-10 text-center text-sm text-muted-foreground">
          {EMPTY_LINE}
        </div>
      ) : (
        <div className="space-y-3">
          {runs.map((run) => (
            <TestCard
              key={run.id}
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
          ))}
        </div>
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
