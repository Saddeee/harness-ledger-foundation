// Round WP6 (DECISIONS.md D5): Harness MCP is now a thin layer over
// adapter.ts, the same module the web app's own routes import -- these
// tests drive it through the real MCP protocol (InMemoryTransport +
// Client), the way an agent actually would, rather than importing its
// handler functions directly. Same temp-DB pattern as
// harness/test/experiments.test.ts: env vars set before any harness module
// is imported, so every store/adapter/mcp-server import below opens the
// same throwaway SQLite file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "harness-mcp-server-test-"));
process.env.HARNESS_DB_PATH = join(tmp, "harness.db");
process.env.HARNESS_AUTH_PATH = join(tmp, "lovable-auth.json");

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { createHarnessMcpServer } = await import("../src/mcp-server.js");
const store = await import("../src/store.js");
const adapter = await import("../src/adapter.js");

const PROJECT = "mcp-server-test-project";
store.upsertProject({ lovable_project_id: PROJECT, name: "MCP Test Project" });
store.allowProject(PROJECT, "MCP Test Project");

function mk(content: string, externalId: string, occurredAt: string) {
  return store.upsertHistoryItem({
    project_id: PROJECT,
    kind: "message",
    external_id: externalId,
    role: "user",
    content,
    occurred_at: occurredAt,
    provenance: "lovable_mcp",
  }) as { id: number };
}

// One full correction -> learning -> rule chain, exactly like
// improvements.test.ts's own fixture, so decide_suggestion has a real
// pending suggestion to act on.
const asked = mk(
  "Never delete a customer's draft without confirming first.",
  "m-1",
  "2026-09-01T10:00:00Z",
);
const episode = store.createTaskEpisode({
  project_id: PROJECT,
  title: "draft deletion episode",
  provenance: "llm_derived",
  evidence_history_item_ids: [asked.id],
}) as { id: number };
const correctionCandidate = store.createCorrectionCandidate({
  task_episode_id: episode.id,
  classification: "constraint_restatement",
  is_correction: true,
  reusable: true,
  proposed_scope: "project",
  summary: "A customer's draft was deleted without confirmation.",
  evidence_history_item_ids: [asked.id],
}) as { id: number };
const learning = store.createLearning({
  correction_candidate_id: correctionCandidate.id,
  observed_problem: "drafts were deleted without asking",
  desired_behavior: "always confirm before deleting a draft",
  reuse_rationale: "applies to every delete flow",
  proposed_scope: "project",
  provenance: "llm_derived",
  created_by: "test",
}) as { id: number };
store.createRule({
  learning_id: learning.id,
  correction_candidate_id: correctionCandidate.id,
  instruction: "Always confirm with the user before deleting a draft.",
  scope: "project",
  applies_when: "a delete action targets a draft",
  predicted_failure: "silent data loss",
  ownership: "harness",
  created_by: "test",
});

async function connectedClient() {
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const server = createHarnessMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server };
}

function parse(result: { content: { type: string; text?: string }[]; isError?: boolean }) {
  const text = result.content.find((c) => c.type === "text")?.text ?? "";
  const isError = result.isError === true;
  // An error result's text is the plain error message, never JSON -- only a
  // successful result's text is the tool's JSON payload (see registerTool's
  // jsonResult/isError branches in mcp-server.ts).
  return { isError, text, json: !isError && text ? JSON.parse(text) : null };
}

const EXPECTED_TOOL_NAMES = [
  "health",
  "list_suggestions",
  "explain_suggestion",
  "decide_suggestion",
  "list_rules",
  "list_skills",
  "start_replay",
  "get_replay",
  "list_replays",
  "list_knowledge_versions",
  "restore_knowledge_version",
  "rule_observations",
  "timeline",
];

test("tools/list returns exactly the 13 permitted tool names, no more, no fewer", async () => {
  const { client, server } = await connectedClient();
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [...EXPECTED_TOOL_NAMES].sort());
  } finally {
    await client.close();
    await server.close();
  }
});

