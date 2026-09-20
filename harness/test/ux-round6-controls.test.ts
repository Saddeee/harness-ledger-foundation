// Round 6 Task 3 / spec §3: structural tests for Undo, Cancel, and Remove
// from Knowledge; Restore lives on the History page only. Same lightweight,
// dependency-free local helpers as ux-round4-retire.test.ts (kept in its own
// file per the task instructions -- other tasks are editing the shared UX
// test files concurrently).
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

const DETAIL = "components/harness/improvement.tsx";
const INSTRUCTIONS_PAGE = "routes/_authenticated/instructions.tsx";
const HISTORY_PAGE = "routes/_authenticated/history.tsx";
const TIMELINE = "components/harness/timeline.tsx";
const INBOX_PAGE = "routes/_authenticated/inbox.tsx";
const CLIENT = "lib/improvements-client.ts";

test("harness-ux.ts: the exact Round 6 Task 3 copy, verbatim", () => {
  assert.equal(ux.UNDO_TOAST, "Undone — back in your Inbox");
  assert.equal(ux.CANCEL_WRITE_TOAST, "Cancelled — back in your Inbox");
  assert.equal(ux.REMOVE_FROM_KNOWLEDGE_TITLE, "Remove this rule from Knowledge?");
  assert.equal(
    ux.REMOVE_FROM_KNOWLEDGE_BODY,
    "Harness Ledger rewrites your Knowledge without it now. You can re-add it later.",
  );
  assert.equal(ux.REMOVE_FROM_KNOWLEDGE_CONFIRM_LABEL, "Remove");
});

test("improvement.tsx: no 'Restore previous version' anywhere; history.tsx and timeline.tsx still offer a restore", () => {
  const detail = readApp(DETAIL);
  assert.ok(
    !/Restore previous version/.test(detail),
    "Restore left the Suggestions card entirely -- it lives on the History page only",
  );
  assert.ok(
    !/action: "restore"/.test(codeOnly(detail)),
    "improvement.tsx must never stage a restore itself any more",
  );

  // History (via postKnowledge) and its Timeline component (the actual
  // "Restore this version" trigger) are untouched by this task.
  const history = readApp(HISTORY_PAGE);
  const timeline = readApp(TIMELINE);
  assert.match(codeOnly(history), /action: "restore"/);
  assert.ok(/Undo this change/.test(timeline));
});

// Round 9 Task 4 / spec §2-§3 vocabulary: "Remove from Knowledge" is a
// banned synonym now -- RemoveFromKnowledgeConfirm stays exported (judge.tsx
// and instructions.tsx still import it) but is renamed to Retire's own exact
// copy (RETIRE_TITLE/RETIRE_BODY/RETIRE_CONSEQUENCES, the same as
// RetireConfirm's), and no longer has a call site of its own inside
// improvement.tsx -- DecidedStatus's whole hand-built bar (the
// "accepted && written && ruleId != null" branch this test used to pin) is
// gone, replaced by InstructionActions' own fixed Retire button.
test("improvement.tsx: RemoveFromKnowledgeConfirm is renamed to Retire's own copy, through the same retire action, with no call site of its own left", () => {
  const raw = readApp(DETAIL);
  const code = codeOnly(raw);

  assert.match(code, /function RemoveFromKnowledgeConfirm/);
  assert.match(code, /trigger=\{INSTRUCTION_ACTION_LABELS\.retire\}/);
  assert.ok(!raw.includes("Remove from Knowledge"));
  // Remove goes through the same "retire" action as everywhere else
  // (improvementActionAndWrite already writes for "retire" -- see
  // executor/beats.ts), addressed by rule_id, never a correction id.
  assert.match(code, /action: "retire", rule_id: ruleId/);
  assert.ok(
    !/<RemoveFromKnowledgeConfirm/.test(code),
    "no call site of its own left inside improvement.tsx",
  );
});

