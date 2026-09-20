// Round 9 Task 4 (2026-09-20): one detail page layout for every instruction
// state (spec §5 Detail). Same lightweight, dependency-free readApp/
// codeOnly/slice pattern as ux-round9-task3.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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
function slice(code: string, start: string, end: string): string {
  const a = code.indexOf(start);
  assert.ok(a >= 0, `missing marker: ${start}`);
  const b = code.indexOf(end, a);
  assert.ok(b > a, `missing marker after ${start}: ${end}`);
  return code.slice(a, b);
}

const IMPROVEMENT = "components/harness/improvement.tsx";
const DECISION_LAYOUT = "components/harness/decision-layout.tsx";
const LEDGER = "routes/_authenticated/ledger.tsx";

// ---- 1. ImprovementDetail: no Previous/Next, no AttentionBlock ----

test("improvement.tsx: ImprovementDetail has no Previous/Next nav", () => {
  const code = codeOnly(readApp(IMPROVEMENT));
  const detail = slice(code, "export function ImprovementDetail", "function SkillProposalPanel");
  assert.ok(!/\bPrevious\b/.test(detail), "no 'Previous' left in ImprovementDetail");
  assert.ok(!/\bNext\b/.test(detail), "no 'Next' left in ImprovementDetail");
});

test("improvement.tsx: no AttentionBlock, no RecommendationCallout, no CurrentStatus in code (comments may still explain their removal)", () => {
  const code = codeOnly(readApp(IMPROVEMENT));
  assert.ok(!/AttentionBlock/.test(code), "AttentionBlock is gone -- one action set per state");
  assert.ok(!/RecommendationCallout/.test(code));
  assert.ok(!/CurrentStatus/.test(code));
});

// ---- 2. Evidence section ----

