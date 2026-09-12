// Client-side types and fetch helpers for the Improvements API. Kept out of
// the component file so React fast-refresh sees only components there.
// Only ever talks to the local Harness routes; never to Lovable.
import { supabase } from "@/integrations/supabase/client";
import {
  improvementGroup,
  writeOutcomeLine,
  type ImprovementGroup,
  type LovableWriteStatus,
  type RetireReason,
  type Stage,
  type WriteOutcome,
} from "@/lib/harness-ux";

export type { WriteOutcome };

// Round 6 Task 2 / spec §2: the toast text for any write-eligible action's
// response -- the real write outcome ("Written to Lovable 19:05" / the
// reason) when the response carries one, else the caller's own static
// fallback (used only for actions that never write, e.g. skip/reopen, or
// as a last-resort default if a response somehow carries no `write`).
export function writeToastText(write: WriteOutcome | undefined, fallback: string): string {
  return writeOutcomeLine(write) ?? fallback;
}

// Round 6 Task 2 / spec §2: "Sync now" runs inline and the button shows the
// real result, not just "requested" -- one line built from syncNow's own
// counts (harness/src/executor/beats.ts).
export function syncResultText(result: {
  ok?: boolean;
  counts?: Record<string, number>;
  error?: string;
}): string {
  if (result.ok === false) return result.error ? `Sync failed: ${result.error}` : "Sync failed";
  const messages = result.counts?.["messages"] ?? 0;
  const snapshots = result.counts?.["knowledge_snapshots"] ?? 0;
  const written = result.counts?.["written"] ?? 0;
  const parts = [
    `${messages} message${messages === 1 ? "" : "s"}`,
    `${snapshots} Knowledge snapshot${snapshots === 1 ? "" : "s"}`,
  ];
  if (written > 0) parts.push(`${written} write${written === 1 ? "" : "s"}`);
  return `Synced: ${parts.join(", ")}`;
}

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

// Task C3 / spec §4 (v1-lite) + §4b (display): the "since added" counters for
// an ordinary (kind "improvement") item whose rule is live, mirroring
// RetireInfo.health above but with its own `since` (the rule's first written
// date). Null when the rule isn't live yet or rule_health hasn't scored it.
export type ImprovementHealth = {
  applicable_tasks: number;
  helped: number;
  hurt: number;
  last_applicable_at: string | null;
  since: string | null;
  // Round 5 Task 7 / spec §5: the other three evidence sources for this same
  // rule -- see KnowledgeActiveRule.verdict/adherence below, which these
  // mirror (this is the Suggestions-list/detail read of the same data, that
  // one is the Instructions-table read). `sources` says which of
  // observed/adherence/verdicts have any data at all for this rule, driving
  // the Details paragraph's "has run for this rule" / "hasn't run for this
  // rule yet".
  verdict: { verdict: "helped" | "did_not_help" | "not_sure"; created_at: string } | null;
  adherence: {
    followed: number;
    broke: number;
    not_applicable: number;
    quotes: {
      verdict: "followed" | "broke" | "not_applicable";
      quote: string;
      created_at: string;
    }[];
  } | null;
  sources: { observed: boolean; adherence: boolean; verdicts: boolean };
};

