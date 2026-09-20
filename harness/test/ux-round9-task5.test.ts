// Round 9 Task 5 (2026-09-20): Instructions flattened to headings and rows
// with the shared action set (spec §5 Instructions). Same lightweight,
// dependency-free readApp/codeOnly/slice pattern as ux-round9-task3.test.ts
// / ux-round9-task4.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ux = await import("../../src/lib/harness-ux.ts");

function readApp(rel: string): string {
  return readFileSync(new URL(`../../src/${rel}`, import.meta.url), "utf8");
}
function codeOnly(source: string): string {
  return source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}
function slice(code: string, start: string, end: string): string {
  const a = code.indexOf(start);
  assert.ok(a >= 0, `missing marker: ${start}`);
  const b = code.indexOf(end, a);
  assert.ok(b > a, `missing marker after ${start}: ${end}`);
  return code.slice(a, b);
}
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const INSTRUCTIONS_PAGE = "routes/_authenticated/instructions.tsx";
const IMPROVEMENT = "components/harness/improvement.tsx";
const DECISION_LAYOUT = "components/harness/decision-layout.tsx";

// ---- 1. The brief's own failing pins ----

test("instructions.tsx: no NeedsAttentionSection, no DropdownMenu import, no VerdictControl import; renders <InstructionActions and an Open link carrying from=instructions", () => {
  const code = codeOnly(readApp(INSTRUCTIONS_PAGE));
  assert.ok(!/NeedsAttentionSection/.test(code), "the attention section is gone (Inbox owns it)");
  assert.ok(!/dropdown-menu/.test(code), "no DropdownMenu import left");
  assert.ok(!/VerdictControl/.test(code), "no per-row verdict control left");
  assert.match(code, /<InstructionActions/);
  // InstructionActions' "open" small action renders a plain <a href>, not a
  // TanStack <Link search={{...}}> -- the row's Open link is a query-string
  // URL, so the literal text is "from=instructions", not a `from: "..."`
  // object key.
  assert.match(code, /from=instructions/);
});

test("decision-layout.tsx: RecommendationCallout is no longer declared or exported (a comment may still explain why it was removed)", () => {
  const code = codeOnly(readApp(DECISION_LAYOUT));
  assert.ok(!/function RecommendationCallout/.test(code));
  assert.ok(!/<RecommendationCallout/.test(code));
});

test('instructions.tsx: "Instructions Harness Ledger added" replaces "Rules Harness Ledger added"', () => {
  const raw = readApp(INSTRUCTIONS_PAGE);
  assert.ok(raw.includes("Instructions Harness Ledger added"));
  assert.ok(!raw.includes("Rules Harness Ledger added"));
  assert.equal(ux.INSTRUCTIONS_ADDED_HEADING, "Instructions Harness Ledger added");
});

test("instructions.tsx: at most one 'rounded-md border' per row (RuleRow), zero on the target wrapper (TargetSection)", () => {
  const code = codeOnly(readApp(INSTRUCTIONS_PAGE));
  const row = slice(code, "function RuleRow", "function RetiredInstructionsFold");
  assert.ok(count(row, "rounded-md border") <= 1, "at most one bordered box per row");
  const target = slice(code, "function TargetSection", "function SkillsSection");
  assert.equal(count(target, "rounded-md border"), 0, "no bordered wrapper on the target itself");
});

// ---- 2. No more "..." menu, no more per-row Keep/Review/Retire/Not-sure
// (Round 8's open item 7 -- "Instructions asks a question on every row" --
// is closed by this task) ----

test("instructions.tsx: the old '...' row menu and 'Remove from Knowledge' copy are gone; Retire/Re-add come from InstructionActions", () => {
  const raw = readApp(INSTRUCTIONS_PAGE);
  const code = codeOnly(raw);
  assert.ok(!raw.includes("Remove from Knowledge"));
  assert.ok(!raw.includes('aria-label="Rule actions"'));
  assert.ok(
    !/AlertDialog/.test(code),
    "no hand-rolled AlertDialog left -- InstructionActions owns its own confirms",
  );
  // Retire/Keep/Re-add are posted from inside InstructionActions
  // (improvement.tsx) now, not spelled out again in instructions.tsx's own
  // source -- the row hands over ids via the `rule` prop instead.
  assert.match(code, /rule=\{\{\s*rule_id:\s*rule\.id,\s*improvement_id:\s*improvementId\s*\}\}/);
  assert.ok(
    !/action:\s*"retire"/.test(code),
    "instructions.tsx no longer spells out the retire action itself",
  );
  assert.ok(
    !/action:\s*"readd"/.test(code),
    "instructions.tsx no longer spells out the readd action itself",
  );
});

