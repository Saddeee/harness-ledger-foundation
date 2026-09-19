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

// Round 8 Task 6 (review item 10): the old seven-item list of internal-
// sounding fragments is replaced with three plain sentences (see
// harness/test/ux-round8-task6.test.ts for the fuller pin).
test("onboarding: recommended-settings list, verbatim and in order", () => {
  assert.deepEqual(copy.RECOMMENDED_SETTINGS_LIST, [
    "Ask before anything is written to Lovable",
    "Check for new chats on a schedule; analyse only when you press Analyse now",
    "Tests run in a copy of your project, never in the project itself",
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

// Round 8 Task 3 (review item 5): Overview merged into the Inbox, so it is
// first now instead of Overview -- seven pages remain.
test("nav: Inbox is first, and every one of the seven remaining pages is kept", () => {
  const shell = codeOnly(readApp(ROUTE));
  const labels = [...shell.matchAll(/label: "([^"]+)"/g)].map((m) => m[1]);
  // Checkpoint 3: Suggestions left the navigation; Inbox is the queue.
  assert.deepEqual(labels, [
    "Inbox",
    "Instructions",
    "Skills",
    "Tests",
    "History",
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
  replaysAwaitingVerdict: 0,
  firstJudgingRunId: null,
  newActivity: false,
  inboxCount: 0,
  inboxTypeCounts: {
    new_instruction: 0,
    new_skill: 0,
    test_result: 0,
    rule_attention: 0,
    conflict: 0,
    action_failed: 0,
  },
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
  assert.equal(action.to, "/inbox");
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
  assert.equal(action.to, "/inbox");
});

test("overviewNextAction: a Skill proposal waiting is one pending suggestion in the Inbox", () => {
  // Checkpoint 3: new_skill items are Inbox items; the Overview counts them
  // with the other suggestions and sends the user to the Inbox.
  const action = copy.overviewNextAction({ ...BASE_STATE, pendingSuggestions: 1 });
  assert.equal(action.headline, "One suggestion needs your review.");
  assert.equal(action.to, "/inbox");
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

// Round 8 Task 3 (review item 5): the "overviewMonitorRows: one row per
// Inbox item type…" test that used to sit here is deleted -- overviewMonitorRows
// and OVERVIEW_MONITOR_TITLE are gone from src/lib/onboarding-copy.ts. The
// six-row Monitor list it covered was a second rendering of exactly the
// counts the Inbox list below it already shows; the Inbox list is the only
// one now.

// ---- buildOverviewState: counts come from the Inbox read, never re-derived ----

test("buildOverviewState: derives every count from the Inbox read, so Overview and Inbox can never disagree", () => {
  const item = (type: string, extra: Record<string, unknown> = {}) => ({
    id: `${type}:1`,
    type,
    project_id: null,
    project_name: null,
    title: "t",
    summary: null,
    created_at: "2026-09-18T00:00:00Z",
    link: { page: "inbox" },
    improvement: null,
    run: null,
    conclusion: null,
    recommended_action: null,
    ...extra,
  });
  const state = copy.buildOverviewState({
    inbox: {
      available: true,
      count: 6,
      items: [
        item("new_instruction"),
        item("new_skill"),
        item("rule_attention"),
        item("test_result", { link: { page: "judge", run_id: 9 } }),
        item("action_failed"),
        item("conflict"),
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
    allowedProjectCount: 2,
  });

  assert.equal(state.connected, true);
  assert.equal(state.hasAllowedProject, true);
  assert.equal(state.providerReady, true);
  assert.equal(state.blockedOrFailedCount, 2); // action_failed + conflict
  assert.equal(state.pendingSuggestions, 2); // new_instruction + new_skill
  assert.equal(state.rulesNeedingAttention, 1);
  assert.equal(state.replaysAwaitingVerdict, 1);
  assert.equal(state.firstJudgingRunId, 9);
  assert.equal(state.newActivity, true);
  assert.equal(state.inboxCount, 6);
  assert.equal(
    Object.values(state.inboxTypeCounts).reduce((a, b) => a + b, 0),
    state.inboxCount,
    "the Overview's buckets add up to the Inbox count",
  );
});
