// UX round 8 (2026-09-19), Task 5: Tests as a card list; judge page verdict
// first (review item 9). Unit tests for the new pure helper
// (testStatusPhrase) plus structural (text-only) pins on tests.tsx and
// judge.tsx. Same lightweight, dependency-free readApp/codeOnly pattern as
// ux-round8-task1.test.ts / ux-round8-task2.test.ts / ux-round8-task3.test.ts
// / ux-round8-task4.test.ts (kept in its own new file per the global
// constraints).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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

const TESTS_PAGE = "routes/_authenticated/tests.tsx";
const JUDGE = "routes/_authenticated/judge.tsx";

// ---- 1. testStatusPhrase: every status ----

test("harness-ux.ts: testStatusPhrase returns the exact phrase for every status", () => {
  assert.equal(ux.testStatusPhrase({ status: "queued", conclusion: null }), "Building");
  assert.equal(ux.testStatusPhrase({ status: "copying", conclusion: null }), "Building");
  assert.equal(ux.testStatusPhrase({ status: "building", conclusion: null }), "Building");
  assert.equal(
    ux.testStatusPhrase({ status: "judging", conclusion: null }),
    "Waiting for your answer",
  );
  assert.equal(ux.testStatusPhrase({ status: "failed", conclusion: null }), "Failed");
  assert.equal(ux.testStatusPhrase({ status: "cancelled", conclusion: null }), "Cancelled");
});

test("harness-ux.ts: testStatusPhrase for a judged run reads the conclusion label, or 'Judged' with no conclusion on record", () => {
  assert.equal(
    ux.testStatusPhrase({ status: "judged", conclusion: "historical_support" }),
    ux.CONCLUSION_LABELS.historical_support,
  );
  assert.equal(
    ux.testStatusPhrase({ status: "judged", conclusion: "not_supported" }),
    ux.CONCLUSION_LABELS.not_supported,
  );
  assert.equal(
    ux.testStatusPhrase({ status: "judged", conclusion: "possibly_harmful" }),
    ux.CONCLUSION_LABELS.possibly_harmful,
  );
  assert.equal(
    ux.testStatusPhrase({ status: "judged", conclusion: "inconclusive" }),
    ux.CONCLUSION_LABELS.inconclusive,
  );
  assert.equal(ux.testStatusPhrase({ status: "judged", conclusion: null }), "Judged");
  assert.equal(ux.testStatusPhrase({ status: "judged", conclusion: undefined }), "Judged");
});

// ---- 1b. Fix round 1, review item 2: ruleTitle -- a frontend-safe
// equivalent of harness/src/improvements.ts's own titleFor (72-char
// word-boundary truncation, cannot be imported client-side). ----

test("harness-ux.ts: ruleTitle leaves a short sentence unchanged", () => {
  assert.equal(ux.ruleTitle("Use sentence case in headings."), "Use sentence case in headings.");
  assert.equal(ux.ruleTitle(""), "");
  assert.equal(ux.ruleTitle(null), "");
  assert.equal(ux.ruleTitle(undefined), "");
});

test("harness-ux.ts: ruleTitle leaves a long-but-terminated first sentence untouched -- only a run-on with no terminator gets clipped", () => {
  const longSentence =
    "This is a genuinely long first sentence that runs well past seventy two characters on its own before the period lands.";
  assert.ok(longSentence.length > 72);
  const withMore = `${longSentence} And then a second sentence follows after it.`;
  assert.equal(ux.ruleTitle(withMore), longSentence);
});

test("harness-ux.ts: ruleTitle clips a run-on instruction with no sentence terminator at a word boundary, with a trailing ellipsis", () => {
  const runOn =
    "always use sentence case for every heading across the whole project no matter what page or component it lives in and never capitalize every word";
  assert.ok(runOn.length > 72);
  assert.equal(
    ux.ruleTitle(runOn),
    "always use sentence case for every heading across the whole project no…",
  );
});

// ---- 2. tests.tsx: a card list, not a table -- no "Historical replay" ----

test("tests.tsx: is a card list -- no <table, and testStatusPhrase(run) supplies the status line", () => {
  const raw = readApp(TESTS_PAGE);
  const code = codeOnly(raw);
  assert.doesNotMatch(raw, /<table/i, "the 8-column table is gone");
  assert.doesNotMatch(raw, /Historical replay/, "the Kind column's own label text is gone");
  assert.match(code, /<article\b/, "one <article> per run");
  assert.match(code, /testStatusPhrase\(run\)/);
});

