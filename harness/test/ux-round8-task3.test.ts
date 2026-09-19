// UX round 8 (2026-09-19), Task 3: Overview merges into the Inbox (review
// item 5). Pure-helper tests for providerDisplayName/scheduleModeLine
// (src/lib/harness-ux.ts) plus structural (text-only) pins on overview.tsx,
// route.tsx and inbox.tsx. Same lightweight, dependency-free
// readApp/codeOnly pattern as ux-round8-task1.test.ts / ux-round8-task2.test.ts
// (kept in its own new file per the global constraints).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ux = await import("../../src/lib/harness-ux.ts");
const copy = await import("../../src/lib/onboarding-copy.ts");

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
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

const SHELL = "routes/_authenticated/route.tsx";
const OVERVIEW_PAGE = "routes/_authenticated/overview.tsx";
const INBOX_PAGE = "routes/_authenticated/inbox.tsx";
const ONBOARDING_PAGE = "routes/_authenticated/onboarding.tsx";

// ---- 1. /overview is a plain redirect, same shape as /suggestions ----

test("overview.tsx: a pure redirect to /inbox, same shape as suggestions.tsx", () => {
  const overview = codeOnly(readApp(OVERVIEW_PAGE));
  const suggestions = codeOnly(readApp("routes/_authenticated/suggestions.tsx"));
  assert.match(overview, /throw redirect\(\{ to: "\/inbox", replace: true \}\)/);
  assert.ok(!/component:/.test(overview), "no component; it is a pure redirect");
  assert.ok(!/OverviewPage/.test(overview), "the old OverviewPage component is gone");
  // Same beforeLoad-redirect shape as the existing suggestions.tsx redirect.
  assert.match(suggestions, /beforeLoad: \(\) => \{/);
  assert.match(overview, /beforeLoad: \(\) => \{/);
});

test("onboarding.tsx: the Skip link's final navigate goes to /inbox, not /overview", () => {
  const onboarding = codeOnly(readApp(ONBOARDING_PAGE));
  assert.match(onboarding, /navigate\(\{ to: "\/inbox" \}\)/);
  assert.ok(!/["'`]\/overview["'`]/.test(onboarding), "no reference to /overview remains");
});

// ---- 2. NAV has no Overview entry ----

test("route.tsx: NAV has no Overview entry; Inbox is first", () => {
  const shell = codeOnly(readApp(SHELL));
  assert.ok(!/label: "Overview"/.test(shell), "Overview must not appear in NAV");
  assert.match(shell, /const NAV = \[\s*\{ to: "\/inbox", label: "Inbox" \}/);
});

// ---- 3. providerDisplayName ----

test("harness-ux.ts: providerDisplayName -- claude_code, anthropic, openai, and an unknown provider falls back to spaced-out raw value", () => {
  assert.equal(ux.providerDisplayName("claude_code"), "Claude Code");
  assert.equal(ux.providerDisplayName("anthropic"), "Anthropic API");
  assert.equal(ux.providerDisplayName("openai"), "OpenAI");
  assert.equal(ux.providerDisplayName("some_future_provider"), "some future provider");
  assert.equal(ux.providerDisplayName("azure"), "azure");
});

// ---- 4. scheduleModeLine ----

test("harness-ux.ts: scheduleModeLine -- app, cli, and no holder", () => {
  assert.equal(
    ux.scheduleModeLine("app"),
    "Checks for new chats on a schedule while Harness Ledger is open",
  );
  assert.equal(
    ux.scheduleModeLine("cli"),
    "Checks for new chats on a schedule from the background process",
  );
  assert.equal(ux.scheduleModeLine(null), "Scheduled checks are off");
  assert.equal(ux.scheduleModeLine(undefined), "Scheduled checks are off");
});

// ---- 5. inbox.tsx renders the Status and budgets fold, collapsed ----

test("inbox.tsx: renders the collapsed 'Status and budgets' fold at the bottom, reusing sidebarSyncLine/providerDisplayName/scheduleModeLine", () => {
  const code = codeOnly(readApp(INBOX_PAGE));
  assert.match(code, /\{OVERVIEW_STATUS_BUDGETS_TITLE\}/);
  // Collapsed by default -- no `open` attribute on the <details>.
  const detailsAt = code.indexOf("<details");
  assert.ok(detailsAt >= 0, "the fold must be a <details> element");
  assert.ok(!/<details[^>]*\bopen\b/.test(code), "the fold must not be open by default");
  assert.match(code, /sidebarSyncLine\(lastRun, nextRunAt\)/);
  assert.match(code, /providerDisplayName\(llm\.provider\)/);
  assert.match(code, /scheduleModeLine\(scheduleHolder\?\.owner/);
  // The raw Lovable error string appears only inside this fold, gated on a
  // failed run -- never unconditionally.
  assert.match(code, /lastRun\.ok === false && lastRun\.error/);
  assert.match(code, /Lovable said: \{lastRun\.error\}/);
});

// ---- 6. inbox.tsx: Overview's own primary-action block moved to the top ----

test("inbox.tsx: the top next-action block renders only for connect/choose_projects/choose_provider/analyse_now/sync_now, reusing overviewNextAction and the shared sync_now/analyse_now mutations", () => {
  const code = codeOnly(readApp(INBOX_PAGE));
  assert.match(code, /buildOverviewState\(/);
  assert.match(code, /overviewNextAction\(/);
  // \s+ tolerates however Prettier wraps this array literal.
  assert.match(
    code,
    /new Set\(\[\s*"connect",\s*"choose_projects",\s*"choose_provider",\s*"analyse_now",\s*"sync_now",?\s*\]\)/,
  );
  assert.match(code, /postExecutor\(\{ action: "sync_now" \}\)/);
  assert.match(code, /postExecutor\(\{ action: "analyse_now" \}\)/);
  // Only one analyse_now mutation exists on this page -- the Inbox's
  // existing Round 8 Task 1 item 8 "Analyse now" button and the top
  // next-action block both call the same analyseNow.mutate().
  assert.equal((code.match(/const analyseNow = useMutation/g) ?? []).length, 1);
});

// ---- 7. Empty Inbox: "Nothing waiting for you." ----

test("inbox.tsx: the empty state (no items, no filter) reads exactly 'Nothing waiting for you.'; the filtered-mismatch case is unchanged", () => {
  const code = codeOnly(readApp(INBOX_PAGE));
  assert.match(code, /"Nothing waiting for you\."/);
  assert.match(code, /"Nothing to show for this filter\."/);
});

// ---- 8. overviewMonitorRows / OVERVIEW_MONITOR_TITLE are gone everywhere ----

test("no file under src/ still references overviewMonitorRows or OVERVIEW_MONITOR_TITLE", () => {
  assert.equal((copy as Record<string, unknown>).overviewMonitorRows, undefined);
  assert.equal((copy as Record<string, unknown>).OVERVIEW_MONITOR_TITLE, undefined);
  const srcDir = join(ROOT, "src");
  const files = readdirSync(srcDir, {
    withFileTypes: true,
    recursive: true,
  } as never) as unknown as { name: string; parentPath?: string; path?: string }[];
  for (const f of files) {
    if (!/\.(ts|tsx)$/.test(f.name)) continue;
    const dir = f.parentPath ?? f.path ?? srcDir;
    const full = join(dir, f.name);
    // routeTree.gen.ts is generated by the router, not hand-authored; it
    // never references either identifier, but skip it explicitly rather
    // than assume that stays true.
    const code = codeOnly(readFileSync(full, "utf8"));
    assert.ok(
      !/overviewMonitorRows|OVERVIEW_MONITOR_TITLE/.test(code),
      `${full} still references overviewMonitorRows/OVERVIEW_MONITOR_TITLE`,
    );
  }
});

// buildOverviewState/overviewNextAction are still exported (Task 3 keeps
// them; only the Monitor list was deleted).
test("onboarding-copy.ts: buildOverviewState and overviewNextAction are still exported (reused by the Inbox now, not deleted)", () => {
  assert.equal(typeof copy.buildOverviewState, "function");
  assert.equal(typeof copy.overviewNextAction, "function");
  assert.equal(copy.OVERVIEW_STATUS_BUDGETS_TITLE, "Status and budgets");
});
