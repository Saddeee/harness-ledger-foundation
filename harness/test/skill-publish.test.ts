// Checkpoint 3 S1: publishing an approved, Harness-owned Skill proposal to
// Lovable as a new workspace Skill. Covers the pure composition module
// (harness/src/skills/publish.ts), every precondition sentence, the success
// path with a stubbed LovableClient, the read-back-mismatch path, the
// failure path (redacted error, rethrown), the Inbox action_failed item,
// and that the automatic sync loop never calls this on its own. Same
// disposable-temp-DB fixture pattern as skill-proposals.test.ts and
// inbox-lifecycle.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HARNESS_DB_PATH = join(
  mkdtempSync(join(tmpdir(), "harness-skill-publish-test-")),
  "harness.db",
);

const { db } = await import("../src/db.js");
const store = await import("../src/store.js");
const imp = await import("../src/improvements.js");
const beats = await import("../src/executor/beats.js");
const action = await import("../src/executor/skill-publish-action.js");
const publish = await import("../src/skills/publish.js");
const ux = await import("../../src/lib/harness-ux.ts");

const PROJECT = "skill-publish-test-project";
const WORKSPACE = "ws-skill-publish-test";
db.prepare(`INSERT INTO allowed_projects (lovable_project_id, label) VALUES (?, ?)`).run(
  PROJECT,
  "test",
);
store.upsertProject({ lovable_project_id: PROJECT, name: "Skill Publish Test" });

// ---------------------------------------------------------------- fixtures

let nextExternalId = 0;
function msg(role: "user" | "assistant", content: string) {
  return store.upsertHistoryItem({
    project_id: PROJECT,
    kind: "message",
    role,
    content,
    occurred_at: "2026-09-19T10:00:00.000Z",
    provenance: "lovable_mcp",
    external_id: `sp-pub-ext-${nextExternalId++}`,
  }) as { id: number };
}

/** A fresh correction candidate with a Skill proposal, same shape a real
 * "destination: skill" suggestion carries -- `name` becomes both the
 * proposal's stored name and (by default, since it's already kebab-case)
 * the name it would normalise to. */
function seedProposal(opts: {
  name: string;
  content?: string;
  ownership?: "harness" | "user";
  status?: "proposed" | "approved" | "retired" | "skipped";
}): { candidateId: number; proposalId: number } {
  const request = msg("user", `Build feature for ${opts.name}`);
  const correction = msg("user", `Fix: ${opts.name}`);
  const episode = store.createTaskEpisode({
    project_id: PROJECT,
    title: opts.name,
    provenance: "llm_derived",
    evidence_history_item_ids: [request.id, correction.id],
  }) as { id: number };
  const candidate = store.createCorrectionCandidate({
    task_episode_id: episode.id,
    classification: "constraint_restatement",
    is_correction: true,
    reusable: true,
    proposed_scope: "project",
    summary: opts.name,
    evidence_history_item_ids: [request.id, correction.id],
    destination: "skill",
    destination_chosen_by: "rule_writer",
  }) as { id: number };
  const proposal = store.createSkillProposal({
    correction_candidate_id: candidate.id,
    name: opts.name,
    content: opts.content ?? `# ${opts.name}\n\n1. Step one.\n`,
    ownership: opts.ownership ?? "harness",
    created_by: "test",
  });
  if (opts.status && opts.status !== "proposed") {
    store.setSkillProposalStatus({ id: proposal.id, status: opts.status, actor: "test" });
  }
  return { candidateId: candidate.id, proposalId: proposal.id };
}

type ReadBack = { name: string; description: string | null; content: string } | null;

class FakeLovable {
  workspaces: { id: string; name: string }[];
  readback: ReadBack;
  createCalls: { workspaceId: string; skillName: string; markdown: string }[] = [];
  createThrows: Error | null = null;
  closed = false;

