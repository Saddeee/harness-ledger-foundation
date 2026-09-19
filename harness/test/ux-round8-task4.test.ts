// UX round 8 (2026-09-19), Task 4: Suggestion detail -- decision first, one
// copy of the instruction (review item 6). Unit tests for the new pure
// helpers (savesToDestinationLabel, correctionDiffersFromRequest,
// pendingQueueIds/pendingQueuePosition -- the pending-only counter/nav
// helper) plus structural (text-only) pins on improvement.tsx and
// ledger.tsx. Same lightweight, dependency-free readApp/codeOnly pattern as
// ux-round8-task1.test.ts / ux-round8-task2.test.ts / ux-round8-task3.test.ts
// (kept in its own new file per the global constraints).
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
const LEDGER = "routes/_authenticated/ledger.tsx";

// ---- 1. savesToDestinationLabel: the four exact strings the brief gives ----

test("harness-ux.ts: savesToDestinationLabel returns the four exact 'Saves to' strings", () => {
  assert.equal(ux.savesToDestinationLabel("knowledge", "project"), "This project's Knowledge");
  assert.equal(
    ux.savesToDestinationLabel("knowledge", "workspace"),
    "All my projects (Workspace Knowledge)",
  );
  // "knowledge" with no explicit target (null/undefined) defaults to the
  // project-scoped label, same convention as destinationLabelPlain.
  assert.equal(ux.savesToDestinationLabel("knowledge", null), "This project's Knowledge");
  assert.equal(ux.savesToDestinationLabel("skill", "project"), "Skill");
  assert.equal(ux.savesToDestinationLabel("skill", "workspace"), "Skill");
  assert.equal(ux.savesToDestinationLabel("both", "project"), "Knowledge and Skill");
  assert.equal(ux.savesToDestinationLabel("both", "workspace"), "Knowledge and Skill");
  assert.equal(ux.savesToDestinationLabel(null, "project"), "This project's Knowledge");
});

test("harness-ux.ts: SUGGESTED_INSTRUCTION_LABEL and SAVES_TO_LABEL are the exact required strings", () => {
  assert.equal(ux.SUGGESTED_INSTRUCTION_LABEL, "Suggested instruction");
  assert.equal(ux.SAVES_TO_LABEL, "Saves to");
});

// ---- 2. correctionDiffersFromRequest: drop "Your correction" on a verbatim
// repeat of "Requested" ----

test("harness-ux.ts: correctionDiffersFromRequest is false only when the trimmed texts match", () => {
  assert.equal(ux.correctionDiffersFromRequest("Add a footer.", "Add a footer."), false);
  // Whitespace-only differences still count as the same text.
  assert.equal(ux.correctionDiffersFromRequest("  Add a footer.\n", "Add a footer."), false);
  assert.equal(
    ux.correctionDiffersFromRequest("Add a footer.", "No, add it in dark mode too."),
    true,
  );
  // No "Requested" text on record: any real correction still counts as its
  // own fact (never silently hidden just because there's nothing to compare
  // it to).
  assert.equal(ux.correctionDiffersFromRequest(null, "Add a footer."), true);
  assert.equal(ux.correctionDiffersFromRequest(undefined, "Add a footer."), true);
  // No correction at all: nothing to show either way.
  assert.equal(ux.correctionDiffersFromRequest("Add a footer.", null), false);
});

// ---- 3. pendingQueueIds / pendingQueuePosition: the pending-only counter
// and Previous/Next helper ----

test("harness-ux.ts: pendingQueueIds keeps only pending items, in the caller's own order", () => {
  const items = [
    { id: 1, decision: { status: "pending" } },
    { id: 2, decision: { status: "accepted" } },
    { id: 3, decision: { status: "pending" } },
    { id: 4, decision: { status: "skipped" } },
    { id: 5, decision: { status: "pending" } },
  ];
  assert.deepEqual(ux.pendingQueueIds(items), [1, 3, 5]);
  assert.deepEqual(ux.pendingQueueIds([]), []);
});

test("harness-ux.ts: pendingQueuePosition reports 1-based index, total, and neighbour ids", () => {
  const pendingIds = [10, 20, 30];
  assert.deepEqual(ux.pendingQueuePosition(pendingIds, 10), {
    index: 1,
    total: 3,
    prevId: null,
    nextId: 20,
  });
  assert.deepEqual(ux.pendingQueuePosition(pendingIds, 20), {
    index: 2,
    total: 3,
    prevId: 10,
    nextId: 30,
  });
  assert.deepEqual(ux.pendingQueuePosition(pendingIds, 30), {
    index: 3,
    total: 3,
    prevId: 20,
    nextId: null,
  });
});

test("harness-ux.ts: pendingQueuePosition is null for an id outside the pending queue (a decided item opened by a direct link)", () => {
  const pendingIds = [10, 20, 30];
  assert.equal(ux.pendingQueuePosition(pendingIds, 999), null);
  assert.equal(ux.pendingQueuePosition([], 10), null);
});

// ---- 4. ledger.tsx: Previous/Next and the counter are built from the
// pending queue only ----

