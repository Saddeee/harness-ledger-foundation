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
  // Checkpoint 2026-09-18 (WP1b): "judge both builds" is gone -- the second
  // column is a historical result, not a second build. Checkpoint 2 2-D:
  // the intro now opens with DECISIONS.md D1's own product name
  // (TEST_A_RULE_PAGE_TITLE, harness-ux.ts) -- updated with that intent.
  assert.match(code, /TEST_A_RULE_PAGE_TITLE/);
  assert.match(
    code,
    /each test shows your project's historical result at the moment before a real request, next to one new Lovable build made from that same point with a candidate rule added, and lets you say whether the original correction would still be needed\./,
  );
  assert.match(
    code,
    /No tests yet\. Open a suggestion and press "Test this rule"\./,
    "the empty state's exact copy",
  );

  const uxCode = codeOnly(readApp(HARNESS_UX));
  assert.match(
    uxCode,
    /export const TEST_A_RULE_PAGE_TITLE = "Test a rule against a previous correction";/,
  );
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

test("tests.tsx: the table's own Status column uses the exact plain-word phrases (Queued/Copying/Building/Your verdict is needed/Judged:.../Failed:...)", () => {
  const code = codeOnly(readApp(TESTS_PAGE));
  assert.match(code, /"Queued"/);
  assert.match(code, /"Copying"/);
  assert.match(code, /"Building"/);
  assert.match(code, /"Your verdict is needed"/);
  assert.match(code, /`Judged: \$\{no\} of \$\{run\.corrections\} correction/);
  assert.match(code, /`Failed: \$\{run\.error/);
});

test("tests.tsx: every test row opens that test (/judge?run=<id>), never the suggestion -- the owner clicked a test and landed on Suggestions", () => {
  const code = codeOnly(readApp(TESTS_PAGE));
  assert.doesNotMatch(code, /to="\/ledger"/, "the Tests page links to tests, not suggestions");
  assert.match(code, /<Link\s+to="\/judge"\s+search=\{\{\s*run:\s*run\.id\s*\}\}/);
  assert.match(code, /navigate\(\{\s*to:\s*"\/judge",\s*search:\s*\{\s*run:\s*run\.id\s*\}\s*\}\)/);
});

test("tests.tsx: the Cost column reads 'N credits · measured' or '—', never a hardcoded number", () => {
  const code = codeOnly(readApp(TESTS_PAGE));
  assert.match(code, /· measured`/);
  assert.match(code, /"—"/);
  assert.doesNotMatch(readApp(TESTS_PAGE), /\d+\s*credits?\b/);
});

test("tests.tsx: the Feedback column offers 'Add feedback'/'Edit' and 'Save', with the saved note shown as 'Your note, <day>'", () => {
  const code = codeOnly(readApp(TESTS_PAGE));
  assert.match(code, /"Add feedback"/);
  assert.match(code, /"Edit"/);
  assert.match(code, /"Save"/);
  assert.match(code, /`Your note, \$\{formatDay\(run\.feedback_at\)\}`/);
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

test("route.tsx: NAV includes Tests between History and Skills", () => {
  const code = codeOnly(readApp(ROUTE));
  const allItems = code.match(/\{ to: "\/([^"]+)", label: "([^"]+)" \}/g);
  assert.ok(allItems);
  const routes = allItems!.map((item) => item.match(/to: "\/([^"]+)"/)![1]);
  const historyIdx = routes.indexOf("history");
  const testsIdx = routes.indexOf("tests");
  const skillsIdx = routes.indexOf("skills");
  assert.ok(historyIdx >= 0 && testsIdx >= 0 && skillsIdx >= 0);
  assert.equal(testsIdx, historyIdx + 1, "Tests sits immediately after History");
  assert.equal(skillsIdx, testsIdx + 1, "Skills sits immediately after Tests");
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

// ---- 5. the "See on Tests" link on the card's judged/failed status lines ----

test("improvement.tsx: the judged/failed status lines carry a 'See on Tests' link to /tests, plus a /judge?run= link so a judged/failed run can be opened straight from the card", () => {
  const code = codeOnly(readApp(IMPROVEMENT));
  assert.match(code, /SEE_ON_TESTS_LABEL/);
  assert.match(code, /to="\/tests"/);

  const uxCode = codeOnly(readApp(HARNESS_UX));
  assert.match(uxCode, /export const SEE_ON_TESTS_LABEL = "See on Tests";/);

  // judging, judged, and failed all link to /judge?run=<id> -- not just
  // judging (Round 6 fix wave item 1: judged/failed runs were unopenable).
  const judgeLinks = code.match(/to="\/judge"/g) ?? [];
  assert.equal(judgeLinks.length, 3, "judging, judged, and failed all link to /judge");
});

// ---- 6. judge.tsx: the feedback box and both back links ----

test("judge.tsx: has a feedback box ('Your feedback about this test', Save) and both '← Suggestion'/'← Tests' back links", () => {
  const code = codeOnly(readApp(JUDGE));
  assert.match(code, /Your feedback about this test/);
  assert.match(code, /action: "feedback", run_id: runId/);
  assert.match(code, /← Suggestion/);
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

// ---- 8. Checkpoint 2 2-D: Evidence column shows the derived conclusion once judged ----

test("tests.tsx: the Evidence column reads evidenceColumnLabel(quality, conclusion), not the bare quality label", () => {
  const code = codeOnly(readApp(TESTS_PAGE));
  assert.match(code, /evidenceColumnLabel\(run\.environment_quality, run\.conclusion\)/);

  const uxCode = codeOnly(readApp(HARNESS_UX));
  assert.match(uxCode, /export function evidenceColumnLabel\(/);
});

// ---- 9. Checkpoint 2 2-D: judge.tsx's page title is the product name ----

test("judge.tsx: the page title (browser tab and every static <h1>) is DECISIONS.md D1's own product name", () => {
  const code = codeOnly(readApp(JUDGE));
  assert.match(code, /title: `\$\{TEST_A_RULE_PAGE_TITLE\} — Harness Ledger`/);
  const h1s =
    code.match(/<h1 className="text-2xl font-semibold">\{TEST_A_RULE_PAGE_TITLE\}<\/h1>/g) ?? [];
  assert.equal(
    h1s.length,
    3,
    "no test specified / loading / error states all use the product name",
  );
});
