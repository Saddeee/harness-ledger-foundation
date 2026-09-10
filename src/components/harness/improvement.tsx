// One "Improvement" per piece of feedback the user gave Lovable: the
// correction, its proposed instruction and its proof, presented as a single
// item with stages. Simple by default, complete on demand. Only fetches the
// local Harness routes; never talks to Lovable.
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import {
  AdvancedDetails,
  ClickableCard,
  ConfirmAction,
  DetailSection,
  ProcessProgress,
} from "@/components/harness/decision-layout";
import {
  CLASSIFICATION_LABELS,
  STAGE_LABELS,
  decisionSentence,
  formatDate,
  formatDay,
  label,
  lovableReplyText,
  whyFor,
  type Stage,
} from "@/lib/harness-ux";

import {
  fetchImprovements,
  postImprovementAction as post,
  projectName,
  stageComplete,
  type Improvement,
  type Message,
} from "@/lib/improvements-client";

export type { Improvement, Message };

// ---- Shared copy (kept in one place so the tests can count it) ----

const DECISION_CONSEQUENCES = [
  "Nothing is written to Lovable yet — adding isn't switched on. You'll approve the exact Knowledge text first.",
  "Reviewing is free and changes nothing in Lovable.",
];

const NOT_SWITCHED_ON =
  "Adding to Lovable isn't switched on yet — Harness saves your choice and shows you the exact Knowledge text before anything is written.";

const LONG_TEXT = 600;

// ---- Card (Inbox / Improvements lists) ----

export function ImprovementCard({
  item,
  onOpen,
}: {
  item: Improvement;
  onOpen: (id: number) => void;
}) {
  return (
    <ClickableCard onClick={() => onOpen(item.id)} ariaLabel={`Open improvement: ${item.title}`}>
      <p className="text-sm font-semibold">{projectName(item)}</p>
      <p className="mt-1 text-base font-medium">{item.title}</p>
      <p className="mt-1 text-sm text-muted-foreground">{whyFor(item.classification)}</p>
      <div className="mt-2">
        <Badge variant={item.decision.status === "pending" ? "default" : "secondary"}>
          {STAGE_LABELS[item.stage] ?? item.stage}
        </Badge>
      </div>
    </ClickableCard>
  );
}

// ---- Detail ----

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

