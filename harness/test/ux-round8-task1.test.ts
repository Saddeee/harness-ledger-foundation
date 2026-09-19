// UX round 8 (2026-09-19), Task 1: Inbox reword (review items 1, 3, 4, 8) and
// conclusion labels. Same lightweight, dependency-free readApp/codeOnly
// pattern as ux-inbox-simplified.test.ts / ux-round6-cards.test.ts (kept in
// its own new file per the global constraints).
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

const SHELL = "routes/_authenticated/route.tsx";
const INSTRUCTIONS_PAGE = "routes/_authenticated/instructions.tsx";
const INBOX_PAGE = "routes/_authenticated/inbox.tsx";
const IMPROVEMENT = "components/harness/improvement.tsx";
const LOCAL_SETTINGS = "components/harness/local-settings.tsx";

// ---- 1. sidebarSyncLine: all four branches (item 3) ----

test("harness-ux.ts: sidebarSyncLine -- ok true, ok false (with/without finished_at, with/without next try), ok null (syncing), no last run", () => {
  // Times computed via ux.formatTime itself (same convention as
  // ux-round6-writes.test.ts's own formatTime pins) so this test doesn't
  // hardcode a timezone-dependent "HH:MM" literal.
  const finishedAt = "2026-09-19T10:00:00.000Z";
  const nextRunAt = "2026-09-19T11:00:00.000Z";
  const finishedTime = ux.formatTime(finishedAt);
  const nextTime = ux.formatTime(nextRunAt);

  assert.equal(
    ux.sidebarSyncLine({ finished_at: finishedAt, ok: true }, null),
    `Last sync ${finishedTime}`,
  );
  assert.equal(
    ux.sidebarSyncLine({ finished_at: finishedAt, ok: false }, null),
    `Last sync failed at ${finishedTime}`,
  );
  assert.equal(
    ux.sidebarSyncLine({ finished_at: finishedAt, ok: false }, nextRunAt),
    `Last sync failed at ${finishedTime} · next try ${nextTime}`,
  );
  assert.equal(ux.sidebarSyncLine({ finished_at: null, ok: false }, null), "Last sync failed");
  assert.equal(
    ux.sidebarSyncLine({ finished_at: null, ok: false }, nextRunAt),
    `Last sync failed · next try ${nextTime}`,
  );
  assert.equal(ux.sidebarSyncLine({ finished_at: null, ok: null }, null), "Syncing now");
  assert.equal(ux.sidebarSyncLine(null, null), null);
  // The raw error string must never appear in what this helper returns --
  // the sidebar's own honesty rule (item 3).
  assert.ok(
    !ux
      .sidebarSyncLine({ finished_at: finishedAt, ok: false }, null)!
      .includes("Lovable API error"),
  );
});

// ---- 2. analysisStatusLine: three branches (item 8) ----

test("harness-ux.ts: analysisStatusLine -- unanalysed count (singular/plural), up to date with a last-checked time, nothing analysed yet", () => {
  const lastAnalysisAt = "2026-09-19T10:00:00.000Z";
  const lastAnalysisTime = ux.formatTime(lastAnalysisAt);
  assert.equal(ux.analysisStatusLine(null, 1), "1 new message to analyse");
  assert.equal(ux.analysisStatusLine(null, 3), "3 new messages to analyse");
  assert.equal(
    ux.analysisStatusLine(lastAnalysisAt, 0),
    `Up to date · last checked ${lastAnalysisTime}`,
  );
  assert.equal(ux.analysisStatusLine(null, 0), "Nothing analysed yet");
  // Pending count wins over a stale last-checked time -- never both at once.
  assert.equal(ux.analysisStatusLine(lastAnalysisAt, 2), "2 new messages to analyse");
});

// ---- 3. recommendedPrimaryAction: the new "skip" outcome (item 4) ----

test("harness-ux.ts: recommendedPrimaryAction returns skip for not_supported/possibly_harmful, ignores historical_support/inconclusive/null", () => {
  const base = {
    content_destination: { value: "knowledge" as const },
    decision: { test_first: false },
  };
  assert.equal(ux.recommendedPrimaryAction(base, "not_supported"), "skip");
  assert.equal(ux.recommendedPrimaryAction(base, "possibly_harmful"), "skip");
  assert.equal(ux.recommendedPrimaryAction(base, "historical_support"), "add");
  assert.equal(ux.recommendedPrimaryAction(base, "inconclusive"), "add");
  assert.equal(ux.recommendedPrimaryAction(base, null), "add");
  assert.equal(ux.recommendedPrimaryAction(base), "add");
  // Skip wins even over a skill-only destination or an already-staged test --
  // the test already answered the question those two branches exist to ask.
  assert.equal(
    ux.recommendedPrimaryAction(
      { content_destination: { value: "skill" }, decision: { test_first: false } },
      "not_supported",
    ),
    "skip",
  );
  assert.equal(
    ux.recommendedPrimaryAction(
      { content_destination: { value: "knowledge" }, decision: { test_first: true } },
      "possibly_harmful",
    ),
    "skip",
  );
});

