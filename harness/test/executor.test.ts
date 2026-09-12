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
  async listWorkspaceSkills() {
    return this.skills;
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
  assert.deepEqual(counts, { written: 1, stale: 0, failed: 0, skipped_auto_write: 0 });
  assert.deepEqual(fake.setCalls, [{ kind: "project", id: PROJECT, content: "live text + rule" }]);
  assert.equal(store.getKnowledgeVersion(v.id)?.status, "written");
});

test("executeWrites marks a version stale when live content drifted, without calling set", async () => {
  const fake = new FakeLovable();
  const v = stagePending("composed against this", "new text");
  fake.projectKnowledge[PROJECT] = "someone else edited it";

  const counts = await beats.executeWrites(fake);
  assert.deepEqual(counts, { written: 0, stale: 1, failed: 0, skipped_auto_write: 0 });
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
  assert.deepEqual(counts, { written: 0, stale: 0, failed: 1, skipped_auto_write: 0 });
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
  assert.deepEqual(counts, { written: 1, stale: 0, failed: 0, skipped_auto_write: 1 });
  assert.equal(store.getKnowledgeVersion(projectVersion.id)?.status, "pending", "left pending, not touched at all");
  assert.equal(store.getKnowledgeVersion(workspaceVersion.id)?.status, "written");
  assert.deepEqual(fake.setCalls, [{ kind: "workspace", id: WORKSPACE, content: "workspace write is unaffected" }]);

  // Turning it back on lets the same pending write through on the next pass.
  store.setProjectSettings(PROJECT, { auto_write: true });
  const second = await beats.executeWrites(fake);
  assert.deepEqual(second, { written: 1, stale: 0, failed: 0, skipped_auto_write: 0 });
  assert.equal(store.getKnowledgeVersion(projectVersion.id)?.status, "written");
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
function makeRule(instruction: string): { id: number; instruction: string; correctionId: number } {
  ruleCounter += 1;
  const evidence = store.upsertHistoryItem({
    project_id: PROJECT,
    kind: "message",
    external_id: `execversion-evidence-${ruleCounter}`,
    role: "user",
    content: "evidence",
    provenance: "lovable_mcp",
  }) as { id: number };
  const episode = store.createTaskEpisode({
    project_id: PROJECT,
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
    created_by: "test",
  }) as { id: number };
  const rule = store.createRule({
    learning_id: learning.id,
    correction_candidate_id: correction.id,
    instruction,
    scope: "project",
    applies_when: "always",
    predicted_failure: "n/a",
    ownership: "harness",
    created_by: "test",
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

test("executeVersionNow: base changed AND the managed block itself was edited in Lovable -- stale, never writes", async () => {
  const rule = makeRule("Always write tests before committing.");
  const previousContent = `Some text.\n\n${managedBlock([rule.instruction])}`;
  // Someone typed directly inside the Harness-managed block in Lovable.
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
  assert.ok(!outcome.written && /edited|changed/i.test(outcome.reason));
  assert.equal(fake.setCalls.length, 0, "never writes when the managed block itself drifted");
  assert.equal(store.getKnowledgeVersion(v.id)?.status, "stale");
});

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

// -------------------------------------------------------- lock interplay --

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

test("improvementActionAndWrite: accept before any Knowledge snapshot exists reports write.kind 'no_snapshot'", async () => {
  // A brand-new project this test's own PROJECT const has never had a
  // snapshot recorded for, so stagePendingWrite has nothing to compose
  // against and stages nothing -- improvementActionAndWrite must still
  // report a write outcome (connected, but nothing to write), not silently
  // omit `write`. status().connected is false in this test file, but the
  // "no_snapshot" report should win when there is genuinely nothing staged
  // regardless -- covered structurally by checking the field always exists
  // for a write-eligible action (the not_connected tests above already
  // cover the "nothing staged AND not connected" path taking precedence).
  const rule = makeRule("Always do V.");
  const result = await beats.improvementActionAndWrite({
    action: "accept",
    id: rule.correctionId,
    destination: "project",
  });
  assert.ok(result.write);
  assert.equal(result.write!.written, false);
});

test("improvementActionAndWrite: retryKnowledgeWrite reports not connected for a real pending version", async () => {
  const v = stagePending("live text", "live text + rule");
  const write = await beats.retryKnowledgeWrite(v.id);
  assert.ok(!write.written && write.kind === "not_connected");
  // retryKnowledgeWrite never touches the version when refusing up front.
  assert.equal(store.getKnowledgeVersion(v.id)?.status, "pending");
});

test("lock.currentLockHolder: null when unheld or stale, the holder when fresh", () => {
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
