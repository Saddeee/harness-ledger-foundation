import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "harness-executor-test-"));
process.env.HARNESS_DB_PATH = join(tmp, "harness.db");
// Keep the auth file out of the real data directory: nothing here connects.
process.env.HARNESS_AUTH_PATH = join(tmp, "lovable-auth.json");

const { db } = await import("../src/db.js");
const store = await import("../src/store.js");
const imp = await import("../src/improvements.js");
const beats = await import("../src/executor/beats.js");
const schedule = await import("../src/executor/schedule.js");
const lock = await import("../src/executor/lock.js");
const { sha256, HARNESS_START, HARNESS_END, MANAGED_HEADING } = await import("../src/knowledge.js");
import type { LovableClient, LovableMessage } from "../src/executor/lovable-mcp.ts";

const PROJECT = "exec-project";
const WORKSPACE = "exec-workspace";

store.allowProject(PROJECT, "Executor test project");

// ------------------------------------------------------------------ fake

type Page = { messages: LovableMessage[]; next_cursor: string | null; has_more: boolean };

function msg(id: string, role: "user" | "assistant", content: string): LovableMessage {
  return {
    message_id: id,
    role,
    status: "complete",
    created_at: `2026-09-0${id.slice(1)}T10:00:00.000Z`,
    edit_id: `edit-${id}`,
    content,
  };
}

class FakeLovable implements LovableClient {
  pages: Record<string, Page[]> = {};
  projectKnowledge: Record<string, string> = {};
  workspaceKnowledge = "";
  skills: { name: string; description: string | null; content: string; updated_at: string | null }[] = [];
  setCalls: { kind: "project" | "workspace"; id: string; content: string }[] = [];
  setProjectThrows: string | null = null;
  closed = false;

  async getMe() {
    return {
      id: "user-1",
      email: "owner@example.com",
      name: "Owner",
      workspaces: [{ id: WORKSPACE, name: "Workspace" }],
    };
  }
  async listProjects() {
    return [{ id: PROJECT, name: "Executor test project" }];
  }
  async listMessages(projectId: string, cursor?: string): Promise<Page> {
    const pages = this.pages[projectId] ?? [];
    const index = cursor ? Number(cursor) : 0;
    return pages[index] ?? { messages: [], next_cursor: null, has_more: false };
  }
  async getProjectKnowledge(projectId: string) {
    return this.projectKnowledge[projectId] ?? "";
  }
  async getWorkspaceKnowledge() {
    return this.workspaceKnowledge;
  }
  skillsComplete = true;
  async listWorkspaceSkills() {
    return { skills: this.skills, complete: this.skillsComplete };
  }
  async setProjectKnowledge(projectId: string, content: string) {
    if (this.setProjectThrows) throw new Error(this.setProjectThrows);
    this.setCalls.push({ kind: "project", id: projectId, content });
    this.projectKnowledge[projectId] = content;
  }
  async setWorkspaceKnowledge(workspaceId: string, content: string) {
    this.setCalls.push({ kind: "workspace", id: workspaceId, content });
    this.workspaceKnowledge = content;
  }
  async close() {
    this.closed = true;
  }
}

function twoPages(): Page[] {
  return [
    {
      messages: [msg("m5", "user", "five"), msg("m4", "assistant", "four"), msg("m3", "user", "three")],
      next_cursor: "1",
      has_more: true,
    },
    { messages: [msg("m2", "user", "two"), msg("m1", "user", "one")], next_cursor: null, has_more: false },
  ];
}

function historyIds(): string[] {
  return (
    db
      .prepare(`SELECT external_id FROM history_items WHERE project_id = ? ORDER BY id`)
      .all(PROJECT) as { external_id: string }[]
  ).map((r) => r.external_id);
}

// ------------------------------------------------------------------ sync

test("syncHistory stops at the first page containing a known message id", async () => {
  store.upsertHistoryItem({
    project_id: PROJECT,
    kind: "message",
    external_id: "m3",
    role: "user",
    content: "three",
    provenance: "lovable_mcp",
  });

  const fake = new FakeLovable();
  fake.pages[PROJECT] = twoPages();

  const first = await beats.syncHistory(fake);
  assert.equal(first.messages, 2, "inserts only the two unknown messages on the known page");
  assert.deepEqual(historyIds().sort(), ["m3", "m4", "m5"]);

  const second = await beats.syncHistory(fake);
  assert.equal(second.messages, 0, "a second run inserts nothing");
  assert.deepEqual(historyIds().sort(), ["m3", "m4", "m5"]);
});

test("syncHistory redacts secrets in message content and backfills the project workspace id", async () => {
  const fake = new FakeLovable();
  fake.pages[PROJECT] = [
    {
      messages: [msg("m9", "assistant", "use sk-abcdefghij1234567890 to call it")],
      next_cursor: null,
      has_more: false,
    },
  ];
  await beats.syncHistory(fake);
  const row = db
    .prepare(`SELECT content, role, source_ref, occurred_at FROM history_items WHERE external_id = 'm9'`)
    .get() as { content: string; role: string; source_ref: string; occurred_at: string };
  assert.equal(row.content, "use [redacted:key] to call it");
  assert.equal(row.role, "assistant");
  assert.equal(row.source_ref, "edit-m9");
  assert.equal(store.getProjectMeta(PROJECT)?.workspace_id, WORKSPACE);
});

test("syncHistory parks a cursor when the page budget runs out and resumes it next pass", async () => {
  const BIG = "exec-big-project";
  store.allowProject(BIG, "Paging test project");
  const fake = new FakeLovable();
  fake.pages[BIG] = [
    { messages: [msg("p9", "user", "nine")], next_cursor: "1", has_more: true },
    { messages: [msg("p8", "user", "eight")], next_cursor: "2", has_more: true },
    { messages: [msg("p7", "user", "seven")], next_cursor: null, has_more: false },
  ];

  const first = await beats.syncHistory(fake, { maxPages: 2 });
  assert.equal(first.truncated, 1);
  assert.equal(store.getSyncCursor(BIG), "2", "the unread cursor is parked, not dropped");
  const afterFirst = db
    .prepare(`SELECT external_id FROM history_items WHERE project_id = ? ORDER BY id`)
    .all(BIG) as { external_id: string }[];
  assert.deepEqual(afterFirst.map((r) => r.external_id), ["p9", "p8"]);

  const second = await beats.syncHistory(fake, { maxPages: 2 });
  assert.equal(second.truncated, 0);
  assert.equal(store.getSyncCursor(BIG), null, "the cursor is cleared once history is read out");
  const afterSecond = db
    .prepare(`SELECT external_id FROM history_items WHERE project_id = ? ORDER BY id`)
    .all(BIG) as { external_id: string }[];
  assert.deepEqual(afterSecond.map((r) => r.external_id), ["p9", "p8", "p7"]);

  store.disallowProject(BIG);
});

// ------------------------------------------------------------- knowledge

