// Round 9 Task 2: one ProjectFilter component, used on Inbox, Instructions,
// Tests and History -- replacing each page's own hand-rolled "Show" chip
// row. Same dynamic-import-from-.ts pattern as ux-round9-task1.test.ts for
// the pure isTestCopyProject helper, plus the lightweight, dependency-free
// readApp/codeOnly structural-pin pattern (ux-round8-task5.test.ts and
// friends) for the four route files and the new component file itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isTestCopyProject } from "../../src/lib/harness-ux";

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
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const PROJECT_FILTER = "components/harness/project-filter.tsx";
const INBOX = "routes/_authenticated/inbox.tsx";
const INSTRUCTIONS = "routes/_authenticated/instructions.tsx";
const TESTS_PAGE = "routes/_authenticated/tests.tsx";
const HISTORY = "routes/_authenticated/history.tsx";

// ---- 1. isTestCopyProject: pure, no React ----

// The brief's own example test case reads "Harness test 7 · with the rule ·
// Quick Tip Calculator" (no "Ledger") -- that matches an outdated doc
// comment on harness/src/executor/experiments.ts's testCopyName, not what
// that function actually returns today ("Harness Ledger test ${runId} ·
// ${which} · ${project}"). A bare "Harness test " prefix would also trip
// the pre-existing ux-naming.test.ts ban on a bare "Harness" in any
// user-facing string in src/lib. Matching the real generator (and staying
// inside the naming rule) means the prefix is "Harness Ledger test ".
test("isTestCopyProject: true only for a name starting with 'Harness Ledger test ' (testCopyName's own prefix)", () => {
  assert.equal(
    isTestCopyProject("Harness Ledger test 7 · with the rule · Quick Tip Calculator"),
    true,
  );
  assert.equal(isTestCopyProject("Quick Tip Calculator"), false);
  assert.equal(isTestCopyProject(""), false);
  assert.equal(isTestCopyProject(null), false);
  assert.equal(isTestCopyProject(undefined), false);
  // Prefix only -- the phrase appearing later in the name doesn't count.
  assert.equal(isTestCopyProject("My Harness Ledger test project"), false);
});

// ---- 2. project-filter.tsx exists and exports the right shape ----

test("project-filter.tsx: exports ProjectFilter and re-exports isTestCopyProject, renders the fixed chip shape", () => {
  const raw = readApp(PROJECT_FILTER);
  const code = codeOnly(raw);
  assert.match(code, /export function ProjectFilter\(/);
  assert.match(code, /isTestCopyProject/);
  assert.match(code, /export \{[^}]*isTestCopyProject[^}]*\}/);
  assert.match(code, /role="group"/);
  assert.match(code, /size="sm"/);
  assert.match(code, /"outline"/);
  assert.match(code, /ALL_PROJECTS_LABEL/);
  assert.match(code, /WORKSPACE_TARGET_LABEL/);
});

// ---- 3. Inbox and Instructions: no more hand-rolled chip row ----

test("inbox.tsx: uses <ProjectFilter>, no longer rolls its own project chip row", () => {
  const code = codeOnly(readApp(INBOX));
  assert.match(code, /<ProjectFilter\b/);
  assert.equal(
    count(code, 'role="group"'),
    0,
    "inbox.tsx must not render its own role=group chip row",
  );
});

test("instructions.tsx: uses <ProjectFilter>, no longer rolls its own project chip row", () => {
  const code = codeOnly(readApp(INSTRUCTIONS));
  assert.match(code, /<ProjectFilter\b/);
  assert.equal(
    count(code, 'role="group"'),
    0,
    "instructions.tsx must not render its own role=group chip row",
  );
});

// ---- 4. Tests and History: gain the shared filter ----

test("tests.tsx: uses <ProjectFilter> to narrow the run list by project", () => {
  const code = codeOnly(readApp(TESTS_PAGE));
  assert.match(code, /<ProjectFilter\b/);
  assert.match(code, /\.project_id/);
});

test("history.tsx: uses <ProjectFilter> for its project/workspace target selector; the activity Filter chip row is unchanged", () => {
  const code = codeOnly(readApp(HISTORY));
  assert.match(code, /<ProjectFilter\b/);
  // The activity "Filter" chip row (Suggestions/Knowledge/Skills/Tests/
  // Restores) is untouched -- still its own role="group" -- so exactly one
  // hand-rolled role="group" remains (the Filter row), not the old Target
  // one this task replaces.
  assert.equal(
    count(code, 'role="group"'),
    1,
    "only the activity Filter row's own role=group remains",
  );
  assert.match(code, /aria-label="Filter"/);
});

// ---- 5. WORKSPACE_TARGET_LABEL: "workspace" banned as a chip label ----
// Round 9 Task 2: the global constraint bans "workspace" as a chip label
// (harness-ux.ts:1866 used to read "Workspace" -- see round-8 pins this
// touches: ux-pages-simplified.test.ts, ux-round7-owner-review.test.ts).

test("harness-ux.ts: WORKSPACE_TARGET_LABEL no longer spells the banned word 'workspace'", async () => {
  const ux = await import("../../src/lib/harness-ux.ts");
  assert.equal(ux.WORKSPACE_TARGET_LABEL, "All my projects");
});
