// One "Improvement" per piece of feedback the user gave Lovable: the
// correction and its proposed instruction, presented as one card whose
// buttons are the decision. Simple by default, complete on demand. Only
// fetches the local Harness routes; never talks to Lovable itself -- adding
// to Lovable is recorded here and executed by Harness afterwards.
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import {
  AdvancedDetails,
  ConfirmAction,
  DetailSection,
  ProcessProgress,
} from "@/components/harness/decision-layout";
import {
  CLASSIFICATION_LABELS,
  DESTINATION_LABELS,
  KNOWLEDGE_CHAR_LIMIT,
  decisionSentence,
  formatDate,
  formatDay,
  label,
  lovableReplyText,
  proveCostLine,
  type StatusCtx,
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
  type Improvement,
  type Message,
} from "@/lib/improvements-client";

export type { Improvement, Message };

// ---- Shared copy (kept in one place so the tests can count it) ----

const NO_SNAPSHOT_BODY =
  "Harness hasn't read your current Knowledge yet. Your choice is saved; at the next sync Harness reads it, then writes this exact text. You can see the result on the Instructions page.";
const PREVIEW_BODY = "This is the exact text Harness will write to your Lovable Knowledge.";
const PREVIEW_CONSEQUENCES = ["You can restore the previous version at any time."];
const OVER_CAP_LINE =
  "This would exceed the Knowledge limit — shorten the instruction or your existing Knowledge first.";
function overRulesLine(activeRulesCount: number): string {
  return `This project already has ${activeRulesCount} active rules. Retire one on the Instructions page first.`;
}
const SAVED_LINE = "Added — will be written at the next sync.";
const RESTORE_TITLE = "Restore the previous Knowledge?";
const RESTORE_BODY = "Harness will write the earlier text back, as a new version.";
const NO_INSTRUCTION = "Harness hasn't drafted an instruction yet.";
const ADD_NOW_HELP = "Harness writes this exact text at the next sync. Uses no credits.";

const LONG_TEXT = 600;

type Destination = "project" | "workspace";

const ADD_LABELS: Record<Destination, string> = {
  project: "Add to this project",
  workspace: "Add to all my projects",
};

type Run = (body: Record<string, unknown>, msg: string) => Promise<boolean>;