test("snapshotKnowledge records once per distinct content", async () => {
  const fake = new FakeLovable();
  fake.projectKnowledge[PROJECT] = "project rules v1";
  fake.workspaceKnowledge = "workspace rules v1";

  const first = await beats.snapshotKnowledge(fake, WORKSPACE);
  assert.equal(first.snapshots, 2);

  const second = await beats.snapshotKnowledge(fake, WORKSPACE);
  assert.equal(second.snapshots, 0, "unchanged content is not re-snapshotted");

  fake.projectKnowledge[PROJECT] = "project rules v2";
  const third = await beats.snapshotKnowledge(fake, WORKSPACE);
  assert.equal(third.snapshots, 1);
  assert.equal(store.latestKnowledgeSnapshot("project", PROJECT)?.content, "project rules v2");
});

test("snapshotSkills records changed skills only", async () => {
  const fake = new FakeLovable();
  fake.skills = [
    { name: "review", description: "Review code", content: "# Review\n", updated_at: "2026-09-01T00:00:00Z" },
  ];
  assert.deepEqual(await beats.snapshotSkills(fake, WORKSPACE), { skills: 1, changed: 1 });
  assert.deepEqual(await beats.snapshotSkills(fake, WORKSPACE), { skills: 1, changed: 0 });
  fake.skills[0].content = "# Review v2\n";
  assert.deepEqual(await beats.snapshotSkills(fake, WORKSPACE), { skills: 1, changed: 1 });
  assert.equal(store.latestSkillSnapshots(WORKSPACE)[0].content, "# Review v2\n");
});

// ---------------------------------------------------------------- writes

function stagePending(previous: string, next: string) {
  return store.createPendingKnowledgeVersion({
    rule_id: null,
    target: "project",
    project_id: PROJECT,
    previous_content: previous,
    new_content: next,
    rule_ids: [],
    actor: "test",
  });
}

test("executeWrites writes, verifies the read-back and marks the version written", async () => {
  const fake = new FakeLovable();
  fake.projectKnowledge[PROJECT] = "live text";
  const v = stagePending("live text", "live text + rule");

  const counts = await beats.executeWrites(fake);
  assert.deepEqual(counts, {
    written: 1,
    stale: 0,
    failed: 0,
    skipped_auto_write: 0,
    skipped_demo: 0,
  });
  assert.deepEqual(fake.setCalls, [{ kind: "project", id: PROJECT, content: "live text + rule" }]);
  assert.equal(store.getKnowledgeVersion(v.id)?.status, "written");
});

test("executeWrites marks a version stale when live content drifted, without calling set", async () => {
  const fake = new FakeLovable();
  const v = stagePending("composed against this", "new text");
  fake.projectKnowledge[PROJECT] = "someone else edited it";

  const counts = await beats.executeWrites(fake);
  assert.deepEqual(counts, {
    written: 0,
    stale: 1,
    failed: 0,
    skipped_auto_write: 0,
    skipped_demo: 0,
  });
  assert.equal(fake.setCalls.length, 0);
  const row = store.getKnowledgeVersion(v.id)!;
  assert.equal(row.status, "stale");
  assert.match(row.error ?? "", /changed in Lovable/i);
  assert.notEqual(sha256(fake.projectKnowledge[PROJECT]), row.previous_sha256);
});

test("executeWrites marks a version failed when the Lovable write throws", async () => {
  const fake = new FakeLovable();
  fake.projectKnowledge[PROJECT] = "live text";
  fake.setProjectThrows = "lovable exploded";
  const v = stagePending("live text", "another rule");

  const counts = await beats.executeWrites(fake);
  assert.deepEqual(counts, {
    written: 0,
    stale: 0,
    failed: 1,
    skipped_auto_write: 0,
    skipped_demo: 0,
  });
  const row = store.getKnowledgeVersion(v.id)!;
  assert.equal(row.status, "failed");
  assert.match(row.error ?? "", /lovable exploded/);
});

test("executeWrites skips a pending project-target write when the project has auto_write off, workspace writes unaffected", async () => {
  store.setProjectSettings(PROJECT, { auto_write: false });
  const fake = new FakeLovable();
  fake.projectKnowledge[PROJECT] = "live text";
  fake.workspaceKnowledge = "live workspace text";
  const projectVersion = stagePending("live text", "project write while auto_write is off");
  const workspaceVersion = store.createPendingKnowledgeVersion({
    rule_id: null,
    target: "workspace",
    workspace_id: WORKSPACE,
    previous_content: "live workspace text",
    new_content: "workspace write is unaffected",
    rule_ids: [],
    actor: "test",
  });

  const counts = await beats.executeWrites(fake);
  assert.deepEqual(counts, {
    written: 1,
    stale: 0,
    failed: 0,
    skipped_auto_write: 1,
    skipped_demo: 0,
  });
  assert.equal(store.getKnowledgeVersion(projectVersion.id)?.status, "pending", "left pending, not touched at all");
  assert.equal(store.getKnowledgeVersion(workspaceVersion.id)?.status, "written");
  assert.deepEqual(fake.setCalls, [{ kind: "workspace", id: WORKSPACE, content: "workspace write is unaffected" }]);

  // Turning it back on lets the same pending write through on the next pass.
  store.setProjectSettings(PROJECT, { auto_write: true });
  const second = await beats.executeWrites(fake);
  assert.deepEqual(second, {
    written: 1,
    stale: 0,
    failed: 0,
    skipped_auto_write: 0,
    skipped_demo: 0,
  });
  assert.equal(store.getKnowledgeVersion(projectVersion.id)?.status, "written");
});

// ---- Round 6 Task 5: demo isolation (spec §5 / spec §0's incident) ----

test("executeWrites skips a pending write whose own rule is a demo rule, and counts it under skipped_demo", async () => {
  const fake = new FakeLovable();
  fake.projectKnowledge[PROJECT] = "live text";
  const demoRule = makeRule("Demo: always do something.", "demo");
  const v = store.createPendingKnowledgeVersion({
    rule_id: demoRule.id,
    target: "project",
    project_id: PROJECT,
    previous_content: "live text",
    new_content: "live text + demo rule",
    rule_ids: [demoRule.id],
    actor: "test",
  });

  const counts = await beats.executeWrites(fake);
  assert.deepEqual(counts, {
    written: 0,
    stale: 0,
    failed: 0,
    skipped_auto_write: 0,
    skipped_demo: 1,
  });
  assert.equal(fake.setCalls.length, 0, "a demo rule's write must never reach Lovable");
  assert.equal(
    store.getKnowledgeVersion(v.id)?.status,
    "pending",
    "left exactly as staged, same as a skipped_auto_write row",
  );
  // Left pending on purpose above (that's the behavior under test) -- cancel
  // it now so it doesn't count against a later test's own executeWrites
  // counts in this shared-DB file.
  store.markKnowledgeWriteCancelled(v.id, "test cleanup");
});

