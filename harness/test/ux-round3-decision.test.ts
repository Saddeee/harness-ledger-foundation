// Round 3 Task 3a (decision polish): decisions shown inline instead of
// behind a collapsed "Change decision" summary, editing moved inside the
// card via a small Edit button on the instruction blockquote, and a
// Previous/Next browser on the detail view. Kept in a separate file per the
// task instructions (other tasks are editing ux.test.ts / ux-decision.test.ts
// concurrently); the same lightweight, dependency-free local helpers are
// duplicated here on purpose.
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
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const DETAIL = "components/harness/improvement.tsx";
const INBOX = "routes/_authenticated/inbox.tsx";
const LEDGER = "routes/_authenticated/ledger.tsx";

test("Decided status: no collapsed 'Change decision' wrapper anywhere in improvement.tsx", () => {
  const detail = codeOnly(readApp(DETAIL));
  assert.ok(!/Change decision/.test(detail), "the collapsed decision wrapper is gone");
});

test("Decided status: buttons render directly in a row, using outline/ghost variants", () => {
  const detail = codeOnly(readApp(DETAIL));
  // Round 5 Task 5 inserted CompactDecisionCard between DecidedStatus and
  // DecisionCard (the Inbox's own lean rendering, with its own outline
  // AddConfirm) -- stop the slice there, not at DecisionCard itself, so this
  // stays scoped to DecidedStatus's own buttons only.
  const decided = detail.slice(
    detail.indexOf("function DecidedStatus"),
    detail.indexOf("function CompactDecisionCard"),
  );
  assert.ok(!/<details/.test(decided), "no <details> wrapper left in DecidedStatus");
  assert.ok(!/<summary/.test(decided), "no <summary> wrapper left in DecidedStatus");
  // Add(s), Try again, and Re-add (Task C2) pass variant="outline" directly
  // at their DecidedStatus call site; Skip and Remove from Knowledge (Round
  // 6 Task 3) bake their own outline styling into SkipConfirm/
  // RemoveFromKnowledgeConfirm themselves, same reason Skip always has;
  // Undo (Round 6 Task 3) is ghost, also baked in at its own call site.
  assert.equal(count(decided, 'variant="outline"'), 4);
  assert.match(decided, /trigger="Add it now instead"/);
  assert.match(decided, /trigger=\{`\$\{ADD_LABELS\[d\]\} instead`\}/);
  assert.match(decided, /action: "retry_write", id: item\.id, version_id: retryableVersion\.id/);
  // Round 6 Task 4 / spec §4: every button in this bar carries the same
  // `size` variable (computed once from titleAs) -- "sm" on lists, default
  // on the detail page.
  assert.match(
    decided,
    /<RemoveFromKnowledgeConfirm\s+ruleId=\{ruleId\}\s+busy=\{busy\}\s+run=\{run\}\s+size=\{size\}\s*\/>/,
  );
  assert.match(decided, /action: "undo", id: item\.id/);
  assert.ok(!/Restore previous version/.test(decided), "Restore moved to the History page only");
  assert.match(
    decided,
    /<SkipConfirm\s+item=\{item\}\s+busy=\{busy\}\s+run=\{run\}\s+size=\{size\}\s*\/>/,
  );
});

test("Detail: no separate 'Edit instruction' link below the card", () => {
  const detail = codeOnly(readApp(DETAIL));
  assert.ok(!/Edit instruction/.test(detail));
});

test("DecisionCard: the instruction blockquote carries a small Edit button in its top-right corner", () => {
  const detail = codeOnly(readApp(DETAIL));
  const card = detail.slice(
    detail.indexOf("export function DecisionCard"),
    detail.indexOf("export function ImprovementDetail"),
  );
  assert.match(card, /editable\?\s*:\s*EditableState/);
  assert.match(card, /className="relative">/, "the blockquote sits in a relative container");
  assert.match(card, /className="absolute right-1 top-1"/, "the Edit button is pinned top-right");
  assert.match(card, /variant="ghost"/);
  assert.match(card, />\s*Edit\s*<\/Button>/);
  assert.match(card, /onClick=\{editable\.onStart\}/);
  // clicking Edit swaps the blockquote for the editor in place
  assert.match(card, /editable\.editing/);
  assert.match(card, /editable\.draft/);
  assert.match(card, /editable\.onChangeDraft/);
  assert.match(card, /editable\.onChangeReason/);
  assert.match(card, /editable\.onSave/);
  assert.match(card, /editable\.onCancel/);
  assert.match(card, /Save wording/);
  assert.match(card, />\s*Cancel\s*<\/Button>/);
});

test("DecisionCard: lists (onOpen present) never receive editable, so no Edit button there", () => {
  for (const page of [INBOX, LEDGER]) {
    const code = codeOnly(readApp(page));
    assert.ok(!/editable=/.test(code), `${page} must not pass editable to DecisionCard`);
  }
});

