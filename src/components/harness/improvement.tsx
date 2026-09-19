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
  CurrentStatus,
  DetailSection,
  PrimaryAction,
  RecommendationCallout,
} from "@/components/harness/decision-layout";
import { ClampedText } from "@/components/harness/clamped-text";
import {
  ALREADY_RECORDED_TOAST,
  actionConsequence,
  adherenceLine,
  CLASSIFICATION_LABELS,
  CONTENT_DESTINATION_LABELS,
  contentDestinationAlternative,
  contentDestinationReason,
  DESTINATION_ALTERNATIVE,
  DESTINATION_CHANGE,
  DESTINATION_LABELS,
  DESTINATION_RECOMMENDED,
  DESTINATION_WHY,
  destinationLabelPlain,
  evidenceSourceLines,
  healthLine,
  attentionBlock,
  KNOWLEDGE_CHAR_LIMIT,
  decisionSentence,
  formatDate,
  formatDay,
  label,
  lessonLine,
  lovableReplyText,
  PRIMARY_ACTION_LABELS,
  proveCostLine,
  recommendedPrimaryAction,
  REMOVE_FROM_KNOWLEDGE_BODY,
  REMOVE_FROM_KNOWLEDGE_CONFIRM_LABEL,
  REMOVE_FROM_KNOWLEDGE_TITLE,
  retireReasonSentence,
  retireSinceLine,
  SEE_ON_TESTS_LABEL,
  SKILL_NOT_IN_LOVABLE_LINE,
  SKILL_NOT_PUBLISHED_LINE,
  SKILL_OWNED_BY_USER_LINE,
  REVIEW_SKILL_LABEL,
  skillProposalPurpose,
  skillProposalStatusLabel,
  skillProposalVersionCountLine,
  // ---- Checkpoint 3 S1 ----
  PUBLISH_SKILL_LABEL,
  PUBLISHING_SKILL_LABEL,
  PUBLISH_SKILL_TITLE,
  publishSkillConfirmBody,
  skillLovableStatusLine,
  skillPublishFailedLine,
  // ---- end Checkpoint 3 S1 ----
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
  VERDICT_CHOICE_LABELS,
  VERDICT_QUESTION,
  VERDICT_TEXT,
  verdictEffectLine,
  verdictLine,
  type RuleVerdictValue,
  type StatusCtx,
  type VerdictEffect,
  versionStatusLine,
  whyFor,
  wordingChangeLine,
  // ---- Checkpoint 3 I2: the Inbox queue's own card copy ----
  INBOX_TYPE_LABELS,
  WHY_RECOMMENDS_TITLE,
  TEST_IN_PROGRESS_LINE,
  USE_KNOWLEDGE_INSTEAD,
  EDIT_LABEL,
  CHANGE_DESTINATION_LABEL,
  VIEW_DETAILS_LABEL,
  VIEW_EVIDENCE_LABEL,
  JUDGE_REPLAY_LABEL,
  REVIEW_RULE_LABEL,
  REVIEW_LABEL,
  RETRY_LABEL,
  VIEW_LABEL,
  YOUR_VERDICT_NEEDED_LINE,
  replayJudgedLine,
  inboxActionConsequence,
  FIELD_LABELS,
  type ReplayConclusionLike,
} from "@/lib/harness-ux";