test("executeWrites skips a target-level recompose (rule_id: null) whose rule_ids_json names a demo rule -- the exact residue shape spec §0 found", async () => {
  const fake = new FakeLovable();
  fake.projectKnowledge[PROJECT] = "live text";
  const demoRule = makeRule("Demo: always do the other thing.", "demo");
  const v = store.createPendingKnowledgeVersion({
    rule_id: null,
    target: "project",
    project_id: PROJECT,
    previous_content: "live text",
    new_content: "live text + demo rule (recompose)",
    rule_ids: [demoRule.id],
    actor: "test",
  });

  const counts = await beats.executeWrites(fake);
  assert.deepEqual(counts, {
    written: 0,
    stale: 0,
    failed: 0,
    skipped_auto_write: 0,
    skipped_demo: 1,
  });
  assert.equal(fake.setCalls.length, 0);
  assert.equal(store.getKnowledgeVersion(v.id)?.status, "pending");
  store.markKnowledgeWriteCancelled(v.id, "test cleanup");
});

test("executeVersionNow refuses a demo-rule version instead of writing it, defense in depth even if one were ever staged", async () => {
  const fake = new FakeLovable();
  fake.projectKnowledge[PROJECT] = "live text";
  const demoRule = makeRule("Demo: never write this to Lovable.", "demo");
  const v = store.createPendingKnowledgeVersion({
    rule_id: demoRule.id,
    target: "project",
    project_id: PROJECT,
    previous_content: "live text",
    new_content: "live text + demo rule",
    rule_ids: [demoRule.id],
    actor: "test",
  });

  const outcome = await beats.executeVersionNow(v.id, fake);
  assert.equal(outcome.written, false);
  assert.ok(!outcome.written && outcome.kind === "demo");
  assert.equal(fake.setCalls.length, 0);
  assert.equal(store.getKnowledgeVersion(v.id)?.status, "cancelled");
});

// -------------------------------------------------------------- schedule

const DEFAULTS = schedule.scheduleFromSettings(store.getSettings());

test("scheduleFromSettings reads the settings table defaults", () => {
  assert.deepEqual(DEFAULTS, {
    enabled: true,
    intervalMinutes: 60,
    windowStartHour: 10,
    windowEndHour: 22,
  });
});

test("shouldRunAt honours enabled, the daily window and the interval", () => {
  const at = (h: number, m = 0) => new Date(2026, 8, 11, h, m, 0, 0);
  assert.equal(schedule.shouldRunAt(at(11), null, { ...DEFAULTS, enabled: false }), false);
  assert.equal(schedule.shouldRunAt(at(9, 59), null, DEFAULTS), false);
  assert.equal(schedule.shouldRunAt(at(10), null, DEFAULTS), true);
  assert.equal(schedule.shouldRunAt(at(10, 30), at(10), DEFAULTS), false);
  assert.equal(schedule.shouldRunAt(at(11), at(10), DEFAULTS), true);
  assert.equal(schedule.shouldRunAt(at(22), at(10), DEFAULTS), false);
});

test("nextRunAt walks forward to the next in-window minute, and is null when disabled", () => {
  const at = (h: number, m = 0) => new Date(2026, 8, 11, h, m, 0, 0);
  assert.equal(schedule.nextRunAt(at(23), null, { ...DEFAULTS, enabled: false }), null);
  const next = schedule.nextRunAt(at(23), at(21), DEFAULTS)!;
  assert.equal(next.getDate(), 12);
  assert.equal(next.getHours(), 10);
  assert.equal(next.getMinutes(), 0);
  // Already runnable: the answer is now.
  assert.equal(schedule.nextRunAt(at(11), at(10), DEFAULTS)!.getTime(), at(11).getTime());
});

test("nextRunAt rejects an overnight window rather than returning null", () => {
  const now = new Date(2026, 8, 11, 11, 0, 0, 0);
  assert.throws(
    () => schedule.nextRunAt(now, null, { ...DEFAULTS, windowStartHour: 22, windowEndHour: 10 }),
    /start must be before end/,
  );
});

test("runOnce refuses to start while another run is in flight", async () => {
  // A token file only so status().connected is true: the single-run guard must
  // be what stops this, and no Lovable client is ever opened.
  writeFileSync(
    process.env.HARNESS_AUTH_PATH!,
    JSON.stringify({ tokens: { access_token: "not-a-real-token", token_type: "bearer" } }),
  );
  const inFlight = store.startSyncRun("scheduled");
  try {
    const result = await schedule.runOnce();
    assert.deepEqual(result, { ok: true, ran: false, error: "already running" });
  } finally {
    store.finishSyncRun(inFlight, { ok: true });
    rmSync(process.env.HARNESS_AUTH_PATH!, { force: true });
  }
});

// ----------------------------------------------------------------- runAll

test("runAll completes the open sync request, records counts and finishes the run", async () => {
  const requested = store.requestSync();
  const fake = new FakeLovable();
  fake.pages[PROJECT] = [{ messages: [msg("m7", "user", "seven")], next_cursor: null, has_more: false }];
  fake.projectKnowledge[PROJECT] = "runAll knowledge";

  const result = await beats.runAll(fake, "manual");
  assert.equal(result.ok, true);
  assert.equal(typeof result.runId, "number");
  assert.equal(result.counts.messages, 1);

  const row = db.prepare(`SELECT status, run_id FROM sync_requests WHERE id = ?`).get(requested.id) as {
    status: string;
    run_id: number;
  };
  assert.equal(row.status, "done");
  assert.equal(row.run_id, result.runId);

  const last = store.latestSyncRun()!;
  assert.equal(last.id, result.runId);
  assert.equal(last.ok, 1);
  assert.ok(last.finished_at);
  assert.equal(store.runningSyncRun(), null);
});

test("runAll captures a beat failure into the run instead of throwing", async () => {
  const fake = new FakeLovable();
  fake.listMessages = async () => {
    throw new Error("network down");
  };
  const result = await beats.runAll(fake, "once");
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /network down/);
  const last = store.latestSyncRun()!;
  assert.equal(last.ok, 0);
  assert.ok(last.finished_at, "a failed run is still finished");
});

// ------------------------------------------------------ Round 6 Task 2 ----
// executeVersionNow: the app-request-driven single-version write. Extends
// this file's own FakeLovable rather than adding a second fake.

function managedBlock(rules: string[]): string {
  const lines = rules.map((r) => `- ${r}`).join("\n");
  return `${HARNESS_START}\n${MANAGED_HEADING}\n${lines}\n${HARNESS_END}`;
}

