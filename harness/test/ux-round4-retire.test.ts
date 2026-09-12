// Round 4 Task C2 / spec §4b-§5: structural tests for the Retire / Keep /
// Re-add UI. Same lightweight, dependency-free local helpers as ux.test.ts
// (kept in its own file per the task instructions -- other tests are being
// edited concurrently).
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
const CLIENT = "lib/improvements-client.ts";
// Task C3: the Inbox page's own "mark_seen" POST (see
// ux-round4-health.test.ts) is not an Improvement action -- it's read into
// the same action-set test below only so the one enumeration test in this
// file stays the single source of truth for every `action: "..."` literal
// across the pages that talk to /api/public/harness/improvements.
const INBOX = "routes/_authenticated/inbox.tsx";

test("harness-ux.ts: IMPROVEMENT_GROUPS gains 'Retired' after 'Reverted'; improvementGroup(retired) wins over writeStatus", () => {
  assert.deepEqual(
    [...ux.IMPROVEMENT_GROUPS],
    [
      "Waiting to be written",
      "Waiting to be tested",
      "In Lovable",
      "Reverted",
      "Retired",
      "Needs attention",
      "Skipped",
    ],
  );

  const g = (
    status: "pending" | "accepted" | "skipped",
    writeStatus: ux.LovableWriteStatus | null,
    retired: boolean,
  ) => ux.improvementGroup({ status, writeStatus, testFirst: false, retired });

  assert.equal(g("accepted", "written", true), "Retired", "retired wins over a written status");
  assert.equal(g("accepted", "reverted", true), "Retired", "retired wins over a reverted status");
  assert.equal(g("accepted", "none", true), "Retired");
  assert.equal(g("accepted", "written", false), "In Lovable", "unretired items are unaffected");
  assert.equal(g("skipped", null, true), "Skipped", "skipped still wins over retired");
  assert.equal(g("pending", null, true), null, "pending items stay out of Improvements either way");
  // Omitting `retired` altogether must behave exactly like `false` (every
  // existing caller in improvements.test.ts omits it).
  assert.equal(
    ux.improvementGroup({ status: "accepted", writeStatus: "written", testFirst: false }),
    "In Lovable",
  );
});

test("harness-ux.ts: retireReasonSentence and retireSinceLine cover all three reasons", () => {
  const hurt = ux.retireReasonSentence({
    reason: "hurt",
    health: { applicable_tasks: 4, helped: 1, hurt: 3, last_applicable_at: "2026-09-01T00:00:00Z" },
    since: "2026-08-01T00:00:00Z",
  });
  // Fix round 1 item 2: "helped" left the retire reason sentence too --
  // same honest vocabulary as healthLine.
  assert.equal(
    hurt,
    "Harness suggests retiring this rule because more of its builds had a repeat correction than didn't.",
  );

  const contradiction = ux.retireReasonSentence({
    reason: "contradiction",
    health: { applicable_tasks: 0, helped: 0, hurt: 0, last_applicable_at: null },
    since: null,
    contradicts_instruction: "Always use dark mode by default.",
  });
  assert.equal(
    contradiction,
    "Harness suggests retiring this rule because it contradicts Always use dark mode by default.",
  );

  const unused = ux.retireReasonSentence({
    reason: "unused",
    health: { applicable_tasks: 0, helped: 0, hurt: 0, last_applicable_at: null },
    since: null,
  });
  assert.equal(
    unused,
    "Harness suggests retiring this rule because it has not applied in 60 days.",
  );

  const sinceLine = ux.retireSinceLine({
    reason: "hurt",
    health: { applicable_tasks: 4, helped: 1, hurt: 3, last_applicable_at: "2026-09-01T00:00:00Z" },
    since: "2026-08-01T00:00:00Z",
  });
  // Fix round 1 item 2: retireSinceLine's "hurt" case now reuses healthLine
  // itself, so the wording (and honesty guarantee) can never drift apart.
  assert.equal(
    sinceLine,
    "Since added: 4 builds in this area · 3 repeat corrections · last used 1 Sep · observed from your real builds",
  );
});

