// Round 6 Task 4 / spec §4: structural tests for the clean-card layout (one
// header row, one full-width body, one action bar) and the compact,
// self-contained verdict control. Same lightweight, dependency-free
// readApp/codeOnly pattern as ux-round4-retire.test.ts (kept in its own
// file per the task instructions -- other tasks are editing shared files
// concurrently this round).
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

const IMPROVEMENT = "components/harness/improvement.tsx";
const INSTRUCTIONS_PAGE = "routes/_authenticated/instructions.tsx";
const IMPROVEMENTS_SRC = "src/improvements.ts";

// ---- 1. One action bar per card, all the same size ----

test("improvement.tsx: ACTION_BAR_CLASS is the exact spec class, defined once, and used as the one action-bar container in every card path", () => {
  const raw = readApp(IMPROVEMENT);
  const code = codeOnly(raw);

  assert.match(
    code,
    /const ACTION_BAR_CLASS = "flex flex-wrap items-center gap-2";/,
    "spec §4's exact bar class",
  );
  assert.equal(count(code, "const ACTION_BAR_CLASS ="), 1, "defined exactly once");
  // DecidedStatus and DecisionCard's own pending branch -- one bar per
  // rendered card, never a second one sharing space with anything else.
  // Checkpoint 3 adds the five Inbox item cards (NewSkillCard,
  // TestResultCard, RuleAttentionCard, ConflictCard, ActionFailedCard),
  // each with one bar.
  // Round 9 Task 3: RetireCard and CompactDecisionCard no longer render
  // their own bar -- both now delegate to the one shared InstructionActions
  // component, whose own single `className={ACTION_BAR_CLASS}` occurrence
  // in source is reused at runtime by every caller. Two card-rendering
  // functions' own bars collapse into that one shared occurrence, dropping
  // the count from 9 to 8.
  // Coordinator fix round 1: RuleAttentionCard gained a second branch (a
  // reachable rule id renders Keep/Retire/Open directly; the old
  // Open-Instructions-only rendering stays as a defensive fallback for a
  // future item with none) -- two bars in source for that one function,
  // only one ever rendered at once, back up to 9.
  assert.equal(
    count(code, "className={ACTION_BAR_CLASS}"),
    9,
    "exactly one action-bar container per card-rendering function (RetireCard/CompactDecisionCard share InstructionActions' own; RuleAttentionCard has two mutually exclusive branches)",
  );
});

function slice(code: string, start: string, end: string): string {
  const a = code.indexOf(start);
  assert.ok(a >= 0, `missing marker: ${start}`);
  const b = code.indexOf(end, a);
  assert.ok(b > a, `missing marker after ${start}: ${end}`);
  return code.slice(a, b);
}

// Round 9 Task 3 ruling (spec §3): RetireCard's own Keep/Retire buttons are
// gone -- a retire proposal is a live instruction asked for attention, so
// its actions now come from the one shared InstructionActions, state forced
// to "live_attention", with a keepAction override so Keep still posts the
// proposal's own negative id. RetireCard itself renders zero action-bar
// containers of its own any more (was 1).
test('improvement.tsx: RetireCard delegates its actions to the shared InstructionActions, state "live_attention", with a keepAction override for the proposal\'s own id', () => {
  const code = codeOnly(readApp(IMPROVEMENT));
  const fn = slice(code, "function RetireCard", "export function VerdictControl");
  assert.equal(
    count(fn, "className={ACTION_BAR_CLASS}"),
    0,
    "RetireCard no longer renders its own action-bar container",
  );
  assert.match(fn, /<InstructionActions/);
  assert.match(fn, /state="live_attention"/);
  assert.match(fn, /keepAction=\{\{ action: "keep", id: -retire\.proposal_id \}\}/);
  assert.ok(!/size="(sm|default)"/.test(fn), "no hardcoded size literal");
});

