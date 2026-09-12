// Round 6 Task 5 fix round 1 (finding A1): structural test that the
// Instructions page's Knowledge read (src/routes/api/public/harness/
// knowledge.ts) never shows demo text as "Read from Lovable at ..." --
// latestKnowledgeSnapshot must be called with { forWrite: true } there
// (spec §5: real Knowledge writes/reads ignore demo snapshots). Kept in its
// own file since other ux-round6-*.test.ts files are being edited
// concurrently by other agents.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function readApp(rel: string): string {
  return readFileSync(new URL(`../../src/${rel}`, import.meta.url), "utf8");
}

const KNOWLEDGE_ROUTE = "routes/api/public/harness/knowledge.ts";

test("knowledge.ts: latestKnowledgeSnapshot is called with { forWrite: true } so the Instructions page never shows demo text as the current Lovable Knowledge", () => {
  const source = readApp(KNOWLEDGE_ROUTE);
  const call = source.match(/adapter\.latestKnowledgeSnapshot\([^)]*\)/);
  assert.ok(call, "expected an adapter.latestKnowledgeSnapshot(...) call in knowledge.ts");
  assert.match(
    call![0],
    /forWrite:\s*true/,
    "latestKnowledgeSnapshot must be called with { forWrite: true } here -- a demo snapshot (fetched_by = 'demo') must never be shown as what Lovable currently holds",
  );
});
