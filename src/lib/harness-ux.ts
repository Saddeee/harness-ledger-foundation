// Pure, dependency-free presentation logic for the guided Harness UI.
// No React, no imports -- so it can be unit-tested from harness/test via tsx.
// Nothing here mutates data; it only maps internal state to plain language.

// ---- Plain-language labels for internal enum values ----

export const CLASSIFICATION_LABELS: Record<string, string> = {
  constraint_restatement: "Existing expectation was missed",
  preference_revision: "You changed the preferred approach",
  missing_requirement: "Part of the request was missed",
  defect_correction: "Lovable made an implementation mistake",
  scope_extension: "The request grew beyond its original scope",
  new_task: "A new request, not a correction",
  question: "A question, not a correction",
  approval: "An approval, not a correction",
  other: "Other",
  retire: "A retirement proposal, not a correction",
};

export const SCOPE_LABELS: Record<string, string> = {
  workspace: "Use across my projects",
  project: "Use only in this project",
  one_time: "One-time decision",
};

export const EVIDENCE_LEVEL_LABELS: Record<string, string> = {
  proposed: "Not tested yet",
  human_grounded: "Confirmed by you",
  verifiable: "Has a defined check",
  historical_support: "Supported by past history",
  controlled_support: "Supported by a controlled test",
  repeated_controlled_support: "Supported by repeated tests",
  field_supported: "Supported in real use",
};

export const VERIFIER_TYPE_LABELS: Record<string, string> = {
  structural: "Automatic check",
  diff_pattern: "Automatic diff check",
  ai_rubric: "AI review",
  human_only: "Your review",
};

export const VERIFIER_STATUS_LABELS: Record<string, string> = {
  not_run: "Not tested",
  passed: "Passed",
  failed: "Failed",
  unclear: "Unclear",
};

export const EXPERIMENT_TYPE_LABELS: Record<string, string> = {
  paired_control_treatment: "Compare with and without the rule",
  treatment_only: "Test with the rule only",
  ablation: "Test what changes when the rule is removed",
};

export const RULE_STATE_LABELS: Record<string, string> = {
  proposed: "Needs review",
  approved: "Approved, not tested",
  testing: "Being tested",
  supported: "Test supported it",
  active: "Active in Lovable",
  questioned: "Questioned",
  disabled: "Disabled",
  retired: "Retired",
  rolled_back: "Rolled back",
  rejected: "Rejected",
};

export const FIELD_LABELS: Record<string, string> = {
  predicted_failure: "Problem this should prevent",
  applies_when: "When this applies",
};

export const STAGE_LABELS: Record<string, string> = {
  found: "Found",
  review: "Your review",
  proof: "Proof",
  in_lovable: "In Lovable",
};

export const DESTINATION_PHRASES: Record<string, string> = {
  workspace: "add to all my projects",
  project: "add to this project only",
  one_time: "keep as a one-time decision",
};

export function label(map: Record<string, string>, value: string | null | undefined): string {
  if (value == null) return "";
  return map[value] ?? value;
}

// ---- One-line lay explanation, keyed by classification. Templates only:
// never invents specifics about the item. ----

export const WHY_TEMPLATES: Record<string, string> = {
  constraint_restatement:
    "Lovable missed something you already expected. Harness Ledger thinks this should become a standing instruction so it doesn't happen again.",
  preference_revision:
    "You changed how you want this done. Harness Ledger thinks the new way should become a standing instruction.",
  missing_requirement:
    "Part of what you needed wasn't in the request. Harness Ledger thinks it should become a standing instruction.",
  defect_correction:
    "Lovable made a mistake you had to fix. Harness Ledger thinks a standing instruction would prevent it.",
  scope_extension:
    "The request grew beyond its original scope. Harness Ledger thinks a standing instruction would set clearer expectations.",
  retire:
    "Harness Ledger found a signal worth your decision about whether this rule is still useful. You can retire it, or keep it and be asked again later.",
};

const WHY_GENERIC =
  "You corrected something Lovable did. Harness Ledger thinks it should become a standing instruction.";

export function whyFor(classification: string | null | undefined): string {
  return (classification && WHY_TEMPLATES[classification]) || WHY_GENERIC;
}

// ---- Text helpers ----

export function firstSentence(text: string | null | undefined): string {
  if (!text) return "";
  const trimmed = text.trim();
  const match = trimmed.match(/^.*?[.!?](?=\s|$)/);
  return (match ? match[0] : trimmed).trim();
}

export function excerpt(text: string | null | undefined, max = 240): string {
  if (!text) return "";
  const t = text.trim().replace(/\s+/g, " ");
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${cut.slice(0, lastSpace > 80 ? lastSpace : max)}…`;
}

const SHORT_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

// "8 Sep" (local time). Returns the input unchanged if it isn't a date.
export function formatDay(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getDate()} ${SHORT_MONTHS[d.getMonth()]}`;
}

