// The Tests page (Round 6c part B, owner's own ask, 2026-09-13: "It is
// better if we have a page dedicated for this so you can see status, and
// actual results, and somewhere we can collect feedback from the user
// about this"). One card per test run ever started, any status, newest
// first -- status in plain words and the measured cost. Reached from NAV
// (between History and Skills) and from every card's "Open Tests" link
// (improvement.tsx) and the judging screen's own "← Tests" link
// (judge.tsx). Only talks to the local Harness routes: fetchTestRuns (GET
// .../improvements?runs=1, not a seventh route) and executorQueryOptions
// (credits + undeleted copies, already the same cache key Projects/Settings
// read from).
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
// rule title is a real Link so the card stays keyboard-reachable.
//
// Round 9 Task 6 / spec §5: a row is now project / instruction / bold
// result label / "Started ⟨date⟩ · ⟨credits⟩ credits" only -- no per-build
// links (buildLinks) and no feedback control (FeedbackCell) in the list;
// the whole row opens Compare builds (/judge?run=), where both the build
// links and the feedback box already live. This also drops the page's own
// feedback mutation entirely -- Compare builds owns "action: feedback" now.
import { useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ProjectFilter, type ProjectFilterOption } from "@/components/harness/project-filter";
import {
  COPY_CREDITS_LINE,
  // ---- Round 8 Task 2 ----
  failedSummaryParts,
  // ---- end Round 8 Task 2 ----
  formatDate,
  testsPageCreditsLine,
  // ---- Round 9 Task 6 ----
  TESTS_INTRO_LINE,
  // ---- end Round 9 Task 6 ----
  // ---- Round 8 Task 5 ----
  ruleTitle,
  testStatusPhrase,
  // ---- end Round 8 Task 5 ----
} from "@/lib/harness-ux";
import {
  executorQueryOptions,
  fetchTestRuns,
  type ExperimentRunSummary,
} from "@/lib/improvements-client";

export const Route = createFileRoute("/_authenticated/tests")({
  head: () => ({
    meta: [
      { title: "Tests — Harness Ledger" },
      {
        name: "description",
        content: "Every test you've run: project, instruction, and result.",
      },
      { property: "og:title", content: "Tests — Harness Ledger" },
      {
        property: "og:description",
        content: "Every test you've run: project, instruction, and result.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Page,
});

// Round 9 Task 6: the intro sentence moved to harness-ux.ts's own
// TESTS_INTRO_LINE -- it no longer opens with judge.tsx's page title
// (TEST_A_RULE_PAGE_TITLE, now "Compare builds"), so this page has its own
// exact wording instead of reusing that constant.
const INTRO_LINE = TESTS_INTRO_LINE;
// Round 9 Task 6: the empty state used to point at the card's own "Test
// this rule" trigger; that trigger's own label is now the shared "Test"
// (INSTRUCTION_ACTION_LABELS.test, improvement.tsx), and "rule" is banned
// in UI copy (spec §2 vocabulary).
const EMPTY_LINE = 'No tests yet. Open an instruction and press "Test".';
// Round 9 Task 2: distinct from EMPTY_LINE above -- there ARE tests, just
// none for the chosen project.
const EMPTY_FILTERED_LINE = "No tests for this project yet.";
const UNAVAILABLE_LINE = "Tests are available when Harness Ledger runs on your machine.";
const IN_PROGRESS_STATUSES = new Set(["copying", "building"]);
const POLL_MS = 10_000;

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

// Round 8 Task 5 (review item 9): one <article> per run -- project name
// (small), the rule's title (medium weight; ruleTitle -- fix 2: the
// frontend-safe equivalent of harness/src/improvements.ts's own titleFor,
// bounded at 72 chars instead of an unbounded firstSentence), the bold
// plain-word status phrase, a failed run's own collapsed technical fold,
// and a combined Started/cost line.
//
// Fix round 2, 2026-09-19: the whole card is the click target to the
// judging screen -- no more separate "Open" link. Same pattern as
// instructions.tsx's RuleRow: onClick + cursor-pointer on the container,
// e.stopPropagation() on each interactive child, and the rule title kept
// as a real Link (RULE_LINK_CLASS) so the card stays keyboard-reachable.
//
// Round 9 Task 6 / spec §5: no build links, no feedback control, no notes
// -- the only interactive child left is the failed row's own collapsed
// "Technical details" fold, so it is the only stopPropagation guard now.
const RULE_LINK_CLASS =
  "text-left hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function TestCard({ run }: { run: ExperimentRunSummary }) {
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
      <p className="text-sm font-semibold">{testStatusPhrase(run)}</p>
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
    </article>
  );
}

function Page() {
  // Round 9 Task 2: the shared ProjectFilter narrows the run list by
  // run.project_id -- local state (not the URL) since nothing else on this
  // page links in pre-scoped to one project the way Inbox/Instructions do.
  const [projectFilter, setProjectFilter] = useState<string | "all">("all");

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

  // Round 9 Task 2: the shared ProjectFilter narrows this list by
  // run.project_id -- ExperimentRunSummary already carries the run's
  // source project id/name (project_id/project_name), so no new fetch.
  // Only offered once there's more than one project to choose between.
  const projectOptions: ProjectFilterOption[] = Array.from(
    new Map(
      runs
        .filter((r): r is ExperimentRunSummary & { project_id: string } => r.project_id != null)
        .map((r) => [r.project_id, { id: r.project_id, name: r.project_name ?? r.project_id }]),
    ).values(),
  );
  const visibleRuns =
    projectFilter === "all" ? runs : runs.filter((r) => r.project_id === projectFilter);

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

      {projectOptions.length >= 2 ? (
        <ProjectFilter options={projectOptions} value={projectFilter} onChange={setProjectFilter} />
      ) : null}

      {runs.length === 0 ? (
        <div className="rounded-md border border-dashed p-10 text-center text-sm text-muted-foreground">
          {EMPTY_LINE}
        </div>
      ) : visibleRuns.length === 0 ? (
        <div className="rounded-md border border-dashed p-10 text-center text-sm text-muted-foreground">
          {EMPTY_FILTERED_LINE}
        </div>
      ) : (
        <div className="space-y-3">
          {visibleRuns.map((run) => (
            <TestCard key={run.id} run={run} />
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
