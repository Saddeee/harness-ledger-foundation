// Checkpoint 2 2-F: proves the deletion safety properties SPEC.md §6
// promises -- "the source project is never chattable, deletable or written
// by the runner" and "only copies registered on the run can be deleted" --
// hold at every entry point that can reach rest.deleteProject: the
// executor's own cleanupCopy/deleteTestCopy (experiments.ts) and the
// Harness Ledger MCP surface (mcp-server.ts). Nothing here calls real
// Lovable -- deletion is exercised only against startFakeLovable's own
// scratch node:http server (fake-lovable.ts), same convention as
// experiments.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "harness-safe-to-delete-test-"));
process.env.HARNESS_DB_PATH = join(tmp, "harness.db");
process.env.HARNESS_AUTH_PATH = join(tmp, "lovable-auth.json");

const store = await import("../src/store.js");
const { cleanupCopy, deleteTestCopy } = await import("../src/executor/experiments.js");
const { createLovableRest } = await import("../src/executor/lovable-rest.js");
const { startFakeLovable } = await import("./fake-lovable.js");
type FakeLovableServer = Awaited<ReturnType<typeof startFakeLovable>>;

const SOURCE = "prj_safe_source";
store.allowProject(SOURCE, "Source project");
store.upsertProject({ lovable_project_id: SOURCE, name: "Source project", workspace_id: "ws_1" });
store.setSettings({ keep_test_copies: "false" });

function restFor(fake: FakeLovableServer) {
  return createLovableRest({ baseUrl: fake.baseUrl, fetchFn: fetch, token: "test-token" });
}

let seedSeq = 0;

/** The minimum rule/candidate/episode chain experiment_runs' own NOT NULL
 * foreign keys require -- trimmed down from experiments.test.ts's own
 * seedCandidate (this file never runs a replay, only exercises deletion, so
 * it needs no request message or Knowledge fixture). */
function seedRun(): { ruleId: number; candidateId: number; episodeId: number } {
  seedSeq += 1;
  const episode = store.createTaskEpisode({
    project_id: SOURCE,
    title: `safe-to-delete episode ${seedSeq}`,
    provenance: "manual",
  }) as { id: number };
  const candidate = store.createCorrectionCandidate({
    task_episode_id: episode.id,
    classification: "defect_correction",
    is_correction: true,
    reusable: true,
    proposed_scope: "project",
    summary: "fixture",
    evidence_history_item_ids: [],
  }) as { id: number };
  const learning = store.createLearning({
    correction_candidate_id: candidate.id,
    observed_problem: "fixture",
    desired_behavior: "fixture",
    reuse_rationale: "fixture",
    proposed_scope: "project",
    provenance: "manual",
    created_by: "test",
  }) as { id: number };
  const rule = store.createRule({
    learning_id: learning.id,
    correction_candidate_id: candidate.id,
    instruction: "fixture rule",
    scope: "project",
    applies_when: "fixture",
    predicted_failure: "fixture",
    ownership: "harness",
    created_by: "test",
  }) as { id: number };
  return { ruleId: rule.id, candidateId: candidate.id, episodeId: episode.id };
}

function newRun(overrides: Partial<Parameters<typeof store.updateExperimentRun>[1]> = {}) {
  const seed = seedRun();
  const { id } = store.createExperimentRun({
    rule_id: seed.ruleId,
    correction_candidate_id: seed.candidateId,
    task_episode_id: seed.episodeId,
    source_project_id: SOURCE,
    request_message_external_id: `aimsg_safe_${seedSeq}`,
  });
  if (Object.keys(overrides).length > 0) store.updateExperimentRun(id, overrides);
  return id;
}

// ---------------------------------------------------- deleteTestCopy

test("deleteTestCopy: refuses the source project id even when it is recorded as the run's own copy", async () => {
  const runId = newRun({ copy_project_id: SOURCE });
  const fake = await startFakeLovable({ deleteProject: () => ({ status: 204 }) });
  try {
    await assert.rejects(
      () => deleteTestCopy(runId, "with_rule", restFor(fake)),
      /Refusing to delete the source project/,
    );
    assert.equal(fake.calls.length, 0, "the source project must never reach a DELETE call");
  } finally {
    await fake.close();
  }
});

