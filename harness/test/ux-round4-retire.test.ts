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
      "Write needs attention",
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
  // same honest vocabulary as healthLine. Round 9 Task 1 / spec §4:
  // observedLine (which this reuses) now returns observedSentence's plain
  // wording.
  assert.equal(hurt, "You corrected this again in 3 of 4 later builds.");

  const contradiction = ux.retireReasonSentence({
    reason: "contradiction",
    health: { applicable_tasks: 0, helped: 0, hurt: 0, last_applicable_at: null },
    since: null,
    contradicts_instruction: "Always use dark mode by default.",
  });
  assert.equal(
    contradiction,
    "Harness Ledger suggests retiring this rule because it contradicts Always use dark mode by default.",
  );

  const unused = ux.retireReasonSentence({
    reason: "unused",
    health: { applicable_tasks: 0, helped: 0, hurt: 0, last_applicable_at: null },
    since: null,
  });
  assert.equal(
    unused,
    "This rule has not applied to any task in 60 days. Review whether it is still relevant.",
  );

  const sinceLine = ux.retireSinceLine({
    reason: "hurt",
    health: { applicable_tasks: 4, helped: 1, hurt: 3, last_applicable_at: "2026-09-01T00:00:00Z" },
    since: "2026-08-01T00:00:00Z",
  });
  // Fix round 1 item 2: retireSinceLine's "hurt" case now reuses healthLine
  // itself, so the wording (and honesty guarantee) can never drift apart.
  // Round 9 Task 1 / spec §4: healthLine's own wording is now
  // observedSentence's plain sentence.
  assert.equal(
    sinceLine,
    "You corrected this again in 3 of 4 later builds. Last relevant build 1 Sep.",
  );
});

test("improvement.tsx: kind 'retire' items render the reason, the since line, and Retire/Keep; decided 'Retired' items show Re-add", () => {
  const raw = readApp(DETAIL);
  const code = codeOnly(raw);

  assert.match(code, /item\.kind === "retire"/);
  assert.match(code, /retireReasonSentence/);
  assert.match(code, /retireSinceLine/);

  // Round 6c part A / item 1: "Harness suggests retiring this rule" must be
  // the card's first line -- Suggestions no longer shows "In Lovable"
  // items, so the card can't rely on that badge to make clear this is an
  // existing rule, not a new suggestion. The actual rule text moves to a
  // blockquote right under it (item.title is "Retire: <instruction>"
  // server-side; the card strips that prefix for display).
  const retireCard = code.slice(
    code.indexOf("function RetireCard"),
    code.indexOf("export function VerdictControl"),
  );
  // Round 9 Task 3 coordinator fix round 1: the literal "Is this rule still
  // useful?" said "rule" in UI copy -- the Title now renders {VERDICT_QUESTION}
  // ("Is this instruction still useful?"), the same question VerdictControl
  // already asks elsewhere in this file.
  assert.match(retireCard, />\s*\{VERDICT_QUESTION\}\s*<\/Title>/);
  assert.match(retireCard, /item\.title\.replace\(\/\^Retire:\\s\*\/, ""\)/);
  const titleIdx = retireCard.indexOf("{VERDICT_QUESTION}");
  const reasonIdx = retireCard.indexOf("retireReasonSentence");
  const sinceIdx = retireCard.indexOf("retireSinceLine");
  assert.ok(titleIdx >= 0 && titleIdx < sinceIdx && sinceIdx < reasonIdx, "title comes first");

  // Retire confirm: same copy shape as the spec, now "instruction" not
  // "rule" (Round 9 Task 3 / spec §2 vocabulary) and the two consequences
  // spelled out verbatim (spec §3).
  assert.ok(raw.includes("Retire this instruction?"));
  assert.ok(raw.includes("Harness Ledger rewrites your Lovable Knowledge without it right away."));
  assert.ok(raw.includes("Removes this instruction from Lovable Knowledge now."));
  assert.ok(raw.includes("Its record stays on Instructions and can be re-added."));

  // Round 9 Task 3 ruling: Keep is no longer RetireCard's own ghost button
  // with a bespoke toast -- it's InstructionActions' own "keep" case (a
  // plain Button, "Kept" toast, same wording every Keep in the app uses),
  // reached via a keepAction override so it still posts the proposal's own
  // negative id.
  assert.match(code, /onClick=\{\(\) => void run\(body, "Kept"\)\}/);

  // Retire posts InstructionActions' own default body ({ action: "retire",
  // rule_id }, via RetireConfirm's ruleId prop) -- a retire proposal's own
  // rule_id is real (buildRetireItem sets it), so no proposal-id override is
  // needed for Retire, only for Keep.
  assert.match(code, /<RetireConfirm\s+ruleId=\{ruleId\}/);
  assert.match(code, /action: "keep", id: -retire\.proposal_id/);

  // A decided "Retired" improvement shows Re-add (readd uses the original,
  // positive improvement id). Round 9 Task 3 moved this into
  // InstructionActions' own "retired"/"skipped" case (spec §3's fixed action
  // set), which renders the label through INSTRUCTION_ACTION_LABELS.readd
  // (= "Re-add") rather than a literal "Re-add" string of its own; Round 9
  // Task 4 removed DecidedStatus's own separate (literal-text) Re-add
  // button, which used to be this test's only literal match.
  assert.match(code, /action: "readd", id: item\.id/);
  assert.match(code, /trigger=\{INSTRUCTION_ACTION_LABELS\.readd\}/);
  assert.equal(ux.INSTRUCTION_ACTION_LABELS.readd, "Re-add");
});

