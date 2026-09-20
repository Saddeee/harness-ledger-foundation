// Client-side types and fetch helpers for the Improvements API. Kept out of
// the component file so React fast-refresh sees only components there.
// Only ever talks to the local Harness routes; never to Lovable.
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import {
  improvementGroup,
  writeOutcomeLine,
  type ImprovementGroup,
  type LovableWriteStatus,
  type RetireReason,
  type Stage,
  type VerdictEffect,
  type WriteOutcome,
} from "@/lib/harness-ux";

export type { VerdictEffect };

export type { WriteOutcome };

// Round 6 Task 2 / spec §2: the toast text for any write-eligible action's
// response -- the real write outcome ("Written to Lovable 19:05" / the
// reason) when the response carries one, else the caller's own static
// fallback (used only for actions that never write, e.g. skip/reopen, or
// as a last-resort default if a response somehow carries no `write`).
export function writeToastText(write: WriteOutcome | undefined, fallback: string): string {
  return writeOutcomeLine(write) ?? fallback;
}

/** Shows an action's result: an error toast when its Knowledge write did not
 * land (a green check on "Not written: …" read as success), else success. */
export function toastWriteOutcome(write: WriteOutcome | undefined, fallback: string): string {
  const text = writeToastText(write, fallback);
  if (write && !write.written) toast.error(text);
  else toast.success(text);
  return text;
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
  // Round 6 Task 3 / spec §3: only set once the rule behind this
  // improvement has been retired -- the write status of the retirement's
  // own removal rewrite (never this rule's own write history above). Drives
  // whether the card offers Undo (the removal never reached Lovable) or
  // Re-add (it did -- the rule really is gone now). Null otherwise.
  retirement_write_status: LovableWriteStatus | null;
  // Round 6 Task 3 fix 1: computed server-side (harness/src/improvements.ts's
  // own controlFlags, the exact same rule the "undo"/"cancel_write" actions
  // enforce) so no page has to re-derive whether either control is safe --
  // in particular, never from write_status alone (a live rule's LATER
  // rewrite can read pending/stale/failed while the rule itself is still
  // exactly what's live in Lovable).
  can_undo: boolean;
  can_cancel_write: boolean;
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
  // Checkpoint 2026-09-18 WP3 (spec §9): observed and AI-review signals kept
  // apart, the health status and why a review is asked for.
  observed_repeat?: number;
  observed_clear?: number;
  ai_not_followed?: number;
  ai_followed?: number;
  status?: "healthy" | "watch" | "review" | "retire_suggested" | "snoozed";
  review_reason?: "inactive" | "repeated_issue" | "user_verdict" | "unclear_contradiction" | null;
  // Round 5 Task 7 / spec §5: the other three evidence sources for this same
  // rule -- see KnowledgeActiveRule.verdict/adherence below, which these
  // mirror (this is the Suggestions-list/detail read of the same data, that
  // one is the Instructions-table read). `sources` says which of
  // observed/adherence/verdicts have any data at all for this rule, driving
  // the Details paragraph's "has run for this rule" / "hasn't run for this
  // rule yet".
  verdict: { verdict: "keep" | "review" | "not_sure"; created_at: string } | null;
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
  sources: { observed: boolean; adherence: boolean; verdicts: boolean; paired: boolean };
  // Round 6 Task 4 / spec §4: set only on the direct response to a
  // just-recorded verdict (the "verdict" action) -- what that one click
  // changed in this rule's health, read by the compact VerdictControl to
  // show the effect line right away instead of waiting for a refetch to
  // guess from the raw counts. Null on every ordinary GET (a persisted
  // health row never remembers "what the last verdict did").
  verdict_effect?: VerdictEffect | null;
};

// Round 6 Task 6b / spec §6: whether "Test this rule" is on offer, and the
// latest paired-test run for this rule (whatever its own status -- once
// judged/failed, `available` is free to be true again for a fresh attempt,
// so the run's own result line and a fresh "Test this rule" button can sit
// side by side on the same card). Mirrors harness/src/improvements.ts's own
// TestInfo exactly.
export type ExperimentStatus =
  "queued" | "copying" | "building" | "judging" | "judged" | "failed" | "cancelled";

