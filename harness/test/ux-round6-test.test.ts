// Round 6 Task 6b / spec §6: structural tests for the paired-test UI --
// "Test this rule"'s own confirm copy on the card, the judging screen, the
// Lovable-credits Settings section, and the client's own route budget.
// Same lightweight, dependency-free readApp/codeOnly pattern as
// ux-round4-retire.test.ts/ux-round6-cards.test.ts (kept in its own file per
// the task instructions).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ux = await import("../../src/lib/harness-ux.ts");

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
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const JUDGE = "routes/_authenticated/judge.tsx";
const TESTS_PAGE = "routes/_authenticated/tests.tsx";
const IMPROVEMENT = "components/harness/improvement.tsx";
const SETTINGS = "components/harness/local-settings.tsx";
const CLIENT = "lib/improvements-client.ts";
const HARNESS_UX = "lib/harness-ux.ts";

// ---- 1. judge.tsx exists with the exact copy and a radiogroup ----

test("judge.tsx: exists, is not in NAV, and carries the exact confounder lines, the back link, and a per-correction radiogroup", () => {
  const raw = readApp(JUDGE);
  const code = codeOnly(raw);

  assert.match(code, /createFileRoute\("\/_authenticated\/judge"\)/);
  assert.match(code, /validateSearch/);

  // Not in NAV -- reached only from a card's own link/result line.
  const navCode = readApp("routes/_authenticated/route.tsx");
  assert.match(codeOnly(navCode), /const NAV = \[/);
  assert.ok(!/\/judge/.test(navCode), "route.tsx's NAV must not link to /judge");

  // Spec §6's own confounder lines, verbatim (testCopyConfounderLine /
  // TEST_ONE_BUILD_LINE, harness-ux.ts).
  assert.match(code, /testCopyConfounderLine/);
  assert.match(code, /TEST_ONE_BUILD_LINE/);
  // Round 7: the copy inherits Lovable's current project memory -- said plainly.
  assert.match(code, /TEST_MEMORY_CONFOUNDER_LINE/);

  // Back link to the suggestion.
  assert.match(code, /← Back to the suggestion/);
  assert.match(code, /to="\/ledger"/);
  assert.match(code, /search=\{\{\s*improvement:\s*view\.improvement_id\s*\}\}/);

  // A radiogroup per correction: "Still needed?" Yes / No / Unclear.
  assert.match(code, /role="radiogroup"/);
  assert.match(code, /Still needed\?/);
  for (const label of ["Yes", "No", "Unclear"]) {
    assert.ok(code.includes(`label: "${label}"`), `missing verdict option "${label}"`);
  }

  // The result line and the cost line, from the shared harness-ux helpers.
  assert.match(code, /testedResultLine/);
  assert.match(code, /testCostLine/);
  assert.match(code, /testFailedLine/);

  // While copying/building: a 10 s refetch driven by the run's own status.
  assert.match(code, /refetchInterval/);
  assert.match(code, /10_000|10000/);

  // Add it now / Remove from Knowledge via the existing action helpers, not
  // a bespoke pair of buttons.
  assert.match(code, /<AddConfirm\b/);
  assert.match(code, /<RemoveFromKnowledgeConfirm\b/);
});

// ---- 2. the card has "Test this rule" and the exact confirm copy ----

test("improvement.tsx: 'Test this rule' offers the exact confirm copy and posts the `test` action", () => {
  const code = codeOnly(readApp(IMPROVEMENT));
  // Checkpoint 2 2-B: TestButton's trigger is now overridable (the Inbox
  // card's own "Test first" primary action reuses this exact button with a
  // different label) -- every OTHER call site still gets the original
  // "Test this rule" text via this same default, rewritten with intent.
  assert.match(code, /trigger=\{trigger \?\? "Test this rule"\}/);
  assert.match(code, /TEST_THIS_RULE_TITLE/);
  assert.match(code, /TEST_THIS_RULE_BODY/);
  assert.match(code, /TEST_THIS_RULE_CREDITS_LINE/);
  assert.match(code, /testThisRuleBudgetLine/);
  assert.match(code, /TEST_ONE_AT_A_TIME_LINE/);
  assert.match(code, /confirmLabel=\{START_TEST_LABEL\}/);
  assert.match(code, /action: "test", id: item\.id, show_original: showOriginal/);

  const uxCode = codeOnly(readApp(HARNESS_UX));
  assert.match(
    uxCode,
    /export const TEST_THIS_RULE_TITLE = "Test this rule in a copy of your project\?";/,
  );
  assert.match(
    uxCode,
    /export const TEST_THIS_RULE_BODY =\s*"Harness Ledger copies your project as it was just before your original request, adds this rule to the copy's Knowledge, and sends the same request\. You get the historical result and the new build side by side as real Lovable projects you can open, compare and keep building on; delete them from the test when you're done\.";/,
  );
  // Checkpoint 2026-09-18 (DECISIONS.md D1/D2): the exact, mandated cost
  // sentence, shared verbatim via COPY_CREDITS_LINE.
  assert.match(
    uxCode,
    /export const COPY_CREDITS_LINE =\s*"Creating project copies currently uses no Lovable builder credits\. Running a Lovable build in a copy consumes normal builder credits\.";/,
  );
  assert.match(
    uxCode,
    /export const TEST_THIS_RULE_CREDITS_LINE = `\$\{COPY_CREDITS_LINE\} The exact cost is recorded after\.`;/,
  );
  assert.match(uxCode, /export const TEST_ONE_AT_A_TIME_LINE = "One test runs at a time\.";/);
  assert.match(uxCode, /export const START_TEST_LABEL = "Start test";/);
  assert.match(
    uxCode,
    /return `This month: \$\{credits\.used_this_month\} credits used of your budget of \$\{credits\.budget\}\.`;/,
  );
});

// ---- 2b. judged/failed status lines are openable, not dead-end text (fix wave item 1) ----

test("improvement.tsx: TestStatusLine links to /judge?run=<id> for judging, judged, and failed -- a judged/failed run is never a dead end", () => {
  const code = codeOnly(readApp(IMPROVEMENT));
  const judgeLinks = code.match(/to="\/judge"/g) ?? [];
  assert.equal(judgeLinks.length, 3, "judging, judged, and failed all link to /judge");
  const runSearch = code.match(/search=\{\{\s*run:\s*run\.id\s*\}\}/g) ?? [];
  assert.equal(runSearch.length, 3);
});

// ---- 3. Settings has "Lovable credits" ----

test("local-settings.tsx: a 'Lovable credits' section with a budget input, a measured used-this-month line, and a keep-copies switch; Evidence's paired checkbox gates on judged_runs", () => {
  const code = codeOnly(readApp(SETTINGS));
  assert.match(code, /Lovable credits/);
  assert.match(code, /lovable_monthly_credit_budget: creditBudget/);
  assert.match(code, /keep_test_copies: keepTestCopies/);
  assert.match(code, /min=\{0\}\s*\n?\s*max=\{1000\}/s);
  // Round 7: builds are kept by default as real projects.
  assert.match(code, /Keep test builds as projects/);
  // Evidence's own paired checkbox: enabled once a judged run exists.
  assert.match(code, /pairedTestsAvailable/);
  assert.match(code, /judged_runs/);
});

// ---- 4. no hardcoded credit number outside a measured template ----

const SRC_ROOT = new URL("../../src", import.meta.url);

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listFiles(full));
    else if (/\.(ts|tsx)$/.test(entry) && entry !== "routeTree.gen.ts") out.push(full);
  }
  return out;
}