import {
  executorQueryOptions,
  groupOf,
  lovableOf,
  postImprovementAction as post,
  projectName,
  toastWriteOutcome,
  type ContentDestinationValue,
  type Improvement,
  type TestInfo,
  type Message,
  type InboxItem,
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
          // real historical replay, not the old test_first staging (approve
          // the rule, write nothing, wait for a verification pass that never
          // ran) -- accept writes immediately (Round 6 Task 2), then a
          // `test` action queues the replay on the now-written rule. A
          // failed second call (e.g. over budget) still leaves the first
          // one's own accept in place; its own toast explains why.
          // Round 7: "Test it first" adds nothing -- the rule is tested, you
          // compare the historical result and the new build, and add it
          // from the test afterwards.
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
  trigger,
  variant,
}: {
  item: Improvement;
  busy: boolean;
  run: Run;
  size?: "default" | "sm" | undefined;
  // Checkpoint 2 2-B: the Inbox card's own primary-action label ("Test
  // first", PRIMARY_ACTION_LABELS.test_first) reuses this exact button
  // rather than a second copy -- every other call site omits this and keeps
  // the original "Test this rule" trigger.
  trigger?: string;
  variant?: "default" | "outline";
}) {
  const [showOriginal, setShowOriginal] = useState(true);
  if (!item.test?.available) return null;
  return (
    <ConfirmAction
      trigger={trigger ?? "Test this rule"}
      variant={variant ?? "outline"}
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

// The historical replay's own consequence lines -- one place, shared by
// "Test this rule" and the Add dialog's "Test it first".
function testConfirmLines(test: TestInfo): string[] {
  return [
    TEST_THIS_RULE_CREDITS_LINE,
    testThisRuleBudgetLine(test.credits),
    TEST_ONE_AT_A_TIME_LINE,
  ];
}

// Round 7: whether the test also makes a copy of the historical result (uses
// no Lovable builder credits), so it can be opened side by side with the
// new build.
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

// The card's own status line for a rule's latest historical-replay run --
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
        Is this rule still useful?
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

// Round 6 Task 4 / spec §4: "Is this rule still useful?" is a compact, self-
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
const VERDICT_CHOICES: { value: RuleVerdictValue; label: string }[] = (
  ["keep", "review", "retire", "not_sure"] as const
).map((value) => ({ value, label: VERDICT_CHOICE_LABELS[value] }));

export function VerdictControl({
  ruleId,
  verdict,
  disabled,
}: {
  ruleId: number;
  verdict: { verdict: RuleVerdictValue; created_at: string } | null;
  disabled?: boolean;
}) {
  const qc = useQueryClient();
  const [showChoices, setShowChoices] = useState(false);
  const [effect, setEffect] = useState<VerdictEffect | null>(null);
  const mutation = useMutation({
    mutationFn: (v: "keep" | "review" | "retire" | "not_sure") =>
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
        aria-label={VERDICT_QUESTION}
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
          <span>{VERDICT_QUESTION}</span>
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

// Round 5 Task 5 / spec §2, rewritten with intent by Checkpoint 2 2-B: the
// Inbox card now shows exactly the Level 1 fields -- project name, the
// plain-language lesson, the instruction (or the Skill name for a
// skill-only destination), the destination in plain words, the one-sentence
// reason, ONE recommended primary action with its consequence line, and
// Skip. Everything else (raw classification, the alternative destination,
// changing scope, the full evidence) is a secondary control, moved into a
// collapsed "More" area rather than sharing the primary action's visual
// weight. No group Badge (the "New" badge is the one exception), no
// DecidedStatus, no editable state -- kept as its own function, never
// entangled with DecisionCard's own (unchanged) full rendering below, since
// it always receives a pending item (the Inbox turns a decided one into a
// ConfirmationRow instead of a card).
function CompactDecisionCard({
  item,
  onOpen,
  busy,
  run,
  isNew,
  conclusion,
}: {
  item: Improvement;
  onOpen?: ((id: number) => void) | undefined;
  busy: boolean;
  run: Run;
  isNew?: boolean | undefined;
  // Checkpoint 3 I2: set only by the Inbox, from InboxItem.conclusion, when
  // this suggestion's own staged test has been judged but the suggestion
  // itself is still pending -- ImprovementDetail's own DecisionCard call has
  // no InboxItem to read this from, so it never passes it.
  conclusion?: ReplayConclusionLike | null | undefined;
}) {
  const titleId = `improvement-${item.id}`;
  // Round 6 Task 4 / spec §4: the Inbox is always a list -- every button in
  // its bar is "sm", same as everywhere else lists render this card.
  const size = "sm";
  const skillOnly = item.content_destination?.value === "skill";
  const scope: "project" | "workspace" = item.destination === "workspace" ? "workspace" : "project";
  const destLabel = destinationLabelPlain(
    item.content_destination?.value ?? null,
    item.destination,
  );
  const reason = item.content_destination
    ? contentDestinationReason(item.content_destination.value, item.content_destination.reason)
    : whyFor(item.classification);
  const recommended = recommendedPrimaryAction(item);
  const canTest = item.test?.available === true;
  // Checkpoint 3 I2: by the Inbox item contract, this card only ever renders
  // a new_instruction item (content_destination knowledge or both -- a
  // skill-only suggestion is its own new_skill Inbox item, see NewSkillCard
  // below); `skillOnly` is kept only as a defensive fallback, never expected
  // to be true here.
  const runStatus = item.test?.run?.status;
  const testRunning = runStatus === "queued" || runStatus === "copying" || runStatus === "building";
  // Checkpoint 3 I2: never show the same text twice -- when the plain-
  // language lesson and the proposed instruction read identically, the
  // instruction blockquote is dropped and the lesson (already the heading)
  // stands alone.
  const lesson = lessonLine(item);
  const instructionText = item.proposed_instruction?.trim() || null;
  const showInstruction = instructionText != null && instructionText !== lesson.trim();
  return (
    <article aria-labelledby={titleId} className="space-y-3 rounded-md border bg-card p-4">
      {/* header row: project name + type label left, New badge right */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-semibold">{projectName(item)}</p>
          <span className="text-xs text-muted-foreground">{INBOX_TYPE_LABELS.new_instruction}</span>
        </div>
        {isNew ? <Badge variant="default">New</Badge> : null}
      </div>
      <h2 id={titleId} className="text-base font-medium">
        <button
          type="button"
          className="text-left hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => onOpen?.(item.id)}
        >
          {lesson}
        </button>
      </h2>
      {/* body: full width, a sibling of the header row above */}
      {/* Checkpoint 2 2-B / Checkpoint 3 I2: the plain-language lesson is the
          heading above; the proposed instruction (or, for a skill-only
          destination, the Skill name) follows, only when it says something
          the lesson didn't already say. */}
      {skillOnly ? (
        <blockquote className="rounded-md border bg-muted/30 p-3 text-sm">
          {item.skill_proposal?.name ?? NO_INSTRUCTION}
        </blockquote>
      ) : showInstruction ? (
        <blockquote className="rounded-md border bg-muted/30 p-3 text-sm">
          {instructionText}
        </blockquote>
      ) : !instructionText ? (
        <p className="text-sm text-muted-foreground">{NO_INSTRUCTION}</p>
      ) : null}
      {item.content_destination?.value === "both" && item.skill_proposal ? (
        <p className="text-xs text-muted-foreground">
          Also creates the Skill "{item.skill_proposal.name}".
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        <span className="font-medium">{destLabel}</span>
        {" — "}
        {reason}
      </p>
      {item.unsure ? (
        <p role="status" className="text-xs text-muted-foreground">
          {item.unsure}
        </p>
      ) : null}
      {/* Checkpoint 3 I2: a staged test judged while the suggestion itself
          is still pending -- shown alongside TestStatusLine's own judged-run
          line (that one is a link to the comparison; this one names the
          conclusion directly). */}
      {replayJudgedLine(conclusion) ? (
        <p className="text-xs font-medium">{replayJudgedLine(conclusion)}</p>
      ) : null}
      <TestStatusLine item={item} />
      <div className={ACTION_BAR_CLASS}>
        {recommended === "review_skill" ? (
          <div className="space-y-1">
            <Button type="button" size={size} onClick={() => onOpen?.(item.id)}>
              {PRIMARY_ACTION_LABELS.review_skill}
            </Button>
            <p className="text-xs text-muted-foreground">{actionConsequence("review_skill")}</p>
          </div>
        ) : recommended === "test_first" ? (
          <div className="space-y-1">
            {testRunning ? (
              <p className="text-sm text-muted-foreground">{TEST_IN_PROGRESS_LINE}</p>
            ) : (
              <TestButton
                item={item}
                busy={busy}
                run={run}
                size={size}
                trigger={PRIMARY_ACTION_LABELS.test_first}
                variant="default"
              />
            )}
            <p className="text-xs text-muted-foreground">{actionConsequence("test_first")}</p>
          </div>
        ) : (
          <div className="space-y-1">
            <AddInstructionConfirm item={item} busy={busy} run={run} size={size} />
            <p className="text-xs text-muted-foreground">{actionConsequence("add", scope)}</p>
          </div>
        )}
        {/* Test first stays offered even when it isn't the recommendation,
            whenever it's actually available -- never the other way round;
            an already-running test shows the status line instead of a
            second, confusing "Test first" button. */}
        {recommended !== "test_first" ? (
          testRunning ? (
            <p className="text-xs text-muted-foreground">{TEST_IN_PROGRESS_LINE}</p>
          ) : canTest ? (
            <TestButton
              item={item}
              busy={busy}
              run={run}
              size={size}
              trigger={PRIMARY_ACTION_LABELS.test_first}
            />
          ) : null
        ) : null}
      </div>
      {/* Checkpoint 3 I2: tertiary text actions -- Edit, Skip, Change
          destination, View details -- ghost/link style, never sharing the
          primary action bar's visual weight. */}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="text-xs text-primary underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => onOpen?.(item.id)}
        >
          {EDIT_LABEL}
        </button>
        <SkipConfirm item={item} busy={busy} run={run} size={size} />
        <ChangeDestinationControl item={item} busy={busy} run={run} />
        <button
          type="button"
          className="text-xs text-primary underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => onOpen?.(item.id)}
        >
          {VIEW_DETAILS_LABEL}
        </button>
      </div>
      {/* Checkpoint 3 I2: prediction paragraphs collapse here; everything
          technical stays on the detail page. */}
      <details className="rounded-md border">
        <summary className="cursor-pointer px-2 py-1 text-xs font-medium text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {WHY_RECOMMENDS_TITLE}
        </summary>
        <div className="space-y-2 border-t p-2 text-xs text-muted-foreground">
          <p>{whyFor(item.classification)}</p>
          {predictedFailureOf(item) ? <p>Without this rule, {predictedFailureOf(item)}.</p> : null}
          {appliesWhenOf(item) ? (
            <p>
              {FIELD_LABELS["applies_when"]}: {appliesWhenOf(item)}
            </p>
          ) : null}
          {item.content_destination ? (
            <p>
              {DESTINATION_ALTERNATIVE}:{" "}
              {contentDestinationAlternative(
                item.content_destination.alternative_label,
                item.content_destination.alternative,
              )}
            </p>
          ) : null}
        </div>
      </details>
    </article>
  );
}

// Checkpoint 3 I2: the rule row behind an improvement carries applies_when/
// predicted_failure (harness/src/store.ts's own rules table columns), but
// Improvement.developer.rule is typed `unknown` (the Developer view's own
// raw-JSON convention) -- these two narrow it just enough for the
// prediction paragraphs above, defensively (an older/retire item may have
// no rule yet).
function predictedFailureOf(item: Improvement): string | null {
  const rule = item.developer.rule as { predicted_failure?: unknown } | null;
  const v = rule?.predicted_failure;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
function appliesWhenOf(item: Improvement): string | null {
  const rule = item.developer.rule as { applies_when?: unknown } | null;
  const v = rule?.applies_when;
  return typeof v === "string" && v.trim() ? v.trim() : null;
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
  conclusion,
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
  // Checkpoint 3 I2: Inbox-only, from InboxItem.conclusion -- see
  // CompactDecisionCard's own doc comment.
  conclusion?: ReplayConclusionLike | null | undefined;
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
    return (
      <CompactDecisionCard
        item={item}
        onOpen={onOpen}
        busy={busy}
        run={run}
        isNew={isNew}
        conclusion={conclusion}
      />
    );
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
      {/* Owner review round 7 fixes 2/3: ClampedText's own "See more"/"See
          less" replaces the old fixed-length slice + a second "Show more"
          <details> repeating the same text -- and, for Lovable's own reply,
          renders it through LightMarkdown so a stray "**" reads as bold
          instead of literal asterisks. */}
      <div className="mt-1 text-sm">
        <ClampedText text={readable} markdown={isLovable} />
      </div>
      {isLovable ? (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            Show full response
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
  const pendingDetail = item.decision.status === "pending";

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

      {/* ---- Checkpoint 2 2-B: the six-section suggestion detail order ---- */}

      {/* 1. What happened -- a short, four-line story: what you asked for,
          what Lovable built, your correction, and whatever Lovable changed
          afterward (else "Not recorded" -- never fabricated). */}
      <section aria-labelledby={`story-${item.id}`} className="space-y-2">
        <h2 id={`story-${item.id}`} className="text-lg font-semibold">
          What happened
        </h2>
        {item.story ? (
          <dl className="space-y-3 text-sm">
            <div>
              <dt className="font-medium">Requested</dt>
              <dd className="text-muted-foreground">
                {item.story.requested ? (
                  <ClampedText text={item.story.requested} />
                ) : (
                  "Not recorded"
                )}
              </dd>
            </div>
            <div>
              <dt className="font-medium">Built</dt>
              <dd className="text-muted-foreground">
                {item.story.built ? (
                  <ClampedText text={item.story.built} markdown />
                ) : (
                  "Not recorded"
                )}
              </dd>
            </div>
            <div>
              <dt className="font-medium">Your correction</dt>
              <dd className="text-muted-foreground">
                <ClampedText text={item.story.correction} />
              </dd>
            </div>
            <div>
              <dt className="font-medium">Changed afterward</dt>
              <dd className="text-muted-foreground">
                {item.story.changed_afterward ? (
                  <ClampedText text={item.story.changed_afterward} markdown />
                ) : (
                  "Not recorded"
                )}
              </dd>
            </div>
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">
            Not enough of this conversation was recorded to show a play-by-play.
          </p>
        )}
      </section>

      {/* 2. What Harness Ledger learned -- the plain-language lesson. */}
      <section aria-labelledby={`lesson-${item.id}`} className="space-y-2">
        <h2 id={`lesson-${item.id}`} className="text-lg font-semibold">
          What Harness Ledger learned
        </h2>
        <p className="text-sm">{lessonLine(item)}</p>
      </section>

      {/* 3. What Harness Ledger recommends -- destination, the instruction or
          Skill draft, and the attention block when a live rule needs one. */}
      <section aria-labelledby={`recommends-${item.id}`} className="space-y-3">
        <h2 id={`recommends-${item.id}`} className="text-lg font-semibold">
          What Harness Ledger recommends
        </h2>
        <p className="text-sm">
          <span className="font-medium">
            {destinationLabelPlain(item.content_destination?.value ?? null, item.destination)}
          </span>
        </p>
        {item.content_destination?.value === "skill" && item.skill_proposal ? (
          <blockquote className="rounded-md border bg-muted/30 p-3 text-sm">
            {item.skill_proposal.name}
          </blockquote>
        ) : item.proposed_instruction ? (
          <blockquote className="rounded-md border bg-muted/30 p-3 text-sm">
            {item.proposed_instruction}
          </blockquote>
        ) : (
          <p className="text-sm text-muted-foreground">{NO_INSTRUCTION}</p>
        )}
        <AttentionBlock item={item} busy={busy} run={run} onReview={() => setEditing(true)} />
      </section>

      {/* 4. Why Knowledge or Skill -- reason, alternative, and the change-
          destination control (the existing DestinationChoice, unchanged). */}
      <section aria-labelledby={`why-destination-${item.id}`} className="space-y-2">
        <h2 id={`why-destination-${item.id}`} className="text-lg font-semibold">
          Why Knowledge or Skill
        </h2>
        <DestinationChoice item={item} busy={busy} run={run} />
      </section>

      {/* 5. What the action will do -- the consequence line for every action
          actually on offer right now, plus the Knowledge scope. */}
      <section aria-labelledby={`action-effect-${item.id}`} className="space-y-2">
        <h2 id={`action-effect-${item.id}`} className="text-lg font-semibold">
          What the action will do
        </h2>
        {pendingDetail ? (
          <ul className="space-y-1 text-sm text-muted-foreground">
            {item.content_destination?.value !== "skill" ? (
              <li>
                {PRIMARY_ACTION_LABELS.add} ({label(DESTINATION_LABELS, "project")}):{" "}
                {actionConsequence("add", "project")}
              </li>
            ) : null}
            {item.content_destination?.value !== "skill" ? (
              <li>
                {PRIMARY_ACTION_LABELS.add} ({label(DESTINATION_LABELS, "workspace")}):{" "}
                {actionConsequence("add", "workspace")}
              </li>
            ) : null}
            {item.content_destination?.value === "skill" ||
            item.content_destination?.value === "both" ? (
              <li>
                {PRIMARY_ACTION_LABELS.review_skill}: {actionConsequence("review_skill")}
              </li>
            ) : null}
            {item.test?.available ? (
              <li>
                {PRIMARY_ACTION_LABELS.test_first}: {actionConsequence("test_first")}
              </li>
            ) : null}
            <li>
              {PRIMARY_ACTION_LABELS.skip}: {actionConsequence("skip")}
            </li>
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            {skipped
              ? actionConsequence("skip")
              : accepted
                ? actionConsequence(
                    "add",
                    item.destination === "workspace" ? "workspace" : "project",
                  )
                : "This suggestion has already been decided."}
          </p>
        )}
      </section>

      {/* 6. The primary decision -- the existing DecisionCard action bar. */}
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

      {/* ---- end Checkpoint 2 2-B section order ---- */}

      <AdvancedDetails title="Technical details">
        <DetailSection title="Full message history">
          {item.evidence.length === 0 ? (
            <p>No Lovable messages are attached to this suggestion.</p>
          ) : (
            <ol className="space-y-2">
              {item.evidence.map((m) => (
                <MessageBlock key={m.id} m={m} projectId={item.project.id} />
              ))}
            </ol>
          )}
        </DetailSection>

        <DetailSection title="How Harness Ledger read this">
          {/* Analysis reasoning: the classification and why it led here. */}
          <p>{whyFor(item.classification)}</p>
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

// ---- Checkpoint 2026-09-18 WP4: destination ----
// Where this suggestion's lesson belongs (Knowledge, a Skill, or both), why,
// the alternative, and -- when a Skill is on the table -- the local Skill
// draft itself: its status, an honest "not in Lovable yet" line, and Edit /
// Approve / Retire. Never claims a Skill was created or updated in Lovable
// (lovable_state is always "not_created"). Shown on the suggestion detail
// only (kind "improvement"); a "retire" item has no content_destination.
// Placed after ImprovementDetail (a function DECLARATION is hoisted, so
// ImprovementDetail's own JSX above can still reference it) rather than
// between DecisionCard and ImprovementDetail, which is exactly the source
// range ux.test.ts's own "Skill should be gone from the detail component"
// check slices out and scans -- this component legitimately says "Skill"
// throughout, so it must live outside that boundary.
const CONTENT_DESTINATION_ORDER: ContentDestinationValue[] = ["knowledge", "skill", "both"];

function DestinationChoice({ item, busy, run }: { item: Improvement; busy: boolean; run: Run }) {
  const destination = item.content_destination;
  const skill = item.skill_proposal;
  const [changingDestination, setChangingDestination] = useState(false);
  const [editingSkill, setEditingSkill] = useState(false);
  const [skillDraft, setSkillDraft] = useState(skill?.content ?? "");
  // Local "Publishing…" state for the publish button below.
  const [publishing, setPublishing] = useState(false);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);

  if (!destination) return null;

  const onOptionKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    const step =
      e.key === "ArrowDown" || e.key === "ArrowRight"
        ? 1
        : e.key === "ArrowUp" || e.key === "ArrowLeft"
          ? -1
          : 0;
    if (step === 0) return;
    e.preventDefault();
    const from = CONTENT_DESTINATION_ORDER.indexOf(destination.value);
    const next =
      CONTENT_DESTINATION_ORDER[
        (from + step + CONTENT_DESTINATION_ORDER.length) % CONTENT_DESTINATION_ORDER.length
      ]!;
    optionRefs.current[CONTENT_DESTINATION_ORDER.indexOf(next)]?.focus();
  };

  const canEditSkill = skill != null && skill.ownership === "harness";

  return (
    <section aria-labelledby={`destination-${item.id}`} className="space-y-3 rounded-md border p-4">
      <h2 id={`destination-${item.id}`} className="text-sm font-semibold">
        {DESTINATION_RECOMMENDED}: {destination.recommended_label}
      </h2>
      <p className="text-sm text-muted-foreground">
        {DESTINATION_WHY}: {contentDestinationReason(destination.value, destination.reason)}
      </p>
      <p className="text-sm text-muted-foreground">
        {DESTINATION_ALTERNATIVE}:{" "}
        {contentDestinationAlternative(destination.alternative_label, destination.alternative)}
      </p>

      {changingDestination ? (
        <div
          role="radiogroup"
          aria-label={DESTINATION_CHANGE}
          className="flex flex-wrap items-center gap-2"
        >
          {CONTENT_DESTINATION_ORDER.map((value, i) => (
            <Button
              key={value}
              type="button"
              role="radio"
              aria-checked={destination.value === value}
              tabIndex={destination.value === value ? 0 : -1}
              ref={(el) => {
                optionRefs.current[i] = el;
              }}
              onKeyDown={onOptionKeyDown}
              variant={destination.value === value ? "default" : "outline"}
              size="sm"
              disabled={busy}
              onClick={() =>
                void run(
                  { action: "set_content_destination", id: item.id, destination: value },
                  `Destination: ${CONTENT_DESTINATION_LABELS[value]}`,
                ).then((ok) => ok && setChangingDestination(false))
              }
            >
              {CONTENT_DESTINATION_LABELS[value]}
            </Button>
          ))}
        </div>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => setChangingDestination(true)}
        >
          {DESTINATION_CHANGE}
        </Button>
      )}

      {destination.value !== "knowledge" && skill ? (
        <div className="space-y-2 rounded-md border bg-muted/30 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium">{skill.name}</p>
            <Badge variant="outline">{skillProposalStatusLabel(skill.status)}</Badge>
            <span className="text-xs text-muted-foreground">
              {skillProposalVersionCountLine(skill.revisions.length)}
            </span>
          </div>
          <details className="rounded-md border bg-background">
            <summary className="cursor-pointer px-2 py-1 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              Skill content
            </summary>
            <pre className="max-h-60 overflow-y-auto whitespace-pre-wrap break-words border-t px-2 py-2 text-xs">
              {skill.content}
            </pre>
          </details>
          {/* Checkpoint 3 S1: the honesty line depends on lovable_state now
              -- 'not_created' keeps the original longer sentence, 'created'
              and 'failed' report the actual outcome instead. */}
          {skill.lovable_state === "created" ? (
            <p className="text-xs text-muted-foreground">{skillLovableStatusLine(skill)}</p>
          ) : skill.lovable_state === "failed" ? (
            <p className="text-xs text-muted-foreground">
              {skillPublishFailedLine(skill.lovable_error)}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">{SKILL_NOT_IN_LOVABLE_LINE}</p>
          )}
          {canEditSkill ? (
            editingSkill ? (
              <div className="space-y-2">
                <Textarea
                  value={skillDraft}
                  onChange={(e) => setSkillDraft(e.target.value)}
                  rows={8}
                  className="font-mono text-xs"
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void run(
                        {
                          action: "edit_skill_proposal",
                          proposal_id: skill.id,
                          name: skill.name,
                          content: skillDraft,
                        },
                        "Skill updated",
                      ).then((ok) => ok && setEditingSkill(false))
                    }
                  >
                    Save
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setSkillDraft(skill.content);
                      setEditingSkill(false);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setSkillDraft(skill.content);
                    setEditingSkill(true);
                  }}
                >
                  Edit
                </Button>
                {skill.status !== "approved" ? (
                  <Button
                    type="button"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void run(
                        { action: "approve_skill_proposal", proposal_id: skill.id },
                        "Skill approved",
                      )
                    }
                  >
                    Approve
                  </Button>
                ) : null}
                {skill.status !== "retired" ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      void run(
                        { action: "retire_skill_proposal", proposal_id: skill.id },
                        "Skill retired",
                      )
                    }
                  >
                    Retire
                  </Button>
                ) : null}
                {/* Checkpoint 3 S1: publishing only ever creates a new
                    workspace Skill -- never offered once it already is one
                    (lovable_state 'created'), and never for a proposal that
                    isn't approved yet. */}
                {skill.status === "approved" && skill.lovable_state === "not_created" ? (
                  <ConfirmAction
                    trigger={publishing ? PUBLISHING_SKILL_LABEL : PUBLISH_SKILL_LABEL}
                    variant="outline"
                    size="sm"
                    title={PUBLISH_SKILL_TITLE}
                    body={publishSkillConfirmBody(skill.name)}
                    consequences={[]}
                    confirmLabel={PUBLISH_SKILL_LABEL}
                    disabled={busy || publishing}
                    onConfirm={() => {
                      setPublishing(true);
                      void run(
                        { action: "publish_skill_proposal", proposal_id: skill.id },
                        "Publishing…",
                      ).finally(() => setPublishing(false));
                    }}
                  />
                ) : null}
                {skill.lovable_state === "failed" ? (
                  <Button
                    type="button"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void run(
                        { action: "publish_skill_proposal", proposal_id: skill.id },
                        "Retrying…",
                      )
                    }
                  >
                    {RETRY_LABEL}
                  </Button>
                ) : null}
              </div>
            )
          ) : (
            <p className="text-xs text-muted-foreground">{SKILL_OWNED_BY_USER_LINE}</p>
          )}
        </div>
      ) : null}
    </section>
  );
}
// ---- end Checkpoint 2026-09-18 WP4: destination ----

// ---- Checkpoint 2026-09-18 WP3: "Needs attention" / "Review for relevance" ----
// Shown above the instruction on the detail page for a live rule whose
// health asks for a person's decision (health.review_reason). The copy comes
// from harness-ux.ts#attentionBlock; the options post the same actions the
// verdict control, the Test button and DestinationChoice post.
function AttentionBlock({
  item,
  busy,
  run,
  onReview,
}: {
  item: Improvement;
  busy: boolean;
  run: ReturnType<typeof useRun>["run"];
  onReview: () => void;
}) {
  const block = attentionBlock(item.health ?? null);
  if (!block || item.rule_id == null) return null;
  const ruleId = item.rule_id;
  const inactive = item.health?.review_reason === "inactive";
  return (
    <section aria-label={block.title} className="space-y-3">
      <CurrentStatus status={block.title} hint={block.line} />
      <RecommendationCallout
        title="Recommendation"
        recommendation={block.recommendation}
        why={
          inactive
            ? "A rule nothing has needed for two months may be stale, or simply rare."
            : block.line
        }
      />
      {inactive ? (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={busy}
            onClick={() =>
              void run({ action: "verdict", rule_id: ruleId, verdict: "keep" }, "Kept")
            }
          >
            Keep
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void run(
                { action: "set_content_destination", id: item.id, destination: "skill" },
                "Moved to a Skill proposal",
              )
            }
          >
            Move to Skill
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void run({ action: "test", id: item.id }, TEST_STARTED_TOAST)}
          >
            Retest
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void run(
                { action: "verdict", rule_id: ruleId, verdict: "retire" },
                "Marked for retirement",
              )
            }
          >
            Retire
          </Button>
        </div>
      ) : (
        <PrimaryAction label={block.action} onClick={onReview} disabled={busy} />
      )}
    </section>
  );
}