export type TestRun = {
  id: number;
  status: ExperimentStatus;
  stage_note: string | null;
  started_at: string;
  finished_at: string | null;
  judged_at: string | null;
  cost_credits: number | null;
  score: number | null;
  corrections: number;
  edits_since_episode: number | null;
  error: string | null;
};

export type TestInfo = {
  available: boolean;
  unavailable_reason: string | null;
  run: TestRun | null;
  credits: { used_this_month: number; budget: number };
};

// Checkpoint 2026-09-18 (WP1a, migration v18): what kind of test a run was,
// and its environment record -- mirrors harness/src/executor/
// replay-environment.ts's ExperimentKind/ReplayEnvironment exactly, as a
// plain structural type (this file has no dependency on harness/src).
export type ExperimentKind = "historical_replay" | "paired_comparison";

export type EnvironmentQuality =
  "controlled" | "partially_controlled" | "historical_approximation" | "not_comparable";

// Checkpoint 2 2-D: mirrors harness/src/executor/replay-environment.ts's own
// ReplayConclusion exactly -- the derived one-word conclusion shown on the
// judging screen (section 6, "How much this shows" -- Round 8 Task 5) and
// the Tests page's own testStatusPhrase once a run is judged.
export type ReplayConclusion =
  "historical_support" | "not_supported" | "possibly_harmful" | "inconclusive";

export type ReplayEnvironment = {
  version: 1;
  kind: ExperimentKind;
  code_state: {
    source: "historical_commit_before_request" | "unavailable";
    request_message_id: string | null;
  };
  project_knowledge: {
    source: "exact_historical" | "nearest_earlier_version" | "current_fallback" | "unavailable";
    snapshot_id: number | null;
    snapshot_fetched_at: string | null;
    episode_started_at: string | null;
    char_count: number;
  };
  workspace_knowledge: { source: "current_uncontrolled" };
  skills: { source: "current_uncontrolled" };
  chat_history: { included: boolean };
  candidate_rule: { rule_id: number; instruction: string; already_present: boolean };
  other_active_rules: string[];
  uncontrolled: string[];
  quality: EnvironmentQuality;
  knowledge_for_copy: string;
  backfilled?: boolean;
  historical_rules_dropped_by_run?: boolean;
  // Checkpoint 2 2-D: set once the judge screen's optional regression
  // checkbox has been saved for this run (judgeRun, harness/src/improvements.ts).
  regression_flag?: boolean;
};

// The judging screen's own read (GET .../improvements?run=<id>), served
// from the same route as everything else here (not a seventh route) --
// harness/src/improvements.ts's buildExperimentRunView.
export type ExperimentRunView = {
  id: number;
  // Checkpoint 2026-09-18: every run so far is a historical replay (D1,
  // DECISIONS.md); `environment` is null only for a run that failed before
  // its Knowledge was chosen.
  kind: ExperimentKind;
  environment: ReplayEnvironment | null;
  // Checkpoint 2 2-D: the derived conclusion, computed on read from
  // verdicts + environment.quality + environment.regression_flag -- null
  // until the run is judged.
  conclusion: ReplayConclusion | null;
  status: ExperimentStatus;
  stage_note: string | null;
  started_at: string;
  finished_at: string | null;
  judged_at: string | null;
  error: string | null;
  request_text: string;
  original_reply: string;
  corrections: string[];
  // Round 6 fix wave item C: "classified" (message_classifications rows, the
  // usual case) or "follow_ups" (an episode with none -- e.g. hand-built --
  // falls back to its own follow-up messages; the judging screen labels
  // this case explicitly).
  corrections_source: "classified" | "follow_ups";
  rule_text: string;
  improvement_id: number;
  original_diff: KnowledgeChanges | null;
  copy_diff: KnowledgeChanges | null;
  copy_summary: string | null;
  copy_reply: string | null;
  cost_credits: number | null;
  edits_since_episode: number | null;
  score: number | null;
  verdicts: ("yes" | "no" | "unclear")[] | null;
  // Round 6c part B: the same feedback box as the Tests page's own list.
  feedback: string | null;
  feedback_at: string | null;
  // Round 7: both builds as real Lovable projects you can open.
  project_id: string;
  project_name: string | null;
  original_summary: string | null;
  show_original: boolean;
  copy: TestBuildCopy | null;
  original_copy: TestBuildCopy | null;
  original_copy_error: string | null;
};

