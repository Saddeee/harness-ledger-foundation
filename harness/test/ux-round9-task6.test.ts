// Round 9 Task 6 (2026-09-20): Tests rows drop links/feedback/notes and open
// Compare builds; the judged/failed page (/judge) is titled "Compare
// builds" with a "← Tests" back link and "Test this instruction" replacing
// "Test this rule". Same lightweight, dependency-free readApp/codeOnly
// pattern as ux-round9-task5.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ux = await import("../../src/lib/harness-ux.ts");

function readApp(rel: string): string {
  return readFileSync(new URL(`../../src/${rel}`, import.meta.url), "utf8");
}
function codeOnly(source: string): string {
  return source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}

const TESTS_PAGE = "routes/_authenticated/tests.tsx";
const JUDGE = "routes/_authenticated/judge.tsx";
const HARNESS_UX = "lib/harness-ux.ts";
const IMPROVEMENT = "components/harness/improvement.tsx";

const ROOT = join(fileURLToPath(new URL("../..", import.meta.url)));
const SRC_TARGETS = ["src/lib", "src/routes", "src/components"];
function srcFiles(path: string): string[] {
  const full = join(ROOT, path);
  if (statSync(full).isFile()) return [full];
  return readdirSync(full, { withFileTypes: true }).flatMap((e) => {
    const p = join(path, e.name);
    if (e.isDirectory()) return srcFiles(p);
    return /\.(ts|tsx)$/.test(e.name) ? [join(ROOT, p)] : [];
  });
}

// ---- 1. The brief's own failing pins ----

test("tests.tsx: no buildLinks, no FeedbackCell, no 'Add feedback'; carries the new intro sentence", () => {
  const raw = readApp(TESTS_PAGE);
  const code = codeOnly(raw);
  assert.ok(!/function buildLinks/.test(code), "buildLinks is gone -- no links inside a row");
  assert.ok(
    !/function FeedbackCell/.test(code),
    "FeedbackCell is gone -- no feedback control in the list",
  );
  assert.ok(!/"Add feedback"/.test(raw), "no 'Add feedback' trigger left on the list");
  // The exact sentence is a harness-ux.ts export (checked in its own test
  // below) -- tests.tsx renders it by reference, not as a re-typed literal.
  assert.match(code, /TESTS_INTRO_LINE/);
});

test("judge.tsx: titled 'Compare builds' (via TEST_A_RULE_PAGE_TITLE) with a '← Tests' back link", () => {
  const code = codeOnly(readApp(JUDGE));
  assert.equal(ux.TEST_A_RULE_PAGE_TITLE, "Compare builds");
  assert.match(code, /TEST_A_RULE_PAGE_TITLE/);
  assert.match(code, /← Tests/);
  assert.match(code, /to="\/tests"/);
});

