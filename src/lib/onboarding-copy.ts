// Copy and pure state-derivation logic for the onboarding path (/onboarding)
// and the Overview page (/overview) — Checkpoint 2 WP2-A. Every sentence a
// person reads on either page is defined here so it can be pinned verbatim
// by harness/test/ux-onboarding.test.ts, and so the two route files never
// have to compare against a raw internal enum value themselves (health
// status, experiment status, decision values) — that comparison happens
// once, in buildOverviewState below, and the route files only ever render
// the plain-language result.
import type {
  ExecutorResponse,
  ImprovementsResponse,
  TestRunsResponse,
} from "@/lib/improvements-client";

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

export type OverviewState = {
  connected: boolean;
  hasAllowedProject: boolean;
  providerReady: boolean;
  blockedOrFailedCount: number;
  pendingSuggestions: number;
  rulesNeedingAttention: number;
  skillProposalsPending: number;
  replaysAwaitingVerdict: number;
  firstJudgingRunId: number | null;
  newActivity: boolean;
};

/** Turns the three existing reads (improvements list, executor, tests list)
 * plus the allowed-project count (Projects' own read) into the plain
 * booleans/counts overviewNextAction and overviewMonitorRows need. This is
 * the one place any internal enum value (health.status, an experiment's
 * status, a write_status) is compared — src/routes/_authenticated/
 * overview.tsx never does that itself. */
export function buildOverviewState(input: {
  improvements: ImprovementsResponse | undefined;
  executor: ExecutorResponse | undefined;
  testRuns: TestRunsResponse | undefined;
  allowedProjectCount: number | undefined;
}): OverviewState {
  const items = input.improvements?.improvements ?? [];
  const counts = input.improvements?.counts;
  const runs = input.testRuns?.available ? input.testRuns.runs : [];

  const blockedWrites = items.filter((item) => {
    const status = item.lovable?.write_status;
    return status === "stale" || status === "failed";
  }).length;
  const failedRuns = runs.filter((run) => run.status === "failed").length;

  const rulesReview = items.filter(
    (item) =>
      item.kind === "improvement" &&
      (item.health?.status === "review" || item.health?.status === "retire_suggested"),
  ).length;
  const retireProposals = counts?.retire ?? 0;

  const skillsPending = items.filter((item) => item.skill_proposal?.status === "proposed").length;

  const judgingRuns = runs.filter((run) => run.status === "judging");

  return {
    connected: Boolean(input.executor?.connection?.connected),
    hasAllowedProject: (input.allowedProjectCount ?? 0) > 0,
    providerReady: Boolean(input.executor?.analysis?.provider_ready?.ok),
    blockedOrFailedCount: blockedWrites + failedRuns,
    pendingSuggestions: counts?.pending ?? 0,
    rulesNeedingAttention: rulesReview + retireProposals,
    skillProposalsPending: skillsPending,
    replaysAwaitingVerdict: judgingRuns.length,
    firstJudgingRunId: judgingRuns[0]?.id ?? null,
    newActivity: (input.executor?.analysis?.awaiting_analysis ?? 0) > 0,
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
      to: "/ledger",
      consequence: "Opens Suggestions. Nothing changes until you decide there.",
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
      to: "/instructions",
      consequence: "Opens Instructions. Nothing changes until you decide there.",
    };
  }
  if (state.skillProposalsPending > 0) {
    return {
      headline: "One Skill proposal is waiting.",
      actionLabel: "Review Skill",
      kind: "review_skill",
      to: "/skills",
      consequence: "Opens Skills. Nothing changes until you decide there.",
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

export type OverviewMonitorRow = { label: string; count: number; to: string };

export const OVERVIEW_MONITOR_TITLE = "Monitor";
export const OVERVIEW_STATUS_BUDGETS_TITLE = "Status and budgets";

/** The compact counts list under the primary action — same five buckets
 * overviewNextAction checks, always shown regardless of which one is
 * currently primary. */
export function overviewMonitorRows(state: OverviewState): OverviewMonitorRow[] {
  return [
    { label: "New suggestions", count: state.pendingSuggestions, to: "/inbox" },
    { label: "Skill proposals", count: state.skillProposalsPending, to: "/skills" },
    { label: "Rules needing attention", count: state.rulesNeedingAttention, to: "/instructions" },
    { label: "Completed replays", count: state.replaysAwaitingVerdict, to: "/tests" },
    { label: "Blocked or failed actions", count: state.blockedOrFailedCount, to: "/ledger" },
  ];
}
