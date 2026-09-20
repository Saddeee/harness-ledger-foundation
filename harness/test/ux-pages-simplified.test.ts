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
// Round 9 Task 2:
const PROJECT_FILTER = "components/harness/project-filter.tsx";
const TIMELINE = "components/harness/timeline.tsx";

// ---- 1. Instructions: section order -- Knowledge, Skills ----
// Round 9 Task 5 / spec §1 principle 6, §5: "Needs your attention" is gone
// from this page outright -- every decision it asked for is decidable on
// the Inbox's own attention card (RuleAttentionCard, improvement.tsx)
// instead, so there is no longer a first section to order ahead of
// Knowledge here. Round 8's open item 7 ("Instructions asks a question on
// every row while a section above says nothing needs attention") is closed
// by removing both halves of that contradiction at once.

test("instructions.tsx: 'Knowledge' comes before 'Skills'; there is no 'Needs your attention' section any more", () => {
  const raw = readApp(INSTRUCTIONS_PAGE);
  const code = codeOnly(raw);
  const pageAt = code.indexOf("function Page()");
  assert.ok(pageAt >= 0, "function Page() not found");
  const page = code.slice(pageAt);
  assert.ok(!/NeedsAttentionSection/.test(page), "the attention section is gone");
  const knowledgeAt = page.indexOf('id="instructions-knowledge"');
  const skillsAt = page.indexOf("<SkillsSection");
  assert.ok(knowledgeAt >= 0, "Page() has no Knowledge section");
  assert.ok(skillsAt >= 0, "Page() does not render <SkillsSection>");
  assert.ok(knowledgeAt < skillsAt, "Knowledge must come before Skills");
});

