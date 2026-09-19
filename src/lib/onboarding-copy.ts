// Copy and pure state-derivation logic for the onboarding path (/onboarding)
// and the Overview page (/overview) — Checkpoint 2 WP2-A. Every sentence a
// person reads on either page is defined here so it can be pinned verbatim
// by harness/test/ux-onboarding.test.ts, and so the two route files never
// have to compare against a raw internal enum value themselves (health
// status, experiment status, decision values) — that comparison happens
// once, in buildOverviewState below, and the route files only ever render
// the plain-language result.
import type { ExecutorResponse, InboxItemType, InboxResponse } from "./improvements-client";

// ---- Shared ----

// Set by the "Skip onboarding" link and checked by route.tsx's first-use
// redirect, alongside the executor's own connection status — either one
// (already connected, or already dismissed once) is enough to stop
// redirecting a returning user back to /onboarding.
export const ONBOARDING_DISMISSED_KEY = "harness-onboarding-dismissed";

// ---- Onboarding (/onboarding) ----

export const ONBOARDING_INTRO =
  "Manually correct Lovable as usual. Harness Ledger finds reusable lessons and proposes Knowledge or Skills.";

export type OnboardingStepId = "connect" | "projects" | "mode" | "provider" | "sync";

export const ONBOARDING_STEPS: { id: OnboardingStepId; title: string }[] = [
  { id: "connect", title: "Connect Lovable" },
  { id: "projects", title: "Choose projects" },
  { id: "mode", title: "Choose decision mode" },
  { id: "provider", title: "Choose AI provider" },
  { id: "sync", title: "Sync and analyse" },
];

export const CHOOSE_ON_PROJECTS_LABEL = "Choose on Projects";

// ---- Step 3: decision mode ----

export const MODE_ASK_TITLE = "Ask me first";
export const MODE_AUTOMATIC_TITLE = "Automatic";
export const MODE_EXPLANATION =
  "Both modes sync, analyse and recommend. Ask me first waits for approval before persistent or credit-spending actions. Automatic performs only the actions, projects and budgets the user has allowed.";
export const MODE_AUTONOMY_NOTE =
  "More capable models may improve automation, but autonomy is earned through observed reliability, not assumed from the model name.";

// ---- Recommended settings ----

export const RECOMMENDED_SETTINGS_LABEL = "Use recommended settings";
// Verbatim, in this order — joined with "; " it reads as one sentence; kept
// as an array so the onboarding page can render it as a plain list.
export const RECOMMENDED_SETTINGS_LIST = [
  "Ask me first",
  "hourly Sync on",
  "automatic analysis after Sync off",
  "no automatic credit-spending tests",
  "only the Harness Ledger block in Knowledge is ever written",
  "your own Knowledge and Skills are never changed",
  "replay budget unchanged",
] as const;
export const ADVANCED_PERMISSIONS_LINK_TEXT = "Advanced permissions are in Settings";
export const SKIP_ONBOARDING_LABEL = "Skip onboarding";

// ---- Step 5: sync and analyse ----

export const SYNC_NOW_CONSEQUENCE = "Reads Lovable. Changes nothing. No credits, no AI tokens.";
export const ANALYSE_NOW_CONSEQUENCE = "Uses AI tokens. Changes nothing in Lovable.";

// ---- Overview (/overview) ----
// Checkpoint 3 I2: the Inbox is now the single decision queue, so Overview
// reads the exact same fetchInbox() the Inbox page reads (one read, per the
// brief) rather than re-deriving its own counts from the raw improvements/
// test-runs lists -- that guarantees Overview's "N decisions" always equals
// the Inbox's own count line, by construction, not by two pieces of logic
// agreeing.

export type OverviewState = {
  connected: boolean;
  hasAllowedProject: boolean;
  providerReady: boolean;
  // "failed actions" (brief §7): action_failed items, plus conflicts -- both
  // are things gone wrong that need a decision now, same priority as before.
  blockedOrFailedCount: number;
  // "suggestions": new_instruction + new_skill Inbox items (a "both"
  // suggestion is the one new_instruction item the contract already folds
  // it into -- never counted twice).
  pendingSuggestions: number;
  // "rules needing attention": rule_attention Inbox items (open retire
  // proposals and live rules whose health asks for review, already merged
  // by listInboxItems).
  rulesNeedingAttention: number;
  // "replays to judge": test_result Inbox items.
  replaysAwaitingVerdict: number;
  firstJudgingRunId: number | null;
  newActivity: boolean;
  // The Inbox's own server-computed count, read once here and shown
  // verbatim -- never recomputed from the buckets above (their sum can
  // differ from inboxCount only if listInboxItems ever adds a type this
  // file doesn't bucket individually; inboxCount is always the ground truth).
  inboxCount: number;
  // Monitor rows: one count per Inbox item type, in the contract's own order.
  inboxTypeCounts: Record<InboxItemType, number>;
};

const INBOX_TYPE_ORDER: InboxItemType[] = [
  "action_failed",
  "conflict",
  "test_result",
  "rule_attention",
  "new_instruction",
  "new_skill",
];

/** Turns the Inbox read (fetchInbox) plus the executor status and the
 * allowed-project count (Projects' own read) into the plain booleans/counts
 * overviewNextAction needs. This is the one place any Inbox item type is
 * switched on for this purpose -- src/routes/_authenticated/inbox.tsx never
 * does that itself. */
