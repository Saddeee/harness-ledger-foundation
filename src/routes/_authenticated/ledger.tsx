import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
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

export const Route = createFileRoute("/_authenticated/ledger")({
  head: () => ({
    meta: [
      { title: "Ledger — Harness Ledger" },
      { name: "description", content: "Proposed and applied rules." },
      { property: "og:title", content: "Ledger — Harness Ledger" },
      { property: "og:description", content: "Proposed and applied rules." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Page,
});

const STATES = [
  "proposed",
  "approved",
  "testing",
  "supported",
  "active",
  "questioned",
  "disabled",
  "retired",
  "rolled_back",
  "rejected",
] as const;

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
  };
  revisions: Revision[];
  learning: { id: number; observed_problem: string; desired_behavior: string } | null;
  correction_candidate: { id: number; summary: string } | null;
  correction_evidence: Evidence[];
};

async function authHeaders(): Promise<HeadersInit> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token
    ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
    : { "Content-Type": "application/json" };
}

async function postRuleAction(body: Record<string, unknown>) {
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

function RuleCard({ r, onChanged }: { r: Rule; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(r.rule.instruction);
  const [reason, setReason] = useState("");
  const lastRevision = r.revisions[0];

  async function run(body: Record<string, unknown>, msg: string) {
    setBusy(true);
    try {
      await postRuleAction(body);
      toast.success(msg);
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "action failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-md border p-4 space-y-3">
      <div className="flex flex-wrap gap-1.5">
        <Badge>{r.rule.state}</Badge>
        <Badge variant="outline">scope: {r.rule.scope}</Badge>
        <Badge variant="outline">owner: {r.rule.ownership}</Badge>
        <Badge variant="outline">evidence: {r.rule.evidence_level}</Badge>
      </div>

      {editing ? (
        <div className="space-y-2">
          <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} />
          <input
            className="w-full rounded-md border bg-background px-3 py-1.5 text-sm"
            placeholder="reason for this edit"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <div className="flex gap-2">
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
        <p className="text-sm">
          <span className="font-medium">Instruction: </span>
          {r.rule.instruction}{" "}
          <button
            className="text-xs text-primary underline underline-offset-2"
            onClick={() => setEditing(true)}
          >
            edit
          </button>
        </p>
      )}

      <p className="text-sm">
        <span className="font-medium">Applies when: </span>
        {r.rule.applies_when}
      </p>
      <p className="text-sm">
        <span className="font-medium">Predicted failure: </span>
        {r.rule.predicted_failure}
      </p>
      {r.rule.overlap_notes && (
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">
            Overlap with existing Knowledge/spec:{" "}
          </span>
          {r.rule.overlap_notes}
        </p>
      )}
      {r.correction_candidate && (
        <p className="text-xs text-muted-foreground">
          source correction #{r.correction_candidate.id}: {r.correction_candidate.summary}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        last revision: {lastRevision ? lastRevision.created_at : "none yet"}
      </p>

      <details className="text-sm">
        <summary className="cursor-pointer font-medium">
          Revision history ({r.revisions.length})
        </summary>
        <div className="mt-2 space-y-2">
          {r.revisions.length === 0 && (
            <p className="text-xs text-muted-foreground">No revisions yet.</p>
          )}
          {r.revisions.map((rev) => (
            <div key={rev.id} className="rounded-md border bg-muted/30 p-3 text-xs">
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
        </div>
      </details>

      {r.learning && (
        <details className="text-sm">
          <summary className="cursor-pointer font-medium">Linked learning</summary>
          <div className="mt-2 space-y-1 text-xs text-muted-foreground">
            <p>
              <span className="font-medium text-foreground">Observed problem: </span>
              {r.learning.observed_problem}
            </p>
            <p>
              <span className="font-medium text-foreground">Desired behavior: </span>
              {r.learning.desired_behavior}
            </p>
          </div>
        </details>
      )}

      {r.correction_evidence.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer font-medium">
            Evidence provenance ({r.correction_evidence.length})
          </summary>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {Array.from(new Set(r.correction_evidence.map((e) => e.provenance))).map((p) => (
              <Badge key={p} variant="outline">
                {p}
              </Badge>
            ))}
          </div>
        </details>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-2">
        <p className="w-full text-xs text-muted-foreground">
          Approving here means only: "the user confirms that this rule accurately represents a
          reusable instruction." It does not write Project or Workspace Knowledge, create or update
          a Skill, run an experiment, or touch any Lovable project.
        </p>
        <Button
          size="sm"
          disabled={busy}
          onClick={() =>
            run(
              { id: r.rule.id, state: "approved", actor: "operator (local UI)" },
              "Approved (local only)",
            )
          }
        >
          Approve
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() =>
            run({ id: r.rule.id, state: "rejected", actor: "operator (local UI)" }, "Rejected")
          }
        >
          Reject
        </Button>
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
      </div>
    </div>
  );
}

function Page() {
  const qc = useQueryClient();
  const [stateFilter, setStateFilter] = useState<string>("all");
  const [scopeFilter, setScopeFilter] = useState<string>("all");
  const [ownerFilter, setOwnerFilter] = useState<string>("all");

  const query = useQuery({
    queryKey: ["harness-rules"],
    queryFn: async () => {
      const res = await fetch("/api/public/harness/rules", { headers: await authHeaders() });
      if (!res.ok) throw new Error(await res.text());
      return (await res.json()) as { available: boolean; reason?: string; rules?: Rule[] };
    },
  });

  const filtered = useMemo(() => {
    const rules = query.data?.rules ?? [];
    return rules.filter(
      (r) =>
        (stateFilter === "all" || r.rule.state === stateFilter) &&
        (scopeFilter === "all" || r.rule.scope === scopeFilter) &&
        (ownerFilter === "all" || r.rule.ownership === ownerFilter),
    );
  }, [query.data, stateFilter, scopeFilter, ownerFilter]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Ledger — Rules</h1>
        {query.data?.available && (
          <div className="flex gap-2">
            <Select value={stateFilter} onValueChange={setStateFilter}>
              <SelectTrigger className="h-8 w-40 text-xs">
                <SelectValue placeholder="State" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All states</SelectItem>
                {STATES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={scopeFilter} onValueChange={setScopeFilter}>
              <SelectTrigger className="h-8 w-36 text-xs">
                <SelectValue placeholder="Scope" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All scopes</SelectItem>
                <SelectItem value="project">project</SelectItem>
                <SelectItem value="workspace">workspace</SelectItem>
              </SelectContent>
            </Select>
            <Select value={ownerFilter} onValueChange={setOwnerFilter}>
              <SelectTrigger className="h-8 w-36 text-xs">
                <SelectValue placeholder="Ownership" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All owners</SelectItem>
                <SelectItem value="user">user</SelectItem>
                <SelectItem value="harness">harness</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      {query.isLoading && (
        <div className="rounded-md border p-6 text-sm text-muted-foreground">Loading rules…</div>
      )}

      {query.isError && (
        <div className="rounded-md border border-destructive/50 bg-destructive/5 p-6 text-sm text-destructive">
          {query.error instanceof Error ? query.error.message : "Failed to load rules."}
        </div>
      )}

      {query.data && query.data.available === false && (
        <div className="rounded-md border border-dashed p-10 text-center text-sm text-muted-foreground">
          {query.data.reason}
        </div>
      )}

      {query.data?.available && filtered.length === 0 && (
        <div className="rounded-md border border-dashed p-10 text-center text-sm text-muted-foreground">
          {(query.data.rules?.length ?? 0) === 0
            ? "No rules yet. Approved learnings become rules here."
            : "No rules match the current filters."}
        </div>
      )}

      {query.data?.available &&
        filtered.map((r) => (
          <RuleCard
            key={r.rule.id}
            r={r}
            onChanged={() => qc.invalidateQueries({ queryKey: ["harness-rules"] })}
          />
        ))}
    </div>
  );
}