test("no digit is ever hardcoded next to 'credit'/'credits' anywhere in src/ -- every number shown is a real, measured value, never typed literally", () => {
  const offenders: string[] = [];
  for (const file of listFiles(SRC_ROOT.pathname)) {
    const source = readFileSync(file, "utf8");
    if (/\d+\s*credits?\b/.test(source)) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});

// ---- 5. the client fetches only the six routes ----

test("improvements-client.ts: fetches only the six local harness routes, template-literal query strings included", () => {
  const code = codeOnly(readApp(CLIENT));
  const targets = [...code.matchAll(/fetch\(\s*[`"]([^`"]*?)(?:\?[^`"]*)?[`"]/g)].map((m) => m[1]);
  assert.ok(targets.length > 0, "expected at least one fetch call");
  for (const t of targets) {
    assert.match(
      t!,
      /^\/api\/public\/harness\/(improvements|runtime|knowledge|executor|projects|skills)$/,
      `unexpected fetch target: ${t}`,
    );
  }
  // fetchExperimentRun's own query-string call is counted above via the
  // template-literal branch of the same regex every other route uses.
  assert.match(code, /fetchExperimentRun/);
});

// ---- 5b. corrections fallback source is surfaced on the judging screen (fix wave item C) ----

test("judge.tsx: shows the follow-up-corrections line when corrections_source is 'follow_ups'", () => {
  const code = codeOnly(readApp(JUDGE));
  assert.match(code, /corrections_source === "follow_ups"/);
  assert.match(code, /CORRECTIONS_FROM_FOLLOW_UPS_LINE/);

  const uxCode = codeOnly(readApp(HARNESS_UX));
  assert.match(
    uxCode,
    /export const CORRECTIONS_FROM_FOLLOW_UPS_LINE = "Corrections taken from your follow-up messages";/,
  );

  const clientCode = codeOnly(readApp(CLIENT));
  assert.match(clientCode, /corrections_source: "classified" \| "follow_ups";/);
});

// ---- 6. TimelineNode.kind has "test" ----

test('TimelineNode.kind gained "test" (Round 6 Task 6b), in both the client type and the harness-side source', () => {
  const clientCode = codeOnly(readApp(CLIENT));
  assert.match(
    clientCode,
    /kind: "version" \| "external_change" \| "decision" \| "skill" \| "verdict" \| "test";/,
  );
  const improvementsSrc = readFileSync(new URL("../src/improvements.ts", import.meta.url), "utf8");
  assert.match(
    codeOnly(improvementsSrc),
    /kind: "version" \| "external_change" \| "decision" \| "skill" \| "verdict" \| "test";/,
  );
});

test("testCopyConfounderLine: an unknown edit count is never shown as 0", async () => {
  const ux = await import("../../src/lib/harness-ux.ts");
  assert.equal(
    ux.testCopyConfounderLine(null),
    "This copy started from the project as it was before that request.",
  );
  assert.match(ux.testCopyConfounderLine(0), /0 edits have landed since\.$/);
  assert.match(ux.testCopyConfounderLine(1), /1 edit has landed since\.$/);
  assert.match(ux.testCopyConfounderLine(3), /3 edits have landed since\.$/);
});

// ---- Checkpoint 2026-09-18 (WP1b, docs/audit/replay.md + ux.md): judge.tsx
// section order, the Replay environment summary, and the banned-word ban.
// Checkpoint 2 2-D renamed "Key difference" -> "Relevant visible difference"
// and "Replay environment" -> "Evidence strength" (section 6, always shown)
// with "Why this is an approximation" collapsed underneath it (section 7) --
// these two pins are updated with that intent, not weakened. ----

// Round 8 Task 5 (review item 9): re-pinned with intent -- the verdict
// block (REPLAY_VERDICT_QUESTION for an unjudged run, testedResultLine for a
// judged one) now renders first, directly under the heading, before the
// original correction section. The rest keeps its previous relative order.
test("judge.tsx: sections appear in the required order -- the verdict block first, then original correction, What Lovable built before / Rebuilt with the rule, Relevant visible difference, How much this shows, Why this is an approximation, Full technical details", () => {
  const full = codeOnly(readApp(JUDGE));
  // Skip the (alphabetized) import block -- order is judged by the JSX
  // returned from Page(), not the order these names happen to be imported.
  const code = full.slice(full.indexOf("function Page()"), full.indexOf("function BuildColumn"));
  const order = [
    "REPLAY_VERDICT_QUESTION",
    "ORIGINAL_CORRECTION_LABEL",
    "HISTORICAL_RESULT_TITLE",
    "REPLAY_WITH_RULE_TITLE",
    "RELEVANT_DIFFERENCE_TITLE",
    "evidenceStrengthTitle(",
    "WHY_APPROXIMATION_TITLE",
    "FULL_TECHNICAL_DETAILS_TITLE",
  ];
  let last = -1;
  for (const marker of order) {
    const at = code.indexOf(marker);
    assert.ok(at >= 0, `missing marker: ${marker}`);
    assert.ok(at > last, `expected "${marker}" after the previous marker (at ${at}, prev ${last})`);
    last = at;
  }
});

test("judge.tsx: shows the request and the correction text(s) as read-only context, separate from the verdict rows", () => {
  const code = codeOnly(readApp(JUDGE));
  assert.match(code, /You asked Lovable/);
  assert.match(code, /CORRECTIONS_LIST_LABEL/);
  assert.match(code, /view\.corrections\.map/);
});

// Round 8 Task 5: re-pinned with intent -- REPLAY_VERDICT_QUESTION now sits
// above RELEVANT_DIFFERENCE_TITLE (the verdict block moved to the top), so
// the section's own end boundary is the next marker after it,
// evidenceStrengthTitle(.
test("judge.tsx: Relevant visible difference shows Lovable's own summary of each side plus a diff toggle each, no invented automatic verdict", () => {
  const full = codeOnly(readApp(JUDGE));
  const body = full.slice(full.indexOf("function Page()"), full.indexOf("function BuildColumn"));
  const section = body.slice(
    body.indexOf("RELEVANT_DIFFERENCE_TITLE"),
    body.indexOf("evidenceStrengthTitle("),
  );
  assert.match(section, /view\.original_summary/);
  assert.match(section, /view\.copy_summary/);
  assert.equal(count(section, "<DiffDetails"), 2, "one diff toggle per side");
});

// Checkpoint 2 2-D: the verdict section's own optional regression checkbox.
// Round 8 Task 5: re-pinned with intent -- the verdict block now sits before
// ORIGINAL_CORRECTION_LABEL (moved to the top of the page), so that is its
// own end boundary now instead of evidenceStrengthTitle(.
test("judge.tsx: the verdict section offers the regression checkbox and saves it with the verdicts", () => {
  const full = codeOnly(readApp(JUDGE));
  const body = full.slice(full.indexOf("function Page()"), full.indexOf("function BuildColumn"));
  const section = body.slice(
    body.indexOf("REPLAY_VERDICT_QUESTION"),
    body.indexOf("ORIGINAL_CORRECTION_LABEL"),
  );
  assert.match(section, /REGRESSION_CHECKBOX_LABEL/);
  assert.match(section, /<Checkbox\b/);
  assert.match(section, /regression/);
  assert.match(full, /action: "judge", run_id: runId!, verdicts: v, regression/);
});

// Checkpoint 2 2-D: section 6 always shows the evidence-strength title and
// sentence; the conclusion line appears only once judged.
test("judge.tsx: Evidence strength shows evidenceStrengthTitle/evidenceStrengthLine and the conclusion line once judged, with 'Why this is an approximation' collapsed underneath", () => {
  const code = codeOnly(readApp(JUDGE));
  assert.match(code, /evidenceStrengthTitle\(view\.environment\.quality\)/);
  assert.match(code, /evidenceStrengthLine\(view\.environment\.quality\)/);
  assert.match(code, /conclusionLine\(view\.conclusion\)/);
  assert.match(code, /<AdvancedDetails title=\{WHY_APPROXIMATION_TITLE\}>/);
});

// Owner review round 7 fix 2 ("if there is a lot of text there should be
// something like see more ... otherwise we take too much place"): BuildColumn
// no longer cuts the summary off for good at 240 characters with no way back
// -- it renders the full summary through ClampedText, which clamps it
// visually and offers "See more" only when it actually overflows. The full
// reply/diff still live only in Full technical details below.
test("judge.tsx: BuildColumn shows the summary via ClampedText (owner review round 7 fix 2 -- no more hard 240-char cutoff); the full reply/diff moved into Full technical details", () => {
  const raw = readApp(JUDGE);
  const code = codeOnly(raw);
  const buildColumnFn = code.slice(code.indexOf("function BuildColumn"));
  assert.match(buildColumnFn, /<ClampedText text=\{summary\}/);
  assert.ok(!/reply:/.test(buildColumnFn) || !/reply,\s*\n\s*diff,/.test(buildColumnFn));
  // Full technical details is the one collapsed <details>, closed by default.
  assert.match(code, /<AdvancedDetails title=\{FULL_TECHNICAL_DETAILS_TITLE\}>/);
  const detailsAt = raw.indexOf("<AdvancedDetails title={FULL_TECHNICAL_DETAILS_TITLE}>");
  assert.ok(detailsAt >= 0);
  assert.match(raw.slice(detailsAt), /view\.original_reply/);
  assert.match(raw.slice(detailsAt), /view\.copy_reply/);
  assert.match(raw.slice(detailsAt), /project_id/);
  assert.match(raw.slice(detailsAt), /request_message_id/);
});

test("judge.tsx: Evidence strength renders replayEnvironmentRows and evidenceStrengthLine, or the no-record line when environment is null", () => {
  const code = codeOnly(readApp(JUDGE));
  assert.match(code, /replayEnvironmentRows\(view\.environment\)/);
  assert.match(code, /evidenceStrengthLine\(view\.environment\.quality\)/);
  assert.match(code, /NO_ENVIRONMENT_RECORD_LINE/);
});

// Checkpoint 2 2-D: replayEnvironmentRows now backs the collapsed "Why this
// is an approximation" section and returns nine rows, not eight -- "Other
// active rules" (a setup fact, not itself a reason this is an
// approximation) moved to otherActiveRulesLine/Full technical details, and
// "Project memory"/"Builder version" were added so every uncontrolled
// surface has its own row instead of only the closing summary. Updated with
// that intent, not weakened -- every row this WP touched is still asserted
// somewhere below, just via the new function for "Other active rules".
test("harness-ux.ts: replayEnvironmentRows returns the exact nine rows, in order, with the spec's own example wording", () => {
  const env = {
    code_state: {
      source: "historical_commit_before_request" as const,
      request_message_id: "msg_1",
    },
    project_knowledge: {
      source: "nearest_earlier_version" as const,
      snapshot_id: 28,
      snapshot_fetched_at: "2026-09-13T19:06:00.000Z",
      episode_started_at: "2026-09-13T19:13:00.000Z",
      char_count: 40,
    },
    workspace_knowledge: { source: "current_uncontrolled" as const },
    skills: { source: "current_uncontrolled" as const },
    chat_history: { included: false },
    candidate_rule: { rule_id: 24, instruction: "Use sentence case.", already_present: false },
    other_active_rules: ["Always show prices in kronor."],
    uncontrolled: [],
    quality: "historical_approximation" as const,
  };
  const rows = ux.replayEnvironmentRows(env);
  assert.deepEqual(
    rows.map((r) => r.label),
    [
      "Code state",
      "Project Knowledge",
      "Workspace Knowledge",
      "Skills",
      "Chat history",
      "Project memory",
      "Candidate rule",
      "Builder version",
      "Uncontrolled context",
    ],
  );
  const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.text]));
  assert.match(byLabel["Project Knowledge"]!, /Nearest earlier version, read 13 Sep 19:06/);
  assert.match(byLabel["Project Knowledge"]!, /before the request/);
  assert.equal(
    byLabel["Workspace Knowledge"],
    "As it is today; Harness Ledger cannot reconstruct the version at the time",
  );
  assert.equal(byLabel["Skills"], "As they are today (workspace Skills apply to the copy)");
  assert.equal(byLabel["Chat history"], "Not copied");
  assert.equal(byLabel["Project memory"], "Lovable's own project memory is copied as it is today");
  assert.equal(byLabel["Builder version"], "Not exposed by Lovable; not recorded");
  assert.match(
    byLabel["Uncontrolled context"]!,
    /Lovable's own project memory, workspace Knowledge, Skills and the builder version come from today/,
  );
  assert.deepEqual(ux.replayEnvironmentRows(null), []);
});

test("harness-ux.ts: replayEnvironmentRows names exact_historical/current_fallback/unavailable Project Knowledge wording and Code state/Chat history variants", () => {
  const base = {
    code_state: { source: "historical_commit_before_request" as const, request_message_id: "m" },
    workspace_knowledge: { source: "current_uncontrolled" as const },
    skills: { source: "current_uncontrolled" as const },
    chat_history: { included: true },
    candidate_rule: { rule_id: 1, instruction: "x", already_present: false },
    other_active_rules: ["rule A"],
    uncontrolled: [],
    quality: "historical_approximation" as const,
  };
  const dropped = ux.replayEnvironmentRows({
    ...base,
    project_knowledge: {
      source: "current_fallback" as const,
      snapshot_id: 1,
      snapshot_fetched_at: "2026-09-13T23:00:00.000Z",
      episode_started_at: null,
      char_count: 0,
    },
    historical_rules_dropped_by_run: true,
  });
  const droppedByLabel = Object.fromEntries(dropped.map((r) => [r.label, r.text]));
  assert.equal(
    droppedByLabel["Project Knowledge"],
    "Today's Knowledge (no version from before the request was on file)",
  );
  assert.equal(droppedByLabel["Chat history"], "Copied");

  const exact = ux.replayEnvironmentRows({
    ...base,
    project_knowledge: {
      source: "exact_historical" as const,
      snapshot_id: 2,
      snapshot_fetched_at: "2026-09-13T19:13:00.000Z",
      episode_started_at: "2026-09-13T19:13:00.000Z",
      char_count: 0,
    },
  });
  assert.equal(
    Object.fromEntries(exact.map((r) => [r.label, r.text]))["Project Knowledge"],
    "Exact version at the time of the request",
  );

  const none = ux.replayEnvironmentRows({
    ...base,
    project_knowledge: {
      source: "unavailable" as const,
      snapshot_id: null,
      snapshot_fetched_at: null,
      episode_started_at: null,
      char_count: 0,
    },
    other_active_rules: [],
    code_state: { source: "unavailable" as const, request_message_id: null },
  });
  const noneByLabel = Object.fromEntries(none.map((r) => [r.label, r.text]));
  assert.equal(
    noneByLabel["Project Knowledge"],
    "None on file; the copy started with empty Knowledge",
  );
  assert.match(noneByLabel["Code state"]!, /Could not be established/);
});

// Checkpoint 2 2-D: "Other active rules" moved out of replayEnvironmentRows
// into its own line (Full technical details) -- otherActiveRulesLine keeps
// exactly the same wording/disclosure the old row carried.
test("harness-ux.ts: otherActiveRulesLine names the kept rules, the older-test disclosure, 'none', and null for no environment", () => {
  assert.equal(
    ux.otherActiveRulesLine({
      other_active_rules: ["rule A"],
      historical_rules_dropped_by_run: true,
    }),
    "Other active rules kept in this replay: rule A -- these rules were live at the time but were not in this replay's Knowledge (an older test); newer tests keep them",
  );
  assert.equal(
    ux.otherActiveRulesLine({ other_active_rules: ["rule A"] }),
    "Other active rules kept in this replay: rule A",
  );
  assert.equal(
    ux.otherActiveRulesLine({ other_active_rules: [] }),
    "Other active rules kept in this replay: none.",
  );
  assert.equal(ux.otherActiveRulesLine(null), null);
  assert.equal(ux.otherActiveRulesLine(undefined), null);
});

// Round 8 Task 5 fix 1: re-pinned with intent -- this sentence renders
// uncollapsed directly under evidenceStrengthTitle's own renamed "How much
// this shows: An approximation" title, so it now opens with "An
// approximation: " instead of the old "Historical approximation: ".
test("harness-ux.ts: evidenceStrengthLine, one sentence per quality, null when there is no quality", () => {
  assert.match(ux.evidenceStrengthLine("historical_approximation")!, /^An approximation:/);
  assert.match(
    ux.evidenceStrengthLine("historical_approximation")!,
    /not that the rule alone caused/,
  );
  assert.equal(
    ux.evidenceStrengthLine("not_comparable"),
    "Not comparable: the historical code state could not be established.",
  );
  assert.equal(ux.evidenceStrengthLine("partially_controlled"), "Partially controlled");
  assert.equal(ux.evidenceStrengthLine("controlled"), "Controlled");
  assert.equal(ux.evidenceStrengthLine(null), null);
});

// Checkpoint 2 2-D: environmentQualityLabel/EXPERIMENT_KIND_LABEL/
// evidenceColumnLabel cover every enum value -- Round 8 Task 5 (review item
// 9) re-pinned with intent: historical_approximation's own label is now "An
// approximation" (evidenceStrengthTitle's "How much this shows: ..." on
// judge.tsx), and tests.tsx's card list no longer renders a Kind/Evidence
// column at all (see ux-round6-tests-page.test.ts item 8) -- the "used by
// tests.tsx" half of this test is removed rather than kept failing.
test("harness-ux.ts: environmentQualityLabel/EXPERIMENT_KIND_LABEL/evidenceColumnLabel cover every enum value", () => {
  assert.equal(ux.environmentQualityLabel("historical_approximation"), "An approximation");
  assert.equal(ux.environmentQualityLabel(null), "—");
  assert.equal(ux.EXPERIMENT_KIND_LABEL.historical_replay, "Historical replay");
  // Round 8 Task 1 item 6: CONCLUSION_LABELS.historical_support was
  // "Historical support" -- now the plain-words "Correction not needed in
  // the rebuilt copy".
  assert.equal(
    ux.evidenceColumnLabel("historical_approximation", "historical_support"),
    "Correction not needed in the rebuilt copy",
  );
  assert.equal(ux.evidenceColumnLabel("historical_approximation", null), "An approximation");
});

test("lib/improvements-client.ts: ExperimentRunView carries kind/environment/conclusion, ExperimentRunSummary carries kind/environment_quality/conclusion", () => {
  const code = codeOnly(readApp(CLIENT));
  const view = code.slice(
    code.indexOf("export type ExperimentRunView"),
    code.indexOf("export type TestBuildCopy"),
  );
  assert.match(view, /kind: ExperimentKind;/);
  assert.match(view, /environment: ReplayEnvironment \| null;/);
  assert.match(view, /conclusion: ReplayConclusion \| null;/);
  const summary = code.slice(
    code.indexOf("export type ExperimentRunSummary"),
    code.indexOf("export type TestRunsResponse"),
  );
  assert.match(summary, /kind: ExperimentKind;/);
  assert.match(summary, /environment_quality: EnvironmentQuality \| null;/);
  assert.match(summary, /conclusion: ReplayConclusion \| null;/);
});

// Checkpoint 2026-09-18 (PLAN.md "Global constraints"): never "paired",
// "proof", "both builds", or unqualified "free" -- in judge.tsx, tests.tsx,
// or the test-related section of harness-ux.ts (checked separately below,
// against the rendered copy rather than the source text -- see that test's
// own comment for why).
//
// judge.tsx and tests.tsx have no "paired"/"proof"/"free" identifiers of
// their own (only imported constant names), so a raw-source scan is safe.
test("no banned words ('paired', 'proof', 'both builds', unqualified 'free') in judge.tsx and tests.tsx", () => {
  const banned: [string, RegExp][] = [
    ["paired", /\bpaired\b/i],
    ["proof", /\bproof\b/i],
    ["both builds", /both builds/i],
    ["unqualified free", /(?<!-)\bfree\b(?!-)/i],
  ];
  for (const rel of [JUDGE, TESTS_PAGE]) {
    const code = codeOnly(readApp(rel));
    for (const [name, re] of banned) {
      assert.ok(!re.test(code), `${rel} still contains the banned word "${name}"`);
    }
  }
});

// harness-ux.ts's test section keeps a `paired` field/identifier (the
// EvidenceSourcesLike source flag -- an internal name, not renamed by this
// WP) and TEST_ONE_BUILD_LINE's own approved, honest "not proof that..."
// disclaimer -- a raw source-text scan would false-positive on both, so
// this checks the actual rendered copy (every exported string constant and
// function output this WP owns) instead of the source text.
test("no banned words in harness-ux.ts's own rendered test-section copy (constants and function outputs, not internal field names)", () => {
  const rendered = [
    ux.TEST_THIS_RULE_TITLE,
    ux.TEST_THIS_RULE_BODY,
    ux.SHOW_ORIGINAL_LABEL,
    ux.SHOW_ORIGINAL_HELP,
    ux.TEST_FIRST_LABEL,
    ux.TEST_FIRST_HELP,
    ux.COPY_CREDITS_LINE,
    ux.TEST_THIS_RULE_CREDITS_LINE,
    ux.TEST_ONE_AT_A_TIME_LINE,
    ux.START_TEST_LABEL,
    ux.TEST_STARTED_TOAST,
    ux.TEST_VERDICT_NEEDED_LABEL,
    ux.TEST_MEMORY_CONFOUNDER_LINE,
    ux.CORRECTIONS_FROM_FOLLOW_UPS_LINE,
    ux.SEE_ON_TESTS_LABEL,
    ux.ORIGINAL_CORRECTION_LABEL,
    ux.CORRECTIONS_LIST_LABEL,
    ux.HISTORICAL_RESULT_TITLE,
    ux.HISTORICAL_RESULT_SUBTITLE,
    ux.REPLAY_WITH_RULE_TITLE,
    ux.REPLAY_WITH_RULE_SUBTITLE,
    ux.RELEVANT_DIFFERENCE_TITLE,
    ux.RELEVANT_DIFFERENCE_INTRO,
    ux.REPLAY_VERDICT_QUESTION,
    ux.REGRESSION_CHECKBOX_LABEL,
    ux.NO_ENVIRONMENT_RECORD_LINE,
    ux.WHY_APPROXIMATION_TITLE,
    ux.FULL_TECHNICAL_DETAILS_TITLE,
    ux.TEST_A_RULE_PAGE_TITLE,
    ...Object.values(ux.EXPERIMENT_KIND_LABEL),
    ...Object.values(ux.ENVIRONMENT_QUALITY_LABEL),
    ...Object.values(ux.CONCLUSION_LABELS),
    ...ux.evidenceSourceLines({ observed: true, adherence: true, verdicts: true, paired: true }),
    ux.testCostLine(3),
    ux.testedResultLine({ score: 0.5, corrections: 2 }),
    ux.testFailedLine("x"),
    ux.testCopyConfounderLine(2),
    ux.proveCostLine(),
    ux.evidenceStrengthLine("historical_approximation"),
    ux.evidenceStrengthLine("not_comparable"),
    ux.evidenceStrengthLine("partially_controlled"),
    ux.evidenceStrengthTitle("historical_approximation"),
    ux.conclusionLine("historical_support"),
    ux.conclusionLine(null),
    ux.evidenceColumnLabel("historical_approximation", "not_supported"),
    ...ux.conclusionDerivationLines({
      verdicts: ["yes", "no", "unclear"],
      quality: "historical_approximation",
      regression_flag: true,
    }),
    ux.otherActiveRulesLine({ other_active_rules: ["rule A"] }),
    ux.evidenceStrengthLine("controlled"),
  ].join("\n");

  for (const [name, re] of [
    ["paired", /\bpaired\b/i],
    ["both builds", /both builds/i],
    ["unqualified free", /(?<!-)\bfree\b(?!-)/i],
  ] as [string, RegExp][]) {
    assert.ok(!re.test(rendered), `harness-ux.ts test-section copy still contains "${name}"`);
  }
  // "proof" is banned everywhere except TEST_ONE_BUILD_LINE's own approved
  // "not proof that..." disclaimer (checked separately, verbatim, below).
  assert.ok(!/\bproof\b/i.test(rendered), 'harness-ux.ts test-section copy still contains "proof"');
  assert.equal(
    ux.TEST_ONE_BUILD_LINE,
    "One replay build; evidence about this correction, not proof that the rule caused the difference.",
  );
});
