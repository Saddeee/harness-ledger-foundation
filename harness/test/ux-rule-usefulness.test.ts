import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Checkpoint 2026-09-18 WP3 (spec §9, §12): rule usefulness is a decision,
// never a causal claim; the detail page leads with status, recommendation
// and primary action; History names a restore by the version restored from.
const ux = await import("../../src/lib/harness-ux.ts");

function readApp(rel: string): string {
  return readFileSync(new URL(`../../src/${rel}`, import.meta.url), "utf8");
}
function codeOnly(source: string): string {
  return source
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}

test("usefulness copy never claims a rule helped or harmed", () => {
  const source = codeOnly(readApp("lib/harness-ux.ts"));
  const strings = [...source.matchAll(/"([^"\n]*)"/g)].map((m) => m[1]!);
  // Round 8 Task 1 item 4: SKIP_RECOMMENDED_CONSEQUENCE_LINE is the brief's
  // own exact, verbatim required copy for the Inbox card's Skip-recommended
  // consequence line, and it does say "helped" -- but this ban exists to
  // stop the general usefulness decision (VERDICT_QUESTION, healthLine, the
  // rule's own "is it still useful" framing) from asserting unproven
  // causation. This one line is different in kind: it reports what ONE
  // specific staged test already showed ("The test suggests..."), hedged,
  // the same honest evidence-reporting register as CONCLUSION_LABELS itself
  // -- not a claim that a live rule generally helped or didn't.
  // Round 9 Task 1: NOT_HELPED_NOTE is the same kind of exemption as
  // SKIP_RECOMMENDED_CONSEQUENCE_LINE above -- it reports what one specific
  // staged test already showed ("The test suggests..."), hedged, not a
  // claim that a live instruction generally helped or didn't.
  const exempt = new Set([ux.SKIP_RECOMMENDED_CONSEQUENCE_LINE, ux.NOT_HELPED_NOTE]);
  for (const s of strings) {
    if (exempt.has(s)) continue;
    assert.ok(!/\bhelped\b/i.test(s), `copy claims help: ${s}`);
    assert.ok(!/harm than good/i.test(s), `copy claims harm: ${s}`);
  }
  // Round 9 Task 1 / spec §2: "instruction", never "rule", in UI copy.
  assert.equal(ux.VERDICT_QUESTION, "Is this instruction still useful?");
});

// Round 9 Task 1 / spec §4: observedLine/aiReviewLine now delegate to
// observedSentence/aiCheckSentence's plain wording -- never "Harness Ledger
// found..."/"AI review marked...".
test("observed and AI review are two separate lines with the spec's wording", () => {
  assert.equal(
    ux.observedLine({
      applicable_tasks: 3,
      hurt: 3,
      last_applicable_at: null,
      observed_repeat: 3,
      observed_clear: 0,
    }),
    "You corrected this again in 3 of 3 later builds.",
  );
  assert.equal(
    ux.aiReviewLine({ ai_not_followed: 3, ai_followed: 0 }),
    "Lovable's replies show the instruction was not followed in 3 of 3 later builds.",
  );
  assert.equal(ux.aiReviewLine({ ai_not_followed: 0, ai_followed: 0 }), null);
});

test("Needs attention and Review for relevance blocks", () => {
  const needs = ux.attentionBlock({
    applicable_tasks: 3,
    hurt: 3,
    last_applicable_at: null,
    observed_repeat: 3,
    observed_clear: 0,
    review_reason: "repeated_issue",
  })!;
  // Round 9 Task 7 / spec §2 vocabulary: "rule" -> "instruction"; "Review
  // rule" is banned outright -- this field is not currently rendered by any
  // page (only `.line` is), so it gets attentionBlock's own "inactive"
  // branch's replacement value, "Open Instructions".
  assert.equal(needs.title, "Needs attention");
  assert.equal(needs.recommendation, "Rewrite this instruction or turn it into a Skill.");
  assert.equal(needs.action, "Open Instructions");
  const inactive = ux.attentionBlock({
    applicable_tasks: 0,
    hurt: 0,
    last_applicable_at: null,
    review_reason: "inactive",
  })!;
  assert.equal(inactive.title, "Review for relevance");
  assert.deepEqual(inactive.options, ["Keep", "Move to Skill", "Retest", "Retire"]);
  assert.equal(ux.attentionBlock({ applicable_tasks: 1, hurt: 0, last_applicable_at: null }), null);
});

// Round 9 Task 4 / spec §1 principle 4, §5: the detail leads with the
// instruction now, not a separate status/recommendation block --
// AttentionBlock (the old "Current status" + Recommendation card, its own
// separate Keep/Move-to-Skill/Retest/Retire row) is gone outright.
// live_attention offers the SAME action set as any other live instruction
// (Keep/Retire/Test/Open, via InstructionActions); why it's asking is one
// line in the card's own evidence, never a different section or a
// different action set.
test("improvement.tsx: the detail page leads with the instruction (DecisionCard); AttentionBlock is gone, and the retire card asks the usefulness question", () => {
  const code = codeOnly(readApp("components/harness/improvement.tsx"));
  const detail = code.slice(code.indexOf("export function ImprovementDetail"));
  assert.ok(!/AttentionBlock/.test(detail), "no AttentionBlock left on the detail page");
  const card = detail.indexOf("<DecisionCard");
  assert.ok(card > -1, "the detail page leads with DecisionCard");
  const backAt = detail.indexOf("{backLabel}");
  assert.ok(backAt > -1 && backAt < card, "the back link comes before the decision card");
  assert.ok(!/function AttentionBlock/.test(code));
  assert.ok(!/Did this rule help/.test(code));
  assert.ok(!/Harness Ledger suggests retiring this rule\s*<\/Title>/.test(code));
});

test("History: a restore reads 'Restored Knowledge from version N' and a version node carries reason, restored-from and rule deltas", () => {
  const server = codeOnly(readFileSync(new URL("../src/improvements.ts", import.meta.url), "utf8"));
  assert.ok(server.includes("`Restored Knowledge from version ${v.restored_from_version_id}`"));
  assert.ok(!/Went back to before version/.test(server));
  for (const field of ["reason:", "restored_from_version_id:", "rules_added:", "rules_removed:"]) {
    assert.ok(server.includes(field), `TimelineNode missing ${field}`);
  }
  const timeline = codeOnly(readApp("components/harness/timeline.tsx"));
  // Round 9 Task 7 / spec §2 vocabulary: "Rules" -> "Instructions" (the
  // server's own TimelineNode fields, rules_added/rules_removed, are
  // identifiers, unchanged).
  for (const label of ["Restored from", "Reason", "Instructions added", "Instructions removed"]) {
    assert.ok(timeline.includes(label), `timeline.tsx missing "${label}"`);
  }
  assert.ok(!/went back to before/.test(timeline));
});