// A real rule row (not just a bare knowledge_version) so executeVersionNow's
// recompose path has something real to look up via store.getRule(id) --
// mirrors harness/test/adapter.test.ts's own minimal evidence -> episode ->
// correction -> learning -> rule chain.
let ruleCounter = 0;
// Round 6 Task 5: createdBy defaults to "test" (every existing call site is
// unaffected) -- pass "demo" to get a rule executeWrites/executeVersionNow
// must skip (spec §5).
// Fix round 1: `project` defaults to the shared PROJECT const (every
// existing call site unaffected) -- pass a fresh, never-snapshotted
// project id for a test that needs "no snapshot recorded yet" to be true.
function makeRule(
  instruction: string,
  createdBy: string = "test",
  project: string = PROJECT,
): { id: number; instruction: string; correctionId: number } {
  ruleCounter += 1;
  const evidence = store.upsertHistoryItem({
    project_id: project,
    kind: "message",
    external_id: `execversion-evidence-${ruleCounter}`,
    role: "user",
    content: "evidence",
    provenance: "lovable_mcp",
  }) as { id: number };
  const episode = store.createTaskEpisode({
    project_id: project,
    title: "executeVersionNow test episode",
    provenance: "llm_derived",
    evidence_history_item_ids: [evidence.id],
  }) as { id: number };
  const correction = store.createCorrectionCandidate({
    task_episode_id: episode.id,
    classification: "other",
    is_correction: true,
    summary: "test",
    evidence_history_item_ids: [evidence.id],
  }) as { id: number };
  const learning = store.createLearning({
    correction_candidate_id: correction.id,
    observed_problem: "p",
    desired_behavior: "d",
    reuse_rationale: "r",
    proposed_scope: "project",
    provenance: "llm_derived",
    created_by: createdBy,
  }) as { id: number };
  const rule = store.createRule({
    learning_id: learning.id,
    correction_candidate_id: correction.id,
    instruction,
    scope: "project",
    applies_when: "always",
    predicted_failure: "n/a",
    ownership: "harness",
    created_by: createdBy,
  }) as { id: number };
  return { id: rule.id, instruction, correctionId: correction.id };
}

test("executeVersionNow: base unchanged -- writes, verifies the read-back, reports written", async () => {
  const fake = new FakeLovable();
  fake.projectKnowledge[PROJECT] = "live text";
  const v = stagePending("live text", "live text + rule");

  const outcome = await beats.executeVersionNow(v.id, fake);
  assert.equal(outcome.written, true);
  assert.ok(outcome.written && outcome.version_id === v.id && outcome.at);
  assert.equal(store.getKnowledgeVersion(v.id)?.status, "written");
  assert.deepEqual(fake.setCalls, [{ kind: "project", id: PROJECT, content: "live text + rule" }]);
});

test("executeVersionNow: base changed only outside the managed block -- recomposes on the fresh base and still writes", async () => {
  const rule = makeRule("Always write tests before committing.");
  const block = managedBlock([rule.instruction]);
  const previousContent = `Old surrounding text.\n\n${block}`;
  const liveContent = `New surrounding text, added directly in Lovable.\n\n${block}`;

  const fake = new FakeLovable();
  fake.projectKnowledge[PROJECT] = liveContent;

  const v = store.createPendingKnowledgeVersion({
    rule_id: rule.id,
    target: "project",
    project_id: PROJECT,
    previous_content: previousContent,
    // Deliberately stale/wrong -- composed against the OLD base -- so a pass
    // that just replayed this verbatim would prove nothing about recompose.
    new_content: `${previousContent}\n(stale composed text nobody should write)`,
    rule_ids: [rule.id],
    actor: "test",
  });

  const outcome = await beats.executeVersionNow(v.id, fake);
  assert.equal(outcome.written, true);
  const written = fake.setCalls[0]!.content;
  assert.ok(written.includes("New surrounding text, added directly in Lovable."));
  assert.ok(written.includes(rule.instruction));
  assert.ok(!written.includes("Old surrounding text."));
  assert.ok(!written.includes("stale composed text"));
  assert.equal(store.getKnowledgeVersion(v.id)?.status, "written");
});

test("executeVersionNow: base changed AND the managed block itself was edited in Lovable by a human -- stale, never writes", async () => {
  const rule = makeRule("Always write tests before committing.");
  // Registered active so the "is this a concurrent Harness write?" check
  // (fix round 1 item 2) has a real known-rule set to compare against --
  // the point of this test is that the EXTRA line matches none of it.
  store.updateRule({ id: rule.id, state: "active", actor: "test" });
  const previousContent = `Some text.\n\n${managedBlock([rule.instruction])}`;
  // Someone typed directly inside the Harness-managed block in Lovable --
  // this extra line is not one of Harness's own active rules.
  const tamperedBlock = managedBlock([
    rule.instruction,
    "Someone typed this directly into Lovable.",
  ]);
  const liveContent = `Some text.\n\n${tamperedBlock}`;

  const fake = new FakeLovable();
  fake.projectKnowledge[PROJECT] = liveContent;

  const v = store.createPendingKnowledgeVersion({
    rule_id: rule.id,
    target: "project",
    project_id: PROJECT,
    previous_content: previousContent,
    new_content: previousContent,
    rule_ids: [rule.id],
    actor: "test",
  });

  const outcome = await beats.executeVersionNow(v.id, fake);
  assert.equal(outcome.written, false);
  assert.ok(!outcome.written && outcome.kind === "stale");
  assert.ok(!outcome.written && /edited the Harness Ledger block/i.test(outcome.reason));
  assert.equal(fake.setCalls.length, 0, "never writes when the managed block itself drifted");
  assert.equal(store.getKnowledgeVersion(v.id)?.status, "stale");
});

// ---- fix round 1 ----

test("executeVersionNow: a write that already landed (an earlier read-back mismatch was spurious) is recognized as written, never re-staled", async () => {
  const rule = makeRule("Always land correctly.");
  const previousContent = "Some text.";
  const block = managedBlock([rule.instruction]);
  const intendedContent = `${previousContent}\n\n${block}`;

  const fake = new FakeLovable();
  // The live content already IS exactly what this version intended to
  // write -- e.g. an earlier attempt's write actually landed, but that
  // attempt's own read-back comparison mismatched for an unrelated reason
  // (a transient read, or a network blip right after the write).
  fake.projectKnowledge[PROJECT] = intendedContent;

  const v = store.createPendingKnowledgeVersion({
    rule_id: rule.id,
    target: "project",
    project_id: PROJECT,
    previous_content: previousContent,
    new_content: intendedContent,
    rule_ids: [rule.id],
    actor: "test",
  });
  store.markKnowledgeWriteFailed(v.id, "read-back hash mismatch (simulated)");

  const outcome = await beats.executeVersionNow(v.id, fake);
  assert.equal(outcome.written, true);
  assert.equal(fake.setCalls.length, 0, "never re-writes what's already there");
  assert.equal(store.getKnowledgeVersion(v.id)?.status, "written");
});

test("executeVersionNow: the block drifted to a rule set Harness Ledger recognizes as its own (a concurrent Harness Ledger write) -- recomposes on the union and writes", async () => {
  const rule1 = makeRule("Always do A.");
  const rule2 = makeRule("Always do B.");
  store.updateRule({ id: rule1.id, state: "active", actor: "test" });
  store.updateRule({ id: rule2.id, state: "active", actor: "test" });

  const previousContent = `Some text.\n\n${managedBlock([rule1.instruction])}`;
  // Another Harness pass wrote rule2 into the block in between -- every
  // live line is still one of Harness's own known active rules.
  const liveContent = `Some text.\n\n${managedBlock([rule1.instruction, rule2.instruction])}`;

  const fake = new FakeLovable();
  fake.projectKnowledge[PROJECT] = liveContent;

  const v = store.createPendingKnowledgeVersion({
    rule_id: rule1.id,
    target: "project",
    project_id: PROJECT,
    previous_content: previousContent,
    new_content: previousContent,
    rule_ids: [rule1.id],
    actor: "test",
  });

  const outcome = await beats.executeVersionNow(v.id, fake);
  assert.equal(outcome.written, true);
  const written = fake.setCalls[0]!.content;
  assert.ok(written.includes(rule1.instruction));
  assert.ok(written.includes(rule2.instruction), "the union keeps the concurrently-added rule");
  assert.equal(store.getKnowledgeVersion(v.id)?.status, "written");
});

