// UX round 8 (2026-09-19), Task 2: dismiss failed actions (review item 2).
// Pure-helper tests for failedSummaryParts/inboxLinkPageLabel/
// inboxPrimaryLinkConsequence/DISMISS_* (src/lib/harness-ux.ts) plus
// structural (text-only) pins on improvement.tsx, the improvements POST
// route, adapter.ts and mcp-server.ts -- none of these import store.js/
// db.js, so this file never opens a database (see inbox-dismiss.test.ts for
// the DB-backed migration/store/improvements/MCP behaviour). Same
// lightweight, dependency-free readApp/readHarness/codeOnly pattern as
// ux-round8-task1.test.ts (kept in its own new file per the global
// constraints).
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

const IMPROVEMENT = "components/harness/improvement.tsx";
const ROUTE = "routes/api/public/harness/improvements.ts";

// ---- 1. failedSummaryParts ----

test("harness-ux.ts: failedSummaryParts -- null/empty summary falls back to 'Something failed.'", () => {
  assert.deepEqual(ux.failedSummaryParts(null), { plain: "Something failed.", technical: null });
  assert.deepEqual(ux.failedSummaryParts(""), { plain: "Something failed.", technical: null });
  assert.deepEqual(ux.failedSummaryParts("   "), {
    plain: "Something failed.",
    technical: null,
  });
});

test("harness-ux.ts: failedSummaryParts -- a raw Lovable error (starts with 'Lovable', or contains REST/API error/a 3-digit status code) is hidden behind 'Something failed in Lovable.'", () => {
  assert.deepEqual(ux.failedSummaryParts("Lovable returned an unexpected response"), {
    plain: "Something failed in Lovable.",
    technical: "Lovable returned an unexpected response",
  });
  assert.deepEqual(ux.failedSummaryParts("The REST call to Lovable failed"), {
    plain: "Something failed in Lovable.",
    technical: "The REST call to Lovable failed",
  });
  assert.deepEqual(ux.failedSummaryParts("Lovable API error: could not write"), {
    plain: "Something failed in Lovable.",
    technical: "Lovable API error: could not write",
  });
  assert.deepEqual(ux.failedSummaryParts("Request failed with status 400"), {
    plain: "Something failed in Lovable.",
    technical: "Request failed with status 400",
  });
  assert.deepEqual(ux.failedSummaryParts("Request failed with status 499"), {
    plain: "Something failed in Lovable.",
    technical: "Request failed with status 499",
  });
});

test("harness-ux.ts: failedSummaryParts -- an already-plain summary passes through unchanged, with no technical fold", () => {
  assert.deepEqual(ux.failedSummaryParts("This test run failed."), {
    plain: "This test run failed.",
    technical: null,
  });
  assert.deepEqual(ux.failedSummaryParts("Deleting the test copy in Lovable failed."), {
    plain: "Deleting the test copy in Lovable failed.",
    technical: null,
  });
});

// ---- 2. inboxLinkPageLabel / inboxPrimaryLinkConsequence ----

test("harness-ux.ts: inboxLinkPageLabel maps every action_failed link.page to a plain-words label, never the raw enum value", () => {
  assert.equal(ux.inboxLinkPageLabel("tests"), "Tests");
  assert.equal(ux.inboxLinkPageLabel("instructions"), "Instructions");
  assert.equal(ux.inboxLinkPageLabel("skills"), "Skills");
  assert.equal(ux.inboxLinkPageLabel("history"), "History");
});

test("harness-ux.ts: inboxPrimaryLinkConsequence reads exactly 'Opens <page>. Nothing changes until you decide.'", () => {
  assert.equal(
    ux.inboxPrimaryLinkConsequence(ux.inboxLinkPageLabel("tests")),
    "Opens Tests. Nothing changes until you decide.",
  );
  assert.equal(
    ux.inboxPrimaryLinkConsequence(ux.inboxLinkPageLabel("skills")),
    "Opens Skills. Nothing changes until you decide.",
  );
});

// ---- 3. Dismiss label + consequence line, pinned ----

test("harness-ux.ts: DISMISS_LABEL and DISMISS_CONSEQUENCE_LINE read exactly as specified", () => {
  assert.equal(ux.DISMISS_LABEL, "Dismiss");
  assert.equal(
    ux.DISMISS_CONSEQUENCE_LINE,
    "Removes this from your Inbox. Nothing changes in Lovable; the record stays on its page.",
  );
});

// ---- 4. improvement.tsx: ActionFailedCard wiring ----

