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
  // RetireCard, DecidedStatus, CompactDecisionCard, and DecisionCard's own
  // pending branch -- one bar per rendered card, never a second one sharing
  // space with anything else.
  assert.equal(
    count(code, "className={ACTION_BAR_CLASS}"),
    4,
    "exactly one action-bar container per card-rendering function",
  );
});

function slice(code: string, start: string, end: string): string {
  const a = code.indexOf(start);
  assert.ok(a >= 0, `missing marker: ${start}`);
  const b = code.indexOf(end, a);
  assert.ok(b > a, `missing marker after ${start}: ${end}`);
  return code.slice(a, b);
}

test("improvement.tsx: RetireCard's bar has exactly one action-bar container, sized by titleAs", () => {
  const code = codeOnly(readApp(IMPROVEMENT));
  const fn = slice(code, "function RetireCard", "export function VerdictControl");
  assert.equal(count(fn, "className={ACTION_BAR_CLASS}"), 1);
  assert.match(fn, /const size: "default" \| "sm" = titleAs === "h1" \? "default" : "sm";/);
  // Every button inside the bar references the same `size` variable --
  // never a hardcoded literal that could drift from it (the reported bug:
  // a small verdict row next to a full-size action row).
  const bar = slice(fn, "className={ACTION_BAR_CLASS}", "</article>");
  assert.ok(!/size="(sm|default)"/.test(bar), "no hardcoded size literal inside the bar");
  assert.equal(count(bar, "size={size}"), 2, "RetireConfirm and Keep both sized");
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

test("improvement.tsx: CompactDecisionCard's bar has exactly one action-bar container, always 'sm' (the Inbox is always a list)", () => {
  const code = codeOnly(readApp(IMPROVEMENT));
  const fn = slice(code, "function CompactDecisionCard", "export function DecisionCard");
  assert.equal(count(fn, "className={ACTION_BAR_CLASS}"), 1);
  assert.match(fn, /const size = "sm";/);
  const bar = slice(fn, "className={ACTION_BAR_CLASS}", "</article>");
  // Round 6 Task 6b / spec §6: both AddConfirms, SkipConfirm, and TestButton
  // (rendered unconditionally in source -- it returns null itself when
  // item.test isn't available, so this is still one bar, never a second).
  assert.equal(count(bar, "size={size}"), 4, "both AddConfirms, SkipConfirm, and TestButton sized");
  assert.ok(!/size="(sm|default)"/.test(bar), "no hardcoded size literal inside the bar");
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
  // The only two literal ternaries deciding size, both keyed off titleAs;
  // every button reads the resulting `size` variable rather than choosing
  // its own literal, so a bar can never mix "sm" with the default.
  assert.equal(
    count(code, 'const size: "default" | "sm" = titleAs === "h1" ? "default" : "sm";'),
    2,
    "RetireCard and DecisionCard each compute size once from titleAs",
  );
});

// ---- 2. Header row -> title -> body (full width) -> status lines -> bar --
// the editor block moved OUT of a two-column header into its own sibling.

test("improvement.tsx: DecisionCard's header row (project + badges) and its body (title + instruction/editor) are siblings, not columns of one shared row", () => {
  const raw = readApp(IMPROVEMENT);
  const headerAt = raw.indexOf(
    "{/* header row: project name left, status badges right -- the body",
  );
  assert.ok(headerAt >= 0, "expected the header-row marker in DecisionCard");
  const bodyAt = raw.indexOf(
    "{/* body: title + instruction (blockquote or the editor), full width",
  );
  assert.ok(bodyAt > headerAt, "expected the body marker after the header row");
  // Structural check (regex on the JSX): the header row's own </div> is
  // immediately followed by the body marker and the click-wrapper's own
  // opening <div -- i.e. the body sits beside the header row, not nested
  // inside its left column.
  const between = raw.slice(headerAt, bodyAt + 400);
  assert.match(
    between,
    /<\/div>\s*\n\s*\{\/\* body: title \+ instruction[\s\S]{0,220}\*\/\}\s*\n\s*<div\s*\n\s*className=\{\s*\n\s*onOpen \?/,
    "the body's own <div> must open right after the header row's </div> closes -- a sibling, not a nested column",
  );
  // The editor (editable.editing) and the plain blockquote both live inside
  // that same body block, never back inside the header row.
  const editingAt = raw.indexOf("editable && editable.editing");
  assert.ok(editingAt > bodyAt, "the editor branch must be part of the body block, after it opens");
});

test("improvement.tsx: CompactDecisionCard's header row and body are siblings too (project+badge row, then title, then blockquote)", () => {
  const raw = readApp(IMPROVEMENT);
  const fnAt = raw.indexOf("function CompactDecisionCard");
  const endAt = raw.indexOf("export function DecisionCard", fnAt);
  const fn = raw.slice(fnAt, endAt);
  const headerAt = fn.indexOf("{/* header row: project name left, status badges right */}");
  const bodyAt = fn.indexOf("{/* body: full width, a sibling of the header row above */}");
  assert.ok(headerAt >= 0 && bodyAt > headerAt);
  const between = fn.slice(headerAt, bodyAt);
  // The header row's own two <div>s (the outer row and, for a decided item,
  // the badge wrapper) both close before the body marker.
  assert.equal(count(between, "<div"), count(between, "</div>"), "header row is fully closed");
});

// ---- 3. The verdict control: compact, shared, one per rule ----

test("improvement.tsx: VerdictControl is role=\"group\", labelled 'Did this rule help?', with the spec's exact Yes/No/Not sure buttons", () => {
  const raw = readApp(IMPROVEMENT);
  const code = codeOnly(raw);
  assert.match(code, /export function VerdictControl/);
  const fn = slice(code, "export function VerdictControl", "function DecidedStatus");
  assert.match(fn, /role="group"/);
  assert.match(fn, /aria-label="Did this rule help\?"/);
  for (const label of ["Yes", "No", "Not sure"]) {
    assert.ok(fn.includes(`label: "${label}"`) || raw.includes(`label: "${label}"`));
  }
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

test("instructions.tsx: exactly one DropdownMenu per row, separate from the Observed cell's VerdictControl", () => {
  const code = codeOnly(readApp(INSTRUCTIONS_PAGE));
  const row = slice(code, "function RuleRow", "function RulesTable");
  assert.equal(count(row, "<DropdownMenu>"), 1, "exactly one row menu");
  assert.equal(count(row, "<VerdictControl"), 1, "exactly one verdict control");
  // The verdict control comes before the menu cell in source order (Observed
  // then the trailing "…" menu), matching the table's own column order.
  assert.ok(row.indexOf("<VerdictControl") < row.indexOf("<DropdownMenu>"));
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
