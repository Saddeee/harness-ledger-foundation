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
    "Harness Ledger found a signal that this rule may be doing more harm than good. You can retire it, or keep it and be asked again later.",
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
      return `Needs attention: ${input.stale_reason ?? "Knowledge changed in Lovable — review the text again"}`;
    case "failed":
      return "Needs attention: adding failed — see Details";
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
  "Needs attention",
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
  if (input.writeStatus === "stale" || input.writeStatus === "failed") return "Needs attention";
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
    return "Harness Ledger suggests retiring this rule because it has not applied in 60 days.";
  }
  return "Harness Ledger suggests retiring this rule because more of its builds had a repeat correction than didn't.";
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
  return healthLine(input.health) ?? "No builds in this area yet";
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
};

export function healthLine(health: HealthLike | null | undefined): string | null {
  if (!health) return null;
  if (health.applicable_tasks === 0) return "No builds in this area yet";
  const last = health.last_applicable_at
    ? ` · last used ${formatDay(health.last_applicable_at)}`
    : "";
  const builds =
    health.applicable_tasks === 1
      ? "1 build in this area"
      : `${health.applicable_tasks} builds in this area`;
  const corrections =
    health.hurt === 1 ? "1 repeat correction" : `${health.hurt} repeat corrections`;
  return `Since added: ${builds} · ${corrections}${last} · observed from your real builds`;
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

// "Followed in 5 of 6 builds it applied to · judged by AI, with quotes" --
// null (renders nothing) until at least one episode has been judged
// followed or broke (a rule judged not_applicable on every build so far has
// nothing meaningful to report yet).
export function adherenceLine(adherence: AdherenceLike | null | undefined): string | null {
  if (!adherence) return null;
  const total = adherence.followed + adherence.broke;
  if (total === 0) return null;
  return `Followed in ${adherence.followed} of ${total} builds it applied to · judged by AI, with quotes`;
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
  "Creating project copies currently uses no Lovable builder credits. Running a Lovable build inside a copy consumes normal Lovable builder credits.";
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
// correction, then Historical result / Replay with rule, a "Key difference"
// section (Lovable's own summaries, never an invented automatic verdict),
// the per-correction verdict question, a plain-sentence Replay environment
// summary (one row per instruction surface, never a silent fallback), and
// one collapsed "Full technical details" section. ----

export const ORIGINAL_CORRECTION_LABEL = "The original correction";
export const CORRECTIONS_LIST_LABEL = "Then you corrected it";

export const HISTORICAL_RESULT_TITLE = "Historical result";
export const HISTORICAL_RESULT_SUBTITLE =
  "What actually happened, shown through a copy of that commit";
export const REPLAY_WITH_RULE_TITLE = "Replay with rule";
export const REPLAY_WITH_RULE_SUBTITLE =
  "One new Lovable build from the same starting point, with this rule added";

export const KEY_DIFFERENCE_TITLE = "Key difference";
export const KEY_DIFFERENCE_INTRO =
  "Lovable's own account of each build, side by side. Harness Ledger does not compute an automatic verdict on the difference -- that is what the question below is for.";

export const REPLAY_VERDICT_QUESTION =
  "Would the original correction still be needed in the replay?";

export const REPLAY_ENVIRONMENT_TITLE = "Replay environment";
export const NO_ENVIRONMENT_RECORD_LINE = "No environment record for this test.";
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

// The Replay environment section's exact eight rows (docs/audit/replay.md
// §2/§3, DECISIONS.md D2) -- every instruction surface a replay can and
// cannot control, in one place, never a silent fallback.
export function replayEnvironmentRows(
  env: ReplayEnvironmentLike | null | undefined,
): ReplayEnvironmentRow[] {
  if (!env) return [];
  const codeStateText =
    env.code_state.source === "historical_commit_before_request"
      ? "Exact version at the time of the request"
      : "Could not be established; the copy could not be started from the historical commit";
  const otherRules =
    env.other_active_rules.length === 0
      ? "None"
      : env.other_active_rules.join("; ") +
        (env.historical_rules_dropped_by_run
          ? " -- these rules were live at the time but were not in this replay's Knowledge (an older test); newer tests keep them"
          : "");
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
      label: "Candidate rule",
      text: env.candidate_rule.already_present
        ? `${env.candidate_rule.instruction} (already present in the historical Knowledge)`
        : env.candidate_rule.instruction,
    },
    { label: "Other active rules", text: otherRules },
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
