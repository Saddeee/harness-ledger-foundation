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

// What the local executor knows, for the status line and decision sentence:
// when it next runs, whether Lovable is connected, and whether the user
// chose to test the instruction first. Every field (and the object itself)
// is allowed to be `undefined` explicitly, not just absent -- callers build
// this from optional-chained query data (e.g. `executor.data?.connection`),
// so the value itself, not just the key, is routinely undefined.
export type StatusCtx = {
  nextSyncAt?: string | null | undefined;
  connected?: boolean | undefined;
  testFirst?: boolean | undefined;
  // Round 3 §5: this project's "write approved changes automatically" is
  // off. Callers set this only for project-destination items (a workspace
  // write isn't gated by one project's flag) -- see DecisionCard/DecidedStatus.
  autoWriteOff?: boolean | undefined;
};

// One line describing where the instruction stands in Lovable. Never claims
// it was added unless a verified write exists. `ctx` carries what the local
// executor knows (when it next runs, whether Lovable is connected) and
// whether the user chose to test the instruction first -- all optional, so
// existing single-argument callers keep working unchanged.
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
      return ctx?.nextSyncAt
        ? `Will be written at the next sync, ${formatDate(ctx.nextSyncAt)}`
        : "Will be written at the next sync";
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
  if (input.decision.status === "skipped") return `You skipped this improvement${when}.`;
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

export function proveCostLine(maxCredits: number | null | undefined): string {
  return `Uses up to ${maxCredits ?? 6} Lovable credits.`;
}

// ---- Onboarding: the only place the product explains itself ----

export const LANDING_INTRO =
  "Harness Ledger keeps your Lovable agent improving. It syncs your project chats on a schedule, finds where you had to correct Lovable, and turns each correction into a standing instruction. You approve; Harness writes it into your Lovable Knowledge, keeps every version, and can roll any of them back.";

export const HOW_IT_WORKS_STEPS = [
  {
    title: "Synced",
    text: "Harness reads your Lovable chats and Knowledge every hour. No credits, no AI.",
  },
  {
    title: "Proposed",
    text: "Where you corrected Lovable, Harness proposes one instruction, with the exact messages as evidence.",
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
// wording for a contradiction.
export function retireReasonSentence(input: RetireLike): string {
  if (input.reason === "contradiction") {
    const other = (input.contradicts_instruction ?? "another rule").replace(/\.+$/, "");
    return `Harness suggests retiring this rule because it contradicts ${other}.`;
  }
  if (input.reason === "unused") {
    return "Harness suggests retiring this rule because it has not applied in 60 days.";
  }
  return "Harness suggests retiring this rule because it hurt more than it helped.";
}

// The one-line health summary under a retirement proposal's title -- the
// stats line for "hurt", and a plainer sentence for "contradiction"/"unused"
// where applicable/helped/hurt counts are often all zero and wouldn't read
// as evidence of anything.
export function retireSinceLine(input: RetireLike): string {
  if (input.reason === "contradiction") {
    return "This rule is still live, but a newer rule now says the opposite.";
  }
  if (input.reason === "unused") {
    const since = input.since ? `, ${formatDay(input.since)}` : "";
    return `Since it was added${since}, this rule has not applied to any task in over 60 days.`;
  }
  const last = input.health.last_applicable_at
    ? formatDay(input.health.last_applicable_at)
    : "never";
  return `Since it was added: ${input.health.applicable_tasks} tasks · ${input.health.helped} helped · ${input.health.hurt} repeat corrections · last used ${last}`;
}