test("Detail header: back link plus 'N of M' and Previous/Next, disabled at the ends", () => {
  const detail = codeOnly(readApp(DETAIL));
  assert.match(
    detail,
    /position\?\s*:\s*\{\s*index:\s*number;\s*total:\s*number\s*\}\s*\|\s*undefined/,
  );
  assert.match(detail, /onPrev\?\s*:\s*\(\(\) => void\)\s*\|\s*undefined/);
  assert.match(detail, /onNext\?\s*:\s*\(\(\) => void\)\s*\|\s*undefined/);
  assert.match(detail, /\{position\.index\} of \{position\.total\}/);
  assert.match(detail, /←\s*Previous/);
  assert.match(detail, /Next\s*→/);
  assert.match(detail, /disabled=\{position\.index <= 1\}/);
  assert.match(detail, /disabled=\{position\.index >= position\.total\}/);
});

test("Detail: ArrowLeft/ArrowRight navigate, ignored in text fields, contenteditable or an open dialog", () => {
  const detail = codeOnly(readApp(DETAIL));
  assert.match(detail, /useEffect\(/);
  assert.match(detail, /e\.key === "ArrowLeft"/);
  assert.match(detail, /onPrev\?\.\(\)/);
  assert.match(detail, /e\.key === "ArrowRight"/);
  assert.match(detail, /onNext\?\.\(\)/);
  assert.match(
    detail,
    /tag === "INPUT" \|\| tag === "TEXTAREA" \|\| tag === "SELECT" \|\| target\?\.isContentEditable/,
  );
  assert.match(detail, /document\.querySelector\('\[role="alertdialog"\]'\)/);
  assert.match(detail, /window\.addEventListener\("keydown", onKeyDown\)/);
  assert.match(detail, /window\.removeEventListener\("keydown", onKeyDown\)/);
});

// Round 5 Task 5 / spec §2: the Inbox lost its own detail view (and with it,
// this Previous/Next browser -- clicking a card now goes straight to
// Suggestions instead of paging through pending items in place). Browsing
// still exists, just one level up: ImprovementDetail's own Previous/Next
// still works from the Suggestions page (see "Improvements: passes the
// grouped order..." right below), which is where every click now lands.
test("Inbox: no Previous/Next browser of its own -- that only ever lived in the (now removed) same-page detail view", () => {
  const inbox = codeOnly(readApp(INBOX));
  for (const gone of ["position=", "onPrev=", "onNext=", "const order ="]) {
    assert.ok(!inbox.includes(gone), `${gone} should be gone from inbox.tsx`);
  }
});

// Round 6c part A / item 1: rewritten with intent -- Suggestions no longer
// iterates IMPROVEMENT_GROUPS generically (In Lovable/Reverted are gone from
// this page; pending items now join "Needs attention" under one "Open"
// section). Previous/Next now browse the four fixed sections in their
// on-page order: Open, Waiting to be written, Waiting to be tested, Decided
// earlier.
test("Improvements: passes the on-page section order (Open, Waiting to be written, Waiting to be tested, Decided earlier) to Previous/Next", () => {
  const ledger = codeOnly(readApp(LEDGER));
  assert.match(
    ledger,
    /const order = \[\.\.\.openItems, \.\.\.waitingToBeWritten, \.\.\.waitingToBeTested, \.\.\.decidedEarlier\]\.map\(\s*\(i\) => i\.id,\s*\);/,
  );
  assert.match(
    ledger,
    /position=\{idx >= 0 \? \{ index: idx \+ 1, total: order\.length \} : undefined\}/,
  );
  assert.match(ledger, /onPrev=\{idx > 0 \? \(\) => open\(order\[idx - 1\]!\) : undefined\}/);
  assert.match(
    ledger,
    /onNext=\{idx >= 0 && idx < order\.length - 1 \? \(\) => open\(order\[idx \+ 1\]!\) : undefined\}/,
  );
});

test('role="radio" count: two from AddConfirm, four from SkipConfirm\'s Round 5 Task 5 "Why?" radiogroup, six total', () => {
  const detail = codeOnly(readApp(DETAIL));
  assert.equal(count(detail, 'role="radio"'), 6);
});

test("cost wording stays honest: 'Lovable credits' <= 2 and 'Harness Ledger analysis' == 1 on improvement.tsx", () => {
  const detail = codeOnly(readApp(DETAIL));
  assert.ok(
    count(detail, "Lovable credits") <= 2,
    `Lovable credits x${count(detail, "Lovable credits")}`,
  );
  assert.equal(count(detail, "Harness Ledger analysis"), 1);
});

test("no <details open> anywhere in improvement.tsx", () => {
  const raw = readApp(DETAIL);
  for (const tag of codeOnly(raw).match(/<details[^>]*>/g) ?? []) {
    assert.ok(!/\sopen\b/.test(tag), `collapsed by default, got: ${tag}`);
  }
  assert.ok(!/<details open/.test(raw));
});