test("tests.tsx: a failed run's raw error is never shown inline -- failedSummaryParts splits it into a plain line and a collapsed 'Technical details' fold", () => {
  const code = codeOnly(readApp(TESTS_PAGE));
  assert.match(code, /failedSummaryParts\(run\.error\)/);
  assert.match(code, /Technical details/);
  assert.match(
    code,
    /<details className="rounded-md border">/,
    "no `open` -- collapsed by default",
  );
});

// Round 8 Task 5 fix 2: re-pinned with intent -- the card title now reads
// ruleTitle(run.rule_text) (bounded at 72 chars), not the unbounded
// firstSentence(run.rule_text) the first pass used.
//
// Fix round 2, 2026-09-19 (owner feedback, final demo round): "I don't like
// the Open button" -- the separate "Open" text link is gone, and the whole
// card is now the click target (an onClick on the <article> itself). The
// rule title stays a real <Link to="/judge"> for keyboard access.
test("tests.tsx: the card's own rule title links to /judge, Started/cost line, no separate Open link", () => {
  const code = codeOnly(readApp(TESTS_PAGE));
  assert.match(code, /ruleTitle\(run\.rule_text\)/);
  assert.match(code, /`Started \$\{formatDate\(run\.started_at\)\}`/);
  assert.match(
    code,
    /<Link\s+to="\/judge"\s+search=\{\{\s*run:\s*run\.id\s*\}\}[^>]*>\s*\{ruleTitle\(run\.rule_text\)\}/,
    "the rule title itself is wrapped in the Link to the judging screen",
  );
  assert.doesNotMatch(code, />\s*Open\s*</, "the separate 'Open' text link is gone");
});

// Fix round 2, 2026-09-19: the whole card is the click target -- an
// onClick on the <article> that navigates to /judge, with cursor-pointer,
// and e.stopPropagation() guarding each interactive child so the card
// click doesn't fire underneath a build link, the Technical details fold,
// or the feedback control (same pattern as instructions.tsx's RuleRow).
test("tests.tsx: the whole card is the click target, with stopPropagation on its interactive children", () => {
  const code = codeOnly(readApp(TESTS_PAGE));
  assert.match(
    code,
    /<article\s+onClick=\{\(\)\s*=>\s*navigate\(\{\s*to:\s*"\/judge",\s*search:\s*\{\s*run:\s*run\.id\s*\}\s*\}\)\}/,
  );
  assert.match(code, /className="cursor-pointer[^"]*"/);
  const stopPropagationCount = (code.match(/e\.stopPropagation\(\)/g) ?? []).length;
  assert.ok(
    stopPropagationCount >= 3,
    "build links, the Technical details fold, and the feedback control each guard against the card's own click",
  );
});

// Fix round 2, 2026-09-19: the feedback note spans the card's full width --
// no more max-w-xs, which wrapped it at ~320px inside a 1000px card.
test("tests.tsx: the feedback note is full width -- no max-w-xs anywhere in the file", () => {
  const raw = readApp(TESTS_PAGE);
  assert.doesNotMatch(raw, /max-w-xs/, "max-w-xs is gone from tests.tsx");
});

// Round 8 Task 5 fix 3: buildLinks' two link labels reuse the shared
// HISTORICAL_RESULT_TITLE/REPLAY_WITH_RULE_TITLE constants instead of their
// own separately-worded strings ("Historical result"/"Rebuilt copy").
test("tests.tsx: buildLinks reuses HISTORICAL_RESULT_TITLE/REPLAY_WITH_RULE_TITLE for its own link labels", () => {
  const code = codeOnly(readApp(TESTS_PAGE));
  const buildLinksFn = code.slice(
    code.indexOf("function buildLinks"),
    code.indexOf("function costCell"),
  );
  assert.match(buildLinksFn, /label:\s*HISTORICAL_RESULT_TITLE/);
  assert.match(buildLinksFn, /label:\s*REPLAY_WITH_RULE_TITLE/);
  assert.doesNotMatch(buildLinksFn, /"Historical result"/);
  assert.doesNotMatch(buildLinksFn, /"Rebuilt copy"/);
});

// ---- 3. Renamed labels (harness-ux.ts constants), pinned exactly ----

test("harness-ux.ts: HISTORICAL_RESULT_TITLE/REPLAY_WITH_RULE_TITLE renamed", () => {
  assert.equal(ux.HISTORICAL_RESULT_TITLE, "What Lovable built before");
  assert.equal(ux.REPLAY_WITH_RULE_TITLE, "Rebuilt with the rule");
});

