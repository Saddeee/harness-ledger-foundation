// Round 4 Task A3: structural tests for the "Analyse now" route wiring and
// client type. Same lightweight, dependency-free file-content checks as
// ux.test.ts/ux-round4-retire.test.ts (kept in its own file per the task
// instructions -- other tasks are editing the improvements route/UI files
// concurrently).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function readApp(rel: string): string {
  return readFileSync(new URL(`../../src/${rel}`, import.meta.url), "utf8");
}

const EXECUTOR_ROUTE = "routes/api/public/harness/executor.ts";
const CLIENT = "lib/improvements-client.ts";

test("executor route: POST handles analyse_now, GET reports provider_ready, and requestAnalysis backs it", () => {
  const source = readApp(EXECUTOR_ROUTE);
  assert.ok(source.includes("analyse_now"), "POST action analyse_now is wired");
  assert.ok(source.includes("provider_ready"), "GET response carries provider_ready");
  assert.ok(source.includes("requestAnalysis"), "analyse_now calls adapter.requestAnalysis()");
});

test("improvements-client.ts: the ExecutorResponse client type carries an analysis field", () => {
  const source = readApp(CLIENT);
  assert.ok(
    /analysis\??:\s*ExecutorAnalysis/.test(source),
    "ExecutorResponse has an `analysis` field",
  );
  assert.ok(source.includes("provider_ready"), "the analysis type carries provider_ready");
  assert.ok(source.includes("awaiting_analysis"), "the analysis type carries awaiting_analysis");
});
