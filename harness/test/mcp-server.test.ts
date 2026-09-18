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
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
// Checkpoint 2 2-F: only for the budget-parity test's direct-db write below
// (store.setSettings validates lovable_monthly_credit_budget as a whole
// number 0-1000, so a fractional test value can't go through it).
const { db } = await import("../src/db.js");

const PROJECT = "mcp-server-test-project";
store.upsertProject({ lovable_project_id: PROJECT, name: "MCP Test Project" });
store.allowProject(PROJECT, "MCP Test Project");

// Checkpoint 2 2-F: same helper as harness/test/experiments-actions.test.ts
// -- lovable-auth.ts#status().connected only ever reads this file's own
// shape (an access_token present), never a real server, so this makes
// start_replay's budget refusal (rather than "not connected") reachable
// without any network call.
function markConnected(): void {
  writeFileSync(
    process.env.HARNESS_AUTH_PATH!,
    JSON.stringify({
      tokens: { access_token: "fake-local-token", token_type: "Bearer", expires_in: 999_999_999 },
      tokens_saved_at: Date.now(),
    }),
  );
}

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
  // Checkpoint 2 2-F: the Skill-proposal tools (D4) -- see this file's own
  // tests below and mcp-server.ts's own "---- Checkpoint 2 2-F ----" block.
  "list_skill_proposals",
  "get_skill_proposal",
  "edit_skill_proposal",
  "approve_skill_proposal",
  "restore_skill_proposal_revision",
];

