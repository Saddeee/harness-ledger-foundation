// Client-side types and fetch helpers for the Improvements API. Kept out of
// the component file so React fast-refresh sees only components there.
// Only ever talks to the local Harness routes; never to Lovable.
import { supabase } from "@/integrations/supabase/client";
import {
  improvementGroup,
  type ImprovementGroup,
  type LovableWriteStatus,
  type RetireReason,
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
  active_rules_count: number;
  over_rules: boolean;
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
  // The project's "write approved changes automatically" flag (Round 3 §5).
  // Present for every improvement; the UI only acts on it for
  // project-destination items -- see lovableOf's fallback below.
  auto_write: boolean;
};

// A retirement proposal (Task C2 / spec §4b-§5), shown as an item of kind
// "retire" with a negative id (-proposal_id). Null on every ordinary
// (kind "improvement") item.
export type RetireInfo = {
  proposal_id: number;
  rule_id: number;
  reason: RetireReason;
  health: {
    applicable_tasks: number;
    helped: number;
    hurt: number;
    last_applicable_at: string | null;
  };
  since: string | null;
  contradicts_instruction: string | null;
};

export type Improvement = {
  id: number;
  kind: "improvement" | "retire";
  project: { id: string; name: string | null };
  title: string;
  proposed_instruction: string | null;
  destination: "workspace" | "project" | "one_time" | null;
  classification: string;
  decision: {
    status: "pending" | "accepted" | "skipped";
    decided_at: string | null;
    divergence: string | null;
    test_first: boolean;
    retired: boolean;
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
  retire: RetireInfo | null;
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

// ---- Contract (matches GET/POST /api/public/harness/knowledge) ----

export type KnowledgeCurrent = { content: string; sha256: string; fetched_at: string } | null;

// Server-computed line diff (harness/src/diff.ts) between a version's
// previous_content and new_content, capped at 400 lines -- see spec
// section 2's "What changed" view.
export type DiffLine = { kind: "+" | "-" | " "; text: string };
export type KnowledgeChanges = {
  added: number;
  removed: number;
  lines: DiffLine[];
  truncated: boolean;
};

export type KnowledgeVersionSummary = {
  id: number;
  status: string;
  created_at: string;
  written_at: string | null;
  actor: string;
  reason: string | null;
  restored_from_version_id: number | null;
  char_count: number;
  changes: KnowledgeChanges;
};

export type KnowledgeActiveRule = { id: number; text: string; improvement_id: number | null };

export type KnowledgeTargetView = {
  target: "project" | "workspace";
  id: string;
  name: string;
  current: KnowledgeCurrent;
  managed_block_present: boolean;
  active_rules: KnowledgeActiveRule[];
  // Task C2: rules retired from this target, collapsed under "Retired rules
  // (N)" on the Instructions page, each with a "Re-add" button.
  retired_rules: KnowledgeActiveRule[];
  versions: KnowledgeVersionSummary[];
  pending_write: { version_id: number; created_at: string } | null;
};

export type KnowledgeResponse = {
  available: boolean;
  reason?: string;
  targets?: KnowledgeTargetView[];
  demo_loaded?: boolean;
  awaiting_analysis?: number;
};

export async function fetchKnowledge(): Promise<KnowledgeResponse> {
  const res = await fetch("/api/public/harness/knowledge", { headers: await authHeaders() });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as KnowledgeResponse;
}

export async function postKnowledge(body: Record<string, unknown>) {
  const res = await fetch("/api/public/harness/knowledge", {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { available?: boolean; error?: string; reason?: string };
  if (!res.ok) throw new Error(json.error ?? "request failed");
  if (json.available === false) throw new Error(json.reason ?? "local runtime unavailable");
  return json;
}

// ---- Contract (matches GET /api/public/harness/skills) ----

export type SkillHistoryEntry = {
  sha256: string;
  fetched_at: string;
  added: number;
  removed: number;
};

export type Skill = {
  name: string;
  description: string | null;
  content: string;
  sha256: string;
  updated_at_remote: string | null;
  fetched_at: string;
  history: SkillHistoryEntry[];
};

export type SkillsResponse = {
  available: boolean;
  reason?: string;
  workspace_id?: string | null;
  fetched_at?: string | null;
  skills?: Skill[];
};

export async function fetchSkills(): Promise<SkillsResponse> {
  const res = await fetch("/api/public/harness/skills", { headers: await authHeaders() });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as SkillsResponse;
}

export const skillsQueryOptions = {
  queryKey: ["harness-skills"],
  queryFn: fetchSkills,
  staleTime: 30_000,
} as const;

// ---- Contract (matches GET/POST /api/public/harness/executor) ----

export type ExecutorConnection = {
  connected: boolean;
  email: string | null;
  workspaces: { id: string; name: string }[];
};

export type ExecutorSchedule = {
  enabled: boolean;
  interval_minutes: number;
  window_start_hour: number;
  window_end_hour: number;
};

export type ExecutorLastRun = {
  started_at: string;
  finished_at: string | null;
  ok: boolean | null;
  error: string | null;
  counts: Record<string, number>;
} | null;

// Spec section 4 (Settings > AI analysis). A key is never sent to the
// client in full -- only has_key/last4 (harness/src/llm-keys.ts).
export type LlmProvider = "openai" | "anthropic" | "google";
export type LlmRole = "classifier" | "miner" | "reviewer" | "proposer";
export type LlmModelChoice = { provider: LlmProvider; model: string };
export type LlmModels = Record<LlmRole, LlmModelChoice>;
export type LlmKeyStatus = { has_key: boolean; last4: string | null };
export type ExecutorLlm = {
  provider: LlmProvider;
  models: LlmModels;
  monthly_token_budget: number;
  tokens_this_month: number;
  spent_usd: number;
  keys: Record<LlmProvider, LlmKeyStatus>;
};

export type ExecutorDefaults = { max_active_rules: number };

export type ExecutorResponse = {
  available: boolean;
  reason?: string;
  connection?: ExecutorConnection;
  schedule?: ExecutorSchedule;
  settings?: { knowledge_char_cap: number };
  last_run?: ExecutorLastRun;
  next_run_at?: string | null;
  running?: boolean;
  llm?: ExecutorLlm;
  defaults?: ExecutorDefaults;
};

export async function fetchExecutor(): Promise<ExecutorResponse> {
  const res = await fetch("/api/public/harness/executor", { headers: await authHeaders() });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as ExecutorResponse;
}

export async function postExecutor(body: Record<string, unknown>) {
  const res = await fetch("/api/public/harness/executor", {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { available?: boolean; error?: string; reason?: string };
  if (!res.ok) throw new Error(json.error ?? "request failed");
  if (json.available === false) throw new Error(json.reason ?? "local runtime unavailable");
  return json;
}

export const executorQueryOptions = {
  queryKey: ["harness-executor"],
  queryFn: fetchExecutor,
  staleTime: 30_000,
} as const;

// ---- Contract (matches GET/POST /api/public/harness/projects) ----

export type ProjectSettings = { max_active_rules: number | null; auto_write: boolean };

export type AllowedProject = {
  id: string;
  name: string;
  last_synced_at: string | null;
  history_count: number;
  settings: ProjectSettings;
};
export type LovableProjectListing = { id: string; name: string; allowed: boolean };

export type ProjectsResponse = {
  available: boolean;
  reason?: string;
  allowed?: AllowedProject[];
  all?: LovableProjectListing[];
  lovable_error?: string;
};

export async function fetchProjects(): Promise<ProjectsResponse> {
  const res = await fetch("/api/public/harness/projects", { headers: await authHeaders() });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as ProjectsResponse;
}

export async function postProjects(body: Record<string, unknown>) {
  const res = await fetch("/api/public/harness/projects", {
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

export function lovableOf(item: Improvement): LovableInfo {
  return (
    item.lovable ?? {
      write_status: "none",
      written_at: null,
      stale_reason: null,
      previews: { project: null, workspace: null },
      versions: [],
      untested: false,
      auto_write: true,
    }
  );
}

export function groupOf(item: Improvement): ImprovementGroup | null {
  return improvementGroup({
    status: item.decision.status,
    writeStatus: lovableOf(item).write_status,
    testFirst: item.decision.test_first,
    retired: item.decision.retired,
  });
}

// ---- Browser notifications (Task D2) ----

export function pendingCount(items: Improvement[]): number {
  return items.filter((item) => item.decision.status === "pending").length;
}