test("harness-ux.ts: evidenceStrengthTitle reads 'How much this shows: ...', with 'An approximation' for historical_approximation", () => {
  assert.equal(
    ux.evidenceStrengthTitle("historical_approximation"),
    "How much this shows: An approximation",
  );
  assert.equal(ux.evidenceStrengthTitle("controlled"), "How much this shows: Controlled");
});

test("harness-ux.ts: conclusionLine reads 'Result: <label>'", () => {
  assert.equal(
    ux.conclusionLine("historical_support"),
    `Result: ${ux.CONCLUSION_LABELS.historical_support}`,
  );
  assert.equal(ux.conclusionLine(null), null);
});

test("harness-ux.ts: WHY_APPROXIMATION_TITLE is unchanged", () => {
  assert.equal(ux.WHY_APPROXIMATION_TITLE, "Why this is an approximation");
});

// Fix round 1, review item 4: conclusionDerivationLines' own "Evidence
// strength: ..." bullet (inside Full technical details' "How the conclusion
// was derived" list) renamed to match evidenceStrengthTitle's own "How much
// this shows: ..." prefix.
test("harness-ux.ts: conclusionDerivationLines' evidence-strength bullet reads 'How much this shows: ...'", () => {
  const lines = ux.conclusionDerivationLines({
    verdicts: ["yes", "no"],
    quality: "historical_approximation",
    regression_flag: false,
  });
  assert.ok(lines.some((l) => l === "How much this shows: An approximation."));
  assert.ok(!lines.some((l) => l.startsWith("Evidence strength:")));
});

test("harness-ux.ts: evidenceSourceLines' fourth sentence reworded from 'Historical replay: ...' to 'Test: ...'", () => {
  const lines = ux.evidenceSourceLines({
    observed: true,
    adherence: true,
    verdicts: true,
    paired: true,
  });
  assert.match(
    lines[3]!,
    /^Test: the original request built again with the rule, next to what Lovable built before\./,
  );
  assert.doesNotMatch(lines[3]!, /Historical replay/);
});

// ---- 4. judge.tsx: the verdict block renders before the build columns ----

test("judge.tsx: the verdict block (REPLAY_VERDICT_QUESTION / testedResultLine) renders before the build columns (HISTORICAL_RESULT_TITLE/REPLAY_WITH_RULE_TITLE) and before ORIGINAL_CORRECTION_LABEL", () => {
  const full = codeOnly(readApp(JUDGE));
  const body = full.slice(full.indexOf("function Page()"), full.indexOf("function BuildColumn"));
  const verdictAt = body.indexOf("REPLAY_VERDICT_QUESTION");
  const testedAt = body.indexOf("testedResultLine(");
  const originalAt = body.indexOf("ORIGINAL_CORRECTION_LABEL");
  const historicalAt = body.indexOf("HISTORICAL_RESULT_TITLE");
  const rebuiltAt = body.indexOf("REPLAY_WITH_RULE_TITLE");
  assert.ok(verdictAt >= 0 && testedAt >= 0 && originalAt >= 0);
  assert.ok(
    testedAt < verdictAt,
    "the judged verdict block sits before the unjudged one, unchanged",
  );
  assert.ok(verdictAt < originalAt, "the verdict block sits before the original correction");
  assert.ok(originalAt < historicalAt && originalAt < rebuiltAt, "then the build columns");
});

test("judge.tsx: renamed HISTORICAL_RESULT_TITLE/REPLAY_WITH_RULE_TITLE still label the build columns", () => {
  const code = codeOnly(readApp(JUDGE));
  assert.match(code, /title=\{HISTORICAL_RESULT_TITLE\}/);
  assert.match(code, /title=\{REPLAY_WITH_RULE_TITLE\}/);
});

// ---- 5. judge.tsx: a failed run's raw error moves under Full technical details ----

test("judge.tsx: FailedLine never shows Lovable's raw error inline -- failedSummaryParts splits it, with the technical half inside the existing Full technical details fold", () => {
  const code = codeOnly(readApp(JUDGE));
  assert.match(code, /failedSummaryParts\(run\.error\)/);
  const failedFn = code.slice(code.indexOf("function FailedLine"), code.indexOf("function Page()"));
  assert.match(failedFn, /testFailedLine\(plain\)/);
  assert.match(failedFn, /<AdvancedDetails title=\{FULL_TECHNICAL_DETAILS_TITLE\}>/);
});
