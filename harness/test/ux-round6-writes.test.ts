// Round 6 Task 2 / spec §2: structural tests for inline writes, inline
// sync, the in-app scheduler and the sidebar connection line. Same
// lightweight, dependency-free local helpers as ux-round4-retire.test.ts
// (kept in its own file per the task instructions -- other tests are being
// edited concurrently).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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

const DETAIL = "components/harness/improvement.tsx";
const INSTRUCTIONS_PAGE = "routes/_authenticated/instructions.tsx";
const HISTORY_PAGE = "routes/_authenticated/history.tsx";
const LOCAL_PROJECTS = "components/harness/local-projects.tsx";
const LOCAL_SETTINGS = "components/harness/local-settings.tsx";
const SHELL = "routes/_authenticated/route.tsx";
const CLIENT = "lib/improvements-client.ts";
const EXECUTOR_ROUTE = "routes/api/public/harness/executor.ts";
const IMPROVEMENTS_ROUTE = "routes/api/public/harness/improvements.ts";
const KNOWLEDGE_ROUTE = "routes/api/public/harness/knowledge.ts";
const HARNESS_RUNTIME = "lib/server/harness-runtime.ts";

// ---- structural: the phrase "next sync" is banned from every page's copy
// (and every source comment) under src/, repo-wide -- not just the files
// this task named explicitly. ----

const SRC_ROOT = fileURLToPath(new URL("../../src", import.meta.url));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

test("structural: no 'next sync' anywhere under src/", () => {
  const offenders: string[] = [];
  for (const file of walk(SRC_ROOT)) {
    const content = readFileSync(file, "utf8");
    if (/next sync/i.test(content)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], `'next sync' must not appear in: ${offenders.join(", ")}`);
});

// ---- harness-ux.ts: WriteOutcome / writeOutcomeLine / formatTime ----

test("harness-ux.ts: writeOutcomeLine reports 'Written to Lovable {time}' for a written outcome, the reason otherwise", () => {
  assert.equal(
    ux.writeOutcomeLine({ written: true, at: "2026-09-12T19:05:00.000Z", version_id: 1 }),
    `Written to Lovable ${ux.formatTime("2026-09-12T19:05:00.000Z")}`,
  );
  assert.equal(
    ux.writeOutcomeLine({
      written: false,
      version_id: 1,
      reason: "Harness is not connected — connect on the Projects page.",
      kind: "not_connected",
    }),
    "Harness is not connected — connect on the Projects page.",
  );
  assert.equal(ux.writeOutcomeLine(null), null);
  assert.equal(ux.writeOutcomeLine(undefined), null);
});

test("harness-ux.ts: formatTime renders HH:MM with no date", () => {
  const t = ux.formatTime("2026-09-12T00:00:00.000Z");
  assert.match(t, /^\d{2}:\d{2}$/);
  assert.equal(ux.formatTime(null), "");
  assert.equal(ux.formatTime(undefined), "");
});

test("harness-ux.ts: StatusCtx no longer has a nextSyncAt field anywhere in src/", () => {
  const code = codeOnly(readApp("lib/harness-ux.ts"));
  assert.ok(!/nextSyncAt/.test(code));
});

// ---- the improvements route: improvementActionAndWrite, write passthrough,
// retry_write ----

test("routes/api/public/harness/improvements.ts: POST uses improvementActionAndWrite and passes write through; retry_write is handled", () => {
  const code = codeOnly(readApp(IMPROVEMENTS_ROUTE));
  assert.match(code, /adapter\.improvementActionAndWrite\(body\)/);
  assert.ok(!/adapter\.improvementAction\(body\)/.test(code), "the old plain call is gone");
  assert.match(code, /write: improvement\.write/);
  assert.match(code, /body\["action"\] === "retry_write"/);
  assert.match(code, /adapter\.retryKnowledgeWrite\(versionId\)/);
});

// ---- the executor route: sync_now runs inline, GET adds schedule_holder ----

test("routes/api/public/harness/executor.ts: sync_now runs syncNow() inline and GET adds schedule_holder", () => {
  const code = codeOnly(readApp(EXECUTOR_ROUTE));
  assert.match(code, /action === "sync_now"/);
  assert.match(code, /executor\.beats\.syncNow\(\)/);
  assert.ok(!/adapter\.requestSync\(\)/.test(code), "sync_now no longer just queues a request");
  assert.match(code, /schedule_holder/);
  assert.match(code, /executor\.lock\.currentLockHolder\(\)/);
});

