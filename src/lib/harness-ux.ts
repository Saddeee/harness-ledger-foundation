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
    "Lovable missed something you already expected. Harness thinks this should become a standing instruction so it doesn't happen again.",
  preference_revision:
    "You changed how you want this done. Harness thinks the new way should become a standing instruction.",
  missing_requirement:
    "Part of what you needed wasn't in the request. Harness thinks it should become a standing instruction.",
  defect_correction:
    "Lovable made a mistake you had to fix. Harness thinks a standing instruction would prevent it.",
  scope_extension:
    "The request grew beyond its original scope. Harness thinks a standing instruction would set clearer expectations.",
  retire:
    "Harness found a signal that this rule may be doing more harm than good. You can retire it, or keep it and be asked again later.",
};

const WHY_GENERIC =
  "You corrected something Lovable did. Harness thinks it should become a standing instruction.";

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
        return "Connect Lovable on the Projects page to let Harness write this";
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

// ---- Proof copy ----

export const PROVE_INTRO =
  "Harness runs the same request twice in a temporary copy of this project, with and without the instruction, and shows you the difference.";

export function proveCostLine(): string {
  return "Uses Lovable credits like any build; the cost is recorded after the test.";
}

// ---- Onboarding: the only place the product explains itself ----

export const LANDING_INTRO =
  "Harness Ledger keeps your Lovable agent improving. It syncs your project chats on a schedule, finds where you had to correct Lovable, and turns each correction into a rule you approve. Harness writes it into your Lovable Knowledge, keeps every version, and can roll any of them back.";

export const HOW_IT_WORKS_STEPS = [
  {
    title: "Synced",
    text: "Harness reads your Lovable chats and Knowledge every hour. No credits, no AI.",
  },
  {
    title: "Proposed",
    text: "Where you corrected Lovable, Harness's AI analysis proposes one rule, with the exact messages as evidence.",
  },
  {
    title: "Approved by you",
    text: "Add it now, test it first in a temporary copy, or skip. Nothing changes until you say so.",
  },
  {
    title: "Written and versioned",
    text: "Harness writes the exact text you saw, reads it back to verify, and keeps every version so you can always go back.",
  },
] as const;

export const LANDING_CREDITS_LINE =
  "Credits left this month? Spend them on making Lovable better at your project. Syncing chats and writing Knowledge costs nothing. Testing a rule in a temporary copy is a normal Lovable build and uses credits like one; Harness records what each test cost.";

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
  return `Updated by Harness on ${day}.`;
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
  "Harness rewrites your Knowledge without it now. You can re-add it later.";
export const REMOVE_FROM_KNOWLEDGE_CONFIRM_LABEL = "Remove";

// ---- Retirement proposals (Task C2 / spec §4b-§5) ----

export type RetireReason = "hurt" | "contradiction" | "unused";
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
  if (input.reason === "contradiction") {
    const other = (input.contradicts_instruction ?? "another rule").replace(/\.+$/, "");
    return `Harness suggests retiring this rule because it contradicts ${other}.`;
  }
  if (input.reason === "unused") {
    return "Harness suggests retiring this rule because it has not applied in 60 days.";
  }
  return "Harness suggests retiring this rule because more of its builds had a repeat correction than didn't.";
}

// The one-line health summary under a retirement proposal's title -- the
// stats line for "hurt", and a plainer sentence for "contradiction"/"unused"
// where applicable/helped/hurt counts are often all zero and wouldn't read
// as evidence of anything. Fix round 1 item 2: the "hurt" stats line now
// reuses healthLine itself (defined below) rather than its own copy of the
// same counts, so the two can never say different things about the same
// rule -- and, by construction, "helped" never appears here either.
export function retireSinceLine(input: RetireLike): string {
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

export const VERDICT_TEXT: Record<"helped" | "did_not_help" | "not_sure", string> = {
  helped: "helped",
  did_not_help: "didn't help",
  not_sure: "not sure",
};

export type VerdictLike = { verdict: "helped" | "did_not_help" | "not_sure"; created_at: string };

// "You said: helped, 5 Sep" -- replaces the verdict buttons once a verdict
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
    `Observed from your real builds: Harness counts builds in this rule's area and any repeat correction, automatically, for free. ${ranSuffix(s.observed)}`,
    `Your verdict: you can say directly whether a rule helped, didn't help, or you're not sure, any time. ${ranSuffix(s.verdicts)}`,
    `AI adherence check: Harness's AI reads the request and Lovable's reply and says whether the rule was followed, broken, or didn't apply, with a quote. ${ranSuffix(s.adherence)}`,
    // Round 6 Task 6b: paired tests are wired now -- the "not available yet"
    // line was only ever true while Phase B hadn't been built.
    `Paired test: the same request run with and without the rule, side by side, to see the difference directly. ${ranSuffix(s.paired)}`,
  ];
}

// ---- Round 6 Task 6b / spec §6: "Test this rule" -- the confirm dialog's
// exact copy, the card's own status line for a rule's latest paired-test
// run, and the judging screen's confounder lines. Kept here, verbatim, so
// every caller (the card, the Add dialog's "Add and test it first" choice,
// the judging screen) reads the same words. ----

export const TEST_THIS_RULE_TITLE = "Test this rule in a temporary copy?";
export const TEST_THIS_RULE_BODY =
  "Harness copies your project as it was just before your original request, adds this rule to the copy's Knowledge, sends the same request, and shows you both builds side by side. The copy is deleted afterwards.";
export const TEST_THIS_RULE_CREDITS_LINE =
  "Uses Lovable credits like any build; the exact cost is recorded after.";
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
  const n = editsSinceEpisode ?? 0;
  return `This copy started from the project as it was before that request; ${n} edit${n === 1 ? "" : "s"} have landed since.`;
}
export const TEST_ONE_BUILD_LINE = "One build; evidence, not proof.";
// "This test used N credits · measured" / "Cost not reported by Lovable" --
// N always comes from cost_credits (a real, measured Lovable REST response
// field, never a guess), so there is never a hardcoded number next to the
// word "credit" anywhere in this codebase's own source text.
export function testCostLine(costCredits: number | null): string {
  return costCredits == null
    ? "Cost not reported by Lovable"
    : `This test used ${costCredits} credit${costCredits === 1 ? "" : "s"} · measured`;
}
// ---- end Round 6 Task 6b ----
