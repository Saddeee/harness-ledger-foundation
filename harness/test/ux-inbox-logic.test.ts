// Tests for the "Inbox holds only undecided items; one vocabulary for where
// an item stands" fix. The owner's complaint: an item could sit in the
// Inbox showing an Improvements-style status ("decided cards stay put"),
// while the detail view's stage bar separately called Lovable writes
// "current" before anything was actually written -- two contradictory
// vocabularies for the same fact. This asserts both are gone: the Inbox now
// shows only pending items (a decided item becomes a compact confirmation
// row, not a card), and the stage bar (ProcessProgress) is removed so
// decisionSentence + the group chip are the only places that say where an
// item stands. Page sources are checked structurally (no DOM), same
// convention as ux.test.ts.
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

test("Inbox: no decidedIds, no 'Hide decided', no 'Nothing left to decide' anywhere", () => {
  const inbox = readApp(INBOX);
  assert.ok(!/decidedIds/.test(inbox), "decidedIds must be gone from inbox.tsx");
  assert.ok(!/Hide decided/.test(inbox), "'Hide decided' must be gone from inbox.tsx");
  assert.ok(!/Nothing left to decide/.test(inbox), "'Nothing left to decide' must be gone from inbox.tsx");
});

test("Inbox: a decided item becomes a confirmation row with Undo and View in Improvements", () => {
  const inbox = codeOnly(readApp(INBOX));
  assert.match(inbox, /Undo/);
  assert.match(inbox, /View in Improvements/);
  // Undo reopens through the shared postImprovementAction helper, not a
  // fetch call authored directly in inbox.tsx.
  assert.match(inbox, /import\s*\{[^}]*\bpostImprovementAction\b[^}]*\}\s*from\s*"@\/lib\/improvements-client"/);
  assert.match(inbox, /postImprovementAction\(\{\s*action:\s*"reopen",\s*id\s*\}\)/);
  assert.ok(!/fetch\(/.test(inbox), "inbox.tsx must not call fetch directly -- it goes through the shared client");
  // "View in Improvements" routes to /ledger with the item preselected.
  assert.match(inbox, /navigate\(\{\s*to:\s*"\/ledger",\s*search:\s*\{\s*improvement:\s*\w+(?:\.\w+)?\s*\}\s*\}\)/);
});

test("Inbox: action \"reopen\" is only ever posted through postImprovementAction, never a raw fetch", () => {
  const inbox = readApp(INBOX);
  const lines = inbox.split("\n");
  const reopenLines = lines
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => /action:\s*"reopen"/.test(line));
  assert.ok(reopenLines.length > 0, "expected at least one reopen call site in inbox.tsx");
  for (const { line, i } of reopenLines) {
    const windowText = lines.slice(Math.max(0, i - 3), i + 1).join("\n");
    assert.match(
      windowText,
      /postImprovementAction\(/,
      `"action: \\"reopen\\"" (line ${i + 1}: ${line.trim()}) must be posted via postImprovementAction`,
    );
  }
});

test("improvement.tsx: no ProcessProgress stage bar", () => {
  const detail = readApp(DETAIL);
  assert.ok(!/<ProcessProgress/.test(detail), "the stage bar must be removed from ImprovementDetail");
  assert.ok(!/ProcessProgress/.test(detail), "no remaining reference to ProcessProgress at all");
});

test("decision-layout.tsx: ProcessProgress component removed", () => {
  const layout = readApp(LAYOUT);
  assert.ok(!/export function ProcessProgress/.test(layout));
  assert.ok(!/STAGE_STATE_SR/.test(layout));
});

test("harness-ux.ts still exports STAGE_LABELS and the Stage type (the API still sends stages; tests import the type)", async () => {
  const ux = await import("../../src/lib/harness-ux.ts");
  assert.ok(ux.STAGE_LABELS);
  assert.deepEqual(Object.values(ux.STAGE_LABELS), ["Found", "Your review", "Proof", "In Lovable"]);
});

test("Detail view for a just-decided item still renders the decided card (chip + sentence + inline decision buttons)", () => {
  const detail = codeOnly(readApp(DETAIL));
  const card = detail.slice(
    detail.indexOf("export function DecisionCard"),
    detail.indexOf("export function ImprovementDetail"),
  );
  assert.match(card, /pending \? null : <Badge variant="secondary">\{groupOf\(item\)\}<\/Badge>/);
  assert.match(card, /<DecidedStatus item=\{item\} busy=\{busy\} run=\{run\} ctx=\{ctx\} \/>/);
  const decided = detail.slice(detail.indexOf("function DecidedStatus"), detail.indexOf("export function DecisionCard"));
  assert.match(decided, /decisionSentence\(/, "the status sentence is decisionSentence's output");
});

// ---- Constraints unchanged by this fix ----

test("unchanged: exactly two role=\"radio\" buttons in AddConfirm", () => {
  const detail = codeOnly(readApp(DETAIL));
  const confirm = detail.slice(detail.indexOf("function AddConfirm"), detail.indexOf("function SkipConfirm"));
  assert.equal(count(confirm, 'role="radio"'), 2, "exactly two radio buttons");
});

test("unchanged: 'Lovable credits' <= 2 and 'Harness analysis' exactly 1 on the detail page", () => {
  const detail = codeOnly(readApp(DETAIL));
  assert.ok(count(detail, "Lovable credits") <= 2, `Lovable credits x${count(detail, "Lovable credits")}`);
  assert.equal(count(detail, "Harness analysis"), 1);
});

test("unchanged: no <details open> anywhere in the layout or detail components", () => {
  for (const rel of [LAYOUT, DETAIL]) {
    const code = codeOnly(readApp(rel));
    for (const tag of code.match(/<details[^>]*>/g) ?? []) {
      assert.ok(!/\sopen\b/.test(tag), `collapsed by default, got: ${tag} in ${rel}`);
    }
  }
});

test("unchanged: only local harness routes are fetched, and inbox.tsx/improvement.tsx never call fetch directly", () => {
  for (const rel of [INBOX, DETAIL]) {
    const code = codeOnly(readApp(rel));
    const targets = [...code.matchAll(/fetch\("([^"]+)"/g)].map((m) => m[1]);
    assert.equal(targets.length, 0, `${rel} must not call fetch directly -- it goes through the shared client`);
  }
});
