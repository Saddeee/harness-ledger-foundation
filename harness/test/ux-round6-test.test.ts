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
  assert.match(code, /←\s*Suggestion/);
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
  assert.match(code, /trigger="Test this rule"/);
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
    /export const TEST_THIS_RULE_BODY =\s*"Harness Ledger copies your project as it was just before your original request, adds this rule to the copy's Knowledge, and sends the same request\. You get both builds side by side as real Lovable projects you can open, compare and keep building on; delete them from the test when you're done\.";/,
  );
  assert.match(
    uxCode,
    /export const TEST_THIS_RULE_CREDITS_LINE =\s*"Uses Lovable credits like any build; the exact cost is recorded after\.";/,
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
