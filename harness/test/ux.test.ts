// Tests for the guided-UX presentation logic (checkpoints C.1/C.2/D0). The
// logic module lives in the root app (src/lib/harness-ux.ts) but is
// dependency-free, so it's tested here with the same node:test runner as the
// data layer. Page sources are checked structurally (no DOM).
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
const LEDGER = "routes/_authenticated/ledger.tsx";
const SHELL = "routes/_authenticated/route.tsx";
const CLIENT = "lib/improvements-client.ts";
const PAGES = [INBOX, LEDGER, DETAIL, LAYOUT];

// Everything a person can read on the detail page: the component plus the
// copy constants it pulls from harness-ux.ts (rendered through helpers).
function detailCopy(): string {
  return codeOnly(readApp(DETAIL));
}

test("enum-to-label mappings: every spec'd example maps to the required plain-language label", () => {
  assert.equal(
    ux.label(ux.CLASSIFICATION_LABELS, "constraint_restatement"),
    "Existing expectation was missed",
  );
  assert.equal(
    ux.label(ux.CLASSIFICATION_LABELS, "preference_revision"),
    "You changed the preferred approach",
  );
  assert.equal(
    ux.label(ux.CLASSIFICATION_LABELS, "missing_requirement"),
    "Part of the request was missed",
  );
  assert.equal(
    ux.label(ux.CLASSIFICATION_LABELS, "defect_correction"),
    "Lovable made an implementation mistake",
  );
  assert.equal(ux.label(ux.SCOPE_LABELS, "workspace"), "Use across my projects");
  assert.equal(ux.label(ux.SCOPE_LABELS, "project"), "Use only in this project");
  assert.equal(ux.label(ux.EVIDENCE_LEVEL_LABELS, "proposed"), "Not tested yet");
  assert.equal(ux.label(ux.VERIFIER_TYPE_LABELS, "structural"), "Automatic check");
  assert.equal(ux.label(ux.VERIFIER_TYPE_LABELS, "ai_rubric"), "AI review");
  assert.equal(ux.label(ux.VERIFIER_STATUS_LABELS, "not_run"), "Not tested");
  assert.equal(
    ux.label(ux.EXPERIMENT_TYPE_LABELS, "paired_control_treatment"),
    "Compare with and without the rule",
  );
  assert.equal(ux.label(ux.FIELD_LABELS, "predicted_failure"), "Problem this should prevent");
  assert.deepEqual(Object.values(ux.STAGE_LABELS), ["Found", "Your review", "Proof", "In Lovable"]);
  assert.deepEqual(Object.values(ux.DESTINATION_LABELS), [
    "This project's Knowledge",
    "Workspace Knowledge (all my projects)",
    "As a Skill",
  ]);
  for (const v of [
    "proposed",
    "approved",
    "testing",
    "supported",
    "active",
    "questioned",
    "disabled",
    "retired",
    "rolled_back",
    "rejected",
  ]) {
    assert.notEqual(ux.label(ux.RULE_STATE_LABELS, v), v, `rule state ${v} needs a label`);
  }
  assert.equal(ux.label(ux.SCOPE_LABELS, "galaxy"), "galaxy");
});

test("lay 'why' templates never invent specifics and always fall back", () => {
  assert.match(
    ux.whyFor("constraint_restatement"),
    /^Lovable missed something you already expected\./,
  );
  assert.match(ux.whyFor("preference_revision"), /^You changed how you want this done\./);
  assert.match(
    ux.whyFor("missing_requirement"),
    /^Part of what you needed wasn't in the request\./,
  );
  assert.match(ux.whyFor("defect_correction"), /^Lovable made a mistake you had to fix\./);
  assert.equal(ux.whyFor("other"), ux.whyFor(null));
  for (const t of Object.values(ux.WHY_TEMPLATES))
    assert.ok(!/cron|pg_cron|queue|credit/i.test(t), t);
});

test("default technical sections are collapsed and the detail page wraps them in Details + Developer view", () => {
  const layout = codeOnly(readApp(LAYOUT));
  for (const tag of layout.match(/<details[^>]*>/g) ?? [])
    assert.ok(!/\sopen\b/.test(tag), `collapsed by default, got: ${tag}`);
  const detail = readApp(DETAIL);
  for (const tag of codeOnly(detail).match(/<details[^>]*>/g) ?? [])
    assert.ok(!/\sopen\b/.test(tag), `collapsed by default, got: ${tag}`);
  assert.match(detail, /<AdvancedDetails title="Details">/);
  assert.ok(!/title="More detail"/.test(detail));
  assert.match(detail, /Developer view/);
  assert.ok(detail.indexOf("developer-view:start") > detail.indexOf('title="Details"'));
  assert.ok(detail.indexOf("developer-view:end") < detail.lastIndexOf("</AdvancedDetails>"));
});

test("detail page order: back, decision card, wording, why, What happened, Details, developer view last", () => {
  const detail = codeOnly(readApp(DETAIL));
  const body = detail.slice(detail.indexOf("export function ImprovementDetail"));
  const order = [
    "{backLabel}",
    "<DecisionCard",
    "{whyFor(item.classification)}",
    "What happened",
    'title="Details"',
    "How Harness Ledger read this",
    "Wording history",
  ];
  let last = -1;
  for (const marker of order) {
    const at = body.indexOf(marker);
    assert.ok(
      at > last,
      `expected "${marker}" after the previous marker (at ${at}, previous ${last})`,
    );
    last = at;
  }
  assert.match(
    body,
    /<DecisionCard\s+item=\{item\}[^>]*busy=\{busy\}[^>]*run=\{run\}[^>]*titleAs="h1"/,
  );
  const raw = readApp(DETAIL);
  assert.ok(raw.indexOf("developer-view:start") > raw.indexOf('title="Details"'));
  // proof is hidden until it can run
  assert.ok(
    !/Run proof|Prove it first|How Harness Ledger would prove this|PROVE_INTRO|proveCostLine/.test(
      body,
    ),
  );
});