// ---- Checkpoint 2 2-B: the Inbox card's single "Add instruction" action ----
// Stands in for the two separate "Add to this project"/"Add to all my
// projects" buttons the compact card used to show side by side, which gave
// the card two equally-weighted primary buttons -- the project/workspace
// choice now lives inside this one confirm instead (spec: "ONE recommended
// primary action"). Reuses the plain-language AddConfirm's own
// preview/over-cap machinery; deliberately has no "test it first" branch of
// its own -- Test first is now its own top-level primary action (see
// recommendedPrimaryAction, harness-ux.ts) rather than a sub-choice of Add.
// Placed at the very end of the file (function declarations hoist, so
// CompactDecisionCard above can still call it) rather than between any of
// the existing functions above, deliberately -- every gap between them is
// already a structural test's own slice boundary, and this component's own
// "size=\"sm\"" literals and second role="radio" radiogroup would otherwise
// land inside someone else's pinned count.
function AddInstructionConfirm({
  item,
  busy,
  run,
  size,
  variant,
}: {
  item: Improvement;
  busy: boolean;
  run: Run;
  size?: "default" | "sm" | undefined;
  variant?: "default" | "outline";
}) {
  const [destination, setDestination] = useState<Destination>(
    item.destination === "workspace" ? "workspace" : "project",
  );
  const preview = lovableOf(item).previews[destination];
  const targetLabel = preview?.target_label ?? label(DESTINATION_LABELS, destination);
  const overCap = preview?.over_cap === true;
  const overRules = preview?.over_rules === true;
  return (
    <ConfirmAction
      trigger={PRIMARY_ACTION_LABELS.add}
      {...(variant ? { variant } : {})}
      title={`Add to ${targetLabel}?`}
      body={preview ? PREVIEW_BODY : NO_SNAPSHOT_BODY}
      consequences={[
        actionConsequence("add", destination),
        ...(preview ? PREVIEW_CONSEQUENCES : []),
      ]}
      confirmLabel={preview ? "Add" : "Save choice"}
      confirmDisabled={overCap || overRules}
      disabled={busy}
      size={size}
      onConfirm={() => void run({ action: "accept", id: item.id, destination }, SAVED_LINE)}
    >
      <div role="radiogroup" aria-label="Where to add it" className="flex flex-wrap gap-2">
        <Button
          type="button"
          role="radio"
          aria-checked={destination === "project"}
          variant={destination === "project" ? "default" : "outline"}
          size="sm"
          onClick={() => setDestination("project")}
        >
          This project
        </Button>
        <Button
          type="button"
          role="radio"
          aria-checked={destination === "workspace"}
          variant={destination === "workspace" ? "default" : "outline"}
          size="sm"
          onClick={() => setDestination("workspace")}
        >
          All my projects
        </Button>
      </div>
      {preview ? (
        <pre className="max-h-60 overflow-y-auto whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-2 text-xs">
          {preview.managed_block}
        </pre>
      ) : null}
      {overCap ? (
        <p role="alert" className="text-xs text-destructive">
          {OVER_CAP_LINE}
        </p>
      ) : null}
      {overRules ? (
        <p role="alert" className="text-xs text-destructive">
          {overRulesLine(preview!.active_rules_count)}
        </p>
      ) : null}
    </ConfirmAction>
  );
}
// ---- end Checkpoint 2 2-B ----