test("improvement.tsx: the detail page has an Evidence section, only rendered when there's something to show", () => {
  const code = codeOnly(readApp(IMPROVEMENT));
  assert.match(code, /aria-label="Evidence"/);
  const detail = slice(code, "export function ImprovementDetail", "function SkillProposalPanel");
  assert.match(detail, /hasEvidence \? \(/, "the section is conditional, never an empty heading");
});

test("improvement.tsx: Evidence reads observedSentence/aiCheckSentence/evidenceDisagreementLine, and the most recent broke quote via mostRecentBrokeQuote", () => {
  const code = codeOnly(readApp(IMPROVEMENT));
  const detail = slice(code, "export function ImprovementDetail", "function SkillProposalPanel");
  assert.match(detail, /observedSentence\(item\.health\)/);
  assert.match(detail, /aiCheckSentence\(item\.health\)/);
  assert.match(detail, /evidenceDisagreementLine\(item\.health\)/);
  assert.match(detail, /mostRecentBrokeQuote\(/);
  assert.match(detail, /LOVABLE_SAID_PREFIX/);
  assert.match(detail, /OPEN_COMPARE_BUILDS_LABEL/);
  assert.match(detail, /testStatusPhrase\(/);
  // Coordinator fix round 1: a judged run's evidence test line reads its
  // real result via testedResultLine (score/corrections), not the bare word
  // "Judged" -- testStatusPhrase stays for every other status (running/
  // failed/waiting).
  assert.match(detail, /testedResultLine\(testRun\)/);
});

test("harness-ux.ts: mostRecentBrokeQuote picks the newest 'broke' quote, ignoring followed/not_applicable, and is null with nothing to show", () => {
  assert.equal(ux.mostRecentBrokeQuote(null), null);
  assert.equal(ux.mostRecentBrokeQuote([]), null);
  assert.equal(
    ux.mostRecentBrokeQuote([{ verdict: "followed", quote: "ok", created_at: "2026-09-01" }]),
    null,
  );
  const quotes = [
    { verdict: "broke" as const, quote: "old one", created_at: "2026-09-01T00:00:00Z" },
    { verdict: "followed" as const, quote: "not this", created_at: "2026-09-19T00:00:00Z" },
    { verdict: "broke" as const, quote: "newest one", created_at: "2026-09-15T00:00:00Z" },
  ];
  assert.deepEqual(ux.mostRecentBrokeQuote(quotes), {
    verdict: "broke",
    quote: "newest one",
    created_at: "2026-09-15T00:00:00Z",
  });
});

// ---- 3. DecisionCard: instruction card, no absolute Edit, one action set ----

test("improvement.tsx: DecisionCard's instruction box has no absolutely positioned Edit", () => {
  const code = codeOnly(readApp(IMPROVEMENT));
  const card = slice(code, "export function DecisionCard", "export function ImprovementDetail");
  assert.ok(!/\babsolute\b/.test(card), "no 'absolute' class left in DecisionCard");
});

test('improvement.tsx: DecisionCard (full) renders one instruction card with instructionStateLine and InstructionActions size="full"', () => {
  const code = codeOnly(readApp(IMPROVEMENT));
  const card = slice(code, "export function DecisionCard", "export function ImprovementDetail");
  assert.match(card, /instructionStateLine\(\{/);
  assert.match(card, /<InstructionActions/);
  assert.match(card, /size="full"/);
  // No badges row left on the decision card: no group Badge, no "New"
  // Badge, no "Accepted automatically" Badge -- the state line says it all.
  assert.ok(!/<Badge/.test(card), "no Badge left in DecisionCard's non-compact body");
});

test("improvement.tsx: DecidedStatus keeps only decisionSentence and a small Undo (only while lovable.can_undo)", () => {
  const code = codeOnly(readApp(IMPROVEMENT));
  const decided = slice(code, "function DecidedStatus", "export function DecisionCard");
  assert.match(decided, /\{decisionSentence\(/);
  assert.match(decided, /canUndo/);
  assert.ok(!/RemoveFromKnowledgeConfirm/.test(decided), "Remove is gone from DecidedStatus");
  assert.ok(!/Re-add/.test(decided), "Re-add is gone from DecidedStatus");
  assert.ok(!/Try again/.test(decided), "Retry is gone from DecidedStatus");
  assert.ok(!/VerdictControl/.test(decided), "the Keep/Review/Retire/Not-sure row is gone");
});

// ---- 4. Retire, not "Remove from Knowledge" ----

test("improvement.tsx: the string 'Remove from Knowledge' no longer appears anywhere", () => {
  const raw = readApp(IMPROVEMENT);
  assert.ok(!raw.includes("Remove from Knowledge"));
});

test("improvement.tsx: RemoveFromKnowledgeConfirm stays exported, renamed to Retire's own copy", () => {
  const code = codeOnly(readApp(IMPROVEMENT));
  assert.match(code, /export function RemoveFromKnowledgeConfirm/);
  const fn = slice(code, "export function RemoveFromKnowledgeConfirm", "function TestButton");
  assert.match(fn, /trigger=\{INSTRUCTION_ACTION_LABELS\.retire\}/);
  assert.match(fn, /title=\{RETIRE_TITLE\}/);
  assert.match(fn, /consequences=\{RETIRE_CONSEQUENCES\}/);
  assert.match(fn, /action: "retire", rule_id: ruleId/);
});

// ---- 5. decision-layout.tsx: CurrentStatus/PrimaryAction gone ----
// Round 9 Task 5 / spec §1 principle 6, §5: RecommendationCallout is gone
// too now -- its only caller, instructions.tsx's "Needs your attention"
// section, was removed this task (the Inbox owns attention). See
// ux-round9-task5.test.ts for the fuller pin on its removal.

test("decision-layout.tsx: CurrentStatus, PrimaryAction and RecommendationCallout are all gone", () => {
  const code = readApp(DECISION_LAYOUT);
  assert.ok(!/export function CurrentStatus/.test(code));
  assert.ok(!/export function PrimaryAction/.test(code));
  assert.ok(!/export function RecommendationCallout/.test(code));
});

// ---- 6. "What happened": Changed afterward compared to Built ----

test("improvement.tsx: 'Changed afterward' is compared to 'Built' (trimmed), omitted only when identical", () => {
  const code = codeOnly(readApp(IMPROVEMENT));
  assert.match(code, /changed_afterward[^;]*!==?[^;]*built|built[^;]*!==?[^;]*changed_afterward/);
});

// ---- 7. ledger.tsx: `from` search param, back link ----

test("ledger.tsx: validateSearch accepts an optional 'from' of 'inbox' | 'instructions'", () => {
  const code = codeOnly(readApp(LEDGER));
  assert.match(code, /from\?:\s*"inbox"\s*\|\s*"instructions"/);
});

test("ledger.tsx: the back link reads '← Instructions' when from is 'instructions', else '← Inbox'", () => {
  const code = codeOnly(readApp(LEDGER));
  assert.match(code, /fromInstructions\s*=\s*search\.from === "instructions"/);
  assert.match(code, /backLabel=\{fromInstructions \? "← Instructions" : "← Inbox"\}/);
});

test("ledger.tsx: no more pendingQueueIds/pendingQueuePosition/position/onPrev/onNext wiring", () => {
  const raw = readApp(LEDGER);
  assert.ok(!/pendingQueueIds/.test(raw));
  assert.ok(!/pendingQueuePosition/.test(raw));
  assert.ok(!/onPrev=/.test(raw));
  assert.ok(!/onNext=/.test(raw));
});