// "8 Sep, 01:29" (local time).
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${formatDay(iso)}, ${hh}:${mm}`;
}

// "19:05" (local time, no date) -- Round 6 Task 2: a write that just
// happened is reported by the time alone ("Written to Lovable 19:05"), not
// the day -- the whole point of an inline write is that it happened just
// now, in this same request.
export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

// ---- Lovable reply extraction ----
// A Lovable assistant message is stored verbatim, including its tool-use
// log. The part a user actually saw in the Lovable chat is the "message"
// field of each user_messaging--message_user block. This pulls those out;
// the full verbatim text stays available behind "Show full response".

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

const MESSAGE_USER_BLOCK =
  /<lov-tool-use\b[^>]*?name="user_messaging--message_user"[^>]*?data="((?:[^"\\]|\\.)*)"/g;
const LOV_TOOL_USE_BLOCK = /<lov-tool-use\b(?:[^>"]|"(?:[^"\\]|\\.)*")*>[\s\S]*?<\/lov-tool-use>/g;
const LOV_OTHER_TAG = /<\/?lov-[\w-]+\b(?:[^>"]|"(?:[^"\\]|\\.)*")*\/?>/g;

export function lovableReplyText(raw: string): string {
  const out: string[] = [];
  for (const match of raw.matchAll(MESSAGE_USER_BLOCK)) {
    const attr = match[1] ?? "";
    const unescaped = decodeHtmlEntities(attr).replace(/\\(["\\])/g, "$1");
    try {
      const parsed = JSON.parse(unescaped) as { message?: unknown };
      if (typeof parsed.message === "string" && parsed.message.trim())
        out.push(parsed.message.trim());
    } catch {
      // not a parsable block; skip it
    }
  }
  if (out.length > 0) return out.join("\n\n");
  // Lovable's current replies have no message_user blocks: what the person
  // saw is the plain text between and after the tool-use blocks. Quoted
  // attribute values may contain ">" and escaped quotes, hence the pattern.
  if (/<lov-[\w-]+\b/.test(raw)) {
    return raw
      .replace(LOV_TOOL_USE_BLOCK, "\n\n")
      .replace(LOV_OTHER_TAG, "\n\n")
      .split(/\n{2,}/)
      .map((chunk) => chunk.trim())
      .filter(Boolean)
      .join("\n\n");
  }
  return excerpt(raw, 600);
}

// ---- Improvement presentation ----

export type Stage = {
  key: "found" | "review" | "proof" | "in_lovable";
  state: "complete" | "current" | "future" | "blocked";
  note: string | null;
};

export type DecisionLike = {
  status: "pending" | "accepted" | "skipped";
  decided_at: string | null;
};

// ---- Destinations and the Lovable write lifecycle ----

export const DESTINATION_LABELS: Record<string, string> = {
  project: "This project's Knowledge",
  workspace: "Workspace Knowledge (all my projects)",
  skill: "As a Skill",
};

export const KNOWLEDGE_CHAR_LIMIT = 10000;

// "cancelled" covers a version that was staged and then superseded by a
// later decision (skip, reopen, or switching to test-first) before the
// executor got to it -- never a failure. lovableStatusLine's switch below
// has no case for it, so it falls into the same default branch as "none"
// and "pending" -- no new copy needed.
// "reverted" covers a written restore: the rule it undid is no longer live
// in Lovable, so it must never read as "written" (added).
export type LovableWriteStatus =
  "none" | "pending" | "written" | "stale" | "failed" | "cancelled" | "reverted";

export type LovableStatusLike = {
  write_status: LovableWriteStatus;
  written_at: string | null;
  stale_reason?: string | null;
};

// Round 6 Task 2 / spec §2: the outcome of one write-to-Lovable attempt --
// the executor's own type (harness/src/executor/beats.ts's WriteOutcome),
// mirrored here so the client never has to import from harness/src/*.
export type WriteOutcome =
  | { written: true; at: string; version_id: number }
  | {
      written: false;
      version_id: number | null;
      reason: string;
      // Round 6 Task 5: "demo" (the version's rule is demo data) added to
      // beats.ts's own WriteOutcomeKind -- mirrored here too.
      kind: "not_connected" | "stale" | "rejected" | "no_snapshot" | "error" | "demo";
    };

// The line a toast (or a just-completed action's own status line) shows for
// one write attempt: "Written to Lovable 19:05" for a written outcome, the
// plain-language reason otherwise. Every write-eligible action
// (accept/retire/readd/restore/change_wording) returns a WriteOutcome
// alongside the item -- this is what turns it into the sentence the user
// reads, never a claim of a future sync.
export function writeOutcomeLine(write: WriteOutcome | null | undefined): string | null {
  if (!write) return null;
  if (write.written) return `Written to Lovable ${formatTime(write.at)}`;
  return write.reason;
}

// What the local executor knows, for the status line and decision sentence:
// whether Lovable is connected, and whether the user chose to test the
// instruction first. Every field (and the object itself) is allowed to be
// `undefined` explicitly, not just absent -- callers build this from
// optional-chained query data (e.g. `executor.data?.connection`), so the
// value itself, not just the key, is routinely undefined.
export type StatusCtx = {
  connected?: boolean | undefined;
  testFirst?: boolean | undefined;
  // Round 3 §5: this project's "write approved changes automatically" is
  // off. Callers set this only for project-destination items (a workspace
  // write isn't gated by one project's flag) -- see DecisionCard/DecidedStatus.
  autoWriteOff?: boolean | undefined;
  // Round 6 Task 4 / spec §4: the action bar's own button size -- "sm" on
  // lists, the default on the detail page (titleAs="h1"). Carried on ctx,
  // not a separate prop, so DecidedStatus's call site in DecisionCard never
  // has to change shape.
  size?: "default" | "sm" | undefined;
};

// One line describing where the instruction stands in Lovable. Never claims
// it was added unless a verified write exists. `ctx` carries what the local
// executor knows (whether Lovable is connected) and whether the user chose
// to test the instruction first -- all optional, so existing single-
// argument callers keep working unchanged.
export function lovableStatusLine(
  input: LovableStatusLike | null | undefined,
  ctx?: StatusCtx | undefined,
): string {
  switch (input?.write_status) {
    case "written":
      return `Added to Lovable, ${formatDay(input.written_at)}`;
    case "reverted":
      return `Reverted to an earlier version, ${formatDay(input.written_at)}`;
    case "stale":
      return `Write needs attention: ${input.stale_reason ?? "Knowledge changed in Lovable — review the text again"}`;
    case "failed":
      return "Write needs attention: adding failed — see Details";
    default:
      if (ctx?.testFirst) return "Saved for testing — nothing is written until the test runs";
      if (ctx?.connected === false)
        return "Connect Lovable on the Projects page to let Harness Ledger write this";
      if (ctx?.autoWriteOff) return "Waiting for you to turn on automatic writes for this project";
      // Round 6 Task 2: a decision the user presses writes in the same
      // request (see writeOutcomeLine above) -- reaching here at all means
      // Harness hasn't read this project's Knowledge from Lovable yet (no
      // snapshot to compose against), so pressing Sync now is what unblocks it.
      return "Not written yet — press Sync now on the Projects page";
  }
}

// One line for a single entry in a rule's Knowledge write history (used by
// the per-version list on the Improvement detail page). A written restore
// reads as "reverted", never as "written" (added) -- see LovableWriteStatus.
export function versionStatusLine(v: {
  status: LovableWriteStatus;
  written_at: string | null;
  restored_from_version_id: number | null;
}): string {
  return lovableStatusLine({
    write_status:
      v.status === "written" && v.restored_from_version_id != null ? "reverted" : v.status,
    written_at: v.written_at,
  });
}

export function decisionSentence(input: {
  decision: DecisionLike;
  destination: string | null;
  lovable?: LovableStatusLike | null;
  ctx?: StatusCtx | undefined;
}): string {
  const when = input.decision.decided_at ? `, on ${formatDay(input.decision.decided_at)}` : "";
  if (input.decision.status === "accepted") {
    const choice = label(DESTINATION_PHRASES, input.destination) || "accept this";
    return `You chose: ${choice}${when}. ${lovableStatusLine(input.lovable, input.ctx)}.`;
  }
  if (input.decision.status === "skipped") return `You skipped this suggestion${when}.`;
  return "Waiting for your decision.";
}

// ---- Improvements page grouping (also the card chip). Pure so it is testable. ----

export const IMPROVEMENT_GROUPS = [
  "Waiting to be written",
  "Waiting to be tested",
  "In Lovable",
  "Reverted",
  "Retired",
  "Write needs attention",
  "Skipped",
] as const;
export type ImprovementGroup = (typeof IMPROVEMENT_GROUPS)[number];

export function improvementGroup(input: {
  status: "pending" | "accepted" | "skipped";
  writeStatus: LovableWriteStatus | null | undefined;
  testFirst: boolean;
  // True once the rule behind this improvement has been retired (Task C2).
  // Checked before writeStatus so a retired rule always reads "Retired",
  // never "In Lovable"/"Reverted" from its own (now-historical) write.
  retired?: boolean | undefined;
}): ImprovementGroup | null {
  if (input.status === "skipped") return "Skipped";
  if (input.status === "pending") return null;
  if (input.retired) return "Retired";
  if (input.writeStatus === "stale" || input.writeStatus === "failed")
    return "Write needs attention";
  if (input.writeStatus === "written") return "In Lovable";
  if (input.writeStatus === "reverted") return "Reverted";
  if (input.testFirst) return "Waiting to be tested";
  return "Waiting to be written";
}

// ---- "Test it first" cost line (Add dialog only; the real historical-
// replay flow's own cost line is TEST_THIS_RULE_CREDITS_LINE below) ----

export function proveCostLine(): string {
  return "Uses Lovable credits like any build; the cost is recorded after the test.";
}

// ---- Onboarding: the only place the product explains itself ----

export const LANDING_INTRO =
  "Harness Ledger keeps your Lovable agent improving. It syncs your project chats on a schedule, finds where you had to correct Lovable, and turns each correction into a rule you approve. Harness Ledger writes it into your Lovable Knowledge, keeps every version, and can roll any of them back.";

export const HOW_IT_WORKS_STEPS = [
  {
    title: "Synced",
    text: "Harness Ledger reads your Lovable chats and Knowledge every hour. No credits, no AI.",
  },
  {
    title: "Proposed",
    text: "Where you corrected Lovable, Harness Ledger's AI analysis proposes one rule, with the exact messages as evidence.",
  },
  {
    title: "Approved by you",
    text: "Add it now, test it first in a temporary copy, or skip. Nothing changes until you say so.",
  },
  {
    title: "Written and versioned",
    text: "Harness Ledger writes the exact text you saw, reads it back to verify, and keeps every version so you can always go back.",
  },
] as const;

export const LANDING_CREDITS_LINE =
  "Credits left this month? Spend them on making Lovable better at your project. Syncing chats and writing Knowledge costs nothing. Testing a rule in a temporary copy is a normal Lovable build and uses credits like one; Harness Ledger records what each test cost.";

// Wording-history attribution: a stored reason is shown only when it was
// typed in this UI; anything else is attributed to Harness without its
// internal reason text.
export function wordingChangeLine(entry: {
  changed_at: string;
  reason: string | null;
  actor?: string | null;
}): string {
  const day = formatDay(entry.changed_at);
  if (entry.actor === "operator (local UI)") {
    return `You changed the wording on ${day}${entry.reason ? ` — ${entry.reason}` : ""}.`;
  }
  if (entry.actor == null || entry.actor.startsWith("operator")) {
    return `You changed the wording on ${day}.`;
  }
  return `Updated by Harness Ledger on ${day}.`;
}

// ---- Round 6 Task 3 / spec §3: Undo, Cancel, Remove from Knowledge ----
// "Anything not yet written to Lovable gets a plain Undo (no dialog);
// anything written gets Remove from Knowledge (retire + immediate rewrite)
// instead of Restore; Cancel lives on the Instructions pending-write
// banner; Restore lives on the History page only." Exact copy, kept here so
// every caller (the Suggestions card/detail, the Inbox confirmation row,
// the Instructions page) reads the same words.
export const UNDO_TOAST = "Undone — back in your Inbox";
export const CANCEL_WRITE_TOAST = "Cancelled — back in your Inbox";
export const REMOVE_FROM_KNOWLEDGE_TITLE = "Remove this rule from Knowledge?";
export const REMOVE_FROM_KNOWLEDGE_BODY =
  "Harness Ledger rewrites your Knowledge without it now. You can re-add it later.";
export const REMOVE_FROM_KNOWLEDGE_CONFIRM_LABEL = "Remove";

// ---- Retirement proposals (Task C2 / spec §4b-§5) ----

export type RetireReason = "hurt" | "contradiction" | "unused" | "changed_mind";
export type RetireLike = {
  reason: RetireReason;
  health: {
    applicable_tasks: number;
    helped: number;
    hurt: number;
    last_applicable_at: string | null;
    // Checkpoint 2026-09-18 WP3: the separately tracked signals, when known.
    observed_repeat?: number;
    observed_clear?: number;
    ai_not_followed?: number;
    ai_followed?: number;
  };
  since: string | null;
  contradicts_instruction?: string | null;
};

// "Harness suggests retiring this rule because ..." -- the fixed sentence
// per reason (spec §4b), never invents specifics beyond the other rule's own
// wording for a contradiction. Fix round 1 item 2: the "hurt" case no longer
// says "helped" -- same honest vocabulary as healthLine below (an applicable
// build without a repeat correction is not proof the rule helped).
export function retireReasonSentence(input: RetireLike): string {
  if (input.reason === "changed_mind") {
    return "Harness Ledger suggests retiring this rule because you asked Lovable for the opposite.";
  }
  if (input.reason === "contradiction") {
    const other = (input.contradicts_instruction ?? "another rule").replace(/\.+$/, "");
    return `Harness Ledger suggests retiring this rule because it contradicts ${other}.`;
  }
  if (input.reason === "unused") {
    return "This rule has not applied to any task in 60 days. Review whether it is still relevant.";
  }
  return (
    observedLine(input.health) ?? "Harness Ledger found the same issue in the relevant builds."
  );
}

// The one-line health summary under a retirement proposal's title -- the
// stats line for "hurt", and a plainer sentence for "contradiction"/"unused"
// where applicable/helped/hurt counts are often all zero and wouldn't read
// as evidence of anything. Fix round 1 item 2: the "hurt" stats line now
// reuses healthLine itself (defined below) rather than its own copy of the
// same counts, so the two can never say different things about the same
// rule -- and, by construction, "helped" never appears here either.
export function retireSinceLine(input: RetireLike): string {
  if (input.reason === "changed_mind") {
    return "This rule is still in your Lovable Knowledge, so Lovable keeps being told the old way.";
  }
  if (input.reason === "contradiction") {
    return "This rule is still live, but a newer rule now says the opposite.";
  }
  if (input.reason === "unused") {
    const since = input.since ? `, ${formatDay(input.since)}` : "";
    return `Since it was added${since}, this rule has not applied to any task in over 60 days.`;
  }
  return aiReviewLine(input.health) ?? healthLine(input.health) ?? "No builds in this area yet";
}

// ---- Outcome tracking (Task C3 / spec §4 v1-lite + §4b display; Round 5
// Task 7 / spec §5.1 rewrites the copy) ----
// The muted health line shown under a *live* rule -- on its Improvement
// card and on the Instructions page. Every number here is counted from real
// builds users actually ran, so it's labelled "observed from your real
// builds" -- but an applicable build without a repeat correction only means
// no repeat was SEEN, not that the rule helped, so the word "helped" never
// appears here (spec §5.1: "an applicable build without a repeat correction
// is not proof of help"). `helped` stays on the type (ImprovementHealth
// keeps the raw count for other reads, e.g. retirement math) -- this line
// just never renders it.
export type HealthLike = {
  applicable_tasks: number;
  hurt: number;
  last_applicable_at: string | null;
  // Checkpoint 2026-09-18 WP3 (spec §9): the free scan's own counts, kept
  // apart from the AI review's. When absent (an older row), the legacy
  // applicable/hurt pair is used with the same wording.
  observed_repeat?: number;
  observed_clear?: number;
  ai_not_followed?: number;
  ai_followed?: number;
  review_reason?: "inactive" | "repeated_issue" | "user_verdict" | "unclear_contradiction" | null;
};

/** What Harness observed in later relevant builds, and nothing more:
 * "Harness found the same issue in 2 of 3 relevant builds." -- no claim
 * about cause. Null when the rule has no observed counts at all. */
export function observedLine(health: HealthLike | null | undefined): string | null {
  if (!health) return null;
  const repeat = health.observed_repeat ?? health.hurt;
  const total =
    health.observed_repeat != null && health.observed_clear != null
      ? health.observed_repeat + health.observed_clear
      : health.applicable_tasks;
  if (total === 0) return "No relevant builds since this rule was added.";
  if (repeat === 0)
    return `Harness Ledger found no repeat of the issue in ${total} relevant build${total === 1 ? "" : "s"}.`;
  if (repeat === total)
    return `Harness Ledger found the same issue in all ${total} relevant build${total === 1 ? "" : "s"}.`;
  return `Harness Ledger found the same issue in ${repeat} of ${total} relevant builds.`;
}

/** What the AI review (the Judge reading Lovable's replies) marked, shown
 * separately from what was observed: "AI review marked the rule as not
 * followed in 3 of 3 relevant builds." Null until the Judge has judged. */
export function aiReviewLine(
  health:
    | { ai_not_followed?: number; ai_followed?: number }
    | { followed: number; broke: number }
    | null
    | undefined,
): string | null {
  if (!health) return null;
  const h = health as {
    ai_not_followed?: number;
    ai_followed?: number;
    broke?: number;
    followed?: number;
  };
  const notFollowed = h.broke ?? h.ai_not_followed ?? 0;
  const followed = h.followed ?? h.ai_followed ?? 0;
  const total = notFollowed + followed;
  if (total === 0) return null;
  return `AI review marked the rule as not followed in ${notFollowed} of ${total} relevant build${total === 1 ? "" : "s"}.`;
}

/** The observed line followed by when the rule last applied. */
export function healthLine(health: HealthLike | null | undefined): string | null {
  const line = observedLine(health);
  if (!line || !health) return null;
  const last = health.last_applicable_at
    ? ` Last relevant build ${formatDay(health.last_applicable_at)}.`
    : "";
  return `${line}${last}`;
}

/** The "Needs attention" block for a rule under review because the same
 * issue keeps appearing, or the "Review for relevance" block for a rule
 * with no relevant task in 60 days. Null when neither applies. */
export function attentionBlock(health: HealthLike | null | undefined): {
  title: string;
  line: string;
  recommendation: string;
  action: string;
  options?: string[];
} | null {
  if (!health || !health.review_reason) return null;
  if (health.review_reason === "inactive") {
    return {
      title: "Review for relevance",
      line: "No relevant task in the last 60 days.",
      recommendation: "Decide whether this rule still belongs in Knowledge.",
      action: "Review rule",
      // "Archive" (spec §10.1) is not a distinct state in this version: a
      // retired rule keeps its record and can be re-added, which is what
      // archiving would do. Recorded in DECISIONS.md.
      options: ["Keep", "Move to Skill", "Retest", "Retire"],
    };
  }
  const n = health.observed_repeat ?? health.hurt;
  const ai = health.ai_not_followed ?? 0;
  const line =
    n > 0
      ? `The same issue appeared in ${n} relevant build${n === 1 ? "" : "s"}.`
      : ai > 0
        ? `AI review marked the rule as not followed in ${ai} relevant build${ai === 1 ? "" : "s"}.`
        : "You asked for a review of this rule.";
  return {
    title: "Needs attention",
    line,
    recommendation: "Rewrite this rule or turn it into a Skill.",
    action: "Review rule",
  };
}

// ---- Round 5 Task 7 / spec §5.2-§5 item 3: your verdict + the AI
// adherence check, shown alongside healthLine above (never inside it --
// each number keeps its own label naming exactly which source produced
// it). ----

// "Is this rule still useful?" -- Keep / Review / Retire / Not sure. A
// usefulness decision, never a causal claim ("helped" is banned from copy).
export type RuleVerdictValue = "keep" | "review" | "retire" | "not_sure";
export const VERDICT_TEXT: Record<RuleVerdictValue, string> = {
  keep: "keep it",
  review: "review it",
  retire: "retire it",
  not_sure: "not sure",
};
export const VERDICT_QUESTION = "Is this rule still useful?";
export const VERDICT_CHOICE_LABELS: Record<RuleVerdictValue, string> = {
  keep: "Keep",
  review: "Review",
  retire: "Retire",
  not_sure: "Not sure",
};

export type VerdictLike = { verdict: RuleVerdictValue; created_at: string };

// "You said: keep it, 5 Sep" -- replaces the verdict buttons once a verdict
// exists; the buttons come back via a "Change" link next to this line.
export function verdictLine(verdict: VerdictLike | null | undefined): string | null {
  if (!verdict) return null;
  return `You said: ${VERDICT_TEXT[verdict.verdict]}, ${formatDay(verdict.created_at)}`;
}

// ---- Round 6 Task 4 / spec §4: the verdict action's own effect line --
// what recording that verdict actually changed, shown right under the
// compact VerdictControl (src/components/harness/improvement.tsx) once the
// server responds. Mirrors harness/src/improvements.ts's own
// recordVerdict return shape (`effect`) and ImprovementHealth.verdict_effect
// -- both carry the same three values. Pressing the same value twice is a
// no-op (store.recordRuleVerdict's upsert reports `changed: false`), read
// separately as the ALREADY_RECORDED_TOAST rather than one of these lines.
export type VerdictEffect = "counted_hurt" | "snoozed" | "none";

export const VERDICT_EFFECT_TEXT: Record<VerdictEffect, string> = {
  counted_hurt: "Counted as one repeat correction in this rule's health",
  snoozed: "Retirement snoozed for 30 days",
  none: "Recorded; no effect on health",
};

export function verdictEffectLine(effect: VerdictEffect | null | undefined): string | null {
  if (!effect) return null;
  return VERDICT_EFFECT_TEXT[effect];
}

export const ALREADY_RECORDED_TOAST = "Already recorded";

export type AdherenceLike = { followed: number; broke: number; not_applicable: number };

// "AI review marked the rule as not followed in 1 of 6 relevant builds." --
// null (renders nothing) until at least one episode has been judged
// followed or broke (a rule judged not_applicable on every build so far has
// nothing meaningful to report yet).
export function adherenceLine(adherence: AdherenceLike | null | undefined): string | null {
  const line = aiReviewLine(adherence);
  return line ? `${line} Quotes from Lovable's replies are in Details.` : null;
}

