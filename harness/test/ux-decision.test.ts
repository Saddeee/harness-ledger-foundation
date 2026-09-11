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
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*") && !t.startsWith("{/*");
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
  assert.match(confirm, /Test it first/);
  assert.match(confirm, /aria-checked=\{choice === "now"\}/);
  assert.match(confirm, /aria-checked=\{choice === "test"\}/);
  // nothing pre-selected
  assert.match(confirm, /useState<"now" \| "test" \| null>\(null\)/);
  // confirm disabled until a choice is made
  assert.match(confirm, /confirmDisabled=\{overCap \|\| choice == null\}/);
  assert.match(confirm, /confirmLabel=\{wantsTest \? "Save for testing" : preview \? "Add" : "Save choice"\}/);
  // the choice resets when the dialog closes
  assert.match(confirm, /onOpenChange=\{/);
  assert.match(confirm, /setChoice\(null\)/);
  // posts the two documented shapes
  assert.match(confirm, /action: "accept",\s*id: item\.id,\s*destination,/);
  assert.match(confirm, /test_first: true/);
  assert.match(confirm, /"Saved for testing\."/);
});

test("AddConfirm help text: exact copy for each choice", () => {
  const detail = codeOnly(readApp(DETAIL));
  assert.match(
    detail,
    /Harness writes this exact text at the next sync\. Uses no credits\./,
  );
  assert.match(
    detail,
    /Harness runs the same request with and without this instruction in a temporary copy of the project and shows you the difference before anything is written\./,
  );
  assert.match(detail, /proveCostLine\(item\.proof\?\.lovable_credits_max\)/);
  assert.match(
    detail,
    /Testing is not switched on yet; your choice is saved and runs when it is\./,
  );
});

test("SAVED_LINE and the new toasts", () => {
  const detail = codeOnly(readApp(DETAIL));
  assert.match(
    detail,
    /const SAVED_LINE = "Added — will be written at the next sync\.";/,
  );
  assert.match(detail, /"Skipped"/);
  assert.ok(!/Uses no Lovable credits/.test(detail), "the old consequence line is gone");
  assert.match(detail, /"You can restore the previous version at any time\."/);
});

test("Change decision: a test_first item with no pending write offers 'Add it now instead' via the same two-choice AddConfirm", () => {
  const detail = codeOnly(readApp(DETAIL));
  const decided = detail.slice(
    detail.indexOf("function DecidedStatus"),
    detail.indexOf("export function DecisionCard"),
  );
  assert.match(decided, /trigger="Add it now instead"/);
  assert.match(decided, /item\.decision\.test_first/);
  // alternate-destination + Skip are still offered
  assert.match(decided, /trigger=\{`\$\{ADD_LABELS\[d\]\} instead`\}/);
  assert.match(decided, /<SkipConfirm item=\{item\} busy=\{busy\} run=\{run\} \/>/);
});

test("Status ctx: DecisionCard reads executorQueryOptions and forwards next_run_at / connected / test_first to decisionSentence", () => {
  const detail = codeOnly(readApp(DETAIL));
  const card = detail.slice(
    detail.indexOf("export function DecisionCard"),
    detail.indexOf("// ---- Detail pieces"),
  );
  assert.match(card, /useQuery\(executorQueryOptions\)/);
  assert.match(card, /executor\.data\?\.next_run_at \?\? null/);
  assert.match(card, /executor\.data\?\.connection\?\.connected/);
  assert.match(card, /testFirst: item\.decision\.test_first/);
  assert.match(card, /<DecidedStatus item=\{item\} busy=\{busy\} run=\{run\} ctx=\{ctx\} \/>/);
});

test("ConfirmAction accepts an optional onOpenChange and forwards it to AlertDialog", () => {
  const layout = codeOnly(readApp(LAYOUT));
  assert.match(layout, /onOpenChange\?: \(open: boolean\) => void;/);
  assert.match(layout, /<AlertDialog \{\.\.\.\(onOpenChange \? \{ onOpenChange \} : \{\}\)\}>/);
});

test("Detail: 'Edit instruction' / 'Cancel', no 'Change the wording' left anywhere", () => {
  const detail = codeOnly(readApp(DETAIL));
  assert.match(detail, /Edit instruction/);
  assert.ok(!/Change the wording/.test(detail));
  assert.ok(!/Cancel wording change/.test(detail));
  // the toggle button reads "Edit instruction" / "Cancel"
  assert.match(detail, /\{editing \? "Cancel" : "Edit instruction"\}/);
});

test("Inbox: decided-this-session cards stay put, 'Hide decided' clears them, count line counts pending only", () => {
  const inbox = codeOnly(readApp(INBOX));
  assert.match(inbox, /useState<Set<number>>/);
  assert.match(inbox, /Hide decided/);
  assert.match(inbox, /decidedIds\.size > 0/);
  assert.match(inbox, /setDecidedIds\(new Set\(\)\)/);
  // list = pending plus decided-this-session, taken from `all` (original order)
  assert.match(inbox, /all\.filter\(\(i\) => i\.decision\.status === "pending" \|\| decidedIds\.has\(i\.id\)\)/);
  // the count line still counts pending only
  assert.match(inbox, /"One improvement is waiting for your decision\."/);
  assert.match(inbox, /`\$\{pending\.length\} improvements are waiting for your decision\.`/);
});

test("harness-ux.ts: LANDING_INTRO and the four HOW_IT_WORKS_STEPS from spec 6.5, verbatim", () => {
  assert.equal(
    ux.LANDING_INTRO,
    "Harness Ledger keeps your Lovable agent improving. It syncs your project chats on a schedule, finds where you had to correct Lovable, and turns each correction into a standing instruction. You approve; Harness writes it into your Lovable Knowledge, keeps every version, and can roll any of them back.",
  );
  assert.deepEqual(
    ux.HOW_IT_WORKS_STEPS.map((s) => s.title),
    ["Synced", "Proposed", "Approved by you", "Written and versioned"],
  );
  assert.deepEqual(
    ux.HOW_IT_WORKS_STEPS.map((s) => s.text),
    [
      "Harness reads your Lovable chats and Knowledge every hour. No credits, no AI.",
      "Where you corrected Lovable, Harness proposes one instruction, with the exact messages as evidence.",
      "Add it now, test it first in a temporary copy, or skip. Nothing changes until you say so.",
      "Harness writes the exact text you saw, reads it back to verify, and keeps every version so you can always go back.",
    ],
  );
});

test("Landing page renders LANDING_INTRO; login has no 'Internal tool' and its subtitle is 'Sign in to continue.'", () => {
  const index = codeOnly(readApp(INDEX));
  assert.match(index, /LANDING_INTRO/);
  assert.match(index, /import \{[^}]*LANDING_INTRO[^}]*\} from "@\/lib\/harness-ux"/);

  const login = readApp(LOGIN);
  assert.ok(!/Internal tool/.test(login));
  assert.match(login, /Sign in to continue\./);
});

test("cost accounting stays honest: 'Lovable credits' <= 2 and 'Harness analysis' == 1 on the detail page", () => {
  const detail = codeOnly(readApp(DETAIL));
  assert.ok(count(detail, "Lovable credits") <= 2, `Lovable credits x${count(detail, "Lovable credits")}`);
  assert.equal(count(detail, "Harness analysis"), 1);
});