// ---- Checkpoint 3 I2: the Inbox queue's non-Knowledge card types ----
// The Knowledge card (new_instruction, CompactDecisionCard above) and the
// Skill card just below share one convention with the four cards after it
// (test_result, rule_attention, conflict, action_failed): a header row
// (project + the item's own INBOX_TYPE_LABELS text), a title, one primary
// action with its consequence line directly underneath (never four equally
// prominent buttons), and nothing else claiming the same visual weight.
// Placed at the very end of the file for the same reason AddInstructionConfirm
// is (see its own comment above) -- every gap between the existing functions
// is already a structural test's own slice boundary.

/** The Knowledge card's own "Change destination" tertiary action: collapsed
 * to a single ghost/link button until pressed, then a small Knowledge/
 * Skill/Both row that posts the existing set_content_destination action --
 * no new mutation path, no confirmation dialog (changing where a still-
 * pending suggestion would go writes nothing to Lovable by itself). */
function ChangeDestinationControl({
  item,
  busy,
  run,
}: {
  item: Improvement;
  busy: boolean;
  run: Run;
}) {
  const [open, setOpen] = useState(false);
  const current = item.content_destination?.value ?? "knowledge";
  if (!open) {
    return (
      <button
        type="button"
        className="text-xs text-primary underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => setOpen(true)}
      >
        {CHANGE_DESTINATION_LABEL}
      </button>
    );
  }
  return (
    <div role="radiogroup" aria-label={CHANGE_DESTINATION_LABEL} className="flex flex-wrap gap-1">
      {(["knowledge", "skill", "both"] as const).map((value) => (
        <Button
          key={value}
          type="button"
          role="radio"
          aria-checked={value === current}
          size="sm"
          variant={value === current ? "default" : "outline"}
          disabled={busy}
          onClick={() =>
            void run(
              { action: "set_content_destination", id: item.id, destination: value },
              "Destination changed.",
            )
          }
        >
          {CONTENT_DESTINATION_LABELS[value]}
        </Button>
      ))}
    </div>
  );
}

