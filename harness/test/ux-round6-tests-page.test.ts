// Round 6c part B: structural tests for the Tests page (owner's own ask,
// 2026-09-13: "a page dedicated for this so you can see status, and actual
// results, and somewhere we can collect feedback from the user about
// this"). Same lightweight, dependency-free readApp/codeOnly pattern as
// ux-round4-retire.test.ts/ux-round6-test.test.ts (kept in its own file per
// the task instructions -- other tests are being edited concurrently).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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

const TESTS_PAGE = "routes/_authenticated/tests.tsx";
const ROUTE = "routes/_authenticated/route.tsx";
const JUDGE = "routes/_authenticated/judge.tsx";
const CLIENT = "lib/improvements-client.ts";
const HARNESS_UX = "lib/harness-ux.ts";
const IMPROVEMENT = "components/harness/improvement.tsx";

// ---- 1. the route exists, with the exact copy ----

test("tests.tsx: exists, titled 'Tests', with the exact intro line and empty state", () => {
  const raw = readApp(TESTS_PAGE);
  const code = codeOnly(raw);
  assert.match(code, /createFileRoute\("\/_authenticated\/tests"\)/);
  assert.match(code, />Tests</, "the page's own <h1> reads exactly 'Tests'");
  // Round 9 Task 6 / spec §5: the intro no longer opens with
  // TEST_A_RULE_PAGE_TITLE (now judge.tsx's own "Compare builds" page
  // title) -- it has its own exact sentence, TESTS_INTRO_LINE
  // (harness-ux.ts), referenced by name rather than reused as a literal.
  assert.match(code, /TESTS_INTRO_LINE/);
  const uxCode = codeOnly(readApp(HARNESS_UX));
  assert.match(
    uxCode,
    /Each test rebuilds one of your past requests with the instruction added, next to what Lovable built at the time\. Open a test to compare the two builds and say whether your correction would still be needed\./,
  );
  // Round 9 Task 6 / spec §2 vocabulary: the empty state pointed at the
  // card's own "Test this rule" trigger; that trigger is now the shared
  // "Test" label (INSTRUCTION_ACTION_LABELS.test) and "rule" is banned.
  assert.match(
    code,
    /No tests yet\. Open an instruction and press "Test"\./,
    "the empty state's exact copy",
  );

  // Round 9 Task 6: TEST_A_RULE_PAGE_TITLE renamed from "Test a rule
  // against a previous correction" to "Compare builds" -- it is now
  // judge.tsx's own page title alone (see ux-round9-task6.test.ts), not
  // reused by this page's intro.
  assert.match(uxCode, /export const TEST_A_RULE_PAGE_TITLE = "Compare builds";/);
});

test("tests.tsx: shows the unavailable/hosted copy the same way History's own page does", () => {
  const code = codeOnly(readApp(TESTS_PAGE));
  assert.match(code, /available === false/);
  assert.match(code, /Tests are available when Harness Ledger runs on your machine\./);
});

