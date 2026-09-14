// One "Improvement" per piece of feedback the user gave Lovable: the
// correction and its proposed instruction, presented as one card whose
// buttons are the decision. Simple by default, complete on demand. Only
// fetches the local Harness routes; never talks to Lovable itself -- adding
// to Lovable is recorded here and executed by Harness afterwards.
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import {
  AdvancedDetails,
  ConfirmAction,
  DetailSection,
} from "@/components/harness/decision-layout";
import {
  ALREADY_RECORDED_TOAST,
  adherenceLine,
  CLASSIFICATION_LABELS,
  DESTINATION_LABELS,
  evidenceSourceLines,
  healthLine,
  KNOWLEDGE_CHAR_LIMIT,
  decisionSentence,
  formatDate,
  formatDay,
  label,
  lovableReplyText,
  proveCostLine,
  REMOVE_FROM_KNOWLEDGE_BODY,
  REMOVE_FROM_KNOWLEDGE_CONFIRM_LABEL,
  REMOVE_FROM_KNOWLEDGE_TITLE,
  retireReasonSentence,
  retireSinceLine,
  SEE_ON_TESTS_LABEL,
  START_TEST_LABEL,
  TEST_ONE_AT_A_TIME_LINE,
  TEST_STARTED_TOAST,
  TEST_THIS_RULE_BODY,
  TEST_THIS_RULE_CREDITS_LINE,
  TEST_THIS_RULE_TITLE,
  TEST_FIRST_HELP,
  TEST_FIRST_LABEL,
  SHOW_ORIGINAL_HELP,
  SHOW_ORIGINAL_LABEL,
  workspaceWordingWarning,
  TEST_VERDICT_NEEDED_LABEL,
  testedResultLine,
  testFailedLine,
  testInProgressLine,
  testThisRuleBudgetLine,
  UNDO_TOAST,
  VERDICT_TEXT,
  verdictEffectLine,
  verdictLine,
  type StatusCtx,
  type VerdictEffect,
  versionStatusLine,
  whyFor,
  wordingChangeLine,
} from "@/lib/harness-ux";

import {
  executorQueryOptions,
  groupOf,
  lovableOf,
  postImprovementAction as post,
  projectName,
  toastWriteOutcome,
  type Improvement,
  type TestInfo,
  type Message,
} from "@/lib/improvements-client";

export type { Improvement, Message };

// ---- Shared copy (kept in one place so the tests can count it) ----

// Round 6 Task 2 / spec §2: pressing "Add" always attempts to write
// immediately when Harness is connected -- reaching this body at all means
// there's no Knowledge snapshot yet to compose against (Harness has never
// read this target), which Sync now fixes.
const NO_SNAPSHOT_BODY =
  "Harness Ledger hasn't read your current Knowledge yet. Your choice is saved; press Sync now on the Projects page, then Harness Ledger reads it and writes this exact text. You can see the result on the Instructions page.";
const PREVIEW_BODY = "This is the exact text Harness Ledger will write to your Lovable Knowledge.";
// Addendum to Round 6 Task 4: "restore" alone overstated what's actually on
// offer from this card -- Remove from Knowledge lives here (Round 6 Task 3),
// while restoring an earlier version is a History-page-only action.
const PREVIEW_CONSEQUENCES = [
  "You can remove it from Knowledge or restore an earlier version from History at any time.",
];
const OVER_CAP_LINE =
  "This would exceed the Knowledge limit — shorten the instruction or your existing Knowledge first.";
function overRulesLine(activeRulesCount: number): string {
  return `This project already has ${activeRulesCount} active rules. Retire one on the Instructions page first.`;
}
// Round 6 Task 2: the real toast text comes from the write outcome
// (writeToastText, below) -- these four are only the defensive fallback for
// a response that somehow carries no `write` field at all.
const SAVED_LINE = "Added.";
const NO_INSTRUCTION = "Harness Ledger hasn't drafted an instruction yet.";
const ADD_NOW_HELP =
  "Harness Ledger writes this exact text now, when you press Add. Uses no credits.";
const RETIRE_TITLE = "Retire this rule?";
const RETIRE_BODY = "Harness Ledger rewrites your Knowledge without it right away.";
const RETIRE_CONSEQUENCES = ["You can re-add it later from Suggestions."];
const RETIRED_TOAST = "Retired.";
const KEPT_TOAST = "Kept — Harness Ledger will ask again in 30 days";
const READDED_TOAST = "Re-added.";
// Round 6 Task 3 / spec §3: "Remove from Knowledge" replaces "Restore
// previous version" on a written rule's card -- it retires the rule and
// rewrites Knowledge without it immediately (the same "retire" action,
// through improvementActionAndWrite, so the response carries `write`).
// Restore itself moved to the History page only.
const REMOVED_TOAST = "Removed from Knowledge.";

const LONG_TEXT = 600;

// Round 6 Task 4 / spec §4: one action bar per card, all buttons the same
// size and gap, wrapping as a row -- the exact class every card's bar uses
// (kept as one constant so the tests can count it: exactly one per rendered
// card, never a second bar sharing space with anything else).
const ACTION_BAR_CLASS = "flex flex-wrap items-center gap-2";

type Destination = "project" | "workspace";

const ADD_LABELS: Record<Destination, string> = {
  project: "Add to this project",
  workspace: "Add to all my projects",
};

export type Run = (body: Record<string, unknown>, msg: string) => Promise<boolean>;

// One busy flag and one toast pattern per card (or per wording editor).
// onChanged also receives the exact toast text, so a caller (the Inbox) can
// show that same sentence in a confirmation row instead of just refetching.
// Round 6 Task 2: when the response carries a `write` outcome (every
// write-eligible action does -- accept unless test_first, retire, readd,
// restore, change_wording of a written rule, retry_write), the toast reads
// that outcome ("Written to Lovable 19:05" or the plain-language reason)
// instead of the caller's static `msg` -- see writeToastText.
export function useRun(onChanged: (msg: string) => void): { busy: boolean; run: Run } {
  const [busy, setBusy] = useState(false);
  const run: Run = async (body, msg) => {
    setBusy(true);
    try {
      const result = await post(body);
      const text = toastWriteOutcome(result.write, msg);
      onChanged(text);
      return true;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "action failed");
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}

function excerptText(text: string, max: number): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length <= max ? t : `${t.slice(0, max).replace(/\s+\S*$/, "")}…`;
}

