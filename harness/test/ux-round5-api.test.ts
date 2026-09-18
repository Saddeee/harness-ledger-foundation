// Round 5 Task 3: structural tests for the Knowledge API's `timeline=`
// branch and the client wiring around it. Same lightweight, dependency-free
// readApp/codeOnly pattern as ux-round4-retire.test.ts (kept in its own
// file -- other ux*.test.ts files are being edited concurrently by another
// task).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function readApp(rel: string): string {
  return readFileSync(new URL(`../../src/${rel}`, import.meta.url), "utf8");
}
function readHarness(rel: string): string {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
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

const KNOWLEDGE_ROUTE = "routes/api/public/harness/knowledge.ts";
const CLIENT = "lib/improvements-client.ts";
const IMPROVEMENTS_SRC = "src/improvements.ts";

test("knowledge.ts: GET handles a `timeline=` query param, delegating to adapter.buildTimeline", () => {
  const code = codeOnly(readApp(KNOWLEDGE_ROUTE));
  assert.match(code, /searchParams\.get\("timeline"\)/);
  assert.match(code, /adapter\.buildTimeline\(/);
  assert.match(code, /target !== "project" && target !== "workspace"/);
});

test("improvements-client.ts: fetches only the six local harness routes", () => {
  const code = codeOnly(readApp(CLIENT));
  const SIX = ["improvements", "knowledge", "skills", "executor", "projects", "runtime"];
  const allFetches = code.match(/fetch\(\s*`?\/api\/public\/harness\/[a-z]+/g) ?? [];
  assert.ok(allFetches.length > 0, "expected at least one fetch call to a harness route");
  for (const f of allFetches) {
    const route = f.match(/\/api\/public\/harness\/([a-z]+)/)![1]!;
    assert.ok(SIX.includes(route), `unexpected harness route in client: ${route}`);
  }
  // Every one of the six is actually used somewhere (a seventh route would
  // be a real regression, but so would silently dropping one of these).
  for (const route of SIX) {
    assert.match(code, new RegExp(`/api/public/harness/${route}`), `missing fetch to ${route}`);
  }
});

test("improvements-client.ts: fetchTimeline hits the knowledge route with a timeline= query, using authHeaders", () => {
  const code = codeOnly(readApp(CLIENT));
  assert.match(code, /export async function fetchTimeline/);
  assert.match(code, /\/api\/public\/harness\/knowledge\?timeline=\$\{target\}:\$\{id\}/);
  const fnBody = code.slice(
    code.indexOf("export async function fetchTimeline"),
    code.indexOf("\n}", code.indexOf("export async function fetchTimeline")),
  );
  assert.match(fnBody, /authHeaders\(\)/);
});

test("TimelineNode type is exported from both the server (improvements.ts) and the client (improvements-client.ts)", () => {
  assert.match(readHarness(IMPROVEMENTS_SRC), /export type TimelineNode = \{/);
  assert.match(readApp(CLIENT), /export type TimelineNode = \{/);
});

test("improvements-client.ts: KnowledgeActiveRule gains status/since/verdict/adherence", () => {
  const code = codeOnly(readApp(CLIENT));
  const block = code.slice(
    code.indexOf("export type KnowledgeActiveRule"),
    code.indexOf("export type KnowledgeTargetView"),
  );
  assert.match(block, /status\?:\s*"written" \| "pending" \| "stale" \| "failed" \| "testing"/);
  assert.match(block, /since\?:\s*string \| null/);
  assert.match(block, /verdict\?:/);
  assert.match(block, /adherence\?:/);
});

test("improvements.ts (server): every spec §3b timeline label string appears verbatim", () => {
  const source = readHarness(IMPROVEMENTS_SRC);
  const LABELS = [
    "Written to Lovable",
    "Staged",
    "Restored Knowledge from version ",
    "Write needs attention",
    "Failed",
    "Cancelled",
    "Changed in Lovable (outside Harness Ledger)",
    "You accepted",
    "Accepted automatically (confidence",
    "You skipped",
    "You retired",
    "Re-added",
    "Harness Ledger suggested retiring",
    "You kept it",
    "Skill ",
    "You said to keep this rule",
    "You said this rule needs a review",
    "You said to retire this rule",
    "You said you're not sure this rule is still useful",
  ];
  for (const label of LABELS) {
    assert.ok(source.includes(label), `missing timeline label: "${label}"`);
  }
});

test("improvementAction: the actionInput union and dispatcher gained a `verdict` case", () => {
  const code = codeOnly(readHarness(IMPROVEMENTS_SRC));
  assert.match(code, /z\.literal\("verdict"\)/);
  assert.match(code, /rule_id: z\.number\(\)\.int\(\)/);
  assert.match(code, /verdict: z\.enum\(\["keep", "review", "retire", "not_sure"\]\)/);
  assert.match(code, /a\.action === "verdict"/);
});