test("executeVersionNow: a union recompose that would exceed the project's rule cap is rejected, not written", async () => {
  const rule1 = makeRule("Always do C.");
  const rule2 = makeRule("Always do D.");
  store.updateRule({ id: rule1.id, state: "active", actor: "test" });
  store.updateRule({ id: rule2.id, state: "active", actor: "test" });
  store.setProjectSettings(PROJECT, { max_active_rules: 1 });

  try {
    const previousContent = `Some text.\n\n${managedBlock([rule1.instruction])}`;
    const liveContent = `Some text.\n\n${managedBlock([rule1.instruction, rule2.instruction])}`;
    const fake = new FakeLovable();
    fake.projectKnowledge[PROJECT] = liveContent;
    const v = store.createPendingKnowledgeVersion({
      rule_id: rule1.id,
      target: "project",
      project_id: PROJECT,
      previous_content: previousContent,
      new_content: previousContent,
      rule_ids: [rule1.id],
      actor: "test",
    });

    const outcome = await beats.executeVersionNow(v.id, fake);
    assert.equal(outcome.written, false);
    assert.ok(!outcome.written && outcome.kind === "rejected");
    assert.ok(!outcome.written && /already has \d+ active rules/.test(outcome.reason));
    assert.equal(fake.setCalls.length, 0);
    assert.equal(store.getKnowledgeVersion(v.id)?.status, "failed");
  } finally {
    store.setProjectSettings(PROJECT, { max_active_rules: null });
  }
});

test("executeVersionNow: a request-scoped timeout returns a plain error instead of hanging on a stuck write", async () => {
  const fake = new FakeLovable();
  fake.projectKnowledge[PROJECT] = "live text";
  fake.setProjectKnowledge = () => new Promise<void>(() => {});
  const v = stagePending("live text", "live text + rule");

  const outcome = await beats.executeVersionNow(v.id, fake, { timeoutMs: 10 });
  assert.equal(outcome.written, false);
  assert.ok(!outcome.written && outcome.kind === "error");
  assert.ok(!outcome.written && /did not answer in time/i.test(outcome.reason));
  assert.equal(store.getKnowledgeVersion(v.id)?.status, "failed");
});
// ---- end fix round 1 ----

test("executeVersionNow: an unknown version id reports a plain error, never throws", async () => {
  const fake = new FakeLovable();
  const outcome = await beats.executeVersionNow(999999, fake);
  assert.equal(outcome.written, false);
  assert.ok(!outcome.written && outcome.kind === "error");
});

// ------------------------------------------------------------- syncNow ----

test("syncNow: refuses without opening a client when a sync is already running", async () => {
  const inFlight = store.startSyncRun("scheduled");
  try {
    const result = await beats.syncNow();
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /already running/i);
  } finally {
    store.finishSyncRun(inFlight, { ok: true });
  }
});

test("syncNow: reports not connected without touching the network", async () => {
  // No token file at this test's HARNESS_AUTH_PATH (the earlier runOnce test
  // cleans its own up) -- status().connected is false, so syncNow must
  // refuse before ever calling openLovableClient.
  const result = await beats.syncNow();
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /not connected/i);
});

// ---- fix round 1 item 3 ----

function withFakeConnection<T>(run: () => Promise<T>): Promise<T> {
  writeFileSync(
    process.env.HARNESS_AUTH_PATH!,
    JSON.stringify({ tokens: { access_token: "fake", token_type: "bearer" } }),
  );
  return run().finally(() => rmSync(process.env.HARNESS_AUTH_PATH!, { force: true }));
}

test("syncNow: two concurrent calls -- exactly one sync_runs row starts, the other is told a sync is already running", async () =>
  withFakeConnection(async () => {
    const fake = new FakeLovable();
    const openClient = async () => fake;

    const results = await Promise.all([beats.syncNow(openClient), beats.syncNow(openClient)]);
    const started = results.filter((r) => r.ok);
    const refused = results.filter((r) => !r.ok);
    assert.equal(started.length, 1, "exactly one of the two concurrent calls actually ran a sync");
    assert.equal(refused.length, 1);
    assert.match(refused[0]!.error ?? "", /already running/i);
  }));

test("syncNow: a request-scoped timeout returns ok:false with a plain error instead of hanging", async () =>
  withFakeConnection(async () => {
    const fake = new FakeLovable();
    fake.listMessages = () => new Promise<Page>(() => {});
    const result = await beats.syncNow(async () => fake, { timeoutMs: 10 });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /did not answer in time/i);
  }));
// ---- end fix round 1 item 3 ----

// -------------------------------------------------------- lock interplay --
//
// Round 6 fix wave item 5: lock.defaultLockPath() below is NOT
// harness/data/executor.lock in this file -- it's dirname(authFilePath())
// + "executor.lock", and this file's own top-of-file HARNESS_AUTH_PATH
// override (join(tmp, "lovable-auth.json"), a mkdtempSync'd dir) already
// redirects authFilePath() under the per-run temp dir. So every
// lock.defaultLockPath() call in this file already resolves under that
// temp dir, not the real data/ directory -- no separate temp-path switch
// needed here.

test("schedule.loop({once:true}) acquires the lock for its owner and releases it once the tick finishes", async () => {
  const lockPath = lock.defaultLockPath();
  await schedule.loop({ once: true, owner: "cli" });
  assert.equal(existsSync(lockPath), false, "the lock is released once the loop returns");
});

test("schedule.loop: refuses to run at all while the other owner holds the lock", async () => {
  const lockPath = lock.defaultLockPath();
  const held = lock.acquireLock(lockPath, "app");
  assert.equal(held.held, true);
  try {
    await schedule.loop({ once: true, owner: "cli" });
    const onDisk = JSON.parse(readFileSync(lockPath, "utf8")) as { owner: string; pid: number };
    assert.equal(onDisk.owner, "app", "the cli loop never touched a lock held by the app");
  } finally {
    lock.releaseLock(lockPath);
  }
});

test("schedule.loop: a stale lock left by a crashed holder can be taken over", async () => {
  const lockPath = lock.defaultLockPath();
  const staleHeartbeat = new Date(Date.now() - 4 * 60 * 1000).toISOString();
  writeFileSync(
    lockPath,
    JSON.stringify({ owner: "app", pid: 999999, heartbeat_at: staleHeartbeat }),
  );
  await schedule.loop({ once: true, owner: "cli" });
  assert.equal(
    existsSync(lockPath),
    false,
    "the lock taken over is released again once the tick finishes",
  );
});

// ------------------------------------------------- improvementActionAndWrite