test("instructions.tsx: no 'Nothing needs your attention' / attention-collection code left (moved to the Inbox's RuleAttentionCard)", () => {
  const code = codeOnly(readApp(INSTRUCTIONS_PAGE));
  assert.ok(!/collectAttentionItems/.test(code));
  assert.ok(!/NOTHING_NEEDS_ATTENTION_LINE/.test(code));
  assert.ok(!/Needs your attention/.test(codeOnly(readApp(INSTRUCTIONS_PAGE))));
  // Round 8's open item 7 ("Instructions asks a question on every row while
  // a section above says nothing needs attention") is closed by removing
  // both halves of the contradiction from this page at once.
  const improvementCode = codeOnly(readApp(IMPROVEMENT));
  assert.match(
    improvementCode,
    /export function RuleAttentionCard/,
    "the Inbox's own attention card exists",
  );
});

// ---- 3. Evidence: observedSentence + aiCheckSentence, never ruleActiveLine/
// aiReviewLine/replayEvidenceLine/attentionBlock's title+recommendation ----

test("instructions.tsx: a row's evidence is observedSentence(rule.health)/aiCheckSentence(rule.health), not the old ruleActiveLine/aiReviewLine/replayEvidenceLine", () => {
  const code = codeOnly(readApp(INSTRUCTIONS_PAGE));
  const row = slice(code, "function RuleRow", "function RetiredInstructionsFold");
  assert.match(row, /observedSentence\(rule\.health/);
  assert.match(row, /aiCheckSentence\(rule\.health/);
  assert.ok(!/ruleActiveLine/.test(code));
  assert.ok(!/aiReviewLine/.test(code));
  assert.ok(!/replayEvidenceLine/.test(code));
});

test("instructions.tsx: a row's state line is instructionStateLine, write_status always 'written'", () => {
  const code = codeOnly(readApp(INSTRUCTIONS_PAGE));
  const row = slice(code, "function RuleRow", "function RetiredInstructionsFold");
  assert.match(row, /instructionStateLine\(\{/);
  assert.match(row, /write_status:\s*"written"/);
});

// ---- 4. Workspace heading: WORKSPACE_TARGET_LABEL, not a bare literal ----

test("instructions.tsx: the workspace target heading uses WORKSPACE_TARGET_LABEL ('All my projects'), not the old 'All your projects (workspace Knowledge)' literal", () => {
  const raw = readApp(INSTRUCTIONS_PAGE);
  const code = codeOnly(raw);
  assert.ok(!raw.includes("All your projects (workspace Knowledge)"));
  assert.match(code, /WORKSPACE_TARGET_LABEL/);
  assert.equal(ux.WORKSPACE_TARGET_LABEL, "All my projects");
  // The explanatory sub-line stays, reworded to say "instructions" (spec §2
  // vocabulary, never "rule" in UI copy).
  assert.match(code, /WORKSPACE_TARGET_EXPLANATION/);
  assert.match(ux.WORKSPACE_TARGET_EXPLANATION, /instructions/i);
  assert.ok(!/\brules\b/i.test(ux.WORKSPACE_TARGET_EXPLANATION));
});

// ---- 5. Empty target: heading + "No instructions yet." + the Knowledge
// fold, no card ----

test("instructions.tsx: a target with no active instructions renders NO_INSTRUCTIONS_YET_LINE, not the old 'No rules yet.'", () => {
  const raw = readApp(INSTRUCTIONS_PAGE);
  const code = codeOnly(raw);
  assert.match(code, /NO_INSTRUCTIONS_YET_LINE/);
  assert.equal(ux.NO_INSTRUCTIONS_YET_LINE, "No instructions yet.");
  assert.ok(!raw.includes("No rules yet."));
});

test('instructions.tsx: the workspace "no instructions" fallback note says "instructions", not "rules"', () => {
  const raw = readApp(INSTRUCTIONS_PAGE);
  const code = codeOnly(raw);
  assert.match(code, /NO_WORKSPACE_INSTRUCTIONS_LINE/);
  assert.ok(!raw.includes("No workspace-wide rules yet."));
  assert.match(ux.NO_WORKSPACE_INSTRUCTIONS_LINE, /instructions/);
});

// ---- 6. Retired instructions fold: renamed, reuses AdvancedDetails,
// collapsed, rows use InstructionActions (state retired -> Re-add) ----

test("instructions.tsx: the retired fold is 'Retired instructions (N)', not 'Retired rules (N)', and reuses AdvancedDetails", () => {
  const raw = readApp(INSTRUCTIONS_PAGE);
  const code = codeOnly(raw);
  assert.match(code, /retiredInstructionsFoldLabel\(/);
  assert.equal(ux.retiredInstructionsFoldLabel(3), "Retired instructions (3)");
  assert.ok(!raw.includes("Retired rules ("));
  const fold = slice(code, "function RetiredInstructionsFold", "function TargetSection");
  assert.match(fold, /<AdvancedDetails\b/);
  assert.match(fold, /<RuleRow key=\{r\.id\} rule=\{r\} retired busy=\{busy\} run=\{run\} \/>/);
});

test("harness-ux.ts: every <details> this page opens starts collapsed (no hardcoded open)", () => {
  const raw = readApp(INSTRUCTIONS_PAGE);
  for (const tag of raw.match(/<details[^>]*>/g) ?? []) {
    assert.ok(!/\sopen\b/.test(tag), `details tag must not be open: ${tag}`);
  }
});

// ---- 7. Test-copy targets are skipped in the section list too (ProjectFilter
// already hides them from the chips, Round 9 Task 2) ----

test("instructions.tsx: test-copy project targets are filtered out of the section list via isTestCopyProject", () => {
  const code = codeOnly(readApp(INSTRUCTIONS_PAGE));
  assert.match(code, /isTestCopyProject\(t\.name\)/);
});

// ---- 8. InstructionActions: `item` optional, new `rule` prop supplies ids
// for a row that has no full Improvement ----

test("improvement.tsx: InstructionActions takes an optional `item` and an optional `rule` prop ({ rule_id, improvement_id }) for a caller with no full Improvement", () => {
  const code = codeOnly(readApp(IMPROVEMENT));
  const fn = slice(code, "export function InstructionActions", "const btnSize");
  assert.match(fn, /item\?:\s*Improvement/, "item is now optional");
  assert.match(fn, /rule\?:\s*\{\s*rule_id:\s*number;\s*improvement_id:\s*number \| null\s*\}/);
});

test("improvement.tsx: InstructionActions derives ruleId/improvementId from item OR rule, and Test renders nothing without a real item", () => {
  const code = codeOnly(readApp(IMPROVEMENT));
  const body = slice(code, "export function InstructionActions", "function DecidedStatus");
  assert.match(body, /const ruleId = item\?\.rule_id \?\? rule\?\.rule_id \?\? null;/);
  assert.match(body, /const improvementId = item\?\.id \?\? rule\?\.improvement_id \?\? null;/);
  // Test needs TestInfo, which a `rule`-only caller never has.
  const renderSmall = slice(body, "function renderSmall", "const primaryEl = renderMain(");
  assert.match(renderSmall, /case "test":[\s\S]{0,200}return item \?/);
});

test("improvement.tsx: readd posts the derived improvementId, guarded on it being non-null", () => {
  const code = codeOnly(readApp(IMPROVEMENT));
  const body = slice(code, "export function InstructionActions", "function DecidedStatus");
  assert.match(body, /case "readd":\s*\n\s*if \(improvementId == null\) return null;/);
  assert.match(body, /action: "readd", id: improvementId/);
});

// ---- 9. Full test suite pattern: run rowRun/rowBusy through useRun, not a
// hand-rolled retire/readd useMutation pair ----

test("instructions.tsx: Page() drives every row through one shared useRun (rowBusy/rowRun), not separate retire/readd useMutations", () => {
  const code = codeOnly(readApp(INSTRUCTIONS_PAGE));
  assert.match(code, /const \{ busy: rowBusy, run: rowRun \} = useRun\(/);
  assert.ok(!/const retireRule = useMutation/.test(code));
  assert.ok(!/const readdRule = useMutation/.test(code));
  // Sync now and Cancel (the pending-write banner) are untouched.
  assert.match(code, /const cancelWrite = useMutation/);
  assert.match(code, /const syncNow = useMutation/);
});

// ---- 10. Sync now: kept in the page header, and inside the pending-write
// banner (the one place a per-target duplicate is legitimate) ----

test("instructions.tsx: the 'Sync now' BUTTON exists exactly twice -- the page header, and the pending-write banner (kept there per the brief, never a third copy)", () => {
  const raw = readApp(INSTRUCTIONS_PAGE);
  const occurrences = [...raw.matchAll(/"Syncing…"\s*:\s*"Sync now"/g)].length;
  assert.equal(occurrences, 2, "header + pending-write banner, no other duplicate button");
});
