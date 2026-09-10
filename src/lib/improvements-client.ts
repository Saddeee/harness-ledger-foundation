// Client-side types and fetch helpers for the Improvements API. Kept out of
// the component file so React fast-refresh sees only components there.
// Only ever talks to the local Harness route; never to Lovable.
import { supabase } from "@/integrations/supabase/client";
import type { Stage } from "@/lib/harness-ux";

// ---- Contract (matches GET/POST /api/public/harness/improvements) ----

export type Message = {
  id: number;
  author: "you" | "lovable";
  sent_at: string | null;
  text: string;
};

export type Improvement = {
  id: number;
  project: { id: string; name: string | null };
  title: string;
  proposed_instruction: string | null;
  destination: "workspace" | "project" | "one_time" | null;
  classification: string;
  decision: {
    status: "pending" | "accepted" | "skipped";
    decided_at: string | null;
    divergence: string | null;
  };
  stage: Stage["key"];
  stages: Stage[];
  evidence: Message[];
  proof: {
    exists: boolean;
    runnable: false;
    lovable_credits_max: number | null;
    outcome: "not_run" | "passed" | "failed" | "unclear" | null;
    manual_cleanup: boolean;
  } | null;
  wording_history: { changed_at: string; from: string; to: string; reason: string | null }[];
  developer: {
    correction: unknown;
    learning: unknown | null;
    rule: unknown | null;
    classification_history: unknown[];
    hidden_evidence: unknown[];
    verification_plan: unknown | null;
    experiment_plans: unknown[];
    audit_events: unknown[];
  };
};

export type ImprovementsResponse = {
  available: boolean;
  reason?: string;
  improvements?: Improvement[];
};

async function authHeaders(): Promise<HeadersInit> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token
    ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
    : { "Content-Type": "application/json" };
}

export async function fetchImprovements(): Promise<ImprovementsResponse> {
  const res = await fetch("/api/public/harness/improvements", { headers: await authHeaders() });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as ImprovementsResponse;
}

export async function postImprovementAction(body: Record<string, unknown>) {
  const res = await fetch("/api/public/harness/improvements", {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { available?: boolean; error?: string; reason?: string };
  if (!res.ok) throw new Error(json.error ?? "request failed");
  if (json.available === false) throw new Error(json.reason ?? "local runtime unavailable");
  return json;
}

export function projectName(item: Improvement): string {
  return item.project.name ?? item.project.id;
}

export function stageComplete(item: Improvement, key: Stage["key"]): boolean {
  return item.stages.some((s) => s.key === key && s.state === "complete");
}