test("improvementActionAndWrite: accept (not connected) reports write.kind 'not_connected', naming the version it staged", async () => {
  const rule = makeRule("Always do X.");
  store.recordKnowledgeSnapshot({
    target: "project",
    project_id: PROJECT,
    content: "Existing Knowledge.",
    fetched_by: "test",
  });

  const result = await beats.improvementActionAndWrite({
    action: "accept",
    id: rule.correctionId,
    destination: "project",
  });
  assert.equal(result.decision.status, "accepted");
  assert.ok(result.write, "accept (not test-first) always reports a write outcome");
  assert.equal(result.write!.written, false);
  assert.ok(!result.write!.written && result.write!.kind === "not_connected");
  assert.ok(!result.write!.written && /not connected/i.test(result.write!.reason));
  assert.ok(!result.write!.written && typeof result.write!.version_id === "number");

  const versions = store.listKnowledgeVersions(result.rule_id!);
  assert.equal(versions[0]!.status, "pending", "the write stays staged locally, never invented");
});

test("improvementActionAndWrite: accept with test_first never reports a write", async () => {
  const rule = makeRule("Always do Z.");
  const result = await beats.improvementActionAndWrite({
    action: "accept",
    id: rule.correctionId,
    destination: "project",
    test_first: true,
  });
  assert.equal(result.write, undefined);
});

test("improvementActionAndWrite: skip/reopen/verdict never carry a write field", async () => {
  const rule = makeRule("Always do Y.");
  const skipped = await beats.improvementActionAndWrite({ action: "skip", id: rule.correctionId });
  assert.equal(skipped.write, undefined);
  const reopened = await beats.improvementActionAndWrite({
    action: "reopen",
    id: rule.correctionId,
  });
  assert.equal(reopened.write, undefined);
});

test("improvementActionAndWrite: retire and readd (not connected) each report write.kind 'not_connected'", async () => {
  const rule = makeRule("Always do W.");
  store.recordKnowledgeSnapshot({
    target: "project",
    project_id: PROJECT,
    content: "Existing Knowledge.",
    fetched_by: "test",
  });
  store.updateRule({ id: rule.id, state: "active", actor: "test" });

  const retired = await beats.improvementActionAndWrite({ action: "retire", rule_id: rule.id });
  assert.ok(retired.write && !retired.write.written && retired.write.kind === "not_connected");

  const readded = await beats.improvementActionAndWrite({
    action: "readd",
    id: rule.correctionId,
  });
  assert.ok(readded.write && !readded.write.written && readded.write.kind === "not_connected");
});

test("improvementActionAndWrite: accept before any Knowledge snapshot exists reports write.kind 'no_snapshot', for real", async () =>
  withFakeConnection(async () => {
    // Fix round 1: a brand-new project (never PROJECT, which earlier tests
    // in this file already snapshotted) that has never had a snapshot
    // recorded, with a genuinely connected auth file -- so this actually
    // exercises the "connected, but nothing was staged to write" branch,
    // not the "not connected" branch it silently fell into before.
    const freshProject = "exec-project-no-snapshot";
    store.allowProject(freshProject, "No snapshot yet");
    const rule = makeRule("Always do V.", "test", freshProject);
    const result = await beats.improvementActionAndWrite({
      action: "accept",
      id: rule.correctionId,
      destination: "project",
    });
    assert.ok(result.write);
    assert.equal(result.write!.written, false);
    assert.ok(!result.write!.written && result.write!.kind === "no_snapshot");
    store.disallowProject(freshProject);
  }));

// ---- Round 6 Task 5 fix round 1 (B1) ----
test("improvementActionAndWrite: retiring a demo rule reports write.kind 'demo' (never 'no_snapshot'), even with a real Knowledge snapshot present; a real rule with genuinely no snapshot still reports 'no_snapshot'", async () =>
  withFakeConnection(async () => {
    // A real Knowledge snapshot DOES exist for PROJECT (recorded by an
    // earlier test in this file, and again here for robustness against
    // reordering) -- retiring a demo rule must report 'demo', not silently
    // fall into 'no_snapshot' just because retireRule staged nothing.
    store.recordKnowledgeSnapshot({
      target: "project",
      project_id: PROJECT,
      content: "Existing Knowledge.",
      fetched_by: "test",
    });
    const demoRule = makeRule("Demo: always do something.", "demo");
    store.updateRule({ id: demoRule.id, state: "active", actor: "demo" });

    const retiredDemo = await beats.improvementActionAndWrite({
      action: "retire",
      rule_id: demoRule.id,
    });
    assert.ok(retiredDemo.write, "retire always reports a write outcome");
    assert.equal(retiredDemo.write!.written, false);
    assert.ok(!retiredDemo.write!.written && retiredDemo.write!.kind === "demo");
    assert.ok(
      !retiredDemo.write!.written &&
        retiredDemo.write!.reason === "Demo data is never written to Lovable.",
    );
    assert.equal(retiredDemo.write!.version_id, null);

    // A real rule, in a fresh project with genuinely no snapshot at all,
    // still reports 'no_snapshot' -- the new demo check must not swallow
    // this case too.
    const freshProject = "exec-project-demo-vs-no-snapshot";
    store.allowProject(freshProject, "No snapshot, and not a demo rule");
    const realRule = makeRule("Always do a real thing.", "test", freshProject);
    const realResult = await beats.improvementActionAndWrite({
      action: "accept",
      id: realRule.correctionId,
      destination: "project",
    });
    assert.ok(realResult.write);
    assert.equal(realResult.write!.written, false);
    assert.ok(!realResult.write!.written && realResult.write!.kind === "no_snapshot");
    store.disallowProject(freshProject);
  }));
// ---- end Round 6 Task 5 fix round 1 (B1) ----

test("improvementActionAndWrite: retryKnowledgeWrite reports not connected for a real pending version", async () => {
  const v = stagePending("live text", "live text + rule");
  const write = await beats.retryKnowledgeWrite(v.id);
  assert.ok(!write.written && write.kind === "not_connected");
  // retryKnowledgeWrite never touches the version when refusing up front.
  assert.equal(store.getKnowledgeVersion(v.id)?.status, "pending");
});

test("lock.currentLockHolder: null when unheld or stale, the holder when fresh", () => {
  // Also resolves under this file's own temp dir -- see the "lock
  // interplay" section header above for why.
  const lockPath = lock.defaultLockPath();
  assert.equal(lock.currentLockHolder(lockPath), null);
  lock.acquireLock(lockPath, "app");
  assert.equal(lock.currentLockHolder(lockPath)?.owner, "app");
  lock.releaseLock(lockPath);
  assert.equal(lock.currentLockHolder(lockPath), null);

  const staleHeartbeat = new Date(Date.now() - 4 * 60 * 1000).toISOString();
  writeFileSync(
    lockPath,
    JSON.stringify({ owner: "cli", pid: 999999, heartbeat_at: staleHeartbeat }),
  );
  assert.equal(lock.currentLockHolder(lockPath), null, "a stale holder does not count as current");
});