// ---- Confirmations ----

// The "Add" confirmation: shows the exact text that would be written when
// Harness has a snapshot of the current Knowledge; otherwise records the
// choice and says so.
export function AddConfirm({
  item,
  destination,
  busy,
  run,
  trigger,
  variant,
  size,
}: {
  item: Improvement;
  destination: Destination;
  busy: boolean;
  run: Run;
  trigger?: string;
  variant?: "default" | "outline";
  size?: "default" | "sm" | undefined;
}) {
  const [choice, setChoice] = useState<"now" | "test" | null>(null);
  const [showOriginal, setShowOriginal] = useState(true);
  const wantsTest = choice === "test";
  const canTest = item.test?.available === true;
  const wordingWarning =
    destination === "workspace"
      ? workspaceWordingWarning(item.proposed_instruction, item.project.name)
      : null;
  // A radiogroup is one tab stop: arrows move between the options and only
  // the selected one (or the first, before anything is chosen) is tabbable.
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const onOptionKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    const step =
      e.key === "ArrowDown" || e.key === "ArrowRight"
        ? 1
        : e.key === "ArrowUp" || e.key === "ArrowLeft"
          ? -1
          : 0;
    if (step === 0) return;
    e.preventDefault();
    const order = ["now", "test"] as const;
    const from = choice == null ? 0 : order.indexOf(choice);
    const next = order[(from + step + order.length) % order.length]!;
    setChoice(next);
    optionRefs.current[order.indexOf(next)]?.focus();
  };
  const preview = lovableOf(item).previews[destination];
  const targetLabel = preview?.target_label ?? label(DESTINATION_LABELS, destination);
  const overCap = preview?.over_cap === true;
  const overRules = preview?.over_rules === true;
  return (
    <ConfirmAction
      trigger={trigger ?? ADD_LABELS[destination]}
      title={wantsTest ? TEST_THIS_RULE_TITLE : `Add to ${targetLabel}?`}
      body={wantsTest ? TEST_THIS_RULE_BODY : preview ? PREVIEW_BODY : NO_SNAPSHOT_BODY}
      consequences={
        wantsTest && item.test ? testConfirmLines(item.test) : preview ? PREVIEW_CONSEQUENCES : []
      }
      confirmLabel={wantsTest ? START_TEST_LABEL : preview ? "Add" : "Save choice"}
      confirmDisabled={(!wantsTest && (overCap || overRules)) || choice == null}
      disabled={busy}
      size={size}
      onOpenChange={(open) => {
        if (!open) setChoice(null);
      }}
      {...(variant ? { variant } : {})}
      onConfirm={() =>
        void (async () => {
          // Round 6 Task 6b / spec §6: "Add and test it first" is now the
          // real paired test, not the old test_first staging (approve the
          // rule, write nothing, wait for a proof pass that never ran) --
          // accept writes immediately (Round 6 Task 2), then a `test`
          // action queues the paired test on the now-written rule. A
          // failed second call (e.g. over budget) still leaves the first
          // one's own accept in place; its own toast explains why.
          // Round 7: "Test it first" adds nothing -- the rule is tested, you
          // compare both builds, and add it from the test afterwards.
          if (wantsTest) {
            await run(
              { action: "test", id: item.id, show_original: showOriginal },
              TEST_STARTED_TOAST,
            );
            return;
          }
          await run({ action: "accept", id: item.id, destination }, SAVED_LINE);
        })()
      }
    >
      <div role="radiogroup" aria-label="How to add it" className="space-y-3">
        <div className="space-y-1">
          <Button
            type="button"
            role="radio"
            aria-checked={choice === "now"}
            tabIndex={choice === "test" ? -1 : 0}
            ref={(el) => {
              optionRefs.current[0] = el;
            }}
            onKeyDown={onOptionKeyDown}
            variant={choice === "now" ? "default" : "outline"}
            className="w-full sm:w-auto"
            onClick={() => setChoice("now")}
          >
            Add it now
          </Button>
          <p className="text-xs text-muted-foreground">{ADD_NOW_HELP}</p>
        </div>
        <div className="space-y-1">
          <Button
            type="button"
            role="radio"
            aria-checked={choice === "test"}
            tabIndex={choice === "test" ? 0 : -1}
            ref={(el) => {
              optionRefs.current[1] = el;
            }}
            onKeyDown={onOptionKeyDown}
            variant={choice === "test" ? "default" : "outline"}
            className="w-full sm:w-auto"
            onClick={() => setChoice("test")}
            disabled={!canTest}
          >
            {TEST_FIRST_LABEL}
          </Button>
          <p className="text-xs text-muted-foreground">
            {canTest
              ? `${TEST_FIRST_HELP} ${proveCostLine()}`
              : (item.test?.unavailable_reason ?? "This suggestion can't be tested.")}
          </p>
          {wantsTest ? (
            <ShowOriginalChoice checked={showOriginal} onChange={setShowOriginal} />
          ) : null}
        </div>
      </div>
      {wordingWarning ? (
        <p role="alert" className="text-xs text-destructive">
          {wordingWarning}
        </p>
      ) : null}
      {preview && !wantsTest ? (
        <div className="space-y-2">
          <details className="rounded-md border">
            <summary className="cursor-pointer px-2 py-1 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              Your existing Knowledge (unchanged)
            </summary>
            <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words border-t px-2 py-2 text-xs">
              {preview.current_user_text || "(nothing yet)"}
            </pre>
          </details>
          <pre className="max-h-60 overflow-y-auto whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-2 text-xs">
            {preview.managed_block}
          </pre>
          <p className="text-xs text-muted-foreground">
            {preview.char_count} of {KNOWLEDGE_CHAR_LIMIT.toLocaleString("en-US")} characters
          </p>
          {overCap ? (
            <p role="alert" className="text-xs text-destructive">
              {OVER_CAP_LINE}
            </p>
          ) : null}
          {overRules ? (
            <p role="alert" className="text-xs text-destructive">
              {overRulesLine(preview.active_rules_count)}
            </p>
          ) : null}
        </div>
      ) : null}
    </ConfirmAction>
  );
}