test("improvement.tsx: kind 'retire' items render the reason, the since line, and Retire/Keep; decided 'Retired' items show Re-add", () => {
  const raw = readApp(DETAIL);
  const code = codeOnly(raw);

  assert.match(code, /item\.kind === "retire"/);
  assert.match(code, /retireReasonSentence/);
  assert.match(code, /retireSinceLine/);

  // Retire confirm: same copy shape as the spec.
  assert.ok(raw.includes("Retire this rule?"));
  assert.ok(raw.includes("Harness will rewrite your Knowledge without it at the next sync."));
  assert.ok(raw.includes("You can re-add it later from Suggestions."));

  // Keep is a ghost button with its own toast, not a confirm dialog.
  assert.match(code, /variant="ghost"[\s\S]{0,200}action: "keep"/);
  assert.ok(raw.includes("Kept — Harness will ask again in 30 days"));

  // The retire/keep action bodies use the proposal's negative id.
  assert.match(code, /action: "retire", id: -proposalId/);
  assert.match(code, /action: "keep", id: -retire\.proposal_id/);

  // A decided "Retired" improvement shows Re-add (readd uses the original,
  // positive improvement id).
  assert.match(code, /action: "readd", id: item\.id/);
  assert.match(code, />\s*Re-add\s*</);
});

test("lib/improvements-client.ts: Improvement carries kind, decision.retired, and retire; groupOf passes retired through", () => {
  const code = codeOnly(readApp(CLIENT));
  assert.match(code, /kind: "improvement" \| "retire"/);
  assert.match(code, /retired: boolean/);
  assert.match(code, /retire: RetireInfo \| null/);
  assert.match(code, /retired: item\.decision\.retired/);
});

test("instructions.tsx: a Retire button under each live rule, and retired rules collapsed under 'Retired rules (N)' with Re-add", () => {
  const raw = readApp(INSTRUCTIONS_PAGE);
  const code = codeOnly(raw);

  assert.ok(raw.includes("Retire this rule?"));
  assert.ok(raw.includes("Harness will rewrite your Knowledge without it at the next sync."));
  assert.ok(raw.includes("You can re-add it later from Suggestions."));
  assert.match(code, /Retired rules \(\{rules\.length\}\)/);
  assert.match(code, /action: "retire", rule_id: ruleId/);
  assert.match(code, /action: "readd", id: improvementId/);
  assert.match(code, />\s*Re-add\s*</);

  // Still uses the client wrapper, never a raw fetch, same as the rest of
  // this page.
  assert.match(code, /postImprovementAction/);
  assert.ok(!/\bfetch\(/.test(code), "instructions.tsx must not call fetch directly");

  // No <details open> anywhere on the page (the collapsed "Retired rules"
  // section included).
  for (const tag of code.match(/<details[^>]*>/g) ?? []) {
    assert.ok(!/\sopen\b/.test(tag), `details tag must not be open: ${tag}`);
  }
});

test("inbox.tsx: Undo is not offered for a retirement confirmation (still shows the message and Open)", () => {
  const code = codeOnly(readApp(INBOX));
  const row = code.slice(code.indexOf("function ConfirmationRow"), code.indexOf("function Page"));
  const guardStart = row.indexOf('item.kind === "retire" ? null : (');
  assert.ok(guardStart >= 0, "Undo must be guarded on item.kind");
  const guardEnd = row.indexOf(")}", guardStart);
  assert.ok(guardEnd > guardStart);
  // Search from guardStart, not 0 -- "Undo" is a substring of the earlier
  // `onUndo` prop type declaration above the guard.
  const undoIdx = row.indexOf("Undo", guardStart);
  const openIdx = row.indexOf("Open", guardStart);
  assert.ok(undoIdx > guardStart && undoIdx < guardEnd, "Undo must live inside the kind guard");
  assert.ok(openIdx > guardEnd, "Open must render unconditionally, after the guard");
});

test("the improvements API's action set now includes retire, keep, readd, mark_seen, verdict", () => {
  const detailAndLedger = codeOnly(
    readApp(DETAIL) + readApp("routes/_authenticated/ledger.tsx") + readApp(INBOX),
  );
  const actions = [...detailAndLedger.matchAll(/action: "([a-z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(actions)].sort(), [
    "accept",
    "change_wording",
    "keep",
    "mark_seen",
    "readd",
    "reopen",
    "restore",
    "retire",
    "skip",
    "verdict",
  ]);
});