  constructor(opts: { workspaces?: { id: string; name: string }[]; readback?: ReadBack } = {}) {
    this.workspaces = opts.workspaces ?? [{ id: WORKSPACE, name: "WS" }];
    this.readback = opts.readback ?? null;
  }
  async getMe() {
    return { id: "u1", email: "a@example.com", name: "A", workspaces: this.workspaces };
  }
  async listProjects() {
    return [];
  }
  async listMessages() {
    return { messages: [], next_cursor: null, has_more: false };
  }
  async getProjectKnowledge() {
    return "";
  }
  async getWorkspaceKnowledge() {
    return "";
  }
  async listWorkspaceSkills() {
    return { skills: [], complete: true };
  }
  async getWorkspaceSkill(_workspaceId: string, _skillName: string) {
    return this.readback;
  }
  async createWorkspaceSkill(workspaceId: string, skillName: string, markdown: string) {
    this.createCalls.push({ workspaceId, skillName, markdown });
    if (this.createThrows) throw this.createThrows;
  }
  async setProjectKnowledge() {}
  async setWorkspaceKnowledge() {}
  async close() {
    this.closed = true;
  }
}

function fakeClient(opts?: { workspaces?: { id: string; name: string }[]; readback?: ReadBack }) {
  return new FakeLovable(opts);
}

// ------------------------------------------------------- composeSkillMarkdown

test("composeSkillMarkdown: no frontmatter -- derives the description from the first '# ' heading", () => {
  const md = publish.composeSkillMarkdown(
    "deploy-checklist",
    "# Deploy checklist\n\n1. Step one.\n",
  );
  assert.equal(
    md,
    "---\nname: deploy-checklist\ndescription: Deploy checklist\n---\n# Deploy checklist\n\n1. Step one.\n",
  );
});

test("composeSkillMarkdown: no frontmatter, no heading -- falls back to the first non-empty line, one line, capped at 200 chars", () => {
  const long = "x".repeat(250);
  const md = publish.composeSkillMarkdown("long-desc", `\n\n${long}\nsecond line\n`);
  const lines = md.split("\n");
  assert.equal(lines[0], "---");
  assert.equal(lines[1], "name: long-desc");
  assert.equal(lines[2], `description: ${"x".repeat(200)}`);
  assert.equal(lines[3], "---");
});

test("composeSkillMarkdown: existing frontmatter without a description -- name is forced, a description is added", () => {
  const original = "---\nname: old-name\n---\n# Real heading\nBody.\n";
  const md = publish.composeSkillMarkdown("forced-name", original);
  assert.equal(
    md,
    "---\nname: forced-name\ndescription: Real heading\n---\n# Real heading\nBody.\n",
  );
});

test("composeSkillMarkdown: existing frontmatter with its own description -- kept as-is, only name forced", () => {
  const original = "---\nname: old-name\ndescription: Already has one\n---\nBody text.\n";
  const md = publish.composeSkillMarkdown("forced-name-2", original);
  assert.equal(md, "---\nname: forced-name-2\ndescription: Already has one\n---\nBody text.\n");
});

// ------------------------------------------------------------ normalizeSkillName

test("normalizeSkillName: lowercase kebab, [a-z0-9-] only, collapsed dashes, trimmed edges, max 64 chars", () => {
  assert.equal(publish.normalizeSkillName("My Skill Name!!"), "my-skill-name");
  assert.equal(publish.normalizeSkillName("already-kebab"), "already-kebab");
  assert.equal(publish.normalizeSkillName("  leading and trailing  "), "leading-and-trailing");
  assert.equal(publish.normalizeSkillName("a__b---c"), "a-b-c");
  assert.equal(publish.normalizeSkillName("a".repeat(80)), "a".repeat(64));
});

// -------------------------------------------------------------- preconditions

test("publishSkillProposal: refuses when the proposal does not exist", async () => {
  await assert.rejects(() => action.publishSkillProposal(999_999, fakeClient(), "test"), {
    message: "skill proposal 999999 not found",
  });
});

test("publishSkillProposal: refuses a user-owned proposal with the exact ownership sentence", async () => {
  // Ownership is checked before status -- a user-owned proposal refuses even
  // while still "proposed" (setSkillProposalStatus itself would refuse to
  // approve a user-owned one, so this never sets one).
  const { proposalId } = seedProposal({
    name: "user-owned-skill",
    ownership: "user",
  });
  await assert.rejects(() => action.publishSkillProposal(proposalId, fakeClient(), "test"), {
    message: "This Skill is yours; Harness Ledger does not change user-owned Skills.",
  });
});