// ---- 4. The four conclusion labels, in plain words (item 6) ----

test("harness-ux.ts: CONCLUSION_LABELS reads in plain words, no 'replay'/'regression' jargon", () => {
  assert.deepEqual(ux.CONCLUSION_LABELS, {
    historical_support: "Correction not needed in the rebuilt copy",
    not_supported: "Correction still needed, even with the rule",
    possibly_harmful: "The rule may have made it worse",
    inconclusive: "Can't tell from this test",
  });
});

test("harness-ux.ts: replayJudgedLine prefixes 'Test result:', not 'Replay judged:'", () => {
  assert.equal(
    ux.replayJudgedLine("not_supported"),
    "Test result: Correction still needed, even with the rule",
  );
  assert.equal(ux.replayJudgedLine(null), null);
  assert.equal(ux.replayJudgedLine(undefined), null);
});

// ---- 5. Item 4's exact skip-recommended consequence line ----

test("harness-ux.ts: SKIP_RECOMMENDED_CONSEQUENCE_LINE reads exactly as specified", () => {
  assert.equal(
    ux.SKIP_RECOMMENDED_CONSEQUENCE_LINE,
    "The test suggests this rule would not have helped. Skipping changes nothing in Lovable.",
  );
});

// ---- 6. route.tsx: honest, untruncated sidebar sync status (item 3) ----