// ---- Round 5 Task 7 / spec §5 "which count": the Suggestions detail's
// "How Harness judges whether a rule helps" paragraph -- four sentences in
// plain words, each naming whether that source has actually run for this
// one rule (`sources`, from harness/src/improvements.ts's computeHealth),
// regardless of whether Settings › Evidence currently counts it towards
// retirement. ----
export type EvidenceSourcesLike = {
  observed: boolean;
  adherence: boolean;
  verdicts: boolean;
  paired: boolean;
};

function ranSuffix(hasRun: boolean): string {
  return hasRun ? "This has run for this rule." : "This hasn't run for this rule yet.";
}

export function evidenceSourceLines(sources: EvidenceSourcesLike | null | undefined): string[] {
  const s = sources ?? { observed: false, adherence: false, verdicts: false, paired: false };
  return [
    `Observed from your real builds: Harness Ledger counts builds in this rule's area and any repeat correction, automatically, using no Lovable credits. ${ranSuffix(s.observed)}`,
    `Your verdict: you can say directly whether a rule helped, didn't help, or you're not sure, any time. ${ranSuffix(s.verdicts)}`,
    `AI adherence check: Harness Ledger's AI reads the request and Lovable's reply and says whether the rule was followed, broken, or didn't apply, with a quote. ${ranSuffix(s.adherence)}`,
    // Checkpoint 2026-09-18: renamed away from "paired" -- every run so far
    // is a historical replay (one new build next to the historical result),
    // not a fresh two-arm comparison. See docs/audit/replay.md.
    `Historical replay: the original request built again with the rule, next to the historical result. ${ranSuffix(s.paired)}`,
  ];
}