export type Improvement = {
  id: number;
  kind: "improvement" | "retire";
  // When this item was found (the correction's or the retire proposal's own
  // created_at) -- Task C3's Inbox "New" marker compares this against the
  // last_seen_at read before mark_seen updates it for this visit.
  created_at: string;
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
  // Round 5 Task 7 / spec §5.2: the rule this item is about, once one
  // exists -- what the verdict buttons address directly. Null until a rule
  // has been proposed/created for this correction; for a "retire" item,
  // RetireInfo.rule_id already carries it.
  rule_id: number | null;
  // Task C3: set only for a live (rule state 'active') "improvement" item
  // with a rule_health row; null otherwise (including every "retire" item,
  // which carries the equivalent counts under retire.health).
  health: ImprovementHealth | null;
  // Round 5 Task 5 / spec §4: why decision_mode='automatic' didn't accept
  // this one without asking; null in ask mode and for "retire" items.
  unsure: string | null;
  // Who decided this item: 'user', 'automatic' (Round 5 Task 6), or null
  // while still pending.
  decided_by: "user" | "automatic" | null;
  // Round 5 Task 5 / spec §4: confidence x tag acceptance rate -- the Inbox
  // sort order for pending items only; every other view ignores it.
  rank: number;
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

// Task C3 / spec §4b display + §5 notifications: a server-computed count
// (never re-derived client-side) for the sidebar badge and the Inbox page.
// Round 5 Task 6 / spec §4: auto_accepted_since_seen feeds the Inbox's own
// automatic-mode empty state ("Harness accepted N suggestions
// automatically since your last visit").
export type InboxCounts = { pending: number; retire: number; auto_accepted_since_seen: number };

export type ImprovementsResponse = {
  available: boolean;
  reason?: string;
  improvements?: Improvement[];
  counts?: InboxCounts;
  // When the Inbox was last opened, before this GET's own "mark_seen" (if
  // any) updates it -- "" means never. Absent on a hosted-preview response.
  last_seen_at?: string;
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

export async function postImprovementAction(body: Record<string, unknown>): Promise<{
  available?: boolean;
  error?: string;
  reason?: string;
  improvement?: Improvement;
  // Round 6 Task 2 / spec §2: present whenever the action just attempted a
  // Knowledge write (accept unless test_first, retire, readd, restore,
  // change_wording of a written rule, retry_write) -- absent for every
  // other action (skip, reopen, set_destination, verdict, keep).
  write?: WriteOutcome;
}> {
  const res = await fetch("/api/public/harness/improvements", {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as {
    available?: boolean;
    error?: string;
    reason?: string;
    improvement?: Improvement;
    write?: WriteOutcome;
  };
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

export type KnowledgeActiveRule = {
  id: number;
  text: string;
  improvement_id: number | null;
  // Task C3 / spec §4/§4b: set for a live rule with a rule_health row;
  // absent/null on a retired rule (retired_rules never carries this) or a
  // live one rule_health hasn't scored yet.
  health?: ImprovementHealth | null;
  // Round 5 Task 3 / spec §3a: the Instructions page's rules table columns.
  // Present on active_rules; absent on retired_rules (same convention as
  // `health` above).
  status?: "written" | "pending" | "stale" | "failed" | "testing";
  since?: string | null;
  verdict?: { verdict: "helped" | "did_not_help" | "not_sure"; created_at: string } | null;
  adherence?: { followed: number; broke: number; not_applicable: number } | null;
};

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

// Round 5 Task 3 / spec §3b: the History page's per-target timeline, served
// from the same route as fetchKnowledge above (GET .../knowledge?timeline=
// project:<id> or workspace:<id>) -- the client only ever talks to the six
// existing harness routes, this is not a seventh.
export type TimelineNode = {
  id: string;
  kind: "version" | "external_change" | "decision" | "skill" | "verdict";
  at: string;
  label: string;
  actor: "you" | "harness" | "lovable";
  summary: string | null;
  content: string | null;
  diff: KnowledgeChanges | null;
  rule_ids: number[];
  restored_from: number | null;
  improvement_id: number | null;
  version_id: number | null;
  restorable: boolean;
};

export type TimelineResponse = {
  available: boolean;
  reason?: string;
  target?: "project" | "workspace";
  id?: string;
  name?: string;
  nodes?: TimelineNode[];
};

export async function fetchTimeline(
  target: "project" | "workspace",
  id: string,
): Promise<TimelineResponse> {
  const res = await fetch(`/api/public/harness/knowledge?timeline=${target}:${id}`, {
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as TimelineResponse;
}

export async function postKnowledge(body: Record<string, unknown>): Promise<{
  available?: boolean;
  error?: string;
  reason?: string;
  version_id?: number;
  // Round 6 Task 2 / spec §2: "restore" writes immediately when Harness is
  // connected, same as every other write-eligible action.
  write?: WriteOutcome;
}> {
  const res = await fetch("/api/public/harness/knowledge", {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as {
    available?: boolean;
    error?: string;
    reason?: string;
    version_id?: number;
    write?: WriteOutcome;
  };
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
// Round 4 Task A4 / spec §2: "claude_code" runs the user's own Claude Code
// subscription (no key -- readiness comes from provider_ready, not `keys`,
// so it's kept out of ApiLlmProvider below).
export type ApiLlmProvider = "openai" | "anthropic" | "google";
export type LlmProvider = ApiLlmProvider | "claude_code";
// Round 5 Task 1: "miner" is renamed "rule_writer" (harness/src/analysis/
// propose.ts), and "judge" is added for the adherence/verdict pipeline --
// see harness/src/store.ts's LlmRole, which this type mirrors.
export type LlmRole = "classifier" | "rule_writer" | "judge" | "reviewer" | "proposer";
export type LlmModelChoice = { provider: LlmProvider; model: string };
export type LlmModels = Record<LlmRole, LlmModelChoice>;
export type LlmKeyStatus = { has_key: boolean; last4: string | null };
export type ExecutorLlm = {
  provider: LlmProvider;
  models: LlmModels;
  monthly_token_budget: number;
  tokens_this_month: number;
  spent_usd: number;
  keys: Record<ApiLlmProvider, LlmKeyStatus>;
};

export type ExecutorDefaults = { max_active_rules: number };

// Round 5 Task 6 / spec §4/§4b: Settings > Decisions. FeedbackStats mirrors
// harness/src/store.ts's own type exactly (accepted/skipped/verdicts feed
// the "From your decisions so far" line; automatic is read but not shown
// there -- it's the same count decision.status/decided_by already expose
// per item). EvidenceSources mirrors store.ts's EvidenceSources -- read
// here, not written by this page (Task 6 owns only the Decisions section;
// the evidence-source toggles live elsewhere).
export type FeedbackStats = {
  accepted: number;
  skipped: number;
  verdicts: number;
  automatic: number;
};
export type EvidenceSources = {
  observed: boolean;
  adherence: boolean;
  verdicts: boolean;
  paired: boolean;
};
export type ExecutorSettings = {
  knowledge_char_cap: number;
  decision_mode: "ask" | "automatic";
  decision_auto_confidence: number;
  evidence_sources: EvidenceSources;
  feedback: FeedbackStats;
};

// Round 4 Task A3 (spec §2): "Analyse now" status, independent of the
// Lovable connection above -- an analysis run has its own last_run/running
// pair and its own readiness check (provider_ready), since it can run
// whether or not Lovable is connected.
export type ExecutorAnalysisLastRun = {
  started_at: string;
  finished_at: string | null;
  ok: boolean | null;
  error: string | null;
  counts: Record<string, number>;
  tokens: number;
  cost_usd: number | null;
} | null;

export type ExecutorProviderReady = { ok: boolean; reason?: string };

export type ExecutorAnalysis = {
  last_run: ExecutorAnalysisLastRun;
  running: boolean;
  awaiting_analysis: number;
  provider_ready: ExecutorProviderReady;
};

// Round 6 Task 2: which process currently drives the schedule -- "app" (the
// in-app scheduler, started with the server) or "cli" (a `npm run
// harness:executor` loop); null when neither currently holds the lock.
export type ScheduleHolder = { owner: "app" | "cli"; pid: number } | null;

export type ExecutorResponse = {
  available: boolean;
  reason?: string;
  connection?: ExecutorConnection;
  schedule?: ExecutorSchedule;
  settings?: ExecutorSettings;
  last_run?: ExecutorLastRun;
  next_run_at?: string | null;
  schedule_holder?: ScheduleHolder;
  running?: boolean;
  llm?: ExecutorLlm;
  analysis?: ExecutorAnalysis;
  defaults?: ExecutorDefaults;
};

export async function fetchExecutor(): Promise<ExecutorResponse> {
  const res = await fetch("/api/public/harness/executor", { headers: await authHeaders() });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as ExecutorResponse;
}

export async function postExecutor(body: Record<string, unknown>): Promise<{
  available?: boolean;
  error?: string;
  reason?: string;
  url?: string;
  // Round 6 Task 2 / spec §2: sync_now's own inline result -- the button
  // shows this, not just "requested".
  ok?: boolean;
  counts?: Record<string, number>;
}> {
  const res = await fetch("/api/public/harness/executor", {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as {
    available?: boolean;
    error?: string;
    reason?: string;
    url?: string;
    ok?: boolean;
    counts?: Record<string, number>;
  };
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
