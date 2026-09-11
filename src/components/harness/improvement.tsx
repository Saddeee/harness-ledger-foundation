// One "Improvement" per piece of feedback the user gave Lovable: the
// correction and its proposed instruction, presented as one card whose
// buttons are the decision. Simple by default, complete on demand. Only
// fetches the local Harness routes; never talks to Lovable itself -- adding
// to Lovable is recorded here and executed by Harness afterwards.
import { useState } from "react";
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
  lovableStatusLine,
  whyFor,
  wordingChangeLine,
} from "@/lib/harness-ux";

import {
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
  "Harness hasn't read your current Knowledge yet. Your choice is saved; Harness will show you the exact text before writing.";
const PREVIEW_BODY = "This is the exact text Harness will write to your Lovable Knowledge.";
const PREVIEW_CONSEQUENCES = [
  "Uses no Lovable credits.",
  "You can restore the previous version at any time.",
];
const OVER_CAP_LINE =
  "This would exceed the Knowledge limit — shorten the instruction or your existing Knowledge first.";
const SAVED_LINE = "Saved — now under Improvements › Waiting to be added.";
const RESTORE_TITLE = "Restore the previous Knowledge?";
const RESTORE_BODY = "Harness will write the earlier text back, as a new version.";
const NO_INSTRUCTION = "Harness hasn't drafted an instruction yet.";

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
  const preview = lovableOf(item).previews[destination];
  const targetLabel = preview?.target_label ?? label(DESTINATION_LABELS, destination);
  const overCap = preview?.over_cap === true;
  return (
    <ConfirmAction
      trigger={trigger ?? ADD_LABELS[destination]}
      title={`Add to ${targetLabel}?`}
      body={preview ? PREVIEW_BODY : NO_SNAPSHOT_BODY}
      consequences={preview ? PREVIEW_CONSEQUENCES : []}
      confirmLabel={preview ? "Add" : "Save choice"}
      confirmDisabled={overCap}
      disabled={busy}
      {...(variant ? { variant } : {})}
      onConfirm={() => void run({ action: "accept", id: item.id, destination }, SAVED_LINE)}
    >
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

function DecidedStatus({ item, busy, run }: { item: Improvement; busy: boolean; run: Run }) {
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
        {decisionSentence({ decision: item.decision, destination: item.destination, lovable })}
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
      <details>
        <summary className="cursor-pointer text-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          Change decision
        </summary>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
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
                    trigger={`Add to ${label(DESTINATION_LABELS, d)} instead`}
                  />
                ))}
              <SkipConfirm item={item} busy={busy} run={run} />
            </>
          ) : null}
          {accepted && written ? (
            <ConfirmAction
              trigger="Restore previous version"
              variant="outline"
              title={RESTORE_TITLE}
              body={RESTORE_BODY}
              consequences={[]}
              confirmLabel="Restore"
              disabled={busy || !latestWritten}
              onConfirm={() => {
                if (!latestWritten) return;
                void run(
                  { action: "restore", id: item.id, version_id: latestWritten.id },
                  "Restore requested — Harness will write the earlier text back",
                );
              }}
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
      </details>
    </div>
  );
}

// ---- The card: the decision itself (Inbox, Improvements, detail) ----

export function DecisionCard({
  item,
  onChanged,
  onOpen,
  titleAs = "h2",
  busy: busyProp,
  run: runProp,
}: {
  item: Improvement;
  onChanged: () => void;
  onOpen?: (id: number) => void;
  titleAs?: "h1" | "h2";
  busy?: boolean;
  run?: Run;
}) {
  const own = useRun(onChanged);
  const busy = busyProp ?? own.busy;
  const run = runProp ?? own.run;
  const pending = item.decision.status === "pending";
  const Title = titleAs;
  const titleId = `improvement-${item.id}`;

  return (
    <article aria-labelledby={titleId} className="space-y-3 rounded-md border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="text-sm font-semibold">{projectName(item)}</p>
        {pending ? null : <Badge variant="secondary">{groupOf(item)}</Badge>}
      </div>
      <Title
        id={titleId}
        className={titleAs === "h1" ? "text-2xl font-semibold" : "text-base font-medium"}
      >
        {item.title}
      </Title>
      {item.proposed_instruction ? (
        <blockquote className="rounded-md border bg-muted/30 p-3 text-sm">
          {item.proposed_instruction}
        </blockquote>
      ) : (
        <p className="text-sm text-muted-foreground">{NO_INSTRUCTION}</p>
      )}

      {pending ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <AddConfirm item={item} destination="project" busy={busy} run={run} />
          <AddConfirm item={item} destination="workspace" busy={busy} run={run} variant="outline" />
          <SkipConfirm item={item} busy={busy} run={run} />
        </div>
      ) : (
        <DecidedStatus item={item} busy={busy} run={run} />
      )}

      {onOpen ? (
        <div className="flex justify-end">
          <button
            type="button"
            className="text-sm text-primary underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onOpen(item.id)}
          >
            Details
          </button>
        </div>
      ) : null}
    </article>
  );
}

// Kept only until the Improvements page moves to DecisionCard (next task).
export function ImprovementCard({
  item,
  onOpen,
}: {
  item: Improvement;
  onOpen: (id: number) => void;
}) {
  return <DecisionCard item={item} onChanged={() => {}} onOpen={onOpen} />;
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
}: {
  item: Improvement;
  onBack: () => void;
  onChanged: () => void;
  backLabel?: string;
}) {
  const { busy, run } = useRun(onChanged);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.proposed_instruction ?? "");
  const [reason, setReason] = useState("");

  const lovable = lovableOf(item);
  const accepted = item.decision.status === "accepted";
  const skipped = item.decision.status === "skipped";

  return (
    <div className="space-y-6">
      <div>
        <button
          type="button"
          className="text-sm text-primary underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onBack}
        >
          {backLabel}
        </button>
      </div>

      <DecisionCard item={item} onChanged={onChanged} busy={busy} run={run} titleAs="h1" />

      <div className="space-y-2">
        {item.proposed_instruction ? (
          <button
            type="button"
            className="text-xs text-primary underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-expanded={editing}
            onClick={() => setEditing((v) => !v)}
          >
            {editing ? "Cancel wording change" : "Change the wording"}
          </button>
        ) : null}
        {editing ? (
          <div className="space-y-2 rounded-md border p-3">
            <label htmlFor={`wording-${item.id}`} className="text-xs font-medium">
              Instruction
            </label>
            <Textarea
              id={`wording-${item.id}`}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={3}
            />
            <label htmlFor={`wording-reason-${item.id}`} className="text-xs font-medium">
              Why you changed it (optional)
            </label>
            <input
              id={`wording-reason-${item.id}`}
              className="w-full rounded-md border bg-background px-3 py-1.5 text-sm"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button
                size="sm"
                disabled={busy || draft.trim().length === 0}
                onClick={() =>
                  void run(
                    { action: "change_wording", id: item.id, instruction: draft, reason },
                    "Wording updated",
                  ).then((ok) => ok && setEditing(false))
                }
              >
                Save wording
              </Button>
              <Button size="sm" variant="outline" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : null}
        <p className="text-sm text-muted-foreground">{whyFor(item.classification)}</p>
      </div>

      {item.decision.divergence ? (
        <p role="status" className="rounded-md border p-3 text-sm">
          {item.decision.divergence}
        </p>
      ) : null}

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
                {lovableStatusLine({ write_status: v.status, written_at: v.written_at })}
                {v.restored_from_version_id != null ? " · restored from an earlier version" : ""}
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