// ---- Round 6 Task 6b / spec §6: "Test this rule" -- the confirm dialog's
// exact copy, the card's own status line for a rule's latest historical-
// replay run, and the judging screen's confounder lines. Kept here,
// verbatim, so every caller (the card, the Add dialog's "Add and test it
// first" choice, the judging screen) reads the same words. ----

export const TEST_THIS_RULE_TITLE = "Test this rule in a copy of your project?";
export const TEST_THIS_RULE_BODY =
  "Harness Ledger copies your project as it was just before your original request, adds this rule to the copy's Knowledge, and sends the same request. You get the historical result and the new build side by side as real Lovable projects you can open, compare and keep building on; delete them from the test when you're done.";
// Round 7 / Checkpoint 2026-09-18: the second copy that shows the historical
// result -- creating it uses no Lovable builder credits (D1/D2, DECISIONS.md).
export const SHOW_ORIGINAL_LABEL =
  "Also copy the historical result so I can open it (no builder credits)";
export const SHOW_ORIGINAL_HELP =
  "Leave this on when the rule is about something you can see. Turn it off for rules about things you can't, like how data is saved.";
// Round 7: "Test it first" in the Add dialog adds nothing until you decide.
export const TEST_FIRST_LABEL = "Test it first";
export const TEST_FIRST_HELP =
  "Nothing is added yet. Harness Ledger replays your original request in a new copy with this rule, next to the historical result, and you add it afterwards if it worked.";
/** A warning when a rule going to every project talks about one app. */
export function workspaceWordingWarning(
  instruction: string | null | undefined,
  projectName: string | null | undefined,
): string | null {
  if (!instruction) return null;
  const match = instruction.match(
    /\b(?:in |for )?(?:this|the) (?:app|project|site|page|website)\b/i,
  );
  if (!match) return null;
  const project = projectName ? ` if it's only for ${projectName}` : "";
  return `This rule says "${match[0].trim()}", but every project in your workspace will read it. Edit the wording first${project}, or add it to this project instead.`;
}
// Checkpoint 2026-09-18 (DECISIONS.md D1/D2, PLAN.md "Global constraints"):
// the exact, mandated cost sentence -- creating a copy is never "free"
// unqualified, and running a build inside it is a normal Lovable build.
// Shared verbatim by the test dialog, the Tests page, and Settings ›
// Lovable credits so the wording can never drift between them.
export const COPY_CREDITS_LINE =
  "Creating project copies currently uses no Lovable builder credits. Running a Lovable build in a copy consumes normal builder credits.";
export const TEST_THIS_RULE_CREDITS_LINE = `${COPY_CREDITS_LINE} The exact cost is recorded after.`;
export function testThisRuleBudgetLine(credits: {
  used_this_month: number;
  budget: number;
}): string {
  return `This month: ${credits.used_this_month} credits used of your budget of ${credits.budget}.`;
}
export const TEST_ONE_AT_A_TIME_LINE = "One test runs at a time.";
export const START_TEST_LABEL = "Start test";
export const TEST_STARTED_TOAST = "Testing started.";

// The card's status line for a rule's latest paired-test run. `queued` and
// `copying` share one phrase (the queue is a brief, invisible hop -- spec §6
// only names "copying"/"building" as distinct in-progress phrases); the
// "verdict needed" prompt is a link (built by the caller, which has a
// router), so this only returns its plain label; `judged`/`failed` need
// values a plain status string alone can't carry, so they're their own
// functions below rather than a case here.
export function testInProgressLine(status: string): string | null {
  if (status === "queued" || status === "copying") return "Testing… copying the project";
  if (status === "building") return "Testing… building in the copy";
  return null;
}
export const TEST_VERDICT_NEEDED_LABEL = "Your verdict is needed";

export type TestRunResultLike = { score: number | null; corrections: number };

// "Tested: 2 of 3 corrections no longer needed · judged by you" -- X is
// derived from score * corrections (rounded) rather than carried as its own
// field on TestInfo.run; score is exactly noCount/corrections (see
// harness/src/improvements.ts#judgeRun), so this round-trips exactly for
// any real judged run.
export function testedResultLine(run: TestRunResultLike): string {
  const no = Math.round((run.score ?? 0) * run.corrections);
  return `Tested: ${no} of ${run.corrections} correction${run.corrections === 1 ? "" : "s"} no longer needed · judged by you`;
}

export function testFailedLine(error: string | null | undefined): string {
  return `Test failed: ${error ?? "unknown error"}`;
}

// The judging screen's own confounder lines (spec §6), verbatim.
export function testCopyConfounderLine(editsSinceEpisode: number | null): string {
  // null means Lovable's edit list could not be read: say nothing about a
  // count rather than claim "0 edits".
  if (editsSinceEpisode == null)
    return "This copy started from the project as it was before that request.";
  const n = editsSinceEpisode;
  return `This copy started from the project as it was before that request; ${n} edit${n === 1 ? " has" : "s have"} landed since.`;
}
export const TEST_ONE_BUILD_LINE =
  "One replay build; evidence about this correction, not proof that the rule caused the difference.";
// Round 7, found in a live test: the copy with the rule came out in euros and
// lowercase -- preferences given to Lovable hours after the replayed request.
// Lovable's own project memory is copied as it is now, not as it was then.
export const TEST_MEMORY_CONFOUNDER_LINE =
  "Lovable's own project memory is copied as it is today, so preferences you gave Lovable after that request can show up in the copy.";
// "This test used N credits · measured" / "Cost not reported by Lovable" --
// N always comes from cost_credits (a real, measured Lovable REST response
// field, never a guess), so there is never a hardcoded number next to the
// word "credit" anywhere in this codebase's own source text.
export function testCostLine(costCredits: number | null): string {
  return costCredits == null
    ? "Cost not reported by Lovable"
    : `This test used ${costCredits} credit${costCredits === 1 ? "" : "s"} · measured`;
}

// ---- Checkpoint 2026-09-18 (WP1b, docs/audit/replay.md + ux.md, DECISIONS.md
// D1/D2): the judging screen's required section order -- the original
// correction, then Historical result / Replay with rule, a "Relevant visible
// difference" section (Lovable's own summaries, never an invented automatic
// verdict), the per-correction verdict question, an evidence-strength
// summary, a collapsed "Why this is an approximation" section (one row per
// instruction surface, never a silent fallback), and one collapsed "Full
// technical details" section. Renamed from "Key difference"/"Replay
// environment" and given a derived conclusion at Checkpoint 2 2-D -- see
// that section below. ----

export const ORIGINAL_CORRECTION_LABEL = "The original correction";
export const CORRECTIONS_LIST_LABEL = "Then you corrected it";

export const HISTORICAL_RESULT_TITLE = "Historical result";
export const HISTORICAL_RESULT_SUBTITLE =
  "What actually happened, shown through a copy of that commit";
export const REPLAY_WITH_RULE_TITLE = "Replay with rule";
export const REPLAY_WITH_RULE_SUBTITLE =
  "One new Lovable build from the same starting point, with this rule added";

// Checkpoint 2 2-D: renamed from "Key difference" -- the section shows only
// Lovable's own account of each build (summaries + diff toggles); it never
// computes or names a difference itself, so "Relevant visible difference"
// says what it actually is without implying Harness Ledger judged anything.
export const RELEVANT_DIFFERENCE_TITLE = "Relevant visible difference";
export const RELEVANT_DIFFERENCE_INTRO =
  "Lovable's own account of each build, side by side. Harness Ledger does not compute an automatic verdict on the difference -- that is what the question below is for.";

export const REPLAY_VERDICT_QUESTION =
  "Would the original correction still be needed in the replay?";
// Checkpoint 2 2-D: the judge screen's optional checkbox, next to the
// per-correction verdicts -- sets environment.regression_flag (stored by
// judgeRun, harness/src/improvements.ts) and forces the derived conclusion
// to possibly_harmful regardless of the verdicts, whatever they say.
export const REGRESSION_CHECKBOX_LABEL =
  "The replay introduced a new problem I would have to correct";

export const NO_ENVIRONMENT_RECORD_LINE = "No environment record for this test.";
// Checkpoint 2 2-D: renamed from "Replay environment" -- the nine-row
// breakdown moved into this collapsed <details> (evidenceStrengthTitle/
// evidenceStrengthLine above it stay uncollapsed, Level 2 explanation).
export const WHY_APPROXIMATION_TITLE = "Why this is an approximation";
export const FULL_TECHNICAL_DETAILS_TITLE = "Full technical details";