test("toIdName: prefers Lovable's display_name, falls back to the slug, then the id", async () => {
  const { toIdName } = await import("../src/executor/lovable-mcp.js");
  assert.deepEqual(toIdName({ id: "p1", name: "harness-ledger-start", display_name: "Harness Ledger Foundation" }), {
    id: "p1",
    name: "Harness Ledger Foundation",
  });
  assert.deepEqual(toIdName({ id: "p2", display_name: "Frontier Forge" }), { id: "p2", name: "Frontier Forge" });
  assert.deepEqual(toIdName({ id: "p3", name: "slug-only" }), { id: "p3", name: "slug-only" });
  assert.deepEqual(toIdName({ id: "p4" }), { id: "p4", name: "p4" });
});

test("syncHistory names a newly allowed project after its Projects-page label, and never wipes an existing name", async () => {
  // A project allowed from the Projects page had a projects row with no
  // name, so every card showed its raw id instead of its name.
  const NEW_PROJECT = "proj-named-by-label";
  store.allowProject(NEW_PROJECT, "Quick Tip Calculator");
  const fake = new FakeLovable();
  fake.pages[NEW_PROJECT] = [{ messages: [], next_cursor: null, has_more: false }];
  await beats.syncHistory(fake);
  assert.equal(store.getProjectMeta(NEW_PROJECT)?.name, "Quick Tip Calculator");
  assert.equal(store.getProjectMeta(NEW_PROJECT)?.workspace_id, WORKSPACE);

  store.upsertProject({ lovable_project_id: NEW_PROJECT, workspace_id: WORKSPACE });
  assert.equal(store.getProjectMeta(NEW_PROJECT)?.name, "Quick Tip Calculator", "an upsert without a name keeps the name");
  store.disallowProject(NEW_PROJECT);
});

test("executeVersionNow: a verified write becomes the latest Knowledge snapshot, so the next change composes on what Lovable now holds", async () => {
  // Add then Remove, with no sync in between: Remove was composed on the
  // pre-write read and went stale on the owner's-style test project.
  const project = "proj-readback-snapshot";
  store.allowProject(project, "Readback snapshot project");
  const fake = new FakeLovable();
  fake.projectKnowledge[project] = "";
  const v = store.createPendingKnowledgeVersion({
    rule_id: null,
    target: "project",
    project_id: project,
    previous_content: "",
    new_content: managedBlock(["Use kr for money."]),
    rule_ids: [],
    actor: "test",
  });
  const outcome = await beats.executeVersionNow(v.id, fake);
  assert.equal(outcome.written, true);
  assert.equal(
    store.latestKnowledgeSnapshot("project", project, { forWrite: true })?.content,
    managedBlock(["Use kr for money."]),
  );
  store.disallowProject(project);
});

test("executeVersionNow: removing a rule right after adding it writes, even when composed on an older base -- Harness Ledger's own last-written block is not someone else's edit", async () => {
  const project = "proj-add-then-remove";
  store.allowProject(project, "Add then remove project");
  const rule = makeRule("Show money in kr.", "test", project);
  const block = managedBlock([rule.instruction]);
  const fake = new FakeLovable();
  fake.projectKnowledge[project] = "";

  const add = store.createPendingKnowledgeVersion({
    rule_id: rule.id,
    target: "project",
    project_id: project,
    previous_content: "",
    new_content: block,
    rule_ids: [rule.id],
    actor: "test",
  });
  assert.equal((await beats.executeVersionNow(add.id, fake)).written, true);

  // The rule is retired before its removal is written (retireRule's order),
  // and the removal was composed on the pre-add base.
  store.updateRule({ id: rule.id, state: "retired", actor: "test", reason: "retired manually" });
  const remove = store.createPendingKnowledgeVersion({
    rule_id: null,
    target: "project",
    project_id: project,
    previous_content: "",
    new_content: managedBlock([]),
    rule_ids: [],
    actor: "test",
  });
  const outcome = await beats.executeVersionNow(remove.id, fake);
  assert.equal(outcome.written, true, JSON.stringify(outcome));
  assert.ok(!fake.projectKnowledge[project]!.includes(rule.instruction), "the rule is gone from Lovable");

  // A line Harness never wrote is still refused.
  fake.projectKnowledge[project] = managedBlock(["Something a human typed inside the markers."]);
  const again = store.createPendingKnowledgeVersion({
    rule_id: null,
    target: "project",
    project_id: project,
    previous_content: "",
    new_content: managedBlock([]),
    rule_ids: [],
    actor: "test",
  });
  const refused = await beats.executeVersionNow(again.id, fake);
  assert.equal(refused.written, false);
  assert.ok(!refused.written && refused.kind === "stale");
  store.disallowProject(project);
});

test("snapshotSkills records a deleted skill, the Skills list drops it, History says it was deleted, and re-creating it is recorded again", async () => {
  // Live: a skill deleted in Lovable stayed on the Skills page as current.
  const WS = "ws-skill-deletion";
  const fake = new FakeLovable();
  fake.skills = [{ name: "temp-skill", description: "d", content: "# v1", updated_at: null }];
  await beats.snapshotSkills(fake, WS);
  assert.deepEqual(store.latestSkillSnapshots(WS).map((s) => s.name), ["temp-skill"]);

  fake.skills = [];
  assert.deepEqual(await beats.snapshotSkills(fake, WS), { skills: 0, changed: 1 });
  assert.deepEqual(store.latestSkillSnapshots(WS), [], "a deleted skill is not listed as current");
  assert.deepEqual(await beats.snapshotSkills(fake, WS), { skills: 0, changed: 0 }, "deletion recorded once");

  const labels = imp.buildTimeline("workspace", WS).filter((n) => n.kind === "skill").map((n) => n.label);
  assert.deepEqual(labels.sort(), ["Skill temp-skill deleted", "Skill temp-skill first read"].sort());

  fake.skills = [{ name: "temp-skill", description: "d", content: "# v1", updated_at: null }];
  assert.deepEqual(await beats.snapshotSkills(fake, WS), { skills: 1, changed: 1 }, "same content after deletion is a new snapshot");
  assert.deepEqual(store.latestSkillSnapshots(WS).map((s) => s.name), ["temp-skill"]);
});

test("executeVersionNow: retrying an older failed write merges with the rules Harness Ledger wrote since -- it never drops a newer rule or re-adds a retired one", async () => {
  // Review finding: V_B (only B) failed; V_A (A+B) was written; retrying V_B
  // recomposed from V_B's own rule set alone and removed A from Lovable.
  const project = "proj-retry-merge";
  store.allowProject(project, "Retry merge project");
  const a = makeRule("Rule A.", "test", project);
  const b = makeRule("Rule B.", "test", project);
  const retired = makeRule("Rule R.", "test", project);
  for (const r of [a, b, retired]) store.updateRule({ id: r.id, state: "active", actor: "test" });
  const fake = new FakeLovable();
  fake.projectKnowledge[project] = "";

  const vB = store.createPendingKnowledgeVersion({
    rule_id: b.id, target: "project", project_id: project,
    previous_content: "", new_content: managedBlock([b.instruction, retired.instruction]),
    rule_ids: [b.id, retired.id], actor: "test",
  });
  store.markKnowledgeWriteFailed(vB.id, "timed out");

  const vA = store.createPendingKnowledgeVersion({
    rule_id: a.id, target: "project", project_id: project,
    previous_content: "", new_content: managedBlock([a.instruction, b.instruction]),
    rule_ids: [a.id, b.id], actor: "test",
  });
  assert.equal((await beats.executeVersionNow(vA.id, fake)).written, true);

  store.updateRule({ id: retired.id, state: "retired", actor: "test", reason: "retired manually" });
  const retry = await beats.executeVersionNow(vB.id, fake);
  assert.equal(retry.written, true, JSON.stringify(retry));
  const live = fake.projectKnowledge[project]!;
  assert.ok(live.includes("Rule A."), "the newer rule A is kept");
  assert.ok(live.includes("Rule B."), "the retried rule B is written");
  assert.ok(!live.includes("Rule R."), "a rule retired since is not re-added");
  store.disallowProject(project);
});