test("every tool description says it follows the app's own permissions", async () => {
  const { client, server } = await connectedClient();
  try {
    const { tools } = await client.listTools();
    for (const t of tools) {
      assert.ok(
        /same (adapter\.ts call|approval mode|permissions|decision mode|read exactly)|Read-only/.test(
          t.description ?? "",
        ) || /web app/.test(t.description ?? ""),
        `${t.name}'s description should say it follows the app's own permissions: ${t.description}`,
      );
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test("server carries the Harness-vs-Lovable-MCP instructions string", async () => {
  const { client, server } = await connectedClient();
  try {
    const instructions = client.getInstructions();
    assert.equal(
      instructions,
      "Harness MCP lets your agent operate Harness Ledger with the same permissions as the web app. " +
        "Lovable MCP (a different server) lets Harness operate Lovable.",
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("structural: mcp-server.ts imports only from ./adapter.js and the SDK/zod -- never ./store.js", () => {
  const source = readFileSync(new URL("../src/mcp-server.ts", import.meta.url), "utf8");
  const code = source
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  assert.ok(!/from\s+["']\.\/store\.js["']/.test(code), "mcp-server.ts must not import store.js");
  const importSpecifiers = [...code.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
  for (const spec of importSpecifiers) {
    assert.ok(
      spec === "./adapter.js" ||
        spec.startsWith("@modelcontextprotocol/sdk") ||
        spec === "zod" ||
        spec === "node:url",
      `unexpected import in mcp-server.ts: ${spec}`,
    );
  }
  assert.ok(importSpecifiers.includes("./adapter.js"));
});

test("no tool can mark a Knowledge version written without a real write: no tool named *readback*, no recordKnowledgeReadback call in source", async () => {
  const { client, server } = await connectedClient();
  try {
    const { tools } = await client.listTools();
    assert.ok(
      !tools.some((t) => /readback/i.test(t.name)),
      "no registered tool name may contain 'readback'",
    );
  } finally {
    await client.close();
    await server.close();
  }
  // A comment may still name the removed tool for context (see this file's
  // own header comment); what must never exist again is an actual call to
  // the function that let a caller fabricate a Lovable write (D5,
  // docs/audit/mcp-security.md finding 1).
  const source = readFileSync(new URL("../src/mcp-server.ts", import.meta.url), "utf8");
  assert.ok(!/recordKnowledgeReadback\(/.test(source));
});

test("no raw store mutation tools remain: update_rule, create_rule, review_correction_candidate are gone", async () => {
  const { client, server } = await connectedClient();
  try {
    const { tools } = await client.listTools();
    const names = new Set(tools.map((t) => t.name));
    for (const gone of [
      "update_rule",
      "create_rule",
      "review_correction_candidate",
      "record_knowledge_readback",
      "create_experiment_plan",
      "register_experiment_resource",
      "update_experiment_resource_status",
      "create_verification_definition",
      "create_verification_plan",
    ]) {
      assert.ok(!names.has(gone), `${gone} should have been removed`);
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test("parity: decide_suggestion(accept_project) in decision_mode 'ask' with no Lovable connection returns exactly what improvementActionAndWrite itself returns", async () => {
  assert.equal(adapter.getSettings().decision_mode, "ask");
  const item = adapter.listImprovements().find((i) => i.id === correctionCandidate.id);
  assert.ok(item, "fixture suggestion should be pending");
  assert.equal(item!.decision.status, "pending");

  // Call the real adapter function directly first, exactly the way the web
  // app's improvements.ts POST route does, to get the reference outcome --
  // then reopen the same decision (skip -> accept again) so the MCP call
  // below acts on an equivalent pending state, and compare the write outcome
  // shape/reason/kind rather than the whole object (ids/timestamps differ
  // between the two independent accepts).
  const direct = await adapter.improvementActionAndWrite(
    { action: "accept", id: correctionCandidate.id, destination: "project" },
    "operator (local UI)",
  );
  assert.equal(direct.decision.status, "accepted");
  assert.equal(direct.write?.written, false);
  assert.equal(direct.write?.kind, "not_connected");
  assert.equal(
    direct.write?.reason,
    "Harness Ledger is not connected — connect on the Projects page.",
  );

  // Reset back to pending (the same "reopen" action the Undo/Reopen control
  // uses) so the MCP call below exercises the same accept transition, not a
  // second decision on an already-decided item.
  await adapter.improvementActionAndWrite(
    { action: "reopen", id: correctionCandidate.id },
    "operator (local UI)",
  );

  const { client, server } = await connectedClient();
  try {
    const result = await client.callTool({
      name: "decide_suggestion",
      arguments: { id: correctionCandidate.id, action: "accept_project" },
    });
    const { isError, json } = parse(result as never);
    assert.equal(isError, false);
    assert.equal(json.decision.status, "accepted");
    assert.equal(json.write.written, false);
    assert.equal(json.write.kind, direct.write?.kind);
    assert.equal(json.write.reason, direct.write?.reason);
  } finally {
    await client.close();
    await server.close();
  }
});

test("start_replay refuses with the exact 'not connected' sentence when Harness is not connected", async () => {
  const { client, server } = await connectedClient();
  try {
    const result = await client.callTool({
      name: "start_replay",
      arguments: { id: correctionCandidate.id },
    });
    const { isError, text } = parse(result as never);
    assert.equal(isError, true);
    assert.equal(text, "Harness Ledger is not connected — connect on the Projects page.");
  } finally {
    await client.close();
    await server.close();
  }
});

test("health returns the same shape store.health()/adapter.health() does", async () => {
  const { client, server } = await connectedClient();
  try {
    const result = await client.callTool({ name: "health", arguments: {} });
    const { json } = parse(result as never);
    assert.equal(json.ok, true);
    assert.equal(typeof json.db_path, "string");
  } finally {
    await client.close();
    await server.close();
  }
});

test("list_suggestions(open) includes the fixture suggestion with trimmed fields", async () => {
  const { client, server } = await connectedClient();
  try {
    const result = await client.callTool({
      name: "list_suggestions",
      arguments: { filter: "all" },
    });
    const { json } = parse(result as never) as { json: { id: number; rule_text: string | null }[] };
    const found = json.find((s) => s.id === correctionCandidate.id);
    assert.ok(found, "fixture suggestion should be listed");
    assert.equal(typeof found!.rule_text, "string");
  } finally {
    await client.close();
    await server.close();
  }
});

test("explain_suggestion(id) returns the full improvement view plus a knowledge_preview key", async () => {
  const { client, server } = await connectedClient();
  try {
    const result = await client.callTool({
      name: "explain_suggestion",
      arguments: { id: correctionCandidate.id },
    });
    const { json } = parse(result as never);
    assert.equal(json.id, correctionCandidate.id);
    assert.ok("knowledge_preview" in json);
  } finally {
    await client.close();
    await server.close();
  }
});

test("timeline(project, id) matches adapter.buildTimeline(project, id) directly", async () => {
  const { client, server } = await connectedClient();
  try {
    const result = await client.callTool({
      name: "timeline",
      arguments: { target: "project", target_id: PROJECT },
    });
    const { json } = parse(result as never);
    assert.deepEqual(json.nodes, adapter.buildTimeline("project", PROJECT));
  } finally {
    await client.close();
    await server.close();
  }
});

test("list_rules(project_id) reflects adapter.activeRulesForTarget for that project", async () => {
  const { client, server } = await connectedClient();
  try {
    const result = await client.callTool({
      name: "list_rules",
      arguments: { project_id: PROJECT },
    });
    const { json } = parse(result as never) as { json: { target: string; id: string }[] };
    assert.equal(json.length, 1);
    assert.equal(json[0]!.target, "project");
    assert.equal(json[0]!.id, PROJECT);
  } finally {
    await client.close();
    await server.close();
  }
});

test("an unknown/removed tool name (e.g. the old raw update_rule) is refused, not silently accepted", async () => {
  const { client, server } = await connectedClient();
  try {
    const result = await client.callTool({ name: "update_rule", arguments: {} });
    const { isError, text } = parse(result as never);
    assert.equal(isError, true);
    assert.match(text, /not found/i);
  } finally {
    await client.close();
    await server.close();
  }
});