// The columns' own short excerpt of Lovable's summary uses the existing
// `excerpt` helper above (240 chars by default) -- the full text lives in
// Full technical details.

export type ExperimentKindLike = "historical_replay" | "paired_comparison";

// Every run so far is a historical replay (D1, DECISIONS.md); paired_comparison
// is deferred (D3) and has no run to label yet, but the map is exhaustive so a
// future run kind can never fall back to a raw enum value on screen.
export const EXPERIMENT_KIND_LABEL: Record<ExperimentKindLike, string> = {
  historical_replay: "Historical replay",
  paired_comparison: "Fresh two-build comparison",
};

export type EnvironmentQualityLike =
  "controlled" | "partially_controlled" | "historical_approximation" | "not_comparable";

export const ENVIRONMENT_QUALITY_LABEL: Record<EnvironmentQualityLike, string> = {
  controlled: "Controlled",
  partially_controlled: "Partially controlled",
  historical_approximation: "Historical approximation",
  not_comparable: "Not comparable",
};

/** The Tests page's own short "Evidence" cell -- "—" only when a run
 * predates the environment record entirely (never possible after backfill,
 * kept for type safety). */
export function environmentQualityLabel(
  quality: EnvironmentQualityLike | null | undefined,
): string {
  return quality ? ENVIRONMENT_QUALITY_LABEL[quality] : "—";
}

// The judging screen's own evidence-strength line, one sentence per quality
// (DECISIONS.md D2's own quality rule, in plain words) -- null only when
// there is no environment record at all (NO_ENVIRONMENT_RECORD_LINE covers
// that case on the page itself, not this function).
export function evidenceStrengthLine(
  quality: EnvironmentQualityLike | null | undefined,
): string | null {
  switch (quality) {
    case "historical_approximation":
      return "Historical approximation: the historical result ran in a different Lovable environment; this replay shows whether the correction would appear again, not that the rule alone caused any difference.";
    case "not_comparable":
      return "Not comparable: the historical code state could not be established.";
    case "partially_controlled":
      return "Partially controlled";
    case "controlled":
      return "Controlled";
    default:
      return null;
  }
}

// Checkpoint 2 2-D: the judging screen's section 6 title, "Evidence
// strength: <quality label>" -- e.g. "Evidence strength: Historical
// approximation". A function, not a constant, because the quality varies
// per run; evidenceStrengthLine (above) supplies the sentence underneath.
export function evidenceStrengthTitle(quality: EnvironmentQualityLike | null | undefined): string {
  return `Evidence strength: ${environmentQualityLabel(quality)}`;
}

// ---- Checkpoint 2 2-D: derived conclusion ----
// DECISIONS.md D1's own product name for this feature -- the judging
// screen's page title and the Tests page's own intro line both use it, so
// a reader sees the same name for "this whole thing" wherever they meet it.
export const TEST_A_RULE_PAGE_TITLE = "Test a rule against a previous correction";

// Mirrors harness/src/executor/replay-environment.ts's own ReplayConclusion
// exactly, as a local structural type (this file stays dependency-free).
// Never "controlled_support" -- a historical replay's quality never reaches
// "controlled" (D2), so this vocabulary is deliberately kept to exactly the
// four honest outcomes replayConclusion can actually produce.
export type ReplayConclusionLike =
  "historical_support" | "not_supported" | "possibly_harmful" | "inconclusive";

export const CONCLUSION_LABELS: Record<ReplayConclusionLike, string> = {
  historical_support: "Historical support",
  not_supported: "Not supported by this replay",
  possibly_harmful: "Possible regression",
  inconclusive: "Inconclusive",
};

/** "Conclusion: Historical support" -- shown once a run is judged; null
 * (nothing shown) before that, same convention as evidenceStrengthLine's
 * own null-when-nothing-to-say case. */
export function conclusionLine(conclusion: ReplayConclusionLike | null | undefined): string | null {
  return conclusion ? `Conclusion: ${CONCLUSION_LABELS[conclusion]}` : null;
}

/** The Tests page's own Evidence column: the conclusion once judged (it is
 * the more specific, more useful answer), the bare quality label before
 * that -- never both, never neither when one is available. */
export function evidenceColumnLabel(
  quality: EnvironmentQualityLike | null | undefined,
  conclusion: ReplayConclusionLike | null | undefined,
): string {
  return conclusion ? CONCLUSION_LABELS[conclusion] : environmentQualityLabel(quality);
}

/** Level 3's plain-words account of how the conclusion above was reached --
 * the verdict counts, the evidence strength, and whether a regression was
 * flagged -- so "Full technical details" never just asserts a conclusion,
 * it shows the arithmetic. Not judged yet (`verdicts` null/empty) says so
 * and stops there, same honesty rule as replayConclusion itself. */
export function conclusionDerivationLines(input: {
  verdicts: ("yes" | "no" | "unclear")[] | null | undefined;
  quality: EnvironmentQualityLike | null | undefined;
  regression_flag?: boolean | null;
}): string[] {
  if (!input.verdicts || input.verdicts.length === 0) {
    return ["Not judged yet: no verdicts to derive a conclusion from."];
  }
  const yes = input.verdicts.filter((v) => v === "yes").length;
  const no = input.verdicts.filter((v) => v === "no").length;
  const unclear = input.verdicts.filter((v) => v === "unclear").length;
  const total = input.verdicts.length;
  return [
    `Verdicts: ${yes} yes, ${no} no, ${unclear} unclear (${total} correction${total === 1 ? "" : "s"} total).`,
    `Evidence strength: ${environmentQualityLabel(input.quality)}.`,
    input.regression_flag
      ? "You flagged that the replay introduced a new problem you would have to correct."
      : "No regression was flagged for this replay.",
  ];
}
// ---- end Checkpoint 2 2-D: derived conclusion ----

// The shape this module needs from harness/src/executor/replay-environment.ts's
// ReplayEnvironment -- a local, structural type (this file stays dependency-
// free) rather than an import from the harness/src half of the app.
export type ReplayEnvironmentLike = {
  // request_message_id is not read by this module's own logic (only the
  // Full technical details block on judge.tsx reads it, straight off
  // ExperimentRunView["environment"]) -- left off this local shape on
  // purpose so harness-ux.ts's own internal-vocabulary ban keeps covering
  // "message_id" everywhere it actually matters.
  code_state: {
    source: "historical_commit_before_request" | "unavailable";
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
  uncontrolled: readonly string[];
  quality: EnvironmentQualityLike;
  historical_rules_dropped_by_run?: boolean;
  regression_flag?: boolean;
};

export type ReplayEnvironmentRow = { label: string; text: string };

// "13 Sep 19:06" -- like formatDate, but without its ", " separator, to
// match the exact wording spec §... gives for the Project Knowledge row.
function dayTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${formatDay(iso)} ${hh}:${mm}`;
}

function beforeRequestPhrase(diffMs: number): string {
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return "less than a minute before the request";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} before the request`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} before the request`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} before the request`;
}

function projectKnowledgeText(pk: ReplayEnvironmentLike["project_knowledge"]): string {
  switch (pk.source) {
    case "exact_historical":
      return "Exact version at the time of the request";
    case "nearest_earlier_version": {
      if (!pk.snapshot_fetched_at) return "Nearest earlier version on file";
      const when = dayTime(pk.snapshot_fetched_at);
      if (pk.episode_started_at) {
        const gapMs =
          new Date(pk.episode_started_at).getTime() - new Date(pk.snapshot_fetched_at).getTime();
        if (Number.isFinite(gapMs) && gapMs >= 0) {
          return `Nearest earlier version, read ${when}, ${beforeRequestPhrase(gapMs)}`;
        }
      }
      return `Nearest earlier version, read ${when}`;
    }
    case "current_fallback":
      return "Today's Knowledge (no version from before the request was on file)";
    case "unavailable":
      return "None on file; the copy started with empty Knowledge";
  }
}

// Checkpoint 2 2-D: "Other active rules" -- which other instructions were
// kept in this replay's Knowledge (a setup fact, not itself a reason this
// is an approximation) -- moved out of replayEnvironmentRows into its own
// line so it can live in "Full technical details" instead. Kept, not
// deleted: the "an older test" disclosure it carries still matters.
export function otherActiveRulesLine(
  env:
    | Pick<ReplayEnvironmentLike, "other_active_rules" | "historical_rules_dropped_by_run">
    | null
    | undefined,
): string | null {
  if (!env) return null;
  if (env.other_active_rules.length === 0) return "Other active rules kept in this replay: none.";
  const dropped = env.historical_rules_dropped_by_run
    ? " -- these rules were live at the time but were not in this replay's Knowledge (an older test); newer tests keep them"
    : "";
  return `Other active rules kept in this replay: ${env.other_active_rules.join("; ")}${dropped}`;
}