// Round 9 Task 4 / spec §1-§3: DecidedStatus no longer has separate
// "retired"/"ordinary" branches at all -- both collapsed into the same
// `canUndo` check (a decided item's Undo means exactly the same thing
// either way: the write never reached Lovable). Undo is now a small text
// link (SMALL_ACTION_LINK_CLASS), not a shadcn ghost Button, matching the
// weight of InstructionActions' own small Edit/Open actions -- there is
// only ONE occurrence of the "undo" action left in DecidedStatus, not two.
test("improvement.tsx: Undo is a single small text link (no confirm dialog), wired to the 'undo' action, gated on lovable.can_undo", () => {
  const raw = readApp(DETAIL);
  const code = codeOnly(raw);
  const decided = code.slice(
    code.indexOf("function DecidedStatus"),
    code.indexOf("function CompactDecisionCard"),
  );

  // Undo never opens a ConfirmAction -- it's a plain <button>.
  const undoCalls = [...decided.matchAll(/action: "undo", id: item\.id/g)];
  assert.equal(undoCalls.length, 1, "Undo appears exactly once now (one canUndo check, not two)");
  assert.match(decided, />\s*Undo\s*</, "Undo renders as its own label");
  assert.match(decided, /UNDO_TOAST/);
  assert.match(
    decided,
    /className=\{SMALL_ACTION_LINK_CLASS\}[\s\S]{0,120}onClick=\{\(\) => void run\(\{ action: "undo"/,
  );

  // Round 6 Task 4 / spec §4: rewritten with intent -- the visibility rule
  // is no longer re-derived here from write_status/retirement_write_status
  // (Round 6 Task 3 fix 1 found that this let Undo demote a rule that was
  // still live in Lovable); it reads the server-computed
  // lovable.can_undo flag directly, the same fix inbox.tsx's own Undo uses.
  assert.match(decided, /const canUndo = lovable\.can_undo;/);
  assert.ok(
    !/retirement_write_status/.test(decided),
    "DecidedStatus must not re-derive canUndo from write_status any more",
  );
});

test("improvement.tsx: the old skipped-only 'Reopen' button is gone, folded into the unified Undo", () => {
  const code = codeOnly(readApp(DETAIL));
  const decided = code.slice(
    code.indexOf("function DecidedStatus"),
    code.indexOf("function CompactDecisionCard"),
  );
  assert.ok(!/>\s*Reopen\s*</.test(decided), "no separate 'Reopen' label left in DecidedStatus");
  assert.ok(!/action: "reopen", id: item\.id/.test(decided));
});

test("instructions.tsx: the pending-write banner offers Cancel via cancel_write, next to Sync now", () => {
  const raw = readApp(INSTRUCTIONS_PAGE);
  const code = codeOnly(raw);

  assert.match(code, /action: "cancel_write", version_id: versionId/);
  assert.ok(raw.includes("CANCEL_WRITE_TOAST"));
  const bannerStart = code.indexOf("target.pending_write ? (");
  const banner = code.slice(bannerStart, code.indexOf("Sync now", bannerStart));
  assert.match(banner, />\s*Cancel\s*</);
  assert.match(banner, /onClick=\{\(\) => onCancelWrite\(target\.pending_write!\.version_id\)\}/);

  // Still uses the client wrapper, never a raw fetch.
  assert.match(code, /postImprovementAction/);
  assert.ok(!/\bfetch\(/.test(code), "instructions.tsx must not call fetch directly");
});

test("instructions.tsx: no <details open> anywhere (unchanged by this task, still holds)", () => {
  const code = codeOnly(readApp(INSTRUCTIONS_PAGE));
  for (const tag of code.match(/<details[^>]*>/g) ?? []) {
    assert.ok(!/\sopen\b/.test(tag), `details tag must not be open: ${tag}`);
  }
});

// ---- Round 6 Task 3 fix 1: undo/cancel_write must never demote a rule
// that's still live in Lovable (rule.state === "active"), which write_status
// alone cannot tell -- a later wording-change rewrite can read pending/
// stale/failed for a rule that's still exactly what's live. improvements.ts
// now computes lovable.can_undo/can_cancel_write server-side (the same
// isRuleLive/controlFlags the "undo"/"cancel_write" actions themselves
// enforce -- see harness/test/improvements.test.ts), and inbox.tsx's own
// Undo -- unguarded before this fix, since Accept can write inline -- reads
// it instead of assuming every just-decided item is safe to reopen. ----

test("inbox.tsx: Undo posts the guarded 'undo' action (never the plain 'reopen'), gated on lovable.can_undo, and shows 'Written to Lovable' + Open once the item reads back written", () => {
  const raw = readApp(INBOX_PAGE);
  const code = codeOnly(raw);

  assert.match(code, /postImprovementAction\(\{\s*action:\s*"undo",\s*id\s*\}\)/);
  assert.ok(!/action:\s*"reopen"/.test(raw), "inbox.tsx must never post the unguarded 'reopen'");

  assert.match(code, /import\s*\{[^}]*\blovableOf\b[^}]*\}\s*from\s*"@\/lib\/improvements-client"/);
  const row = code.slice(code.indexOf("function ConfirmationRow"), code.indexOf("function Page"));
  assert.match(row, /const lovable = lovableOf\(item\);/);
  assert.match(row, /const written = lovable\.write_status === "written";/);
  assert.match(row, /const canUndo = item\.kind !== "retire" && lovable\.can_undo;/);
  assert.match(row, /written \? "Written to Lovable" : message/);
  assert.match(row, /\{!written && canUndo \? \(/);
});

test("lib/improvements-client.ts: LovableInfo carries can_undo/can_cancel_write, and lovableOf's fallback fails closed (both false)", () => {
  const code = codeOnly(readApp(CLIENT));
  assert.match(code, /can_undo: boolean;/);
  assert.match(code, /can_cancel_write: boolean;/);
  const fallback = code.slice(
    code.indexOf("export function lovableOf"),
    code.indexOf("export function groupOf"),
  );
  assert.match(fallback, /can_undo: false,/);
  assert.match(fallback, /can_cancel_write: false,/);
});