// Round 5 Task 5 / spec §4b: "why" toasts. WRONG_WORDING_TOAST fires only
// when that one reason was chosen; every other case (including no reason at
// all) gets the plain default below.
const WRONG_WORDING_TOAST = "Skipped — reopen it from Suggestions to fix the wording.";
const SKIPPED_TOAST = "Skipped";

type SkipReasonValue = "not_useful" | "wrong_wording" | "one_time" | "already_covered";
const SKIP_REASON_ORDER: SkipReasonValue[] = [
  "not_useful",
  "wrong_wording",
  "one_time",
  "already_covered",
];

function SkipConfirm({
  item,
  busy,
  run,
  size,
}: {
  item: Improvement;
  busy: boolean;
  run: Run;
  size?: "default" | "sm" | undefined;
}) {
  const [reason, setReason] = useState<SkipReasonValue | null>(null);
  // Same roving-tabindex radiogroup pattern as AddConfirm's own above:
  // arrows move between the four options, only the selected one (or the
  // first, before anything is chosen) is tabbable.
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const onOptionKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    const step =
      e.key === "ArrowDown" || e.key === "ArrowRight"
        ? 1
        : e.key === "ArrowUp" || e.key === "ArrowLeft"
          ? -1
          : 0;
    if (step === 0) return;
    e.preventDefault();
    const from = reason == null ? 0 : SKIP_REASON_ORDER.indexOf(reason);
    const next =
      SKIP_REASON_ORDER[(from + step + SKIP_REASON_ORDER.length) % SKIP_REASON_ORDER.length]!;
    setReason(next);
    optionRefs.current[SKIP_REASON_ORDER.indexOf(next)]?.focus();
  };
  return (
    <ConfirmAction
      trigger="Skip"
      variant="ghost"
      size={size}
      title="Skip this suggestion?"
      body="Harness Ledger won't suggest it again."
      consequences={["Nothing changes in Lovable."]}
      confirmLabel="Skip"
      disabled={busy}
      onOpenChange={(open) => {
        if (!open) setReason(null);
      }}
      onConfirm={() =>
        void run(
          { action: "skip", id: item.id, ...(reason ? { reason } : {}) },
          reason === "wrong_wording" ? WRONG_WORDING_TOAST : SKIPPED_TOAST,
        )
      }
    >
      <div role="radiogroup" aria-label="Why? (optional)" className="space-y-1">
        <p className="text-xs font-medium text-muted-foreground">Why? (optional)</p>
        <Button
          type="button"
          role="radio"
          aria-checked={reason === "not_useful"}
          tabIndex={reason == null || reason === "not_useful" ? 0 : -1}
          ref={(el) => {
            optionRefs.current[0] = el;
          }}
          onKeyDown={onOptionKeyDown}
          variant={reason === "not_useful" ? "default" : "outline"}
          size="sm"
          className="mr-1 mb-1"
          onClick={() => setReason(reason === "not_useful" ? null : "not_useful")}
        >
          Not useful
        </Button>
        <Button
          type="button"
          role="radio"
          aria-checked={reason === "wrong_wording"}
          tabIndex={reason === "wrong_wording" ? 0 : -1}
          ref={(el) => {
            optionRefs.current[1] = el;
          }}
          onKeyDown={onOptionKeyDown}
          variant={reason === "wrong_wording" ? "default" : "outline"}
          size="sm"
          className="mr-1 mb-1"
          onClick={() => setReason(reason === "wrong_wording" ? null : "wrong_wording")}
        >
          Wrong wording
        </Button>
        <Button
          type="button"
          role="radio"
          aria-checked={reason === "one_time"}
          tabIndex={reason === "one_time" ? 0 : -1}
          ref={(el) => {
            optionRefs.current[2] = el;
          }}
          onKeyDown={onOptionKeyDown}
          variant={reason === "one_time" ? "default" : "outline"}
          size="sm"
          className="mr-1 mb-1"
          onClick={() => setReason(reason === "one_time" ? null : "one_time")}
        >
          One-time thing
        </Button>
        <Button
          type="button"
          role="radio"
          aria-checked={reason === "already_covered"}
          tabIndex={reason === "already_covered" ? 0 : -1}
          ref={(el) => {
            optionRefs.current[3] = el;
          }}
          onKeyDown={onOptionKeyDown}
          variant={reason === "already_covered" ? "default" : "outline"}
          size="sm"
          className="mr-1 mb-1"
          onClick={() => setReason(reason === "already_covered" ? null : "already_covered")}
        >
          Already covered
        </Button>
      </div>
    </ConfirmAction>
  );
}

// ---- Retirement proposals (Task C2 / spec §4b-§5): kind "retire" items ----

// `proposalId` (from an open retire_proposals row, the Inbox item) or
// `ruleId` (the manual path, from the Instructions page's per-rule Retire
// button, with no proposal necessarily open) -- exactly one is passed.
function RetireConfirm({
  proposalId,
  ruleId,
  busy,
  run,
  trigger,
  variant,
  size,
}: {
  proposalId?: number;
  ruleId?: number;
  busy: boolean;
  run: Run;
  trigger?: string;
  variant?: "default" | "outline";
  size?: "default" | "sm" | undefined;
}) {
  return (
    <ConfirmAction
      trigger={trigger ?? "Retire"}
      {...(variant ? { variant } : {})}
      size={size}
      title={RETIRE_TITLE}
      body={RETIRE_BODY}
      consequences={RETIRE_CONSEQUENCES}
      confirmLabel="Retire"
      disabled={busy}
      onConfirm={() =>
        void run(
          proposalId != null
            ? { action: "retire", id: -proposalId }
            : { action: "retire", rule_id: ruleId },
          RETIRED_TOAST,
        )
      }
    />
  );
}

// Round 6 Task 3 / spec §3: replaces the old restore-to-an-earlier-version
// button on a written rule's card (Restore itself now lives on the History
// page only). Same underlying action as RetireConfirm above (this
// item's own rule is definitely live, so it's always addressed by
// rule_id -- never a retire-proposal id), but its own copy: the confirm
// explains what happens to Knowledge, not that the rule is "retired".
export function RemoveFromKnowledgeConfirm({
  ruleId,
  busy,
  run,
  size,
}: {
  ruleId: number;
  busy: boolean;
  run: Run;
  size?: "default" | "sm" | undefined;
}) {
  return (
    <ConfirmAction
      trigger="Remove from Knowledge"
      variant="outline"
      size={size}
      title={REMOVE_FROM_KNOWLEDGE_TITLE}
      body={REMOVE_FROM_KNOWLEDGE_BODY}
      consequences={[]}
      confirmLabel={REMOVE_FROM_KNOWLEDGE_CONFIRM_LABEL}
      disabled={busy}
      onConfirm={() => void run({ action: "retire", rule_id: ruleId }, REMOVED_TOAST)}
    />
  );
}

