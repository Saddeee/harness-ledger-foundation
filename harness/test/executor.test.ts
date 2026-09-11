import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "harness-executor-test-"));
process.env.HARNESS_DB_PATH = join(tmp, "harness.db");
// Keep the auth file out of the real data directory: nothing here connects.
process.env.HARNESS_AUTH_PATH = join(tmp, "lovable-auth.json");

const { db } = await import("../src/db.js");
const store = await import("../src/store.js");
const beats = await import("../src/executor/beats.js");
const schedule = await import("../src/executor/schedule.js");
const { sha256 } = await import("../src/knowledge.js");
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
  assert.deepEqual(counts, { written: 1, stale: 0, failed: 0 });
  assert.deepEqual(fake.setCalls, [{ kind: "project", id: PROJECT, content: "live text + rule" }]);
  assert.equal(store.getKnowledgeVersion(v.id)?.status, "written");
});

test("executeWrites marks a version stale when live content drifted, without calling set", async () => {
  const fake = new FakeLovable();
  const v = stagePending("composed against this", "new text");
  fake.projectKnowledge[PROJECT] = "someone else edited it";

  const counts = await beats.executeWrites(fake);
  assert.deepEqual(counts, { written: 0, stale: 1, failed: 0 });
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
  assert.deepEqual(counts, { written: 0, stale: 0, failed: 1 });
  const row = store.getKnowledgeVersion(v.id)!;
  assert.equal(row.status, "failed");
  assert.match(row.error ?? "", /lovable exploded/);
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
