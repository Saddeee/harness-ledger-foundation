// Round 5 Task 4 / spec §3a-§3b: structural tests for the Instructions
// page's rules table and the new History page + its Timeline component.
// Same lightweight, dependency-free readApp/codeOnly pattern as
// ux-round4-retire.test.ts (kept in its own file -- other tasks are editing
// shared files concurrently).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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

const INSTRUCTIONS_PAGE = "routes/_authenticated/instructions.tsx";
const HISTORY_PAGE = "routes/_authenticated/history.tsx";
const TIMELINE = "components/harness/timeline.tsx";
const SKILLS_PAGE = "routes/_authenticated/skills.tsx";
const SHELL = "routes/_authenticated/route.tsx";
const CLIENT = "lib/improvements-client.ts";
const IMPROVEMENTS_SRC = "src/improvements.ts";

// ---- 1. instructions.tsx: rules table, not the old history/diff view ----

test("instructions.tsx: renders a rules table, and the old per-version history view is gone", () => {
  const raw = readApp(INSTRUCTIONS_PAGE);
  const code = codeOnly(raw);

  assert.match(code, /<Table/, "instructions.tsx must render the shadcn Table for rules");
  assert.ok(!raw.includes("What changed"), 'instructions.tsx must not say "What changed" any more');
  assert.ok(
    !code.includes("versions.map"),
    "instructions.tsx must not map over a per-target versions array any more",
  );

  // the Knowledge text lives inside a collapsed DetailSection now (which
  // itself renders a <details>, see decision-layout.tsx), titled with its
  // own character count (spec §3a).
  assert.match(code, /<DetailSection[\s\S]{0,20}title=\{`Full Knowledge text as Lovable sees it/);
  assert.ok(raw.includes("Full Knowledge text as Lovable sees it"));
  assert.match(code, /\(\$\{content\.length\} characters\)/);

  // rules table columns/status vocabulary (spec §3a)
  for (const text of [
    "Rule",
    "Status",
    "Since",
    "Observed",
    "In Lovable",
    "Staged",
    "Needs attention",
    "Testing",
  ]) {
    assert.ok(raw.includes(text), `instructions.tsx missing rules-table text "${text}"`);
  }
  assert.ok(raw.includes("No rules yet."));

  // Round 6 Task 4 / spec §4: the row's trailing cell no longer keeps a
  // bare Retire button (it's now a "…" menu with Remove from Knowledge and
  // Open suggestion) and the Observed cell's own verdict-buttons marker was
  // replaced by an actual <VerdictControl> -- the still-live "adherence-line"
  // marker (a JSX comment, stripped out of `code` by codeOnly -- check the
  // raw source instead) is the one part of this row Task 4 didn't touch.
  assert.ok(raw.includes("{/* adherence-line */}"));
  assert.ok(!raw.includes("{/* verdict-buttons */}"), "replaced by a real <VerdictControl>");

  // Fix round 1: the row itself keeps native <tr> semantics -- clicking
  // anywhere in the row is a mouse-only convenience navigating to the
  // rule's Suggestions detail, but the row must not claim role="link" or
  // steal a tab stop from the table; the rule text is reachable by keyboard
  // through its own focusable Link/Button in the first cell instead.
  assert.ok(!raw.includes('role="link"'), "the <tr> must not override its role to link");
  assert.ok(!code.includes('role: "link"'), "the <tr> must not override its role to link");
  assert.match(
    code,
    /<Link to="\/ledger" search=\{\{ improvement: improvementId \}\}/,
    "the rule cell must render a focusable Link when there's a Suggestions detail to open",
  );
  assert.match(code, /to: "\/ledger", search: \{ improvement: improvementId \}/);
});

// ---- 2. Restore (postKnowledge) moved off Instructions; only the client
// helpers it still needs remain ----

test("instructions.tsx: no longer stages a restore (postKnowledge) -- that moved to the History page", () => {
  const code = codeOnly(readApp(INSTRUCTIONS_PAGE));
  assert.ok(!/postKnowledge\(/.test(code));
  assert.ok(!/\bfetch\(/.test(code), "instructions.tsx must not call fetch directly");
});

// ---- 3. history.tsx exists and is wired up ----

test("history.tsx: fetches the timeline, has a target selector and the empty-state copy", () => {
  const raw = readApp(HISTORY_PAGE);
  const code = codeOnly(raw);

  assert.match(code, /<h1[^>]*>History<\/h1>/);
  assert.match(code, /fetchTimeline/);
  assert.match(code, /fetchKnowledge/);
  assert.match(code, /postKnowledge\(/, "restore now lives on the History page");
  assert.match(code, /queryKey:\s*\["harness-timeline"/);
  assert.match(code, /<Timeline\b/);
  assert.match(code, /aria-pressed/);

  assert.ok(
    raw.includes(
      "Nothing has happened here yet. Rules you add, changes Harness writes, and your decisions will show up here.",
    ),
  );

  // unavailable/error/loading states mirror the Instructions page's
  assert.ok(raw.includes("Knowledge is available when Harness runs on your machine."));
  assert.match(code, /Loading…/);
  assert.match(code, /role="alert"/);

  // demo banner, copied from Instructions
  assert.ok(raw.includes("Demo data is loaded so you can see how history looks."));
  assert.ok(raw.includes("harness:demo -- --remove"));

  // search params: target/id, optional
  assert.match(code, /validateSearch/);
  assert.match(code, /target\?:\s*"project"\s*\|\s*"workspace"/);

  assert.ok(!/\bfetch\(/.test(code), "history.tsx must not call fetch directly");
});

// ---- 4. timeline.tsx: expand/collapse, diff toggle, restore, labels ----

test("timeline.tsx: aria-expanded nodes, a diff toggle, Restore, nothing expanded by default", () => {
  const raw = readApp(TIMELINE);
  const code = codeOnly(raw);

  assert.match(code, /export function Timeline/);
  assert.match(code, /aria-expanded/);
  assert.ok(raw.includes("Show as diff"));
  assert.ok(raw.includes("Full text"));
  assert.ok(raw.includes("Undo this change"));
  assert.ok(raw.includes("Go back to before this change"));
  assert.ok(raw.includes("Open suggestion"));
  assert.ok(raw.includes("went back to before #"));

  // a single selection, defaulting to nothing selected -- never expanded by
  // default.
  assert.match(code, /useState<string \| null>\(null\)/);

  // ManagedBlockText and WhatChangedLines moved here, and are exported so
  // instructions.tsx can still use ManagedBlockText.
  assert.match(code, /export function ManagedBlockText/);
  assert.match(code, /export function WhatChangedLines/);

  // no <details open> anywhere
  for (const tag of code.match(/<details[^>]*>/g) ?? []) assert.ok(!/\sopen\b/.test(tag));

  assert.ok(!/\bfetch\(/.test(code), "timeline.tsx must not call fetch directly");
});

test("timeline.tsx: instructions.tsx imports ManagedBlockText from it (moved, not duplicated)", () => {
  const instructionsCode = codeOnly(readApp(INSTRUCTIONS_PAGE));
  assert.match(
    instructionsCode,
    /import \{ ManagedBlockText \} from "@\/components\/harness\/timeline"/,
  );
  // the old local copies are gone from instructions.tsx
  assert.ok(!/function ManagedBlockText/.test(instructionsCode));
  assert.ok(!/function WhatChangedLines/.test(instructionsCode));
});

// ---- 5. every §3b node-kind label string appears somewhere in the server
// (buildTimeline, harness/src/improvements.ts) or the client (timeline.tsx)
// ----

test("every History timeline label from spec §3b appears in improvements.ts or timeline.tsx", () => {
  const combined = readHarness(IMPROVEMENTS_SRC) + readApp(TIMELINE);
  for (const label of [
    "Written to Lovable",
    "Staged",
    "Needs attention",
    "Failed",
    "Cancelled",
    "Changed in Lovable (outside Harness)",
    "You accepted",
    "Accepted automatically (confidence",
    "You skipped",
    "You retired",
    "Re-added",
    "Harness suggested retiring",
    "You kept it",
    "You said this rule helped",
    "You said this rule didn't help",
  ]) {
    assert.ok(combined.includes(label), `missing timeline label "${label}"`);
  }
});

// ---- 6. Nav + Skills wiring ----

test("route.tsx: NAV includes /history between Instructions and Skills", () => {
  const shell = codeOnly(readApp(SHELL));
  assert.match(shell, /\{ to: "\/history", label: "History" \}/);
  const instructionsAt = shell.indexOf('{ to: "/instructions"');
  const historyAt = shell.indexOf('{ to: "/history"');
  const skillsAt = shell.indexOf('{ to: "/skills"');
  assert.ok(instructionsAt < historyAt && historyAt < skillsAt);
});

test("skills.tsx: links to the History page for the workspace's Skills", () => {
  const raw = readApp(SKILLS_PAGE);
  const code = codeOnly(raw);
  assert.match(code, /to="\/history"/);
  assert.match(code, /search=\{\{ target: "workspace", id: workspaceId \}\}/);
  assert.ok(raw.includes("See on the History page"));
});

// ---- 7. improvements-client.ts: versions dropped from KnowledgeTargetView
// (Task 3 added the fields; this task removes the per-target versions list)
// ----

test("improvements-client.ts: KnowledgeTargetView no longer carries a per-target versions array", () => {
  const client = codeOnly(readApp(CLIENT));
  const start = client.indexOf("export type KnowledgeTargetView");
  const end = client.indexOf("\n};", start);
  const body = client.slice(start, end);
  assert.ok(!/\bversions:/.test(body), "KnowledgeTargetView must not carry `versions` any more");
  assert.match(body, /active_rules: KnowledgeActiveRule\[\]/);
  assert.match(body, /retired_rules: KnowledgeActiveRule\[\]/);
  assert.match(body, /pending_write: \{ version_id: number; created_at: string \} \| null/);
});

// ---- 8. Only the six harness routes are ever fetched, across the new
// files too ----

test("history.tsx and timeline.tsx only use the shared client helpers, never a raw fetch", () => {
  for (const rel of [HISTORY_PAGE, TIMELINE]) {
    const code = codeOnly(readApp(rel));
    assert.ok(!/\bfetch\(/.test(code), `${rel} must not call fetch directly`);
  }
});
