// UX round 8 (2026-09-19), Task 6: Settings "Advanced" fold and onboarding
// leaks (review item 10, scoped). Structural (text-only) pins on
// local-settings.tsx and onboarding.tsx, plus the onboarding-copy.ts
// recommended-settings list. Same lightweight, dependency-free
// readApp/codeOnly pattern as ux-round8-task1.test.ts / ux-round8-task2.test.ts
// / ux-round8-task3.test.ts / ux-round8-task4.test.ts / ux-round8-task5.test.ts
// (kept in its own new file per the global constraints).
//
// Round 8 Task 6 fix round 1: the review found that the first version's
// "done" signal for onboarding step 3 (settings.decision_mode != null) was
// always true -- store.ts's getSettings() always merges in a default
// ("ask") for decision_mode, so there is no "unset" a client can observe
// through it, and a purely structural (source-as-text) test can't catch
// that (the shape of the code looked right; its runtime behaviour was
// wrong). The fix adds a real DB-backed signal (store.hasSettingRow) and a
// DB-backed test for it below, alongside the re-pinned structural tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolated temp DB for this file's DB-backed test, set before store.js (and
// the db.js it imports) is first loaded anywhere in this process -- same
// pattern as harness/test/store.test.ts.
process.env.HARNESS_DB_PATH = join(mkdtempSync(join(tmpdir(), "harness-test-")), "harness.db");
const store = await import("../src/store.js");

const copy = await import("../../src/lib/onboarding-copy.ts");

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

const SETTINGS = "components/harness/local-settings.tsx";
const ONBOARDING = "routes/_authenticated/onboarding.tsx";

// ---- Settings: three visible sections, then one collapsed "Advanced" ----

test("local-settings.tsx: Decisions, AI analysis, Lovable credits are visible, in order, before Advanced", () => {
  const raw = readApp(SETTINGS);
  const order = ["Decisions", "AI analysis", "Lovable credits"];
  let last = -1;
  for (const marker of order) {
    const at = raw.indexOf(`>${marker}<`);
    assert.ok(at > last, `expected section "${marker}" after the previous one`);
    last = at;
  }
  const advancedAt = raw.search(/<summary[^>]*>\s*Advanced\s*<\/summary>/);
  assert.ok(advancedAt > last, "the Advanced fold must come after Lovable credits");
});

test("local-settings.tsx: exactly one 'Advanced' details summary, wrapping the five folded sections in order", () => {
  const raw = readApp(SETTINGS);
  const code = codeOnly(raw);

  // Only one top-level "Advanced" fold -- the AI analysis section still has
  // its own, differently-labelled "Advanced: different models per role"
  // details, untouched by this task.
  const bareAdvanced = [...raw.matchAll(/<summary[^>]*>\s*Advanced\s*<\/summary>/g)];
  assert.equal(bareAdvanced.length, 1, "expected exactly one bare 'Advanced' summary");

  const advancedAt = raw.search(/<summary[^>]*>\s*Advanced\s*<\/summary>/);
  assert.ok(advancedAt >= 0);

  const foldedOrder = [
    "Evidence",
    "Sync schedule",
    "Knowledge limit",
    "Defaults for projects",
    "Notifications",
  ];
  let last = advancedAt;
  for (const marker of foldedOrder) {
    const at = raw.indexOf(`>${marker}<`);
    assert.ok(at > last, `expected folded section "${marker}" after the previous one`);
    last = at;
  }

  // Collapsed by default, like every other <details> in this file.
  for (const tag of code.match(/<details[^>]*>/g) ?? []) assert.ok(!/\sopen\b/.test(tag));
});

test("local-settings.tsx: the Approval section is gone; its line is now the last line of Decisions", () => {
  const raw = readApp(SETTINGS);
  assert.ok(
    !/<h2[^>]*>Approval<\/h2>/.test(raw),
    "the standalone Approval section heading must be gone",
  );
  assert.ok(
    raw.includes("Nothing is written to Lovable until you approve it here."),
    "the approval sentence itself must still be present",
  );

  // It sits inside the Decisions section, after the "Save decisions"
  // button, and before that section's closing tag. Located via the JSX
  // usage ({APPROVAL_LINE}), not the sentence text itself -- that also
  // appears once, much earlier, in the APPROVAL_LINE constant declaration.
  const decisionsAt = raw.indexOf(">Decisions<");
  const saveDecisionsAt = raw.indexOf('"Save decisions"');
  const approvalAt = raw.indexOf("{APPROVAL_LINE}");
  const aiAnalysisAt = raw.indexOf(">AI analysis<");
  assert.ok(
    decisionsAt >= 0 &&
      saveDecisionsAt > decisionsAt &&
      approvalAt > saveDecisionsAt &&
      aiAnalysisAt > approvalAt,
    "the approval line must be the last thing in the Decisions section, before AI analysis",
  );
});

// ---- AI analysis: no raw provider enum, "Ready: <name>" status lines ----

test("local-settings.tsx: the Claude Code readiness line reads 'Ready: Claude Code', not the raw enum", () => {
  const raw = readApp(SETTINGS);
  const code = codeOnly(raw);
  assert.ok(!raw.includes("Claude Code found"), "the old bare status line must be gone");
  assert.match(code, /return `Ready: \$\{providerDisplayName\("claude_code"\)\}`/);
  assert.match(
    code,
    /import\s*\{[^}]*\bproviderDisplayName\b[^}]*\}\s*from\s*"@\/lib\/harness-ux"/s,
  );
});