test("lib/improvements-client.ts: Improvement carries kind, decision.retired, and retire; groupOf passes retired through", () => {
  const code = codeOnly(readApp(CLIENT));
  assert.match(code, /kind: "improvement" \| "retire"/);
  assert.match(code, /retired: boolean/);
  assert.match(code, /retire: RetireInfo \| null/);
  assert.match(code, /retired: item\.decision\.retired/);
});

// Round 6 Task 4 / spec §4: rewritten with intent -- the row's own Retire
// button is gone. Its exact action (retire, addressed by rule_id -- the
// same "immediately retire this live rule and rewrite Knowledge" request
// the card's own "Remove from Knowledge" already made in Round 6 Task 3)
// now lives behind the row's "…" menu, worded the same way as the card:
// "Remove from Knowledge" with the REMOVE_FROM_KNOWLEDGE_* copy, not
// "Retire this rule?". Retired rules collapsed under "Retired rules (N)"
// with Re-add is unchanged.
test("instructions.tsx: 'Remove from Knowledge' under each live rule's '…' menu, and retired rules collapsed under 'Retired rules (N)' with Re-add", () => {
  const raw = readApp(INSTRUCTIONS_PAGE);
  const code = codeOnly(raw);

  assert.ok(!raw.includes("Retire this rule?"), "the row no longer uses the proposal-style copy");
  assert.ok(raw.includes("REMOVE_FROM_KNOWLEDGE_TITLE"));
  assert.ok(raw.includes("REMOVE_FROM_KNOWLEDGE_BODY"));
  assert.ok(raw.includes("REMOVE_FROM_KNOWLEDGE_CONFIRM_LABEL"));
  assert.ok(raw.includes("Remove from Knowledge"));
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

test("instructions.tsx: the row's trailing actions collapse into one DropdownMenu -- Remove from Knowledge and Open suggestion", () => {
  const raw = readApp(INSTRUCTIONS_PAGE);
  const code = codeOnly(raw);

  assert.match(
    code,
    /import\s*\{[^}]*\bDropdownMenu\b[^}]*\}\s*from\s*"@\/components\/ui\/dropdown-menu"/s,
  );
  assert.equal(
    (code.match(/<DropdownMenu>/g) ?? []).length,
    1,
    "exactly one DropdownMenu on the row",
  );
  assert.ok(raw.includes('aria-label="Rule actions"'));
  assert.match(code, />\s*…\s*</, 'the trigger reads "…"');
  assert.match(code, />\s*Open suggestion\s*</);
  // The confirm is an AlertDialog nested inside the menu item (the standard
  // pattern for a confirm triggered from a menu, since AlertDialogTrigger
  // can't be the DropdownMenu's own trigger) -- never the old ConfirmAction.
  assert.ok(!/ConfirmAction/.test(code), "the row no longer uses the shared ConfirmAction");
  assert.match(code, /<AlertDialogTrigger asChild>[\s\S]{0,120}<DropdownMenuItem/);
});

test("inbox.tsx: Undo is not offered for a retirement confirmation, nor once the item is already written (still shows the message and Open) -- Round 6 Task 3 fix 1", () => {
  const code = codeOnly(readApp(INBOX));
  const row = code.slice(code.indexOf("function ConfirmationRow"), code.indexOf("function Page"));
  // can_undo is server-computed (harness/src/improvements.ts's own
  // controlFlags) and already false for a retire-kind item; the explicit
  // `item.kind !== "retire"` here is belt-and-suspenders, not the only guard.
  assert.match(row, /const canUndo = item\.kind !== "retire" && lovable\.can_undo;/);
  const guardStart = row.indexOf("{!written && canUndo ? (");
  assert.ok(guardStart >= 0, "Undo must be guarded on both !written and can_undo");
  const guardEnd = row.indexOf(") : null}", guardStart);
  assert.ok(guardEnd > guardStart);
  // Search from guardStart, not 0 -- "Undo" is a substring of the earlier
  // `onUndo` prop type declaration above the guard.
  const undoIdx = row.indexOf("Undo", guardStart);
  const openIdx = row.indexOf("Open", guardStart);
  assert.ok(undoIdx > guardStart && undoIdx < guardEnd, "Undo must live inside the guard");
  assert.ok(openIdx > guardEnd, "Open must render unconditionally, after the guard");
});