test("improvement.tsx: DecidedStatus's bar has exactly one action-bar container, sized via ctx (not write_status)", () => {
  const code = codeOnly(readApp(IMPROVEMENT));
  const fn = slice(code, "function DecidedStatus", "function CompactDecisionCard");
  assert.equal(count(fn, "className={ACTION_BAR_CLASS}"), 1);
  assert.match(fn, /const size = ctx\?\.size \?\? "sm";/);
  const bar = fn.slice(fn.indexOf("className={ACTION_BAR_CLASS}"));
  assert.ok(!/size="(sm|default)"/.test(bar), "no hardcoded size literal inside the bar");
  // Undo/Re-add, Add-instead x2, Skip, Try again, Remove from Knowledge,
  // Undo again -- every branch's button reads the same `size` variable.
  assert.ok(count(bar, "size={size}") >= 6, "every button in the bar shares the size variable");
});

// Round 9 Task 3: CompactDecisionCard's own action bar (the bespoke
// recommendedPrimaryAction branches -- Add/Skip/Review Skill/Test first,
// each hand-sized) is gone, replaced by one <InstructionActions size="card">
// call -- InstructionActions itself owns the one bar, sizing every button
// from its own "card"/"full"/"row" prop, never a local "sm"/"default"
// literal CompactDecisionCard has to keep in sync.
test('improvement.tsx: CompactDecisionCard renders exactly one <InstructionActions size="card"> and no action-bar container of its own', () => {
  const code = codeOnly(readApp(IMPROVEMENT));
  const fn = slice(code, "function CompactDecisionCard", "export function DecisionCard");
  assert.equal(
    count(fn, "className={ACTION_BAR_CLASS}"),
    0,
    "CompactDecisionCard no longer renders its own action-bar container",
  );
  assert.equal(count(fn, "<InstructionActions"), 1);
  assert.match(fn, /<InstructionActions[\s\S]{0,200}size="card"/);
  assert.ok(!/size="(sm|default)"/.test(fn), "no hardcoded size literal");
});

test("improvement.tsx: DecisionCard's own pending branch has exactly one action-bar container, sized by titleAs", () => {
  const code = codeOnly(readApp(IMPROVEMENT));
  const fn = slice(code, "export function DecisionCard", "function MessageBlock");
  assert.equal(count(fn, "className={ACTION_BAR_CLASS}"), 1);
  assert.match(fn, /const size: "default" \| "sm" = titleAs === "h1" \? "default" : "sm";/);
  const bar = slice(fn, "className={ACTION_BAR_CLASS}", "</article>");
  // Round 6 Task 6b / spec §6: both AddConfirms, SkipConfirm, and TestButton.
  assert.equal(count(bar, "size={size}"), 4, "both AddConfirms, SkipConfirm, and TestButton sized");
  assert.ok(!/size="(sm|default)"/.test(bar), "no hardcoded size literal inside the bar");
});

test('improvement.tsx: lists use size="sm", the detail page uses the default -- never mixed in the same card', () => {
  const code = codeOnly(readApp(IMPROVEMENT));
  // Round 9 Task 3: RetireCard no longer computes its own "default"/"sm"
  // size at all -- InstructionActions derives it from its own "card"/"full"
  // prop instead (passed titleAs === "h1" ? "full" : "card"). Only
  // DecisionCard's own (unchanged, non-compact) pending/decided body still
  // uses this literal ternary -- one occurrence, not two.
  assert.equal(
    count(code, 'const size: "default" | "sm" = titleAs === "h1" ? "default" : "sm";'),
    1,
    "DecisionCard alone still computes size once from titleAs",
  );
});

// ---- 2. Header row -> title -> body (full width) -> status lines -> bar --
// the editor block moved OUT of a two-column header into its own sibling.

