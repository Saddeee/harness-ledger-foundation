// Client-side types and fetch helpers for the Improvements API. Kept out of
// the component file so React fast-refresh sees only components there.
// Only ever talks to the local Harness routes; never to Lovable.
import { supabase } from "@/integrations/supabase/client";
import {
  improvementGroup,
  type ImprovementGroup,
  type LovableWriteStatus,
  type Stage,
} from "@/lib/harness-ux";

// ---- Contract (matches GET/POST /api/public/harness/improvements) ----

export type Message = {
  id: number;
  author: "you" | "lovable";
  sent_at: string | null;
  text: string;
};

export type KnowledgePreview = {
  target: "project" | "workspace";
  target_label: string;
  based_on_snapshot_at: string | null;
  current_user_text: string;
  managed_block: string;
  final_content: string;
  char_count: number;
  cap: number;
  over_cap: boolean;
};

export type KnowledgeVersion = {
  id: number;
  target: string;
  status: LovableWriteStatus;
  written_at: string | null;
  created_at: string;
  reason: string | null;
  restored_from_version_id: number | null;
};

export type LovableInfo = {
  write_status: LovableWriteStatus;
  written_at: string | null;
  stale_reason: string | null;
  previews: { project: KnowledgePreview | null; workspace: KnowledgePreview | null };
  versions: KnowledgeVersion[];
  untested: boolean;
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
  wording_history: {
    changed_at: string;
    from: string;
    to: string;
    reason: string | null;
    actor?: string | null;
  }[];
  // Present once the data layer ships the Lovable write lifecycle; optional
  // so an older payload still renders (status falls back to "none").
  lovable?: LovableInfo;
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

export type RuntimeMode = "local" | "hosted";

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

// Which runtime this UI is talking to. Anything other than a confirmed
// "local" answer (loading, error, hosted preview) is treated as hosted, so
// the hosted-era screens never flash away and back.
export async function fetchRuntime(): Promise<{ mode: RuntimeMode }> {
  try {
    const res = await fetch("/api/public/harness/runtime", { headers: await authHeaders() });
    if (!res.ok) return { mode: "hosted" };
    const json = (await res.json()) as { mode?: string };
    return { mode: json.mode === "local" ? "local" : "hosted" };
  } catch {
    return { mode: "hosted" };
  }
}

export const runtimeQueryOptions = {
  queryKey: ["harness-runtime"],
  queryFn: fetchRuntime,
  staleTime: Infinity,
} as const;

export function projectName(item: Improvement): string {
  return item.project.name ?? item.project.id;
}

export function stageComplete(item: Improvement, key: Stage["key"]): boolean {
  return item.stages.some((s) => s.key === key && s.state === "complete");
}

export function lovableOf(item: Improvement): LovableInfo {
  return (
    item.lovable ?? {
      write_status: "none",
      written_at: null,
      stale_reason: null,
      previews: { project: null, workspace: null },
      versions: [],
      untested: false,
    }
  );
}

export function groupOf(item: Improvement, deferred: boolean): ImprovementGroup | null {
  return improvementGroup({
    status: item.decision.status,
    deferred,
    writeStatus: lovableOf(item).write_status,
    proofOutcome: item.proof?.outcome ?? null,
  });
}

// ---- Per-browser conveniences (never product state) ----

const DEFERRED_PREFIX = "harness.deferred:";
const HOW_IT_WORKS_KEY = "harness.howItWorksDismissed";
export const HOW_IT_WORKS_EVENT = "harness:show-how-it-works";

export function isDeferred(id: number): boolean {
  try {
    return localStorage.getItem(DEFERRED_PREFIX + id) === "1";
  } catch {
    return false;
  }
}

export function setDeferred(id: number, on: boolean): void {
  try {
    if (on) localStorage.setItem(DEFERRED_PREFIX + id, "1");
    else localStorage.removeItem(DEFERRED_PREFIX + id);
  } catch {
    // storage unavailable: the item simply stays "Needs your decision"
  }
}

export function isHowItWorksDismissed(): boolean {
  try {
    return localStorage.getItem(HOW_IT_WORKS_KEY) === "1";
  } catch {
    return false;
  }
}

export function setHowItWorksDismissed(on: boolean): void {
  try {
    if (on) localStorage.setItem(HOW_IT_WORKS_KEY, "1");
    else localStorage.removeItem(HOW_IT_WORKS_KEY);
  } catch {
    // ignore
  }
}
