import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import {
  AdvancedDetails,
  ConfirmAction,
  CurrentStatus,
  DetailSection,
  KeyValue,
  ProcessProgress,
  RecommendationCallout,
  SecondaryAction,
  WhatHappensNext,
} from "@/components/harness/decision-layout";
import {
  CLASSIFICATION_LABELS,
  CONTINUE_CONFIRMATION,
  SCOPE_LABELS,
  computeStages,
  correctionPrimaryAction,
  excerpt,
  firstSentence,
  label,
  ruleTitle,
  storyFromEvidence,
  type EvidenceLike,
} from "@/lib/harness-ux";

export const Route = createFileRoute("/_authenticated/inbox")({
  validateSearch: (search: Record<string, unknown>) => ({
    correction:
      typeof search["correction"] === "number"
        ? search["correction"]
        : typeof search["correction"] === "string"
          ? Number(search["correction"])
          : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Inbox — Harness Ledger" },
      { name: "description", content: "Corrections that need your review." },
      { property: "og:title", content: "Inbox — Harness Ledger" },
      { property: "og:description", content: "Corrections that need your review." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Page,
});

const CLASSIFICATIONS = Object.keys(CLASSIFICATION_LABELS);

type Evidence = {
  id: number;
  kind: string;
  provenance: string;
  role: string | null;
  content: string;
  occurred_at: string | null;
  source_ref: string | null;
};
type HistoryEntry = {
  id: number;
  actor: string;
  action: string;
  provider: string | null;
  model: string | null;
  structured_output: string | null;
  created_at: string;
};
type Correction = {
  id: number;
  episode_title: string;
  episode_summary: string | null;
  project_id: string | null;
  project_name: string | null;
  classification: string;
  is_correction: 0 | 1;
  reusable: 0 | 1 | null;
  proposed_scope: string | null;
  summary: string;
  confidence: number | null;
  evidence_reason: string | null;
  reviewed: 0 | 1;
  reviewed_at: string | null;
  excluded_from_learning: 0 | 1;
  created_at: string;
  evidence: Evidence[];
  classification_history: HistoryEntry[];
  learning: {
    id: number;
    observed_problem: string;
    desired_behavior: string;
    reuse_rationale: string;
  } | null;
  rule: { id: number; instruction: string; state: string } | null;
  audit_events: { id: number; kind: string; created_at: string }[];
};

async function authHeaders(): Promise<HeadersInit> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token
    ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
    : { "Content-Type": "application/json" };
}

async function post(body: Record<string, unknown>) {
  const res = await fetch("/api/public/harness/corrections", {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { available?: boolean; error?: string; reason?: string };
  if (!res.ok) throw new Error(json.error ?? "request failed");
  if (json.available === false) throw new Error(json.reason ?? "local runtime unavailable");
  return json;
}

function lessonOf(c: Correction): string {
  if (c.rule) return ruleTitle(c.rule.instruction);
  if (c.learning) return firstSentence(c.learning.desired_behavior);
  return firstSentence(c.summary);
}

function recommendationOf(c: Correction): string {
  if (c.excluded_from_learning) return "Do not learn from this.";
  if (c.reusable === 0 || c.proposed_scope === "one_time")
    return "Treat this as a one-time decision.";
  return c.proposed_scope === "project"
    ? "Use this lesson only in this project."
    : "Use this lesson across your projects.";
}

function statusOf(c: Correction): { text: string; hint?: string } {
  if (c.excluded_from_learning) return { text: "Excluded from learning" };
  if (!c.reviewed) return { text: "Needs your review" };
  if (c.rule) {
    return {
      text: "Reviewed",
      hint: `you confirmed the lesson; a rule was ${c.rule.state === "approved" ? "created and approved" : "created"}`,
    };
  }
  return { text: "Reviewed", hint: "Harness is drafting a rule" };
}

// ---- List ----

function CorrectionList({ items, onOpen }: { items: Correction[]; onOpen: (id: number) => void }) {
  return (
    <div className="space-y-3">
      {items.map((c) => {
        const status = statusOf(c);
        return (
          <div key={c.id} className="rounded-md border p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 space-y-1">
                <h2 className="text-base font-medium">{lessonOf(c)}</h2>
                <p className="text-sm text-muted-foreground">
                  {label(CLASSIFICATION_LABELS, c.classification)}. {firstSentence(c.summary)}
                </p>
                <p className="text-sm">
                  <span className="font-medium">Harness recommends: </span>
                  {recommendationOf(c)}
                </p>
                <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  <Badge variant={c.reviewed ? "secondary" : "default"}>{status.text}</Badge>
                  <span>{c.project_name ?? c.project_id ?? "unknown project"}</span>
                </div>
              </div>
              <Button size="sm" onClick={() => onOpen(c.id)}>
                Review
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---- Detail ----

function StoryBlock({ title, e }: { title: string; e: EvidenceLike | null }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</p>
      <p className="mt-1 text-sm">{e ? excerpt(e.content) : "—"}</p>
    </div>
  );
}

function CorrectionDetail({
  c,
  onBack,
  onChanged,
}: {
  c: Correction;
  onBack: () => void;
  onChanged: () => void;
}) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(c.summary);
  const [reclassifyTo, setReclassifyTo] = useState(c.classification);

  const stages = computeStages({
    reviewed: c.reviewed === 1,
    excludedFromLearning: c.excluded_from_learning === 1,
    ruleState: c.rule?.state ?? null,
    experimentStatus: null,
    experimentStartingState: null,
    testOutcome: null,
  });
  const primary = correctionPrimaryAction({
    reviewed: c.reviewed === 1,
    excludedFromLearning: c.excluded_from_learning === 1,
    hasRule: !!c.rule,
  });
  const story = storyFromEvidence(c.evidence);
  const status = statusOf(c);

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

  const whatHappensNext = c.excluded_from_learning
    ? ["Harness will not create a rule from this."]
    : !c.reviewed
      ? ["Harness prepares a rule.", "Nothing changes in Lovable.", "No credits are used."]
      : c.rule
        ? [
            `The rule is ${label({ proposed: "waiting for your approval", approved: "approved and can be tested next" }, c.rule.state)}.`,
            "Nothing changes in Lovable until a rule is tested and you choose to add it.",
            "No credits are used by reviewing.",
          ]
        : [
            "Harness drafts a rule from this lesson.",
            "Nothing changes in Lovable.",
            "No credits are used.",
          ];

  return (
    <div className="space-y-6">
      <div>
        <button className="text-sm text-primary underline underline-offset-2" onClick={onBack}>
          ← All corrections
        </button>
      </div>

      <ProcessProgress stages={stages} />

      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">{lessonOf(c)}</h1>
        <p className="text-sm text-muted-foreground">
          {label(CLASSIFICATION_LABELS, c.classification)} · {c.project_name ?? c.project_id}
        </p>
      </div>

      {/* Layer 1: decision */}
      <RecommendationCallout
        title="Possible lesson"
        recommendation={recommendationOf(c)}
        why={firstSentence(c.summary)}
      />
      <CurrentStatus status={status.text} hint={status.hint} />
      <WhatHappensNext heading="What happens if you continue?" lines={whatHappensNext} />

      <div className="space-y-3 rounded-md border p-4">
        <p className="text-sm font-medium">Does this capture what you meant?</p>
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          {primary.kind === "confirm" && (
            <ConfirmAction
              trigger={primary.label}
              title={CONTINUE_CONFIRMATION.title}
              body={CONTINUE_CONFIRMATION.body}
              consequences={[
                CONTINUE_CONFIRMATION.noLovableChange,
                CONTINUE_CONFIRMATION.noCredits,
              ]}
              confirmLabel={CONTINUE_CONFIRMATION.confirmLabel}
              disabled={busy}
              onConfirm={() =>
                run(
                  {
                    kind: "human_decision",
                    id: c.id,
                    final_classification: c.classification,
                    reusable: c.reusable !== 0 && c.proposed_scope !== "one_time",
                    proposed_scope: c.proposed_scope ?? "workspace",
                  },
                  "Decision recorded",
                )
              }
            />
          )}
          {primary.kind === "view_rule" && (
            <Button
              className="w-full sm:w-auto"
              onClick={() => navigate({ to: "/ledger", search: { rule: c.rule!.id } })}
            >
              {primary.label}
            </Button>
          )}
          {primary.kind === "none" && (
            <p className="text-sm text-muted-foreground">{primary.label}</p>
          )}
          <SecondaryAction label="Edit the interpretation" onClick={() => setEditing((v) => !v)} />
        </div>
        <p className="text-xs text-muted-foreground">{primary.consequence}</p>

        {editing && (
          <div className="space-y-2">
            <label htmlFor={`summary-${c.id}`} className="text-xs font-medium">
              Harness's interpretation (one or two sentences)
            </label>
            <Textarea
              id={`summary-${c.id}`}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={3}
            />
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  run(
                    { kind: "edit_summary", id: c.id, summary: draft },
                    "Interpretation updated",
                  ).then(() => setEditing(false))
                }
              >
                Save
              </Button>
              <Button size="sm" variant="outline" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        <details>
          <summary className="cursor-pointer text-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            Change details
          </summary>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                run(
                  { action: "change_scope", id: c.id, proposed_scope: "workspace" },
                  "Set to use across projects",
                )
              }
            >
              {SCOPE_LABELS["workspace"]}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                run(
                  { action: "change_scope", id: c.id, proposed_scope: "project" },
                  "Set to this project only",
                )
              }
            >
              {SCOPE_LABELS["project"]}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => run({ action: "mark_one_time", id: c.id }, "Marked as one-time")}
            >
              {SCOPE_LABELS["one_time"]}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => run({ action: "exclude", id: c.id }, "Excluded from learning")}
            >
              Exclude from learning
            </Button>
          </div>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
            <label htmlFor={`classification-${c.id}`} className="text-xs font-medium">
              Change classification
            </label>
            <Select value={reclassifyTo} onValueChange={setReclassifyTo}>
              <SelectTrigger id={`classification-${c.id}`} className="h-8 w-full text-xs sm:w-72">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CLASSIFICATIONS.map((cl) => (
                  <SelectItem key={cl} value={cl}>
                    {CLASSIFICATION_LABELS[cl]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || reclassifyTo === c.classification}
              onClick={() =>
                run(
                  { action: "reclassify", id: c.id, classification: reclassifyTo },
                  "Classification changed",
                )
              }
            >
              Apply
            </Button>
          </div>
        </details>
      </div>

      {/* Layer 2: explanation */}
      <section aria-labelledby={`story-${c.id}`} className="space-y-3">
        <h2 id={`story-${c.id}`} className="text-lg font-semibold">
          What happened
        </h2>
        <StoryBlock title="Requested" e={story.requested} />
        <StoryBlock title="Built" e={story.built} />
        <StoryBlock title="Your feedback" e={story.feedback} />
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Changed afterward
          </p>
          {story.changed.length === 0 ? (
            <p className="mt-1 text-sm">—</p>
          ) : (
            <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
              {story.changed.slice(0, 3).map((e) => (
                <li key={e.id}>{excerpt(e.content, 180)}</li>
              ))}
            </ul>
          )}
        </div>
        <KeyValue
          items={[
            { k: "Scope", v: label(SCOPE_LABELS, c.proposed_scope) },
            {
              k: "Consequence",
              v: c.excluded_from_learning
                ? "No rule will be created"
                : "A rule can be prepared, tested, and only then offered for Lovable",
            },
            {
              k: "Next step",
              v:
                primary.kind === "confirm"
                  ? "Confirm the lesson"
                  : c.rule
                    ? "Review the rule"
                    : "Wait for a drafted rule",
            },
          ]}
        />
      </section>

      {/* Layer 3: technical details, collapsed */}
      <AdvancedDetails title="Advanced details">
        <DetailSection title={`Evidence sources (${c.evidence.length})`}>
          {c.evidence.map((e) => (
            <div key={e.id} className="rounded-md border bg-background p-2">
              <div className="flex flex-wrap gap-1.5">
                <Badge variant="outline">{e.kind}</Badge>
                <Badge variant={e.provenance === "manual" ? "destructive" : "outline"}>
                  {e.provenance}
                </Badge>
                {e.role ? <Badge variant="outline">{e.role}</Badge> : null}
                <span className="text-muted-foreground">
                  {e.occurred_at ?? ""}
                  {e.source_ref ? ` · ${e.source_ref}` : ""}
                </span>
              </div>
              <p className="mt-1 whitespace-pre-wrap">{e.content}</p>
            </div>
          ))}
        </DetailSection>

        <DetailSection title="Original interpretation and reasoning">
          <p className="whitespace-pre-wrap">
            <span className="font-medium">Summary: </span>
            {c.summary}
          </p>
          {c.episode_summary && (
            <p className="whitespace-pre-wrap">
              <span className="font-medium">Source context: </span>
              {c.episode_summary}
            </p>
          )}
          {c.evidence_reason && (
            <p className="whitespace-pre-wrap">
              <span className="font-medium">Evidence reason: </span>
              {c.evidence_reason}
            </p>
          )}
        </DetailSection>

        <DetailSection title={`Classification history (${c.classification_history.length})`}>
          {c.classification_history.map((h) => {
            let parsed: Record<string, unknown> = {};
            try {
              parsed = h.structured_output
                ? (JSON.parse(h.structured_output) as Record<string, unknown>)
                : {};
            } catch {
              // ignore malformed
            }
            return (
              <div key={h.id} className="rounded-md border bg-background p-2">
                <div className="text-muted-foreground">
                  {h.actor} · {h.action} · {h.provider ?? "—"}/{h.model ?? "—"} · {h.created_at}
                </div>
                {typeof parsed["previous_classification"] === "string" && (
                  <div>
                    {String(parsed["previous_classification"])} →{" "}
                    {String(parsed["proposed_classification"] ?? "")}
                  </div>
                )}
                {typeof parsed["final_classification"] === "string" && (
                  <div>final: {String(parsed["final_classification"])}</div>
                )}
                {typeof parsed["reasoning"] === "string" && (
                  <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
                    {String(parsed["reasoning"])}
                  </p>
                )}
              </div>
            );
          })}
        </DetailSection>

        {c.learning && (
          <DetailSection title="Linked learning">
            <KeyValue
              items={[
                { k: "Observed problem", v: c.learning.observed_problem },
                { k: "Desired behavior", v: c.learning.desired_behavior },
                { k: "Reuse rationale", v: c.learning.reuse_rationale },
              ]}
            />
          </DetailSection>
        )}

        <DetailSection title={`Audit history (${c.audit_events.length})`}>
          {c.audit_events.length === 0 ? (
            <p>—</p>
          ) : (
            c.audit_events.map((ev) => (
              <div key={ev.id}>
                {ev.created_at} · {ev.kind}
              </div>
            ))
          )}
        </DetailSection>

        <DetailSection title="Internal identifiers">
          <KeyValue
            items={[
              { k: "Correction id", v: c.id },
              { k: "Classification (raw)", v: c.classification },
              { k: "Scope (raw)", v: c.proposed_scope },
              { k: "Confidence", v: c.confidence },
              { k: "Reviewed at", v: c.reviewed_at },
              { k: "Project id", v: c.project_id },
              { k: "Learning id", v: c.learning?.id },
              { k: "Rule id", v: c.rule?.id },
            ]}
          />
        </DetailSection>
      </AdvancedDetails>
    </div>
  );
}

// ---- Page ----

function Page() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const search = Route.useSearch();

  const query = useQuery({
    queryKey: ["harness-corrections"],
    queryFn: async () => {
      const res = await fetch("/api/public/harness/corrections", { headers: await authHeaders() });
      if (!res.ok) throw new Error(await res.text());
      return (await res.json()) as {
        available: boolean;
        reason?: string;
        corrections?: Correction[];
      };
    },
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["harness-corrections"] });
  const open = (id: number) => navigate({ to: "/inbox", search: { correction: id } });
  const back = () => navigate({ to: "/inbox", search: { correction: undefined } });

  if (query.isLoading) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Corrections</h1>
        <div className="rounded-md border p-6 text-sm text-muted-foreground">Loading…</div>
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Corrections</h1>
        <div
          role="alert"
          className="rounded-md border border-destructive/50 bg-destructive/5 p-6 text-sm text-destructive"
        >
          {query.error instanceof Error ? query.error.message : "Failed to load corrections."}
        </div>
      </div>
    );
  }
  if (query.data && query.data.available === false) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Corrections</h1>
        <div className="rounded-md border border-dashed p-10 text-center text-sm text-muted-foreground">
          {query.data.reason}
        </div>
      </div>
    );
  }

  const items = query.data?.corrections ?? [];
  const selected =
    search.correction != null ? items.find((c) => c.id === search.correction) : undefined;

  if (selected) {
    return <CorrectionDetail c={selected} onBack={back} onChanged={refresh} />;
  }

  const needsReview = items.filter((c) => !c.reviewed && !c.excluded_from_learning).length;

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Corrections</h1>
        <p className="text-sm text-muted-foreground">
          {items.length === 0
            ? "Nothing here yet."
            : needsReview === 0
              ? "Nothing needs your review right now."
              : `${needsReview} need${needsReview === 1 ? "s" : ""} your review.`}
        </p>
      </div>
      {items.length === 0 ? (
        <div className="rounded-md border border-dashed p-10 text-center text-sm text-muted-foreground">
          Corrections Harness finds in your project history will appear here.
        </div>
      ) : (
        <CorrectionList items={items} onOpen={open} />
      )}
    </div>
  );
}
