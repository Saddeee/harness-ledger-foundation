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

// Round 5 Task 7 / spec §5.1: rewritten with intent -- "helped" leaves this
// line entirely (an applicable build without a repeat correction is not
// proof the rule helped, just that no repeat was observed), the noun
// changes from "tasks" to "builds in this area", the zero-builds line drops
// its "Since added:" prefix, and the source label changes from "from real
// builds" to "observed from your real builds" (spec's own example line).
test("harness-ux.ts: healthLine -- no row, zero builds, no last_applicable_at, and the full line, never says 'helped'", () => {
  assert.equal(
    ux.healthLine(null),
    null,
    "no health row yet (rule not live, or rule_health hasn't scored it) -> no line",
  );
  // Checkpoint 2026-09-18 WP3 (spec §9): the line says what was observed,
  // never what it caused. Legacy rows (no observed_* fields) use
  // applicable_tasks/hurt with the same wording.
  // Round 9 Task 1 / spec §4: observedLine/healthLine now delegate to
  // observedSentence's plain wording ("You corrected this again...", "No
  // later build has needed this yet.") -- never "Harness Ledger found...".
  assert.equal(
    ux.healthLine({ applicable_tasks: 0, hurt: 0, last_applicable_at: null }),
    "No later build has needed this yet.",
  );
  assert.equal(
    ux.healthLine({ applicable_tasks: 4, hurt: 2, last_applicable_at: null }),
    "You corrected this again in 2 of 4 later builds.",
    "omits the last-build sentence when null",
  );
  assert.equal(
    ux.healthLine({
      applicable_tasks: 4,
      hurt: 1,
      last_applicable_at: "2026-09-01T00:00:00Z",
    }),
    "You corrected this again in 1 of 4 later builds. Last relevant build 1 Sep.",
  );
  assert.equal(
    ux.healthLine({ applicable_tasks: 1, hurt: 0, last_applicable_at: null }),
    "You have not had to correct this again in 1 later build.",
    "singular 'build' when there is one",
  );
  assert.equal(
    ux.observedLine({
      applicable_tasks: 9,
      hurt: 9,
      last_applicable_at: null,
      observed_repeat: 3,
      observed_clear: 0,
    }),
    "You corrected this again in 3 of 3 later builds.",
    "the separately tracked observed counts win over the legacy pair",
  );
  // Round 9 Task 1 / spec §4: aiReviewLine now delegates to aiCheckSentence
  // -- never "AI review marked...".
  assert.equal(
    ux.aiReviewLine({ ai_not_followed: 3, ai_followed: 0 }),
    "Lovable's replies show the instruction was not followed in 3 of 3 later builds.",
  );
  // Round 9 Task 1 / spec §4: attentionBlock's line is now the plain
  // observedSentence, not the old bespoke "The same issue appeared...".
  assert.deepEqual(
    ux.attentionBlock({
      applicable_tasks: 3,
      hurt: 3,
      last_applicable_at: null,
      observed_repeat: 3,
      observed_clear: 0,
      review_reason: "repeated_issue",
    }),
    {
      title: "Needs attention",
      line: "You corrected this again in 3 of 3 later builds.",
      recommendation: "Rewrite this rule or turn it into a Skill.",
      action: "Review rule",
    },
  );
  assert.equal(
    ux.attentionBlock({
      applicable_tasks: 0,
      hurt: 0,
      last_applicable_at: null,
      review_reason: "inactive",
    })!.title,
    "Review for relevance",
  );
  for (const health of [
    { applicable_tasks: 0, hurt: 0, last_applicable_at: null },
    { applicable_tasks: 4, hurt: 2, last_applicable_at: "2026-09-01T00:00:00Z" },
  ]) {
    assert.ok(
      !/helped/i.test(ux.healthLine(health) ?? ""),
      "the word 'helped' must never appear in healthLine's output",
    );
  }
});

test("improvement.tsx: DecidedStatus renders the health line for a live item's health, via healthLine", () => {
  const raw = readApp(DETAIL);
  const code = codeOnly(raw);
  assert.match(code, /healthLine/);
  assert.match(code, /item\.health/);
});

// Checkpoint 2 2-C: rewritten with intent -- the Instructions page's rules
// table no longer merges this into one healthLine call. Each active rule
// now renders observedLine and aiReviewLine as separate lines (spec §9:
// "never merged"), plus the plain ruleActiveLine ("Active in Lovable" /
// "Active, not replay-tested") in place of a healthy rule's old fallback,
// or the shared attentionBlock() when the rule needs review.
test("instructions.tsx: each active rule renders observedLine, aiReviewLine and ruleActiveLine as separate lines", () => {
  const raw = readApp(INSTRUCTIONS_PAGE);
  const code = codeOnly(raw);
  assert.match(code, /observedLine\(rule\.health/);
  assert.match(code, /aiReviewLine\(rule\.health/);
  assert.match(code, /ruleActiveLine\(/);
  assert.match(code, /attentionBlock\(rule\.health/);
});

// Rewritten with intent for checkpoint 3 UX fix 1: the owner reported the
// sidebar badge disagreeing with the Inbox page itself (3 items in the
// Inbox, 2 on the sidebar) -- counts.pending + counts.retire was its own,
// second aggregation of "what needs a decision", which could disagree with
// listInboxItems()'s own count. The badge now reads that same Inbox fetch
// (fetchInbox / "harness-inbox"), never counts.pending or pendingCount.
// See harness/test/ux-inbox-queue.test.ts for the fuller pin on this.
test("route.tsx: the sidebar Inbox badge uses the Inbox's own count, never counts.pending or pendingCount", () => {
  const raw = readApp(ROUTE);
  const code = codeOnly(raw);
  assert.match(code, /fetchInbox/);
  assert.match(code, /queryKey: \["harness-inbox"\]/);
  assert.ok(!code.includes("pendingCount"), "route.tsx must no longer call pendingCount");
  assert.ok(
    !/counts\.pending/.test(code) && !/counts\.retire/.test(code),
    "route.tsx must no longer re-derive the badge from counts.pending/counts.retire",
  );
  // The 60s poll and the notification effect stay in place.
  assert.ok(code.includes("refetchInterval: 60_000"));
  assert.ok(code.includes("new Notification("));
});

test("inbox.tsx: posts mark_seen on mount (after reading the previous last_seen_at) and marks new items via isNew", () => {
  const raw = readApp(INBOX);
  const code = codeOnly(raw);
  assert.match(code, /action:\s*"mark_seen"/);
  assert.match(code, /last_seen_at/);
  assert.match(code, /isNew=\{isNew\(it\.improvement\)\}/);
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

test("improvement.tsx: 'Lovable credits' appears at most twice, 'Harness Ledger analysis' exactly once", () => {
  const raw = readApp(DETAIL);
  assert.ok(count(raw, "Lovable credits") <= 2, "too many literal 'Lovable credits' occurrences");
  assert.equal(
    count(raw, "Harness Ledger analysis"),
    1,
    "'Harness Ledger analysis' should appear exactly once (the developer-view disclosure)",
  );
});