test("no file under src/ contains 'Test this rule' or 'Historical result' as a string literal", () => {
  const offenders: string[] = [];
  for (const file of SRC_TARGETS.flatMap(srcFiles)) {
    const code = codeOnly(readFileSync(file, "utf8"));
    const literals = code.match(/"[^"\n]*"|`[^`\n]*`|'[^'\n]*'/g) ?? [];
    for (const lit of literals) {
      if (lit.includes("Test this rule") || lit.includes("Historical result")) {
        offenders.push(`${file.replace(ROOT, "")}: ${lit}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `banned string literal(s):\n${offenders.join("\n")}`);
});

// ---- 2. tests.tsx: a row is project / instruction / bold result / started+cost, whole row opens Compare builds ----

test("tests.tsx: TestCard renders project, instruction, a bold result label, and the Started/credits line -- no build links, no feedback, no notes", () => {
  const code = codeOnly(readApp(TESTS_PAGE));
  const cardFn = code.slice(code.indexOf("function TestCard"), code.indexOf("function Page("));
  assert.match(cardFn, /run\.project_name/);
  assert.match(cardFn, /ruleTitle\(run\.rule_text\)/);
  assert.match(cardFn, /className="text-sm font-semibold">\{testStatusPhrase\(run\)\}/);
  assert.match(cardFn, /startedCostLine\(run\)/);
  assert.doesNotMatch(cardFn, /buildLinks\(/);
  assert.doesNotMatch(cardFn, /FeedbackCell/);
  assert.doesNotMatch(cardFn, /run\.feedback/);
  // still keyboard-reachable and opens Compare builds on a whole-row click.
  assert.match(
    cardFn,
    /onClick=\{\(\)\s*=>\s*navigate\(\{\s*to:\s*"\/judge",\s*search:\s*\{\s*run:\s*run\.id\s*\}\s*\}\)\}/,
  );
  assert.match(cardFn, /<Link\s+to="\/judge"\s+search=\{\{\s*run:\s*run\.id\s*\}\}/);
});

test("tests.tsx: a failed row still keeps its collapsed 'Technical details' fold", () => {
  const code = codeOnly(readApp(TESTS_PAGE));
  assert.match(code, /failedSummaryParts\(run\.error\)/);
  assert.match(code, /Technical details/);
  assert.match(code, /<details className="rounded-md border">/);
});

test("tests.tsx: 'Test copies to delete by hand' fold stays", () => {
  const code = codeOnly(readApp(TESTS_PAGE));
  assert.match(code, /Test copies to delete by hand \(\$\{undeletedCopies\.length\}\)/);
});

test("tests.tsx: the new intro sentence lives in harness-ux.ts, not as an inline literal", () => {
  const code = codeOnly(readApp(TESTS_PAGE));
  assert.doesNotMatch(
    code,
    /const INTRO_LINE = `/,
    "the intro sentence is a harness-ux.ts export, not a re-typed template literal",
  );
  const uxCode = codeOnly(readApp(HARNESS_UX));
  assert.match(
    uxCode,
    /Each test rebuilds one of your past requests with the instruction added, next to what Lovable built at the time\. Open a test to compare the two builds and say whether your correction would still be needed\./,
  );
});

test("tests.tsx: the credits budget line stays under the intro", () => {
  const code = codeOnly(readApp(TESTS_PAGE));
  assert.match(code, /testsPageCreditsLine\(/);
});

// ---- 3. judge.tsx: page title region ----

test("judge.tsx: the page title (browser tab and every <h1>) reads TEST_A_RULE_PAGE_TITLE, now 'Compare builds'", () => {
  const code = codeOnly(readApp(JUDGE));
  assert.equal(ux.TEST_A_RULE_PAGE_TITLE, "Compare builds");
  assert.match(code, /title: `\$\{TEST_A_RULE_PAGE_TITLE\} — Harness Ledger`/);
  const h1s =
    code.match(/<h1 className="text-2xl font-semibold">\{TEST_A_RULE_PAGE_TITLE\}<\/h1>/g) ?? [];
  // Round 9 Task 6: the successful-run view now also shows the page title
  // above the instruction (previously only the no-run/loading/error states
  // did) -- one more occurrence than before.
  assert.equal(
    h1s.length,
    4,
    "no test specified / loading / error / judged all show the page title",
  );
  // the instruction itself renders below the title, no longer as the <h1>.
  assert.doesNotMatch(code, /<h1 className="text-2xl font-semibold">\{view\.rule_text\}<\/h1>/);
});

test("judge.tsx: the judged run's RemoveFromKnowledgeConfirm (Retire) and the feedback section stay", () => {
  const code = codeOnly(readApp(JUDGE));
  assert.match(code, /<RemoveFromKnowledgeConfirm\b/);
  assert.match(code, /Your feedback about this test/);
  assert.match(code, /action: "feedback", run_id: runId/);
});

test("judge.tsx: 'Try again' stays for a failed run", () => {
  const code = codeOnly(readApp(JUDGE));
  assert.match(code, /Try again/);
});

// ---- 4. harness-ux.ts: renamed copy constants, by value ----

test("harness-ux.ts: TEST_THIS_RULE_TITLE reads 'Test this instruction'", () => {
  assert.equal(ux.TEST_THIS_RULE_TITLE, "Test this instruction");
});

test("harness-ux.ts: CONCLUSION_LABELS.not_supported says 'instruction', not 'rule'", () => {
  assert.equal(
    ux.CONCLUSION_LABELS.not_supported,
    "Correction still needed, even with the instruction",
  );
});

test("improvement.tsx: TestButton's own fallback trigger is never a raw 'Test this rule' literal", () => {
  const code = codeOnly(readApp(IMPROVEMENT));
  assert.doesNotMatch(code, /"Test this rule"/);
});
