// Owner review round 7 (2026-09-19): four owner-reported fixes from an app
// walkthrough --
//   1. Inbox reuses Instructions' own project filter.
//   2. Long free text gets a "See more"/"See less" clamp instead of eating
//      the whole page.
//   3. A limited, safe markdown renderer replaces raw "**"/"###"/backticks
//      in Lovable's own stored text.
//   4. A published Skill proposal no longer appears twice on the Skills
//      page.
// Same lightweight, dependency-free readApp/codeOnly pattern as
// ux-round6-tests-page.test.ts (kept in its own file per the task
// instructions -- other tests are being edited concurrently).
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

const INBOX = "routes/_authenticated/inbox.tsx";
const INSTRUCTIONS = "routes/_authenticated/instructions.tsx";
const ROUTE = "routes/_authenticated/route.tsx";
const IMPROVEMENT = "components/harness/improvement.tsx";
const JUDGE = "routes/_authenticated/judge.tsx";
const SKILLS_PAGE = "routes/_authenticated/skills.tsx";
const CLAMPED_TEXT = "components/harness/clamped-text.tsx";
const LIGHT_MARKDOWN_COMPONENT = "components/harness/light-markdown.tsx";
const LIGHT_MARKDOWN_LIB = "lib/light-markdown.ts";

// ---- 1. Inbox reuses the Instructions project filter ----

test("inbox.tsx: validateSearch accepts a project id or 'workspace', same shape as instructions.tsx", () => {
  const code = codeOnly(readApp(INBOX));
  assert.match(code, /type InboxSearch = \{ project\?: string \}/);
  const start = code.indexOf("validateSearch: (search: Record<string, unknown>): InboxSearch");
  assert.ok(start >= 0, "validateSearch reads the ?project= param");
  const body = code.slice(start, start + 300);
  assert.match(body, /search\["project"\]/);
});

test("inbox.tsx: renders the same 'Show' segmented control and copy as instructions.tsx (All projects / Workspace)", () => {
  const code = codeOnly(readApp(INBOX));
  assert.match(code, /INSTRUCTIONS_PROJECT_FILTER_LABEL/);
  assert.match(code, /ALL_PROJECTS_LABEL/);
  assert.match(code, /WORKSPACE_TARGET_LABEL/);
  assert.match(code, /role="group"/);
  assert.match(code, /aria-label=\{INSTRUCTIONS_PROJECT_FILTER_LABEL\}/);

  // Same three exported labels instructions.tsx itself uses -- one shared
  // vocabulary, not a second, differently-worded filter.
  const instructionsCode = codeOnly(readApp(INSTRUCTIONS));
  assert.match(instructionsCode, /INSTRUCTIONS_PROJECT_FILTER_LABEL/);
  assert.equal(ux.INSTRUCTIONS_PROJECT_FILTER_LABEL, "Show");
  assert.equal(ux.ALL_PROJECTS_LABEL, "All projects");
  assert.equal(ux.WORKSPACE_TARGET_LABEL, "Workspace");
});

