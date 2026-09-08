import { createFileRoute } from "@tanstack/react-router";
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

export const Route = createFileRoute("/_authenticated/inbox")({
  head: () => ({
    meta: [
      { title: "Inbox — Harness Ledger" },
      { name: "description", content: "Correction candidates awaiting review." },
      { property: "og:title", content: "Inbox — Harness Ledger" },
      { property: "og:description", content: "Correction candidates awaiting review." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Page,
});

const CLASSIFICATIONS = [
  "defect_correction",
  "constraint_restatement",
  "missing_requirement",
  "preference_revision",
  "scope_extension",
  "new_task",
  "question",
  "approval",
  "other",
] as const;

type Evidence = {
  id: number;
  kind: string;
  provenance: string;
  role: string | null;
  content: string;
  occurred_at: string | null;
  source_ref: string | null;
};

type ClassificationHistoryEntry = {
  id: number;
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
  classification: string;
  is_correction: 0 | 1;
  reusable: 0 | 1 | null;
  proposed_scope: string | null;
  summary: string;
  confidence: number | null;
  evidence_reason: string | null;
  reviewed: 0 | 1;
  excluded_from_learning: 0 | 1;
  evidence: Evidence[];
  classification_history: ClassificationHistoryEntry[];
};

async function authHeaders(): Promise<HeadersInit> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token
    ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
    : { "Content-Type": "application/json" };
}

async function postCorrectionAction(body: Record<string, unknown>) {
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

const PROVENANCE_LABEL: Record<string, string> = {
  lovable_mcp: "Lovable chat/diff (verified live)",
  git_history: "git history",
  build_log: "build-log.md",
  spec: "SPEC.md",
  manual: "manual note — not Lovable chat",
  llm_derived: "Claude-derived synthesis",
};

function ProvenanceBadge({ provenance }: { provenance: string }) {
  const emphasize = provenance === "manual";
  return (
    <Badge
      variant={emphasize ? "destructive" : "outline"}
      title={PROVENANCE_LABEL[provenance] ?? provenance}
    >
      {PROVENANCE_LABEL[provenance] ?? provenance}
    </Badge>
  );
}

function EvidenceItem({ e }: { e: Evidence }) {
  return (
    <div className="rounded-md border bg-muted/30 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="outline">{e.kind}</Badge>
        <ProvenanceBadge provenance={e.provenance} />
        {e.role ? <Badge variant="outline">{e.role}</Badge> : null}
        <span className="text-xs text-muted-foreground">
          {e.occurred_at ?? ""}
          {e.source_ref ? ` · ${e.source_ref}` : ""}
        </span>
      </div>
      <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{e.content}</p>
    </div>
  );
}

function CorrectionCard({ c, onChanged }: { c: Correction; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [editingSummary, setEditingSummary] = useState(false);
  const [summaryDraft, setSummaryDraft] = useState(c.summary);
  const [reclassifyTo, setReclassifyTo] = useState(c.classification);

  async function run(body: Record<string, unknown>, successMessage: string) {
    setBusy(true);
    try {
      await postCorrectionAction(body);
      toast.success(successMessage);
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "action failed");
    } finally {
      setBusy(false);
    }
  }

  const provenances = Array.from(new Set(c.evidence.map((e) => e.provenance)));

  return (
    <div className="rounded-md border p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-muted-foreground">
          project {c.project_id ?? "—"} · episode: {c.episode_title}
        </div>
        <Badge variant={c.reviewed ? "secondary" : "outline"}>
          {c.reviewed ? "reviewed" : "awaiting review"}
        </Badge>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <Badge>{c.classification}</Badge>
        <Badge variant="outline">{c.is_correction ? "is correction" : "not a correction"}</Badge>
        {c.reusable === 1 && <Badge variant="outline">reusable</Badge>}
        {c.reusable === 0 && <Badge variant="outline">one-time</Badge>}
        {c.proposed_scope && <Badge variant="outline">scope: {c.proposed_scope}</Badge>}
        {c.confidence != null && <Badge variant="outline">confidence {c.confidence}</Badge>}
        {c.excluded_from_learning === 1 && (
          <Badge variant="destructive">excluded from learning</Badge>
        )}
        {provenances.map((p) => (
          <ProvenanceBadge key={p} provenance={p} />
        ))}
      </div>

      {c.episode_summary && (
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">Source context: </span>
          {c.episode_summary}
        </p>
      )}

      {editingSummary ? (
        <div className="space-y-2">
          <Textarea
            value={summaryDraft}
            onChange={(e) => setSummaryDraft(e.target.value)}
            rows={3}
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                run(
                  { kind: "edit_summary", id: c.id, summary: summaryDraft },
                  "Summary updated",
                ).then(() => setEditingSummary(false))
              }
            >
              Save
            </Button>
            <Button size="sm" variant="outline" onClick={() => setEditingSummary(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-sm">
          <span className="font-medium">Summary: </span>
          {c.summary}{" "}
          <button
            className="text-xs text-primary underline underline-offset-2"
            onClick={() => {
              setSummaryDraft(c.summary);
              setEditingSummary(true);
            }}
          >
            edit
          </button>
        </p>
      )}

      {c.evidence_reason && (
        <p className="whitespace-pre-wrap text-sm text-muted-foreground">
          <span className="font-medium text-foreground">Evidence reason: </span>
          {c.evidence_reason}
        </p>
      )}

      {c.classification_history.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer font-medium">
            Classification history ({c.classification_history.length})
          </summary>
          <div className="mt-2 space-y-2">
            {c.classification_history.map((h) => {
              let parsed: Record<string, unknown> = {};
              try {
                parsed = h.structured_output ? JSON.parse(h.structured_output) : {};
              } catch {
                // leave empty
              }
              return (
                <div key={h.id} className="rounded-md border bg-muted/30 p-3">
                  <div className="text-xs text-muted-foreground">
                    {h.action} · {h.provider ?? "?"}/{h.model ?? "?"} · {h.created_at}
                  </div>
                  {typeof parsed["previous_classification"] === "string" && (
                    <div className="text-xs">
                      {parsed["previous_classification"]} →{" "}
                      {String(parsed["proposed_classification"] ?? parsed["classification"])}
                    </div>
                  )}
                  {typeof parsed["reasoning"] === "string" && (
                    <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">
                      {parsed["reasoning"] as string}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </details>
      )}

      <details>
        <summary className="cursor-pointer text-sm font-medium">
          Evidence ({c.evidence.length})
        </summary>
        <div className="mt-2 space-y-2">
          {c.evidence.map((e) => (
            <EvidenceItem key={e.id} e={e} />
          ))}
        </div>
      </details>

      <div className="flex flex-wrap items-center gap-2 pt-2">
        <Button
          size="sm"
          disabled={busy}
          onClick={() => run({ action: "confirm", id: c.id }, "Confirmed")}
        >
          Confirm classification
        </Button>

        <Select value={reclassifyTo} onValueChange={setReclassifyTo}>
          <SelectTrigger className="h-8 w-48 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CLASSIFICATIONS.map((cl) => (
              <SelectItem key={cl} value={cl}>
                {cl}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() =>
            run({ action: "reclassify", id: c.id, classification: reclassifyTo }, "Reclassified")
          }
        >
          Reclassify
        </Button>

        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => run({ action: "mark_reusable", id: c.id }, "Marked reusable")}
        >
          Mark reusable
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() =>
            run(
              { action: "change_scope", id: c.id, proposed_scope: "project" },
              "Marked project-specific",
            )
          }
        >
          Mark project-specific
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() =>
            run(
              { action: "change_scope", id: c.id, proposed_scope: "workspace" },
              "Marked workspace-level",
            )
          }
        >
          Mark workspace-level
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => run({ action: "mark_one_time", id: c.id }, "Marked one-time")}
        >
          Mark one-time
        </Button>
        <Button
          size="sm"
          variant="destructive"
          disabled={busy}
          onClick={() => run({ action: "exclude", id: c.id }, "Excluded from learning")}
        >
          Exclude from learning
        </Button>
      </div>
    </div>
  );
}

function Page() {
  const qc = useQueryClient();

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

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Inbox — Corrections</h1>

      {query.isLoading && (
        <div className="rounded-md border p-6 text-sm text-muted-foreground">
          Loading corrections…
        </div>
      )}

      {query.isError && (
        <div className="rounded-md border border-destructive/50 bg-destructive/5 p-6 text-sm text-destructive">
          {query.error instanceof Error ? query.error.message : "Failed to load corrections."}
        </div>
      )}

      {query.data && query.data.available === false && (
        <div className="rounded-md border border-dashed p-10 text-center text-sm text-muted-foreground">
          {query.data.reason}
        </div>
      )}

      {query.data?.available && (query.data.corrections?.length ?? 0) === 0 && (
        <div className="rounded-md border border-dashed p-10 text-center text-sm text-muted-foreground">
          No correction candidates yet. Mined tasks awaiting triage will appear here.
        </div>
      )}

      {query.data?.available &&
        query.data.corrections?.map((c) => (
          <CorrectionCard
            key={c.id}
            c={c}
            onChanged={() => qc.invalidateQueries({ queryKey: ["harness-corrections"] })}
          />
        ))}
    </div>
  );
}