test("tools/list returns exactly the 18 permitted tool names, no more, no fewer", async () => {
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

// ---- Checkpoint 2 2-F ----

test("MCP budget parity: start_replay's refusal is byte-for-byte adapter.improvementActionAndWrite's own, in both decision modes", async () => {
  markConnected();
  const rule = store.getRuleForCorrection(correctionCandidate.id) as { id: number };
  // credit_ledger rows carry a real experiment_runs FK -- a throwaway run,
  // immediately put in a terminal state so activeExperimentRun(20) (the
  // "already running" refusal, checked before the budget) never sees it.
  const { id: creditRunId } = store.createExperimentRun({
    rule_id: rule.id,
    correction_candidate_id: correctionCandidate.id,
    task_episode_id: episode.id,
    source_project_id: PROJECT,
    request_message_external_id: "aimsg_budget_fixture",
  });
  store.updateExperimentRun(creditRunId, { status: "cancelled" });
  store.recordCredits(creditRunId, 1.0);
  // store.setSettings only accepts a whole-number budget (0-1000) --
  // writing "0.5" straight to the settings table is the same direct-db
  // convention this file's own fixtures already use elsewhere (backdating
  // fetched_at) for a value the public API deliberately can't produce but
  // this test still needs to exercise the exact fractional-usage wording.
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES ('lovable_monthly_credit_budget', '0.5', datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run();
  try {
    for (const mode of ["ask", "automatic"] as const) {
      store.setSettings({ decision_mode: mode });

      let expected: string | null = null;
      try {
        await adapter.improvementActionAndWrite(
          { action: "test", id: correctionCandidate.id },
          "operator (local UI)",
        );
        assert.fail("expected a budget refusal");
      } catch (err) {
        assert.ok(err instanceof Error);
        expected = err.message;
      }
      assert.equal(
        expected,
        "This would exceed your monthly Lovable credit budget (1 of 0.5 used).",
      );

      const { client, server } = await connectedClient();
      try {
        const result = await client.callTool({
          name: "start_replay",
          arguments: { id: correctionCandidate.id },
        });
        const { isError, text } = parse(result as never);
        assert.equal(isError, true);
        assert.equal(text, expected, `decision_mode ${mode} must not change the refusal text`);
      } finally {
        await client.close();
        await server.close();
      }
    }
  } finally {
    store.setSettings({ decision_mode: "ask", lovable_monthly_credit_budget: "12" });
  }
});

test("list_skill_proposals lists a proposal created via set_content_destination, with lovable_state 'not_created'", async () => {
  await adapter.improvementActionAndWrite(
    { action: "set_content_destination", id: correctionCandidate.id, destination: "both" },
    "operator (local UI)",
  );
  const { client, server } = await connectedClient();
  try {
    const result = await client.callTool({ name: "list_skill_proposals", arguments: {} });
    const { json } = parse(result as never) as {
      json: { suggestion_id: number; lovable_state: string; ownership: string }[];
    };
    const found = json.find((p) => p.suggestion_id === correctionCandidate.id);
    assert.ok(found, "the newly-created proposal should be listed");
    assert.equal(found!.lovable_state, "not_created");
    assert.equal(found!.ownership, "harness");
  } finally {
    await client.close();
    await server.close();
  }
});

test("get_skill_proposal(suggestion_id) returns the proposal, its revisions, and lovable_state 'not_created'", async () => {
  const direct = adapter.getImprovement(correctionCandidate.id, { connected: false });
  assert.ok(direct?.skill_proposal, "fixture suggestion should carry a skill proposal by now");

  const { client, server } = await connectedClient();
  try {
    const result = await client.callTool({
      name: "get_skill_proposal",
      arguments: { suggestion_id: correctionCandidate.id },
    });
    const { json } = parse(result as never);
    assert.equal(json.available, true);
    assert.equal(json.proposal.id, direct!.skill_proposal!.id);
    assert.equal(json.proposal.lovable_state, "not_created");
    assert.ok(Array.isArray(json.proposal.revisions));
    assert.ok(json.proposal.revisions.length >= 1);
  } finally {
    await client.close();
    await server.close();
  }
});

test("get_skill_proposal: an unknown suggestion id is refused, not silently returned as available", async () => {
  const { client, server } = await connectedClient();
  try {
    const result = await client.callTool({
      name: "get_skill_proposal",
      arguments: { suggestion_id: 999_999 },
    });
    const { isError, text } = parse(result as never);
    assert.equal(isError, true);
    assert.match(text, /not found/i);
  } finally {
    await client.close();
    await server.close();
  }
});

test("approve_skill_proposal via MCP matches adapter.improvementActionAndWrite's own result, and creates a new revision", async () => {
  const before = adapter.getImprovement(correctionCandidate.id, { connected: false });
  const proposalId = before!.skill_proposal!.id;
  const revisionsBefore = before!.skill_proposal!.revisions.length;

  const { client, server } = await connectedClient();
  try {
    const result = await client.callTool({
      name: "approve_skill_proposal",
      arguments: { proposal_id: proposalId },
    });
    const { isError, json } = parse(result as never);
    assert.equal(isError, false);
    assert.equal(json.skill_proposal.id, proposalId);
    assert.equal(json.skill_proposal.status, "approved");
    assert.equal(
      json.skill_proposal.revisions.length,
      revisionsBefore + 1,
      "approving records a new revision",
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("restore_skill_proposal_revision via MCP restores content from an earlier revision", async () => {
  const proposal = adapter.getImprovement(correctionCandidate.id, {
    connected: false,
  })!.skill_proposal!;
  const firstRevision = proposal.revisions[0]!;
  const originalName = firstRevision.new_name;

  // Change it first, so there is something to restore away from.
  await adapter.improvementActionAndWrite(
    {
      action: "edit_skill_proposal",
      proposal_id: proposal.id,
      name: "a different name entirely",
      content: proposal.content,
    },
    "operator (local UI)",
  );

  const { client, server } = await connectedClient();
  try {
    const result = await client.callTool({
      name: "restore_skill_proposal_revision",
      arguments: { proposal_id: proposal.id, revision_id: firstRevision.id },
    });
    const { isError, json } = parse(result as never);
    assert.equal(isError, false);
    assert.equal(json.skill_proposal.name, originalName);
  } finally {
    await client.close();
    await server.close();
  }
});

test("edit_skill_proposal via MCP refuses a user-owned proposal with the exact sentence the UI gets", async () => {
  // A user-owned proposal on its own, unrelated suggestion -- Harness Ledger
  // never edits a Skill it did not itself propose (SkillProposalOwnershipError,
  // store.ts), through the UI or through MCP.
  const asked2 = mk(
    "Always show a loading spinner during checkout.",
    "m-2-2f",
    "2026-09-02T10:00:00Z",
  );
  const episode2 = store.createTaskEpisode({
    project_id: PROJECT,
    title: "loading spinner episode",
    provenance: "llm_derived",
    evidence_history_item_ids: [asked2.id],
  }) as { id: number };
  const candidate2 = store.createCorrectionCandidate({
    task_episode_id: episode2.id,
    classification: "constraint_restatement",
    is_correction: true,
    reusable: true,
    proposed_scope: "project",
    summary: "No loading spinner during checkout.",
    evidence_history_item_ids: [asked2.id],
  }) as { id: number };
  const userProposal = store.createSkillProposal({
    correction_candidate_id: candidate2.id,
    name: "user's own skill",
    content: "# User's own skill\n",
    ownership: "user",
    created_by: "user",
  });

  let expected: string | null = null;
  try {
    await adapter.improvementActionAndWrite(
      {
        action: "edit_skill_proposal",
        proposal_id: userProposal.id,
        name: "harness tries to rename it",
        content: userProposal.content,
      },
      "operator (local UI)",
    );
    assert.fail("expected a SkillProposalOwnershipError");
  } catch (err) {
    assert.ok(err instanceof Error);
    expected = err.message;
  }
  assert.equal(expected, "This Skill is yours; Harness Ledger does not change user-owned Skills.");

  const { client, server } = await connectedClient();
  try {
    const result = await client.callTool({
      name: "edit_skill_proposal",
      arguments: {
        proposal_id: userProposal.id,
        name: "harness tries to rename it",
        content: userProposal.content,
      },
    });
    const { isError, text } = parse(result as never);
    assert.equal(isError, true);
    assert.equal(text, expected);
  } finally {
    await client.close();
    await server.close();
  }
});
// ---- end Checkpoint 2 2-F ----