// The "Why this is an approximation" section's exact nine rows (docs/audit/
// replay.md §2/§3, DECISIONS.md D2, Checkpoint 2 2-D) -- every instruction
// surface a replay can and cannot control, in one place, never a silent
// fallback. "Other active rules" (a setup fact, not an approximation
// surface) moved to Full technical details -- see otherActiveRulesLine.
export function replayEnvironmentRows(
  env: ReplayEnvironmentLike | null | undefined,
): ReplayEnvironmentRow[] {
  if (!env) return [];
  const codeStateText =
    env.code_state.source === "historical_commit_before_request"
      ? "Exact version at the time of the request"
      : "Could not be established; the copy could not be started from the historical commit";
  return [
    { label: "Code state", text: codeStateText },
    { label: "Project Knowledge", text: projectKnowledgeText(env.project_knowledge) },
    {
      label: "Workspace Knowledge",
      text: "As it is today; Harness Ledger cannot reconstruct the version at the time",
    },
    { label: "Skills", text: "As they are today (workspace Skills apply to the copy)" },
    { label: "Chat history", text: env.chat_history.included ? "Copied" : "Not copied" },
    {
      label: "Project memory",
      text: "Lovable's own project memory is copied as it is today",
    },
    {
      label: "Candidate rule",
      text: env.candidate_rule.already_present
        ? `${env.candidate_rule.instruction} (already present in the historical Knowledge)`
        : env.candidate_rule.instruction,
    },
    { label: "Builder version", text: "Not exposed by Lovable; not recorded" },
    {
      label: "Uncontrolled context",
      text: "Lovable's own project memory, workspace Knowledge, Skills and the builder version come from today, not from the time of the request",
    },
  ];
}
// ---- end Round 6 Task 6b ----

// Round 6 fix wave item C: shown on the judging screen only when the run's
// own corrections_source is "follow_ups" -- an episode with no classified
// correction on record (e.g. hand-built before the classifier pipeline
// existed) whose corrections list is instead the owner's own follow-up
// messages after the original request.
export const CORRECTIONS_FROM_FOLLOW_UPS_LINE = "Corrections taken from your follow-up messages";

// ---- Round 6c part B: the Tests page (owner's own ask, 2026-09-13: "a page
// dedicated for this so you can see status, and actual results, and
// somewhere we can collect feedback from the user about this"). Copy
// shared between the Tests page and the card's own "See on Tests" link
// (improvement.tsx) lives here; the page's own table/empty-state copy that
// nothing else reads stays local to tests.tsx, same convention
// history.tsx's own EMPTY_LINE uses. ----
export const SEE_ON_TESTS_LABEL = "See on Tests";

// "This month: N credits used of your budget of B · measured" -- the Tests
// page's own credits line, distinct from testThisRuleBudgetLine's confirm-
// dialog wording (that one has no "· measured" suffix): both N and B are
// always real numbers read off the executor's own credits/settings, never
// typed literally.
export function testsPageCreditsLine(credits: { used_this_month: number; budget: number }): string {
  return `This month: ${credits.used_this_month} credits used of your budget of ${credits.budget} · measured`;
}
// ---- end Round 6c part B ----

// ---- Checkpoint 2026-09-18 WP4: destination ----
// Skills as a first-class destination (D4, docs/audit/skills.md §3): a
// suggestion's `content_destination` (Knowledge / Skill / both), and the
// local Skill proposal that goes with it. Named CONTENT_DESTINATION_* --
// not DESTINATION_* -- because DESTINATION_LABELS/DESTINATION_PHRASES above
// already name a DIFFERENT, older concept (which Knowledge target --
// project vs workspace vs one-time -- an accepted rule writes to); reusing
// that name here would silently repoint every existing caller of
// DESTINATION_LABELS (the Add dialog, the Knowledge-versions list) at the
// wrong map.

export const DESTINATION_RECOMMENDED = "Recommended destination";
export const DESTINATION_WHY = "Why";
export const DESTINATION_ALTERNATIVE = "Alternative";
export const DESTINATION_CHANGE = "Change destination";

export type ContentDestinationValue = "knowledge" | "skill" | "both";

export const CONTENT_DESTINATION_LABELS: Record<ContentDestinationValue, string> = {
  knowledge: "Knowledge",
  skill: "Skill",
  both: "Knowledge + Skill",
};

// The generic sentence shown when the Rule writer (or a human's own later
// choice) gave no reason of its own.
export const CONTENT_DESTINATION_REASON_DEFAULT: Record<ContentDestinationValue, string> = {
  knowledge: "A short standing preference that should be available on every relevant request.",
  skill: "A multi-step procedure that applies only to one kind of task.",
  both: "A short reminder in Knowledge that points to the detailed procedure in a Skill.",
};

/** The "Why" line for a suggestion's recommended destination: its own
 * reason when one was given, else the generic sentence for that
 * destination value. */
export function contentDestinationReason(
  value: ContentDestinationValue,
  reason: string | null | undefined,
): string {
  return reason && reason.trim() ? reason : CONTENT_DESTINATION_REASON_DEFAULT[value];
}

/** The "Alternative" line: the Rule writer's own free-text alternative when
 * given, else a plain fallback naming the other destination by its label. */
export function contentDestinationAlternative(
  alternativeLabel: string,
  alternative: string | null | undefined,
): string {
  return alternative && alternative.trim() ? alternative : `Could also go as: ${alternativeLabel}.`;
}

// Skill proposals: status and honesty copy. `lovable_state` never has any
// value other than 'not_created' in this checkpoint -- SKILL_NOT_IN_LOVABLE_LINE
// is the one sentence responsible for saying so everywhere a Skill proposal
// is shown (the Skills page and the suggestion detail's DestinationChoice).
export const SKILL_PROPOSAL_STATUS_LABELS: Record<string, string> = {
  proposed: "Proposed",
  approved: "Approved",
  retired: "Retired",
  skipped: "Skipped",
};

export const SKILL_NOT_IN_LOVABLE_LINE =
  "Not in Lovable yet: Harness Ledger keeps this Skill locally with its versions. Creating and updating Skills in Lovable is not wired in this version.";

export const SKILL_OWNED_BY_USER_LINE =
  "This Skill is yours; Harness Ledger does not change user-owned Skills.";

export function skillProposalStatusLabel(status: string | null | undefined): string {
  return (status && SKILL_PROPOSAL_STATUS_LABELS[status]) || "Proposed";
}

/** "N version" / "N versions" -- the Skills page's per-proposal count. */
export function skillProposalVersionCountLine(count: number): string {
  return `${count} version${count === 1 ? "" : "s"}`;
}
// ---- end Checkpoint 2026-09-18 WP4: destination ----

// ---- Checkpoint 2026-09-18 WP5: analysis ----
// D7: the automatic-analysis-after-sync setting (default off -- the
// Settings toggle itself is wired by the orchestrator; this file only owns
// the key and its label), the "Analyse now" scope disclosure, and
// "Reanalyse history" (scope dialog copy, the estimate line, and the
// disagreement review-item card).

// Matches harness/src/analysis/context.ts's own AUTOMATIC_ANALYSIS_SETTING_KEY
// constant exactly -- kept as a plain string literal here (not imported)
// since src/ and harness/ are separate packages; the two are asserted equal
// by this file's own structural test.
export const AUTOMATIC_ANALYSIS_SETTING_KEY = "automatic_analysis_after_sync";
export const AUTOMATIC_ANALYSIS_SETTING_LABEL =
  "Run analysis automatically after each sync (uses AI tokens)";

export const ANALYSE_NOW_SCOPE_LINE =
  "Only new messages and corrections are analysed; older context may be read as context without being analysed again.";

export const REANALYSE_TITLE = "Reanalyse history";
export const REANALYSE_BODY =
  "Re-checks messages Harness Ledger already looked at, using the current classifier. A decision you already made is never changed automatically: if the new result disagrees with it, that becomes a review item here in the Inbox instead of overwriting anything.";

export const REANALYSE_PROJECTS_LABEL = "Projects";
export const REANALYSE_FROM_LABEL = "From";
export const REANALYSE_TO_LABEL = "To";
export const REANALYSE_INCLUDE_REVIEWED_LABEL = "Include records I already decided on";
export const REANALYSE_REASON_LABEL = "Why are you re-checking this?";
export const REANALYSE_REASON_PLACEHOLDER =
  "e.g. checking whether an updated rule changes past corrections";
export const REANALYSE_CONFIRM_BUTTON = "Reanalyse";
export const REANALYSE_CANCEL_BUTTON = "Cancel";
export const REANALYSE_TRIGGER_BUTTON = "Reanalyse history";

/** "About N messages · ≈ T tokens · model M · budget remaining R" -- shown
 * in the confirm dialog before a reanalyse request is sent. */
export function reanalyseEstimateLine(input: {
  messages: number;
  estimated_tokens: number;
  model: string;
  budget_remaining: number;
}): string {
  const messages = `${input.messages} message${input.messages === 1 ? "" : "s"}`;
  return `About ${messages} · ≈ ${input.estimated_tokens.toLocaleString()} tokens · model ${input.model} · budget remaining ${input.budget_remaining.toLocaleString()}`;
}

export const DISAGREEMENT_TITLE = "A newer analysis disagrees with your previous decision.";
export const DISAGREEMENT_ACCEPT_BUTTON = "Accept the new result";
export const DISAGREEMENT_DISMISS_BUTTON = "Keep my decision";

/** The disagreement card's own body line -- what changed, not why (the
 * reason a person gave for reanalysing is shown separately). */
export function disagreementBodyLine(
  previousClassification: string,
  proposedClassification: string,
): string {
  return `You classified this as "${previousClassification}". The newest analysis says "${proposedClassification}".`;
}
// ---- end Checkpoint 2026-09-18 WP5: analysis ----

