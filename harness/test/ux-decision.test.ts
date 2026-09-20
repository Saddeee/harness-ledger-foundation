// New tests for Task 8 (decision flow, landing and login copy): the
// two-choice Add confirmation, decided cards staying put in the Inbox,
// "Edit instruction", and the landing + login copy. Kept in a separate file
// from ux.test.ts because that file is being edited concurrently by another
// task; the same lightweight, dependency-free local helpers are duplicated
// here on purpose.
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
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const DETAIL = "components/harness/improvement.tsx";
const LAYOUT = "components/harness/decision-layout.tsx";
const INBOX = "routes/_authenticated/inbox.tsx";
const INDEX = "routes/index.tsx";
const LOGIN = "routes/login.tsx";

test("AddConfirm: a two-choice radiogroup above the preview, nothing pre-selected, confirm disabled until chosen", () => {
  const detail = codeOnly(readApp(DETAIL));
  const confirm = detail.slice(
    detail.indexOf("function AddConfirm"),
    detail.indexOf("function SkipConfirm"),
  );
  assert.match(confirm, /role="radiogroup"/);
  assert.match(confirm, /aria-label="How to add it"/);
  assert.equal(count(confirm, 'role="radio"'), 2, "exactly two radio buttons");
  assert.match(confirm, /Add it now/);
  // Round 7 (owner): "Test it first" adds nothing -- you test, compare both
  // builds, and add it afterwards. The old "Add and test it first" added
  // the rule before testing it.
  assert.match(confirm, /\{TEST_FIRST_LABEL\}/);
  assert.ok(!/Add and test it first/.test(confirm));
  assert.match(confirm, /aria-checked=\{choice === "now"\}/);
  assert.match(confirm, /aria-checked=\{choice === "test"\}/);
  // nothing pre-selected
  assert.match(confirm, /useState<"now" \| "test" \| null>\(null\)/);
  // confirm disabled until a choice is made (Round 3 §5 also disables it
  // when the project is already over its active-rule cap)
  assert.match(
    confirm,
    /confirmDisabled=\{\(!wantsTest && \(overCap \|\| overRules\)\) \|\| choice == null\}/,
  );
  assert.match(
    confirm,
    /confirmLabel=\{wantsTest \? START_TEST_LABEL : preview \? "Add" : "Save choice"\}/,
  );
  // the choice resets when the dialog closes
  assert.match(confirm, /onOpenChange=\{/);
  assert.match(confirm, /setChoice\(null\)/);
  // Round 6 Task 6b: posts accept, then (only when the test choice was
  // picked, and only once accept itself succeeded) a `test` action for the
  // same id -- test_first is gone from this dialog entirely.
  assert.match(confirm, /action: "accept",\s*id: item\.id,\s*destination\s*\}/);
  assert.ok(!/test_first/.test(confirm), "test_first is no longer staged from this dialog");
  assert.match(
    confirm,
    /if \(wantsTest\) \{\s*await run\(\s*\{ action: "test", id: item\.id, show_original: showOriginal \},\s*TEST_STARTED_TOAST,?\s*\);\s*return;\s*\}/,
  );
});

test("AddConfirm help text: exact copy for each choice", () => {
  const detail = codeOnly(readApp(DETAIL));
  assert.match(
    detail,
    /Harness Ledger writes this exact text now, when you press Add\. Uses no credits\./,
  );
  // Round 6 Task 6b / spec §6: the real historical-replay flow's own help
  // text -- "not switched on yet" is gone (it is switched on now).
  // Checkpoint 2026-09-18 (WP1b): "compare both builds" is gone -- the
  // second column is a historical result, not a second build.
  const ux = codeOnly(readApp("lib/harness-ux.ts"));
  // Round 9 Task 7 / spec §2 vocabulary: "replays"/"rule" -> "rebuilds"/
  // "instruction".
  assert.match(
    ux,
    /export const TEST_FIRST_HELP =\s*"Nothing is added yet\. Harness Ledger rebuilds your original request in a new copy with this instruction, next to the historical result, and you add it afterwards if it worked\.";/,
  );
  assert.match(detail, /TEST_FIRST_HELP/);
  assert.match(detail, /proveCostLine\(\)/);
  assert.ok(!/Testing is not switched on yet/.test(detail));
});

test("SAVED_LINE and the new toasts", () => {
  const detail = codeOnly(readApp(DETAIL));
  assert.match(detail, /const SAVED_LINE = "Added\.";/);
  assert.match(detail, /"Skipped"/);
  assert.ok(!/Uses no Lovable credits/.test(detail), "the old consequence line is gone");
  // Addendum to Round 6 Task 4: names both places a written rule can be
  // undone from -- Remove from Knowledge on the card, restore an earlier
  // version from History -- not just "restore" alone.
  assert.match(
    detail,
    /"You can remove it from Knowledge or restore an earlier version from History at any time\."/,
  );
});