test("publishSkillProposal: refuses a proposal that isn't approved yet", async () => {
  const { proposalId } = seedProposal({ name: "not-approved-skill" });
  await assert.rejects(() => action.publishSkillProposal(proposalId, fakeClient(), "test"), {
    message: "Approve the Skill before publishing it.",
  });
  assert.equal(store.getSkillProposal(proposalId)!.lovable_state, "not_created");
});

test("publishSkillProposal: refuses a proposal already in Lovable", async () => {
  const { proposalId } = seedProposal({ name: "already-there-skill", status: "approved" });
  store.setSkillProposalLovableState({
    id: proposalId,
    lovable_state: "created",
    actor: "test",
    reason: "test setup",
  });
  await assert.rejects(() => action.publishSkillProposal(proposalId, fakeClient(), "test"), {
    message: "This Skill is already in Lovable.",
  });
  assert.equal(
    store.getSkillProposal(proposalId)!.lovable_state,
    "created",
    "unchanged by the refusal",
  );
});

test("publishSkillProposal: refuses when the stored name does not already normalise to itself", async () => {
  const { proposalId } = seedProposal({ name: "Not Kebab Case", status: "approved" });
  await assert.rejects(
    () => action.publishSkillProposal(proposalId, fakeClient(), "test"),
    /Rename this proposal to "not-kebab-case" with Edit before publishing/,
  );
  assert.equal(store.getSkillProposal(proposalId)!.lovable_state, "not_created");
});

test("publishSkillProposal: refuses when the workspace cannot be resolved, and records it as failed", async () => {
  const { proposalId } = seedProposal({ name: "no-workspace-skill", status: "approved" });
  await assert.rejects(
    () => action.publishSkillProposal(proposalId, fakeClient({ workspaces: [] }), "test"),
    { message: "Could not determine your Lovable workspace." },
  );
  const row = store.getSkillProposal(proposalId)!;
  assert.equal(row.lovable_state, "failed");
  assert.equal(row.lovable_error, "Could not determine your Lovable workspace.");
});

test("publishSkillProposal: refuses when a Skill of that name already exists in the workspace -- Harness Ledger creates, it never overwrites", async () => {
  const { proposalId } = seedProposal({ name: "name-conflict-skill", status: "approved" });
  store.recordSkillSnapshot({
    workspace_id: WORKSPACE,
    name: "name-conflict-skill",
    description: null,
    content: "existing content",
    updated_at_remote: null,
    fetched_by: "test",
  });
  await assert.rejects(() => action.publishSkillProposal(proposalId, fakeClient(), "test"), {
    message:
      "A Skill named name-conflict-skill already exists in your workspace. Rename the proposal first.",
  });
  assert.equal(store.getSkillProposal(proposalId)!.lovable_state, "failed");
});

// ------------------------------------------------------------------ success

test("publishSkillProposal: success -- creates with the composed markdown, records readback_ok true, a revision, a snapshot and an event", async () => {
  const content = "# Success skill\n\nDo it.\n";
  const { candidateId, proposalId } = seedProposal({
    name: "success-skill",
    content,
    status: "approved",
  });
  const composed = publish.composeSkillMarkdown("success-skill", content);
  const client = fakeClient({
    readback: { name: "success-skill", description: "Success skill", content: composed },
  });
  const revisionsBefore = store.listSkillProposalRevisions(proposalId).length;

  const improvement = await action.publishSkillProposal(proposalId, client, "test-actor");

  assert.equal(client.createCalls.length, 1);
  assert.deepEqual(client.createCalls[0], {
    workspaceId: WORKSPACE,
    skillName: "success-skill",
    markdown: composed,
  });
  assert.equal(client.closed, false, "publishSkillProposal never closes a client it did not open");

  const row = store.getSkillProposal(proposalId)!;
  assert.equal(row.lovable_state, "created");
  assert.equal(row.lovable_readback_ok, 1);
  assert.ok(row.lovable_written_at);
  assert.equal(row.lovable_error, null);

  assert.equal(
    store.listSkillProposalRevisions(proposalId).length,
    revisionsBefore + 1,
    "publishing records a revision",
  );

  const snapshot = store.latestSkillSnapshots(WORKSPACE).find((s) => s.name === "success-skill");
  assert.ok(snapshot, "a skill snapshot was recorded, same write the sync path uses");
  assert.equal(snapshot!.content, composed);

  const event = db
    .prepare(
      `SELECT * FROM events WHERE kind = 'skill_proposal.lovable_state_changed' ORDER BY id DESC LIMIT 1`,
    )
    .get() as { payload: string };
  const payload = JSON.parse(event.payload) as { id: number; lovable_state: string };
  assert.equal(payload.id, proposalId);
  assert.equal(payload.lovable_state, "created");

  assert.equal(improvement.id, candidateId);
  assert.equal(improvement.skill_proposal?.lovable_state, "created");
  assert.equal(improvement.skill_proposal?.lovable_readback_ok, true);
});

