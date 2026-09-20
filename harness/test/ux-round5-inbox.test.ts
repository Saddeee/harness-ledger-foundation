// Round 5 Task 5 / spec §2, §4, §4b: structural tests for the compact Inbox
// cards (Inbox holds only what needs a decision, with the decision buttons
// right there; clicking an item goes to Suggestions -- /ledger's own
// ImprovementDetail -- since the Inbox no longer has its own detail view)
// and the SkipConfirm "Why? (optional)" reason radiogroup. Same lightweight,
// dependency-free local helpers as ux.test.ts / the other ux-round*.test.ts
// files (kept in its own file per the task instructions -- other tests are
// being edited concurrently).
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

test("inbox.tsx: no ImprovementDetail import or use in code -- the Inbox has no detail view of its own", () => {
  const inbox = codeOnly(readApp(INBOX));
  assert.ok(
    !/ImprovementDetail/.test(inbox),
    "ImprovementDetail must not appear in inbox.tsx's code",
  );
});

test("inbox.tsx: clicking an item navigates to Suggestions (/ledger), never a same-page detail", () => {
  const inbox = codeOnly(readApp(INBOX));
  assert.match(
    inbox,
    /navigate\(\{\s*to:\s*"\/ledger",\s*search:\s*\{\s*improvement:\s*id\s*\}\s*\}\)/,
    "expected an onOpen that navigates to /ledger with the item preselected",
  );
  // Never routes back to /inbox with an ?improvement= param -- that was the
  // old same-page detail view, now removed entirely.
  assert.ok(
    !/to:\s*"\/inbox",\s*search:\s*\{\s*improvement/.test(inbox),
    "must not navigate back into inbox.tsx's own (removed) detail view",
  );
});

test("inbox.tsx: Route.validateSearch still exists and returns {} -- no ?improvement= param is read any more", () => {
  const inbox = codeOnly(readApp(INBOX));
  assert.match(inbox, /validateSearch:/, "Route.validateSearch must still be defined");
  // No trace of the old improvement-id search param parsing.
  assert.ok(!/search\["improvement"\]/.test(inbox));
  assert.ok(!/search\.improvement/.test(inbox));
  assert.ok(!/\{\s*improvement\?:\s*number\s*\}/.test(inbox));
});

test("inbox.tsx: no 'selected' branch, no Previous/Next wiring -- those lived only in the removed detail view", () => {
  const inbox = codeOnly(readApp(INBOX));
  for (const gone of ["const selected", "onPrev", "onNext", "backLabel", "position="]) {
    assert.ok(!inbox.includes(gone), `${gone} should be gone from inbox.tsx`);
  }
});

test("inbox.tsx: ConfirmationRow, confirmed/undo state and the 'New' marker are kept", () => {
  const inbox = codeOnly(readApp(INBOX));
  assert.match(inbox, /function ConfirmationRow/);
  assert.match(inbox, /useState<Map<number, string>>/);
  assert.match(inbox, /const \[undoing, setUndoing\] = useState<Set<number>>/);
  assert.match(inbox, /const isNew = \(item: Improvement\): boolean =>/);
  // Checkpoint 3: cards are rendered from the unified Inbox items.
  assert.match(inbox, /isNew=\{isNew\(it\.improvement\)\}/);
});

test("inbox.tsx: mark_seen effect is kept", () => {
  const inbox = codeOnly(readApp(INBOX));
  assert.match(inbox, /action:\s*"mark_seen"/);
  assert.match(inbox, /previousLastSeenAt/);
});

test("inbox.tsx: the pending list renders DecisionCard in compact mode", () => {
  const inbox = codeOnly(readApp(INBOX));
  assert.match(inbox, /<DecisionCard\s+compact\b/, "the Inbox must pass compact to DecisionCard");
});

test("improvement.tsx: DecisionCard accepts an optional compact prop", () => {
  const detail = codeOnly(readApp(DETAIL));
  const card = detail.slice(
    detail.indexOf("export function DecisionCard"),
    detail.indexOf("// ---- Detail pieces"),
  );
  assert.match(card, /compact\?\s*:\s*boolean/);
});

// Split out into its own function (CompactDecisionCard) rather than an
// inline branch, precisely so it never entangles with the unchanged
// non-compact JSX -- see improvement.tsx's own comment on the function.
function compactCardSource(detail: string): string {
  const start = detail.indexOf("function CompactDecisionCard");
  assert.ok(start >= 0, "expected a CompactDecisionCard function in improvement.tsx");
  const end = detail.indexOf("export function DecisionCard");
  assert.ok(end > start);
  return detail.slice(start, end);
}

test("improvement.tsx: DecisionCard delegates to CompactDecisionCard when compact is set", () => {
  const detail = codeOnly(readApp(DETAIL));
  const card = detail.slice(
    detail.indexOf("export function DecisionCard"),
    detail.indexOf("// ---- Detail pieces"),
  );
  assert.match(card, /if \(compact\)/);
  assert.match(card, /<CompactDecisionCard/);
});

// Checkpoint 2 2-B: rewritten with intent -- the compact card's own "three
// decision buttons" (Add to project / Add to workspace / Skip) collapsed
// into ONE recommended primary action (Add instruction, Review Skill, or
// Test first, chosen by recommendedPrimaryAction) plus Skip; the two
// separate AddConfirm calls are gone from this card (AddInstructionConfirm,
// defined at the end of the file, replaces them). Everything else this test
// already checked (project name, the onOpen title button, no group Badge,
// no DecidedStatus, no editable state, the New badge) still holds.
// Round 9 Task 3: rewritten with intent -- the card's own three-branch
// recommended-action logic (AddInstructionConfirm/review_skill/test_first
// picked by recommendedPrimaryAction, a separate tertiary Skip/Edit/View
// details row) is gone. One state (instructionState) drives one shared
// InstructionActions component instead -- Add/Skip/Edit/Open (and, for a
// live/attention item this card would also be asked to render, Keep/
// Retire/Test) all come from that one call, never picked here.
test("improvement.tsx: CompactDecisionCard renders project name, an onOpen title button, the state line, the instruction once, and delegates its actions to InstructionActions -- no group Badge, no DecidedStatus, no editable state", () => {
  const compact = compactCardSource(codeOnly(readApp(DETAIL)));
  assert.match(compact, /projectName\(item\)/);
  assert.match(compact, /onOpen/);
  assert.match(compact, /lessonLine\(item\)/);
  assert.match(compact, /item\.proposed_instruction \?\? item\.title/);
  assert.match(compact, /instructionState\(\{/);
  assert.match(compact, /instructionStateLine\(\{/);
  assert.match(compact, /<InstructionActions/);
  assert.ok(
    !/recommendedPrimaryAction|<AddInstructionConfirm\b|<AddConfirm\b|<SkipConfirm\b|<TestButton\b/.test(
      compact,
    ),
    "compact mode must not pick its own action -- InstructionActions does",
  );
  assert.ok(!/DecidedStatus/.test(compact), "compact mode must never render DecidedStatus");
  assert.ok(!/editable/.test(compact), "compact mode must never carry editable state");
  assert.ok(
    !/Badge variant="secondary"/.test(compact),
    "compact mode must never render the group Badge",
  );
  assert.match(compact, /isNew \? <Badge variant="default">New<\/Badge> : null/);
  // Checkpoint 3: prediction paragraphs and the alternative destination
  // collapse under "Why Harness Ledger recommends this"; Round 9 Task 3:
  // Edit/Open are InstructionActions' own small links now, not a separate
  // tertiary row of this card's own.
  assert.match(compact, /<details className="rounded-md border">/);
  assert.match(compact, /\{WHY_RECOMMENDS_TITLE\}/);
  assert.match(compact, /whyFor\(item\.classification\)/);
  assert.ok(
    !/\{EDIT_LABEL\}|\{VIEW_DETAILS_LABEL\}/.test(compact),
    "the old standalone Edit/View details tertiary row is gone",
  );
});

test('improvement.tsx: CompactDecisionCard renders item.unsure as a muted role="status" line when present', () => {
  const compact = compactCardSource(codeOnly(readApp(DETAIL)));
  assert.match(compact, /item\.unsure/);
  assert.match(compact, /role="status"/);
});

test("improvement.tsx: whyFor is imported from @/lib/harness-ux", () => {
  const raw = readApp(DETAIL);
  assert.match(raw, /import\s*\{[^}]*\bwhyFor\b[^}]*\}\s*from\s*"@\/lib\/harness-ux"/s);
});

test("improvement.tsx: SkipConfirm has a 'Why? (optional)' radiogroup with the four reason labels", () => {
  const detail = codeOnly(readApp(DETAIL));
  const confirm = detail.slice(
    detail.indexOf("WRONG_WORDING_TOAST"),
    detail.indexOf("function RetireConfirm"),
  );
  assert.match(confirm, /role="radiogroup"/);
  assert.match(confirm, /aria-label="Why\? \(optional\)"/);
  for (const label of ["Not useful", "Wrong wording", "One-time thing", "Already covered"]) {
    assert.match(confirm, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  // The same roving-tabindex keyboard pattern as AddConfirm's own radiogroup
  // in this file: role="radio" buttons with aria-checked + a shared
  // onKeyDown handling Arrow keys.
  assert.equal(count(confirm, 'role="radio"'), 4, "exactly four reason radios");
  assert.match(confirm, /aria-checked=\{/);
  assert.match(confirm, /ArrowDown|ArrowRight/);
});

test("improvement.tsx: skipping with 'Wrong wording' shows the reopen-from-Suggestions toast; every other case (including no reason) shows the plain 'Skipped' toast", () => {
  const detail = codeOnly(readApp(DETAIL));
  const confirm = detail.slice(
    detail.indexOf("WRONG_WORDING_TOAST"),
    detail.indexOf("function RetireConfirm"),
  );
  assert.match(confirm, /"Skipped — reopen it from Suggestions to fix the wording\."/);
  assert.match(confirm, /"Skipped"/);
});

test("improvement.tsx: SkipConfirm's onConfirm sends the chosen reason to the skip action", () => {
  const detail = codeOnly(readApp(DETAIL));
  const confirm = detail.slice(
    detail.indexOf("WRONG_WORDING_TOAST"),
    detail.indexOf("function RetireConfirm"),
  );
  assert.match(confirm, /action:\s*"skip",\s*id:\s*item\.id/);
  assert.match(confirm, /reason/);
});

// Round 6 Task 4 / spec §4: every button in a card's action bar is the same
// size, so every SkipConfirm call site that still lives directly in a card
// (not behind InstructionActions) carries `size={size}` (a local variable at
// each site, computed from titleAs).
// Round 9 Task 3: CompactDecisionCard's own direct SkipConfirm call went
// first -- InstructionActions renders Skip now, with its own
// `size={btnSize} variant={variant}` call (a different literal shape,
// pinned separately in ux-round9-task3.test.ts).
// Round 9 Task 4: the other two direct call sites (DecidedStatus's own
// hand-built pending-branch bar, and DecisionCard's own non-compact pending
// branch) are gone too -- both were replaced outright by the ONE fixed
// action set per state (InstructionActions, rendered once by DecisionCard
// for every state). No direct `<SkipConfirm item={item} busy={busy}
// run={run} size={size} />` call site is left anywhere in the file.
test("improvement.tsx: no more direct sized SkipConfirm call sites -- Skip only renders through InstructionActions now", () => {
  const detail = codeOnly(readApp(DETAIL));
  const matches = [
    ...detail.matchAll(
      /<SkipConfirm\s+item=\{item\}\s+busy=\{busy\}\s+run=\{run\}\s+size=\{size\}\s*\/>/g,
    ),
  ];
  assert.equal(matches.length, 0, "expected zero direct sized SkipConfirm call sites left");
  assert.match(
    detail,
    /<SkipConfirm item=\{item\} busy=\{busy\} run=\{run\} size=\{btnSize\} variant=\{variant\} \/>/,
    "Skip still renders once, through InstructionActions",
  );
});

test("improvements-client.ts: Improvement gains unsure, decided_by and rank", () => {
  const client = codeOnly(readApp("lib/improvements-client.ts"));
  assert.match(client, /unsure:\s*string \| null/);
  assert.match(client, /decided_by:\s*"user"\s*\|\s*"automatic"\s*\|\s*null/);
  assert.match(client, /rank:\s*number/);
});
