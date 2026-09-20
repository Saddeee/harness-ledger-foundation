// Round 9 final wave (2026-09-20): pins for the whole-branch review's
// remaining items (1-9), applied on top of the seven already-committed
// Round 9 tasks. Same lightweight, dependency-free readApp/codeOnly/slice
// pattern as ux-round9-task3.test.ts / ux-round9-task4.test.ts /
// ux-round9-task5.test.ts. harness/src/improvements.ts (item 9, backend
// copy) is read directly by raw text, the same convention ux-naming.test.ts
// uses for scanning that file's own user-facing strings.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ux = await import("../../src/lib/harness-ux.ts");

function readApp(rel: string): string {
  return readFileSync(new URL(`../../src/${rel}`, import.meta.url), "utf8");
}
function readHarness(rel: string): string {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}
function codeOnly(source: string): string {
  return source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}
function slice(code: string, start: string, end: string): string {
  const a = code.indexOf(start);
  assert.ok(a >= 0, `missing marker: ${start}`);
  const b = code.indexOf(end, a);
  assert.ok(b > a, `missing marker after ${start}: ${end}`);
  return code.slice(a, b);
}
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const IMPROVEMENT = "components/harness/improvement.tsx";
const HARNESS_UX = "lib/harness-ux.ts";

// ---- Item 1: the leak detector's comment stripper no longer opens a
// phantom block comment on a `//` line containing an unbalanced "/*", and
// the three real hits it found (LANDING_INTRO, HOW_IT_WORKS_STEPS[1].text,
// LANDING_CREDITS_LINE) say "instruction", not "rule". ----

test("harness-ux.ts: LANDING_INTRO, HOW_IT_WORKS_STEPS[1].text, and LANDING_CREDITS_LINE say 'instruction', never 'rule' -- the leak detector's own new hit list, fixed", () => {
  assert.match(ux.LANDING_INTRO, /an instruction you approve/);
  assert.doesNotMatch(ux.LANDING_INTRO, /\brules?\b/i);
  assert.match(ux.HOW_IT_WORKS_STEPS[1]!.text, /proposes one instruction/);
  assert.doesNotMatch(ux.HOW_IT_WORKS_STEPS[1]!.text, /\brules?\b/i);
  assert.match(ux.LANDING_CREDITS_LINE, /Testing an instruction in a temporary copy/);
  assert.doesNotMatch(ux.LANDING_CREDITS_LINE, /\brules?\b/i);
});

// ---- Item 2: retireReasonSentence / retireSinceLine say "instruction", not
// "rule", for every reason. ----

test("harness-ux.ts: retireReasonSentence and retireSinceLine say 'instruction', never 'rule', for every reason", () => {
  const base = {
    health: { applicable_tasks: 0, helped: 0, hurt: 0, last_applicable_at: null },
    since: null,
  };
  const reasonSentences = [
    ux.retireReasonSentence({ ...base, reason: "changed_mind" }),
    ux.retireReasonSentence({
      ...base,
      reason: "contradiction",
      contradicts_instruction: "Always use dark mode by default.",
    }),
    ux.retireReasonSentence({ ...base, reason: "unused" }),
  ];
  const sinceLines = [
    ux.retireSinceLine({ ...base, reason: "changed_mind" }),
    ux.retireSinceLine({ ...base, reason: "contradiction" }),
    ux.retireSinceLine({ ...base, reason: "unused", since: "2026-01-01T00:00:00Z" }),
  ];
  for (const line of [...reasonSentences, ...sinceLines]) {
    assert.doesNotMatch(line, /\brules?\b/i, `leaked "rule": ${line}`);
  }
  assert.match(
    ux.retireReasonSentence({
      ...base,
      reason: "contradiction",
      contradicts_instruction: "Always use dark mode by default.",
    }),
    /retiring this instruction because it contradicts/,
  );
  assert.match(
    ux.retireSinceLine({ ...base, reason: "contradiction" }),
    /This instruction is still live, but a newer instruction now says the opposite\./,
  );
});

// ---- Item 3: DecidedStatus's sentence is suppressed once write_status is
// "written" (the state line already says "In Lovable since …"); Undo stays
// reachable off canUndo alone. ----

