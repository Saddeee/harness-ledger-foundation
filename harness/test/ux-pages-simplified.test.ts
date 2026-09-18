// Checkpoint 2 2-C: structural pins for the simplified Instructions, Skills
// and History pages -- section order, the exact per-rule status lines, the
// Skills page's card fields and section order, the History page's "Current
// Knowledge" box ahead of the timeline with diffs collapsed, and the
// checkpoint-wide banned-word list across every file this WP touched. Same
// lightweight, dependency-free readApp/codeOnly source-text-pin pattern as
// ux-round3-pages.test.ts and friends (kept in its own file -- other WPs
// are editing shared files concurrently).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ux = await import("../../src/lib/harness-ux.ts");

function readApp(rel: string): string {
  return readFileSync(new URL(`../../src/${rel}`, import.meta.url), "utf8");
}
// Stricter than the repo's usual line-prefix codeOnly (which misses a
// continuation line of a multi-line {/* ... */} JSX comment): strips whole
// block comments first, JSX or plain, then line comments -- needed here
// because the banned-word scan below reads arbitrary substrings, and a
// multi-line comment's own continuation lines (e.g. explaining why a word
// like "helped" is banned) must never trip it.
function codeOnly(source: string): string {
  return source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}

const INSTRUCTIONS_PAGE = "routes/_authenticated/instructions.tsx";
const SKILLS_PAGE = "routes/_authenticated/skills.tsx";
const HISTORY_PAGE = "routes/_authenticated/history.tsx";
const TIMELINE = "components/harness/timeline.tsx";

// ---- 1. Instructions: section order -- Needs your attention, Knowledge,
// Skills ----

test("instructions.tsx: 'Needs your attention' comes before 'Knowledge', which comes before 'Skills'", () => {
  const raw = readApp(INSTRUCTIONS_PAGE);
  const code = codeOnly(raw);
  // NeedsAttentionSection and SkillsSection are their own components,
  // defined (and so textually present) above Page() -- what actually
  // proves render order is where Page()'s own JSX invokes/inlines each
  // section, so scope the search to Page()'s body.
  const pageAt = code.indexOf("function Page()");
  assert.ok(pageAt >= 0, "function Page() not found");
  const page = code.slice(pageAt);
  const attentionAt = page.indexOf("<NeedsAttentionSection");
  const knowledgeAt = page.indexOf('id="instructions-knowledge"');
  const skillsAt = page.indexOf("<SkillsSection");
  assert.ok(attentionAt >= 0, "Page() does not render <NeedsAttentionSection>");
  assert.ok(knowledgeAt >= 0, "Page() has no Knowledge section");
  assert.ok(skillsAt >= 0, "Page() does not render <SkillsSection>");
  assert.ok(attentionAt < knowledgeAt, "Needs your attention must come before Knowledge");
  assert.ok(knowledgeAt < skillsAt, "Knowledge must come before Skills");
});

test("instructions.tsx: only rules whose health status is 'review' or 'retire_suggested' are collected for Needs your attention", () => {
  const code = codeOnly(readApp(INSTRUCTIONS_PAGE));
  assert.match(code, /status !== "review" && status !== "retire_suggested"/);
  assert.ok(ux.NOTHING_NEEDS_ATTENTION_LINE === "Nothing needs your attention.");
  assert.match(code, /NOTHING_NEEDS_ATTENTION_LINE/);
});

// ---- 2. Instructions: the exact per-rule status lines ----

test("harness-ux.ts: ruleActiveLine and replayEvidenceLine read exactly as specified", () => {
  assert.equal(ux.ruleActiveLine(true), "Active in Lovable");
  assert.equal(ux.ruleActiveLine(false), "Active, not replay-tested");
  assert.equal(ux.replayEvidenceLine(null), null);
  assert.equal(ux.replayEvidenceLine(undefined), null);
  assert.equal(ux.replayEvidenceLine({ conclusion: null }), "Replay judged");
  assert.equal(ux.replayEvidenceLine({ conclusion: "not_a_real_value" }), "Replay judged");
  assert.equal(
    ux.replayEvidenceLine({ conclusion: "historical_support" }),
    ux.CONCLUSION_LABELS.historical_support,
  );
});