// ---- Checkpoint 2 2-F ----
// A delete request returning 2xx is Lovable accepting it, not proof the
// project is gone (harness/src/executor/experiments.ts's own
// confirmDeletion does one free read-back to tell the difference). This is
// the wording next to a test copy for each status that read-back can leave
// a run in; null means there is nothing to say (no delete was ever
// requested for this copy).
export function copyDeletionLine(
  status: "none" | "requested" | "confirmed" | "failed",
): string | null {
  switch (status) {
    case "none":
      return null;
    case "requested":
      return "Deletion requested; Lovable has not confirmed it yet.";
    case "confirmed":
      return "Deleted in Lovable (confirmed).";
    case "failed":
      return "Could not delete; the copy was set private. Delete it by hand in Lovable.";
  }
}
// ---- end Checkpoint 2 2-F ----

// ---- Checkpoint 2 2-E ----
// OpenAI provider compatibility + Settings > AI analysis "Test provider"
// button. A newer OpenAI model can reject `max_tokens` (it wants
// `max_completion_tokens`) and reject `temperature` outright --
// harness/src/llm/openai.ts retries once when that happens; these are the
// plain-language versions of what it found, for the button's result line.
// harness/src/llm/index.ts's testProvider() keeps its own copy of the same
// three sentences (harness/src and src/ are separate packages, the same
// reason analysis/context.ts's AUTOMATIC_ANALYSIS_SETTING_KEY is duplicated
// rather than imported) -- harness/test/ux-provider-test.test.ts keeps the
// two in lockstep.
export const TEST_PROVIDER_BUTTON_LABEL = "Test provider";
export const TEST_PROVIDER_CONSEQUENCE_LINE =
  "Sends one tiny request to your AI provider. Uses a few AI tokens. Changes nothing.";

/** "Provider test passed: gpt-4o, about 40 tokens" -- the button's success line. */
export function testProviderSuccessLine(model: string, estimatedTokens: number): string {
  return `Provider test passed: ${model}, about ${estimatedTokens} tokens`;
}

/** `retriedWith` is a parameter name ("max_completion_tokens"/"max_tokens") or "no temperature parameter" for the temperature case, which has no substitute. */
export function openAiParamRejectedLine(
  model: string,
  rejectedParam: "max_tokens" | "max_completion_tokens" | "temperature",
  retriedWith: string | null,
): string {
  const base = `OpenAI rejected a request parameter for model ${model} (${rejectedParam}).`;
  return retriedWith ? `${base} Harness Ledger retried with ${retriedWith}.` : base;
}

export function openAiModelNotFoundLine(model: string): string {
  return `The model name ${model} was not found at OpenAI.`;
}

export const OPENAI_KEY_REJECTED_LINE = "OpenAI rejected the API key.";
// ---- end Checkpoint 2 2-E ----

// ---- Checkpoint 2 2-B ----
// Inbox card (Level 1) and Suggestions detail simplification. One helper per
// piece of copy so the Inbox card and the Suggestions detail's "What the
// action will do" section can never say something different about the same
// action. No internal enum name (missing_requirement, constraint_restatement,
// preference_revision, one_time, retire_suggested, ...) is spelled out by any
// of these -- everything here is either an existing plain-language helper
// (whyFor, contentDestinationReason) or a brand new fixed phrase.

export type PrimaryActionKind = "add" | "review_skill" | "test_first" | "skip";

// The closed set of primary actions the Inbox card (and the Suggestions
// detail's "What the action will do" section) may ever show -- exact button
// text.
export const PRIMARY_ACTION_LABELS: Record<PrimaryActionKind, string> = {
  add: "Add instruction",
  review_skill: "Review Skill",
  test_first: "Test first",
  skip: "Skip",
};

/** The plain-language lesson for a suggestion card: what Harness Ledger
 * concluded happened, in one sentence -- never the proposed instruction
 * itself (that's shown as its own line). Prefers the classifier's own
 * summary of the correction; falls back to the first evidence message's own
 * text; never invents anything, and never returns an internal enum name. */
export function lessonLine(item: {
  correction_summary?: string | null;
  evidence: { text: string }[];
}): string {
  const raw =
    (item.correction_summary && item.correction_summary.trim()) || item.evidence[0]?.text || "";
  if (!raw.trim()) return "Harness Ledger found something in your Lovable chat worth a decision.";
  return firstSentence(raw) || excerpt(raw, 160);
}

/** "Project Knowledge" / "Workspace Knowledge" / "Skill" / "Knowledge and
 * Skill" -- the plain-word destination label for the card and the detail
 * page, derived from content_destination (Knowledge / Skill / both) and,
 * for a Knowledge-bearing destination, which Knowledge target it would use.
 * Never an internal enum name. */
export function destinationLabelPlain(
  contentDestinationValue: ContentDestinationValue | null | undefined,
  knowledgeTarget: "project" | "workspace" | "one_time" | null | undefined,
): string {
  if (contentDestinationValue === "skill") return "Skill";
  if (contentDestinationValue === "both") return "Knowledge and Skill";
  return knowledgeTarget === "workspace" ? "Workspace Knowledge" : "Project Knowledge";
}

/** The exact consequence line for one of the four primary actions -- always
 * says whether Lovable changes, whether Lovable credits are used, and
 * whether AI tokens are used, verbatim (checkpoint 2 brief). `destination`
 * only matters for "add" (project vs workspace changes the wording); it is
 * ignored for the other three actions. */
export function actionConsequence(
  action: PrimaryActionKind,
  destination?: "project" | "workspace" | null,
): string {
  switch (action) {
    case "add":
      return destination === "workspace"
        ? "Writes to Lovable Knowledge for all your projects. No Lovable credits. No AI tokens."
        : "Writes to Lovable Knowledge in this project. No Lovable credits. No AI tokens.";
    case "review_skill":
      return "Opens the Skill proposal. Nothing changes in Lovable.";
    case "test_first":
      return "Runs one Lovable build in a temporary copy. Uses Lovable credits. Nothing changes in your project.";
    case "skip":
      return "Nothing changes in Lovable. Harness Ledger will not propose this again.";
  }
}

/** Which ONE action the Inbox card recommends as primary, from the closed
 * set {add, review_skill, test_first} -- Skip is always available but is
 * never itself the recommendation (Harness Ledger doesn't suggest skipping;
 * a person chooses that). Skill-only destinations have nothing to add to
 * Knowledge, so they recommend reviewing the Skill instead; a Knowledge (or
 * Knowledge + Skill) destination recommends testing first when Harness
 * Ledger already staged a test for it, else recommends adding it. */
export function recommendedPrimaryAction(item: {
  content_destination: { value: ContentDestinationValue } | null;
  decision: { test_first: boolean };
}): "add" | "review_skill" | "test_first" {
  if (item.content_destination?.value === "skill") return "review_skill";
  if (item.decision.test_first) return "test_first";
  return "add";
}
// ---- end Checkpoint 2 2-B ----

// ---- Checkpoint 2 2-C ----
// Instructions / Skills / History simplification: the Instructions page's
// per-rule "is this rule live and untroubled" line (kept apart from the
// Status column's write-status label, and from observedLine/aiReviewLine/
// verdictLine -- every one of those stays its own line, never merged), the
// "Replay evidence" line reusing Checkpoint 2 2-D's own conclusion labels,
// and the Skills page's proposal-card copy (a Skill proposal's plain-words
// purpose/applies-when/procedure preview, parsed from its own markdown).

/** "Active in Lovable" once at least one historical-replay run for this
 * rule has been judged, else "Active, not replay-tested" -- never rendered
 * for a rule whose health status is 'review' or 'retire_suggested' (the
 * attention block takes that line's place instead; see attentionBlock
 * above). Deliberately not a claim that the rule helped -- only that it is
 * live, and whether it has ever been replay-tested. */
export function ruleActiveLine(hasJudgedReplay: boolean): string {
  return hasJudgedReplay ? "Active in Lovable" : "Active, not replay-tested";
}

/** The Instructions page's "Replay evidence" line: the same conclusion
 * label Checkpoint 2 2-D's Tests/judging pages show (CONCLUSION_LABELS
 * above) when this rule's latest judged run carries one, else the plain
 * fact that a run was judged. Null (nothing shown) until a run has actually
 * been judged for this rule. */
export function replayEvidenceLine(
  judgedRun: { conclusion?: string | null } | null | undefined,
): string | null {
  if (!judgedRun) return null;
  const conclusion = judgedRun.conclusion as ReplayConclusionLike | null | undefined;
  const label = conclusion ? CONCLUSION_LABELS[conclusion] : undefined;
  return label ?? "Replay judged";
}

/** The "Needs your attention" section's empty state, when no rule's health
 * status is 'review' or 'retire_suggested'. */
export const NOTHING_NEEDS_ATTENTION_LINE = "Nothing needs your attention.";

/** The Skills page's exact honesty line for a locally proposed Skill card
 * -- distinct from SKILL_NOT_IN_LOVABLE_LINE above (that longer sentence
 * stays on the suggestion detail's DestinationChoice and is not touched
 * here): the card itself just needs the one short fact. */
export const SKILL_NOT_PUBLISHED_LINE = "Not published to Lovable yet.";

export const REVIEW_SKILL_LABEL = "Review Skill";

/** The first non-empty paragraph of a Skill proposal's own markdown, after
 * its leading "# Title" line(s) -- the card's plain-words purpose. Falls
 * back to the rule's own instruction when the proposal has no body text of
 * its own yet (a freshly created draft, or one written by hand with only a
 * title so far). */
