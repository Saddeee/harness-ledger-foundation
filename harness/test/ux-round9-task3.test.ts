// Round 9 Task 3 (2026-09-20): InstructionActions -- the one component every
// instruction's buttons render through -- and the Inbox cards rewired to
// it. Same lightweight, dependency-free readApp/codeOnly pattern as
// ux-round9-task2.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}
function slice(code: string, start: string, end: string): string {
  const a = code.indexOf(start);
  assert.ok(a >= 0, `missing marker: ${start}`);
  const b = code.indexOf(end, a);
  assert.ok(b > a, `missing marker after ${start}: ${end}`);
  return code.slice(a, b);
}

const IMPROVEMENT = "components/harness/improvement.tsx";
const INBOX = "routes/_authenticated/inbox.tsx";
const UX = "lib/harness-ux.ts";

// ---- 1. InstructionActions exists and is exported ----

test("improvement.tsx: exports InstructionActions", () => {
  const code = codeOnly(readApp(IMPROVEMENT));
  assert.match(code, /export function InstructionActions\(/);
});

// ---- 2. CompactDecisionCard: the instruction text once, no second box,
// uses InstructionActions ----

test("improvement.tsx: CompactDecisionCard shows the instruction exactly once (one <h2, no <blockquote) and renders <InstructionActions", () => {
  const code = codeOnly(readApp(IMPROVEMENT));
  const card = slice(code, "function CompactDecisionCard", "export function DecisionCard");
  assert.equal(count(card, "<h2"), 1, "exactly one heading");
  assert.equal(count(card, "<blockquote"), 0, "no second box repeating the instruction");
  assert.match(card, /<InstructionActions/);
  assert.match(card, /item\.proposed_instruction \?\? item\.title/);
});

// ---- 3. inbox.tsx: "Open History", never "View past decisions" ----

test("inbox.tsx: says 'Open History', not 'View past decisions'", () => {
  const code = codeOnly(readApp(INBOX));
  assert.match(code, /openLabel\("History"\)/);
  assert.ok(!/View past decisions/.test(readApp(INBOX)));
});

// ---- 4. Banned navigation literals are gone from improvement.tsx; the
// harness-ux.ts constants behind two of them now read the new values ----

test("improvement.tsx: no 'View details', 'Judge replay', 'Review rule', 'See on Tests', 'See the comparison' string literals", () => {
  const raw = readApp(IMPROVEMENT);
  for (const banned of [
    "View details",
    "Judge replay",
    "Review rule",
    "See on Tests",
    "See the comparison",
  ]) {
    assert.ok(!raw.includes(banned), `banned literal still present: ${banned}`);
  }
});

test("harness-ux.ts: SEE_ON_TESTS_LABEL, REVIEW_RULE_LABEL, YOUR_VERDICT_NEEDED_LINE and the new Compare-builds label read the renamed values", () => {
  const ux = codeOnly(readApp(UX));
  assert.match(ux, /export const SEE_ON_TESTS_LABEL = "Open Tests";/);
  assert.match(ux, /export const REVIEW_RULE_LABEL = "Open Instructions";/);
  assert.match(ux, /export const OPEN_COMPARE_BUILDS_LABEL = "Open Compare builds";/);
  // Spec §2 vocabulary: "Your verdict is needed" is banned -- "Waiting for
  // your answer" is the one phrase for a test needing the user.
  assert.match(ux, /export const YOUR_VERDICT_NEEDED_LINE = "Waiting for your answer";/);
});

// ---- 5. VerdictControl renders only VERDICT_CHOICES_SHOWN ----

test("improvement.tsx: VerdictControl's own VERDICT_CHOICES is built from VERDICT_CHOICES_SHOWN, not the full four-value union", () => {
  const code = codeOnly(readApp(IMPROVEMENT));
  assert.match(code, /VERDICT_CHOICES_SHOWN\.map\(/);
  assert.ok(
    !/\["keep", "review", "retire", "not_sure"\]/.test(code),
    "the old four-value literal must be gone",
  );
});

// ---- 6. Spec §3 action wiring, one card at a time ----

test("improvement.tsx: InstructionActions wires add/skip/judge/keep/retire/test/readd/edit/open to the right primitive", () => {
  const code = codeOnly(readApp(IMPROVEMENT));
  const fn = slice(code, "export function InstructionActions", "function DecidedStatus");
  assert.match(fn, /<AddInstructionConfirm[\s\S]{0,200}trigger=\{INSTRUCTION_ACTION_LABELS\.add\}/);
  assert.match(
    fn,
    /<SkipConfirm item=\{item\} busy=\{busy\} run=\{run\} size=\{btnSize\} variant=\{variant\}/,
  );
  assert.match(fn, /to="\/judge" search=\{\{ run: runId \}\}/);
  assert.match(fn, /action: "verdict" as const, rule_id: ruleId, verdict: "keep" as const/);
  assert.match(fn, /<RetireConfirm[\s\S]{0,200}trigger=\{INSTRUCTION_ACTION_LABELS\.retire\}/);
  assert.match(fn, /<TestButton[\s\S]{0,200}trigger=\{INSTRUCTION_ACTION_LABELS\.test\}/);
  assert.match(fn, /action: "readd", id: item\.id/);
  assert.match(fn, /onClick=\{onEdit\}/);
  assert.match(fn, /href=\{openHref\}/);
});

test('improvement.tsx: InstructionActions\' retire action posts { action: "retire", rule_id } by default, and RetireCard overrides only Keep', () => {
  const code = codeOnly(readApp(IMPROVEMENT));
  const fn = slice(code, "export function InstructionActions", "function DecidedStatus");
  assert.match(fn, /<RetireConfirm\s+ruleId=\{ruleId\}/);
  const retireCard = slice(code, "function RetireCard", "export function VerdictControl");
  assert.match(retireCard, /state="live_attention"/);
  assert.match(retireCard, /keepAction=\{\{ action: "keep", id: -retire\.proposal_id \}\}/);
});

test('improvement.tsx: the ordinary Suggested state\'s own Add button gets actionConsequence("add", ...) as its consequence line', () => {
  const code = codeOnly(readApp(IMPROVEMENT));
  const fn = slice(code, "export function InstructionActions", "function DecidedStatus");
  assert.match(
    fn,
    /actionConsequence\("add", item\.destination === "workspace" \? "workspace" : "project"\)/,
  );
});

test("improvement.tsx: retire's consequence line and judge's consequence line are the exact given sentences", () => {
  const code = codeOnly(readApp(IMPROVEMENT));
  const fn = slice(code, "export function InstructionActions", "function DecidedStatus");
  assert.match(fn, /RETIRE_ACTION_CONSEQUENCE_LINE/);
  assert.match(fn, /inboxActionConsequence\("judge_replay"\)/);
  const ux = codeOnly(readApp(UX));
  assert.match(
    ux,
    /export const RETIRE_ACTION_CONSEQUENCE_LINE =\s*\n?\s*"Removes it from Lovable Knowledge\. The record stays and can be re-added\.";/,
  );
  assert.match(
    ux,
    /return "Records your answer\. Nothing changes in Lovable\. No credits, no AI tokens\.";/,
  );
});

// ---- 7. Buttons keep spec §3 order in one flex row: exactly one action
// bar inside InstructionActions ----

test("improvement.tsx: InstructionActions renders exactly one ACTION_BAR_CLASS row containing primary, secondary, then the small links", () => {
  const code = codeOnly(readApp(IMPROVEMENT));
  const fn = slice(code, "export function InstructionActions", "function DecidedStatus");
  assert.equal(count(fn, "className={ACTION_BAR_CLASS}"), 1);
});

// ---- 8. RuleAttentionCard (no improvement): "Open Instructions" ----

test('improvement.tsx: RuleAttentionCard\'s button reads openLabel("Instructions")', () => {
  const code = codeOnly(readApp(IMPROVEMENT));
  const card = slice(code, "export function RuleAttentionCard", "export function ConflictCard");
  assert.match(card, /openLabel\("Instructions"\)/);
});

// Coordinator fix round 1, item 3: a rule_attention item with no improvement
// still carries a reachable rule id (link.rule_id, set by both of
// buildRuleAttentionInboxItems' own branches) -- the card offers Keep
// (posts verdict keep, toast "Kept"), Retire (the existing RetireConfirm,
// never a duplicated body), then the small "Open Instructions" link. No
// Test button.
test("improvement.tsx: RuleAttentionCard offers Keep/Retire/Open Instructions when the item's rule id is reachable, reusing RetireConfirm rather than duplicating its body", () => {
  const code = codeOnly(readApp(IMPROVEMENT));
  const card = slice(code, "export function RuleAttentionCard", "export function ConflictCard");
  assert.match(card, /const ruleId = item\.link\.rule_id \?\? null;/);
  // \s+ tolerates however Prettier wraps this arrow function's body across
  // lines (same convention as ux.test.ts's own AddConfirm/RemoveFromKnowledgeConfirm pins).
  assert.match(
    card,
    /onClick=\{\(\)\s*=>\s*void run\(\{ action: "verdict", rule_id: ruleId, verdict: "keep" \}, "Kept"\)\s*\}/,
  );
  assert.match(card, /\{INSTRUCTION_ACTION_LABELS\.keep\}/);
  assert.match(
    card,
    /<RetireConfirm\s+ruleId=\{ruleId\}[\s\S]{0,120}variant="outline"[\s\S]{0,60}trigger=\{INSTRUCTION_ACTION_LABELS\.retire\}/,
  );
  assert.ok(!/<TestButton\b/.test(card), "RuleAttentionCard never offers Test");
});

// ---- 9. TestResultCard: primary Judge, judge's consequence line ----

test("improvement.tsx: TestResultCard's primary button reads INSTRUCTION_ACTION_LABELS.judge with the judge consequence line", () => {
  const code = codeOnly(readApp(IMPROVEMENT));
  const card = slice(code, "export function TestResultCard", "export function RuleAttentionCard");
  assert.match(card, /\{INSTRUCTION_ACTION_LABELS\.judge\}/);
  assert.match(card, /inboxActionConsequence\("judge_replay"\)/);
});

// ---- 10. ActionFailedCard: Open <place> + Dismiss; Retry gated on
// recommended_action === "retry" ----

test('improvement.tsx: ActionFailedCard gates Retry on item.recommended_action === "retry" and otherwise shows an Open <place> link plus Dismiss', () => {
  const code = codeOnly(readApp(IMPROVEMENT));
  const card = code.slice(code.indexOf("export function ActionFailedCard"));
  assert.match(card, /item\.recommended_action === "retry"/);
  assert.match(card, /actionFailedOpenLabel\(item\.link\.page\)/);
  assert.match(card, /\{DISMISS_LABEL\}/);
  assert.match(card, /\{DISMISS_CONSEQUENCE_LINE\}/);
});

// ---- 11. Coordinator fix round 1, item 1: "Without this rule" -> "Without
// this instruction" (WITHOUT_INSTRUCTION_PREFIX, harness-ux.ts) ----

test("improvement.tsx: the fold's predicted-failure sentence uses WITHOUT_INSTRUCTION_PREFIX, never the literal 'Without this rule'", () => {
  const raw = readApp(IMPROVEMENT);
  assert.ok(!raw.includes("Without this rule"), "banned literal still present");
  assert.match(codeOnly(raw), /\{WITHOUT_INSTRUCTION_PREFIX\}/);
  const ux = codeOnly(readApp(UX));
  assert.match(ux, /export const WITHOUT_INSTRUCTION_PREFIX = "Without this instruction, ";/);
});

// ---- 12. Coordinator fix round 1, item 2: RetireCard's heading uses
// VERDICT_QUESTION, never the literal "Is this rule still useful?" ----

test("improvement.tsx: RetireCard's heading renders {VERDICT_QUESTION}, never the literal 'Is this rule still useful?'", () => {
  const raw = readApp(IMPROVEMENT);
  // Scoped to RetireCard's own JSX (codeOnly, so its own explanatory
  // comment naming the old literal doesn't trip this) -- VerdictControl's
  // pre-existing Round 6 Task 4 doc comment elsewhere in the file legitimately
  // names this same literal as its own historical description and is out of
  // scope for this pin.
  const code = codeOnly(raw);
  const retireCard = slice(code, "function RetireCard", "export function VerdictControl");
  assert.ok(
    !retireCard.includes("Is this rule still useful?"),
    "banned literal still present in RetireCard's own JSX",
  );
  assert.match(retireCard, /\{VERDICT_QUESTION\}/);
});
