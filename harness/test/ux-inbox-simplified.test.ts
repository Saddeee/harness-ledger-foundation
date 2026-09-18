// Checkpoint 2 2-B: structural + unit pins for the Inbox card's Level 1
// simplification (one recommended primary action, a plain-language lesson,
// a plain-words destination label, and verbatim consequence lines) and the
// Suggestions detail's six-section reorder (the "What happened" story,
// "Technical details" holding the full message history). Same lightweight,
// dependency-free readApp/codeOnly pattern as ux-round6-cards.test.ts (kept
// in its own new file per the work package instructions).
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
function slice(code: string, start: string, end: string): string {
  const a = code.indexOf(start);
  assert.ok(a >= 0, `missing marker: ${start}`);
  const b = code.indexOf(end, a);
  assert.ok(b > a, `missing marker after ${start}: ${end}`);
  return code.slice(a, b);
}

const IMPROVEMENT = "components/harness/improvement.tsx";
const HARNESS_UX = "lib/harness-ux.ts";
const IMPROVEMENTS_SRC = "src/improvements.ts";
const CLIENT = "lib/improvements-client.ts";

function compactCardSource(): string {
  const code = codeOnly(readApp(IMPROVEMENT));
  return slice(code, "function CompactDecisionCard", "export function DecisionCard");
}

// ---- 1. The four primary action labels, exact ----

test("harness-ux.ts: PRIMARY_ACTION_LABELS has exactly the four required labels", () => {
  assert.deepEqual(ux.PRIMARY_ACTION_LABELS, {
    add: "Add instruction",
    review_skill: "Review Skill",
    test_first: "Test first",
    skip: "Skip",
  });
});

// ---- 2. actionConsequence: verbatim consequence lines ----

test("harness-ux.ts: actionConsequence returns the exact consequence line for every action, verbatim", () => {
  assert.equal(
    ux.actionConsequence("add", "project"),
    "Writes to Lovable Knowledge in this project. No Lovable credits. No AI tokens.",
  );
  assert.equal(
    ux.actionConsequence("add", "workspace"),
    "Writes to Lovable Knowledge for all your projects. No Lovable credits. No AI tokens.",
  );
  // No destination given defaults to the project wording (never silently
  // says "workspace" without being told so).
  assert.equal(
    ux.actionConsequence("add"),
    "Writes to Lovable Knowledge in this project. No Lovable credits. No AI tokens.",
  );
  assert.equal(
    ux.actionConsequence("review_skill"),
    "Opens the Skill proposal. Nothing changes in Lovable.",
  );
  assert.equal(
    ux.actionConsequence("test_first"),
    "Runs one Lovable build in a temporary copy. Uses Lovable credits. Nothing changes in your project.",
  );
  assert.equal(
    ux.actionConsequence("skip"),
    "Nothing changes in Lovable. Harness Ledger will not propose this again.",
  );
});

// ---- 3. destinationLabelPlain: plain words, never an internal enum name ----

test("harness-ux.ts: destinationLabelPlain returns the four plain-word labels", () => {
  assert.equal(ux.destinationLabelPlain("knowledge", "project"), "Project Knowledge");
  assert.equal(ux.destinationLabelPlain("knowledge", "workspace"), "Workspace Knowledge");
  assert.equal(ux.destinationLabelPlain("skill", "project"), "Skill");
  assert.equal(ux.destinationLabelPlain("both", "workspace"), "Knowledge and Skill");
  // No destination target recorded yet still reads as Project Knowledge,
  // never a raw null or an internal value.
  assert.equal(ux.destinationLabelPlain("knowledge", null), "Project Knowledge");
});

// ---- 4. lessonLine: classifier summary first, evidence excerpt fallback ----

test("harness-ux.ts: lessonLine prefers correction_summary, falls back to the first evidence excerpt, never invents", () => {
  assert.equal(
    ux.lessonLine({ correction_summary: "Prices should show SEK, not EUR.", evidence: [] }),
    "Prices should show SEK, not EUR.",
  );
  assert.equal(
    ux.lessonLine({
      correction_summary: null,
      evidence: [{ text: "Please always use SEK for prices going forward." }],
    }),
    "Please always use SEK for prices going forward.",
  );
  assert.equal(
    ux.lessonLine({ correction_summary: "", evidence: [] }),
    "Harness Ledger found something in your Lovable chat worth a decision.",
  );
});

// ---- 5. recommendedPrimaryAction: the closed, mutually exclusive set ----

test("harness-ux.ts: recommendedPrimaryAction picks Review Skill for a skill-only destination, Test first when already staged, else Add -- Skip is never the recommendation", () => {
  assert.equal(
    ux.recommendedPrimaryAction({
      content_destination: { value: "skill" },
      decision: { test_first: false },
    }),
    "review_skill",
  );
  assert.equal(
    ux.recommendedPrimaryAction({
      content_destination: { value: "knowledge" },
      decision: { test_first: true },
    }),
    "test_first",
  );
  assert.equal(
    ux.recommendedPrimaryAction({
      content_destination: { value: "knowledge" },
      decision: { test_first: false },
    }),
    "add",
  );
  assert.equal(
    ux.recommendedPrimaryAction({ content_destination: null, decision: { test_first: false } }),
    "add",
  );
});

// ---- 6. Inbox card: the exact Level 1 fields, one primary action, no banned enum names ----