// ---- Round 6 Task 6b / spec §6: "Test this rule" ----
// TestButton (the confirm dialog, placed inside the shared action bar) and
// TestStatusLine (a muted status paragraph, placed alongside healthLine/
// adherenceLine -- never inside the bar itself, same convention those two
// already use) are deliberately separate: a card's action bar holds only
// buttons (the "no hardcoded size literal" / "one action bar" structural
// tests scan for exactly that), while a status line is plain text.

function TestButton({
  item,
  busy,
  run,
  size,
}: {
  item: Improvement;
  busy: boolean;
  run: Run;
  size?: "default" | "sm" | undefined;
}) {
  const [showOriginal, setShowOriginal] = useState(true);
  if (!item.test?.available) return null;
  return (
    <ConfirmAction
      trigger="Test this rule"
      variant="outline"
      size={size}
      title={TEST_THIS_RULE_TITLE}
      body={TEST_THIS_RULE_BODY}
      consequences={testConfirmLines(item.test)}
      confirmLabel={START_TEST_LABEL}
      disabled={busy}
      onConfirm={() =>
        void run({ action: "test", id: item.id, show_original: showOriginal }, TEST_STARTED_TOAST)
      }
    >
      <ShowOriginalChoice checked={showOriginal} onChange={setShowOriginal} />
    </ConfirmAction>
  );
}

// The paired test's own consequence lines -- one place, shared by "Test this
// rule" and the Add dialog's "Test it first".
function testConfirmLines(test: TestInfo): string[] {
  return [
    TEST_THIS_RULE_CREDITS_LINE,
    testThisRuleBudgetLine(test.credits),
    TEST_ONE_AT_A_TIME_LINE,
  ];
}

// Round 7: whether the test also makes a free copy of the original build,
// so both builds can be opened side by side.
function ShowOriginalChoice({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input
        type="checkbox"
        className="mt-1"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="space-y-0.5">
        <span className="block">{SHOW_ORIGINAL_LABEL}</span>
        <span className="block text-xs text-muted-foreground">{SHOW_ORIGINAL_HELP}</span>
      </span>
    </label>
  );
}

// The card's own status line for a rule's latest paired-test run --
// whichever of "testing…", "your verdict is needed", the judged result, or
// the failure sentence applies; falls back to the plain unavailable reason
// only once a run exists (nothing here, on a run with no result yet) or the
// item has been accepted -- never on a still-pending Inbox card (spec: "do
// not clutter pending Inbox cards").
function TestStatusLine({ item }: { item: Improvement }) {
  const test = item.test;
  if (!test) return null;
  const run = test.run;
  if (run) {
    switch (run.status) {
      case "queued":
      case "copying":
      case "building": {
        const line = testInProgressLine(run.status);
        return line ? <p className="text-xs text-muted-foreground">{line}</p> : null;
      }
      case "judging":
        return (
          <p className="text-xs text-muted-foreground">
            <Link
              to="/judge"
              search={{ run: run.id }}
              className="text-primary underline underline-offset-2"
            >
              {TEST_VERDICT_NEEDED_LABEL} →
            </Link>
          </p>
        );
      case "judged":
        return (
          <p className="text-xs text-muted-foreground">
            {testedResultLine(run)}{" "}
            <Link
              to="/judge"
              search={{ run: run.id }}
              className="text-primary underline underline-offset-2"
            >
              See the comparison
            </Link>{" "}
            <Link to="/tests" className="text-primary underline underline-offset-2">
              {SEE_ON_TESTS_LABEL}
            </Link>
          </p>
        );
      case "failed":
        return (
          <p className="text-xs text-muted-foreground">
            {testFailedLine(run.error)}{" "}
            <Link
              to="/judge"
              search={{ run: run.id }}
              className="text-primary underline underline-offset-2"
            >
              See why
            </Link>{" "}
            <Link to="/tests" className="text-primary underline underline-offset-2">
              {SEE_ON_TESTS_LABEL}
            </Link>
          </p>
        );
      default:
        return null;
    }
  }
  if (!test.available && test.unavailable_reason && item.decision.status === "accepted") {
    return <p className="text-xs text-muted-foreground">{test.unavailable_reason}</p>;
  }
  return null;
}
// ---- end Round 6 Task 6b "Test this rule" ----