test("ledger.tsx: imports and uses pendingQueueIds/pendingQueuePosition from harness-ux.ts", () => {
  const code = codeOnly(readApp(LEDGER));
  assert.match(
    code,
    /import \{ pendingQueueIds, pendingQueuePosition \} from "@\/lib\/harness-ux";/,
  );
  assert.match(code, /const pendingIds = pendingQueueIds\(all\);/);
  assert.match(code, /const pos = pendingQueuePosition\(pendingIds, selected\.id\);/);
});

// ---- 5. improvement.tsx: decision card leads, story second, the collapsed
// why-recommends details third, Technical details last ----

test("improvement.tsx: ImprovementDetail renders in order: DecisionCard, 'What happened', the collapsed why-recommends details, Technical details", () => {
  const code = codeOnly(readApp(DETAIL));
  const body = code.slice(code.indexOf("export function ImprovementDetail"));
  const order = [
    "<DecisionCard",
    "What happened",
    "{WHY_RECOMMENDS_TITLE}",
    'title="Technical details"',
  ];
  let last = -1;
  for (const marker of order) {
    const at = body.indexOf(marker);
    assert.ok(at > last, `expected "${marker}" after the previous marker`);
    last = at;
  }
});

test("improvement.tsx: 'What the action will do' is gone -- each button already carries its own consequence line", () => {
  const raw = readApp(DETAIL);
  assert.ok(!raw.includes("What the action will do"));
});

test("improvement.tsx: the decision card shows 'Suggested instruction' and a 'Saves to' line with savesToDestinationLabel and the existing Change destination control inline", () => {
  const code = codeOnly(readApp(DETAIL));
  const card = code.slice(
    code.indexOf("export function DecisionCard"),
    code.indexOf("export function ImprovementDetail"),
  );
  assert.match(card, /\{SUGGESTED_INSTRUCTION_LABEL\}/);
  assert.match(card, /\{SAVES_TO_LABEL\}/);
  assert.match(
    card,
    /savesToDestinationLabel\(item\.content_destination\?\.value \?\? null, item\.destination\)/,
  );
  assert.match(card, /<ChangeDestinationControl item=\{item\} busy=\{busy\} run=\{run\} \/>/);
});

test("improvement.tsx: the instruction's own duplicated title is gone -- item.title never renders as a heading in DecisionCard's non-compact body", () => {
  const code = codeOnly(readApp(DETAIL));
  const card = code.slice(
    code.indexOf("export function DecisionCard"),
    code.indexOf("export function ImprovementDetail"),
  );
  assert.ok(!/<Title\b/.test(card), "no <Title> element left in the non-compact card");
  assert.ok(!card.includes("{item.title}"), "item.title no longer rendered as a duplicated title");
});

test("improvement.tsx: the collapsed why-recommends details contains the prediction, Why, and Alternative, in order, and is collapsed by default", () => {
  const code = codeOnly(readApp(DETAIL));
  const body = code.slice(code.indexOf("export function ImprovementDetail"));
  const detailsAt = body.indexOf("<details");
  const summaryAt = body.indexOf("{WHY_RECOMMENDS_TITLE}", detailsAt);
  const closeAt = body.indexOf("</details>", summaryAt);
  assert.ok(detailsAt >= 0 && summaryAt > detailsAt && closeAt > summaryAt);
  const fold = body.slice(detailsAt, closeAt);
  const lessonAt = fold.indexOf("{lessonLine(item)}");
  const whyAt = fold.indexOf("{DESTINATION_WHY}");
  const altAt = fold.indexOf("{DESTINATION_ALTERNATIVE}");
  assert.ok(lessonAt >= 0 && whyAt > lessonAt && altAt > whyAt);
  const raw = readApp(DETAIL);
  for (const tag of raw.match(/<details[^>]*>/g) ?? []) {
    assert.ok(!/\sopen\b/.test(tag), `collapsed by default, got: ${tag}`);
  }
});

test("improvement.tsx: the 'What happened' story shows 'Your correction' only when correctionDiffersFromRequest says so", () => {
  const code = codeOnly(readApp(DETAIL));
  const body = code.slice(code.indexOf("export function ImprovementDetail"));
  const story = body.slice(body.indexOf("What happened"), body.indexOf("{WHY_RECOMMENDS_TITLE}"));
  assert.match(
    story,
    /\{correctionDiffersFromRequest\(item\.story\.requested, item\.story\.correction\) \? \(/,
  );
});

// ---- 6. SkillProposalPanel: the Skill draft that used to live inside the
// removed "Why Knowledge or Skill" card still renders, unchanged ----

test("improvement.tsx: SkillProposalPanel (formerly part of DestinationChoice) still renders the Skill draft's Edit/Approve/Retire/Publish actions", () => {
  const code = codeOnly(readApp(DETAIL));
  assert.match(code, /function SkillProposalPanel\(/);
  assert.match(code, /<SkillProposalPanel item=\{item\} busy=\{busy\} run=\{run\} \/>/);
  assert.match(code, /action: "edit_skill_proposal"/);
  assert.match(code, /action: "approve_skill_proposal"/);
  assert.match(code, /action: "retire_skill_proposal"/);
  assert.match(code, /action: "publish_skill_proposal"/);
});
