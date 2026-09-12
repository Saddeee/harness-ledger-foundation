// Tests for Task 7 (Projects and Settings for the local runtime): the mode
// switch on both route files, the local Projects/Settings pages, and the
// hosted Projects page moved into its own component. Same structural,
// source-as-text approach as ux.test.ts (no DOM).
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
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const PROJECTS_ROUTE = "routes/_authenticated/projects.tsx";
const SETTINGS_ROUTE = "routes/_authenticated/settings.tsx";
const HOSTED_PROJECTS = "components/harness/hosted-projects.tsx";
const LOCAL_PROJECTS = "components/harness/local-projects.tsx";
const LOCAL_SETTINGS = "components/harness/local-settings.tsx";

const CONNECT_LOVABLE_SENTENCE =
  "Harness reads your chats and Knowledge through Lovable's MCP. Reading and writing Knowledge uses no credits.";
const SCHEDULE_SENTENCE =
  "Syncing reads your Lovable chats and Knowledge. It uses no Lovable credits and no AI.";
const APPROVAL_SENTENCE = "Nothing is written to Lovable until you approve it here.";

test("projects.tsx and settings.tsx switch on runtime mode, hosted by default while loading", () => {
  const projects = codeOnly(readApp(PROJECTS_ROUTE));
  assert.match(projects, /mode === "local" \? <LocalProjects/);
  assert.match(projects, /<HostedProjects/);
  assert.match(
    projects,
    /import \{ HostedProjects \} from "@\/components\/harness\/hosted-projects";/,
  );
  assert.match(
    projects,
    /import \{ LocalProjects \} from "@\/components\/harness\/local-projects";/,
  );
  assert.match(projects, /const mode = runtime\.data\?\.mode;/);
  // validateSearch/head stay on the route file
  assert.match(projects, /validateSearch:/);
  assert.match(projects, /head: \(\)/);

  const settings = codeOnly(readApp(SETTINGS_ROUTE));
  assert.match(settings, /mode === "local" \? <LocalSettings/);
  assert.match(settings, /<HostedSettings/);
  assert.match(
    settings,
    /import \{ LocalSettings \} from "@\/components\/harness\/local-settings";/,
  );
  assert.match(settings, /const mode = runtime\.data\?\.mode;/);
});

test("settings.tsx: AdvancedSection survives verbatim (existing structural test), hosted form reduced to kill_switch and monthly_credit_budget", () => {
  const settings = codeOnly(readApp(SETTINGS_ROUTE));
  // existing ux.test.ts assertions this file must keep satisfying
  assert.match(settings, /function AdvancedSection/);
  assert.match(settings, /if \(runtime\.data\?\.mode !== "hosted"\) return null;/);
  assert.match(settings, /<summary[^>]*>\s*Advanced\s*<\/summary>/);
  assert.match(settings, /<Link to="\/jobs"/);
  assert.match(settings, /Credits this month/);
  assert.match(settings, /<AdvancedSection \/>/);

  assert.match(settings, /monthly_credit_budget/);
  assert.match(settings, /kill_switch/);
  for (const gone of [
    "drift_check_every_n",
    "max_active_rules",
    "one_change_per_day",
    "require_replay_approval",
    "keep_forks",
    "llm_provider",
    "llm_models",
  ]) {
    assert.ok(!settings.includes(gone), `settings.tsx should no longer contain ${gone}`);
  }
});