test("publishSkillProposal: a read-back that doesn't match the sent markdown is recorded as created with readback_ok false, not a failure", async () => {
  const { proposalId } = seedProposal({ name: "mismatch-skill", status: "approved" });
  const client = fakeClient({
    readback: { name: "mismatch-skill", description: null, content: "totally different content" },
  });

  await action.publishSkillProposal(proposalId, client, "test");

  const row = store.getSkillProposal(proposalId)!;
  assert.equal(row.lovable_state, "created");
  assert.equal(row.lovable_readback_ok, 0);
  assert.equal(row.lovable_error, null);
});

// ------------------------------------------------------------------ failure

test("publishSkillProposal: the client throwing marks the proposal failed with a redacted error, and rethrows the redacted message", async () => {
  const { proposalId } = seedProposal({ name: "failing-skill", status: "approved" });
  const client = fakeClient();
  client.createThrows = new Error(
    "Lovable API error: 500, token lov_abcdefghij1234567890 rejected",
  );

  await assert.rejects(action.publishSkillProposal(proposalId, client, "test"), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.ok(
      !err.message.includes("lov_abcdefghij1234567890"),
      "the rethrown error must never carry the raw token",
    );
    assert.match(err.message, /\[redacted:key\]/);
    return true;
  });

  const row = store.getSkillProposal(proposalId)!;
  assert.equal(row.lovable_state, "failed");
  assert.ok(row.lovable_error);
  assert.ok(!row.lovable_error!.includes("lov_abcdefghij1234567890"));
  assert.match(row.lovable_error!, /\[redacted:key\]/);
});

// ------------------------------------------------------ action / dispatch

test("isPublishSkillProposalAction recognizes only the publish_skill_proposal shape", () => {
  assert.equal(
    action.isPublishSkillProposalAction({ action: "publish_skill_proposal", proposal_id: 1 }),
    true,
  );
  assert.equal(
    action.isPublishSkillProposalAction({ action: "approve_skill_proposal", proposal_id: 1 }),
    false,
  );
  assert.equal(action.isPublishSkillProposalAction(null), false);
  assert.equal(action.isPublishSkillProposalAction("publish_skill_proposal"), false);
});

test("publishSkillProposalAction refuses immediately when not connected, without ever recording a failure", async () => {
  const { proposalId } = seedProposal({ name: "not-connected-skill", status: "approved" });
  await assert.rejects(
    () =>
      action.publishSkillProposalAction(
        { action: "publish_skill_proposal", proposal_id: proposalId },
        "test",
      ),
    { message: "Harness Ledger is not connected — connect on the Projects page." },
  );
  assert.equal(
    store.getSkillProposal(proposalId)!.lovable_state,
    "not_created",
    "never attempted, so never marked failed",
  );
});

test("beats.improvementActionAndWrite intercepts publish_skill_proposal before peekActionKind, refusing exactly the way publishSkillProposalAction itself does", async () => {
  const { proposalId } = seedProposal({ name: "beats-dispatch-skill", status: "approved" });
  await assert.rejects(
    () =>
      beats.improvementActionAndWrite({
        action: "publish_skill_proposal",
        proposal_id: proposalId,
      }),
    { message: "Harness Ledger is not connected — connect on the Projects page." },
  );
});