// ---- the knowledge route: restore writes inline too ----

test("routes/api/public/harness/knowledge.ts: restore attempts an inline write and reports the outcome", () => {
  const code = codeOnly(readApp(KNOWLEDGE_ROUTE));
  assert.match(code, /executor\.beats\.executeVersionNow\(version\.id, client\)/);
  assert.match(code, /available: true, version_id: version\.id, write/);
});

// ---- harness-runtime.ts: the executor bundle carries beats + lock, and
// starts the in-app scheduler once ----

test("lib/server/harness-runtime.ts: loadHarnessExecutor bundles beats.js and lock.js and starts the scheduler once", () => {
  const code = codeOnly(readApp(HARNESS_RUNTIME));
  assert.match(code, /executor\/beats\.js/);
  assert.match(code, /executor\/lock\.js/);
  assert.match(code, /schedule\.startInAppScheduler\(\)/);
  assert.match(code, /inAppSchedulerStarted/);
});

// ---- the sidebar connection line ----

test("routes/_authenticated/route.tsx: a connection line in the sidebar footer, built from executorQueryOptions", () => {
  const code = codeOnly(readApp(SHELL));
  assert.match(code, /useQuery\(executorQueryOptions\)/);
  assert.ok(readApp(SHELL).includes("Connected to Lovable"));
  assert.ok(readApp(SHELL).includes("Not connected — connect on Projects"));
});

// ---- the Projects page: schedule holder line ----

test("local-projects.tsx: a schedule holder line (running in the app / in the executor process / not running)", () => {
  const raw = readApp(LOCAL_PROJECTS);
  for (const text of [
    "Schedule: running in the app",
    "Schedule: running in the executor process",
    "Schedule: not running",
  ]) {
    assert.ok(raw.includes(text), `local-projects.tsx missing "${text}"`);
  }
  const code = codeOnly(raw);
  assert.match(code, /executor\.data\?\.schedule_holder/);
});

// ---- copy: "Written to Lovable" toast text, driven by the write outcome ----

test("improvement.tsx: toasts read the write outcome (writeToastText), not a static 'next sync' message", () => {
  const code = codeOnly(readApp(DETAIL));
  assert.match(code, /writeToastText\(result\.write, msg\)/);
  assert.match(code, /const SAVED_LINE = "Added\.";/);
  assert.match(code, /const RETIRED_TOAST = "Retired\.";/);
  assert.match(code, /const READDED_TOAST = "Re-added\.";/);
});

test("improvement.tsx: 'Try again' on a stale or failed outcome re-runs executeVersionNow via retry_write", () => {
  const code = codeOnly(readApp(DETAIL));
  assert.match(code, /lovable\.write_status === "stale" \|\| lovable\.write_status === "failed"/);
  assert.match(code, /action: "retry_write", id: item\.id, version_id: retryableVersion\.id/);
  assert.match(code, />\s*Try again\s*</);
});

// ---- instructions.tsx / history.tsx also read the write outcome ----

test("instructions.tsx: retire/readd/sync toasts read the write outcome and the sync result", () => {
  const code = codeOnly(readApp(INSTRUCTIONS_PAGE));
  assert.match(code, /writeToastText\(data\.write, "Retired\."\)/);
  assert.match(code, /writeToastText\(data\.write, "Re-added\."\)/);
  assert.match(code, /syncResultText\(data\)/);
});

test("history.tsx: restore's toast reads the write outcome", () => {
  const code = codeOnly(readApp(HISTORY_PAGE));
  assert.match(code, /writeToastText\(data\.write, "Restore staged\."\)/);
});

// ---- local-settings.tsx: the automatic-mode help text lost 'next sync' ----

test("local-settings.tsx: the automatic-mode help text no longer says 'next sync'", () => {
  const raw = readApp(LOCAL_SETTINGS);
  assert.ok(!/next sync/i.test(raw));
  assert.ok(raw.includes("the next time Harness syncs"));
});

// ---- improvements-client.ts: WriteOutcome type and helpers exist ----

test("lib/improvements-client.ts: WriteOutcome, writeToastText and syncResultText are exported", () => {
  const code = codeOnly(readApp(CLIENT));
  assert.match(code, /export type \{ WriteOutcome \}/);
  assert.match(code, /export function writeToastText/);
  assert.match(code, /export function syncResultText/);
  assert.match(code, /schedule_holder\?: ScheduleHolder/);
});