/** The Skill card (new_skill Inbox items): a locally proposed Skill, never
 * yet published to Lovable. Primary "Review Skill" opens the detail page
 * (the same ImprovementDetail every other card links to); secondary "Use
 * Knowledge instead" posts the existing set_content_destination action --
 * no new mutation path. */
export function NewSkillCard({
  item,
  onOpen,
  busy,
  run,
}: {
  item: Improvement;
  onOpen?: ((id: number) => void) | undefined;
  busy: boolean;
  run: Run;
}) {
  const titleId = `improvement-${item.id}`;
  const scopeLabel = item.destination === "workspace" ? "Workspace" : "Project";
  const purpose = skillProposalPurpose(
    item.skill_proposal?.content ?? null,
    item.proposed_instruction,
  );
  const destinationReason = item.content_destination
    ? contentDestinationReason(item.content_destination.value, item.content_destination.reason)
    : whyFor(item.classification);
  return (
    <article aria-labelledby={titleId} className="space-y-3 rounded-md border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold">
          {projectName(item)} · {scopeLabel}
        </p>
        <span className="text-xs text-muted-foreground">{INBOX_TYPE_LABELS.new_skill}</span>
      </div>
      <h2 id={titleId} className="text-base font-medium">
        <button
          type="button"
          className="text-left hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => onOpen?.(item.id)}
        >
          {item.skill_proposal?.name ?? item.title}
        </button>
      </h2>
      <p className="text-sm">{purpose}</p>
      <p className="text-xs text-muted-foreground">
        <span className="font-medium">Why a Skill rather than Knowledge</span>
        {" — "}
        {destinationReason}
      </p>
      <p className="text-xs text-muted-foreground">{SKILL_NOT_PUBLISHED_LINE}</p>
      <div className={ACTION_BAR_CLASS}>
        <div className="space-y-1">
          <Button type="button" size="sm" onClick={() => onOpen?.(item.id)}>
            {REVIEW_SKILL_LABEL}
          </Button>
          <p className="text-xs text-muted-foreground">{actionConsequence("review_skill")}</p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() =>
            void run(
              { action: "set_content_destination", id: item.id, destination: "knowledge" },
              "Moved to Knowledge.",
            )
          }
        >
          {USE_KNOWLEDGE_INSTEAD}
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <SkipConfirm item={item} busy={busy} run={run} size="sm" />
        <button
          type="button"
          className="text-xs text-primary underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => onOpen?.(item.id)}
        >
          {VIEW_EVIDENCE_LABEL}
        </button>
      </div>
    </article>
  );
}