// Checkpoint 2 2-F: mirrors harness/src/store.ts's own CopyDeletionStatus --
// "none" until a delete is requested, "requested" once it is but Lovable's
// own read-back has not (yet, or ever) confirmed it gone, "confirmed" once
// a read-back 404'd, "failed" if the delete itself failed and the copy was
// set private instead. src/lib/harness-ux.ts's copyDeletionLine turns this
// into the line shown next to a copy.
export type CopyDeletionStatus = "none" | "requested" | "confirmed" | "failed";

/** One test build as a Lovable project (harness/src/improvements.ts). */
export type TestBuildCopy = {
  project_id: string;
  editor_url: string;
  preview_url: string;
  screenshot_url: string | null;
  deleted: boolean;
  // Checkpoint 2 2-F: mirrors harness/src/improvements.ts's own buildCopy.
  deletion_status: CopyDeletionStatus;
};

// Checkpoint 2026-09-18 WP4 (D4): mirrors harness/src/improvements.ts's own
// ContentDestination/SkillProposalView exactly. Named `content_destination`
// (not `destination`) to avoid colliding with the existing `destination`
// field below (the Knowledge target -- project/workspace/one_time -- a
// different axis: which Knowledge belongs to, not what kind of thing this
// suggestion is).
export type ContentDestinationValue = "knowledge" | "skill" | "both";
export type ContentDestination = {
  value: ContentDestinationValue;
  reason: string | null;
  alternative: string | null;
  chosen_by: "rule_writer" | "user" | null;
  recommended_label: string;
  alternative_label: string;
};

export type SkillProposalStatus = "proposed" | "approved" | "retired" | "skipped";
export type SkillProposalRevision = {
  id: number;
  new_name: string;
  new_content: string;
  new_status: string;
  reason: string;
  actor: string;
  created_at: string;
};
// ---- Checkpoint 3 S1 ----
export type SkillProposalLovableState = "not_created" | "created" | "failed";
// ---- end Checkpoint 3 S1 ----
export type SkillProposal = {
  id: number;
  name: string;
  content: string;
  status: SkillProposalStatus;
  ownership: "harness" | "user";
  lovable_state: SkillProposalLovableState;
  // ---- Checkpoint 3 S1 ----
  lovable_written_at: string | null;
  lovable_readback_ok: boolean | null;
  lovable_error: string | null;
  // ---- end Checkpoint 3 S1 ----
  revisions: SkillProposalRevision[];
} | null;

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
  // Checkpoint 2026-09-18 WP4: null only for a "retire" item.
  content_destination: ContentDestination | null;
  skill_proposal: SkillProposal;
  classification: string;
  // ---- Checkpoint 2 2-B ----
  // The classifier's own one-sentence summary of the correction (the "lesson"
  // the Inbox card and the Suggestions detail show) -- null only for a
  // "retire" item, which has no correction candidate of its own.
  // lessonLine (harness-ux.ts) falls back to the first evidence excerpt when
  // this is null or blank.
  correction_summary: string | null;
  // The four-line "What happened" story on the Suggestions detail page --
  // null for a "retire" item and for an "improvement" item whose episode has
  // no reconstructable request/reply (never fabricated).
  story: {
    requested: string;
    built: string;
    correction: string;
    changed_afterward: string | null;
  } | null;
  // The classifier's own confidence (0-1) in this suggestion, when recorded
  // -- shown next to the classification label in the detail page's
  // "Technical details". Null for a "retire" item and for an older row
  // recorded before confidence was tracked.
  confidence: number | null;
  // ---- end Checkpoint 2 2-B ----
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
  // Round 6 Task 6b / spec §6: null for a "retire" item and for an ordinary
  // improvement with no rule yet.
  test: TestInfo | null;
  // Round 5 Task 5 / spec §4: why decision_mode='automatic' didn't accept
  // this one without asking; null in ask mode and for "retire" items.
  unsure: string | null;
  // Who decided this item: 'user', 'automatic' (Round 5 Task 6), or null
  // while still pending.
  decided_by: "user" | "automatic" | null;
  // Round 5 Task 5 / spec §4: confidence x tag acceptance rate -- the Inbox
  // sort order for pending items only; every other view ignores it.
  rank: number;
  // Round 6 Task 4 / spec §4: present only on the direct response to the
  // "verdict" action -- store.recordRuleVerdict's own upsert result
  // (`changed: false` only when this is the exact same verdict already on
  // file -- VerdictControl's cue for the "Already recorded" toast instead
  // of a fresh effect line) and which of the two health-affecting branches
  // fired, mirrored on health.verdict_effect above for a caller that only
  // has the item's health at hand. Absent from every ordinary GET.
  changed?: boolean;
  effect?: VerdictEffect;
  // Addendum to Round 6 Task 4 (Round 6 Task 3 fix 2): present only on the
  // "cancel_write" response, only when the rule stayed live (only a later,
  // not-yet-written rewrite was dropped) -- harness/src/improvements.ts's
  // own cancelPendingVersion. The exact toast text to show instead of the
  // generic CANCEL_WRITE_TOAST, which wrongly claims the item went "back in
  // your Inbox".
  cancel_note?: string;
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