test("hosted-projects.tsx carries the moved-out hosted Projects page unchanged in shape", () => {
  const hosted = codeOnly(readApp(HOSTED_PROJECTS));
  assert.match(hosted, /export function HostedProjects/);
  assert.match(hosted, /Write workspace Knowledge/);
  assert.match(hosted, /Write Skills/);
  assert.match(hosted, /Connect Lovable/);
  assert.match(hosted, /Sync projects/);
  assert.match(hosted, /supabase\.from\("workspaces"\)/);
  assert.match(hosted, /supabase\.from\("projects"\)/);

  // moved out of the route file -- projects.tsx no longer renders the table itself
  const projects = codeOnly(readApp(PROJECTS_ROUTE));
  assert.ok(
    !/Write workspace Knowledge/.test(projects),
    "the hosted table body should live in hosted-projects.tsx only",
  );
  assert.ok(
    !/supabase\.from\(/.test(projects),
    "the route file no longer talks to Supabase directly",
  );
});

test("local-projects.tsx: connection card, sync card, allowed switch, connect flow, only the client helpers", () => {
  const code = codeOnly(readApp(LOCAL_PROJECTS));
  const raw = readApp(LOCAL_PROJECTS);

  for (const text of ["Connect Lovable", "Sync now", "Allowed"]) {
    assert.ok(raw.includes(text), `local-projects.tsx missing "${text}"`);
  }
  assert.match(raw, /uses no credits/);
  assert.equal(
    count(raw, CONNECT_LOVABLE_SENTENCE),
    1,
    "the exact MCP/credits sentence appears exactly once",
  );

  // sync card: last-run line built from last_run.counts, using the count
  // keys the executor actually writes (see harness/src/executor/beats.ts runAll)
  assert.match(code, /counts(\?\.\["messages"\]|\?\.messages|\.messages)/);
  assert.match(code, /knowledge_snapshots/);
  assert.match(code, /Last sync failed/);
  assert.match(code, /Next sync/);
  assert.match(code, /Syncing…/);

  // connect flow
  assert.match(code, /postExecutor\(\{ action: "connect" \}\)/);
  assert.match(code, /window\.open\(/);
  assert.match(code, /noopener/);
  assert.match(code, /postExecutor\(\{ action: "disconnect" \}\)/);
  assert.match(code, /fetchExecutor\(/);
  assert.match(code, /3000|3_000/, "polls every 3 seconds");
  assert.match(code, /10 \* 60 \* 1000|600000|600_000/, "stops polling after 10 minutes");

  // allow/disallow
  assert.match(code, /action: "allow"/);
  assert.match(code, /action: "disallow"/);
  assert.match(code, /lovable_project_id/);

  // when `all` is absent, only allowed projects are listed
  assert.match(code, /projects\.data\?\.all/);
  assert.match(code, /projects\.data\?\.allowed/);

  // only the local Harness client helpers -- no raw fetch, no Supabase, no Lovable
  assert.ok(!/\bfetch\(/.test(code), "local-projects.tsx must not call fetch directly");
  assert.ok(
    !/supabase|lovable\.dev|callApi\(/i.test(code),
    "local-projects.tsx must not talk to Supabase or Lovable directly",
  );
  assert.match(code, /from "@\/lib\/improvements-client"/);

  // credits only in the one approved sentence
  assert.equal(count(raw, "credit"), 1);

  // no <details open>
  for (const tag of code.match(/<details[^>]*>/g) ?? []) assert.ok(!/\sopen\b/.test(tag));

  // no internal vocabulary, no spec/Claude Code leakage
  for (const word of ["checkpoint", "message_id", "provenance", "confidence", "classifier"]) {
    assert.ok(!new RegExp(word, "i").test(code), `${word} leaks into local-projects.tsx`);
  }
  assert.ok(!/\bspec\b/i.test(code));
  assert.ok(!/claude code/i.test(code));
});

test("local-settings.tsx: five sections with the exact sentences, schedule and cap posts, validation errors toast", () => {
  const code = codeOnly(readApp(LOCAL_SETTINGS));
  const raw = readApp(LOCAL_SETTINGS);

  for (const text of ["Sync schedule", "Knowledge limit", APPROVAL_SENTENCE, SCHEDULE_SENTENCE]) {
    assert.ok(raw.includes(text), `local-settings.tsx missing "${text}"`);
  }
  assert.match(raw, /Approval/);

  // schedule form posts the full contract
  assert.match(code, /action: "schedule"/);
  assert.match(code, /enabled:/);
  assert.match(code, /interval_minutes:/);
  assert.match(code, /window_start_hour:/);
  assert.match(code, /window_end_hour:/);

  // cap posts the settings action
  assert.match(code, /action: "settings"/);
  assert.match(code, /knowledge_char_cap/);

  // validation errors from the API surface as a toast (postExecutor throws,
  // caught by a mutation onError that calls toast.error)
  assert.match(code, /onError:/);
  assert.match(code, /toast\.error\(/);

  // save buttons per section: decisions (Round 5 Task 6), evidence (Round 5
  // Task 7), schedule, cap, one combined AI analysis save (settings + key
  // when typed), key remove, and project defaults (Round 3 §4)
  assert.match(code, /useMutation\(/);
  assert.equal(
    count(code, "useMutation("),
    7,
    "decisions, evidence, schedule, cap, ai analysis save, llm key remove, defaults",
  );

  // only the local Harness client helpers
  assert.ok(!/\bfetch\(/.test(code), "local-settings.tsx must not call fetch directly");
  assert.ok(
    !/supabase|lovable\.dev|callApi\(/i.test(code),
    "local-settings.tsx must not talk to Supabase or Lovable directly",
  );
  assert.match(code, /from "@\/lib\/improvements-client"/);
  assert.match(code, /postExecutor\(/);

  // credits only in the one approved sentence
  assert.equal(count(raw, "credit"), 1);

  for (const tag of code.match(/<details[^>]*>/g) ?? []) assert.ok(!/\sopen\b/.test(tag));
  // "classifier" is dropped from this page's ban: Round 3 §4 makes it a
  // legitimate user-facing AI-analysis role label ("Classifier"), not a
  // leaked implementation term. "Claude Code" is dropped too: Round 4 Task
  // A4 / spec §2 adds it as a real provider choice ("Claude Code (your
  // subscription)"), the one sanctioned exception to the no-Claude-Code-
  // mentions rule, since it's the provider's own name. "confidence" is
  // dropped too: Round 5 Task 6 / spec §4 makes it real, approved
  // user-facing vocabulary in the new Decisions section ("Confidence
  // needed", and the automatic-mode help text's own "a confidence of at
  // least 0.8", verbatim from the spec) plus the decision_auto_confidence
  // wire key that section actually posts.
  for (const word of ["checkpoint", "message_id", "provenance"]) {
    assert.ok(!new RegExp(word, "i").test(code), `${word} leaks into local-settings.tsx`);
  }
  assert.ok(!/\bspec\b/i.test(code));
});

test("local pages fetch only the harness client helpers, not raw routes", () => {
  for (const page of [LOCAL_PROJECTS, LOCAL_SETTINGS]) {
    const code = codeOnly(readApp(page));
    const targets = [...code.matchAll(/fetch\("([^"]+)"/g)].map((m) => m[1]);
    assert.equal(targets.length, 0, `${page} should call fetch only through the client helpers`);
  }
});
