// Checkpoint 2 WP2-A: the onboarding path (/onboarding) and the Overview
// next-action page (/overview). Pins the onboarding copy verbatim, the step
// order, that each step exposes at most one primary action, the nav order,
// and — the important safety property — that neither page ever leaks an
// internal enum name (health status, experiment status, decision field) to
// a person reading it. overviewNextAction is a pure function, so its
// priority order is tested directly, branch by branch, in the order the
// spec defines it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const copy = await import("../../src/lib/onboarding-copy.ts");

function readApp(rel: string): string {
  return readFileSync(new URL(`../../src/${rel}`, import.meta.url), "utf8");
}
function codeOnly(source: string): string {
  return source
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return (
        !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*") && !t.startsWith("{/*")
      );
    })
    .join("\n");
}

const ROUTE = "routes/_authenticated/route.tsx";
const ONBOARDING = "routes/_authenticated/onboarding.tsx";
const OVERVIEW = "routes/_authenticated/overview.tsx";

// ---- Onboarding copy, verbatim ----

test("onboarding: first-screen sentence, verbatim", () => {
  assert.equal(
    copy.ONBOARDING_INTRO,
    "Manually correct Lovable as usual. Harness Ledger finds reusable lessons and proposes Knowledge or Skills.",
  );
});

test("onboarding: the five step titles, in order", () => {
  assert.deepEqual(
    copy.ONBOARDING_STEPS.map((s) => s.title),
    [
      "Connect Lovable",
      "Choose projects",
      "Choose decision mode",
      "Choose AI provider",
      "Sync and analyse",
    ],
  );
});

test("onboarding: decision-mode explanation and autonomy note, verbatim", () => {
  assert.equal(copy.MODE_ASK_TITLE, "Ask me first");
  assert.equal(copy.MODE_AUTOMATIC_TITLE, "Automatic");
  assert.equal(
    copy.MODE_EXPLANATION,
    "Both modes sync, analyse and recommend. Ask me first waits for approval before persistent or credit-spending actions. Automatic performs only the actions, projects and budgets the user has allowed.",
  );
  assert.equal(
    copy.MODE_AUTONOMY_NOTE,
    "More capable models may improve automation, but autonomy is earned through observed reliability, not assumed from the model name.",
  );
});

test("onboarding: recommended-settings list, verbatim and in order", () => {
  assert.deepEqual(copy.RECOMMENDED_SETTINGS_LIST, [
    "Ask me first",
    "hourly Sync on",
    "automatic analysis after Sync off",
    "no automatic credit-spending tests",
    "only the Harness Ledger block in Knowledge is ever written",
    "your own Knowledge and Skills are never changed",
    "replay budget unchanged",
  ]);
});

test("onboarding: sync/analyse consequence lines match the rest of the app", () => {
  assert.equal(
    copy.SYNC_NOW_CONSEQUENCE,
    "Reads Lovable. Changes nothing. No credits, no AI tokens.",
  );
  assert.equal(copy.ANALYSE_NOW_CONSEQUENCE, "Uses AI tokens. Changes nothing in Lovable.");
});

// ---- Onboarding structure ----

test('onboarding page: one primary action per step, gated on state === "current"', () => {
  const src = readApp(ONBOARDING);
  // Each of the five step components only renders its interactive control
  // (Connect/Save/Sync/Analyse button) once its own state is "current" --
  // an earlier or later step's controls are never live at the same time.
  const gates = src.match(/if \(state !== "current"\)/g) ?? [];
  assert.equal(gates.length, 5, "each of the five steps gates its controls on state==='current'");
  assert.match(src, /RECOMMENDED_SETTINGS_LABEL/);
  assert.match(src, /RECOMMENDED_SETTINGS_LIST\.map/);
  assert.match(src, /SKIP_ONBOARDING_LABEL/);
  assert.match(src, /ADVANCED_PERMISSIONS_LINK_TEXT/);
  assert.match(src, /ONBOARDING_DISMISSED_KEY/);
});

test("onboarding page: connect, projects, mode, provider and sync steps each post the same action their own full page uses", () => {
  const src = readApp(ONBOARDING);
  assert.match(src, /action:\s*"connect"/);
  assert.match(src, /action:\s*"allow"/);
  assert.match(src, /action:\s*"disallow"/);
  assert.match(src, /action:\s*"settings",\s*decision_mode:/s);
  assert.match(src, /action:\s*"llm_key"/);
  assert.match(src, /action:\s*"llm_settings"/);
  assert.match(src, /action:\s*"sync_now"/);
  assert.match(src, /action:\s*"analyse_now"/);
});

// ---- Nav ----

test("nav: Overview is first, and every one of the eight existing pages is kept", () => {
  const shell = codeOnly(readApp(ROUTE));
  const labels = [...shell.matchAll(/label: "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(labels, [
    "Overview",
    "Inbox",
    "Suggestions",
    "Instructions",
    "History",
    "Tests",
    "Skills",
    "Projects",
    "Settings",
  ]);
});

test("route shell: redirects to /onboarding on first use, using both the executor status and a localStorage flag", () => {
  const shell = codeOnly(readApp(ROUTE));
  assert.match(shell, /ONBOARDING_DISMISSED_KEY/);
  assert.match(shell, /connection\?\.connected/);
  assert.match(shell, /to: "\/onboarding", replace: true/);
  assert.match(shell, /location\.pathname === "\/onboarding"/);
});

// ---- No internal enum names in the default view ----

test("overview and onboarding pages never name an internal enum value directly", () => {
  const banned = /retire_suggested|historical_replay|decided_by/;
  assert.ok(!banned.test(readApp(OVERVIEW)), "overview.tsx must not name an internal enum value");
  assert.ok(
    !banned.test(readApp(ONBOARDING)),
    "onboarding.tsx must not name an internal enum value",
  );
});

// ---- Overview: buildOverviewState + overviewNextAction ----

const BASE_STATE: import("../../src/lib/onboarding-copy.ts").OverviewState = {
  connected: true,
  hasAllowedProject: true,
  providerReady: true,
  blockedOrFailedCount: 0,
  pendingSuggestions: 0,
  rulesNeedingAttention: 0,
  skillProposalsPending: 0,
  replaysAwaitingVerdict: 0,
  firstJudgingRunId: null,
  newActivity: false,
};

test("overviewNextAction: not connected takes priority over everything else", () => {
  const action = copy.overviewNextAction({
    ...BASE_STATE,
    connected: false,
    hasAllowedProject: false,
    providerReady: false,
    blockedOrFailedCount: 3,
    pendingSuggestions: 5,
  });
  assert.equal(action.headline, "Connect Lovable to get started.");
  assert.equal(action.actionLabel, "Connect Lovable");
  assert.equal(action.to, "/onboarding");
});

test("overviewNextAction: connected but no allowed project", () => {
  const action = copy.overviewNextAction({ ...BASE_STATE, hasAllowedProject: false });
  assert.equal(action.headline, "Choose the projects Harness Ledger may read.");
  assert.equal(action.to, "/projects");
});

test("overviewNextAction: project allowed but no provider configured", () => {
  const action = copy.overviewNextAction({ ...BASE_STATE, providerReady: false });
  assert.equal(action.headline, "Pick an AI provider so Analyse now can run.");
  assert.equal(action.to, "/settings");
});

test("overviewNextAction: set up, but a blocked/failed write or run needs attention", () => {
  const action = copy.overviewNextAction({ ...BASE_STATE, blockedOrFailedCount: 1 });
  assert.equal(action.headline, "One action needs attention.");
  assert.equal(action.to, "/ledger");
});

test("overviewNextAction: pending suggestions, singular and plural", () => {
  const one = copy.overviewNextAction({ ...BASE_STATE, pendingSuggestions: 1 });
  assert.equal(one.headline, "One suggestion needs your review.");
  assert.equal(one.actionLabel, "Review suggestion");
  assert.equal(one.to, "/inbox");

  const many = copy.overviewNextAction({ ...BASE_STATE, pendingSuggestions: 4 });
  assert.equal(many.headline, "4 suggestions need your review.");
  assert.equal(many.actionLabel, "Review suggestions");
});

test("overviewNextAction: a rule needs attention", () => {
  const action = copy.overviewNextAction({ ...BASE_STATE, rulesNeedingAttention: 1 });
  assert.equal(action.headline, "One rule may need attention.");
  assert.equal(action.to, "/instructions");
});

test("overviewNextAction: a Skill proposal is waiting", () => {
  const action = copy.overviewNextAction({ ...BASE_STATE, skillProposalsPending: 1 });
  assert.equal(action.headline, "One Skill proposal is waiting.");
  assert.equal(action.to, "/skills");
});

test("overviewNextAction: a replay is ready to judge, and links straight to it", () => {
  const action = copy.overviewNextAction({
    ...BASE_STATE,
    replaysAwaitingVerdict: 1,
    firstJudgingRunId: 42,
  });
  assert.equal(action.headline, "One replay is ready to judge.");
  assert.equal(action.to, "/judge?run=42");
});

test("overviewNextAction: replay ready but no run id on hand falls back to /tests", () => {
  const action = copy.overviewNextAction({
    ...BASE_STATE,
    replaysAwaitingVerdict: 1,
    firstJudgingRunId: null,
  });
  assert.equal(action.to, "/tests");
});

test("overviewNextAction: new activity since the last analysis offers Analyse now", () => {
  const action = copy.overviewNextAction({ ...BASE_STATE, newActivity: true });
  assert.equal(action.headline, "New project activity is ready to analyse.");
  assert.equal(action.kind, "analyse_now");
  assert.equal(action.consequence, copy.ANALYSE_NOW_CONSEQUENCE);
});

test("overviewNextAction: fully caught up offers Sync now", () => {
  const action = copy.overviewNextAction(BASE_STATE);
  assert.equal(action.headline, "You're up to date.");
  assert.equal(action.kind, "sync_now");
  assert.equal(action.consequence, copy.SYNC_NOW_CONSEQUENCE);
});

test("overviewMonitorRows: five buckets, each a link, in the state's own counts", () => {
  const rows = copy.overviewMonitorRows({
    ...BASE_STATE,
    pendingSuggestions: 2,
    skillProposalsPending: 1,
    rulesNeedingAttention: 3,
    replaysAwaitingVerdict: 1,
    blockedOrFailedCount: 4,
  });
  assert.deepEqual(rows, [
    { label: "New suggestions", count: 2, to: "/inbox" },
    { label: "Skill proposals", count: 1, to: "/skills" },
    { label: "Rules needing attention", count: 3, to: "/instructions" },
    { label: "Completed replays", count: 1, to: "/tests" },
    { label: "Blocked or failed actions", count: 4, to: "/ledger" },
  ]);
});

// ---- buildOverviewState: the one place enum values are compared ----

test("buildOverviewState: derives every count from the improvements/executor/tests reads", () => {
  const state = copy.buildOverviewState({
    improvements: {
      available: true,
      counts: { pending: 2, retire: 1, auto_accepted_since_seen: 0 },
      improvements: [
        {
          kind: "improvement",
          health: { status: "review" },
          skill_proposal: null,
          lovable: { write_status: "failed" },
        },
        {
          kind: "improvement",
          health: { status: "healthy" },
          skill_proposal: { status: "proposed" },
          lovable: { write_status: "written" },
        },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    executor: {
      available: true,
      connection: { connected: true, email: null, workspaces: [] },
      analysis: {
        last_run: null,
        running: false,
        awaiting_analysis: 3,
        provider_ready: { ok: true },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    testRuns: {
      available: true,
      runs: [
        { id: 9, status: "judging" },
        { id: 10, status: "failed" },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    allowedProjectCount: 2,
  });

  assert.equal(state.connected, true);
  assert.equal(state.hasAllowedProject, true);
  assert.equal(state.providerReady, true);
  assert.equal(state.blockedOrFailedCount, 2); // one failed write + one failed run
  assert.equal(state.pendingSuggestions, 2);
  assert.equal(state.rulesNeedingAttention, 1 + 1); // one "review" item + counts.retire
  assert.equal(state.skillProposalsPending, 1);
  assert.equal(state.replaysAwaitingVerdict, 1);
  assert.equal(state.firstJudgingRunId, 9);
  assert.equal(state.newActivity, true);
});