test("improvement.tsx: ActionFailedCard renders a secondary outline Dismiss button that posts dismiss_inbox_item with this item's id", () => {
  const code = codeOnly(readApp(IMPROVEMENT));
  const card = code.slice(
    code.indexOf("export function ActionFailedCard"),
    code.indexOf("// ---- end Checkpoint 3 I2 ----"),
  );
  assert.match(card, /\{DISMISS_LABEL\}/);
  assert.match(card, /\{DISMISS_CONSEQUENCE_LINE\}/);
  assert.match(card, /action:\s*"dismiss_inbox_item"/);
  assert.match(card, /item_id:\s*item\.id/);
  // The Dismiss button is styled as a secondary outline button (its own
  // <Button ... {DISMISS_LABEL}</Button> tag carries variant="outline").
  const dismissAt = card.indexOf('void run({ action: "dismiss_inbox_item"');
  const dismissButtonStart = card.lastIndexOf("<Button", dismissAt);
  const dismissButtonEnd = card.indexOf("{DISMISS_LABEL}", dismissAt);
  assert.match(card.slice(dismissButtonStart, dismissButtonEnd), /variant="outline"/);
});

test("improvement.tsx: ActionFailedCard never shows a raw Lovable error as its main summary line -- failedSummaryParts feeds the visible text and a collapsed 'Technical details' fold", () => {
  const code = codeOnly(readApp(IMPROVEMENT));
  const card = code.slice(
    code.indexOf("export function ActionFailedCard"),
    code.indexOf("// ---- end Checkpoint 3 I2 ----"),
  );
  assert.match(card, /const \{ plain, technical \} = failedSummaryParts\(item\.summary\);/);
  assert.match(card, /<p className="text-sm text-muted-foreground">\{plain\}<\/p>/);
  assert.match(card, /Technical details/);
  assert.match(card, /<details className="rounded-md border">/);
  // Every <details> stays collapsed by default (global constraint).
  assert.ok(!/<details[^>]*\bopen\b/.test(card), "no <details> in this card may default open");
});

test("improvement.tsx: the primary link's own consequence line uses inboxLinkPageLabel/inboxPrimaryLinkConsequence, never the generic 'review_rule' wording", () => {
  const code = codeOnly(readApp(IMPROVEMENT));
  const card = code.slice(
    code.indexOf("export function ActionFailedCard"),
    code.indexOf("// ---- end Checkpoint 3 I2 ----"),
  );
  assert.match(card, /\{inboxPrimaryLinkConsequence\(inboxLinkPageLabel\(item\.link\.page\)\)\}/);
  assert.ok(
    !/inboxActionConsequence\("review_rule"\)/.test(card),
    "ActionFailedCard must no longer use the generic review_rule consequence line",
  );
});

// ---- 5. Route: dismiss_inbox_item handled the same way mark_seen is ----

test("routes/api/public/harness/improvements.ts: POST handles action === 'dismiss_inbox_item' before the discriminated-union call, calling adapter.dismissInboxItem", () => {
  const code = codeOnly(readApp(ROUTE));
  const markSeenAt = code.indexOf('body["action"] === "mark_seen"');
  const dismissAt = code.indexOf('body["action"] === "dismiss_inbox_item"');
  const unionCallAt = code.indexOf("adapter.improvementActionAndWrite(body)");
  assert.ok(markSeenAt >= 0 && dismissAt >= 0 && unionCallAt >= 0);
  assert.ok(dismissAt > markSeenAt, "dismiss_inbox_item should be handled alongside mark_seen");
  assert.ok(
    dismissAt < unionCallAt,
    "dismiss_inbox_item must be handled before the discriminated-union action call",
  );
  const dismissBranch = code.slice(dismissAt, code.indexOf("if (", dismissAt + 10));
  assert.match(dismissBranch, /adapter\.dismissInboxItem\(/);
  assert.match(dismissBranch, /available: true, ok: result\.ok, item_id: result\.item_id/);
});

// ---- 6. adapter.ts / mcp-server.ts: dismissInboxItem exported and the MCP tool exists ----

test("adapter.ts exports dismissInboxItem", () => {
  const code = readHarness("src/adapter.ts");
  assert.match(code, /export \{ dismissInboxItem \} from "\.\/improvements\.js";/);
});

test("mcp-server.ts registers dismiss_inbox_item with an item_id string param, calling adapter.dismissInboxItem", () => {
  const code = codeOnly(readHarness("src/mcp-server.ts"));
  const at = code.indexOf('"dismiss_inbox_item"');
  assert.ok(at >= 0, "dismiss_inbox_item tool must be registered");
  const block = code.slice(at, code.indexOf(");", code.indexOf("adapter.dismissInboxItem", at)));
  assert.match(block, /item_id:\s*z\.string\(\)/);
  assert.match(block, /adapter\.dismissInboxItem\(input\.item_id\)/);
});