test("inbox.tsx: filters by project_id client-side, with a 'Workspace' bucket for items with no project of their own", () => {
  const code = codeOnly(readApp(INBOX));
  // project_id === null (workspace-level or unknown) gets its own bucket,
  // never silently dropped.
  assert.match(code, /it\.project_id \?\? "workspace"/);
  assert.match(code, /const visibleItems = /);
  // Project names/ids come from the existing fetchProjects query (allowed).
  assert.match(code, /fetchProjects/);
  assert.match(code, /projectsQuery\.data\?\.allowed/);
  // The control only appears once there is something to filter.
  // Only projects that currently have an item get a button (the owner's
  // Inbox showed six buttons, test copies included, for three items).
  assert.match(
    code,
    /projectsWithItems\.length >= 2 \|\| \(projectsWithItems\.length >= 1 && hasWorkspaceItem\)/,
  );
  assert.match(code, /projectsWithItems\.map\(\(p\) => \(/);
  assert.doesNotMatch(code, /allowedProjects\.map\(/);
});

test("inbox.tsx: never touches the local API surface -- still filters an already-fetched list, no new fetch", () => {
  const code = codeOnly(readApp(INBOX));
  const targets = [...code.matchAll(/fetch\(\s*[`"]([^`"]*?)(?:\?[^`"]*)?[`"]/g)].map((m) => m[1]);
  for (const t of targets) {
    assert.match(
      t!,
      /^\/api\/public\/harness\/(improvements|runtime|knowledge|executor|projects|skills)$/,
      `unexpected fetch target: ${t}`,
    );
  }
});

test("route.tsx: the sidebar badge still reads the unfiltered ['harness-inbox'] query -- the Inbox filter never touches it", () => {
  const code = codeOnly(readApp(ROUTE));
  assert.match(code, /queryKey:\s*\["harness-inbox"\]/);
});

// ---- 2. "See more" for long text (ClampedText) ----

test("clamped-text.tsx: ClampedText exists with text/lines/className/markdown props, lines defaults to 6", () => {
  const code = codeOnly(readApp(CLAMPED_TEXT));
  assert.match(code, /export function ClampedText\(/);
  assert.match(code, /lines\s*=\s*6/);
  assert.match(code, /SEE_MORE_LABEL/);
  assert.match(code, /SEE_LESS_LABEL/);
  assert.equal(ux.SEE_MORE_LABEL, "See more");
  assert.equal(ux.SEE_LESS_LABEL, "See less");
});

test("clamped-text.tsx: only shows the button once the text actually overflows (measured, not guessed)", () => {
  const code = codeOnly(readApp(CLAMPED_TEXT));
  assert.match(code, /scrollHeight > el\.clientHeight/);
  assert.match(code, /ResizeObserver/);
  assert.match(code, /\{overflowing \?/);
});

// Round 8 Task 4: "What Harness Ledger learned" is no longer a section
// heading -- the story's slice now ends at the collapsed "Why Harness
// Ledger recommends this" details that follows it instead.
test("improvement.tsx: the 'What happened' story (Requested/Built/Your correction/Changed afterward) renders through ClampedText, Built and Changed afterward with markdown", () => {
  const code = codeOnly(readApp(IMPROVEMENT));
  const detail = code.slice(code.indexOf("export function ImprovementDetail"));
  const story = detail.slice(
    detail.indexOf("What happened"),
    detail.indexOf("{WHY_RECOMMENDS_TITLE}"),
  );
  // 2026-09-19 demo round (owner: the request text "looks weird" on the
  // judge page): the user's own request and correction go through the same
  // light markdown as Lovable's replies -- people write "- item" lists and
  // **bold** in prompts too, and the renderer emits no raw HTML either way.
  assert.match(story, /<ClampedText text=\{item\.story\.requested\} markdown \/>/);
  assert.match(story, /<ClampedText text=\{item\.story\.correction\} markdown \/>/);
  assert.match(story, /<ClampedText text=\{item\.story\.built\} markdown \/>/);
  assert.match(story, /<ClampedText text=\{item\.story\.changed_afterward\} markdown \/>/);
});

test("improvement.tsx: MessageBlock renders the message text through ClampedText with markdown", () => {
  const code = codeOnly(readApp(IMPROVEMENT));
  const messageBlock = code.slice(
    code.indexOf("function MessageBlock"),
    code.indexOf("export function ImprovementDetail"),
  );
  // 2026-09-19 demo round: user text renders through the light markdown too.
  assert.match(messageBlock, /<ClampedText text=\{readable\} markdown \/>/);
});

test("judge.tsx: the request text, both summaries, both replies, and BuildColumn's summary all render through ClampedText", () => {
  const code = codeOnly(readApp(JUDGE));
  assert.match(code, /<ClampedText text=\{view\.request_text\} markdown \/>/);
  assert.match(code, /<ClampedText text=\{view\.original_summary\} markdown \/>/);
  assert.match(code, /<ClampedText text=\{view\.copy_summary\} markdown \/>/);
  assert.match(code, /<ClampedText text=\{view\.original_reply\} markdown \/>/);
  assert.match(code, /<ClampedText text=\{view\.copy_reply\} markdown \/>/);
  assert.match(code, /<ClampedText text=\{summary\} markdown lines=\{3\} \/>/);
});

test("judge.tsx and improvement.tsx: code/diff <pre> blocks with their own max-h scroll, and Knowledge/rule text, are left alone", () => {
  // DiffDetails / WhatChangedLines / ManagedBlockText are untouched --
  // ClampedText is never imported into timeline.tsx.
  const timeline = codeOnly(readApp("components/harness/timeline.tsx"));
  assert.ok(
    !timeline.includes("ClampedText"),
    "timeline.tsx (diffs/Knowledge text) stays untouched",
  );
});

// ---- 3. LightMarkdown: a limited, safe markdown renderer, no library ----

test("package.json has no markdown library -- light-markdown.ts is hand-written", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  for (const name of names) {
    assert.ok(!/markdown|marked|remark|showdown/i.test(name), `unexpected markdown dep: ${name}`);
  }
});

test("light-markdown.ts: parseLightMarkdown is a pure function -- no React import", () => {
  const code = readFileSync(new URL(`../../src/${LIGHT_MARKDOWN_LIB}`, import.meta.url), "utf8");
  assert.match(code, /export function parseLightMarkdown\(/);
  assert.ok(!/from ["']react["']/.test(code), "light-markdown.ts must not import React");
});

test("light-markdown.tsx: LightMarkdown renders bold/code/heading/list with no dangerouslySetInnerHTML", () => {
  const code = codeOnly(readApp(LIGHT_MARKDOWN_COMPONENT));
  assert.match(code, /export function LightMarkdown\(/);
  assert.match(code, /<strong/);
  assert.match(code, /<code/);
  assert.match(code, /font-medium/);
  assert.ok(!code.includes("dangerouslySetInnerHTML"), "no raw HTML injection point");
});

test("harness-ux.ts: the markdown pass runs on already <lov-tool-use>-stripped text, same place lovableReplyText/ClampedText apply", () => {
  const uxCode = codeOnly(readApp("lib/harness-ux.ts"));
  assert.match(uxCode, /export function lovableReplyText\(/);
  // Assistant text only ever reaches LightMarkdown through ClampedText's own
  // `markdown` prop, fed `readable`/`humanVisibleText` output -- never the
  // raw m.text/history_items.content directly.
  const improvementCode = codeOnly(readApp(IMPROVEMENT));
  assert.match(
    improvementCode,
    /const readable = isLovable \? lovableReplyText\(m\.text\) : m\.text;/,
  );
});

// ---- 4. Skills: a published proposal no longer appears twice ----

test("skills.tsx: a proposal with lovable_state 'created' is dropped from 'Proposed by Harness Ledger'", () => {
  const code = codeOnly(readApp(SKILLS_PAGE));
  assert.match(
    code,
    /const proposedProposals = proposals\.filter\(\(p\) => p\.lovable_state !== "created"\)/,
  );
  assert.match(code, /proposedProposals\.map\(\(p\) => \(/);
});

test("skills.tsx: 'In Lovable' shows the published-from line and a link back to the proposal, matched by skill name", () => {
  const code = codeOnly(readApp(SKILLS_PAGE));
  assert.match(
    code,
    /const publishedProposals = proposals\.filter\(\(p\) => p\.lovable_state === "created"\)/,
  );
  assert.match(code, /publishedProposalByName\.get\(s\.name\)/);
  assert.match(code, /publishedFromProposalLine\(/);
  assert.match(code, />\s*\{REVIEW_SKILL_LABEL\}\s*</);

  const uxCode = codeOnly(readApp("lib/harness-ux.ts"));
  assert.match(uxCode, /export function publishedFromProposalLine\(day: string\): string/);
  assert.equal(
    ux.publishedFromProposalLine("19 Sep"),
    "Published from a Harness Ledger proposal on 19 Sep.",
  );
});

test("skills.tsx: failed and not_created proposals still show under 'Proposed by Harness Ledger'", () => {
  const code = codeOnly(readApp(SKILLS_PAGE));
  assert.match(code, /\{SKILL_NOT_PUBLISHED_LINE\}/);
  assert.match(code, /skillPublishFailedLine\(proposal\.lovable_error\)/);
});