// --------------------------------------------------------------------- Inbox

test("a Skill proposal whose last publish attempt failed appears in the Inbox as action_failed, and never once it's created", async () => {
  const { proposalId } = seedProposal({ name: "inbox-failed-skill", status: "approved" });
  const client = fakeClient();
  client.createThrows = new Error("boom, plainly");
  await assert.rejects(action.publishSkillProposal(proposalId, client, "test"));

  const items = imp.listInboxItems({ connected: false });
  const item = items.find((i) => i.id === `skill:${proposalId}`);
  assert.ok(item, "the failed publish appears in the Inbox");
  assert.equal(item!.type, "action_failed");
  assert.equal(item!.title, "inbox-failed-skill");
  assert.equal(item!.summary, "boom, plainly");
  assert.equal(item!.recommended_action, "retry");
  assert.deepEqual(item!.link, { page: "skills" });

  // Retry it successfully -- the item must then disappear (lovable_state
  // 'created' is never surfaced here).
  const proposalContent = store.getSkillProposal(proposalId)!.content;
  const composed = publish.composeSkillMarkdown("inbox-failed-skill", proposalContent);
  const client2 = fakeClient({
    readback: { name: "inbox-failed-skill", description: null, content: composed },
  });
  await action.publishSkillProposal(proposalId, client2, "test");

  const itemsAfter = imp.listInboxItems({ connected: false });
  assert.ok(
    !itemsAfter.some((i) => i.id === `skill:${proposalId}`),
    "a created proposal is never an Inbox item",
  );
});

// ------------------------------------------------------------ automatic loop

test("structural: beats.ts's automatic sync loop (runAll) never calls publish_skill_proposal on its own", () => {
  const source = readFileSync(new URL("../src/executor/beats.ts", import.meta.url), "utf8");
  const marker = "export async function runAll(";
  const start = source.indexOf(marker);
  assert.ok(start >= 0, "runAll should exist in beats.ts");
  // The next top-level `export` after runAll's own declaration is guaranteed
  // to start only once runAll's body has closed (a function body cannot
  // itself contain a top-level `export` keyword), so this slice is exactly
  // runAll's own source regardless of what comment or code follows it.
  const nextExportIdx = source.indexOf("\nexport ", start + marker.length);
  const body = nextExportIdx === -1 ? source.slice(start) : source.slice(start, nextExportIdx);
  assert.ok(
    !/publishSkillProposal/.test(body),
    "the automatic sync loop must never call publish_skill_proposal on its own",
  );
});

// --------------------------------------------------------- structural: UX copy

test("structural: harness-ux.ts exposes the exact Publish/status copy, and both surfaces render it", () => {
  assert.equal(ux.PUBLISH_SKILL_LABEL, "Publish to Lovable");
  assert.equal(ux.skillPublishFailedLine("boom"), "Publish failed: boom");
  assert.match(
    ux.skillLovableStatusLine({
      lovable_state: "created",
      lovable_written_at: "2026-09-19T10:00:00.000Z",
      lovable_readback_ok: true,
      lovable_error: null,
    })!,
    /^In Lovable since .* · read back$/,
  );
  assert.match(
    ux.skillLovableStatusLine({
      lovable_state: "created",
      lovable_written_at: "2026-09-19T10:00:00.000Z",
      lovable_readback_ok: false,
      lovable_error: null,
    })!,
    /read-back differs$/,
  );

  const detail = readFileSync(
    new URL("../../src/components/harness/improvement.tsx", import.meta.url),
    "utf8",
  );
  assert.match(detail, /PUBLISH_SKILL_LABEL/);
  assert.match(detail, /action: "publish_skill_proposal"/);

  const skillsPage = readFileSync(
    new URL("../../src/routes/_authenticated/skills.tsx", import.meta.url),
    "utf8",
  );
  assert.match(skillsPage, /PUBLISH_SKILL_LABEL/);
  assert.match(skillsPage, /action: "publish_skill_proposal"/);
});