function RetireCard({
  item,
  busy,
  run,
  titleAs,
  isNew,
}: {
  item: Improvement;
  busy: boolean;
  run: Run;
  titleAs: "h1" | "h2";
  isNew?: boolean | undefined;
}) {
  const Title = titleAs;
  const titleId = `improvement-${item.id}`;
  const retire = item.retire;
  if (!retire) return null;
  // Round 6 Task 4 / spec §4: lists use "sm" for every button in the bar;
  // the detail page (titleAs="h1") uses the default size.
  const size: "default" | "sm" = titleAs === "h1" ? "default" : "sm";
  return (
    <article aria-labelledby={titleId} className="space-y-3 rounded-md border bg-card p-4">
      {/* header row: project name left, status badges right */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold">{projectName(item)}</p>
        {isNew ? <Badge variant="default">New</Badge> : null}
      </div>
      {/* Round 6c part A / item 1: this fixed line comes first -- Suggestions never lists a live rule, so the card can't lean on a badge to say so. */}
      <Title
        id={titleId}
        className={titleAs === "h1" ? "text-2xl font-semibold" : "text-base font-medium"}
      >
        Harness Ledger suggests retiring this rule
      </Title>
      <blockquote className="rounded-md border bg-muted/30 p-3 text-sm">
        {item.title.replace(/^Retire:\s*/, "")}
      </blockquote>
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">{retireSinceLine(retire)}</p>
        <p className="text-sm">{retireReasonSentence(retire)}</p>
        {retire.reason === "changed_mind" && item.evidence[0] ? (
          // Round 7: the message that asked for the opposite, so the choice
          // can be made from the card.
          <blockquote className="border-l-2 pl-3 text-sm text-muted-foreground">
            {`You wrote: "${excerptText(item.evidence[0].text, 240)}"`}
          </blockquote>
        ) : null}
      </div>
      <div className={ACTION_BAR_CLASS}>
        <RetireConfirm proposalId={retire.proposal_id} busy={busy} run={run} size={size} />
        <Button
          type="button"
          variant="ghost"
          size={size}
          disabled={busy}
          onClick={() => void run({ action: "keep", id: -retire.proposal_id }, KEPT_TOAST)}
        >
          Keep
        </Button>
      </div>
    </article>
  );
}

// ---- Decided items: where it stands, and how to change your mind ----

// Round 6 Task 4 / spec §4: "Did this rule help?" is now a compact, self-
// contained control living in the observed line -- not a row of buttons in
// the action bar. It owns its own network call and local state, so the
// Suggestions card/detail and the Instructions row render one shared widget
// instead of two copies of "You said.../Change" kept in sync by hand. One
// verdict per rule: store.recordRuleVerdict's own upsert (Round 6 Task 1)
// makes a repeat click a no-op (`changed: false`), read here as
// ALREADY_RECORDED_TOAST instead of a fresh "You said" + effect line. Every
// other choice's response carries `effect` (harness/src/improvements.ts's
// recordVerdict) -- what that one click changed in this rule's health,
// shown right underneath via verdictEffectLine.
const VERDICT_CHOICES: { value: "helped" | "did_not_help" | "not_sure"; label: string }[] = [
  { value: "helped", label: "Yes" },
  { value: "did_not_help", label: "No" },
  { value: "not_sure", label: "Not sure" },
];

export function VerdictControl({
  ruleId,
  verdict,
  disabled,
}: {
  ruleId: number;
  verdict: { verdict: "helped" | "did_not_help" | "not_sure"; created_at: string } | null;
  disabled?: boolean;
}) {
  const qc = useQueryClient();
  const [showChoices, setShowChoices] = useState(false);
  const [effect, setEffect] = useState<VerdictEffect | null>(null);
  const mutation = useMutation({
    mutationFn: (v: "helped" | "did_not_help" | "not_sure") =>
      post({ action: "verdict", rule_id: ruleId, verdict: v }),
    onSuccess: (data, v) => {
      if (data.improvement?.changed === false) {
        toast.success(ALREADY_RECORDED_TOAST);
      } else {
        toast.success(`You said: ${VERDICT_TEXT[v]}`);
        setEffect(data.improvement?.effect ?? "none");
      }
      setShowChoices(false);
      void qc.invalidateQueries({ queryKey: ["harness-improvements"] });
      void qc.invalidateQueries({ queryKey: ["harness-knowledge"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not save your verdict"),
  });
  const showButtons = !verdict || showChoices;

  return (
    <div className="space-y-1">
      <div
        role="group"
        aria-label="Did this rule help?"
        className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
      >
        {verdict ? (
          <span>
            {verdictLine(verdict)}
            {" · "}
            <button
              type="button"
              className="underline underline-offset-2 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => setShowChoices(true)}
            >
              Change
            </button>
          </span>
        ) : (
          <span>Did this rule help?</span>
        )}
        {showButtons
          ? VERDICT_CHOICES.map((c) => (
              <Button
                key={c.value}
                type="button"
                variant="ghost"
                size="sm"
                disabled={disabled || mutation.isPending}
                onClick={() => mutation.mutate(c.value)}
              >
                {c.label}
              </Button>
            ))
          : null}
      </div>
      {effect ? <p className="text-xs text-muted-foreground">{verdictEffectLine(effect)}</p> : null}
    </div>
  );
}

function DecidedStatus({
  item,
  busy,
  run,
  ctx,
}: {
  item: Improvement;
  busy: boolean;
  run: Run;
  ctx?: StatusCtx | undefined;
}) {
  const lovable = lovableOf(item);
  const accepted = item.decision.status === "accepted";
  const retired = item.decision.retired;
  const written = lovable.write_status === "written";
  // Round 6 Task 4 / spec §4: lists use "sm" for every button in the bar;
  // the detail page (titleAs="h1") uses the default size -- threaded
  // through ctx so this component's own call site (DecisionCard, below)
  // never has to change shape.
  const size = ctx?.size ?? "sm";
  // Round 6 Task 2: "Try again" (Needs attention) re-runs executeVersionNow
  // on this exact version -- the one whose status is why the card reads
  // stale/failed in the first place.
  const retryableVersion = lovable.versions.find(
    (v) => v.status === "stale" || v.status === "failed",
  );
  // Round 6 Task 3 fix 1 / spec §3: server-computed (harness/src/
  // improvements.ts's controlFlags -- the exact same rule the "undo" action
  // itself enforces), never re-derived from write_status alone: a live
  // rule's later wording-change rewrite can read pending/stale/failed while
  // the rule itself is still exactly what's live in Lovable, which the old
  // client-side check let Undo wrongly demote.
  const canUndo = lovable.can_undo;

  const ruleId = item.rule_id;
  const verdictEligible = accepted && written && ruleId != null;

  return (
    <div className="space-y-2">
      <p className="text-sm">
        {decisionSentence({
          decision: item.decision,
          destination: item.destination,
          lovable,
          ctx,
        })}
      </p>
      {item.health ? (
        <p className="text-xs text-muted-foreground">{healthLine(item.health)}</p>
      ) : null}
      {verdictEligible ? (
        <VerdictControl ruleId={ruleId} verdict={item.health?.verdict ?? null} disabled={busy} />
      ) : null}
      {item.health && adherenceLine(item.health.adherence) ? (
        <p className="text-xs text-muted-foreground">{adherenceLine(item.health.adherence)}</p>
      ) : null}
      <TestStatusLine item={item} />
      {accepted && lovable.write_status === "none" ? (
        <p className="text-xs text-muted-foreground">
          Waiting for Harness Ledger to read your current Knowledge. You'll see the exact text
          before anything is written.
        </p>
      ) : null}
      {accepted && lovable.write_status === "stale" && lovable.stale_reason ? (
        <p className="text-xs text-muted-foreground">{lovable.stale_reason}</p>
      ) : null}
      {accepted && lovable.write_status === "failed" ? (
        <p className="text-xs text-muted-foreground">
          Harness Ledger could not write this to Lovable. You can try again, choose the other
          destination, or skip it.
        </p>
      ) : null}
      <div className={ACTION_BAR_CLASS}>
        {retired ? (
          canUndo ? (
            // Round 6 Task 3 / spec §3: the removal never actually reached
            // Lovable (write failed, or Harness was disconnected at retire
            // time) -- Undo brings the rule straight back to "active", no
            // Lovable write involved. Once the removal IS written, Re-add
            // takes over (below).
            <Button
              type="button"
              variant="ghost"
              size={size}
              disabled={busy}
              onClick={() => void run({ action: "undo", id: item.id }, UNDO_TOAST)}
            >
              Undo
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              size={size}
              disabled={busy}
              onClick={() => void run({ action: "readd", id: item.id }, READDED_TOAST)}
            >
              Re-add
            </Button>
          )
        ) : (
          <>
            {accepted &&
            item.decision.test_first &&
            lovable.write_status === "none" &&
            (item.destination === "project" || item.destination === "workspace") ? (
              <AddConfirm
                item={item}
                destination={item.destination}
                busy={busy}
                run={run}
                variant="outline"
                size={size}
                trigger="Add it now instead"
              />
            ) : null}
            {accepted && !written ? (
              <>
                {(["project", "workspace"] as Destination[])
                  .filter((d) => d !== item.destination)
                  .map((d) => (
                    <AddConfirm
                      key={d}
                      item={item}
                      destination={d}
                      busy={busy}
                      run={run}
                      variant="outline"
                      size={size}
                      trigger={`${ADD_LABELS[d]} instead`}
                    />
                  ))}
                <SkipConfirm item={item} busy={busy} run={run} size={size} />
              </>
            ) : null}
            {accepted &&
            (lovable.write_status === "stale" || lovable.write_status === "failed") &&
            retryableVersion ? (
              <Button
                type="button"
                variant="outline"
                size={size}
                disabled={busy}
                onClick={() =>
                  void run(
                    { action: "retry_write", id: item.id, version_id: retryableVersion.id },
                    "Trying again…",
                  )
                }
              >
                Try again
              </Button>
            ) : null}
            {accepted && written && ruleId != null ? (
              <RemoveFromKnowledgeConfirm ruleId={ruleId} busy={busy} run={run} size={size} />
            ) : null}
            {/* Round 6 Task 3 / spec §3: a plain, no-dialog Undo -- shown for
                every decided-but-unwritten item, accepted or skipped alike
                (the skipped case's own "Reopen" button folded into this same
                one, since it's exactly the same reopen semantics). */}
            {canUndo ? (
              <Button
                type="button"
                variant="ghost"
                size={size}
                disabled={busy}
                onClick={() => void run({ action: "undo", id: item.id }, UNDO_TOAST)}
              >
                Undo
              </Button>
            ) : null}
            <TestButton item={item} busy={busy} run={run} size={size} />
          </>
        )}
      </div>
    </div>
  );
}

// ---- The card: the decision itself (Inbox, Improvements, detail) ----

// The detail view owns the editing state; DecisionCard only renders it. When
// omitted (lists), the blockquote shows no Edit button at all.
type EditableState = {
  editing: boolean;
  draft: string;
  reason: string;
  busy: boolean;
  onStart: () => void;
  onChangeDraft: (v: string) => void;
  onChangeReason: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
};

// Round 5 Task 5 / spec §2: the Inbox's own lean rendering -- project name,
// the title as a button to Suggestions (the Inbox has no detail view of its
// own any more), the instruction blockquote, one muted line for why Harness
// read it this way, the "wasn't sure" line when decision_mode='automatic'
// flagged one, and the three decision buttons. No group Badge (the "New"
// badge is the one exception), no DecidedStatus, no editable state -- kept
// as its own function, never entangled with DecisionCard's own (unchanged)
// full rendering below, since it always receives a pending item (the Inbox
// turns a decided one into a ConfirmationRow instead of a card).
function CompactDecisionCard({
  item,
  onOpen,
  busy,
  run,
  isNew,
}: {
  item: Improvement;
  onOpen?: ((id: number) => void) | undefined;
  busy: boolean;
  run: Run;
  isNew?: boolean | undefined;
}) {
  const titleId = `improvement-${item.id}`;
  // Round 6 Task 4 / spec §4: the Inbox is always a list -- every button in
  // its bar is "sm", same as everywhere else lists render this card.
  const size = "sm";
  return (
    <article aria-labelledby={titleId} className="space-y-3 rounded-md border bg-card p-4">
      {/* header row: project name left, status badges right */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold">{projectName(item)}</p>
        {isNew ? <Badge variant="default">New</Badge> : null}
      </div>
      <h2 id={titleId} className="text-base font-medium">
        <button
          type="button"
          className="text-left hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => onOpen?.(item.id)}
        >
          {item.title}
        </button>
      </h2>
      {/* body: full width, a sibling of the header row above */}
      {item.proposed_instruction ? (
        <blockquote className="rounded-md border bg-muted/30 p-3 text-sm">
          {item.proposed_instruction}
        </blockquote>
      ) : (
        <p className="text-sm text-muted-foreground">{NO_INSTRUCTION}</p>
      )}
      <p className="text-xs text-muted-foreground">{whyFor(item.classification)}</p>
      {item.unsure ? (
        <p role="status" className="text-xs text-muted-foreground">
          {item.unsure}
        </p>
      ) : null}
      <TestStatusLine item={item} />
      <div className={ACTION_BAR_CLASS}>
        <AddConfirm item={item} destination="project" busy={busy} run={run} size={size} />
        <AddConfirm
          item={item}
          destination="workspace"
          busy={busy}
          run={run}
          variant="outline"
          size={size}
        />
        <SkipConfirm item={item} busy={busy} run={run} size={size} />
        <TestButton item={item} busy={busy} run={run} size={size} />
      </div>
    </article>
  );
}

export function DecisionCard({
  item,
  onChanged,
  onOpen,
  titleAs = "h2",
  busy: busyProp,
  run: runProp,
  editable,
  isNew,
  compact,
}: {
  item: Improvement;
  onChanged: (msg: string) => void;
  onOpen?: (id: number) => void;
  titleAs?: "h1" | "h2";
  busy?: boolean;
  run?: Run;
  editable?: EditableState;
  // Task C3 / spec §5: found after the Inbox was last opened (the caller
  // compares item.created_at against the last_seen_at read before this
  // visit's "mark_seen" updated it) -- Inbox-only; the ledger and detail
  // pages never pass it.
  isNew?: boolean;
  // Round 5 Task 5 / spec §2: Inbox-only lean rendering -- delegates to
  // CompactDecisionCard above. Ledger and the detail page never pass it, so
  // their own rendering below is unchanged.
  compact?: boolean;
}) {
  const own = useRun(onChanged);
  const busy = busyProp ?? own.busy;
  const run = runProp ?? own.run;
  const executor = useQuery(executorQueryOptions);
  // Round 6 Task 4 / spec §4: lists use "sm" for every button in the bar;
  // the detail page (titleAs="h1") uses the default size.
  const size: "default" | "sm" = titleAs === "h1" ? "default" : "sm";
  const ctx = {
    connected: executor.data?.connection?.connected,
    testFirst: item.decision.test_first,
    // A workspace write isn't gated by one project's flag, so this only
    // ever applies to project-destination items (Round 3 §5).
    autoWriteOff: item.destination === "project" && item.lovable?.auto_write === false,
    size,
  };
  const pending = item.decision.status === "pending";
  const Title = titleAs;
  const titleId = `improvement-${item.id}`;

  if (item.kind === "retire") {
    return <RetireCard item={item} busy={busy} run={run} titleAs={titleAs} isNew={isNew} />;
  }

  if (compact) {
    return <CompactDecisionCard item={item} onOpen={onOpen} busy={busy} run={run} isNew={isNew} />;
  }

  return (
    <article aria-labelledby={titleId} className="space-y-3 rounded-md border bg-card p-4">
      {/* header row: project name left, status badges right -- the body
          below used to share this row's left column with the badges,
          cutting the editor short; it's a full-width sibling block now. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold">{projectName(item)}</p>
        {pending ? (
          isNew ? (
            <Badge variant="default">New</Badge>
          ) : null
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{groupOf(item)}</Badge>
            {/* Round 5 Task 6: automatic mode's own visibility requirement -- marked wherever a decided item shows. */}
            {item.decided_by === "automatic" ? (
              <Badge variant="outline">Accepted automatically</Badge>
            ) : null}
          </div>
        )}
      </div>

      {/* body: title + instruction (blockquote or the editor), full width --
          a sibling of the header row above, never sharing its left column. */}
      <div
        className={
          onOpen ? "space-y-3 cursor-pointer rounded-md -m-1 p-1 hover:bg-accent/50" : "space-y-3"
        }
        role={onOpen ? "link" : undefined}
        tabIndex={onOpen ? 0 : undefined}
        onClick={onOpen ? () => onOpen(item.id) : undefined}
        onKeyDown={
          onOpen
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onOpen(item.id);
                }
              }
            : undefined
        }
      >
        <Title
          id={titleId}
          className={titleAs === "h1" ? "text-2xl font-semibold" : "text-base font-medium"}
        >
          {onOpen ? (
            <button
              type="button"
              className="text-left hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => onOpen(item.id)}
            >
              {item.title}
            </button>
          ) : (
            item.title
          )}
        </Title>
        {item.proposed_instruction ? (
          editable && editable.editing ? (
            <div className="space-y-2 rounded-md border p-3">
              <label htmlFor={`wording-${item.id}`} className="text-xs font-medium">
                Instruction
              </label>
              <Textarea
                id={`wording-${item.id}`}
                value={editable.draft}
                onChange={(e) => editable.onChangeDraft(e.target.value)}
                rows={3}
              />
              <label htmlFor={`wording-reason-${item.id}`} className="text-xs font-medium">
                Why you changed it (optional)
              </label>
              <input
                id={`wording-reason-${item.id}`}
                className="w-full rounded-md border bg-background px-3 py-1.5 text-sm"
                value={editable.reason}
                onChange={(e) => editable.onChangeReason(e.target.value)}
              />
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button
                  size="sm"
                  disabled={editable.busy || editable.draft.trim().length === 0}
                  onClick={editable.onSave}
                >
                  Save wording
                </Button>
                <Button size="sm" variant="outline" onClick={editable.onCancel}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="relative">
              <blockquote className="rounded-md border bg-muted/30 p-3 text-sm">
                {item.proposed_instruction}
              </blockquote>
              {editable ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="absolute right-1 top-1"
                  onClick={editable.onStart}
                >
                  Edit
                </Button>
              ) : null}
            </div>
          )
        ) : (
          <p className="text-sm text-muted-foreground">{NO_INSTRUCTION}</p>
        )}
      </div>

      {pending ? (
        <>
          <TestStatusLine item={item} />
          <div className={ACTION_BAR_CLASS}>
            <AddConfirm item={item} destination="project" busy={busy} run={run} size={size} />
            <AddConfirm
              item={item}
              destination="workspace"
              busy={busy}
              run={run}
              variant="outline"
              size={size}
            />
            <SkipConfirm item={item} busy={busy} run={run} size={size} />
            <TestButton item={item} busy={busy} run={run} size={size} />
          </div>
        </>
      ) : (
        <DecidedStatus item={item} busy={busy} run={run} ctx={ctx} />
      )}
    </article>
  );
}

// ---- Detail pieces ----

function MessageBlock({ m, projectId }: { m: Message; projectId?: string }) {
  const isLovable = m.author === "lovable";
  const readable = isLovable ? lovableReplyText(m.text) : m.text;
  const tooLong = !isLovable && readable.length > LONG_TEXT;
  return (
    <li className="rounded-md border bg-muted/30 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {isLovable ? "Lovable replied" : "You asked Lovable"}
          {m.sent_at ? ` · ${formatDate(m.sent_at)}` : ""}
        </p>
        {!isLovable && projectId ? (
          <a
            href={`https://lovable.dev/projects/${projectId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Open in Lovable
          </a>
        ) : null}
      </div>
      <p className="mt-1 whitespace-pre-wrap text-sm">
        {tooLong ? `${readable.slice(0, LONG_TEXT)}…` : readable}
      </p>
      {isLovable ? (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            Show full response
          </summary>
          <pre className="mt-2 whitespace-pre-wrap break-words text-xs">{m.text}</pre>
        </details>
      ) : tooLong ? (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            Show more
          </summary>
          <pre className="mt-2 whitespace-pre-wrap break-words text-xs">{m.text}</pre>
        </details>
      ) : null}
    </li>
  );
}

export function ImprovementDetail({
  item,
  onBack,
  onChanged,
  backLabel = "← Back",
  position,
  onPrev,
  onNext,
}: {
  item: Improvement;
  onBack: () => void;
  onChanged: (msg: string) => void;
  backLabel?: string;
  position?: { index: number; total: number } | undefined;
  onPrev?: (() => void) | undefined;
  onNext?: (() => void) | undefined;
}) {
  const { busy, run } = useRun(onChanged);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.proposed_instruction ?? "");
  const [reason, setReason] = useState("");

  const lovable = lovableOf(item);
  const accepted = item.decision.status === "accepted";
  const skipped = item.decision.status === "skipped";

  // Arrows move between improvements unless focus is in a text field or a
  // confirmation dialog is open.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) {
        return;
      }
      if (document.querySelector('[role="alertdialog"]')) return;
      if (e.key === "ArrowLeft") onPrev?.();
      else if (e.key === "ArrowRight") onNext?.();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onPrev, onNext]);

  const editable = {
    editing,
    draft,
    reason,
    busy,
    onStart: () => setEditing(true),
    onChangeDraft: setDraft,
    onChangeReason: setReason,
    onSave: () =>
      void run(
        { action: "change_wording", id: item.id, instruction: draft, reason },
        "Wording updated",
      ).then((ok) => ok && setEditing(false)),
    onCancel: () => setEditing(false),
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          className="text-sm text-primary underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onBack}
        >
          {backLabel}
        </button>
        {position ? (
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">
              {position.index} of {position.total}
            </span>
            <Button variant="outline" size="sm" onClick={onPrev} disabled={position.index <= 1}>
              ← Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={onNext}
              disabled={position.index >= position.total}
            >
              Next →
            </Button>
          </div>
        ) : null}
      </div>

      <DecisionCard
        item={item}
        onChanged={onChanged}
        busy={busy}
        run={run}
        titleAs="h1"
        editable={editable}
      />

      {item.decision.divergence ? (
        <p role="status" className="rounded-md border p-3 text-sm">
          {item.decision.divergence}
        </p>
      ) : null}

      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">{whyFor(item.classification)}</p>
      </div>

      <section aria-labelledby={`story-${item.id}`} className="space-y-3">
        <h2 id={`story-${item.id}`} className="text-lg font-semibold">
          What happened
        </h2>
        {item.evidence.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No Lovable messages are attached to this suggestion.
          </p>
        ) : (
          <ol className="space-y-2">
            {item.evidence.map((m) => (
              <MessageBlock key={m.id} m={m} projectId={item.project.id} />
            ))}
          </ol>
        )}
      </section>

      <AdvancedDetails title="Details">
        <DetailSection title="How Harness Ledger read this">
          <p>Harness Ledger read this as: {label(CLASSIFICATION_LABELS, item.classification)}.</p>
          {item.decision.decided_at ? (
            <p>
              {skipped ? "You skipped it on" : "You decided on"}{" "}
              {formatDay(item.decision.decided_at)}.
            </p>
          ) : null}
          {accepted && lovable.untested ? (
            <p>Added without a proof — Harness Ledger hasn't tested this instruction.</p>
          ) : null}
          <p>Harness Ledger analysis uses Harness Ledger's own AI, not your Lovable account.</p>
        </DetailSection>

        <DetailSection title="How Harness Ledger judges whether a rule helps">
          {evidenceSourceLines(item.health?.sources ?? null).map((line, i) => (
            <p key={i}>{line}</p>
          ))}
          {item.health?.adherence && item.health.adherence.quotes.length > 0 ? (
            <details className="mt-2 rounded-md border bg-background">
              <summary className="cursor-pointer px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                Quotes
              </summary>
              <ul className="space-y-2 border-t px-3 py-3">
                {item.health.adherence.quotes.map((q, i) => (
                  <li key={i}>
                    “{q.quote}” — {q.verdict === "broke" ? "broke the rule" : "followed the rule"},{" "}
                    {formatDay(q.created_at)}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </DetailSection>

        <DetailSection title={`Wording history (${item.wording_history.length})`}>
          {item.wording_history.length === 0 ? (
            <p>No wording changes yet.</p>
          ) : (
            item.wording_history.map((w, i) => (
              <div key={`${w.changed_at}-${i}`} className="rounded-md border bg-background p-2">
                <p>{wordingChangeLine(w)}</p>
                <p className="mt-1 text-muted-foreground line-through">{w.from}</p>
                <p>{w.to}</p>
              </div>
            ))
          )}
        </DetailSection>

        {lovable.versions.length > 0 ? (
          <DetailSection title={`Knowledge versions (${lovable.versions.length})`}>
            {lovable.versions.map((v) => (
              <p key={v.id}>
                {formatDay(v.created_at)} · {label(DESTINATION_LABELS, v.target)} ·{" "}
                {versionStatusLine(v)}
              </p>
            ))}
          </DetailSection>
        ) : null}

        {/* developer-view:start */}
        <details className="rounded-md border bg-muted/30">
          <summary className="cursor-pointer px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            Developer view
          </summary>
          <div className="space-y-2 border-t px-3 py-3 text-xs">
            <p className="text-muted-foreground">
              Raw records as Harness Ledger stores them. Includes internal identifiers and
              classifier reasoning.
            </p>
            {(
              [
                ["Correction", item.developer.correction],
                ["Learning", item.developer.learning],
                ["Rule", item.developer.rule],
                ["Classification history", item.developer.classification_history],
                ["Other stored items (not shown to users)", item.developer.hidden_evidence],
                ["Verification plan", item.developer.verification_plan],
                ["Experiment plans", item.developer.experiment_plans],
                ["Lovable write records", item.lovable ?? null],
                ["Audit events", item.developer.audit_events],
              ] as [string, unknown][]
            ).map(([title, value]) => (
              <DetailSection key={title} title={title}>
                <pre className="whitespace-pre-wrap break-words text-xs">
                  {value == null ? "—" : JSON.stringify(value, null, 2)}
                </pre>
              </DetailSection>
            ))}
          </div>
        </details>
        {/* developer-view:end */}
      </AdvancedDetails>
    </div>
  );
}
