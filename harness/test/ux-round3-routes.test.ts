// Structural tests for Round 3 Task 2 (routes and client): knowledge.ts's
// per-version diff + demo_loaded, the new skills.ts route, executor.ts's
// LLM settings/keys/defaults actions, projects.ts's per-project settings,
// and improvements-client.ts's matching types/helpers. Page/route sources
// are checked structurally (no DOM, no HTTP server), same convention as
// ux.test.ts.
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
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*") && !t.startsWith("{/*");
    })
    .join("\n");
}

const KNOWLEDGE_ROUTE = "routes/api/public/harness/knowledge.ts";
const SKILLS_ROUTE = "routes/api/public/harness/skills.ts";
const EXECUTOR_ROUTE = "routes/api/public/harness/executor.ts";
const PROJECTS_ROUTE = "routes/api/public/harness/projects.ts";
const CLIENT = "lib/improvements-client.ts";
const ALL_ROUTES = [KNOWLEDGE_ROUTE, SKILLS_ROUTE, EXECUTOR_ROUTE, PROJECTS_ROUTE];

test("every Round 3 Task 2 route enforces auth through the shared adapter and references no spec document", () => {
  for (const route of ALL_ROUTES) {
    const code = readApp(route);
    assert.match(code, /requireAuth\(/, `${route} must call requireAuth(`);
    assert.match(code, /loadHarnessAdapter\(/, `${route} must call loadHarnessAdapter(`);
    assert.ok(!/SPEC/.test(code), `${route} must not reference a spec document`);
  }
});

test("knowledge.ts: the response carries demo_loaded and no per-target version diff any more; skills moved out", () => {
  const code = codeOnly(readApp(KNOWLEDGE_ROUTE));
  assert.match(code, /adapter\.demoLoaded\(\)/);
  assert.match(code, /demo_loaded:\s*adapter\.demoLoaded\(\)/);
  // skills is a whole field of the old response object -- it must not be
  // constructed here any more (the bare word "skills" still legitimately
  // appears in the file's own doc comment, which codeOnly strips).
  assert.ok(!/\bskills\b/.test(code), "the knowledge route must no longer build a skills field");
  assert.ok(!/latestSkillSnapshots/.test(code), "skill snapshot reads move to skills.ts");
  // Round 5 Task 4 / spec §3a-§3b: the per-target `versions` array (with its
  // own per-version line diff) moved out of buildKnowledgeResponse entirely
  // -- the full write history, and its diff, now live only on the History
  // page's timeline (`adapter.buildTimeline`, checked in
  // ux-round5-api.test.ts). buildKnowledgeResponse itself never diffs.
  assert.ok(
    !/adapter\.lineDiff\(/.test(code),
    "buildKnowledgeResponse must no longer compute a per-version diff",
  );
  assert.ok(!/versions,/.test(code), "targetsOut must no longer carry a versions field");
});

test("skills.ts: per-skill latest content plus full snapshot history with a line diff between consecutive snapshots", () => {
  const code = codeOnly(readApp(SKILLS_ROUTE));
  assert.match(code, /adapter\.latestSkillSnapshots\(/);
  assert.match(code, /adapter\.listSkillSnapshots\(/);
  assert.match(code, /adapter\.lineDiff\(/);
  assert.match(code, /\bhistory\b/);
  assert.match(code, /workspace_id:/);
  assert.match(code, /fetched_at:/);
  assert.match(code, /sha256:/);
  assert.match(code, /updated_at_remote:/);
  // GET only -- no write action exists for skills in this task.
  assert.ok(!/handlePost/.test(code));
  assert.match(code, /GET:\s*handleGet/);
});

test("executor.ts: GET returns llm + defaults, POST supports llm_settings/llm_key/llm_key_remove/defaults, and never echoes a raw key", () => {
  const raw = readApp(EXECUTOR_ROUTE);
  const code = codeOnly(raw);
  assert.match(code, /llm:\s*\{/);
  assert.match(code, /provider:\s*settings\.llm_provider/);
  assert.match(code, /models:\s*JSON\.parse\(settings\.llm_models\)/);
  assert.match(code, /monthly_token_budget:\s*Number\(settings\.llm_monthly_token_budget\)/);
  assert.match(code, /tokens_this_month:\s*adapter\.sumLlmTokensThisMonth\(\)/);
  assert.match(code, /spent_usd:\s*adapter\.sumLlmCostThisMonth\(\)/);
  assert.match(code, /defaults:\s*\{\s*max_active_rules:\s*Number\(settings\.max_active_rules\)\s*\}/);

  for (const action of ["llm_settings", "llm_key", "llm_key_remove", "defaults"]) {
    assert.match(code, new RegExp(`action === "${action}"`), `missing POST action ${action}`);
  }
  assert.match(code, /adapter\.setLlmKey\(provider, key\)/);
  assert.match(code, /adapter\.removeLlmKey\(provider\)/);
  assert.match(code, /key\.length === 0/, "llm_key must reject an empty key");
  assert.match(code, /key\.length > 400/, "llm_key must reject a key over 400 chars");
  assert.match(code, /isLlmProvider\(/, "llm_key/llm_key_remove must validate provider against the allowed set");

  // Never returns a raw key -- only has_key/last4, sourced only from
  // llmKeyStatus()/keyStatus, never a route-authored `key:`/`has_key:` field.
  const rawKeyFieldUsages = [...raw.matchAll(/\bkey:\s*/g)];
  assert.equal(
    rawKeyFieldUsages.length,
    0,
    `executor.ts must never construct a response field literally named "key:" -- found ${rawKeyFieldUsages.length}`,
  );
  const keysUsages = [...code.matchAll(/\bkeys:\s*([^\n,}]+)/g)].map((m) => m[1]!.trim());
  assert.ok(keysUsages.length > 0, "executor.ts must return a keys field somewhere");
  for (const usage of keysUsages) {
    assert.match(
      usage,
      /^(adapter\.llmKeyStatus\(\)|keyStatus)$/,
      `every "keys:" field must come from llmKeyStatus()/keyStatus, got: ${usage}`,
    );
  }
});