// Round 8 Task 4: rewritten with intent -- the body no longer carries a
// duplicated title (removed, see review item 6), so its own onOpen-ternary
// wrapper (dead code on this branch -- onOpen is never passed to the
// non-compact DecisionCard) is gone too; the body is now a plain sibling
// <div className="space-y-3"> labelled "Suggested instruction".
test("improvement.tsx: DecisionCard's header row (project + badges) and its body (instruction/editor) are siblings, not columns of one shared row", () => {
  const raw = readApp(IMPROVEMENT);
  const headerAt = raw.indexOf(
    "{/* header row: project name left, status badges right -- the body",
  );
  assert.ok(headerAt >= 0, "expected the header-row marker in DecisionCard");
  const bodyAt = raw.indexOf("{/* body: instruction, full width -- a sibling of the header row");
  assert.ok(bodyAt > headerAt, "expected the body marker after the header row");
  // Structural check (regex on the JSX): the header row's own </div> is
  // immediately followed by the body marker and the body's own opening
  // <div className="space-y-3"> -- i.e. the body sits beside the header
  // row, not nested inside its left column.
  const between = raw.slice(headerAt, bodyAt + 500);
  assert.match(
    between,
    /<\/div>\s*\n\s*\{\/\* body: instruction, full width[\s\S]{0,600}\*\/\}\s*\n\s*<div className="space-y-3">/,
    "the body's own <div> must open right after the header row's </div> closes -- a sibling, not a nested column",
  );
  // The editor (editable.editing) and the plain blockquote both live inside
  // that same body block, never back inside the header row.
  const editingAt = raw.indexOf("editable && editable.editing");
  assert.ok(editingAt > bodyAt, "the editor branch must be part of the body block, after it opens");
});

// Round 9 Task 3: the header row's own marker comment and the body's own
// (the instruction heading, not a second "body" comment block any more --
// the <h2> follows the header <div> directly) changed wording; the
// structural guarantee -- the header row's own <div>s are fully closed
// before the heading -- still holds and is still worth pinning.
test("improvement.tsx: CompactDecisionCard's header row and heading are siblings too (project+badge row, then the instruction heading)", () => {
  const raw = readApp(IMPROVEMENT);
  const fnAt = raw.indexOf("function CompactDecisionCard");
  const endAt = raw.indexOf("export function DecisionCard", fnAt);
  const fn = raw.slice(fnAt, endAt);
  const headerAt = fn.indexOf(
    "{/* header row: project name (+ New badge) left, the state line right",
  );
  const bodyAt = fn.indexOf("{/* body: the instruction text, once -- full width, a sibling of the");
  assert.ok(headerAt >= 0 && bodyAt > headerAt);
  const between = fn.slice(headerAt, bodyAt);
  // The header row's own two <div>s (the outer row and the badge wrapper)
  // both close before the body marker.
  assert.equal(count(between, "<div"), count(between, "</div>"), "header row is fully closed");
});

// ---- 3. The verdict control: compact, shared, one per rule ----

test("improvement.tsx: VerdictControl is role=\"group\", labelled 'Is this rule still useful?', with Keep / Review / Retire / Not sure", () => {
  const raw = readApp(IMPROVEMENT);
  const code = codeOnly(raw);
  assert.match(code, /export function VerdictControl/);
  const fn = slice(code, "export function VerdictControl", "function DecidedStatus");
  assert.match(fn, /role="group"/);
  assert.match(fn, /aria-label=\{VERDICT_QUESTION\}/);
  assert.match(raw, /VERDICT_CHOICE_LABELS\[value\]/);
  // Ghost, small buttons -- a compact inline control, not a row in the
  // action bar (VerdictControl is never wrapped in ACTION_BAR_CLASS).
  assert.match(fn, /variant="ghost"/);
  assert.match(fn, /size="sm"/);
});

test("improvement.tsx and instructions.tsx: both render the shared VerdictControl -- one visible verdict control per rule, in both places", () => {
  for (const rel of [IMPROVEMENT, INSTRUCTIONS_PAGE]) {
    const code = codeOnly(readApp(rel));
    assert.match(code, /<VerdictControl\b/, `${rel} missing <VerdictControl`);
  }
  const instructions = codeOnly(readApp(INSTRUCTIONS_PAGE));
  // Exactly one per row -- the Observed cell's own control, nothing else.
  assert.equal(count(instructions, "<VerdictControl"), 1);
});

test("improvement.tsx: pressing the same verdict twice is a no-op -- reads changed:false as ALREADY_RECORDED_TOAST, otherwise shows the You-said line plus the effect line", () => {
  const raw = readApp(IMPROVEMENT);
  const code = codeOnly(raw);
  assert.match(code, /data\.improvement\?\.changed === false/);
  assert.match(code, /ALREADY_RECORDED_TOAST/);
  assert.match(code, /verdictEffectLine\(effect\)/);
  assert.match(code, /post\(\{ action: "verdict", rule_id: ruleId, verdict: v \}\)/);
});

