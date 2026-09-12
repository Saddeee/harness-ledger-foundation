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
    "Harness rewrites your Knowledge without it now. You can re-add it later.",
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
  assert.ok(/Restore this version/.test(timeline));
});

test("improvement.tsx: Remove from Knowledge replaces Restore on a written rule's card, through the retire action", () => {
  const raw = readApp(DETAIL);
  const code = codeOnly(raw);

  assert.match(code, /function RemoveFromKnowledgeConfirm/);
  assert.match(code, /REMOVE_FROM_KNOWLEDGE_TITLE/);
  assert.match(code, /REMOVE_FROM_KNOWLEDGE_BODY/);
  assert.match(code, /REMOVE_FROM_KNOWLEDGE_CONFIRM_LABEL/);
  assert.ok(raw.includes('trigger="Remove from Knowledge"'));
  // Remove goes through the same "retire" action as everywhere else
  // (improvementActionAndWrite already writes for "retire" -- see
  // executor/beats.ts), addressed by rule_id, never a correction id.
  assert.match(code, /action: "retire", rule_id: ruleId/);
  assert.match(
    code,
    /accepted && written && ruleId != null[\s\S]{0,80}<RemoveFromKnowledgeConfirm/,
  );
});

test("improvement.tsx: Undo is a plain ghost button (no confirm dialog), wired to the 'undo' action, on both the ordinary and the retired-not-yet-removed branch", () => {
  const raw = readApp(DETAIL);
  const code = codeOnly(raw);
  const decided = code.slice(
    code.indexOf("function DecidedStatus"),
    code.indexOf("function CompactDecisionCard"),
  );

  // Undo never opens a ConfirmAction -- it's a plain Button.
  const undoCalls = [...decided.matchAll(/action: "undo", id: item\.id/g)];
  assert.equal(undoCalls.length, 2, "Undo appears on both the retired and the ordinary branch");
  assert.match(decided, />\s*Undo\s*</, "Undo renders as its own button label");
  assert.match(decided, /UNDO_TOAST/);
  assert.match(
    decided,
    /variant="ghost"[\s\S]{0,120}onClick=\{\(\) => void run\(\{ action: "undo"/,
  );

  // The visibility rule (spec §3 / the task brief): write_status
  // none|pending|stale|failed, or (for a retired rule) its own removal
  // rewrite not yet written.
  assert.match(decided, /retirement_write_status/);
  assert.match(decided, /canUndo/);
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