test("instructions.tsx: renders ruleActiveLine/observedLine/aiReviewLine/replayEvidenceLine as separate lines, and the attention block takes their place when a rule needs review", () => {
  const code = codeOnly(readApp(INSTRUCTIONS_PAGE));
  assert.match(code, /ruleActiveLine\(rule\.judged_run != null\)/);
  assert.match(code, /observedLine\(rule\.health/);
  assert.match(code, /aiReviewLine\(rule\.health/);
  assert.match(code, /replayEvidenceLine\(rule\.judged_run/);
  assert.match(code, /attentionBlock\(rule\.health/);
  assert.match(code, /<VerdictControl ruleId=\{rule\.id\}/);
});

// ---- 3. Skills: section order and card fields ----

test("skills.tsx: 'In Lovable' before 'Proposed by Harness Ledger', and every proposal card's required fields", () => {
  const raw = readApp(SKILLS_PAGE);
  const code = codeOnly(raw);
  const workspaceAt = raw.indexOf("In Lovable");
  const proposedAt = raw.indexOf("Proposed by Harness Ledger");
  assert.ok(workspaceAt >= 0 && proposedAt >= 0 && workspaceAt < proposedAt);

  assert.match(code, /proposal\.name/);
  assert.match(code, /skillProposalStatusLabel\(proposal\.status\)/);
  assert.match(code, /skillProposalPurpose\(/);
  assert.match(code, /skillProposalAppliesWhen\(/);
  assert.match(code, /skillProposalProcedurePreview\(/);
  assert.match(code, /proposal\.correction_candidate_id/);
  assert.match(code, /proposal\.correction_summary/);
  assert.match(code, /\{SKILL_NOT_PUBLISHED_LINE\}/);
  assert.match(code, />\s*\{REVIEW_SKILL_LABEL\}\s*</);
  assert.equal(ux.REVIEW_SKILL_LABEL, "Review Skill");

  // no control here implies a remote create/update/enable/disable
  for (const word of [
    "create_workspace_skill",
    "update_workspace_skill",
    "delete_workspace_skill",
  ]) {
    assert.ok(!code.includes(word), `skills.tsx must not reference ${word}`);
  }
});

// ---- 4. History: "Current Knowledge" box ahead of the timeline, diffs
// collapsed ----

test("history.tsx: 'Current Knowledge' box appears before the Timeline is rendered", () => {
  const code = codeOnly(readApp(HISTORY_PAGE));
  const currentAt = code.indexOf('id="current-knowledge"');
  const timelineAt = code.indexOf("<Timeline");
  assert.ok(currentAt >= 0, "no Current Knowledge section found");
  assert.ok(timelineAt >= 0, "no <Timeline> render found");
  assert.ok(currentAt < timelineAt, "Current Knowledge must come before the Timeline");
  assert.match(code, /Current Knowledge/);
  assert.match(code, /<ManagedBlockText/);
});

test("timeline.tsx: full text/diff is collapsed inside its own closed <details>, version detail rows stay outside it", () => {
  const raw = readApp(TIMELINE);
  const code = codeOnly(raw);
  assert.match(code, /<details>\s*<summary/, "the full text/diff has its own <details>");
  assert.ok(raw.includes("Show full text"));
  // The dl of version detail rows (Version/Restored from/Reason/Rules
  // added/Rules removed/By/When) is not inside that same <details> -- it
  // still renders directly once a node is selected.
  const dlAt = code.indexOf("<dl");
  const detailsAt = code.indexOf("<details>");
  assert.ok(dlAt >= 0 && detailsAt >= 0 && dlAt < detailsAt);
  for (const label of [
    "Version",
    "Restored from",
    "Reason",
    "Rules added",
    "Rules removed",
    "By",
    "When",
  ]) {
    assert.ok(raw.includes(label), `timeline.tsx missing version detail row "${label}"`);
  }
  // still nothing expanded by default anywhere.
  for (const tag of code.match(/<details[^>]*>/g) ?? []) {
    assert.ok(!/\sopen\b/.test(tag), `details tag must not be open: ${tag}`);
  }
});

// ---- 5. Checkpoint-wide banned words, across every file this WP touched ----

const TOUCHED_FILES = [INSTRUCTIONS_PAGE, SKILLS_PAGE, HISTORY_PAGE, TIMELINE];

test("no banned words in the Instructions/Skills/History/Timeline pages", () => {
  for (const rel of TOUCHED_FILES) {
    const code = codeOnly(readApp(rel));
    // Only user-facing strings matter (JSX text/attributes) -- codeOnly
    // already strips comment-only lines.
    assert.ok(!/\bpaired test\b/i.test(code), `${rel}: "paired test"`);
    assert.ok(!/\bproof\b/i.test(code), `${rel}: "proof"`);
    assert.ok(!/\bboth builds\b/i.test(code), `${rel}: "both builds"`);
    assert.ok(!/\bhelped\b/i.test(code), `${rel}: "helped"`);
    assert.ok(!/\bharm\b/i.test(code), `${rel}: "harm"`);
    assert.ok(!/\bharmful\b/i.test(code), `${rel}: "harmful"`);
    assert.ok(!/\bfree\b/i.test(code), `${rel}: unqualified "free"`);
    assert.ok(!/SPEC\.md/.test(code), `${rel}: "SPEC.md"`);
    assert.ok(!/\bcheckpoint\b/i.test(code), `${rel}: "checkpoint"`);
    assert.ok(!/went back to before/i.test(code), `${rel}: "Went back to before"`);
  }
});

test("harness-ux.ts's Checkpoint 2 2-C section carries no banned words", () => {
  const raw = readApp("lib/harness-ux.ts");
  const start = raw.indexOf("// ---- Checkpoint 2 2-C ----");
  const end = raw.indexOf("// ---- end Checkpoint 2 2-C ----");
  assert.ok(start >= 0 && end > start, "Checkpoint 2 2-C section not found in harness-ux.ts");
  const section = codeOnly(raw.slice(start, end));
  const strings = [...section.matchAll(/"([^"\n]*)"/g)].map((m) => m[1]!);
  for (const s of strings) {
    assert.ok(!/\bhelped\b/i.test(s), `copy claims help: ${s}`);
    assert.ok(!/\bharm\b/i.test(s), `copy claims harm: ${s}`);
    assert.ok(!/\bproof\b/i.test(s), `copy claims proof: ${s}`);
  }
});