function DestinationActions({
  item,
  busy,
  run,
  exclude,
}: {
  item: Improvement;
  busy: boolean;
  run: (body: Record<string, unknown>, msg: string) => Promise<void>;
  exclude?: Improvement["destination"];
}) {
  return (
    <>
      {exclude !== "workspace" && (
        <ConfirmAction
          trigger="Add to all my projects"
          title="Add to all my projects?"
          body="Harness will save this as a workspace instruction."
          consequences={DECISION_CONSEQUENCES}
          confirmLabel="Save choice"
          disabled={busy}
          onConfirm={() =>
            run(
              { action: "accept", id: item.id, destination: "workspace" },
              "Saved: add to all my projects",
            )
          }
        />
      )}
      {exclude !== "project" && (
        <ConfirmAction
          trigger="Add to this project only"
          title="Add to this project only?"
          body="Harness will save this as an instruction for this project."
          consequences={DECISION_CONSEQUENCES}
          confirmLabel="Save choice"
          disabled={busy}
          variant={exclude === undefined ? "outline" : "default"}
          onConfirm={() =>
            run(
              { action: "accept", id: item.id, destination: "project" },
              "Saved: add to this project only",
            )
          }
        />
      )}
    </>
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
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.proposed_instruction ?? "");
  const [reason, setReason] = useState("");

  async function run(body: Record<string, unknown>, msg: string) {
    setBusy(true);
    try {
      await post(body);
      toast.success(msg);
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "action failed");
    } finally {
      setBusy(false);
    }
  }

  const pending = item.decision.status === "pending";
  const accepted = item.decision.status === "accepted";
  const skipped = item.decision.status === "skipped";
  const inLovable = stageComplete(item, "in_lovable");
  const statusLine = decisionSentence({
    decision: item.decision,
    destination: item.destination,
    inLovable,
  });

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

      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Project</p>
        <p className="text-base font-semibold">{projectName(item)}</p>
      </div>

      <ProcessProgress stages={item.stages} />

      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">{item.title}</h1>
        <p className="text-sm text-muted-foreground">{whyFor(item.classification)}</p>
      </div>

      {item.proposed_instruction ? (
        <blockquote className="border-l-2 border-border pl-4 text-sm">
          {item.proposed_instruction}
        </blockquote>
      ) : (
        <p className="text-sm text-muted-foreground">Harness hasn't drafted an instruction yet.</p>
      )}

      {item.decision.divergence ? (
        <p role="status" className="rounded-md border p-3 text-sm">
          {item.decision.divergence}
        </p>
      ) : null}

      <section aria-labelledby={`decide-${item.id}`} className="space-y-3 rounded-md border p-4">
        <h2 id={`decide-${item.id}`} className="text-sm font-medium">
          {pending ? "Your decision" : "Your decision so far"}
        </h2>

        {pending ? (
          <>
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              <DestinationActions item={item} busy={busy} run={run} />
              <ConfirmAction
                trigger="Not this one"
                title="Skip this improvement?"
                body="Harness won't suggest it again."
                consequences={DECISION_CONSEQUENCES}
                confirmLabel="Skip"
                variant="ghost"
                disabled={busy}
                onConfirm={() => run({ action: "skip", id: item.id }, "Skipped")}
              />
            </div>
            <p className="text-xs text-muted-foreground">{NOT_SWITCHED_ON}</p>
          </>
        ) : (
          <>
            <p className="text-sm">{statusLine}</p>
            {accepted && !inLovable ? (
              <p className="text-xs text-muted-foreground">
                Adding a rule to Knowledge uses no Lovable credits. Adding isn't switched on yet —
                you'll approve the exact Knowledge text first.
              </p>
            ) : null}
            <details>
              <summary className="cursor-pointer text-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                Change my decision
              </summary>
              <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                {accepted ? (
                  <>
                    <DestinationActions
                      item={item}
                      busy={busy}
                      run={run}
                      exclude={item.destination}
                    />
                    <ConfirmAction
                      trigger="Not this one"
                      title="Skip this improvement?"
                      body="Harness won't suggest it again."
                      consequences={DECISION_CONSEQUENCES}
                      confirmLabel="Skip"
                      variant="ghost"
                      disabled={busy}
                      onConfirm={() => run({ action: "skip", id: item.id }, "Skipped")}
                    />
                  </>
                ) : null}
                {skipped ? (
                  <Button
                    variant="outline"
                    className="w-full sm:w-auto"
                    disabled={busy}
                    onClick={() =>
                      run({ action: "reopen", id: item.id }, "Reopened — waiting for your decision")
                    }
                  >
                    Reopen
                  </Button>
                ) : null}
              </div>
            </details>
          </>
        )}

        {item.proposed_instruction ? (
          <details open={editing || undefined}>
            <summary
              className="cursor-pointer text-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={(e) => {
                e.preventDefault();
                setEditing((v) => !v);
              }}
            >
              Change wording
            </summary>
            {editing ? (
              <div className="mt-2 space-y-2">
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
                      run(
                        { action: "change_wording", id: item.id, instruction: draft, reason },
                        "Wording updated",
                      ).then(() => setEditing(false))
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
          </details>
        ) : null}
      </section>

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

      {item.proof?.exists ? (
        <section aria-labelledby={`proof-${item.id}`} className="space-y-3">
          <h2 id={`proof-${item.id}`} className="text-lg font-semibold">
            How Harness would prove this
          </h2>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            <li>
              <span className="font-medium">Without the rule:</span> Lovable gets the same request
              as before.
            </li>
            <li>
              <span className="font-medium">With the rule:</span> Lovable gets the same request plus
              this instruction.
            </li>
            <li>
              <span className="font-medium">Harness checks:</span> whether Lovable sets up recurring
              work without asking you first.
            </li>
            <li>
              Uses up to {item.proof.lovable_credits_max ?? "a few"} Lovable credits — the same
              credits your builds use — and only after you approve the test.
            </li>
            {item.proof.manual_cleanup ? (
              <li>Temporary copies of your project must be deleted by hand afterwards.</li>
            ) : null}
          </ul>
          <div className="flex flex-col gap-1">
            <Button disabled aria-disabled className="w-full sm:w-auto">
              Run proof
            </Button>
            <p className="text-xs text-muted-foreground">Not available yet.</p>
          </div>
        </section>
      ) : null}

      <AdvancedDetails title="More detail">
        <DetailSection title="How Harness read this">
          <p>Harness read this as: {label(CLASSIFICATION_LABELS, item.classification)}.</p>
          {item.decision.decided_at ? (
            <p>
              {skipped ? "You skipped it on" : "You confirmed it on"}{" "}
              {formatDay(item.decision.decided_at)}.
            </p>
          ) : null}
          <p>Harness analysis uses Harness's own AI, not your Lovable account.</p>
        </DetailSection>

        <DetailSection title={`Wording history (${item.wording_history.length})`}>
          {item.wording_history.length === 0 ? (
            <p>No wording changes yet.</p>
          ) : (
            item.wording_history.map((w, i) => (
              <div key={`${w.changed_at}-${i}`} className="rounded-md border bg-background p-2">
                <p>
                  You changed the wording on {formatDay(w.changed_at)}
                  {w.reason ? ` — ${w.reason}` : ""}.
                </p>
                <p className="mt-1 text-muted-foreground line-through">{w.from}</p>
                <p>{w.to}</p>
              </div>
            ))
          )}
        </DetailSection>

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