test("projects.ts: allowed rows carry per-project settings, project_settings action writes them", () => {
  const code = codeOnly(readApp(PROJECTS_ROUTE));
  assert.match(code, /settings:\s*adapter\.getProjectSettings\(row\.lovable_project_id\)/);
  assert.match(code, /body\["action"\]\s*===\s*"project_settings"/);
  assert.match(code, /adapter\.setProjectSettings\(id, patch\)/);
});

test("improvements-client.ts: fetchSkills/skillsQueryOptions and the new Round 3 types exist, and it fetches exactly the six local harness routes", () => {
  const client = codeOnly(readApp(CLIENT));
  assert.match(client, /export async function fetchSkills\(/);
  assert.match(client, /export const skillsQueryOptions\s*=/);
  assert.match(client, /changes:\s*KnowledgeChanges/);
  assert.match(client, /demo_loaded\?:\s*boolean/);
  assert.match(client, /llm\?:\s*ExecutorLlm/);
  assert.match(client, /defaults\?:\s*ExecutorDefaults/);
  assert.match(client, /settings:\s*ProjectSettings/);
  assert.ok(!/KnowledgeSkills/.test(client), "the old KnowledgeSkills type must be gone from the knowledge contract");

  const targets = new Set([...client.matchAll(/fetch\("([^"]+)"/g)].map((m) => m[1]));
  assert.deepEqual(
    [...targets].sort(),
    [
      "/api/public/harness/executor",
      "/api/public/harness/improvements",
      "/api/public/harness/knowledge",
      "/api/public/harness/projects",
      "/api/public/harness/runtime",
      "/api/public/harness/skills",
    ],
  );
});
