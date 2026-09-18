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
  for (const s of strings) {
    assert.ok(!/\bhelped\b/i.test(s), `copy claims help: ${s}`);
    assert.ok(!/harm than good/i.test(s), `copy claims harm: ${s}`);
  }
  assert.equal(ux.VERDICT_QUESTION, "Is this rule still useful?");
});

test("observed and AI review are two separate lines with the spec's wording", () => {
  assert.equal(
    ux.observedLine({
      applicable_tasks: 3,
      hurt: 3,
      last_applicable_at: null,
      observed_repeat: 3,
      observed_clear: 0,
    }),
    "Harness found the same issue in all 3 relevant builds.",
  );
  assert.equal(
    ux.aiReviewLine({ ai_not_followed: 3, ai_followed: 0 }),
    "AI review marked the rule as not followed in 3 of 3 relevant builds.",
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
  assert.equal(needs.title, "Needs attention");
  assert.equal(needs.recommendation, "Rewrite this rule or turn it into a Skill.");
  assert.equal(needs.action, "Review rule");
  const inactive = ux.attentionBlock({
    applicable_tasks: 0,
    hurt: 0,
    last_applicable_at: null,
    review_reason: "inactive",
  })!;
  assert.equal(inactive.title, "Review for relevance");
  assert.deepEqual(inactive.options, ["Keep", "Archive", "Move to Skill", "Retest", "Retire"]);
  assert.equal(ux.attentionBlock({ applicable_tasks: 1, hurt: 0, last_applicable_at: null }), null);
});

test("improvement.tsx: the attention block comes before the DecisionCard on the detail page, and the retire card asks the usefulness question", () => {
  const code = codeOnly(readApp("components/harness/improvement.tsx"));
  const detail = code.slice(code.indexOf("export function ImprovementDetail"));
  const attention = detail.indexOf("<AttentionBlock");
  const card = detail.indexOf("<DecisionCard");
  assert.ok(attention > -1 && card > -1 && attention < card, "AttentionBlock before DecisionCard");
  assert.match(code, /function AttentionBlock/);
  for (const opt of [
    'verdict: "keep"',
    'destination: "skill"',
    'action: "test"',
    'verdict: "retire"',
  ]) {
    assert.ok(code.includes(opt), `attention block option missing: ${opt}`);
  }
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
  for (const label of ["Restored from", "Reason", "Rules added", "Rules removed"]) {
    assert.ok(timeline.includes(label), `timeline.tsx missing "${label}"`);
  }
  assert.ok(!/went back to before/.test(timeline));
});
