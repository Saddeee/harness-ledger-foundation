// UX round 8 (2026-09-19) Task 2, review item 2: dismissing a failed action
// from the Inbox. DB-backed -- migration v24 (inbox_dismissals), the
// store.dismissInboxItem/listDismissedInboxItemIds pair, improvements.ts's
// dismissInboxItem/listInboxItems filtering, and MCP parity. Same
// disposable-temp-DB fixture pattern as inbox-lifecycle.test.ts/
// mcp-server.test.ts -- never the real DB (see harness/data/, never touched
// here). Test files never import each other, so the small seeding helpers
// below are duplicated locally rather than shared with inbox-lifecycle.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "harness-inbox-dismiss-test-"));
process.env.HARNESS_DB_PATH = join(tmp, "harness.db");
process.env.HARNESS_AUTH_PATH = join(tmp, "lovable-auth.json");

const { db } = await import("../src/db.js");
const store = await import("../src/store.js");
const imp = await import("../src/improvements.js");
const adapter = await import("../src/adapter.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { createHarnessMcpServer } = await import("../src/mcp-server.js");

// ---- fixtures (mirrors inbox-lifecycle.test.ts's own helpers) ----

let projSeq = 0;
function freshProject(): string {
  projSeq += 1;
  const id = `inbox-dismiss-project-${projSeq}`;
  db.prepare(`INSERT INTO allowed_projects (lovable_project_id, label) VALUES (?, ?)`).run(id, id);
  store.upsertProject({ lovable_project_id: id, name: `Inbox Dismiss Test Project ${projSeq}` });
  return id;
}

let msgSeq = 0;
function msg(projectId: string, role: "user" | "assistant", content: string) {
  msgSeq += 1;
  return store.upsertHistoryItem({
    project_id: projectId,
    kind: "message",
    role,
    content,
    occurred_at: "2026-09-10T10:00:00.000Z",
    provenance: "lovable_mcp",
    external_id: `inbox-dismiss-ext-${msgSeq}`,
  }) as { id: number };
}

function seedSuggestion(opts: { projectId: string; instruction: string }): {
  candidateId: number;
  ruleId: number;
  episodeId: number;
} {
  const request = msg(opts.projectId, "user", `Build feature for ${opts.instruction}`);
  const correction = msg(opts.projectId, "user", `Fix: ${opts.instruction}`);
  const episode = store.createTaskEpisode({
    project_id: opts.projectId,
    title: opts.instruction,
    provenance: "llm_derived",
    evidence_history_item_ids: [request.id, correction.id],
  }) as { id: number };
  const candidate = store.createCorrectionCandidate({
    task_episode_id: episode.id,
    classification: "constraint_restatement",
    is_correction: true,
    reusable: true,
    proposed_scope: "project",
    summary: opts.instruction,
    evidence_history_item_ids: [request.id, correction.id],
    destination: "knowledge",
  }) as { id: number };
  const learning = store.createLearning({
    correction_candidate_id: candidate.id,
    observed_problem: opts.instruction,
    desired_behavior: opts.instruction,
    reuse_rationale: "r",
    proposed_scope: "project",
    provenance: "llm_derived",
    created_by: "test",
  }) as { id: number };
  const rule = store.createRule({
    learning_id: learning.id,
    correction_candidate_id: candidate.id,
    instruction: opts.instruction,
    scope: "project",
    applies_when: "always",
    predicted_failure: "p",
    ownership: "harness",
    created_by: "test",
  }) as { id: number };
  return { candidateId: candidate.id, ruleId: rule.id, episodeId: episode.id };
}

function createRun(
  candidateId: number,
  ruleId: number,
  episodeId: number,
  projectId: string,
): { id: number } {
  return store.createExperimentRun({
    rule_id: ruleId,
    correction_candidate_id: candidateId,
    task_episode_id: episodeId,
    source_project_id: projectId,
    request_message_external_id: `inbox-dismiss-run-req-${ruleId}`,
  });
}

function inboxItems() {
  return imp.listInboxItems({ connected: false });
}
function findItem(id: string) {
  return inboxItems().find((i) => i.id === id) ?? null;
}

/** A fresh failed run -- an action_failed item, id `run:<id>`. */
function seedFailedRun(): { itemId: string; projectId: string } {
  const projectId = freshProject();
  const { candidateId, ruleId, episodeId } = seedSuggestion({
    projectId,
    instruction: `Always show an empty state for zero results ${projectId}.`,
  });
  const run = createRun(candidateId, ruleId, episodeId, projectId);
  store.updateExperimentRun(run.id, {
    status: "failed",
    error: "The remix timed out",
    finished_at: "2026-09-11T00:00:00Z",
  });
  return { itemId: `run:${run.id}`, projectId };
}

// ---- 1. migration v24 applies on a fresh DB ----

test("migration v24 creates inbox_dismissals on a fresh DB", () => {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'inbox_dismissals'`)
    .get();
  assert.ok(row, "inbox_dismissals table must exist after migrations run");
  const applied = db.prepare(`SELECT version FROM schema_migrations WHERE version = 24`).get() as
    { version: number } | undefined;
  assert.ok(applied, "migration v24 must be recorded in schema_migrations");
  const cols = db.prepare(`PRAGMA table_info(inbox_dismissals)`).all() as { name: string }[];
  assert.deepEqual(cols.map((c) => c.name).sort(), ["dismissed_at", "item_id"]);
});

// ---- 2. dismissing a failed run removes it from the Inbox and drops the count ----

test("dismissing a failed run's Inbox item removes it from listInboxItems and inboxCount drops by one", () => {
  const { itemId } = seedFailedRun();
  assert.ok(findItem(itemId), "the failed run appears as action_failed before dismissal");
  const before = imp.inboxCount({ connected: false });

  const result = imp.dismissInboxItem(itemId);
  assert.deepEqual(result, { ok: true, item_id: itemId });

  assert.equal(findItem(itemId), null, "the dismissed item is gone from listInboxItems");
  const after = imp.inboxCount({ connected: false });
  assert.equal(after, before - 1, "inboxCount drops by exactly one");
  assert.equal(after, inboxItems().length, "inboxCount must equal listInboxItems().length");
});

test("store.listDismissedInboxItemIds reflects the dismissal, keyed by the item's own composite id", () => {
  const { itemId } = seedFailedRun();
  imp.dismissInboxItem(itemId);
  const dismissed = store.listDismissedInboxItemIds();
  assert.ok(dismissed.has(itemId));
});

// ---- 3. only a failed action can be dismissed ----

test("dismissing a new_instruction id throws 'Only a failed action can be dismissed'", () => {
  const projectId = freshProject();
  const { candidateId } = seedSuggestion({
    projectId,
    instruction: `Always debounce the search box ${projectId}.`,
  });
  const itemId = `suggestion:${candidateId}`;
  assert.ok(findItem(itemId), "the pending suggestion appears as new_instruction");
  assert.throws(() => imp.dismissInboxItem(itemId), /Only a failed action can be dismissed/);
  // Nothing was recorded -- the item is still there afterwards.
  assert.ok(findItem(itemId));
});

test("dismissing an unknown id throws 'Only a failed action can be dismissed'", () => {
  assert.throws(
    () => imp.dismissInboxItem("run:99999999"),
    /Only a failed action can be dismissed/,
  );
});

// ---- 4. adapter parity: adapter.dismissInboxItem is the same function ----

test("adapter.dismissInboxItem dismisses the same way improvements.dismissInboxItem does", () => {
  const { itemId } = seedFailedRun();
  const result = adapter.dismissInboxItem(itemId);
  assert.deepEqual(result, { ok: true, item_id: itemId });
  assert.equal(findItem(itemId), null);
});

// ---- 5. MCP parity: dismiss_inbox_item tool exists and behaves identically ----

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
  return { isError, text, json: !isError && text ? JSON.parse(text) : null };
}

test("MCP: tools/list includes dismiss_inbox_item", async () => {
  const { client, server } = await connectedClient();
  try {
    const { tools } = await client.listTools();
    assert.ok(tools.some((t) => t.name === "dismiss_inbox_item"));
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP: dismiss_inbox_item dismisses a failed run the same way the adapter call does", async () => {
  const { itemId } = seedFailedRun();
  const { client, server } = await connectedClient();
  try {
    const result = await client.callTool({
      name: "dismiss_inbox_item",
      arguments: { item_id: itemId },
    });
    const parsed = parse(result as Parameters<typeof parse>[0]);
    assert.equal(parsed.isError, false);
    assert.deepEqual(parsed.json, { ok: true, item_id: itemId });
    assert.equal(findItem(itemId), null);
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP: dismiss_inbox_item refuses an unknown/non-action_failed id with the exact same sentence the adapter throws", async () => {
  const { client, server } = await connectedClient();
  try {
    const result = await client.callTool({
      name: "dismiss_inbox_item",
      arguments: { item_id: "run:99999999" },
    });
    const parsed = parse(result as Parameters<typeof parse>[0]);
    assert.equal(parsed.isError, true);
    assert.equal(parsed.text, "Only a failed action can be dismissed");
  } finally {
    await client.close();
    await server.close();
  }
});