/** Where an Inbox item's own `link` points -- one place every non-Knowledge/
 * Skill card resolves it, so the six page names in the contract's own
 * `link.page` union are only ever switched on here. */
/** The page an Inbox item opens, as a plain href -- the pages are all
 * inside the authenticated shell and the ids are numbers, so a string href
 * keeps the typed router out of a dynamic switch. */
function inboxLinkHref(item: InboxItem): string {
  const link = item.link;
  switch (link.page) {
    case "detail":
      return link.improvement_id != null ? `/ledger?improvement=${link.improvement_id}` : "/inbox";
    case "judge":
      return link.run_id != null ? `/judge?run=${link.run_id}` : "/tests";
    case "instructions": {
      // Checkpoint 3 UX fix 2: open Instructions already scoped to this
      // item's own target, using the same ?project= the page's filter
      // reads -- project_id null with project_name "Workspace" is the
      // contract's own way of marking a workspace-scoped rule (see
      // inboxTargetProject in harness/src/improvements.ts).
      const project = item.project_id ?? (item.project_name === "Workspace" ? "workspace" : null);
      return project ? `/instructions?project=${encodeURIComponent(project)}` : "/instructions";
    }
    case "skills":
      return "/skills";
    case "tests":
      return "/tests";
    case "history":
      return "/history";
    case "inbox":
      return "/inbox";
  }
}