test("instructions.tsx: no attention-collection code left -- collectAttentionItems/NOTHING_NEEDS_ATTENTION_LINE moved out with the section", () => {
  const code = codeOnly(readApp(INSTRUCTIONS_PAGE));
  assert.ok(!/collectAttentionItems/.test(code));
  assert.ok(!/NOTHING_NEEDS_ATTENTION_LINE/.test(code));
  assert.equal(ux.NOTHING_NEEDS_ATTENTION_LINE, "Nothing needs your attention.");
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

// Round 9 Task 5 / spec §4-§5: a row's evidence is now the two plain,
// never-merged sentences observedSentence/aiCheckSentence (Round 9 Task 1),
// same convention as Inbox/the detail page -- ruleActiveLine/observedLine/
// aiReviewLine/replayEvidenceLine (the old merged/duplicated wiring) are
// gone from this page; the attention "why" line still takes attentionBlock,
// same as the Inbox's own attention card.
test("instructions.tsx: a row's evidence is observedSentence(rule.health)/aiCheckSentence(rule.health), and the attention block still supplies the 'why' line", () => {
  const code = codeOnly(readApp(INSTRUCTIONS_PAGE));
  assert.match(code, /observedSentence\(rule\.health/);
  assert.match(code, /aiCheckSentence\(rule\.health/);
  assert.match(code, /attentionBlock\(rule\.health/);
  assert.ok(!/ruleActiveLine/.test(code));
  assert.ok(!/observedLine\(/.test(code));
  assert.ok(!/aiReviewLine/.test(code));
  assert.ok(!/replayEvidenceLine/.test(code));
  assert.ok(!/VerdictControl/.test(code));
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

// ---- 3b. Instructions: per-project filter (checkpoint 3 UX fix 2) ----

test("instructions.tsx: validateSearch accepts a project id or 'workspace', drops anything else", () => {
  const code = codeOnly(readApp(INSTRUCTIONS_PAGE));
  assert.match(code, /type InstructionsSearch = \{ project\?: string \}/);
  const start = code.indexOf(
    "validateSearch: (search: Record<string, unknown>): InstructionsSearch",
  );
  assert.ok(start >= 0, "no validateSearch found");
  const body = code.slice(start, code.indexOf("head: () => (", start));
  // Accepts any non-empty string (a project id or "workspace") and nothing
  // else -- same permissive-then-let-the-component-fall-back convention as
  // history.tsx's own ?target=/?id=.
  assert.match(body, /typeof raw === "string" && raw \? raw : undefined/);
});

test("instructions.tsx: a project filter control exists, using harness-ux's own labels rather than a bare 'Workspace' literal", () => {
  const raw = readApp(INSTRUCTIONS_PAGE);
  const code = codeOnly(raw);
  // Round 9 Task 2: the filter control is now the shared <ProjectFilter>
  // (src/components/harness/project-filter.tsx) -- the label/ALL_PROJECTS/
  // WORKSPACE_TARGET literals this test used to pin directly on
  // instructions.tsx now live only inside that one component file.
  assert.match(code, /<ProjectFilter\b/);
  const projectFilterCode = codeOnly(readApp(PROJECT_FILTER));
  assert.match(projectFilterCode, /aria-label=\{label\}/);
  assert.match(projectFilterCode, /ALL_PROJECTS_LABEL/);
  assert.match(projectFilterCode, /WORKSPACE_TARGET_LABEL/);
  assert.equal(ux.INSTRUCTIONS_PROJECT_FILTER_LABEL, "Show");
  assert.equal(ux.ALL_PROJECTS_LABEL, "All projects");
  // Round 9 Task 2: "workspace" is banned as a chip label -- was "Workspace".
  assert.equal(ux.WORKSPACE_TARGET_LABEL, "All my projects");
  // Reconfirms the existing round6c-part-a.test.ts pin from this angle too:
  // the page never spells the word out itself.
  assert.ok(
    !code.includes('"Workspace"'),
    "no bare literal 'Workspace' string in instructions.tsx",
  );
});

// Round 9 Task 5: "Needs your attention" (and collectAttentionItems with
// it) is gone from this page -- Knowledge and Skills still read the
// filtered view exactly as before.
test("instructions.tsx: Knowledge and Skills both read the filtered view", () => {
  const code = codeOnly(readApp(INSTRUCTIONS_PAGE));
  assert.match(code, /const visibleTargets = selectedTarget/);
  assert.match(code, /\{visibleTargets\.map\(/);
  assert.match(code, /const visibleSkillProposals =/);
  assert.match(code, /<SkillsSection proposals=\{visibleSkillProposals\} \/>/);
  // The raw, unfiltered list is never handed straight to a section once the
  // filter exists.
  assert.ok(!/<SkillsSection proposals=\{skillProposals\} \/>/.test(code));
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

test("history.tsx: 'Current Knowledge' is a <details> element, collapsed unless this browser remembers it open", () => {
  const raw = readApp(HISTORY_PAGE);
  const code = codeOnly(raw);
  assert.match(raw, /harness-history-current-knowledge-open/);
  const detailsTags = code.match(/<details\b[^>]*>/g) ?? [];
  assert.ok(detailsTags.length >= 1, "Current Knowledge is not a <details>");
  for (const tag of detailsTags) {
    assert.ok(!/\bopen(?!=)\b/.test(tag), `details tag hardcodes open: ${tag}`);
  }
  assert.match(
    code,
    /<details[^>]*\bopen=\{knowledgeOpen\}/,
    "open state is component state, not a literal",
  );
  // The only way it starts open is the stored value being exactly "1".
  assert.match(code, /localStorage\.getItem\(CURRENT_KNOWLEDGE_OPEN_KEY\) === "1"/);
  // Its own summary still carries the same heading text and now a one-line
  // hint (target name, character count, rule count when known).
  const summaryAt = code.indexOf("<summary");
  const detailsAt = code.indexOf("<details");
  assert.ok(detailsAt >= 0 && summaryAt > detailsAt);
  assert.match(code, /currentKnowledgeHint\(/);
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