test("route.tsx: the status line is no longer truncated, no longer carries the user's e-mail, and reads sidebarSyncLine as a second line", () => {
  const code = codeOnly(readApp(SHELL));
  assert.ok(!/\btruncate\b/.test(code), "no truncate class anywhere in the sidebar footer");
  assert.ok(!/\{user\?\.email\}/.test(code), "the user e-mail line must be gone");
  assert.match(code, /sidebarSyncLine\(/);
  assert.match(code, /"Connected to Lovable"/);
  assert.match(code, /"Not connected — connect on Projects"/);
  // Sign out survives -- only the e-mail line was removed.
  assert.match(code, /Sign out/);
});

// ---- 7. instructions.tsx / inbox.tsx: AnalyseNotice moved to Settings ----

test("instructions.tsx: no longer imports AnalyseNotice", () => {
  const code = codeOnly(readApp(INSTRUCTIONS_PAGE));
  assert.ok(!/AnalyseNotice/.test(code), "instructions.tsx must not reference AnalyseNotice");
});

test("inbox.tsx: imports neither AnalyseNotice nor lessonLine as a heading", () => {
  const code = codeOnly(readApp(INBOX_PAGE));
  assert.ok(!/AnalyseNotice/.test(code), "inbox.tsx must not reference AnalyseNotice");
  assert.ok(!/\blessonLine\b/.test(code), "inbox.tsx must not import/use lessonLine directly");
  assert.match(code, /analysisStatusLine\(/);
});

test("local-settings.tsx: mounts AnalyseNotice at the end of the AI analysis section", () => {
  const code = codeOnly(readApp(LOCAL_SETTINGS));
  const section = slice(code, '<h2 className="text-lg font-medium">AI analysis</h2>', "</section>");
  assert.match(section, /<AnalyseNotice/);
  // Mounted after the provider test button, i.e. at the end of the section.
  const testBtnAt = section.indexOf("TEST_PROVIDER_BUTTON_LABEL");
  const noticeAt = section.indexOf("<AnalyseNotice");
  assert.ok(
    testBtnAt >= 0 && noticeAt > testBtnAt,
    "AnalyseNotice must come after the provider test button",
  );
});

// Round 8 Task 1 fix 1: "Reanalyse history" (its trigger, dialog and token
// figures) moved off the Inbox and into Settings > AI analysis, rendered
// directly under <AnalyseNotice />; the Inbox keeps only the one-line
// analysisStatusLine + its own plain "Analyse now" button.
test("inbox.tsx no longer contains REANALYSE_TRIGGER_BUTTON; local-settings.tsx does, after AnalyseNotice", () => {
  const inboxCode = codeOnly(readApp(INBOX_PAGE));
  assert.ok(
    !/REANALYSE_TRIGGER_BUTTON/.test(inboxCode),
    "inbox.tsx must no longer reference REANALYSE_TRIGGER_BUTTON",
  );
  assert.ok(
    !/REANALYSE_TOKENS_NOTE/.test(inboxCode),
    "inbox.tsx must no longer reference REANALYSE_TOKENS_NOTE",
  );
  assert.ok(
    !/ReanalyseDialog/.test(inboxCode),
    "inbox.tsx must no longer reference ReanalyseDialog",
  );

  const settingsCode = codeOnly(readApp(LOCAL_SETTINGS));
  const section = slice(
    settingsCode,
    '<h2 className="text-lg font-medium">AI analysis</h2>',
    "</section>",
  );
  assert.match(section, /\{REANALYSE_TRIGGER_BUTTON\}/);
  assert.match(section, /\{REANALYSE_TOKENS_NOTE\}/);
  assert.match(section, /<ReanalyseDialog/);
  const noticeAt = section.indexOf("<AnalyseNotice");
  const triggerAt = section.indexOf("{REANALYSE_TRIGGER_BUTTON}");
  assert.ok(
    noticeAt >= 0 && triggerAt > noticeAt,
    "the Reanalyse trigger must come after <AnalyseNotice />",
  );
});

// ---- 8. CompactDecisionCard: item.title is the heading, not lessonLine (item 1) ----

test("improvement.tsx: CompactDecisionCard's heading is item.title; lessonLine's own prediction moved inside the 'Why Harness Ledger recommends this' details", () => {
  const code = codeOnly(readApp(IMPROVEMENT));
  const compact = slice(code, "function CompactDecisionCard", "export function DecisionCard");
  // The onOpen title button renders item.title, not lessonLine's output.
  const headingButton = slice(
    compact,
    'className="text-left hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"',
    "</button>",
  );
  assert.match(headingButton, /\{heading\}/);
  assert.ok(!/\{lesson\}/.test(headingButton), "the heading button must not render {lesson}");
  // lessonLine(item) is still called (for the details below), and the
  // details block renders it as its own paragraph.
  assert.match(compact, /const lesson = lessonLine\(item\);/);
  assert.match(compact, /const heading = item\.title;/);
  const details = slice(compact, '<details className="rounded-md border">', "</details>");
  assert.match(details, /\{WHY_RECOMMENDS_TITLE\}/);
  assert.match(details, /<p>\{lesson\}<\/p>/);
});

test("improvement.tsx: recommendedPrimaryAction is now called with this card's own conclusion", () => {
  const code = codeOnly(readApp(IMPROVEMENT));
  const compact = slice(code, "function CompactDecisionCard", "export function DecisionCard");
  assert.match(compact, /recommendedPrimaryAction\(item, conclusion\)/);
});

test("improvement.tsx: when recommended is 'skip', the card renders Skip as primary with the exact consequence line and Add instruction as secondary, never a duplicate tertiary Skip", () => {
  const code = codeOnly(readApp(IMPROVEMENT));
  const compact = slice(code, "function CompactDecisionCard", "export function DecisionCard");
  const skipBranch = slice(compact, 'recommended === "skip" ?', 'recommended === "review_skill"');
  // \s+ tolerates however Prettier wraps these attributes (same convention
  // as ux.test.ts's own AddConfirm/RemoveFromKnowledgeConfirm pins).
  assert.match(
    skipBranch,
    /<SkipConfirm\s+item=\{item\}\s+busy=\{busy\}\s+run=\{run\}\s+size=\{size\}\s+variant="default"\s*\/>/,
  );
  assert.match(skipBranch, /\{SKIP_RECOMMENDED_CONSEQUENCE_LINE\}/);
  assert.match(
    skipBranch,
    /<AddInstructionConfirm\s+item=\{item\}\s+busy=\{busy\}\s+run=\{run\}\s+size=\{size\}\s+variant="outline"\s*\/>/,
  );
  assert.match(compact, /recommended !== "skip" \? \(\s*<SkipConfirm/);
});

// ---- 9. "the assistant" -> "Lovable" in analysis prompts (item 2) ----

test("harness/src/analysis: prompt text says Lovable, not 'the assistant', wherever it refers to the builder", () => {
  const classify = readHarness("src/analysis/classify.ts");
  const propose = readHarness("src/analysis/propose.ts");
  assert.ok(!classify.includes("the assistant"), "classify.ts must not say 'the assistant'");
  assert.ok(!propose.includes("the assistant"), "propose.ts must not say 'the assistant'");
  assert.ok(classify.includes("confirming/accepting Lovable's last change"));
  assert.ok(propose.includes("a summary of Lovable's build"));
  assert.ok(propose.includes("(the user's and Lovable's)"));
  // The code path (message.role === "assistant") is untouched -- never a
  // field name or JSON schema value.
  assert.match(classify, /message\.role === "assistant"/);
});