test("the improvements API's action set now includes retire, keep, readd, mark_seen, verdict, retry_write, undo, cancel_write", () => {
  const detailAndLedger = codeOnly(
    readApp(DETAIL) + readApp("routes/_authenticated/ledger.tsx") + readApp(INBOX),
  );
  // Round 6 Task 3: cancel_write lives only on the Instructions page's
  // pending-write banner. That whole file also has postExecutor's own
  // "sync_now" action (a different endpoint) -- rather than pull it into
  // the general blob above, only its postImprovementAction(...) call lines
  // are added to the scan, the same lines the "restore lives on the
  // History page only" test elsewhere in this round checks too.
  const instructionsCalls = codeOnly(readApp(INSTRUCTIONS_PAGE))
    .split("\n")
    .filter((l) => l.includes("postImprovementAction("))
    .join("\n");
  const actions = [...(detailAndLedger + instructionsCalls).matchAll(/action: "([a-z_]+)"/g)].map(
    (m) => m[1],
  );
  assert.deepEqual([...new Set(actions)].sort(), [
    "accept",
    // Checkpoint 2026-09-18 WP5: the Inbox's disagreement cards post this to
    // the executor route. Round 8 Task 1 fix 1: the Reanalyse history
    // dialog that used to also post here moved to local-settings.tsx (not
    // scanned by this test) -- see "reanalyse"/"reanalyse_estimate" below.
    "accept_disagreement",
    // Round 8 Task 1 item 8: the Inbox's own "Analyse now" button (its own
    // mutation, replacing the AnalyseNotice mount that used to live here).
    "analyse_now",
    // Checkpoint 2026-09-18 WP4: the local Skill proposal lifecycle.
    "approve_skill_proposal",
    // Round 6 Task 3: cancel the Instructions page's own staged write.
    "cancel_write",
    "change_wording",
    // Round 8 Task 2 (review item 2): "Dismiss" on a failed action, purely
    // local -- see improvement.tsx's own ActionFailedCard.
    "dismiss_inbox_item",
    "edit_skill_proposal",
    "keep",
    "mark_seen",
    // Checkpoint 3 S1: "Publish to Lovable" / Retry on a failed publish.
    "publish_skill_proposal",
    "readd",
    // "reanalyse"/"reanalyse_estimate" are gone from this list: Round 8
    // Task 1 fix 1 moved the Reanalyse history dialog that posted them off
    // the Inbox and into local-settings.tsx, outside this scan's three
    // pages (see the dedicated Settings pins in ux-analysis.test.ts).
    "retire",
    "retire_skill_proposal",
    // Round 6 Task 2: "Try again" on a not-written outcome.
    "retry_write",
    "set_content_destination",
    "skip",
    // Round 8 Task 3 (review item 5): Overview's own "Sync now" mutation,
    // reused verbatim on the Inbox now that Overview's next-action block
    // moved there.
    "sync_now",
    // Round 6 Task 6b / spec §6: "Test this rule"'s own confirm, and the Add
    // dialog's "Add and test it first" choice (accept, then this).
    "test",
    // Round 6 Task 3: a plain, no-dialog reopen for anything not yet
    // written -- "restore" is gone from this set: it moved to the History
    // page only (see ux-round6-controls.test.ts). Round 6 Task 3 fix 1:
    // "reopen" is gone too -- inbox.tsx's own Undo now posts "undo" (the
    // guarded action), the only place in this scan that ever posted
    // "reopen" in the first place.
    "undo",
    "verdict",
  ]);
});

test("harness-ux.ts: a 'changed_mind' retirement says you asked for the opposite, and the card quotes your message", async () => {
  const base = {
    health: { applicable_tasks: 0, helped: 0, hurt: 0, last_applicable_at: null },
    since: null,
  };
  assert.equal(
    ux.retireReasonSentence({ ...base, reason: "changed_mind" }),
    "Harness Ledger suggests retiring this rule because you asked Lovable for the opposite.",
  );
  assert.doesNotMatch(ux.retireSinceLine({ ...base, reason: "changed_mind" }), /below/);
  const card = readFileSync(
    new URL("../../src/components/harness/improvement.tsx", import.meta.url),
    "utf8",
  );
  assert.match(card, /retire\.reason === "changed_mind" && item\.evidence\[0\]/);
});
