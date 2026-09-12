// Round 4 Task C3 / spec §4 (v1-lite) + §4b (display) + §5 (notifications):
// structural tests for the outcome-tracking health line, the sidebar Inbox
// count (including retirement proposals), and the "New" marker. Same
// lightweight, dependency-free local helpers as ux.test.ts / the other
// ux-round4-*.test.ts files (kept in its own file per the task instructions
// -- other tests are being edited concurrently).
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
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const DETAIL = "components/harness/improvement.tsx";
const INSTRUCTIONS_PAGE = "routes/_authenticated/instructions.tsx";
const ROUTE = "routes/_authenticated/route.tsx";
const INBOX = "routes/_authenticated/inbox.tsx";

test("harness-ux.ts: healthLine -- no row, zero tasks, no last_applicable_at, and the full line", () => {
  assert.equal(
    ux.healthLine(null),
    null,
    "no health row yet (rule not live, or rule_health hasn't scored it) -> no line",
  );
  assert.equal(
    ux.healthLine({ applicable_tasks: 0, helped: 0, hurt: 0, last_applicable_at: null }),
    "Since added: no matching tasks yet · from real builds",
  );
  assert.equal(
    ux.healthLine({ applicable_tasks: 4, helped: 2, hurt: 2, last_applicable_at: null }),
    "Since added: 4 tasks · 2 helped · 2 repeat corrections · from real builds",
    "omits 'last used' when null",
  );
  assert.equal(
    ux.healthLine({
      applicable_tasks: 4,
      helped: 3,
      hurt: 1,
      last_applicable_at: "2026-09-01T00:00:00Z",
    }),
    "Since added: 4 tasks · 3 helped · 1 repeat correction · last used 1 Sep · from real builds",
    "singular 'repeat correction' when hurt === 1",
  );
  // Fix round 1 (C3 minor): applicable_tasks/hurt both pluralize correctly
  // at 1; helped has no plural form to get wrong.
  assert.equal(
    ux.healthLine({ applicable_tasks: 1, helped: 1, hurt: 0, last_applicable_at: null }),
    "Since added: 1 task · 1 helped · 0 repeat corrections · from real builds",
    "singular 'task' when applicable_tasks === 1",
  );
});

test("improvement.tsx: DecidedStatus renders the health line for a live item's health, via healthLine", () => {
  const raw = readApp(DETAIL);
  const code = codeOnly(raw);
  assert.match(code, /healthLine/);
  assert.match(code, /item\.health/);
});

test("instructions.tsx: each active rule renders its own health line, via healthLine", () => {
  const raw = readApp(INSTRUCTIONS_PAGE);
  const code = codeOnly(raw);
  assert.match(code, /healthLine/);
});

test("route.tsx: the sidebar Inbox badge uses the server's counts (pending + retire), not pendingCount", () => {
  const raw = readApp(ROUTE);
  const code = codeOnly(raw);
  assert.match(code, /counts\.pending/);
  assert.match(code, /counts\.retire/);
  assert.ok(!code.includes("pendingCount"), "route.tsx must no longer call pendingCount");
  // The 60s poll and the notification effect stay in place.
  assert.ok(code.includes("refetchInterval: 60_000"));
  assert.ok(code.includes("new Notification("));
});

test("inbox.tsx: posts mark_seen on mount (after reading the previous last_seen_at) and marks new items via isNew", () => {
  const raw = readApp(INBOX);
  const code = codeOnly(raw);
  assert.match(code, /action:\s*"mark_seen"/);
  assert.match(code, /last_seen_at/);
  assert.match(code, /isNew=\{isNew\(i\)\}/);
});

test("improvement.tsx: renders a 'New' badge, driven by the isNew prop", () => {
  const raw = readApp(DETAIL);
  const code = codeOnly(raw);
  assert.match(code, />\s*New\s*</, "no literal 'New' badge text found");
  assert.match(code, /isNew/);
});

test("no <details> elements are open, across the touched pages/components", () => {
  for (const rel of [DETAIL, INSTRUCTIONS_PAGE, ROUTE, INBOX]) {
    const src = readApp(rel);
    assert.ok(!src.includes("<details open"), `Found <details open in ${rel}`);
  }
});

test("pages only fetch from local harness routes", () => {
  const inbox = readApp(INBOX);
  const ledger = readApp("routes/_authenticated/ledger.tsx");
  const instructionsPage = readApp(INSTRUCTIONS_PAGE);
  const code = [inbox, ledger, instructionsPage].map(codeOnly).join("\n");
  const allFetches = code.match(/fetch\([^)]+\)/g) || [];
  for (const f of allFetches) {
    assert(
      f.includes("/api/public/harness/") ||
        f.includes("queryFn:") ||
        f.includes("runtimeQueryOptions"),
      `Unexpected fetch in pages: ${f}`,
    );
  }
});

test("improvement.tsx: 'Lovable credits' appears at most twice, 'Harness analysis' exactly once", () => {
  const raw = readApp(DETAIL);
  assert.ok(count(raw, "Lovable credits") <= 2, "too many literal 'Lovable credits' occurrences");
  assert.equal(
    count(raw, "Harness analysis"),
    1,
    "'Harness analysis' should appear exactly once (the developer-view disclosure)",
  );
});
