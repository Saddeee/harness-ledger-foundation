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

  // 2026-09-19 demo round (review item 7): the rules table became a card
  // list -- one <article> per rule, no shadcn Table left on this page.
  assert.match(code, /<article\b/, "instructions.tsx must render a card per rule");
  assert.ok(!/<Table\b/.test(code), "instructions.tsx no longer renders the shadcn Table");
  assert.ok(
    !code.includes("<TableHead>Observed</TableHead>"),
    "the Observed column header is gone",
  );
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

  // Round 9 Task 5 / spec §2: the old rule-card status vocabulary ("In
  // Lovable"/"Staged"/"Write needs attention"/"Testing") is gone -- a row's
  // state line is the same instructionStateLine every page shows now
  // ("In Lovable since <date>"/"Retired <date>"), and "No rules yet." is
  // "No instructions yet." (spec §2 vocabulary: "instruction", never
  // "rule").
  assert.ok(!raw.includes("No rules yet."));
  assert.match(code, /NO_INSTRUCTIONS_YET_LINE/);

  // Round 9 Task 5 / spec §1 principle 3, §5: navigating anywhere is "Open
  // ..." -- the row's title is plain text, not a second, unlabeled way to
  // reach the same place; the one link off a row is InstructionActions' own
  // small "Open" action, a plain <a href> (never a DropdownMenu's "Open
  // suggestion", and never the old bare Retire button either -- both are
  // gone with the "…" menu entirely).
  assert.ok(!raw.includes('role="link"'), 'a row must not claim role="link"');
  assert.ok(!/DropdownMenu/.test(code), "the old '...' menu is gone");
  assert.ok(!/Open suggestion/.test(code));
  assert.match(code, /<InstructionActions/);
  assert.match(code, /from=instructions/, "the row's Open link carries from=instructions");
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

  // Round 9 Task 7 / spec §2 vocabulary: "Rules"/"rules" -> "Instructions"/
  // "instructions".
  assert.ok(
    raw.includes(
      "Nothing has happened here yet. Instructions you add, changes Harness Ledger writes, and your decisions about those instructions will show up here.",
    ),
  );

  // unavailable/error/loading states mirror the Instructions page's
  assert.ok(raw.includes("Knowledge is available when Harness Ledger runs on your machine."));
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
  assert.ok(raw.includes("restored from version {node.restored_from}"));

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
    "Write needs attention",
    "Failed",
    "Cancelled",
    "Changed in Lovable (outside Harness Ledger)",
    "You accepted",
    "Accepted automatically (confidence",
    "You skipped",
    "You retired",
    "Re-added",
    "Harness Ledger suggested retiring",
    "You kept it",
    "You said to keep this rule",
    "You said this rule needs a review",
  ]) {
    assert.ok(combined.includes(label), `missing timeline label "${label}"`);
  }
});

// ---- 6. Nav + Skills wiring ----

test("route.tsx: NAV includes /history after Tests (checkpoint 3 order: Instructions, Skills, Tests, History)", () => {
  const shell = codeOnly(readApp(SHELL));
  assert.match(shell, /\{ to: "\/history", label: "History" \}/);
  const instructionsAt = shell.indexOf('{ to: "/instructions"');
  const testsAt = shell.indexOf('{ to: "/tests"');
  const historyAt = shell.indexOf('{ to: "/history"');
  assert.ok(instructionsAt < testsAt && testsAt < historyAt);
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