export function skillProposalPurpose(
  content: string | null | undefined,
  fallbackInstruction: string | null | undefined,
): string {
  const lines = (content ?? "").split("\n");
  let i = 0;
  while (i < lines.length && (lines[i]!.trim() === "" || lines[i]!.trim().startsWith("#"))) i++;
  const paragraph: string[] = [];
  while (i < lines.length && lines[i]!.trim() !== "") {
    paragraph.push(lines[i]!.trim());
    i++;
  }
  const text = paragraph.join(" ").trim();
  return text || (fallbackInstruction ?? "").trim();
}

/** "When it applies": the rule's own applies_when when it has one, else the
 * suggestion's destination reason (the Rule writer's own words for why this
 * became a Skill in the first place, which is usually itself a statement of
 * when the procedure applies). Null when neither exists. */
export function skillProposalAppliesWhen(
  appliesWhen: string | null | undefined,
  destinationReason: string | null | undefined,
): string | null {
  const a = (appliesWhen ?? "").trim();
  if (a) return a;
  const r = (destinationReason ?? "").trim();
  return r || null;
}

/** The first three numbered-list lines ("1. ...", "2) ...") found in a
 * Skill proposal's markdown -- a short procedure preview; the full
 * procedure lives behind "Review Skill", never repeated here. Empty when
 * the draft has no numbered steps yet. */
export function skillProposalProcedurePreview(content: string | null | undefined): string[] {
  const steps: string[] = [];
  for (const raw of (content ?? "").split("\n")) {
    const m = /^\s*\d+[.)]\s+(.*)$/.exec(raw);
    if (m) {
      steps.push(m[1]!.trim());
      if (steps.length === 3) break;
    }
  }
  return steps;
}
// ---- end Checkpoint 2 2-C ----

// ---- Checkpoint 3 I2 ----
// The Inbox becomes the single decision queue (checkpoint 3, WP I2): copy for
// the queue heading/intro, the secondary "Analysis" section below it, the
// Knowledge/Skill/Test-result/Rule-attention/Conflict/Action-failed cards,
// and the History page's new kind filter. Mirrors the InboxItem contract
// shared with WP I1 (harness/src/improvements.ts's listInboxItems/
// inboxCount) as a local, dependency-free structural type -- this file never
// imports from harness/src or src/lib/improvements-client.ts.

export type InboxItemTypeLike =
  "new_instruction" | "new_skill" | "test_result" | "rule_attention" | "conflict" | "action_failed";

// Mirrors the contract's own INBOX_TYPE_LABELS exactly -- the one place the
// Inbox card and the History filter both read a type's plain-language name.
export const INBOX_TYPE_LABELS: Record<InboxItemTypeLike, string> = {
  new_instruction: "New instruction",
  new_skill: "New Skill",
  test_result: "Test result",
  rule_attention: "Rule needs attention",
  conflict: "Conflict",
  action_failed: "Action failed",
};

export const INBOX_TITLE = "Inbox";
export const INBOX_INTRO = "Inbox contains everything that needs your attention.";
export const VIEW_PAST_DECISIONS = "View past decisions";

/** "3 decisions need your attention." / "One decision needs your attention."
 * / "Nothing needs your attention." -- the Inbox heading's own count line,
 * always built from the server's own inboxCount, never re-derived. */
export function inboxCountLine(n: number): string {
  if (n === 0) return "Nothing needs your attention.";
  if (n === 1) return "One decision needs your attention.";
  return `${n} decisions need your attention.`;
}

// ---- Inbox: secondary "Analysis" section ----

export const NEW_ACTIVITY_TITLE = "New activity is ready";
// "Everything synced has been analysed." -- the caller appends
// " Last analysis <time>." itself (formatTime/formatDate already do that
// formatting; no need for a second date-formatting helper here).
export const ANALYSED_ALL_LINE = "Everything synced has been analysed.";
export const REANALYSE_TOKENS_NOTE = "Can use additional AI tokens.";

/** "N new messages can be analysed." / "One new message can be analysed." --
 * the count is omitted (a plainer "New messages can be analysed.") when it
 * isn't known. */
export function newActivityLine(n: number | null | undefined): string {
  if (n == null) return "New messages can be analysed.";
  if (n === 1) return "One new message can be analysed.";
  return `${n} new messages can be analysed.`;
}

/** "Estimated AI-token use: about T tokens" -- "not estimated" when the
 * reanalyse-estimate function couldn't be scoped to just the unanalysed
 * messages (e.g. no prior analysis run to scope from). */
export function tokenEstimateLine(t: number | null | undefined): string {
  if (t == null) return "Estimated AI-token use: not estimated";
  return `Estimated AI-token use: about ${t.toLocaleString()} tokens`;
}

// ---- Inbox card: shared tertiary/secondary copy ----

export const WHY_RECOMMENDS_TITLE = "Why Harness Ledger recommends this";
export const TEST_IN_PROGRESS_LINE = "Test in progress";
export const USE_KNOWLEDGE_INSTEAD = "Use Knowledge instead";
export const EDIT_LABEL = "Edit";
export const CHANGE_DESTINATION_LABEL = "Change destination";
export const VIEW_DETAILS_LABEL = "View details";
export const VIEW_EVIDENCE_LABEL = "View evidence";
export const JUDGE_REPLAY_LABEL = "Judge replay";
export const REVIEW_RULE_LABEL = "Review rule";
export const REVIEW_LABEL = "Review";
export const RETRY_LABEL = "Retry";
export const VIEW_LABEL = "View";
export const YOUR_VERDICT_NEEDED_LINE = "Your verdict is needed";

/** "Replay judged: Historical support" -- the pending-suggestion card's own
 * line once a staged test has been judged but the suggestion itself is
 * still open (InboxItem.conclusion). Null (nothing shown) until judged. */
export function replayJudgedLine(
  conclusion: ReplayConclusionLike | null | undefined,
): string | null {
  return conclusion ? `Replay judged: ${CONCLUSION_LABELS[conclusion]}` : null;
}

export const INBOX_RECOMMENDED_ACTION_LABELS: Record<string, string> = {
  add_instruction: PRIMARY_ACTION_LABELS.add,
  review_skill: PRIMARY_ACTION_LABELS.review_skill,
  judge_replay: JUDGE_REPLAY_LABEL,
  review_rule: REVIEW_RULE_LABEL,
  resolve_conflict: REVIEW_LABEL,
  retry: RETRY_LABEL,
  review_disagreement: REVIEW_LABEL,
};

/** The recommended-action button's own label, from the closed set the
 * contract defines -- "View" for a null/unrecognised action rather than an
 * internal enum name. */
export function recommendedActionLabel(action: string | null | undefined): string {
  return (action && INBOX_RECOMMENDED_ACTION_LABELS[action]) || VIEW_LABEL;
}

// actionConsequence (Checkpoint 2 2-B, above) already covers add/
// review_skill/test_first/skip -- these three extend the same closed-set
// convention for the Inbox's other card types, added here rather than
// widening actionConsequence's own PrimaryActionKind union (that stays the
// Knowledge-card add-dialog's own type; a shared file, edited additively).
export type InboxActionKind = "judge_replay" | "review_rule" | "retry";

export function inboxActionConsequence(action: InboxActionKind, retryDoes?: string): string {
  switch (action) {
    case "judge_replay":
      return "Records your verdict. Nothing changes in Lovable. No credits, no AI tokens.";
    case "review_rule":
      return "Opens the rule. Nothing changes until you decide.";
    case "retry":
      return retryDoes ?? "Retries the action that failed. May write to Lovable.";
  }
}

// ---- History: the Inbox-kind filter ----

export type HistoryFilterValue =
  "all" | "suggestions" | "knowledge" | "skills" | "tests" | "restores";

export const HISTORY_FILTER_LABELS: Record<HistoryFilterValue, string> = {
  all: "All activity",
  suggestions: "Suggestions",
  knowledge: "Knowledge",
  skills: "Skills",
  tests: "Tests",
  restores: "Restores",
};

export const HISTORY_FILTER_ORDER: HistoryFilterValue[] = [
  "all",
  "suggestions",
  "knowledge",
  "skills",
  "tests",
  "restores",
];

/** Which History filter bucket a timeline node's own `kind` belongs to.
 * `restored_from` distinguishes a restore (a version node that undid an
 * earlier one) from an ordinary Knowledge write -- both are "knowledge" but
 * a restore is also "restores". */
export function historyFilterBucketsFor(node: {
  kind: "version" | "external_change" | "decision" | "skill" | "verdict" | "test";
  restored_from?: number | null;
}): HistoryFilterValue[] {
  switch (node.kind) {
    case "decision":
      return ["suggestions"];
    case "version":
      return node.restored_from != null ? ["knowledge", "restores"] : ["knowledge"];
    case "external_change":
      return ["knowledge"];
    case "skill":
      return ["skills"];
    case "verdict":
    case "test":
      return ["tests"];
  }
}

/** Whether a timeline node passes the selected History filter -- "all"
 * always passes; every other value matches only the buckets the node's own
 * kind belongs to (see historyFilterBucketsFor). */
export function historyNodeMatchesFilter(
  node: {
    kind: "version" | "external_change" | "decision" | "skill" | "verdict" | "test";
    restored_from?: number | null;
  },
  filter: HistoryFilterValue,
): boolean {
  if (filter === "all") return true;
  return historyFilterBucketsFor(node).includes(filter);
}
// ---- end Checkpoint 3 I2 ----
