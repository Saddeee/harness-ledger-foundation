import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Checkpoint 3: Inbox is the single decision queue. Navigation, redirects,
// deep links, page hierarchy, one source of truth (no second aggregation,
// no second mutation path), and History filters -- as source-level pins.
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const codeOnly = (s: string) =>
  s
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");

const SHELL = codeOnly(read("src/routes/_authenticated/route.tsx"));
const INBOX = codeOnly(read("src/routes/_authenticated/inbox.tsx"));
const LEDGER = codeOnly(read("src/routes/_authenticated/ledger.tsx"));
const HISTORY = codeOnly(read("src/routes/_authenticated/history.tsx"));
const OVERVIEW = codeOnly(read("src/routes/_authenticated/overview.tsx"));
const CARDS = codeOnly(read("src/components/harness/improvement.tsx"));
const UX = codeOnly(read("src/lib/harness-ux.ts"));

test("navigation: Suggestions is absent; eight pages in the demo order", () => {
  const labels = [...SHELL.matchAll(/label: "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(labels, [
    "Overview",
    "Inbox",
    "Instructions",
    "Skills",
    "Tests",
    "History",
    "Projects",
    "Settings",
  ]);
  assert.ok(!/to: "\/ledger"/.test(SHELL), "no nav entry points at the old Suggestions list");
});

test("redirects: the Suggestions list route sends you to the Inbox; the old /improvements and /suggestions still resolve; a deep link with ?improvement= keeps the detail", () => {
  assert.match(LEDGER, /if \(search\.improvement == null\) throw redirect\(\{ to: "\/inbox" \}\)/);
  assert.match(LEDGER, /<ImprovementDetail/);
  for (const rel of ["improvements", "suggestions"]) {
    const src = codeOnly(read(`src/routes/_authenticated/${rel}.tsx`));
    assert.match(
      src,
      /redirect\(\{ to: "\/ledger"/,
      `${rel} still redirects into the detail route`,
    );
  }
  // Inbox and History link to the detail with the same search param.
  assert.match(INBOX, /to: "\/ledger", search: \{ improvement: id \}/);
});

test("Inbox hierarchy: count line, items, past-decisions link, then the secondary Analysis section", () => {
  const at = (s: string) => {
    const i = INBOX.indexOf(s);
    assert.ok(i >= 0, `inbox.tsx missing ${s}`);
    return i;
  };
  const count = at("inboxCountLine(count)");
  const items = at("<NewSkillCard");
  const past = at("{VIEW_PAST_DECISIONS}");
  const analysis = at('aria-label="Analysis"');
  assert.ok(
    count < items && items < past && past < analysis,
    "pending decisions come before analysis status",
  );
  assert.match(INBOX, /\{NEW_ACTIVITY_TITLE\}/);
  assert.match(INBOX, /newActivityLine\(awaiting\)/);
  assert.match(INBOX, /\{REANALYSE_TOKENS_NOTE\}/);
  assert.match(
    INBOX,
    /search=\{\{ filter: "suggestions" \}\}/,
    "View past decisions opens History › Suggestions",
  );
});

test("Inbox item types: six plain labels, every card path renders one primary action with a consequence line", () => {
  assert.match(UX, /new_instruction: "New instruction"/);
  assert.match(UX, /new_skill: "New Skill"/);
  assert.match(UX, /test_result: "Test result"/);
  assert.match(UX, /rule_attention: "Rule needs attention"/);
  assert.match(UX, /conflict: "Conflict"/);
  assert.match(UX, /action_failed: "Action failed"/);
  for (const fn of [
    "TestResultCard",
    "RuleAttentionCard",
    "ConflictCard",
    "ActionFailedCard",
    "NewSkillCard",
  ]) {
    const start = CARDS.indexOf(`export function ${fn}`);
    assert.ok(start >= 0, fn);
    const end = CARDS.indexOf("\nexport function", start + 10);
    const body = CARDS.slice(start, end > 0 ? end : undefined);
    assert.ok(
      /inboxActionConsequence\(|actionConsequence\(/.test(body),
      `${fn} states its consequence`,
    );
    // One default-styled (primary) Button per card; the rest are outline / ghost / links.
    const primaries = (body.match(/<Button(?![^>]*variant=)[^>]*>/g) ?? []).length;
    assert.ok(primaries <= 1, `${fn} has ${primaries} primary buttons`);
  }
});

test("one source of truth: exactly one Inbox aggregation, one route branch, Overview counts read it, no mutation in the detail route", () => {
  const harnessSrc = join(ROOT, "harness/src");
  const files = readdirSync(harnessSrc, {
    withFileTypes: true,
    recursive: true,
  } as never) as unknown as { name: string; parentPath?: string; path?: string }[];
  let definitions = 0;
  for (const f of files) {
    if (!f.name.endsWith(".ts")) continue;
    const dir = f.parentPath ?? f.path ?? harnessSrc;
    const src = readFileSync(join(dir, f.name), "utf8");
    definitions += (src.match(/export function listInboxItems\(/g) ?? []).length;
  }
  assert.equal(definitions, 1, "listInboxItems is defined once");
  const route = codeOnly(read("src/routes/api/public/harness/improvements.ts"));
  assert.equal((route.match(/adapter\.listInboxItems\(/g) ?? []).length, 1);
  assert.match(OVERVIEW, /fetchInbox/);
  assert.ok(!/postImprovementAction\(/.test(LEDGER), "the detail route posts nothing of its own");
  // The Inbox posts only the shared actions (no ad-hoc endpoint).
  assert.ok(!/fetch\(/.test(INBOX), "inbox.tsx never calls fetch directly");
});

test("sidebar badge: route.tsx derives it from the Inbox's own count, never from counts.pending", () => {
  assert.match(
    SHELL,
    /fetchInbox/,
    "route.tsx must read the same Inbox fetch the Inbox page and Overview read",
  );
  assert.match(SHELL, /queryKey: \["harness-inbox"\]/, "same query key -- react-query dedupes it");
  assert.match(
    SHELL,
    /const badgeCount =\s+inboxQuery\.data && inboxQuery\.data\.available \? inboxQuery\.data\.count : 0;/,
  );
  assert.ok(
    !/const badgeCount = counts/.test(SHELL) && !/counts\.pending \+ counts\.retire/.test(SHELL),
    "the badge must never be re-derived from counts.pending/counts.retire again",
  );
});

test("History: filter values and their labels", () => {
  assert.match(HISTORY, /filter\?: HistoryFilterValue/);
  for (const v of ["all", "suggestions", "knowledge", "skills", "tests", "restores"]) {
    assert.ok(UX.includes(`"${v}"`), `history filter value ${v}`);
  }
  assert.match(UX, /All activity/);
});