// Round 6 Task 6b / spec §6: the judging screen's own read -- same route as
// fetchImprovements above (?run=<id>), not a seventh one.
export type ExperimentRunResponse =
  { available: true; run: ExperimentRunView } | { available: false; reason?: string };

export async function fetchExperimentRun(runId: number): Promise<ExperimentRunResponse> {
  const res = await fetch(`/api/public/harness/improvements?run=${runId}`, {
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as ExperimentRunResponse;
}

// Round 6c part B: the Tests page's own list -- same route as everything
// else here (?runs=1), not a seventh one. Mirrors
// harness/src/improvements.ts's own ExperimentRunSummary/listTestRunSummaries.
export type ExperimentRunSummary = {
  id: number;
  // Checkpoint 2026-09-18: the Tests page's own Kind/Evidence columns.
  kind: ExperimentKind;
  environment_quality: EnvironmentQuality | null;
  // Checkpoint 2 2-D: the Tests page's own Evidence column, once judged.
  conclusion: ReplayConclusion | null;
  rule_id: number;
  improvement_id: number;
  rule_text: string;
  project_id: string | null;
  status: ExperimentStatus;
  stage_note: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
  judged_at: string | null;
  cost_credits: number | null;
  score: number | null;
  corrections: number;
  copy_deleted: number;
  feedback: string | null;
  feedback_at: string | null;
  project_name: string | null;
  copy: TestBuildCopy | null;
  original_copy: TestBuildCopy | null;
};

export type TestRunsResponse =
  { available: true; runs: ExperimentRunSummary[] } | { available: false; reason?: string };

export async function fetchTestRuns(): Promise<TestRunsResponse> {
  const res = await fetch(`/api/public/harness/improvements?runs=1`, {
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as TestRunsResponse;
}

export async function postImprovementAction(body: Record<string, unknown>): Promise<{
  available?: boolean;
  error?: string;
  reason?: string;
  improvement?: Improvement;
  // Round 6 Task 2 / spec §2: present whenever the action just attempted a
  // Knowledge write (accept unless test_first, retire, readd, restore,
  // change_wording of a written rule, retry_write) -- absent for every
  // other action (skip, reopen, set_destination, verdict, keep, and Round 6
  // Task 3's own undo/cancel_write, which never touch Lovable).
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
  verdict?: { verdict: "keep" | "review" | "not_sure"; created_at: string } | null;
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
  kind: "version" | "external_change" | "decision" | "skill" | "verdict" | "test";
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
  latest_version?: boolean;
  // Round 6 fix wave item 3: only ever set on a `test` node -- the run this
  // node is about, so timeline.tsx can link straight to /judge?run=.
  run_id?: number | null;
  // Checkpoint 2026-09-18 WP3: version nodes carry their reason, the version
  // restored from, and the rules added or removed.
  reason?: string | null;
  restored_from_version_id?: number | null;
  rules_added?: string[];
  rules_removed?: string[];
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

// Checkpoint 2026-09-18 WP4 (D4): the Skills page's "Proposed by Harness
// Ledger" section -- a local Skill proposal, never a workspace Skill (see
// Skill above). `correction_candidate_id` links back to the suggestion
// (/ledger?improvement=<id>). Checkpoint 3 S1 (D4 superseded): `lovable_state`
// starts "not_created" (kept locally only) and moves to "created" once
// publish_skill_proposal succeeds, or "failed" if it didn't -- Harness Ledger
// still never updates or deletes a Skill, including one it published itself.
export type SkillProposalListItem = {
  id: number;
  name: string;
  status: SkillProposalStatus;
  ownership: "harness" | "user";
  lovable_state: SkillProposalLovableState;
  // ---- Checkpoint 3 S1 ----
  lovable_written_at: string | null;
  lovable_readback_ok: boolean | null;
  lovable_error: string | null;
  // ---- end Checkpoint 3 S1 ----
  version_count: number;
  correction_candidate_id: number;
  updated_at: string;
};

export type SkillsResponse = {
  available: boolean;
  reason?: string;
  workspace_id?: string | null;
  fetched_at?: string | null;
  skills?: Skill[];
  proposals?: SkillProposalListItem[];
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

// Round 6 Task 6b / spec §6: the Lovable-credits Settings section and the
// Evidence "Paired tests" checkbox's own enable condition.
export type ExecutorCredits = {
  used_this_month: number;
  budget: number;
  last_test_cost: number | null;
  judged_runs: number;
};
export type UndeletedCopy = {
  run_id: number;
  copy_project_id: string;
  copy_cleanup_note: string | null;
};

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
  // Round 8 Task 6 (review item 10), fix round 1: decision_mode above is
  // always a real value (the store default is "ask"), so it can never say
  // whether the user has actually chosen one -- decision_mode_chosen reads
  // the settings table directly (no default merged in), for onboarding
  // step 3's "done" state.
  decision_mode_chosen: boolean;
  decision_auto_confidence: number;
  evidence_sources: EvidenceSources;
  feedback: FeedbackStats;
  // Round 6 Task 6b / spec §6: "Keep test copies (delete them by hand)".
  keep_test_copies: boolean;
  // Checkpoint 2026-09-18 (D7): scheduled Sync queues an analysis only when true.
  automatic_analysis_after_sync?: boolean;
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

export type AnalysisStage = "starting" | "classify" | "group" | "rules" | "judge" | "health";

export type ExecutorAnalysis = {
  last_run: ExecutorAnalysisLastRun;
  running: boolean;
  // Round 7: the run in flight, step by step, and a requested run not yet
  // started -- the Inbox's progress display.
  progress?: {
    id: number;
    started_at: string;
    progress: { stage: AnalysisStage; done: number; total: number | null } | null;
  } | null;
  queued?: boolean;
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
  credits?: ExecutorCredits;
  undeleted_copies?: UndeletedCopy[];
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
export type LovableProjectListing = {
  id: string;
  name: string;
  allowed: boolean;
  // Round 7: set when this project is one of Harness Ledger's own test copies.
  test_copy_run?: number | null;
};

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
      retirement_write_status: null,
      // Fail closed: an old/legacy payload with no `lovable` at all gives
      // no evidence either control is safe.
      can_undo: false,
      can_cancel_write: false,
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

// ---- Checkpoint 2 2-C ----
// Read-only additions for the Instructions/Skills/History redesign: none of
// these are new routes -- they widen the existing KnowledgeActiveRule (a
// rule's latest judged historical-replay run, for the "Replay evidence"
// line) and SkillProposalListItem (the fields a proposal card now shows)
// payloads, both served from knowledge.ts and skills.ts respectively.
// Declared as intersections here, appended, rather than edited into the
// original type aliases above (the shared-file rule for this file).

// Round 9 Task 7: KnowledgeActiveRuleWithJudgedRun and its RuleJudgedRun
// field type (dead exports left by an earlier task -- nothing imports
// either, and no test pins them) deleted.

/** The extra fields knowledge.ts's active_rules now carry alongside the
 * ones KnowledgeActiveRule already declared -- `getRuleHealth`'s full row,
 * not just the four legacy counts. */
export type KnowledgeActiveRuleHealthFields = {
  status?: "healthy" | "watch" | "review" | "retire_suggested" | "snoozed" | null;
  review_reason?: "inactive" | "repeated_issue" | "user_verdict" | "unclear_contradiction" | null;
  observed_repeat?: number;
  observed_clear?: number;
  ai_not_followed?: number;
  ai_followed?: number;
};

/** The Skills page's proposal-card fields: the proposal's own markdown
 * (`content`, already stored locally -- never fetched from Lovable), the
 * rule's own `applies_when`, the destination's own reason (the "when it
 * applies" line falls back to this when the rule has none), and the source
 * correction's summary (the "source correction" line's own text, next to
 * the link back to /ledger). */
export type SkillProposalCardFields = {
  content: string;
  applies_when: string | null;
  destination_reason: string | null;
  correction_summary: string;
};

export type SkillProposalCard = SkillProposalListItem & SkillProposalCardFields;
// ---- end Checkpoint 2 2-C ----

// ---- Checkpoint 3 I2 ----
// TEMPORARY: the shared InboxItem contract (WP I1 owns the real thing --
// harness/src/improvements.ts's listInboxItems/inboxCount, re-exported
// through adapter.ts and served at GET .../improvements?inbox=1). Added here,
// under this delimited section, only because I1's own exports were not yet
// present in this file when I2 needed to typecheck against the contract.
// Re-read this file before touching this block: if I1 has since added its
// own client type/fetch function (here or under its own name), delete this
// block and switch every caller to that one instead of keeping two contracts
// in parallel.
export type InboxItemType =
  "new_instruction" | "new_skill" | "test_result" | "rule_attention" | "conflict" | "action_failed";

// Round 9 Task 7 / spec §2 vocabulary (controller ruling): kept in sync with
// harness-ux.ts's own INBOX_TYPE_LABELS, the one this TEMPORARY block's own
// comment says to switch every caller to once it exists (it does now -- see
// harness-ux.ts -- but this block stays until every caller is repointed).
export const INBOX_TYPE_LABELS: Record<InboxItemType, string> = {
  new_instruction: "Suggested",
  new_skill: "New Skill",
  test_result: "Test",
  rule_attention: "Needs a decision",
  conflict: "Edited in Lovable",
  action_failed: "Something failed",
};

export type InboxItemLink = {
  page: "detail" | "judge" | "instructions" | "skills" | "tests" | "history" | "inbox";
  improvement_id?: number;
  run_id?: number;
  rule_id?: number;
};

export type InboxRecommendedAction =
  | "add_instruction"
  | "review_skill"
  | "judge_replay"
  | "review_rule"
  | "resolve_conflict"
  | "retry"
  | "review_disagreement"
  | null;

export type InboxItem = {
  id: string;
  type: InboxItemType;
  project_id: string | null;
  project_name: string | null;
  title: string;
  summary: string | null;
  created_at: string;
  link: InboxItemLink;
  improvement: Improvement | null;
  run: ExperimentRunSummary | null;
  conclusion: ReplayConclusion | null;
  recommended_action: InboxRecommendedAction;
};

export type InboxResponse =
  | { available: true; items: InboxItem[]; count: number; reason?: undefined }
  | { available: false; reason?: string; items?: undefined; count?: undefined };

export async function fetchInbox(): Promise<InboxResponse> {
  // Template literal, same convention as fetchExperimentRun/fetchTestRuns/
  // fetchTimeline's own query-string calls just above -- the structural
  // "only six local harness routes" tests scan for a literal double-quoted
  // fetch("...") call and would otherwise misread this as a seventh route.
  const res = await fetch(`/api/public/harness/improvements?inbox=1`, {
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as InboxResponse;
}
// ---- end Checkpoint 3 I2 ----
