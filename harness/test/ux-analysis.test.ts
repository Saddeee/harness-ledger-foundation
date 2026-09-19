// Checkpoint 2026-09-18 WP5 (D7): structural tests for this WP's own
// harness-ux.ts section (`// ---- Checkpoint 2026-09-18 WP5: analysis ----`)
// -- the automatic-analysis setting key/label, the "Analyse now" scope
// disclosure, "Reanalyse history" copy/estimate line, and the disagreement
// card copy -- plus that the Inbox route actually renders them (wiring, not
// just existence).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "harness-ux-analysis-test-"));
process.env.HARNESS_DB_PATH = join(tmp, "harness.db");
process.env.HARNESS_AUTH_PATH = join(tmp, "lovable-auth.json");

const ux = await import("../../src/lib/harness-ux.ts");
const context = await import("../src/analysis/context.js");

function readApp(rel: string): string {
  return readFileSync(new URL(`../../src/${rel}`, import.meta.url), "utf8");
}

const INBOX = "routes/_authenticated/inbox.tsx";
const LOCAL_SETTINGS = "components/harness/local-settings.tsx";

test("AUTOMATIC_ANALYSIS_SETTING_KEY matches harness/src/analysis/context.ts's own constant exactly", () => {
  assert.equal(ux.AUTOMATIC_ANALYSIS_SETTING_KEY, "automatic_analysis_after_sync");
  assert.equal(ux.AUTOMATIC_ANALYSIS_SETTING_KEY, context.AUTOMATIC_ANALYSIS_SETTING_KEY);
});

test("AUTOMATIC_ANALYSIS_SETTING_LABEL names both what it does and its cost", () => {
  assert.equal(
    ux.AUTOMATIC_ANALYSIS_SETTING_LABEL,
    "Run analysis automatically after each sync (uses AI tokens)",
  );
});

test("ANALYSE_NOW_SCOPE_LINE is the exact disclosure sentence", () => {
  assert.equal(
    ux.ANALYSE_NOW_SCOPE_LINE,
    "Only new messages and corrections are analysed; older context may be read as context without being analysed again.",
  );
});

test("REANALYSE_TITLE and DISAGREEMENT_TITLE are the exact required strings", () => {
  assert.equal(ux.REANALYSE_TITLE, "Reanalyse history");
  assert.equal(ux.DISAGREEMENT_TITLE, "A newer analysis disagrees with your previous decision.");
});

test("REANALYSE_BODY discloses that a human decision is never silently overwritten", () => {
  assert.match(ux.REANALYSE_BODY, /never/i);
  assert.match(ux.REANALYSE_BODY, /review item|disagree/i);
});

test("reanalyseEstimateLine renders the exact 'About N messages · ≈ T tokens · model M · budget remaining R' shape", () => {
  const line = ux.reanalyseEstimateLine({
    messages: 12,
    estimated_tokens: 3400,
    model: "gpt-5.4-mini",
    budget_remaining: 1_996_600,
  });
  assert.equal(
    line,
    "About 12 messages · ≈ 3,400 tokens · model gpt-5.4-mini · budget remaining 1,996,600",
  );
  // Singular message.
  assert.match(
    ux.reanalyseEstimateLine({
      messages: 1,
      estimated_tokens: 1,
      model: "m",
      budget_remaining: 0,
    }),
    /^About 1 message ·/,
  );
});

test("disagreementBodyLine names both the previous and the newer classification", () => {
  const line = ux.disagreementBodyLine("correction", "new_task");
  assert.match(line, /"correction"/);
  assert.match(line, /"new_task"/);
});

// Round 8 Task 1 fix 1: the Reanalyse trigger/dialog moved off the Inbox and
// into Settings > AI analysis (see local-settings.tsx); the Inbox keeps only
// the scope disclosure and the disagreement card copy. Split into two
// scans, one per page, rather than loosening the original single scan.
test("Inbox route renders the scope disclosure and the disagreement card copy from harness-ux.ts (not inline strings)", () => {
  const source = readApp(INBOX);
  for (const symbol of [
    "ANALYSE_NOW_SCOPE_LINE",
    "DISAGREEMENT_TITLE",
    "DISAGREEMENT_ACCEPT_BUTTON",
    "DISAGREEMENT_DISMISS_BUTTON",
    "disagreementBodyLine",
  ]) {
    assert.ok(source.includes(symbol), `inbox.tsx should reference ${symbol}`);
  }
  assert.match(source, /from "@\/lib\/harness-ux"/);
  for (const symbol of [
    "REANALYSE_TITLE",
    "REANALYSE_BODY",
    "REANALYSE_TRIGGER_BUTTON",
    "REANALYSE_CONFIRM_BUTTON",
    "REANALYSE_CANCEL_BUTTON",
    "REANALYSE_PROJECTS_LABEL",
    "REANALYSE_INCLUDE_REVIEWED_LABEL",
    "REANALYSE_REASON_LABEL",
    "reanalyseEstimateLine",
  ]) {
    assert.ok(!source.includes(symbol), `inbox.tsx should no longer reference ${symbol}`);
  }
});

test("Settings > AI analysis renders the Reanalyse trigger/dialog copy from harness-ux.ts (not inline strings)", () => {
  const source = readApp(LOCAL_SETTINGS);
  for (const symbol of [
    "REANALYSE_TITLE",
    "REANALYSE_BODY",
    "REANALYSE_TRIGGER_BUTTON",
    "REANALYSE_TOKENS_NOTE",
    "REANALYSE_CONFIRM_BUTTON",
    "REANALYSE_CANCEL_BUTTON",
    "REANALYSE_PROJECTS_LABEL",
    "REANALYSE_INCLUDE_REVIEWED_LABEL",
    "REANALYSE_REASON_LABEL",
    "reanalyseEstimateLine",
  ]) {
    assert.ok(source.includes(symbol), `local-settings.tsx should reference ${symbol}`);
  }
  assert.match(source, /from "@\/lib\/harness-ux"/);
});