test("tests.tsx: the credits line comes from harness-ux.ts's own testsPageCreditsLine, not a re-typed template", () => {
  const code = codeOnly(readApp(TESTS_PAGE));
  assert.match(code, /testsPageCreditsLine\(/);

  const uxCode = codeOnly(readApp(HARNESS_UX));
  assert.match(
    uxCode,
    /`This month: \$\{credits\.used_this_month\} credits used of your budget of \$\{credits\.budget\} · measured`/,
  );
});

// Round 8 Task 5 (review item 9): the table's own local statusText function
// is gone -- tests.tsx now calls the shared testStatusPhrase(run) from
// harness-ux.ts, whose own exact-phrase pins live in
// ux-round8-task5.test.ts.
test("tests.tsx: each card's status line reads testStatusPhrase(run), the shared helper from harness-ux.ts", () => {
  const code = codeOnly(readApp(TESTS_PAGE));
  assert.match(code, /testStatusPhrase\(run\)/);
});

// Round 8 Task 5: the table row's whole-row click-through is gone -- the
// card list links each card to /judge?run=<id>.
// Fix round 2, 2026-09-19 (owner feedback): the whole card is now the click
// target and the separate "Open" text link is gone -- but the rule title
// stays wrapped in this same <Link to="/judge"> for keyboard access, so
// this assertion still holds.
test("tests.tsx: every test card's rule title links to /judge?run=<id>, never the suggestion -- the owner clicked a test and landed on Suggestions", () => {
  const code = codeOnly(readApp(TESTS_PAGE));
  assert.doesNotMatch(code, /to="\/ledger"/, "the Tests page links to tests, not suggestions");
  assert.match(code, /<Link\s+to="\/judge"\s+search=\{\{\s*run:\s*run\.id\s*\}\}/);
});

test("tests.tsx: the Cost column reads 'N credits · measured' or '—', never a hardcoded number", () => {
  const code = codeOnly(readApp(TESTS_PAGE));
  assert.match(code, /· measured`/);
  assert.match(code, /"—"/);
  assert.doesNotMatch(readApp(TESTS_PAGE), /\d+\s*credits?\b/);
});

// Round 9 Task 6 / spec §5: the Feedback column is gone from the list --
// feedback lives only on Compare builds now (judge.tsx already has "Your
// feedback about this test", pinned by ux-round6-tests-page.test.ts item 6
// below). Re-pinned with intent: this test now asserts the control's
// absence instead of its presence.
test("tests.tsx: no feedback control on the list -- 'Add feedback' and the saved-note paragraph are gone (feedback lives on Compare builds only)", () => {
  const raw = readApp(TESTS_PAGE);
  assert.doesNotMatch(raw, /"Add feedback"/);
  assert.doesNotMatch(raw, /run\.feedback/);
  assert.doesNotMatch(raw, /Your note, /);
});

// ---- 2. the "Test copies to delete by hand" details block lives here now, not on Projects ----

test("tests.tsx: a collapsed <details> lists undeleted test copies when there are any, moved from the Projects page", () => {
  const code = codeOnly(readApp(TESTS_PAGE));
  assert.match(
    code,
    /<details className="rounded-md border">/,
    "no `open` attribute -- collapsed by default",
  );
  assert.match(code, /Test copies to delete by hand \(\$\{undeletedCopies\.length\}\)/);
  assert.match(code, /executor\.data\?\.undeleted_copies/);

  const projectsCode = codeOnly(readApp("components/harness/local-projects.tsx"));
  assert.doesNotMatch(
    projectsCode,
    /Test copies to delete by hand/,
    "moved to Tests, not left duplicated on Projects",
  );
});

// ---- 3. NAV includes Tests, in order, between History and Skills ----

test("route.tsx: NAV includes Tests between Skills and History (checkpoint 3 order)", () => {
  const code = codeOnly(readApp(ROUTE));
  const allItems = code.match(/\{ to: "\/([^"]+)", label: "([^"]+)" \}/g);
  assert.ok(allItems);
  const routes = allItems!.map((item) => item.match(/to: "\/([^"]+)"/)![1]);
  const historyIdx = routes.indexOf("history");
  const testsIdx = routes.indexOf("tests");
  const skillsIdx = routes.indexOf("skills");
  assert.ok(historyIdx >= 0 && testsIdx >= 0 && skillsIdx >= 0);
  assert.equal(testsIdx, skillsIdx + 1, "Tests sits immediately after Skills");
  assert.equal(historyIdx, testsIdx + 1, "History sits immediately after Tests");
});

// ---- 4. the client fetches only the six local harness routes ----

test("improvements-client.ts: fetchTestRuns still fetches only the six local harness routes", () => {
  const code = codeOnly(readApp(CLIENT));
  assert.match(code, /fetchTestRuns/);
  const targets = [...code.matchAll(/fetch\(\s*[`"]([^`"]*?)(?:\?[^`"]*)?[`"]/g)].map((m) => m[1]);
  assert.ok(targets.length > 0);
  for (const t of targets) {
    assert.match(
      t!,
      /^\/api\/public\/harness\/(improvements|runtime|knowledge|executor|projects|skills)$/,
      `unexpected fetch target: ${t}`,
    );
  }
});

// ---- 5. the "Open Tests" link on the card's judged/failed status lines ----

test("improvement.tsx: the judged/failed status lines carry an 'Open Tests' link to /tests, plus a /judge?run= link so a judged/failed run can be opened straight from the card", () => {
  const code = codeOnly(readApp(IMPROVEMENT));
  assert.match(code, /SEE_ON_TESTS_LABEL/);
  assert.match(code, /to="\/tests"/);

  const uxCode = codeOnly(readApp(HARNESS_UX));
  // Round 9 Task 3 / spec §2 vocabulary: "See on Tests" is banned
  // navigation wording -- renamed to "Open Tests", same constant name.
  assert.match(uxCode, /export const SEE_ON_TESTS_LABEL = "Open Tests";/);

  // judging, judged, and failed all link to /judge?run=<id> -- not just
  // judging (Round 6 fix wave item 1: judged/failed runs were unopenable).
  // Round 9 Task 3: InstructionActions gained its own "judge" action, a
  // fourth to="/judge" link (its own runId, not TestStatusLine's run.id) --
  // the three TestStatusLine links (judging/judged/failed) are unchanged.
  // Round 9 Task 4: the detail page's new Evidence section adds a fifth link
  // of its own ("Open Compare builds", testRun.id).
  // Round 9 final wave item 5: CompactDecisionCard's own inline judged-run
  // line adds a sixth "Open Compare builds" link (item.test.run.id) instead
  // of always delegating to TestStatusLine, so a judged suggestion's result
  // is never described twice on the Inbox card.
  const judgeLinks = code.match(/to="\/judge"/g) ?? [];
  assert.equal(
    judgeLinks.length,
    6,
    "judging, judged, and failed link to /judge, plus InstructionActions', Evidence's, and CompactDecisionCard's own",
  );
});

// ---- 6. judge.tsx: the feedback box and both back links ----

test("judge.tsx: has a feedback box ('Your feedback about this test', Save) and both '← Suggestion'/'← Tests' back links", () => {
  const code = codeOnly(readApp(JUDGE));
  assert.match(code, /Your feedback about this test/);
  assert.match(code, /action: "feedback", run_id: runId/);
  assert.match(code, /← Back to the suggestion/);
  assert.match(code, /← Tests/);
  assert.match(code, /to="\/tests"/);
});

// ---- 7. no digit is ever hardcoded next to 'credit'/'credits' on the Tests page or judge.tsx ----

test("tests.tsx and judge.tsx never hardcode a digit next to 'credit'/'credits'", () => {
  for (const rel of [TESTS_PAGE, JUDGE]) {
    const source = readApp(rel);
    assert.doesNotMatch(source, /\d+\s*credits?\b/, `${rel} has a hardcoded credits number`);
  }
});

// ---- 8. Round 8 Task 5 (review item 9): the Evidence/Kind columns are gone
// from the card list -- evidenceColumnLabel still exists (and is still
// pinned by its own unit tests) but tests.tsx no longer calls it; a judged
// run's own conclusion is already the card's status phrase instead. ----

test("tests.tsx: the card list no longer renders a separate Evidence/Kind column -- evidenceColumnLabel/EXPERIMENT_KIND_LABEL stay exported and tested elsewhere but tests.tsx has no import of either", () => {
  const code = codeOnly(readApp(TESTS_PAGE));
  assert.doesNotMatch(code, /evidenceColumnLabel\(/);
  assert.doesNotMatch(code, /EXPERIMENT_KIND_LABEL/);

  const uxCode = codeOnly(readApp(HARNESS_UX));
  assert.match(uxCode, /export function evidenceColumnLabel\(/);
});

// ---- 9. Checkpoint 2 2-D: judge.tsx's page title is the product name ----

test("judge.tsx: the page title (browser tab and every static <h1>) is 'Compare builds' (TEST_A_RULE_PAGE_TITLE)", () => {
  const code = codeOnly(readApp(JUDGE));
  assert.match(code, /title: `\$\{TEST_A_RULE_PAGE_TITLE\} — Harness Ledger`/);
  const h1s =
    code.match(/<h1 className="text-2xl font-semibold">\{TEST_A_RULE_PAGE_TITLE\}<\/h1>/g) ?? [];
  // Round 9 Task 6 / spec §5: the successful-run view now also shows
  // "Compare builds" above the instruction (previously only the no-run/
  // loading/error states did) -- one more occurrence than before.
  assert.equal(
    h1s.length,
    4,
    "no test specified / loading / error / judged states all show the page title",
  );
});