// Round 9 Task 4 / spec §1-§3: DecidedStatus no longer offers "Add it now
// instead"/alternate-destination Add/Skip at all -- those belonged to the
// old hand-built action bar this task replaced with the ONE fixed action set
// per state (InstructionActions). A decided (accepted) item is always
// "live" now (Round 9 Task 1), whose only actions are Keep/Retire/Test/
// Open; there is no state left in which a decided item still offers Add.
test("Change decision: DecidedStatus offers no Add/Skip of its own any more -- the one action set per state (InstructionActions) replaces it", () => {
  const detail = codeOnly(readApp(DETAIL));
  const decided = detail.slice(
    detail.indexOf("function DecidedStatus"),
    detail.indexOf("export function DecisionCard"),
  );
  assert.ok(!/trigger="Add it now instead"/.test(decided));
  assert.ok(!/<SkipConfirm/.test(decided));
  assert.ok(!/<AddConfirm/.test(decided));
  assert.match(decided, /\{decisionSentence\(/);
});

test("Status ctx: DecisionCard reads executorQueryOptions and forwards connected / test_first to decisionSentence", () => {
  const detail = codeOnly(readApp(DETAIL));
  const card = detail.slice(
    detail.indexOf("export function DecisionCard"),
    detail.indexOf("// ---- Detail pieces"),
  );
  assert.match(card, /useQuery\(executorQueryOptions\)/);
  assert.match(card, /executor\.data\?\.connection\?\.connected/);
  assert.match(card, /testFirst: item\.decision\.test_first/);
  assert.match(card, /<DecidedStatus item=\{item\} busy=\{busy\} run=\{run\} ctx=\{ctx\} \/>/);
  // Round 6 Task 2: a pressed decision writes in the same request -- there
  // is no "next sync" ETA left for the card to forward.
  assert.ok(!/nextSyncAt/.test(card));
});

test("ConfirmAction accepts an optional onOpenChange and forwards it to AlertDialog", () => {
  const layout = codeOnly(readApp(LAYOUT));
  assert.match(layout, /onOpenChange\?: \(open: boolean\) => void;/);
  assert.match(layout, /<AlertDialog \{\.\.\.\(onOpenChange \? \{ onOpenChange \} : \{\}\)\}>/);
});

// Round 3 Task 3a moves editing inside the card (a small "Edit" button on
// the instruction blockquote); the separate below-card "Edit instruction"
// link is gone. See harness/test/ux-round3-decision.test.ts for the new
// in-card editor assertions.
test("Detail: editing is in-card now, no 'Edit instruction' link, no 'Change the wording' left anywhere", () => {
  const detail = codeOnly(readApp(DETAIL));
  assert.ok(!/Edit instruction/.test(detail));
  assert.ok(!/Change the wording/.test(detail));
  assert.ok(!/Cancel wording change/.test(detail));
});

test("Inbox: decided-this-visit items become a confirmation row, the count line is the server's Inbox count", () => {
  // Checkpoint 3: the Inbox reads the unified queue (fetchInbox); items
  // decided this visit stay as confirmation rows with Undo, and the count
  // line is inboxCountLine(count) from the server, never re-derived.
  const inbox = codeOnly(readApp(INBOX));
  assert.match(inbox, /useState<Map<number, string>>/);
  assert.match(inbox, /all\.filter\(\(i\) => confirmed\.has\(i\.id\)\)/);
  assert.match(inbox, /queryFn: fetchInbox/);
  assert.match(inbox, /inboxCountLine\(count\)/);
  assert.ok(!/suggestions are waiting for your decision/.test(inbox));
});

test("harness-ux.ts: LANDING_INTRO and the four HOW_IT_WORKS_STEPS from spec 6.5, verbatim", () => {
  assert.equal(
    ux.LANDING_INTRO,
    "Harness Ledger keeps your Lovable agent improving. It syncs your project chats on a schedule, finds where you had to correct Lovable, and turns each correction into a rule you approve. Harness Ledger writes it into your Lovable Knowledge, keeps every version, and can roll any of them back.",
  );
  assert.deepEqual(
    ux.HOW_IT_WORKS_STEPS.map((s) => s.title),
    ["Synced", "Proposed", "Approved by you", "Written and versioned"],
  );
  assert.deepEqual(
    ux.HOW_IT_WORKS_STEPS.map((s) => s.text),
    [
      "Harness Ledger reads your Lovable chats and Knowledge every hour. No credits, no AI.",
      "Where you corrected Lovable, Harness Ledger's AI analysis proposes one rule, with the exact messages as evidence.",
      "Add it now, test it first in a temporary copy, or skip. Nothing changes until you say so.",
      "Harness Ledger writes the exact text you saw, reads it back to verify, and keeps every version so you can always go back.",
    ],
  );
});

test("Landing page renders the landing copy (HERO_TITLE from landing-copy.ts); login has no 'Internal tool' and its subtitle is 'Sign in to continue.'", () => {
  // Checkpoint 2026-09-18: the landing page's copy moved to
  // src/lib/landing-copy.ts (pinned by ux-landing.test.ts).
  const index = codeOnly(readApp(INDEX));
  assert.match(index, /\{HERO_TITLE\}/);
  assert.match(index, /import \{[^}]*HERO_TITLE[^}]*\} from "@\/lib\/landing-copy"/);

  const login = readApp(LOGIN);
  assert.ok(!/Internal tool/.test(login));
  assert.match(login, /Sign in to continue\./);
});

test("cost accounting stays honest: 'Lovable credits' <= 2 and 'Harness Ledger analysis' == 1 on the detail page", () => {
  const detail = codeOnly(readApp(DETAIL));
  assert.ok(
    count(detail, "Lovable credits") <= 2,
    `Lovable credits x${count(detail, "Lovable credits")}`,
  );
  assert.equal(count(detail, "Harness Ledger analysis"), 1);
});