test("harness-ux.ts: the verdict effect copy, verbatim -- ALREADY_RECORDED_TOAST and the three VERDICT_EFFECT_TEXT lines", () => {
  assert.equal(ux.ALREADY_RECORDED_TOAST, "Already recorded");
  assert.deepEqual(ux.VERDICT_EFFECT_TEXT, {
    counted_hurt: "Counted as one repeat correction in this rule's health",
    snoozed: "Retirement snoozed for 30 days",
    none: "Recorded; no effect on health",
  });
  assert.equal(ux.verdictEffectLine(null), null);
  assert.equal(ux.verdictEffectLine("snoozed"), "Retirement snoozed for 30 days");
});

test("harness-ux.ts: WriteOutcome's kind union gained 'demo' (Round 6 Task 5), mirroring beats.ts's WriteOutcomeKind", () => {
  const code = codeOnly(readApp("lib/harness-ux.ts"));
  assert.match(
    code,
    /kind: "not_connected" \| "stale" \| "rejected" \| "no_snapshot" \| "error" \| "demo";/,
  );
});

// ---- 4. harness/src/improvements.ts: the verdict action returns changed
// and effect, and health.verdict_effect mirrors it on the returned item ----

test("harness/src/improvements.ts: recordVerdict returns { changed, effect } and sets health.verdict_effect to the same value", () => {
  const code = codeOnly(readHarness(IMPROVEMENTS_SRC));
  assert.match(code, /\): Improvement & \{\s*changed: boolean;\s*effect: VerdictEffect;?\s*\}/);
  assert.match(code, /export type VerdictEffect = "counted_hurt" \| "snoozed" \| "none";/);
  assert.match(code, /effect = "counted_hurt";/);
  assert.match(code, /effect = "snoozed";/);
  assert.match(
    code,
    /health: refreshed\.health \? \{ \.\.\.refreshed\.health, verdict_effect: effect \} : refreshed\.health,/,
  );
  // computeHealth's own ordinary build always starts null -- only
  // recordVerdict's direct response ever sets a real value.
  assert.match(code, /verdict_effect: null,/);
});

// ---- 5. Instructions row: one DropdownMenu, Remove from Knowledge +
// Open suggestion, and the VerdictControl living in a different cell ----

test("instructions.tsx: exactly one DropdownMenu per rule card, separate from its own VerdictControl", () => {
  const code = codeOnly(readApp(INSTRUCTIONS_PAGE));
  const row = slice(code, "function RuleCard", "function RulesList");
  assert.equal(count(row, "<DropdownMenu>"), 1, "exactly one card menu");
  assert.equal(count(row, "<VerdictControl"), 1, "exactly one verdict control");
  // 2026-09-19 demo round (review item 7): the rules table became a card --
  // the "…" menu now sits in the card's own header row (top-right, next to
  // the rule text), ahead of the body content further down that includes
  // the VerdictControl, reversing the old table's column order.
  assert.ok(row.indexOf("<DropdownMenu>") < row.indexOf("<VerdictControl"));
});

// ---- 6. Addendum: the pending-write banner's own Cancel button reads the
// cancel_write response's cancel_note when the rule stayed live ----

test("instructions.tsx: Cancel on the pending-write banner shows cancel_note when present, CANCEL_WRITE_TOAST otherwise", () => {
  const code = codeOnly(readApp(INSTRUCTIONS_PAGE));
  assert.match(code, /data\.improvement\?\.cancel_note \?\? CANCEL_WRITE_TOAST/);
});

test("improvements-client.ts: Improvement carries cancel_note, changed, effect, and ImprovementHealth carries verdict_effect", () => {
  const code = codeOnly(readApp("lib/improvements-client.ts"));
  assert.match(code, /cancel_note\?: string;/);
  assert.match(code, /changed\?: boolean;/);
  assert.match(code, /effect\?: VerdictEffect;/);
  assert.match(code, /verdict_effect\?: VerdictEffect \| null;/);
});