test("decision card: three buttons for pending items, decision buttons shown inline for decided ones, no Decide later", () => {
  const detail = codeOnly(readApp(DETAIL));
  const card = detail.slice(
    detail.indexOf("export function DecisionCard"),
    detail.indexOf("export function ImprovementDetail"),
  );
  assert.match(
    detail,
    /const ADD_LABELS: Record<Destination, string> = \{\s*project: "Add to this project",\s*workspace: "Add to all my projects",\s*\};/,
  );
  // Round 6 Task 4 / spec §4: every button in one card's bar is the same
  // size ("sm" on lists, default on the detail page) -- these three now
  // also carry the `size={size}` computed once at the top of DecisionCard,
  // \s+ tolerating however Prettier wraps the extra attribute.
  assert.match(
    card,
    /<AddConfirm\s+item=\{item\}\s+destination="project"\s+busy=\{busy\}\s+run=\{run\}\s+size=\{size\}\s*\/>/,
  );
  assert.match(
    card,
    /<AddConfirm\s+item=\{item\}\s+destination="workspace"\s+busy=\{busy\}\s+run=\{run\}\s+variant="outline"\s+size=\{size\}\s*\/>/,
  );
  assert.match(
    card,
    /<SkipConfirm\s+item=\{item\}\s+busy=\{busy\}\s+run=\{run\}\s+size=\{size\}\s*\/>/,
  );
  assert.match(card, /\{onOpen \? \(/);
  assert.match(card, /onClick=\{\(\) => onOpen\(item\.id\)\}/);
  assert.ok(
    !/>\s*Details\s*<\/button>/.test(card),
    "no separate Details link; the card opens the item",
  );
  assert.match(card, /<DecidedStatus item=\{item\} busy=\{busy\} run=\{run\} ctx=\{ctx\} \/>/);
  const decided = detail.slice(
    detail.indexOf("function DecidedStatus"),
    detail.indexOf("export function DecisionCard"),
  );
  assert.ok(
    !/Change decision/.test(decided),
    "the collapsed wrapper is gone; buttons show directly",
  );
  assert.match(decided, /trigger=\{`\$\{ADD_LABELS\[d\]\} instead`\}/);
  assert.match(decided, /action: "retry_write", id: item\.id, version_id: retryableVersion\.id/);
  // Round 6 Task 3 / spec §3: "Restore previous version" is gone from
  // DecidedStatus -- Remove from Knowledge (still the "retire" action) took
  // its place, and Restore itself moved to the History page only.
  assert.ok(!/Restore previous version/.test(decided), "Restore moved to the History page only");
  // Round 6 Task 4 / spec §4: same size threading as the other action-bar
  // buttons above.
  assert.match(
    decided,
    /<RemoveFromKnowledgeConfirm\s+ruleId=\{ruleId\}\s+busy=\{busy\}\s+run=\{run\}\s+size=\{size\}\s*\/>/,
  );
  assert.match(decided, /\{ action: "undo", id: item\.id \}/);
  assert.match(decided, /\{decisionSentence\(/);
  // "role=\"radio\"" used to be forbidden here (an earlier deferred-decision
  // design); Task 8 reintroduces it deliberately for the Add-confirmation
  // choice, tested separately in ux-decision.test.ts.
  // Checkpoint 2026-09-18 WP4: "Skill" is back on purpose -- a real,
  // honest destination (DestinationChoice) -- so only the old stub's own
  // SKILL_NOT_ON marker stays banned.
  for (const gone of [
    "SKILL_NOT_ON",
    "Decide later",
    "Decide now",
    "isDeferred",
    "setDeferred",
    "DecisionPanel",
    "justAccepted",
    "PENDING_CHIP",
  ]) {
    assert.ok(!detail.includes(gone), `${gone} should be gone from the detail component`);
  }
  const client = codeOnly(readApp(CLIENT));
  assert.ok(
    !/DEFERRED_PREFIX|isDeferred|setDeferred|localStorage/.test(client),
    "no per-browser state left",
  );
  assert.match(client, /export function groupOf\(item: Improvement\): ImprovementGroup \| null/);
  assert.match(detail, /trigger="Skip"\s+variant="ghost"/);
  assert.match(detail, /title="Skip this suggestion\?"/);
});

// Checkpoint 2026-09-18: PROVE_INTRO (the "runs the same request twice...
// with and without the instruction" copy) is gone -- it was dead code
// (never imported by any page) and factually described a fresh two-arm
// comparison that has never existed; the real, live "Test it first" cost
// line is proveCostLine(), kept and pinned below. "no screen runs or
// mentions a proof" still holds.
test("PROVE_INTRO is gone; nothing on screen runs or mentions a proof, apart from the Add dialog's own honest cost line", () => {
  assert.ok(!("PROVE_INTRO" in ux), "PROVE_INTRO must be removed, not just unused");
  assert.equal(
    ux.proveCostLine(),
    "Uses Lovable credits like any build; the cost is recorded after the test.",
  );
  for (const page of PAGES) {
    const code = codeOnly(readApp(page));
    assert.ok(
      !/run_experiment|execute_experiment|remix_project|send_message|"run_proof"|action: "run"|action: "prove"/.test(
        code,
      ),
      page,
    );
    // Task 8: the Add confirmation's "Test it first" choice legitimately
    // states its cost via proveCostLine -- everything else still shows no
    // proof-running UI.
    const forbidden = page === DETAIL ? /Run proof/ : /Run proof|proveCostLine/;
    assert.ok(!forbidden.test(code), `${page} still shows proof UI`);
  }
});

test("Add confirmation: exact preview lines, no-snapshot variant, over-cap guard, post-accept line", () => {
  const detail = codeOnly(readApp(DETAIL));
  const confirm = detail.slice(
    detail.indexOf("function AddConfirm"),
    detail.indexOf("function SkipConfirm"),
  );
  // Round 7: with "Test it first" picked the dialog speaks about the test.
  assert.match(
    confirm,
    /title=\{wantsTest \? TEST_THIS_RULE_TITLE : `Add to \$\{targetLabel\}\?`\}/,
  );
  assert.match(confirm, /Your existing Knowledge \(unchanged\)/);
  assert.match(confirm, /\{preview\.managed_block\}/);
  assert.match(
    confirm,
    /\{preview\.char_count\} of \{KNOWLEDGE_CHAR_LIMIT\.toLocaleString\("en-US"\)\} characters/,
  );
  assert.equal(ux.KNOWLEDGE_CHAR_LIMIT, 10000);
  // Task 8: the Add-it-now/Test-it-first choice text now says "Uses no
  // credits" itself, so this line was dropped from PREVIEW_CONSEQUENCES.
  assert.ok(!/"Uses no Lovable credits\.",/.test(detail));
  // Addendum to Round 6 Task 4: names both places a written rule can be
  // undone from -- Remove from Knowledge on the card, restore an earlier
  // version from History -- not just "restore" alone.
  assert.match(
    detail,
    /\[\s*"You can remove it from Knowledge or restore an earlier version from History at any time\.",?\s*\]/,
  );
  assert.match(
    confirm,
    /consequences=\{\s*wantsTest && item\.test \? testConfirmLines\(item\.test\) : preview \? PREVIEW_CONSEQUENCES : \[\]\s*\}/,
  );
  // no snapshot yet -> save the choice, say so, and promise the read-back
  assert.match(
    detail,
    /const NO_SNAPSHOT_BODY =\s*"Harness Ledger hasn't read your current Knowledge yet\. Your choice is saved; press Sync now on the Projects page, then Harness Ledger reads it and writes this exact text\. You can see the result on the Instructions page\.";/,
  );
  // Task 8: confirm label now reflects the two-choice selection, not
  // whether a preview is available. Round 6 Task 6b / spec §6: "Save for
  // testing" is gone -- the test choice now writes immediately too.
  assert.match(
    confirm,
    /confirmLabel=\{wantsTest \? START_TEST_LABEL : preview \? "Add" : "Save choice"\}/,
  );
  // over the cap -> the confirm button is disabled and the reason is shown
  assert.match(
    detail,
    /const OVER_CAP_LINE =\s*"This would exceed the Knowledge limit — shorten the instruction or your existing Knowledge first\.";/,
  );
  // ... and so is an unmade choice, or the project's over its rule cap
  // (Round 3 §5: over_rules mirrors over_cap)
  assert.match(
    confirm,
    /confirmDisabled=\{\(!wantsTest && \(overCap \|\| overRules\)\) \|\| choice == null\}/,
  );
  assert.match(confirm, /\{overCap \? \(/);
  assert.match(confirm, /\{overRules \? \(/);
  assert.match(detail, /Retire one on the Instructions page first\./);
  // the confirmation posts accept for "Add it now"; Round 7: "Test it
  // first" posts only a `test` action -- nothing is added until the owner
  // has compared both builds.
  assert.match(confirm, /action: "accept",\s*id: item\.id,\s*destination\s*\}/);
  assert.match(confirm, /if \(wantsTest\) \{\s*await run\(\s*\{ action: "test"/);
  // afterwards: a toast says where it went; the card re-renders as decided
  // -- Round 6 Task 2: the real toast text now comes from the write outcome
  // (see writeToastText/useRun), this constant is only the defensive
  // fallback for a response that somehow carries no `write` at all.
  assert.match(detail, /const SAVED_LINE = "Added\.";/);
  assert.ok(!/useNavigate/.test(detail), "the component never navigates");
  // the layout supports the preview slot and a disabled confirm
  const layout = codeOnly(readApp(LAYOUT));
  assert.match(layout, /children\?: ReactNode;/);
  assert.match(layout, /<AlertDialogAction onClick=\{onConfirm\} disabled=\{confirmDisabled\}>/);
});

test("no per-stage progress bar in the layout (decisionSentence + the group chip are the only two places that say where an item stands); decided cards show the group chip", () => {
  const layout = readApp(LAYOUT);
  assert.ok(!/ProcessProgress/.test(layout), "the stage bar is gone -- see ux-inbox-logic.test.ts");
  assert.ok(!/you are here/.test(codeOnly(layout)));
  assert.ok(
    !/ClickableCard/.test(layout),
    "whole-card buttons are gone; the buttons are the decision",
  );
  const detail = codeOnly(readApp(DETAIL));
  // Round 4 Task C3: the pending branch also renders a "New" badge (isNew)
  // now, but a decided item's group chip -- this assertion's own subject --
  // is unchanged: still the final "else" of the same ternary. Round 5 Task
  // 6 wraps the chip in a row div alongside the new "Accepted
  // automatically" marker -- the chip is still that row's first child.
  assert.match(
    detail,
    /\) : \(\s*<div className="flex flex-wrap items-center gap-2">\s*<Badge variant="secondary">\{groupOf\(item\)\}<\/Badge>/,
  );
});

test("lovableStatusLine / decisionSentence / improvementGroup follow the write lifecycle without implying Lovable changed", () => {
  assert.equal(ux.lovableStatusLine(null), "Not written yet — press Sync now on the Projects page");
  assert.equal(
    ux.lovableStatusLine({ write_status: "none", written_at: null }),
    "Not written yet — press Sync now on the Projects page",
  );
  assert.equal(
    ux.lovableStatusLine({ write_status: "pending", written_at: null }),
    "Not written yet — press Sync now on the Projects page",
  );
  // Round 6 Task 2: a pressed decision writes in the same request (see
  // writeOutcomeLine) -- there is no "next sync" ETA left to show, so
  // StatusCtx no longer carries a nextSyncAt field at all.
  assert.equal(
    ux.lovableStatusLine({ write_status: "none", written_at: null }, { connected: false }),
    "Connect Lovable on the Projects page to let Harness Ledger write this",
  );
  assert.equal(
    ux.lovableStatusLine({ write_status: "none", written_at: null }, { testFirst: true }),
    "Saved for testing — nothing is written until the test runs",
  );
  assert.equal(
    ux.lovableStatusLine({ write_status: "written", written_at: "2026-09-10T08:00:00Z" }),
    "Added to Lovable, 10 Sep",
  );
  assert.equal(
    ux.lovableStatusLine({ write_status: "stale", written_at: null, stale_reason: null }),
    "Write needs attention: Knowledge changed in Lovable — review the text again",
  );
  assert.equal(
    ux.lovableStatusLine({ write_status: "failed", written_at: null }),
    "Write needs attention: adding failed — see Details",
  );
  assert.equal(
    ux.lovableStatusLine({ write_status: "reverted", written_at: "2026-09-10T08:00:00Z" }),
    "Reverted to an earlier version, 10 Sep",
  );

  const pending = ux.decisionSentence({
    decision: { status: "pending", decided_at: null },
    destination: null,
  });
  assert.equal(pending, "Waiting for your decision.");
  const accepted = ux.decisionSentence({
    decision: { status: "accepted", decided_at: "2026-09-09T14:38:48Z" },
    destination: "workspace",
    lovable: { write_status: "pending", written_at: null },
  });
  assert.equal(
    accepted,
    "You chose: add to all my projects, on 9 Sep. Not written yet — press Sync now on the Projects page.",
  );
  const skipped = ux.decisionSentence({
    decision: { status: "skipped", decided_at: null },
    destination: null,
  });
  assert.equal(skipped, "You skipped this suggestion.");
  const added = ux.decisionSentence({
    decision: { status: "accepted", decided_at: null },
    destination: "project",
    lovable: { write_status: "written", written_at: "2026-09-10T08:00:00Z" },
  });
  assert.equal(added, "You chose: add to this project only. Added to Lovable, 10 Sep.");
  const testFirstSentence = ux.decisionSentence({
    decision: { status: "accepted", decided_at: null },
    destination: "project",
    lovable: { write_status: "none", written_at: null },
    ctx: { testFirst: true },
  });
  assert.equal(
    testFirstSentence,
    "You chose: add to this project only. Saved for testing — nothing is written until the test runs.",
  );

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
    testFirst = false,
    retired = false,
  ) => ux.improvementGroup({ status, writeStatus, testFirst, retired });
  assert.equal(g("pending", null), null, "pending items belong in Inbox, not Improvements");
  assert.equal(g("skipped", null), "Skipped");
  assert.equal(g("accepted", "none"), "Waiting to be written");
  assert.equal(g("accepted", "pending"), "Waiting to be written");
  assert.equal(g("accepted", "written"), "In Lovable");
  assert.equal(g("accepted", "reverted"), "Reverted");
  assert.equal(g("accepted", "stale"), "Write needs attention");
  assert.equal(g("accepted", "failed"), "Write needs attention");
  assert.equal(g("accepted", "none", true), "Waiting to be tested");
  assert.equal(
    g("accepted", "written", true),
    "In Lovable",
    "a written version always wins over test_first",
  );
  assert.equal(
    g("accepted", "reverted", true),
    "Reverted",
    "a reverted version always wins over test_first",
  );
  // Task C2: retired wins over every writeStatus and over test_first.
  assert.equal(g("accepted", "written", false, true), "Retired");
  assert.equal(g("accepted", "reverted", true, true), "Retired");
  assert.equal(g("skipped", null, false, true), "Skipped", "skipped still wins over retired");

  assert.ok(!/Waiting for Harness Ledger/.test(readApp("lib/harness-ux.ts")));

  assert.equal(
    ux.versionStatusLine({
      status: "written",
      written_at: "2026-09-10T08:00:00Z",
      restored_from_version_id: null,
    }),
    "Added to Lovable, 10 Sep",
  );
  assert.equal(
    ux.versionStatusLine({
      status: "written",
      written_at: "2026-09-10T08:00:00Z",
      restored_from_version_id: 7,
    }),
    "Reverted to an earlier version, 10 Sep",
    "a written version that restored an earlier one reads as reverted, not written",
  );
  assert.equal(
    ux.versionStatusLine({ status: "pending", written_at: null, restored_from_version_id: null }),
    "Not written yet — press Sync now on the Projects page",
  );
});

// Round 6c part A / item 1: rewritten with intent -- "a suggestion that is
// already in Lovable makes no sense" (the owner's report). Suggestions now
// holds only what still needs or awaits a decision: pending items (incl.
// retirement proposals) and "Needs attention" under one "Open" section;
// "Waiting to be written"/"Waiting to be tested" as their own sections;
// "Retired"/"Skipped" collapsed under "Decided earlier"; "In Lovable" and
// "Reverted" are gone from this page entirely, replaced by a one-line
// pointer to the Instructions page (those items are rules now, not
// suggestions).
test("Suggestions page: Open/Waiting/Decided-earlier sections, no In Lovable/Reverted listing, decision cards, restore lives in the card", () => {
  const ledger = codeOnly(readApp(LEDGER));
  assert.ok(!/IMPROVEMENT_GROUPS/.test(ledger), "no more generic group iteration on this page");
  assert.match(
    ledger,
    /const pending = all\.filter\(\(i\) => i\.decision\.status === "pending"\);/,
  );
  assert.match(ledger, /const openItems = \[\.\.\.pending, \.\.\.needsAttention\];/);
  assert.match(ledger, />\s*Open\{" "\}/, "the Open section heading");
  assert.match(ledger, />\s*Waiting to be written\{" "\}/);
  assert.match(ledger, />\s*Waiting to be tested\{" "\}/);
  assert.match(ledger, /Decided earlier \(\{decidedEarlier\.length\}\)/);
  assert.match(
    ledger,
    /Rules already in Lovable are on the/,
    "a pointer, not a listing, for rules already in Lovable",
  );
  // Retired/Skipped are gone from the page's own section headings -- they
  // only ever appear now inside the collapsed "Decided earlier" details.
  assert.ok(!/>\s*In Lovable\{" "\}/.test(ledger));
  assert.ok(!/>\s*Reverted\{" "\}/.test(ledger));
  assert.ok(!/Everything Harness Ledger has learned/.test(ledger), "no subtitle on Suggestions");
  assert.ok(
    !/Needs your decision|Waiting for proof|Ready to add|Decide later/.test(ledger),
    "old group names are gone",
  );
  assert.match(ledger, /<DecisionCard item=\{i\} onChanged=\{refresh\} onOpen=\{open\} \/>/);
  assert.ok(
    !/Restore previous version|action: "restore"|ConfirmAction|ImprovementCard|ClickableCard/.test(
      ledger,
    ),
  );
  assert.ok(
    !/export function ImprovementCard/.test(readApp(DETAIL)),
    "the temporary wrapper is gone",
  );
  // Decided earlier is the only <details> on this page, and it is collapsed.
  for (const tag of ledger.match(/<details[^>]*>/g) ?? []) {
    assert.ok(!/\sopen\b/.test(tag), `details tag must not be open: ${tag}`);
  }
  const inbox = codeOnly(readApp(INBOX));
  assert.match(inbox, /i\.decision\.status === "pending"/, "only pending items are in Inbox");
});

test("wording history: reasons only for changes made in this UI; anything else is 'Updated by Harness Ledger'", () => {
  assert.equal(
    ux.wordingChangeLine({
      changed_at: "2026-09-09T10:00:00Z",
      reason: "tighter",
      actor: "operator (local UI)",
    }),
    "You changed the wording on 9 Sep — tighter.",
  );
  assert.equal(
    ux.wordingChangeLine({
      changed_at: "2026-09-09T10:00:00Z",
      reason: "internal classifier note",
      actor: "claude-checkpoint-b",
    }),
    "Updated by Harness Ledger on 9 Sep.",
  );
  assert.equal(
    ux.wordingChangeLine({ changed_at: "2026-09-09T10:00:00Z", reason: "x", actor: "operator" }),
    "You changed the wording on 9 Sep.",
  );
  assert.match(codeOnly(readApp(DETAIL)), /\{wordingChangeLine\(w\)\}/);
});

test("Overview is gone: the route only redirects to Inbox and nothing links to /overview", () => {
  const overview = codeOnly(readApp("routes/_authenticated/overview.tsx"));
  assert.match(overview, /throw redirect\(\{ to: "\/inbox", replace: true \}\)/);
  assert.ok(!/component:/.test(overview), "no component; it is a pure redirect");
  for (const page of [
    INBOX,
    LEDGER,
    SHELL,
    CLIENT,
    DETAIL,
    LAYOUT,
    "routes/login.tsx",
    "routes/index.tsx",
    "routes/_authenticated/settings.tsx",
  ]) {
    assert.ok(
      !/["'`]\/overview["'`]/.test(codeOnly(readApp(page))),
      `${page} still links to /overview`,
    );
  }
});

test("Settings: hosted usage cards live under Advanced, gated to the hosted runtime, with a link to Jobs", () => {
  const settings = codeOnly(readApp("routes/_authenticated/settings.tsx"));
  assert.match(settings, /function AdvancedSection/);
  assert.match(settings, /if \(runtime\.data\?\.mode !== "hosted"\) return null;/);
  assert.match(settings, /<summary[^>]*>\s*Advanced\s*<\/summary>/);
  assert.match(settings, /<Link to="\/jobs"/);
  assert.match(settings, /Credits this month/);
  assert.match(settings, /<AdvancedSection \/>/);
  assert.ok(!/queryKey: \["overview"\]/.test(settings));
});

test("nav: Inbox, Suggestions, Instructions, History, Tests, Skills, Projects, Settings in every runtime; How Harness Ledger works links to the landing page", () => {
  const shell = codeOnly(readApp(SHELL));
  assert.match(shell, /\{ to: "\/inbox", label: "Inbox" \}/);
  assert.match(shell, /\{ to: "\/ledger", label: "Suggestions" \}/);
  assert.match(shell, /\{ to: "\/instructions", label: "Instructions" \}/);
  assert.match(shell, /\{ to: "\/history", label: "History" \}/);
  assert.match(shell, /\{ to: "\/tests", label: "Tests" \}/);
  assert.match(shell, /\{ to: "\/skills", label: "Skills" \}/);
  assert.match(shell, /\{ to: "\/projects", label: "Projects" \}/);
  assert.match(shell, /\{ to: "\/settings", label: "Settings" \}/);
  assert.equal(count(shell, 'label: "'), 8, "exactly eight nav items");
  const navOrder = [
    'label: "Inbox"',
    'label: "Suggestions"',
    'label: "Instructions"',
    'label: "History"',
    'label: "Tests"',
    'label: "Skills"',
    'label: "Projects"',
    'label: "Settings"',
  ];
  let lastAt = -1;
  for (const marker of navOrder) {
    const at = shell.indexOf(marker);
    assert.ok(at > lastAt, `expected ${marker} after the previous nav item`);
    lastAt = at;
  }
  assert.ok(
    !/LOCAL_NAV|runtimeQueryOptions|mode === "local"/.test(shell),
    "nav never depends on the runtime",
  );
  assert.ok(!/label: "Ledger"|label: "Overview"|label: "Knowledge"/.test(shell));
  assert.match(shell, /<Link to="\/"[^>]*>\s*How Harness Ledger works\s*<\/Link>/);
  const client = codeOnly(readApp(CLIENT));
  assert.ok(
    !/HowItWorks|howItWorks|HOW_IT_WORKS/.test(client),
    "no onboarding state in the client lib",
  );
  assert.match(client, /staleTime: Infinity/);
  assert.match(
    client,
    /json\.mode === "local" \? "local" : "hosted"/,
    "anything but a confirmed local answer is hosted",
  );
});

test("formatDate / formatDay produce '8 Sep, HH:MM' style and pass non-dates through", () => {
  assert.match(ux.formatDay("2026-09-08T10:31:23Z"), /^8 Sep$/);
  assert.match(ux.formatDate("2026-09-08T10:31:23Z"), /^8 Sep, \d{2}:\d{2}$/);
  assert.equal(ux.formatDate("not a date"), "not a date");
  assert.equal(ux.formatDate(null), "");
});

test("lovableReplyText extracts what the user saw in the Lovable chat from a verbatim assistant message", () => {
  const raw =
    '<lov-tool-use id="a" name="supabase--run_sql" integration-id="supabase" data="{\\"query\\": \\"select 1\\"}">\n</lov-tool-use>\n' +
    '<lov-tool-use id="b" name="user_messaging--message_user" integration-id="user_messaging" data="{\\"summary\\": \\"s\\", \\"message\\": \\"Heads up: the worker will wake once a minute (1,440 times a day).\\\\nSecond line.\\", \\"finished\\": false}">\n</lov-tool-use>\n' +
    '<lov-tool-use id="c" name="user_messaging--message_user" integration-id="user_messaging" data="{\\"summary\\": \\"t\\", \\"message\\": \\"The foundation is live.\\", \\"finished\\": true}">\n</lov-tool-use>';
  const text = ux.lovableReplyText(raw);
  assert.equal(
    text,
    "Heads up: the worker will wake once a minute (1,440 times a day).\nSecond line.\n\nThe foundation is live.",
  );
  assert.ok(!text.includes("run_sql"));
  // no message blocks -> readable fallback, not an empty string
  const fallback = ux.lovableReplyText("plain assistant text " + "x".repeat(1000));
  assert.ok(fallback.length <= 601 && fallback.startsWith("plain assistant text"));
});

test("cost wording: 'Lovable credits' at most twice on the detail page, 'Harness Ledger analysis' exactly once, nowhere else", () => {
  const detail = detailCopy();
  assert.ok(
    count(detail, "Lovable credits") <= 2,
    `Lovable credits x${count(detail, "Lovable credits")}`,
  );
  assert.equal(count(detail, "Harness Ledger analysis"), 1);
  // Task 8 adds one bare "credit" mention: "Uses no credits." in the
  // Add-it-now choice text. Round 6 Task 6b adds a second, non-display one:
  // `item.test.credits` (TestInfo's own field name, read for
  // testThisRuleBudgetLine's argument) -- neither is "Lovable credits" or
  // "lovable_credits_max", so neither is counted by those two terms.
  assert.equal(
    count(codeOnly(readApp(DETAIL)), "credit"),
    count(codeOnly(readApp(DETAIL)), "Lovable credits") +
      count(codeOnly(readApp(DETAIL)), "lovable_credits_max") +
      2,
  );
  for (const page of [INBOX, LEDGER, LAYOUT]) {
    assert.equal(count(codeOnly(readApp(page)), "credit"), 0, `${page} mentions credits`);
  }
  // the client lib carries the contract field name lovable_credits_max, but no user-facing credit copy
  assert.equal(count(codeOnly(readApp(CLIENT)), "Lovable credits"), 0);
  // harness-ux.ts (Round 5 Task 2): "Lovable credits" appeared once, in
  // proveCostLine. Checkpoint 2026-09-18 (WP1b) keeps the count at exactly
  // two, but the second one moved: TEST_THIS_RULE_CREDITS_LINE no longer
  // spells it out literally (it now reads "Lovable builder credits" via the
  // shared COPY_CREDITS_LINE, D1/D2 DECISIONS.md's mandated cost sentence);
  // the second "Lovable credits" is now evidenceSourceLines' own "observed"
  // sentence ("...automatically, using no Lovable credits."), replacing the
  // old unqualified "for free".
  const uxSource = codeOnly(readApp("lib/harness-ux.ts"));
  assert.equal(count(uxSource, "Lovable credits"), 2);
  // Count case-insensitive: use regex to match credit/credits/Credit/Credits/CREDITS.
  // Round 6 Task 6b's own paired-test copy block (confirm lines, the card's
  // status line, the judging screen's cost/confounder lines, the
  // TestRunResultLike type and its own doc comments) is the entire jump
  // from 5 to 16; Round 6c part B's own testsPageCreditsLine (the Tests
  // page's credits line, with its own "· measured" suffix) is the jump
  // from 16 to 21. Checkpoint 2026-09-18 (WP1b) adds the shared
  // COPY_CREDITS_LINE constant (its own name and two literal "credits") and
  // the observed-evidence sentence's "using no Lovable credits" -- the jump
  // from 21 to 26, recomputed directly against the file rather than
  // hand-counted, inventoried here so a FUTURE bump still gets looked at,
  // rather than this assertion silently loosening forever.
  const creditMatches = (uxSource.match(/credit/gi) || []).length;
  assert.equal(creditMatches, 26);
});

test("no internal vocabulary in user-facing JSX outside the Developer view", () => {
  const detail = readApp(DETAIL);
  const start = detail.indexOf("developer-view:start");
  const end = detail.indexOf("developer-view:end");
  assert.ok(start > 0 && end > start);
  const userFacing = codeOnly(detail.slice(0, start) + detail.slice(end));
  for (const word of ["checkpoint", "message_id", "provenance", "confidence", "classifier"]) {
    assert.ok(!new RegExp(word, "i").test(userFacing), `${word} leaks into the user-facing detail`);
  }
  for (const page of [
    INBOX,
    LEDGER,
    SHELL,
    CLIENT,
    LAYOUT,
    "lib/harness-ux.ts",
    "routes/_authenticated/settings.tsx",
  ]) {
    const code = codeOnly(readApp(page));
    // CLIENT (improvements-client.ts) drops "confidence" from its own ban:
    // Round 5 Task 6 / spec §4 gives it a real, typed field
    // (ExecutorSettings.decision_auto_confidence, mirroring the setting
    // local-settings.tsx now shows as "Confidence needed") -- the client's
    // own honest contract, not a leak. Checkpoint 2026-09-18 (WP1b) drops
    // "message_id" from CLIENT's ban too: ReplayEnvironment.code_state.
    // request_message_id is a real, typed field mirroring
    // harness/src/executor/replay-environment.ts's own field name exactly
    // (the judging screen's Full technical details reads it) -- the same
    // "honest contract, not a leak" reasoning as confidence above. Every
    // other page here keeps the full ban.
    const words =
      page === CLIENT
        ? ["checkpoint", "provenance"]
        : ["checkpoint", "message_id", "provenance", "confidence"];
    for (const word of words) {
      assert.ok(!new RegExp(word, "i").test(code), `${word} leaks into ${page}`);
    }
  }
});

test("pages only fetch local harness routes: improvements, runtime, knowledge, executor, projects, skills -- nothing else", () => {
  for (const page of [INBOX, LEDGER, SHELL, CLIENT, DETAIL]) {
    const code = codeOnly(readApp(page));
    const targets = [...code.matchAll(/fetch\("([^"]+)"/g)].map((m) => m[1]);
    for (const t of targets)
      assert.match(
        t!,
        /^\/api\/public\/harness\/(improvements|runtime|knowledge|executor|projects|skills)$/,
        `${page} fetches ${t}`,
      );
    // Allow lovable.dev in href links (D1); forbid API calls and MCP tools
    const codeWithoutHrefs = code.replace(
      /href=\{[^}]*lovable\.dev[^}]*\}|href="[^"]*lovable\.dev[^"]*"|href='[^']*lovable\.dev[^']*'/g,
      "",
    );
    assert.ok(
      !/lovable\.dev|set_project_knowledge|setProjectKnowledge|createWorkspaceSkill/i.test(
        codeWithoutHrefs,
      ),
      page,
    );
  }
  const client = codeOnly(readApp(CLIENT));
  assert.match(client, /fetch\("\/api\/public\/harness\/improvements"/);
  assert.match(client, /fetch\("\/api\/public\/harness\/runtime"/);
  assert.ok(readApp(INBOX).includes("fetchImprovements"));
  assert.ok(readApp(LEDGER).includes("fetchImprovements"));
  // the only actions the UI can send
  const actions = [
    ...codeOnly(readApp(DETAIL) + readApp(LEDGER)).matchAll(/action: "([a-z_]+)"/g),
  ].map((m) => m[1]);
  // Task C2 adds retire/keep/readd (the Retire/Keep/Re-add actions); Round 5
  // Task 7 adds verdict (the "Did this rule help?" buttons); Round 6 Task 2
  // adds retry_write ("Try again" on a not-written outcome). Round 6 Task 3:
  // "reopen" and "restore" are gone from DETAIL+LEDGER -- Restore moved to
  // the History page only, and the skipped-only "Reopen" button folded into
  // the new "undo" (a plain, no-dialog reversal of anything not yet
  // written, shared by the accepted-unwritten and skipped cases alike).
  // Round 6 Task 6b / spec §6: "test" -- "Test this rule"'s own confirm and
  // the Add dialog's "Add and test it first" choice both post it.
  assert.deepEqual([...new Set(actions)].sort(), [
    "accept",
    // Checkpoint 2026-09-18 WP4: the local Skill proposal lifecycle.
    "approve_skill_proposal",
    "change_wording",
    "edit_skill_proposal",
    "keep",
    "readd",
    "retire",
    "retire_skill_proposal",
    "retry_write",
    "set_content_destination",
    "skip",
    "test",
    "undo",
    "verdict",
  ]);
});

test("Inbox: a count line, then compact decision cards you can act on without opening them", () => {
  const inbox = codeOnly(readApp(INBOX));
  // onChanged also turns the item into a confirmation row (see
  // ux-inbox-logic.test.ts), so it's no longer bare `refresh`. Round 4 Task
  // C3 adds an `isNew` prop after onOpen (see ux-round4-health.test.ts), so
  // this no longer requires the tag to close right after onOpen. Round 5
  // Task 5 / spec §2: the card is `compact` now, and `onOpen` (no longer
  // named `open`) navigates to Suggestions rather than an in-page detail.
  assert.match(
    inbox,
    /<DecisionCard\s+compact\s+item=\{i\}\s+onChanged=\{\(msg\)\s*=>\s*confirmDecision\(i\.id,\s*msg\)\}\s+onOpen=\{onOpen\}/,
  );
  assert.match(inbox, /"One suggestion is waiting for your decision\."/);
  assert.match(inbox, /`\$\{pending\.length\} suggestions are waiting for your decision\.`/);
  assert.ok(!/ImprovementCard|ClickableCard|isDeferred/.test(inbox));
  assert.ok(!/>\s*Review\s*<\/Button>/.test(inbox));
});

test("evidence rendering only knows two authors and labels them for a person", () => {
  const detail = readApp(DETAIL);
  assert.match(detail, /"Lovable replied" : "You asked Lovable"/);
  assert.match(detail, /Show full response/);
  assert.match(detail, /lovableReplyText\(m\.text\)/);
});

test("landing page: public, copy from landing-copy.ts, never redirects, fetches nothing", () => {
  // Checkpoint 2026-09-18: the landing page moved to src/lib/landing-copy.ts
  // (hero, eight-step story, evidence levels, limitations) -- pinned in
  // detail by ux-landing.test.ts. HOW_IT_WORKS_STEPS/LANDING_INTRO stay in
  // harness-ux.ts for the in-app "How Harness Ledger works" link only.
  const landing = codeOnly(readApp("routes/index.tsx"));
  assert.match(landing, /STORY_STEPS\.map/);
  assert.match(landing, /\{HERO_TITLE\}/);
  assert.match(landing, /signedIn \? "\/inbox" : "\/login"/);
  assert.ok(!/navigate\(|redirect\(/.test(landing), "the landing page never redirects");
  assert.ok(!/fetch\(/.test(landing), "the landing page fetches nothing");
  const login = codeOnly(readApp("routes/login.tsx"));
  assert.equal(count(login, 'to: "/inbox"'), 3);
  assert.match(login, /emailRedirectTo: `\$\{window\.location\.origin\}\/inbox`/);
});

// ---- Task 5: knowledge, executor, projects routes ----

const KNOWLEDGE_ROUTE = "routes/api/public/harness/knowledge.ts";
const EXECUTOR_ROUTE = "routes/api/public/harness/executor.ts";
const PROJECTS_ROUTE = "routes/api/public/harness/projects.ts";
const RUNTIME_LIB = "lib/server/harness-runtime.ts";

test("harness-runtime.ts never mentions a spec document, and every new route enforces auth through the shared adapter", () => {
  const runtimeLib = readApp(RUNTIME_LIB);
  assert.ok(!/SPEC/.test(runtimeLib), "harness-runtime.ts must not reference a spec document");

  for (const route of [KNOWLEDGE_ROUTE, EXECUTOR_ROUTE, PROJECTS_ROUTE]) {
    const code = readApp(route);
    assert.match(code, /requireAuth\(/, `${route} must call requireAuth(`);
    assert.match(code, /loadHarnessAdapter\(/, `${route} must call loadHarnessAdapter(`);
  }
});

test("improvements-client.ts fetches exactly the six local harness routes", () => {
  const client = codeOnly(readApp(CLIENT));
  const targets = new Set([...client.matchAll(/fetch\("([^"]+)"/g)].map((m) => m[1]));
  assert.deepEqual([...targets].sort(), [
    "/api/public/harness/executor",
    "/api/public/harness/improvements",
    "/api/public/harness/knowledge",
    "/api/public/harness/projects",
    "/api/public/harness/runtime",
    "/api/public/harness/skills",
  ]);
});

// ---- Task 6: Knowledge page and navigation ----
// Round 3 Task 3b moved this page's content to /instructions (see
// harness/test/ux-round3-pages.test.ts for the full content coverage);
// /knowledge and /versions are now pure redirects, same shape as /overview.

const KNOWLEDGE_PAGE = "routes/_authenticated/knowledge.tsx";
const VERSIONS_PAGE = "routes/_authenticated/versions.tsx";

test("Knowledge redirects to Instructions, same shape as the Overview redirect", () => {
  const knowledge = codeOnly(readApp(KNOWLEDGE_PAGE));
  assert.match(knowledge, /throw redirect\(\{ to: "\/instructions", replace: true \}\)/);
  assert.ok(!/component:/.test(knowledge), "no component; it is a pure redirect");
});

test("Versions redirects to Instructions, same shape as the Overview redirect", () => {
  const versions = codeOnly(readApp(VERSIONS_PAGE));
  assert.match(versions, /throw redirect\(\{ to: "\/instructions", replace: true \}\)/);
  assert.ok(!/component:/.test(versions), "no component; it is a pure redirect");
});
