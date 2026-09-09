import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import {
  AdvancedDetails,
  ConfirmAction,
  CurrentStatus,
  DetailSection,
  KeyValue,
  PrimaryAction,
  ProcessProgress,
  RecommendationCallout,
  SecondaryAction,
  WhatHappensNext,
} from "@/components/harness/decision-layout";
import {
  APPROVAL_CONFIRMATION,
  EVIDENCE_LEVEL_LABELS,
  EXPERIMENT_TYPE_LABELS,
  FIELD_LABELS,
  NO_CREDITS,
  NO_LOVABLE_CHANGE,
  RULE_STATE_LABELS,
  SCOPE_LABELS,
  VERIFIER_STATUS_LABELS,
  VERIFIER_TYPE_LABELS,
  computeStages,
  firstSentence,
  label,
  rulePrimaryAction,
  ruleStatusSentence,
  ruleTitle,
} from "@/lib/harness-ux";

export const Route = createFileRoute("/_authenticated/ledger")({
  validateSearch: (search: Record<string, unknown>) => ({
    rule:
      typeof search["rule"] === "number"
        ? search["rule"]
        : typeof search["rule"] === "string"
          ? Number(search["rule"])
          : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Ledger — Harness Ledger" },
      { name: "description", content: "Rules Harness has learned, and what to do with them next." },
      { property: "og:title", content: "Ledger — Harness Ledger" },
      {
        property: "og:description",
        content: "Rules Harness has learned, and what to do with them next.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Page,
});

type Evidence = {
  id: number;
  kind: string;
  provenance: string;
  role: string | null;
  content: string;
};
type Revision = {
  id: number;
  previous_instruction: string;
  previous_state: string;
  new_instruction: string;
  new_state: string;
  reason: string | null;
  actor: string;
  created_at: string;
};
type VerificationPlanItem = {
  id: number;
  verification_definition_id: number;
  status: "passed" | "failed" | "unclear" | "not_run";
  evidence: string | null;
  evidence_type: string | null;
  definition_name: string;
  verifier_type: string;
  definition_description: string;
};
type VerificationPlan = {
  plan: { id: number; failure_signature: string; failure_condition: string };
  items: VerificationPlanItem[];
};
type ExperimentPlan = {
  plan: {
    id: number;
    experiment_type: string;
    starting_state_quality: string;
    source_project_id: string;
    exact_prompt: string;
    control_configuration: string;
    treatment_configuration: string;
    protected_checks: string;
    estimated_credits: number;
    max_permitted_credits: number;
    resource_strategy: string;
    cleanup_requirements: string;
    risks: string;
    success_conditions: string;
    inconclusive_conditions: string;
    stop_conditions: string;
    status: string;
  };
  verifications: { id: number; name: string; verifier_type: string; configuration: string }[];
  resources: {
    id: number;
    cleanup_status: string;
    creation_status: string;
    lovable_resource_id: string | null;
  }[];
};
type Rule = {
  rule: {
    id: number;
    instruction: string;
    scope: string;
    applies_when: string;
    predicted_failure: string;
    ownership: string;
    state: string;
    evidence_level: string;
    overlap_notes: string | null;
    created_at: string;
    updated_at: string;
  };
  revisions: Revision[];
  learning: {
    id: number;
    observed_problem: string;
    desired_behavior: string;
    reuse_rationale: string;
  } | null;
  correction_candidate: { id: number; summary: string; classification: string } | null;
  correction_evidence: Evidence[];
  classification_history: {
    id: number;
    actor: string;
    action: string;
    created_at: string;
    structured_output: string | null;
  }[];
  verification_plan: VerificationPlan | null;
  experiment_plans: ExperimentPlan[];
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
  const res = await fetch("/api/public/harness/rules", {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { available?: boolean; error?: string; reason?: string };
  if (!res.ok) throw new Error(json.error ?? "request failed");
  if (json.available === false) throw new Error(json.reason ?? "local runtime unavailable");
  return json;
}

// Plain-language grouping for the list.
const GROUPS: { title: string; states: string[] }[] = [
  { title: "Needs review", states: ["proposed"] },
  { title: "Ready to test", states: ["approved"] },
  { title: "Active", states: ["testing", "supported", "active"] },
  { title: "Questioned", states: ["questioned"] },
  { title: "Retired", states: ["retired", "rolled_back", "rejected", "disabled"] },
];

function testOutcomeOf(r: Rule): "passed" | "failed" | "unclear" | "not_run" | null {
  const items = r.verification_plan?.items ?? [];
  if (items.length === 0) return null;
  if (items.some((i) => i.status === "failed")) return "failed";
  if (items.every((i) => i.status === "passed")) return "passed";
  if (items.some((i) => i.status === "unclear")) return "unclear";
  return "not_run";
}

function nextActionLabel(r: Rule): string {
  return rulePrimaryAction(r.rule.state).label;
}

// ---- List ----

function RuleList({ rules, onOpen }: { rules: Rule[]; onOpen: (id: number) => void }) {
  const [filter, setFilter] = useState<string>("all");
  const showFilters = rules.length > 5;
  const visible = filter === "all" ? rules : rules.filter((r) => r.rule.state === filter);

  return (
    <div className="space-y-6">
      {showFilters && (
        <details className="rounded-md border">
          <summary className="cursor-pointer px-3 py-2 text-sm font-medium">Filter</summary>
          <div className="flex flex-wrap gap-2 border-t p-3">
            {["all", ...Object.keys(RULE_STATE_LABELS)].map((s) => (
              <Button
                key={s}
                size="sm"
                variant={filter === s ? "default" : "outline"}
                onClick={() => setFilter(s)}
              >
                {s === "all" ? "All" : RULE_STATE_LABELS[s]}
              </Button>
            ))}
          </div>
        </details>
      )}
      {GROUPS.map((g) => {
        const inGroup = visible.filter((r) => g.states.includes(r.rule.state));
        if (inGroup.length === 0) return null;
        return (
          <section key={g.title} aria-labelledby={`group-${g.title}`} className="space-y-2">
            <h2 id={`group-${g.title}`} className="text-lg font-semibold">
              {g.title}{" "}
              <span className="text-sm font-normal text-muted-foreground">({inGroup.length})</span>
            </h2>
            {inGroup.map((r) => (
              <div key={r.rule.id} className="rounded-md border p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <h3 className="text-base font-medium">{ruleTitle(r.rule.instruction)}</h3>
                    <div className="flex flex-wrap gap-1.5">
                      <Badge variant="secondary">{label(RULE_STATE_LABELS, r.rule.state)}</Badge>
                      <Badge variant="outline">{label(SCOPE_LABELS, r.rule.scope)}</Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      <span className="font-medium text-foreground">
                        {FIELD_LABELS["predicted_failure"]}:{" "}
                      </span>
                      {firstSentence(r.rule.predicted_failure)}
                    </p>
                  </div>
                  <Button size="sm" onClick={() => onOpen(r.rule.id)}>
                    {nextActionLabel(r)}
                  </Button>
                </div>
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}

// ---- Detail ----

function TestPlanSummary({ r }: { r: Rule }) {
  const exp = r.experiment_plans[0];
  const vp = r.verification_plan;
  if (!exp && !vp) {
    return (
      <p className="text-sm text-muted-foreground">
        Harness has not proposed a test for this rule yet.
      </p>
    );
  }
  const check = vp
    ? `Whether ${vp.plan.failure_condition.charAt(0).toLowerCase()}${vp.plan.failure_condition.slice(1)}`
    : "—";
  const manualCleanup = exp ? /manual/i.test(exp.plan.cleanup_requirements) : false;
  return (
    <div className="space-y-3">
      <KeyValue
        items={[
          { k: "Without the rule", v: "Lovable receives the original request." },
          { k: "With the rule", v: "Lovable receives the same request plus the proposed rule." },
          { k: "Harness checks", v: check },
          {
            k: "Estimated cost",
            v: exp ? `Up to ${exp.plan.estimated_credits} Lovable credits.` : "—",
          },
          {
            k: "Current limitation",
            v: manualCleanup ? "Temporary test projects require manual cleanup." : "—",
          },
        ]}
      />
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <PrimaryAction
          label="Run test"
          disabled
          disabledReason="Not available in this checkpoint. Nothing will be executed."
        />
      </div>
    </div>
  );
}

function RuleDetail({
  r,
  onBack,
  onChanged,
}: {
  r: Rule;
  onBack: () => void;
  onChanged: () => void;
}) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(r.rule.instruction);
  const [reason, setReason] = useState("");
  const [showTest, setShowTest] = useState(false);

  const testOutcome = testOutcomeOf(r);
  const exp = r.experiment_plans[0];
  const stages = computeStages({
    reviewed: true,
    excludedFromLearning: false,
    ruleState: r.rule.state,
    experimentStatus: exp?.plan.status ?? null,
    experimentStartingState: exp?.plan.starting_state_quality ?? null,
    testOutcome,
  });
  const primary = rulePrimaryAction(r.rule.state);
  const lastRevision = r.revisions[0];

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

  const recommendation =
    r.rule.state === "proposed"
      ? "Approve this rule if it says what you meant."
      : r.rule.state === "approved"
        ? "Review the proposed test before this rule goes anywhere near Lovable."
        : label(RULE_STATE_LABELS, r.rule.state);
  const why =
    r.rule.state === "approved"
      ? "Rules are tested first so that only instructions that actually change Lovable's behavior get added."
      : r.learning
        ? firstSentence(r.learning.observed_problem)
        : firstSentence(r.rule.predicted_failure);

  const nextLines =
    r.rule.state === "proposed"
      ? [`Approving means: ${APPROVAL_CONFIRMATION.body}`, NO_LOVABLE_CHANGE, NO_CREDITS]
      : r.rule.state === "approved"
        ? [
            "Reviewing the test changes nothing.",
            "Running the test is not available yet; when it is, it would use Lovable credits only after you approve it.",
            "Lovable only changes if you later choose to add the rule.",
          ]
        : [NO_LOVABLE_CHANGE, NO_CREDITS];

  return (
    <div className="space-y-6">
      <div>
        <button className="text-sm text-primary underline underline-offset-2" onClick={onBack}>
          ← All rules
        </button>
      </div>

      <ProcessProgress stages={stages} />

      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">{ruleTitle(r.rule.instruction)}</h1>
        {editing ? (
          <div className="space-y-2">
            <label htmlFor={`instruction-${r.rule.id}`} className="text-xs font-medium">
              Rule instruction
            </label>
            <Textarea
              id={`instruction-${r.rule.id}`}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={3}
            />
            <label htmlFor={`reason-${r.rule.id}`} className="text-xs font-medium">
              Reason for the edit (optional)
            </label>
            <input
              id={`reason-${r.rule.id}`}
              className="w-full rounded-md border bg-background px-3 py-1.5 text-sm"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  run(
                    { id: r.rule.id, instruction: draft, reason, actor: "operator (local UI)" },
                    "Rule updated (revision saved)",
                  ).then(() => setEditing(false))
                }
              >
                Save (creates a revision)
              </Button>
              <Button size="sm" variant="outline" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <p className="text-sm">{r.rule.instruction}</p>
        )}
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="outline">{label(SCOPE_LABELS, r.rule.scope)}</Badge>
          <Badge variant="outline">{label(EVIDENCE_LEVEL_LABELS, r.rule.evidence_level)}</Badge>
        </div>
      </div>

      {/* Layer 1: decision */}
      <CurrentStatus status={ruleStatusSentence(r.rule.state, testOutcome)} />
      <RecommendationCallout title="Harness recommends" recommendation={recommendation} why={why} />
      <WhatHappensNext
        heading={r.rule.state === "proposed" ? "What approval means" : "What the next step means"}
        lines={nextLines}
      />
      <KeyValue
        items={[
          { k: "Will Lovable change?", v: "No. Nothing is added to Lovable in this step." },
          { k: "Will credits be spent?", v: "No." },
          { k: label(FIELD_LABELS, "predicted_failure"), v: r.rule.predicted_failure },
        ]}
      />

      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        {primary.kind === "approve" && (
          <ConfirmAction
            trigger={primary.label}
            title={APPROVAL_CONFIRMATION.title}
            body={APPROVAL_CONFIRMATION.body}
            consequences={[APPROVAL_CONFIRMATION.noLovableChange, APPROVAL_CONFIRMATION.noCredits]}
            confirmLabel={APPROVAL_CONFIRMATION.confirmLabel}
            disabled={busy}
            onConfirm={() =>
              run(
                { id: r.rule.id, state: "approved", actor: "operator (local UI)" },
                "Approved (local only)",
              )
            }
          />
        )}
        {primary.kind === "review_test" && (
          <PrimaryAction label={primary.label} onClick={() => setShowTest(true)} />
        )}
        {primary.kind === "return_to_proposed" && (
          <PrimaryAction
            label={primary.label}
            onClick={() =>
              run(
                { id: r.rule.id, state: "proposed", actor: "operator (local UI)" },
                "Returned to proposed",
              )
            }
          />
        )}
        <SecondaryAction
          label={editing ? "Cancel edit" : "Edit rule"}
          onClick={() => setEditing((v) => !v)}
        />
        {r.correction_candidate && (
          <SecondaryAction
            label="View correction"
            onClick={() =>
              navigate({ to: "/inbox", search: { correction: r.correction_candidate!.id } })
            }
          />
        )}
      </div>
      <p className="text-xs text-muted-foreground">{primary.consequence}</p>

      <details open={showTest || undefined}>
        <summary className="cursor-pointer text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          More options
        </summary>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          {r.rule.state !== "rejected" && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                run({ id: r.rule.id, state: "rejected", actor: "operator (local UI)" }, "Rejected")
              }
            >
              Reject rule
            </Button>
          )}
          {r.rule.state !== "proposed" && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                run(
                  { id: r.rule.id, state: "proposed", actor: "operator (local UI)" },
                  "Returned to proposed",
                )
              }
            >
              Return to proposed
            </Button>
          )}
        </div>
      </details>

      {/* Layer 2: how Harness can test this */}
      <section aria-labelledby={`test-${r.rule.id}`} className="space-y-3">
        <h2 id={`test-${r.rule.id}`} className="text-lg font-semibold">
          How Harness can test this
        </h2>
        <TestPlanSummary r={r} />
      </section>

      {/* Layer 3: technical details, collapsed */}
      <AdvancedDetails title="Advanced details">
        {r.correction_evidence.length > 0 && (
          <DetailSection title={`Evidence sources (${r.correction_evidence.length})`}>
            {r.correction_evidence.map((e) => (
              <div key={e.id} className="rounded-md border bg-background p-2">
                <div className="flex flex-wrap gap-1.5">
                  <Badge variant="outline">{e.kind}</Badge>
                  <Badge variant={e.provenance === "manual" ? "destructive" : "outline"}>
                    {e.provenance}
                  </Badge>
                  {e.role ? <Badge variant="outline">{e.role}</Badge> : null}
                </div>
                <p className="mt-1 whitespace-pre-wrap">{e.content}</p>
              </div>
            ))}
          </DetailSection>
        )}

        <DetailSection title={`Classification history (${r.classification_history.length})`}>
          {r.classification_history.map((h) => (
            <div key={h.id}>
              {h.created_at} · {h.actor} · {h.action}
            </div>
          ))}
        </DetailSection>

        {r.learning && (
          <DetailSection title="Linked learning">
            <KeyValue
              items={[
                { k: "Observed problem", v: r.learning.observed_problem },
                { k: "Desired behavior", v: r.learning.desired_behavior },
                { k: "Reuse rationale", v: r.learning.reuse_rationale },
              ]}
            />
          </DetailSection>
        )}

        <DetailSection title={`Revision history (${r.revisions.length})`}>
          {r.revisions.length === 0 && <p>No revisions yet.</p>}
          {r.revisions.map((rev) => (
            <div key={rev.id} className="rounded-md border bg-background p-2">
              <div className="text-muted-foreground">
                {rev.created_at} · {rev.actor} {rev.reason ? `· ${rev.reason}` : ""}
              </div>
              <div>
                state: {rev.previous_state} → {rev.new_state}
              </div>
              {rev.previous_instruction !== rev.new_instruction && (
                <div className="mt-1">
                  <div className="text-muted-foreground line-through">
                    {rev.previous_instruction}
                  </div>
                  <div>{rev.new_instruction}</div>
                </div>
              )}
            </div>
          ))}
        </DetailSection>

        {r.verification_plan?.items
          .filter((i) => i.verifier_type !== "ai_rubric")
          .map((i) => (
            <DetailSection
              key={i.id}
              title={`${VERIFIER_TYPE_LABELS[i.verifier_type] ?? i.verifier_type} definition`}
            >
              <KeyValue
                items={[
                  { k: "Name", v: i.definition_name },
                  { k: "Checks", v: i.definition_description },
                  { k: "Status", v: label(VERIFIER_STATUS_LABELS, i.status) },
                  { k: "Evidence", v: i.evidence },
                  { k: "Evidence type", v: i.evidence_type },
                  { k: "Failure signature", v: r.verification_plan?.plan.failure_signature },
                  { k: "Verifier type (raw)", v: i.verifier_type },
                ]}
              />
            </DetailSection>
          ))}

        {r.verification_plan?.items
          .filter((i) => i.verifier_type === "ai_rubric")
          .map((i) => (
            <DetailSection key={i.id} title="AI-review definition">
              <KeyValue
                items={[
                  { k: "Name", v: i.definition_name },
                  { k: "Checks", v: i.definition_description },
                  { k: "Status", v: label(VERIFIER_STATUS_LABELS, i.status) },
                  { k: "Evidence", v: i.evidence },
                  { k: "Failure signature", v: r.verification_plan?.plan.failure_signature },
                ]}
              />
            </DetailSection>
          ))}

        {exp && (
          <DetailSection title="Full experiment plan">
            <KeyValue
              items={[
                {
                  k: "Type",
                  v: `${label(EXPERIMENT_TYPE_LABELS, exp.plan.experiment_type)} (${exp.plan.experiment_type})`,
                },
                { k: "Starting state", v: exp.plan.starting_state_quality },
                { k: "Status", v: exp.plan.status },
                { k: "Source project", v: exp.plan.source_project_id },
                { k: "Prompt", v: exp.plan.exact_prompt },
                { k: "Control", v: exp.plan.control_configuration },
                { k: "Treatment", v: exp.plan.treatment_configuration },
                { k: "Protected checks", v: exp.plan.protected_checks },
                {
                  k: "Estimated / max credits",
                  v: `${exp.plan.estimated_credits} / ${exp.plan.max_permitted_credits}`,
                },
                { k: "Success conditions", v: exp.plan.success_conditions },
                { k: "Inconclusive conditions", v: exp.plan.inconclusive_conditions },
                { k: "Stop conditions", v: exp.plan.stop_conditions },
                { k: "Risks", v: exp.plan.risks },
              ]}
            />
          </DetailSection>
        )}

        {exp && (
          <DetailSection title="Cleanup strategy">
            <KeyValue
              items={[
                { k: "Resource strategy", v: exp.plan.resource_strategy },
                { k: "Cleanup requirements", v: exp.plan.cleanup_requirements },
                {
                  k: "Registered resources",
                  v:
                    exp.resources.length === 0
                      ? "none — nothing has been created"
                      : exp.resources
                          .map(
                            (x) =>
                              `${x.lovable_resource_id ?? "(not created)"}: ${x.creation_status}/${x.cleanup_status}`,
                          )
                          .join("; "),
                },
              ]}
            />
          </DetailSection>
        )}

        <DetailSection title={`Audit history (${r.audit_events.length})`}>
          {r.audit_events.length === 0 ? (
            <p>—</p>
          ) : (
            r.audit_events.map((ev) => (
              <div key={ev.id}>
                {ev.created_at} · {ev.kind}
              </div>
            ))
          )}
        </DetailSection>

        <DetailSection title="Internal identifiers">
          <KeyValue
            items={[
              { k: "Rule id", v: r.rule.id },
              { k: "State (raw)", v: r.rule.state },
              { k: "Scope (raw)", v: r.rule.scope },
              { k: "Ownership", v: r.rule.ownership },
              { k: "Evidence level (raw)", v: r.rule.evidence_level },
              { k: "When this applies", v: r.rule.applies_when },
              { k: "Overlap notes", v: r.rule.overlap_notes },
              { k: "Learning id", v: r.learning?.id },
              { k: "Correction id", v: r.correction_candidate?.id },
              { k: "Verification plan id", v: r.verification_plan?.plan.id },
              { k: "Experiment plan id", v: exp?.plan.id },
              { k: "Created", v: r.rule.created_at },
              { k: "Last revision", v: lastRevision?.created_at ?? "none" },
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
    queryKey: ["harness-rules"],
    queryFn: async () => {
      const res = await fetch("/api/public/harness/rules", { headers: await authHeaders() });
      if (!res.ok) throw new Error(await res.text());
      return (await res.json()) as { available: boolean; reason?: string; rules?: Rule[] };
    },
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["harness-rules"] });
  const open = (id: number) => navigate({ to: "/ledger", search: { rule: id } });
  const back = () => navigate({ to: "/ledger", search: { rule: undefined } });

  if (query.isLoading) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Rules</h1>
        <div className="rounded-md border p-6 text-sm text-muted-foreground">Loading…</div>
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Rules</h1>
        <div
          role="alert"
          className="rounded-md border border-destructive/50 bg-destructive/5 p-6 text-sm text-destructive"
        >
          {query.error instanceof Error ? query.error.message : "Failed to load rules."}
        </div>
      </div>
    );
  }
  if (query.data && query.data.available === false) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Rules</h1>
        <div className="rounded-md border border-dashed p-10 text-center text-sm text-muted-foreground">
          {query.data.reason}
        </div>
      </div>
    );
  }

  const rules = query.data?.rules ?? [];
  const selected = search.rule != null ? rules.find((r) => r.rule.id === search.rule) : undefined;
  if (selected) return <RuleDetail r={selected} onBack={back} onChanged={refresh} />;

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Rules</h1>
        <p className="text-sm text-muted-foreground">
          {rules.length === 0
            ? "Nothing here yet."
            : "Lessons Harness has turned into rules, and what to do with each next."}
        </p>
      </div>
      {rules.length === 0 ? (
        <div className="rounded-md border border-dashed p-10 text-center text-sm text-muted-foreground">
          Rules appear here once you confirm a correction.
        </div>
      ) : (
        <RuleList rules={rules} onOpen={open} />
      )}
    </div>
  );
}