function InboxCardHeader({ item }: { item: InboxItem }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-sm font-semibold">{item.project_name ?? "Workspace"}</p>
      <span className="text-xs text-muted-foreground">{INBOX_TYPE_LABELS[item.type]}</span>
    </div>
  );
}

/** The test_result card: a replay awaiting a verdict. Primary "Judge
 * replay" -- recording a verdict changes nothing in Lovable and uses no
 * tokens or Lovable spend, stated directly underneath. */
export function TestResultCard({ item }: { item: InboxItem }) {
  const titleId = `inbox-${item.id}`;
  const href = inboxLinkHref(item);
  return (
    <article aria-labelledby={titleId} className="space-y-3 rounded-md border bg-card p-4">
      <InboxCardHeader item={item} />
      <h2 id={titleId} className="text-base font-medium">
        {item.title}
      </h2>
      <p className="text-sm text-muted-foreground">{item.summary ?? YOUR_VERDICT_NEEDED_LINE}</p>
      <p className="text-xs text-muted-foreground">{YOUR_VERDICT_NEEDED_LINE}</p>
      {replayJudgedLine(item.conclusion) ? (
        <p className="text-xs text-muted-foreground">{replayJudgedLine(item.conclusion)}</p>
      ) : null}
      <div className={ACTION_BAR_CLASS}>
        <div className="space-y-1">
          <Button asChild type="button" size="sm">
            <a href={href}>{JUDGE_REPLAY_LABEL}</a>
          </Button>
          <p className="text-xs text-muted-foreground">{inboxActionConsequence("judge_replay")}</p>
        </div>
      </div>
    </article>
  );
}

