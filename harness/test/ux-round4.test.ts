// Round 4 Task A4 / spec §2: structural tests for the "Analyse now" notice,
// the Settings > AI analysis provider/budget/run-status UI. Same
// lightweight, dependency-free local helpers as ux.test.ts and the other
// ux-round4-*.test.ts files (kept in its own file per the task
// instructions -- other tasks are editing shared files concurrently).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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

const ANALYSE_NOTICE = "components/harness/analyse-notice.tsx";
const LOCAL_SETTINGS = "components/harness/local-settings.tsx";
const INSTRUCTIONS_PAGE = "routes/_authenticated/instructions.tsx";
const INBOX_PAGE = "routes/_authenticated/inbox.tsx";

test("analyse-notice.tsx: Analyse now, analyse_now, running/last-run/not-ready copy", () => {
  const raw = readApp(ANALYSE_NOTICE);
  for (const text of [
    "Analyse now",
    "analyse_now",
    "Analysing…",
    "Last analysis",
    "Add an API key or install Claude Code in Settings.",
  ]) {
    assert.ok(raw.includes(text), `analyse-notice.tsx missing "${text}"`);
  }
  // Only talks to the executor route, via the shared client helpers -- never
  // a raw fetch, and never a route other than harness/executor.
  const code = codeOnly(raw);
  assert.ok(!/\bfetch\(/.test(code), "analyse-notice.tsx must not call fetch directly");
  assert.match(code, /executorQueryOptions/);
  assert.match(code, /postExecutor/);
  assert.match(code, /action:\s*"analyse_now"/);

  for (const tag of code.match(/<details[^>]*>/g) ?? []) assert.ok(!/\sopen\b/.test(tag));

  // Fix round 1 (Important #1): the last-run summary line is a *finished*
  // run's summary only -- while running, `last_run` is the in-flight row
  // itself (ok null, zero counts), so it must never render underneath
  // "Analysing…". Gated in both the computation and the render, and
  // ok === null is never treated as success.
  assert.match(code, /if\s*\(\s*running\s*\|\|\s*!lastRun\s*\)\s*return null/);
  assert.match(code, /lastRun\.ok\s*!==\s*true/);
  assert.match(code, /!running\s*&&\s*lastRunLine/);
  assert.ok(!/lastRun\.ok === false/.test(code), "ok === null must not fall through as success");

  // Fix round 1 (Minor #4): the fixed prefix is a fallback only for when the
  // server gave no reason -- when it did, the reason alone is shown (it
  // already says where to fix it).
  assert.match(
    code,
    /providerReady\.reason \|\| "Add an API key or install Claude Code in Settings\."/,
  );
});

test("instructions.tsx and inbox.tsx render the shared AnalyseNotice", () => {
  for (const page of [INSTRUCTIONS_PAGE, INBOX_PAGE]) {
    const raw = readApp(page);
    assert.match(codeOnly(raw), /<AnalyseNotice/, `${page} should render <AnalyseNotice`);
  }
});

test("inbox.tsx: isNew treats a never-visited last_seen_at as nothing New, not everything New", () => {
  const code = codeOnly(readApp(INBOX_PAGE));
  assert.match(
    code,
    /if\s*\(\s*!previous\s*\)\s*return false/,
    "a first-ever visit (no previous last_seen_at) must not flag the whole backlog as New",
  );
});

test("local-settings.tsx: Claude Code provider, token budget, honest run-only-on-press line", () => {
  const raw = readApp(LOCAL_SETTINGS);
  const code = codeOnly(raw);

  for (const text of [
    "Claude Code (your subscription)",
    "Monthly token budget",
    "Analysis runs only when you press Analyse now.",
  ]) {
    assert.ok(raw.includes(text), `local-settings.tsx missing "${text}"`);
  }
  assert.ok(
    !raw.includes("nothing is sent to any provider today"),
    "local-settings.tsx still has the obsoleted round-3 honest line",
  );

  // Claude Code found/not found, derived from provider_ready -- only shown
  // in place of the API key field when claude_code is the selected provider.
  assert.ok(raw.includes("Claude Code found"));
  assert.ok(raw.includes("Claude Code not found on this machine"));
  assert.match(code, /provider_ready/);

  // Fix round 1 (Important #2): the found/not-found label is only accurate
  // when provider_ready is actually about Claude Code -- ok, or a reason
  // that names Claude Code. Any other not-ready reason (e.g. a different
  // role's missing API key) is shown verbatim instead of being mislabelled.
  assert.match(code, /function claudeCodeStatusLine/);
  assert.match(code, /providerReady\?\.ok\)\s*return "Claude Code found"/);
  assert.match(code, /\/claude code\/i\.test\(providerReady\.reason\)/);
  assert.match(code, /return providerReady\?\.reason \?\?/);

  // Fix round 1 (Important #3): the dollar estimate is shown whenever
  // spent_usd > 0, regardless of the selected provider dropdown.
  assert.match(code, /spentUsd\s*>\s*0/);
  assert.match(code, /this month \(API providers\)/);

  // budget bounds (100,000-50,000,000) and the tokens-used line.
  assert.match(code, /min=\{100000\}/);
  assert.match(code, /max=\{50000000\}/);
  assert.match(code, /tokens_this_month/);

  // Claude Code suggests "sonnet" as a role model placeholder.
  assert.match(code, /placeholder=\{.*"sonnet".*\}/);

  assert.ok(!/\bfetch\(/.test(code), "local-settings.tsx must not call fetch directly");
  for (const tag of code.match(/<details[^>]*>/g) ?? []) assert.ok(!/\sopen\b/.test(tag));
});