test("snapshotSkills never marks skills deleted from an incomplete or malformed answer", async () => {
  // Review finding: an unexpected response shape read as "no skills" and
  // would have marked every skill in the workspace deleted.
  const WS = "ws-skill-incomplete";
  const fake = new FakeLovable();
  fake.skills = [{ name: "keep-me", description: null, content: "# k", updated_at: null }];
  await beats.snapshotSkills(fake, WS);
  fake.skills = [];
  fake.skillsComplete = false;
  assert.deepEqual(await beats.snapshotSkills(fake, WS), { skills: 0, changed: 0 });
  assert.deepEqual(store.latestSkillSnapshots(WS).map((s) => s.name), ["keep-me"]);
});

test("lovable-mcp listWorkspaceSkills: complete only for a well-formed answer without has_more", async () => {
  const { skillListFromResponse } = await import("../src/executor/lovable-mcp.js");
  assert.deepEqual(skillListFromResponse({ skills: [], total: 0, has_more: false }), { skills: [], complete: true });
  assert.equal(skillListFromResponse({ skills: [{ name: "a", markdown: "# a" }], has_more: true }).complete, false);
  assert.deepEqual(skillListFromResponse({ error: "unexpected" }), { skills: [], complete: false });
});

test("executeVersionNow: 'Go back to before this change' on an older version writes that older text, even though later changes are live", async () => {
  const project = "proj-go-back";
  store.allowProject(project, "Go back project");
  const a = makeRule("Go back A.", "test", project);
  const b = makeRule("Go back B.", "test", project);
  for (const r of [a, b]) store.updateRule({ id: r.id, state: "active", actor: "test" });
  const fake = new FakeLovable();
  fake.projectKnowledge[project] = "Notes.";
  const v1 = store.createPendingKnowledgeVersion({ rule_id: a.id, target: "project", project_id: project, previous_content: "Notes.", new_content: `Notes.\n\n${managedBlock([a.instruction])}`, rule_ids: [a.id], actor: "test" });
  assert.equal((await beats.executeVersionNow(v1.id, fake)).written, true);
  const v2 = store.createPendingKnowledgeVersion({ rule_id: b.id, target: "project", project_id: project, previous_content: fake.projectKnowledge[project]!, new_content: `Notes.\n\n${managedBlock([a.instruction, b.instruction])}`, rule_ids: [a.id, b.id], actor: "test" });
  assert.equal((await beats.executeVersionNow(v2.id, fake)).written, true);

  const goBack = store.createRestoreVersion(v1.id, "test") as { id: number };
  const outcome = await beats.executeVersionNow(goBack.id, fake);
  assert.equal(outcome.written, true, JSON.stringify(outcome));
  assert.equal(fake.projectKnowledge[project], "Notes.", "the text from before version 1 is back");
  // Both rules left Lovable, so both read as reverted.
  const stateOf = (id: number) => (db.prepare(`SELECT state FROM rules WHERE id = ?`).get(id) as { state: string }).state;
  assert.equal(stateOf(a.id), "rolled_back");
  assert.equal(stateOf(b.id), "rolled_back");

  // Someone edits Knowledge in Lovable, outside Harness: going back refuses
  // rather than overwrite that edit.
  fake.projectKnowledge[project] = "Notes. Edited in Lovable.";
  const again = store.createRestoreVersion(v2.id, "test") as { id: number };
  const refused = await beats.executeVersionNow(again.id, fake);
  assert.equal(refused.written, false);
  assert.ok(!refused.written && refused.kind === "stale");
  assert.equal(fake.projectKnowledge[project], "Notes. Edited in Lovable.");
  store.disallowProject(project);
});

test("parseToolResult: a Lovable error result throws -- its message is never returned as data (it was saved as Knowledge)", async () => {
  const { parseToolResult } = await import("../src/executor/lovable-mcp.js");
  assert.throws(
    () => parseToolResult({ isError: true, content: [{ type: "text", text: "Lovable API error: 401 unauthorized: Unauthorized" }] }),
    /401 unauthorized/,
  );
  assert.deepEqual(parseToolResult({ content: [{ type: "text", text: '{"content":"Notes"}' }] }), { content: "Notes" });
});

test("going back keeps a rule active when Knowledge holds an earlier wording of it, or a rule written over several lines", async () => {
  // Review finding: rules were matched by their current wording only, so
  // undoing a wording change (old wording back in Lovable) marked the rule
  // Reverted, and so did any multi-line instruction.
  const project = "proj-go-back-wording";
  store.allowProject(project, "Go back wording");
  const worded = makeRule("Use kronor.", "test", project);
  const multi = makeRule("First line.\nSecond line.", "test", project);
  for (const r of [worded, multi]) store.updateRule({ id: r.id, state: "active", actor: "test" });
  const fake = new FakeLovable();
  fake.projectKnowledge[project] = "";
  const blockOld = managedBlock(["Use kronor.", "First line.\nSecond line."]);
  const v1 = store.createPendingKnowledgeVersion({ rule_id: worded.id, target: "project", project_id: project, previous_content: "", new_content: blockOld, rule_ids: [worded.id, multi.id], actor: "test" });
  assert.equal((await beats.executeVersionNow(v1.id, fake)).written, true);
  store.updateRule({ id: worded.id, instruction: "Show money in kronor.", actor: "test", reason: "reworded" });
  const blockNew = managedBlock(["Show money in kronor.", "First line.\nSecond line."]);
  const v2 = store.createPendingKnowledgeVersion({ rule_id: worded.id, target: "project", project_id: project, previous_content: blockOld, new_content: blockNew, rule_ids: [worded.id, multi.id], actor: "test" });
  assert.equal((await beats.executeVersionNow(v2.id, fake)).written, true);

  // Undo the wording change: the old wording is back in Lovable.
  const undo = store.createRestoreVersion(v2.id, "test") as { id: number };
  assert.equal((await beats.executeVersionNow(undo.id, fake)).written, true);
  assert.equal(fake.projectKnowledge[project], blockOld);
  const stateOf = (id: number) => (db.prepare(`SELECT state FROM rules WHERE id = ?`).get(id) as { state: string }).state;
  assert.notEqual(stateOf(worded.id), "rolled_back", "its earlier wording is in Lovable");
  assert.equal(stateOf(multi.id), "active", "a multi-line rule that is present stays active");
  store.disallowProject(project);
});
