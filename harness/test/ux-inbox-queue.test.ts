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
const CARDS = codeOnly(read("src/components/harness/improvement.tsx"));
const UX = codeOnly(read("src/lib/harness-ux.ts"));

// Round 8 Task 3 (review item 5): Overview merged into the Inbox and left
// the nav -- seven pages now, Inbox first.
test("navigation: Suggestions is absent; seven pages in the demo order", () => {
  const labels = [...SHELL.matchAll(/label: "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(labels, [
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
  // Round 9 Task 3 / spec §2 vocabulary: "View past decisions" is banned
  // navigation wording -- the link now reads openLabel("History").
  const past = at('openLabel("History")');
  const analysis = at('aria-label="Analysis"');
  assert.ok(
    count < items && items < past && past < analysis,
    "pending decisions come before analysis status",
  );
  // Round 8 Task 1 item 8: the "New activity is ready"/"Everything synced"
  // pair (NEW_ACTIVITY_TITLE/newActivityLine) is gone, replaced by one
  // analysisStatusLine call.
  assert.match(INBOX, /analysisStatusLine\(lastAnalysis, awaiting\)/);
  // Round 8 Task 1 fix 1: REANALYSE_TOKENS_NOTE (and the rest of "Reanalyse
  // history") moved off the Inbox and into Settings > AI analysis.
  assert.ok(
    !/REANALYSE_TOKENS_NOTE/.test(INBOX),
    "REANALYSE_TOKENS_NOTE must be gone from inbox.tsx",
  );
  assert.match(
    INBOX,
    /search=\{\{ filter: "suggestions" \}\}/,
    "View past decisions opens History › Suggestions",
  );
});

// Round 9 Task 7 / spec §2 vocabulary (controller ruling): new_instruction
// "Suggested", test_result "Test", rule_attention "Needs a decision",
// action_failed "Something failed", conflict "Edited in Lovable".
test("Inbox item types: six plain labels, every card path renders one primary action with a consequence line", () => {
  assert.match(UX, /new_instruction: "Suggested"/);
  assert.match(UX, /new_skill: "New Skill"/);
  assert.match(UX, /test_result: "Test"/);
  assert.match(UX, /rule_attention: "Needs a decision"/);
  assert.match(UX, /conflict: "Edited in Lovable"/);
  assert.match(UX, /action_failed: "Something failed"/);
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
    // Coordinator fix round 1, item 3: RuleAttentionCard gained a second,
    // mutually exclusive branch (a reachable rule id renders Keep directly;
    // otherwise the old Open-Instructions-only fallback) -- each branch has
    // its own one primary Button, never both at once, so its own source
    // text carries two, not one.
    const maxPrimaries = fn === "RuleAttentionCard" ? 2 : 1;
    const primaries = (body.match(/<Button(?![^>]*variant=)[^>]*>/g) ?? []).length;
    assert.ok(primaries <= maxPrimaries, `${fn} has ${primaries} primary buttons`);
  }
});

test("one source of truth: exactly one Inbox aggregation, one route branch, the Inbox page reads it, no mutation in the detail route", () => {
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
  // Round 8 Task 3 (review item 5): Overview merged into the Inbox, so the
  // "Overview counts read it" leg of this test is now just "the Inbox page
  // reads it" -- INBOX already covers that assertion below.
  assert.match(INBOX, /fetchInbox/);
  assert.ok(!/postImprovementAction\(/.test(LEDGER), "the detail route posts nothing of its own");
  // The Inbox posts only the shared actions (no ad-hoc endpoint).
  assert.ok(!/fetch\(/.test(INBOX), "inbox.tsx never calls fetch directly");
});

test("sidebar badge: route.tsx derives it from the Inbox's own count, never from counts.pending", () => {
  assert.match(
    SHELL,
    /fetchInbox/,
    "route.tsx must read the same Inbox fetch the Inbox page reads",
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
