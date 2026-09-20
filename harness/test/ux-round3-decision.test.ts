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

// Round 9 Task 4 / spec §1-§3: DecidedStatus is no longer a second action
// bar at all -- the ONE fixed action set per state (InstructionActions,
// rendered by DecisionCard directly) replaced its whole hand-built button
// row (Add-instead, Try again, Remove-from-Knowledge, Re-add, the old
// no-dialog Undo baked into two branches). What remains is decisionSentence
// plus, only while lovable.can_undo, a small Undo text link -- no <details>,
// no <summary>, no button bar of its own.
test("Decided status: no button bar of its own left -- decisionSentence plus, only while lovable.can_undo, a small Undo link", () => {
  const detail = codeOnly(readApp(DETAIL));
  // Round 5 Task 5 inserted CompactDecisionCard between DecidedStatus and
  // DecisionCard (the Inbox's own lean rendering, with its own outline
  // AddConfirm) -- stop the slice there, not at DecisionCard itself, so this
  // stays scoped to DecidedStatus's own body only.
  const decided = detail.slice(
    detail.indexOf("function DecidedStatus"),
    detail.indexOf("function CompactDecisionCard"),
  );
  assert.ok(!/<details/.test(decided), "no <details> wrapper left in DecidedStatus");
  assert.ok(!/<summary/.test(decided), "no <summary> wrapper left in DecidedStatus");
  assert.ok(!/variant="outline"/.test(decided), "no outline buttons left in DecidedStatus");
  assert.ok(!/trigger="Add it now instead"/.test(decided));
  assert.ok(!/trigger=\{`\$\{ADD_LABELS\[d\]\} instead`\}/.test(decided));
  assert.ok(!/action: "retry_write"/.test(decided), "Retry is gone");
  assert.ok(!/<RemoveFromKnowledgeConfirm/.test(decided), "Remove/Retire is gone from here");
  assert.ok(!/<SkipConfirm/.test(decided), "Skip is gone from here");
  assert.match(decided, /action: "undo", id: item\.id/);
  assert.ok(!/Restore previous version/.test(decided), "Restore moved to the History page only");
  assert.match(decided, /canUndo/);
});

test("Detail: no separate 'Edit instruction' link below the card", () => {
  const detail = codeOnly(readApp(DETAIL));
  assert.ok(!/Edit instruction/.test(detail));
});

// Round 9 Task 4 / spec §5: the absolutely positioned Edit overlaying the
// instruction box is gone -- Edit is now one of InstructionActions' own
// small text actions (offered only for a Suggested state, spec §3), reached
// via the `onEdit` prop (editable?.onStart). Clicking it still swaps the
// same blockquote for the same editor in place.
test("DecisionCard: no absolutely positioned Edit -- Edit reaches editable.onStart through InstructionActions' onEdit prop", () => {
  const detail = codeOnly(readApp(DETAIL));
  const card = detail.slice(
    detail.indexOf("export function DecisionCard"),
    detail.indexOf("export function ImprovementDetail"),
  );
  assert.match(card, /editable\?\s*:\s*EditableState/);
  assert.ok(!/className="relative">/.test(card), "no relative wrapper left around the blockquote");
  assert.ok(!/className="absolute right-1 top-1"/.test(card), "no absolutely positioned Edit left");
  assert.match(card, /onEdit:\s*editable\.onStart/);
  // clicking Edit still swaps the blockquote for the editor in place
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

// Round 9 Task 4 / spec §5 Detail, principle 1: "No Previous/Next" -- one
// instruction, one shape, read top to bottom, never a browsing widget of
// its own. ImprovementDetail now takes only item/onBack/onChanged/backLabel.
test("Detail header: no 'N of M' counter and no Previous/Next -- just the back link", () => {
  const code = codeOnly(readApp(DETAIL));
  const detail = code.slice(
    code.indexOf("export function ImprovementDetail"),
    code.indexOf("function SkillProposalPanel"),
  );
  assert.ok(!/position/.test(detail));
  assert.ok(!/onPrev/.test(detail));
  assert.ok(!/onNext/.test(detail));
  assert.ok(!/\bPrevious\b/.test(detail));
  assert.ok(!/\bNext\b/.test(detail));
  assert.match(detail, /\{backLabel\}/);
});

// Round 9 Task 4: the ArrowLeft/ArrowRight browser went with Previous/Next --
// there is nothing left to page between on the detail page.
test("Detail: no ArrowLeft/ArrowRight keydown browser left in ImprovementDetail", () => {
  const code = codeOnly(readApp(DETAIL));
  const detail = code.slice(
    code.indexOf("export function ImprovementDetail"),
    code.indexOf("function SkillProposalPanel"),
  );
  assert.ok(!/useEffect\(/.test(detail));
  assert.ok(!/ArrowLeft/.test(detail));
  assert.ok(!/ArrowRight/.test(detail));
  assert.ok(!/addEventListener\("keydown"/.test(detail));
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
// Round 9 Task 4 / spec §5 Detail, principle 1: Previous/Next (and the
// "N of M" counter) are gone outright, and with them ledger.tsx's own
// pendingQueueIds/pendingQueuePosition wiring -- the back link now reads
// "← Instructions" and returns there when opened with ?from=instructions
// (Round 9 Task 5 links with it), else "← Inbox".
test("ledger.tsx: no Previous/Next wiring left; the back link honours ?from=instructions", () => {
  const raw = readApp(LEDGER);
  const ledger = codeOnly(raw);
  assert.ok(!/pendingQueueIds/.test(raw));
  assert.ok(!/pendingQueuePosition/.test(raw));
  assert.ok(!/position=/.test(ledger));
  assert.ok(!/onPrev=/.test(ledger));
  assert.ok(!/onNext=/.test(ledger));
  assert.match(ledger, /from\?:\s*"inbox"\s*\|\s*"instructions"/);
  assert.match(ledger, /backLabel=\{fromInstructions \? "← Instructions" : "← Inbox"\}/);
});

// Checkpoint 2 2-B adds a second radiogroup with two options ("This
// project"/"All my projects") inside AddInstructionConfirm, the Inbox
// card's single "Add instruction" dialog -- rewritten with intent, seven to
// nine in source. Round 8 Task 4: DestinationChoice's own radiogroup (the
// "Why Knowledge or Skill" card's Change-destination control) is gone --
// the decision card's "Saves to" line now reuses the existing
// ChangeDestinationControl (already counted below) instead of a second,
// near-duplicate one -- nine in source, not ten.
test('role="radio" count: two from AddConfirm, four from SkipConfirm\'s Round 5 Task 5 "Why?" radiogroup, one from the shared ChangeDestinationControl (Round 8 Task 4), two from AddInstructionConfirm\'s project/workspace choice (checkpoint 2 2-B), one from the Skill card\'s "Use Knowledge instead" choice, nine in source', () => {
  const detail = codeOnly(readApp(DETAIL));
  assert.equal(count(detail, 'role="radio"'), 9);
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