export function buildOverviewState(input: {
  inbox: InboxResponse | undefined;
  executor: ExecutorResponse | undefined;
  allowedProjectCount: number | undefined;
}): OverviewState {
  const available = input.inbox != null && input.inbox.available !== false;
  const items = available ? (input.inbox!.items ?? []) : [];
  const inboxCount = available ? (input.inbox!.count ?? 0) : 0;

  const inboxTypeCounts = Object.fromEntries(
    INBOX_TYPE_ORDER.map((t) => [t, items.filter((i) => i.type === t).length]),
  ) as Record<InboxItemType, number>;

  const testResultItems = items.filter((i) => i.type === "test_result");
  const firstJudgingRunId = testResultItems[0]?.run?.id ?? testResultItems[0]?.link.run_id ?? null;

  return {
    connected: Boolean(input.executor?.connection?.connected),
    hasAllowedProject: (input.allowedProjectCount ?? 0) > 0,
    providerReady: Boolean(input.executor?.analysis?.provider_ready?.ok),
    blockedOrFailedCount: inboxTypeCounts.action_failed + inboxTypeCounts.conflict,
    pendingSuggestions: inboxTypeCounts.new_instruction + inboxTypeCounts.new_skill,
    rulesNeedingAttention: inboxTypeCounts.rule_attention,
    replaysAwaitingVerdict: inboxTypeCounts.test_result,
    firstJudgingRunId,
    newActivity: (input.executor?.analysis?.awaiting_analysis ?? 0) > 0,
    inboxCount,
    inboxTypeCounts,
  };
}

export type OverviewActionKind =
  | "connect"
  | "choose_projects"
  | "choose_provider"
  | "review_blocked"
  | "review_suggestions"
  | "review_rules"
  | "review_skill"
  | "judge_replay"
  | "analyse_now"
  | "sync_now";

export type OverviewNextAction = {
  headline: string;
  actionLabel: string;
  kind: OverviewActionKind;
  // "" for the two inline-button actions (analyse_now / sync_now) — every
  // other kind navigates.
  to: string;
  consequence: string;
};

export const OVERVIEW_UP_TO_DATE_HEADLINE = "You're up to date.";

/** The single next action Overview offers, in priority order. Pure and
 * order-sensitive: each branch below is unit-tested independently in
 * harness/test/ux-onboarding.test.ts. */
export function overviewNextAction(state: OverviewState): OverviewNextAction {
  if (!state.connected) {
    return {
      headline: "Connect Lovable to get started.",
      actionLabel: "Connect Lovable",
      kind: "connect",
      to: "/onboarding",
      consequence: "Opens onboarding. Nothing changes in Lovable until you connect there.",
    };
  }
  if (!state.hasAllowedProject) {
    return {
      headline: "Choose the projects Harness Ledger may read.",
      actionLabel: "Choose projects",
      kind: "choose_projects",
      to: "/projects",
      consequence: "Opens Projects. Nothing changes until you choose there.",
    };
  }
  if (!state.providerReady) {
    return {
      headline: "Pick an AI provider so Analyse now can run.",
      actionLabel: "Choose provider",
      kind: "choose_provider",
      to: "/settings",
      consequence: "Opens Settings. No AI tokens are used until you save a provider there.",
    };
  }
  if (state.blockedOrFailedCount > 0) {
    return {
      headline: "One action needs attention.",
      actionLabel: "Review",
      kind: "review_blocked",
      to: "/inbox",
      consequence: "Opens Inbox. Nothing changes until you decide there.",
    };
  }
  if (state.pendingSuggestions > 0) {
    const n = state.pendingSuggestions;
    return {
      headline:
        n === 1 ? "One suggestion needs your review." : `${n} suggestions need your review.`,
      actionLabel: n === 1 ? "Review suggestion" : "Review suggestions",
      kind: "review_suggestions",
      to: "/inbox",
      consequence: "Opens Inbox. Nothing changes until you decide there.",
    };
  }
  if (state.rulesNeedingAttention > 0) {
    return {
      headline: "One rule may need attention.",
      actionLabel: "Review rule",
      kind: "review_rules",
      to: "/inbox",
      consequence: "Opens Inbox. Nothing changes until you decide there.",
    };
  }
  if (state.replaysAwaitingVerdict > 0) {
    return {
      headline: "One replay is ready to judge.",
      actionLabel: "Judge replay",
      kind: "judge_replay",
      to: state.firstJudgingRunId != null ? `/judge?run=${state.firstJudgingRunId}` : "/tests",
      consequence: "Opens the replay. Nothing changes until you record a verdict.",
    };
  }
  if (state.newActivity) {
    return {
      headline: "New project activity is ready to analyse.",
      actionLabel: "Analyse now",
      kind: "analyse_now",
      to: "",
      consequence: ANALYSE_NOW_CONSEQUENCE,
    };
  }
  return {
    headline: OVERVIEW_UP_TO_DATE_HEADLINE,
    actionLabel: "Sync now",
    kind: "sync_now",
    to: "",
    consequence: SYNC_NOW_CONSEQUENCE,
  };
}

export const OVERVIEW_STATUS_BUDGETS_TITLE = "Status and budgets";

// Round 8 Task 3 (review item 5): the six-row "Monitor" list
// (OverviewMonitorRow / OVERVIEW_MONITOR_TITLE / overviewMonitorRows) is
// deleted here, along with its tests in harness/test/ux-onboarding.test.ts.
// Overview merged into the Inbox, and the Inbox list itself is now the only
// place those per-type counts are worked through -- a second list of the
// same counts, one page up, was the thing being removed.