test("deleteTestCopy: refuses an id that was never recorded on this run -- there is no way to pass a raw project id in", async () => {
  // deleteTestCopy's own signature (runId, which, rest) has no id parameter
  // at all -- the only two ids it can ever act on are whatever this run's
  // own copy_project_id/original_copy_project_id columns hold. Asserting
  // its arity here pins that shape: a future edit that added a fourth,
  // caller-supplied id parameter would break this test, on purpose.
  assert.equal(deleteTestCopy.length, 3, "deleteTestCopy must take no caller-supplied project id");

  const runId = newRun(); // copy_project_id/original_copy_project_id both null
  const fake = await startFakeLovable({ deleteProject: () => ({ status: 204 }) });
  try {
    await assert.rejects(() => deleteTestCopy(runId, "with_rule", restFor(fake)), /no such copy/);
    await assert.rejects(() => deleteTestCopy(runId, "original", restFor(fake)), /no such copy/);
    assert.equal(fake.calls.length, 0, "no delete call was ever made for an unrecorded copy");
  } finally {
    await fake.close();
  }
});

// -------------------------------------------------------- cleanupCopy

test("cleanupCopy: deletes exactly the run's own two recorded copy ids, and nothing else (never the source project)", async () => {
  const runId = newRun({
    copy_project_id: "prj_safe_copy",
    original_copy_project_id: "prj_safe_original",
  });
  const fake = await startFakeLovable({
    deleteProject: () => ({ status: 204 }),
    getProject: (req) => ({
      status: 200,
      body: { id: req.params.project_id!, workspace_id: "ws_1" },
    }),
  });
  try {
    await cleanupCopy(store.getExperimentRun(runId)!, restFor(fake));
    const deleteCalls = fake.calls.filter((c) => c.method === "DELETE");
    assert.deepEqual(
      deleteCalls.map((c) => c.path).sort(),
      ["/v1/projects/prj_safe_copy", "/v1/projects/prj_safe_original"].sort(),
    );
    assert.ok(
      !deleteCalls.some((c) => c.path.includes(SOURCE)),
      "the source project id must never appear in a delete call",
    );
  } finally {
    await fake.close();
  }
});

test("cleanupCopy: a run with no copies recorded makes no delete call at all", async () => {
  const runId = newRun();
  const fake = await startFakeLovable({ deleteProject: () => ({ status: 204 }) });
  try {
    await cleanupCopy(store.getExperimentRun(runId)!, restFor(fake));
    assert.equal(fake.calls.length, 0);
  } finally {
    await fake.close();
  }
});

// ------------------------------------------------------- MCP surface

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { createHarnessMcpServer } = await import("../src/mcp-server.js");

async function connectedMcpClient() {
  const client = new Client({ name: "safe-to-delete-test-client", version: "0.0.0" });
  const server = createHarnessMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server };
}

test("Harness Ledger MCP has no tool named with 'resource' or 'safe', and no delete-capable tool at all", async () => {
  const { client, server } = await connectedMcpClient();
  try {
    const { tools } = await client.listTools();
    for (const t of tools) {
      assert.ok(!/resource/i.test(t.name), `tool name "${t.name}" must not contain "resource"`);
      assert.ok(!/safe/i.test(t.name), `tool name "${t.name}" must not contain "safe"`);
      // D5: the 18-tool surface has no delete/remove/destroy action of any
      // kind (deleting a test copy is a web-app-only action --
      // experiments-actions.ts's deleteCopyAction -- never re-exported to
      // mcp-server.ts); a raw Lovable project id can therefore never reach
      // a delete through this server.
      assert.ok(
        !/delete|remove|destroy/i.test(t.name),
        `tool "${t.name}" must not be a delete-capable tool`,
      );
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test("structural: mcp-server.ts never calls deleteProject/deleteTestCopy/cleanupCopy -- deletion is unreachable from MCP", () => {
  const source = readFileSync(new URL("../src/mcp-server.ts", import.meta.url), "utf8");
  assert.ok(!/deleteProject/.test(source));
  assert.ok(!/deleteTestCopy/.test(source));
  assert.ok(!/cleanupCopy/.test(source));
});