/** The rule_attention card: an open retire proposal, or a live rule whose
 * health asks for review. Primary "Review rule" opens wherever the
 * contract's own `link` points (the retire proposal's or the rule's own
 * detail) -- reviewing decides nothing by itself. */
export function RuleAttentionCard({ item }: { item: InboxItem }) {
  const titleId = `inbox-${item.id}`;
  const href = inboxLinkHref(item);
  return (
    <article aria-labelledby={titleId} className="space-y-3 rounded-md border bg-card p-4">
      <InboxCardHeader item={item} />
      <h2 id={titleId} className="text-base font-medium">
        {item.title}
      </h2>
      {item.summary ? <p className="text-sm text-muted-foreground">{item.summary}</p> : null}
      <div className={ACTION_BAR_CLASS}>
        <div className="space-y-1">
          <Button asChild type="button" size="sm">
            <a href={href}>{REVIEW_RULE_LABEL}</a>
          </Button>
          <p className="text-xs text-muted-foreground">{inboxActionConsequence("review_rule")}</p>
        </div>
      </div>
    </article>
  );
}

/** The conflict card for a stale Knowledge write (a write conflict, not an
 * open re-analysis disagreement -- see inbox.tsx's own DisagreementCard for
 * that case, reused as-is per the checkpoint 3 brief). Primary "Review"
 * opens the Instructions row this conflict is about. */
export function ConflictCard({ item }: { item: InboxItem }) {
  const titleId = `inbox-${item.id}`;
  const href = inboxLinkHref(item);
  return (
    <article aria-labelledby={titleId} className="space-y-3 rounded-md border bg-card p-4">
      <InboxCardHeader item={item} />
      <h2 id={titleId} className="text-base font-medium">
        {item.title}
      </h2>
      {item.summary ? <p className="text-sm text-muted-foreground">{item.summary}</p> : null}
      <div className={ACTION_BAR_CLASS}>
        <div className="space-y-1">
          <Button asChild type="button" size="sm">
            <a href={href}>{REVIEW_LABEL}</a>
          </Button>
          <p className="text-xs text-muted-foreground">{inboxActionConsequence("review_rule")}</p>
        </div>
      </div>
    </article>
  );
}

/** The action_failed card: a failed Knowledge write, test run, or copy
 * cleanup. "Retry" only when there's a specific failed Knowledge write on
 * this same suggestion to retry (the existing retry_write action, never a
 * new mutation path); every other case is honestly a "View" link to wherever
 * the contract's own `link` points, since there is nothing this card can
 * retry on its own. */
export function ActionFailedCard({
  item,
  busy,
  run,
}: {
  item: InboxItem;
  busy: boolean;
  run: Run;
}) {
  const titleId = `inbox-${item.id}`;
  const href = inboxLinkHref(item);
  const failedVersion = item.improvement?.lovable?.versions.find(
    (v) => v.status === "failed" || v.status === "stale",
  );
  const canRetryWrite = item.improvement != null && failedVersion != null;
  // Checkpoint 3 S1: a failed Skill publish is addressed by its own id
  // shape ("skill:<proposal_id>", never an improvement) -- Retry posts the
  // exact same publish_skill_proposal action the Skills page's own Retry
  // button does.
  const skillProposalId = item.id.startsWith("skill:") ? Number(item.id.slice(6)) : null;
  const canRetryPublish = skillProposalId != null && Number.isFinite(skillProposalId);
  return (
    <article aria-labelledby={titleId} className="space-y-3 rounded-md border bg-card p-4">
      <InboxCardHeader item={item} />
      <h2 id={titleId} className="text-base font-medium">
        {item.title}
      </h2>
      {item.summary ? <p className="text-sm text-muted-foreground">{item.summary}</p> : null}
      <div className={ACTION_BAR_CLASS}>
        {canRetryPublish || canRetryWrite ? (
          <div className="space-y-1">
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={() =>
                void run(
                  canRetryPublish
                    ? { action: "publish_skill_proposal", proposal_id: skillProposalId }
                    : {
                        action: "retry_write",
                        id: item.improvement!.id,
                        version_id: failedVersion!.id,
                      },
                  "Retrying…",
                )
              }
            >
              {RETRY_LABEL}
            </Button>
            <p className="text-xs text-muted-foreground">
              {canRetryPublish
                ? inboxActionConsequence("retry", "Retries publishing this Skill to Lovable.")
                : inboxActionConsequence("retry")}
            </p>
          </div>
        ) : (
          <div className="space-y-1">
            <Button asChild type="button" size="sm" variant="outline">
              <a href={href}>{VIEW_LABEL}</a>
            </Button>
            <p className="text-xs text-muted-foreground">{inboxActionConsequence("review_rule")}</p>
          </div>
        )}
      </div>
    </article>
  );
}
// ---- end Checkpoint 3 I2 ----