test("improvement.tsx: CompactDecisionCard shows the project name, lesson, instruction, plain destination label + reason, and calls the shared consequence/label helpers rather than inlining copy", () => {
  const compact = compactCardSource();
  assert.match(compact, /projectName\(item\)/);
  assert.match(compact, /lessonLine\(item\)/);
  assert.match(compact, /item\.proposed_instruction/);
  assert.match(compact, /item\.skill_proposal\?\.name/);
  assert.match(compact, /destinationLabelPlain\(/);
  assert.match(compact, /contentDestinationReason\(/);
  assert.match(compact, /actionConsequence\(/);
  assert.match(compact, /PRIMARY_ACTION_LABELS\./);
  assert.match(compact, /recommendedPrimaryAction\(item\)/);
});

test("improvement.tsx: the Inbox card never spells out an internal enum name -- only plain-language helpers appear in its JSX", () => {
  const compact = compactCardSource();
  for (const enumName of [
    "missing_requirement",
    "constraint_restatement",
    "preference_revision",
    "one_time",
    "retire_suggested",
  ]) {
    assert.ok(!compact.includes(enumName), `${enumName} must not appear in the Inbox card`);
  }
});

test("improvement.tsx: the Inbox card's secondary controls (raw classification, the alternative destination, changing scope) collapse into a 'More' <details>, never sharing the primary action's visual weight", () => {
  const compact = compactCardSource();
  const more = slice(compact, '<details className="rounded-md border">', "</details>");
  assert.match(more, />\s*More\s*</);
  assert.match(more, /whyFor\(item\.classification\)/);
  assert.match(more, /contentDestinationAlternative\(/);
  // The alternative-scope Add lives here too, styled outline (never the
  // recommended action's own default styling).
  assert.match(more, /variant="outline"/);
});

// ---- 7. Suggestions detail: the "What happened" story, in order ----

test("improvement.tsx: ImprovementDetail's 'What happened' section shows Requested, Built, Your correction, Changed afterward, in that order", () => {
  const code = codeOnly(readApp(IMPROVEMENT));
  const detail = code.slice(code.indexOf("export function ImprovementDetail"));
  const story = slice(detail, "What happened", "What Harness Ledger learned");
  const order = ["Requested", "Built", "Your correction", "Changed afterward"];
  let last = -1;
  for (const label of order) {
    const at = story.indexOf(label);
    assert.ok(at > last, `expected "${label}" after the previous label in the story`);
    last = at;
  }
  assert.match(story, /item\.story\.requested/);
  assert.match(story, /item\.story\.built/);
  assert.match(story, /item\.story\.correction/);
  assert.match(story, /item\.story\.changed_afterward/);
  assert.match(story, /"Not recorded"/);
});

test("improvement.tsx: the six-section order names every section exactly once, before the primary decision", () => {
  const code = codeOnly(readApp(IMPROVEMENT));
  const detail = code.slice(code.indexOf("export function ImprovementDetail"));
  for (const heading of [
    "What happened",
    "What Harness Ledger learned",
    "What Harness Ledger recommends",
    "Why Knowledge or Skill",
    "What the action will do",
  ]) {
    const first = detail.indexOf(heading);
    const second = detail.indexOf(heading, first + 1);
    assert.ok(first >= 0, `missing section: ${heading}`);
    assert.equal(second, -1, `section "${heading}" must appear exactly once`);
  }
  const recommendsAt = detail.indexOf("What Harness Ledger recommends");
  const decisionAt = detail.indexOf("<DecisionCard");
  assert.ok(recommendsAt >= 0 && decisionAt > recommendsAt, "the decision card comes last");
});

// ---- 8. Technical details: the evidence list moved inside the collapsed <details> ----

test("improvement.tsx: 'Technical details' is a collapsed <details> (via AdvancedDetails) containing the full evidence list, not the main body", () => {
  const raw = readApp(IMPROVEMENT);
  const code = codeOnly(raw);
  const detail = code.slice(code.indexOf("export function ImprovementDetail"));
  const techAt = detail.indexOf('title="Technical details"');
  assert.ok(techAt >= 0, 'expected AdvancedDetails title="Technical details"');
  const evidenceMapAt = detail.indexOf("item.evidence.map((m) =>");
  assert.ok(evidenceMapAt > techAt, "the evidence list must render after Technical details opens");
  // Never open by default.
  for (const tag of raw.match(/<details[^>]*>/g) ?? []) {
    assert.ok(!/\sopen\b/.test(tag), `collapsed by default, got: ${tag}`);
  }
});

// ---- 9. harness/src/improvements.ts: correction_summary and story are wired ----

test("harness/src/improvements.ts: buildImprovement carries correction_summary and story; buildRetireItem sets both null", () => {
  const server = codeOnly(readHarness(IMPROVEMENTS_SRC));
  assert.match(server, /correction_summary: c\.summary,/);
  assert.match(server, /story: buildImprovementStory\(c, visible\[0\] \?\? null\),/);
  assert.match(server, /correction_summary: null,\s*story: null,/);
  assert.match(server, /function buildImprovementStory\(/);
  assert.match(server, /function replyAfterCorrection\(/);
});

test("improvements-client.ts: Improvement carries correction_summary and a typed story", () => {
  const client = codeOnly(readApp(CLIENT));
  assert.match(client, /correction_summary: string \| null;/);
  assert.match(
    client,
    /story: \{\s*requested: string;\s*built: string;\s*correction: string;\s*changed_afterward: string \| null;\s*\} \| null;/,
  );
});