test("local-settings.tsx: the Claude Code model hint reads 'Model: sonnet, opus or haiku'", () => {
  const raw = readApp(SETTINGS);
  assert.ok(!raw.includes("Claude Code model alias: sonnet, opus or haiku"));
  assert.ok(raw.includes("Model: sonnet, opus or haiku"));
});

// ---- No internal enum literal anywhere in onboarding/settings copy ----

test("onboarding.tsx and local-settings.tsx never render the raw '(claude_code)' enum form", () => {
  for (const page of [ONBOARDING, SETTINGS]) {
    const raw = readApp(page);
    assert.ok(!raw.includes("(claude_code)"), `${page} still renders the raw "(claude_code)" form`);
  }
});

// ---- Onboarding: Ready: <name>, and the three recommended-settings lines ----

test("onboarding.tsx: the provider step's ready line uses providerDisplayName, not a raw provider id", () => {
  const raw = readApp(ONBOARDING);
  const code = codeOnly(raw);
  assert.ok(
    !raw.includes("Ready (${provider})"),
    "the old template-literal enum form must be gone",
  );
  assert.match(code, /`Ready: \$\{providerDisplayName\(provider\)\}`/);
  assert.match(code, /import\s*\{\s*providerDisplayName\s*\}\s*from\s*"@\/lib\/harness-ux"/);
});

// Round 8 Task 6 fix round 1: settings.decision_mode is never null/undefined
// once the executor query resolves (the store always merges in a default of
// "ask" -- see the DB-backed hasSettingRow tests below), so the original
// `decision_mode != null` check was always true and step 3 was "Done" for
// every user immediately, before the radio group or Save button ever got a
// chance to render. Re-pinned to the real signal, decision_mode_chosen.
test("onboarding.tsx: step 3's done state reads decision_mode_chosen, not the always-true decision_mode != null", () => {
  const code = codeOnly(readApp(ONBOARDING));
  assert.ok(
    !/decision_mode\s*!=\s*null/.test(code),
    "the always-true decision_mode != null check must be gone",
  );
  assert.match(code, /executor\.data\?\.settings\?\.decision_mode_chosen\s*===\s*true/);
  assert.match(code, /modeSaved\s*\|\|\s*decisionModeOnServer/);
  assert.match(
    code,
    /const doneFlags = \[connected, hasProject, modeDone, providerReady, hasAnalysisRun\];/,
  );
});

// Round 8 Task 6 fix round 1: the wire contract itself -- the executor
// route's GET response and the client type it feeds -- now carries a real
// "has the user chosen?" signal, not just the always-populated
// decision_mode value.
test("executor.ts and improvements-client.ts: decision_mode_chosen is a real signal from hasSettingRow, not derived from decision_mode", () => {
  const executorCode = codeOnly(readApp("routes/api/public/harness/executor.ts"));
  assert.match(executorCode, /decision_mode_chosen:\s*adapter\.hasSettingRow\("decision_mode"\)/);
  const clientCode = codeOnly(readApp("lib/improvements-client.ts"));
  assert.match(clientCode, /decision_mode_chosen:\s*boolean/);
});

// Round 8 Task 6 fix round 1: store.hasSettingRow reads the settings table
// directly (SELECT 1 ... no defaults merged), so it can tell "never set" from
// "set to the default value" -- exactly what getSetting/getSettings can never
// do (they always return SETTING_DEFAULTS.decision_mode = "ask" once no row
// exists). DB-backed, on an isolated temp DB (see this file's header).
test("store.hasSettingRow: false on a fresh DB, true once decision_mode has actually been set", () => {
  assert.equal(
    store.hasSettingRow("decision_mode"),
    false,
    "a fresh DB has no decision_mode row -- only the in-memory default",
  );
  // getSetting/getSettings already report the default despite no row existing.
  assert.equal(store.getSetting("decision_mode"), "ask");

  store.setSettings({ decision_mode: "ask" });
  assert.equal(
    store.hasSettingRow("decision_mode"),
    true,
    "setSettings must have written a real row, even though the value ('ask') equals the default",
  );

  // A key that really doesn't exist yet (e.g. before any setting on this
  // DB has ever been saved) stays false -- confirms this isn't a tautology
  // that's always true once *any* setting exists.
  assert.equal(store.hasSettingRow("this_setting_key_does_not_exist"), false);
});

test("onboarding-copy.ts: RECOMMENDED_SETTINGS_LIST is the three plain sentences, verbatim and in order", () => {
  assert.deepEqual(copy.RECOMMENDED_SETTINGS_LIST, [
    "Ask before anything is written to Lovable",
    "Check for new chats on a schedule; analyse only when you press Analyse now",
    "Tests run in a copy of your project, never in the project itself",
  ]);
});

test("onboarding.tsx: still renders RECOMMENDED_SETTINGS_LIST as a plain list, and keeps the button", () => {
  const src = readApp(ONBOARDING);
  assert.match(src, /RECOMMENDED_SETTINGS_LABEL/);
  assert.match(src, /RECOMMENDED_SETTINGS_LIST\.map/);
});