// One busy flag and one toast pattern per card (or per wording editor).
function useRun(onChanged: () => void): { busy: boolean; run: Run } {
  const [busy, setBusy] = useState(false);
  const run: Run = async (body, msg) => {
    setBusy(true);
    try {
      await post(body);
      toast.success(msg);
      onChanged();
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

// ---- Confirmations ----

// The "Add" confirmation: shows the exact text that would be written when
// Harness has a snapshot of the current Knowledge; otherwise records the
// choice and says so.
function AddConfirm({
  item,
  destination,
  busy,
  run,
  trigger,
  variant,
}: {
  item: Improvement;
  destination: Destination;
  busy: boolean;
  run: Run;
  trigger?: string;
  variant?: "default" | "outline";
}) {
  const [choice, setChoice] = useState<"now" | "test" | null>(null);
  const wantsTest = choice === "test";
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
      title={`Add to ${targetLabel}?`}
      body={preview ? PREVIEW_BODY : NO_SNAPSHOT_BODY}
      consequences={preview ? PREVIEW_CONSEQUENCES : []}
      confirmLabel={wantsTest ? "Save for testing" : preview ? "Add" : "Save choice"}
      confirmDisabled={overCap || overRules || choice == null}
      disabled={busy}
      onOpenChange={(open) => {
        if (!open) setChoice(null);
      }}
      {...(variant ? { variant } : {})}
      onConfirm={() =>
        void run(
          {
            action: "accept",
            id: item.id,
            destination,
            ...(wantsTest ? { test_first: true } : {}),
          },
          wantsTest ? "Saved for testing." : SAVED_LINE,
        )
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
          >
            Test it first
          </Button>
          <p className="text-xs text-muted-foreground">
            {`Harness runs the same request with and without this instruction in a temporary copy of the project and shows you the difference before anything is written. ${proveCostLine(item.proof?.lovable_credits_max)} Testing is not switched on yet; your choice is saved and runs when it is.`}
          </p>
        </div>
      </div>
      {preview ? (
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

function SkipConfirm({ item, busy, run }: { item: Improvement; busy: boolean; run: Run }) {
  return (
    <ConfirmAction
      trigger="Skip"
      variant="ghost"
      title="Skip this improvement?"
      body="Harness won't suggest it again."
      consequences={["Nothing changes in Lovable."]}
      confirmLabel="Skip"
      disabled={busy}
      onConfirm={() => void run({ action: "skip", id: item.id }, "Skipped")}
    />
  );
}

// ---- Decided items: where it stands, and how to change your mind ----

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
  const skipped = item.decision.status === "skipped";
  const written = lovable.write_status === "written";
  const latestWritten = lovable.versions
    .filter((v) => v.status === "written")
    .sort((a, b) => b.id - a.id)[0];

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
      {accepted && lovable.write_status === "none" ? (
        <p className="text-xs text-muted-foreground">
          Waiting for Harness to read your current Knowledge. You'll see the exact text before
          anything is written.
        </p>
      ) : null}
      {accepted && lovable.write_status === "stale" && lovable.stale_reason ? (
        <p className="text-xs text-muted-foreground">{lovable.stale_reason}</p>
      ) : null}
      {accepted && lovable.write_status === "failed" ? (
        <p className="text-xs text-muted-foreground">
          Harness could not write this to Lovable. You can try again, choose the other destination,
          or skip it.
        </p>
      ) : null}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
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
                  trigger={`${ADD_LABELS[d]} instead`}
                />
              ))}
            <SkipConfirm item={item} busy={busy} run={run} />
          </>
        ) : null}
        {accepted &&
        lovable.write_status === "failed" &&
        (item.destination === "project" || item.destination === "workspace") ? (
          <AddConfirm
            item={item}
            destination={item.destination}
            busy={busy}
            run={run}
            variant="outline"
            trigger="Try adding again"
          />
        ) : null}
        {accepted && written && latestWritten ? (
          <ConfirmAction
            trigger="Restore previous version"
            variant="outline"
            title={RESTORE_TITLE}
            body={RESTORE_BODY}
            consequences={[]}
            confirmLabel="Restore"
            disabled={busy}
            onConfirm={() =>
              void run(
                { action: "restore", id: item.id, version_id: latestWritten.id },
                "Restore requested — Harness will write the earlier text back",
              )
            }
          />
        ) : null}
        {skipped ? (
          <Button
            variant="outline"
            className="w-full sm:w-auto"
            disabled={busy}
            onClick={() =>
              void run({ action: "reopen", id: item.id }, "Reopened — waiting for your decision")
            }
          >
            Reopen
          </Button>
        ) : null}
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

export function DecisionCard({
  item,
  onChanged,
  onOpen,
  titleAs = "h2",
  busy: busyProp,
  run: runProp,
  editable,
}: {
  item: Improvement;
  onChanged: () => void;
  onOpen?: (id: number) => void;
  titleAs?: "h1" | "h2";
  busy?: boolean;
  run?: Run;
  editable?: EditableState;
}) {
  const own = useRun(onChanged);
  const busy = busyProp ?? own.busy;
  const run = runProp ?? own.run;
  const executor = useQuery(executorQueryOptions);
  const ctx = {
    nextSyncAt: executor.data?.next_run_at ?? null,
    connected: executor.data?.connection?.connected,
    testFirst: item.decision.test_first,
    // A workspace write isn't gated by one project's flag, so this only
    // ever applies to project-destination items (Round 3 §5).
    autoWriteOff: item.destination === "project" && item.lovable?.auto_write === false,
  };
  const pending = item.decision.status === "pending";
  const Title = titleAs;
  const titleId = `improvement-${item.id}`;

  return (
    <article aria-labelledby={titleId} className="space-y-3 rounded-md border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div
          className={
            onOpen
              ? "min-w-0 flex-1 space-y-3 cursor-pointer rounded-md -m-1 p-1 hover:bg-accent/50"
              : "min-w-0 flex-1 space-y-3"
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
          <p className="text-sm font-semibold">{projectName(item)}</p>
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
        {pending ? null : <Badge variant="secondary">{groupOf(item)}</Badge>}
      </div>

      {pending ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <AddConfirm item={item} destination="project" busy={busy} run={run} />
          <AddConfirm item={item} destination="workspace" busy={busy} run={run} variant="outline" />
          <SkipConfirm item={item} busy={busy} run={run} />
        </div>
      ) : (
        <DecidedStatus item={item} busy={busy} run={run} ctx={ctx} />
      )}
    </article>
  );
}

// ---- Detail pieces ----

function MessageBlock({ m }: { m: Message }) {
  const isLovable = m.author === "lovable";
  const readable = isLovable ? lovableReplyText(m.text) : m.text;
  const tooLong = !isLovable && readable.length > LONG_TEXT;
  return (
    <li className="rounded-md border bg-muted/30 p-3">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {isLovable ? "Lovable replied" : "You asked Lovable"}
        {m.sent_at ? ` · ${formatDate(m.sent_at)}` : ""}
      </p>
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
  onChanged: () => void;
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
            No Lovable messages are attached to this improvement.
          </p>
        ) : (
          <ol className="space-y-2">
            {item.evidence.map((m) => (
              <MessageBlock key={m.id} m={m} />
            ))}
          </ol>
        )}
      </section>

      <AdvancedDetails title="Details">
        <ProcessProgress stages={item.stages} />

        <DetailSection title="How Harness read this">
          <p>Harness read this as: {label(CLASSIFICATION_LABELS, item.classification)}.</p>
          {item.decision.decided_at ? (
            <p>
              {skipped ? "You skipped it on" : "You decided on"}{" "}
              {formatDay(item.decision.decided_at)}.
            </p>
          ) : null}
          {accepted && lovable.untested ? (
            <p>Added without a proof — Harness hasn't tested this instruction.</p>
          ) : null}
          <p>Harness analysis uses Harness's own AI, not your Lovable account.</p>
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
              Raw records as Harness stores them. Includes internal identifiers and classifier
              reasoning.
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