test("improvement.tsx: DecidedStatus takes hideSentence, suppresses decisionSentence when set, but Undo renders off canUndo regardless", () => {
  const code = codeOnly(readApp(IMPROVEMENT));
  const fn = slice(code, "function DecidedStatus", "export function DecisionCard");
  assert.match(fn, /hideSentence\?:\s*boolean/);
  assert.match(fn, /if \(hideSentence && !canUndo\) return null;/);
  assert.match(fn, /hideSentence \? null : \(/);
  // Undo's own conditional (canUndo ? (...) : null) is untouched by
  // hideSentence -- it's a sibling, not nested inside the sentence branch.
  const undoIdx = fn.indexOf("canUndo ? (");
  const hideIdx = fn.indexOf("hideSentence ? null : (");
  assert.ok(undoIdx > hideIdx, "Undo's own branch comes after the sentence branch, not inside it");
});

test('improvement.tsx: the detail page\'s own DecidedStatus call passes hideSentence keyed off write_status === "written"', () => {
  const code = codeOnly(readApp(IMPROVEMENT));
  assert.match(
    code,
    /<DecidedStatus\s+item=\{item\}\s+busy=\{busy\}\s+run=\{run\}\s+ctx=\{ctx\}\s+hideSentence=\{lovableOf\(item\)\.write_status === "written"\}/,
  );
});

// ---- Item 4: "Changed afterward" omitted when null/empty/whitespace, and
// when Built already contains it as a prefix or exactly -- never "Not
// recorded" for this field. ----

test("improvement.tsx: 'Changed afterward' is omitted when empty/whitespace or already a prefix of Built, never 'Not recorded'", () => {
  const code = codeOnly(readApp(IMPROVEMENT));
  const section = slice(code, "What happened", "{WHY_RECOMMENDS_TITLE}");
  assert.match(
    section,
    /changedAfterwardText\.length > 0 && !builtText\.startsWith\(changedAfterwardText\)/,
  );
  const changedAfterwardBlock = section.slice(section.indexOf("Changed afterward"));
  assert.ok(
    !/"Not recorded"/.test(changedAfterwardBlock),
    "no 'Not recorded' fallback for Changed afterward",
  );
});

// ---- Item 5: CompactDecisionCard shows exactly one line for a judged run
// -- the result label + one "Open Compare builds" link, no "Open Tests" --
// and keeps TestStatusLine's own single line for every other status. ----

test("improvement.tsx: CompactDecisionCard slice references OPEN_COMPARE_BUILDS_LABEL once and not SEE_ON_TESTS_LABEL", () => {
  const code = codeOnly(readApp(IMPROVEMENT));
  const card = slice(code, "function CompactDecisionCard", "export function DecisionCard");
  assert.equal(count(card, "OPEN_COMPARE_BUILDS_LABEL"), 1);
  assert.ok(
    !/SEE_ON_TESTS_LABEL/.test(card),
    "no 'Open Tests' link on the Inbox card's own judged line",
  );
  assert.match(card, /CONCLUSION_LABELS\[conclusion\]/);
  // The judged-run branch and the fallback are mutually exclusive -- a
  // <TestStatusLine> call only renders when there's no conclusion (i.e.
  // every other run status: queued/copying/building/judging/failed).
  assert.match(card, /\{conclusion \? \(/);
  assert.match(card, /<TestStatusLine item=\{item\} \/>/);
});

// ---- Item 6: InstructionActions at size === "full" also offers Edit for
// live/live_attention when onEdit is supplied; actionsForState's own table
// (cards/rows) is unchanged. ----

test('improvement.tsx: InstructionActions adds a small Edit link for live/live_attention only at size === "full" and only when onEdit is supplied', () => {
  const code = codeOnly(readApp(IMPROVEMENT));
  const fn = slice(code, "export function InstructionActions", "function DecidedStatus");
  assert.match(
    fn,
    /size === "full" && \(state === "live" \|\| state === "live_attention"\) && onEdit/,
  );
});

test('harness-ux.ts: actionsForState\'s own table is unchanged -- live/live_attention still has no "edit" in `small` (cards and rows)', () => {
  const raw = readHarness("../src/lib/harness-ux.ts");
  const code = codeOnly(raw);
  const fn = slice(code, "export function actionsForState", "export const LOVABLE_SAID_PREFIX");
  const liveCase = slice(fn, 'case "live":', 'case "retired":');
  assert.match(liveCase, /small: \["test", "open"\]/);
  assert.ok(!/small: \["edit"/.test(liveCase));
});

test("harness-ux.ts: ux-round9-task1.test.ts does not pin InstructionActions (the table is unchanged, so it needed no update)", () => {
  const task1 = readHarness("test/ux-round9-task1.test.ts");
  assert.ok(!/InstructionActions/.test(task1));
});

// ---- Item 7: one left-aligned action row (no justify-between, no
// right-floated group); the single consequence line renders below the whole
// row, not under one button; no consequence line at size === "row". ----

test('improvement.tsx: InstructionActions has no "justify-between" and guards the consequence line on size !== "row"', () => {
  const code = codeOnly(readApp(IMPROVEMENT));
  const fn = slice(code, "export function InstructionActions", "function DecidedStatus");
  assert.ok(!/justify-between/.test(fn), "no right-floated group inside InstructionActions");
  assert.match(fn, /size !== "row" && consequenceLine/);
  // The row itself (primary, secondary, small links) renders as one
  // ACTION_BAR_CLASS flex row, with the consequence line as its sibling,
  // not nested inside a per-button wrapper.
  assert.equal(count(fn, "className={ACTION_BAR_CLASS}"), 1);
  const rowIdx = fn.indexOf("className={ACTION_BAR_CLASS}");
  const lineIdx = fn.indexOf('size !== "row" && consequenceLine');
  assert.ok(lineIdx > rowIdx, "the consequence line comes after (below) the action row");
});

// ---- Item 8: WORKSPACE_TARGET_LABEL replaces the three hardcoded "All my
// projects" literals in improvement.tsx. ----

test('improvement.tsx: no hardcoded "All my projects" string literal left -- every spot reads WORKSPACE_TARGET_LABEL', () => {
  const raw = readApp(IMPROVEMENT);
  const code = codeOnly(raw);
  assert.ok(!/"All my projects"/.test(code), 'no hardcoded "All my projects" literal in code');
  assert.match(
    code,
    /const scopeLabel = item\.destination === "workspace" \? WORKSPACE_TARGET_LABEL/,
  );
  assert.match(code, /\{item\.project_name === "Workspace"\s*\n\s*\? WORKSPACE_TARGET_LABEL/);
  // The import, scopeLabel's own read, and InboxCardHeader's two branches.
  assert.equal(count(code, "WORKSPACE_TARGET_LABEL"), 4);
});

// ---- Item 9: backend copy (harness/src/improvements.ts) says
// "instruction", not "rule", for VERDICT_LABEL, testedLabel, the version
// summary, the Inbox test-result summary, and the two inbox summary
// functions (inboxRetireSummary/inboxReviewReasonSummary) the sweep found
// while searching for other summary/label/title fields reaching the UI. ----

test('harness/src/improvements.ts: VERDICT_LABEL, testedLabel, the version summary, and the Inbox test-result summary say "instruction", never "rule"', () => {
  const raw = readHarness("src/improvements.ts");
  assert.match(raw, /Tested with the instruction: \$\{no\} of \$\{total\}/);
  assert.ok(!raw.includes("Tested with the rule:"));
  assert.match(raw, /keep: "You said to keep this instruction"/);
  assert.match(raw, /review: "You said this instruction needs a review"/);
  assert.match(raw, /retire: "You said to retire this instruction"/);
  assert.match(raw, /not_sure: "You said you're not sure this instruction is still useful"/);
  assert.ok(!raw.includes('"You said to keep this rule"'));
  assert.match(
    raw,
    /summary = `\$\{versionRuleIds\.length\} instruction\$\{versionRuleIds\.length === 1 \? "" : "s"\} added`;/,
  );
  assert.ok(!raw.includes('rule${versionRuleIds.length === 1 ? "" : "s"} added'));
  assert.match(raw, /summary: "Waiting for your answer\."/);
  assert.ok(!raw.includes("Awaiting your verdict on this replay."));
});

test('harness/src/improvements.ts: inboxRetireSummary and inboxReviewReasonSummary (both feed the Inbox\'s own `summary` field) say "instruction", never "rule"', () => {
  const raw = readHarness("src/improvements.ts");
  const start = raw.indexOf("function inboxRetireSummary");
  const end = raw.indexOf("// rule_attention: an open retire proposal");
  assert.ok(start >= 0 && end > start, "both functions found in expected order");
  const body = raw.slice(start, end);
  assert.doesNotMatch(body, /\brules?\b/i, `leaked "rule": ${body}`);
  assert.match(body, /This instruction has recently led to more corrections, not fewer\./);
  assert.match(body, /You asked to retire this instruction\./);
  assert.match(body, /This instruction keeps needing the same kind of correction\./);
  assert.match(body, /You marked this instruction for review\./);
  assert.match(body, /This instruction may contradict another instruction\./);
  assert.match(body, /This instruction needs a look\./);
});
