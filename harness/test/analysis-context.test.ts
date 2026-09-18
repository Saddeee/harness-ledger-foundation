// Checkpoint 2026-09-18 WP5 (D7): the context packet (harness/src/analysis/
// context.ts) -- selection, cap/truncation, recording, and its wiring into
// classify.ts's classifyPending. No LLM call is ever made in this file: a
// fake CallLlm plays the same role harness/test/analysis-classify.test.ts's
// own fake does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "harness-analysis-context-test-"));
process.env.HARNESS_DB_PATH = join(tmp, "harness.db");
process.env.HARNESS_AUTH_PATH = join(tmp, "lovable-auth.json");

const { db } = await import("../src/db.js");
const store = await import("../src/store.js");
const context = await import("../src/analysis/context.js");
const classify = await import("../src/analysis/classify.js");
import type { CallLlm, LlmRequest, LlmResult } from "../src/llm/types.js";

// ------------------------------------------------------------------ fakes

type Canned = { classification: string; tags: string[]; summary: string };

function fakeCallLlmFor(canned: Record<string, Canned>): CallLlm {
  return async function callLlm<T>(req: LlmRequest): Promise<LlmResult<T>> {
    const marker = "Message to classify:\n";
    const idx = req.user.indexOf(marker);
    const text = idx >= 0 ? req.user.slice(idx + marker.length) : req.user;
    const key = Object.keys(canned).find((k) => text.startsWith(k));
    if (!key) throw new Error(`fakeCallLlm: no canned response for "${text}"`);
    return {
      json: canned[key] as T,
      provider: "anthropic",
      model: "fake-classifier",
      tokensIn: 42,
      tokensOut: 7,
      costUsd: 0,
      latencyMs: 1,
    };
  };
}

let nextExternalId = 0;
function insertMessage(
  projectId: string,
  role: "user" | "assistant",
  content: string,
  occurredAt: string,
): { id: number; external_id: string } {
  return store.upsertHistoryItem({
    project_id: projectId,
    kind: "message",
    role,
    content,
    occurred_at: occurredAt,
    provenance: "lovable_mcp",
    external_id: `ext-${nextExternalId++}`,
  }) as { id: number; external_id: string };
}

function ts(minute: number): string {
  return `2026-09-05T10:${String(minute).padStart(2, "0")}:00.000Z`;
}

// ------------------------------------------------------------ pure unit tests

test("buildContextPacket: records a reason per item kind (current message, window, initial request, latest reply)", () => {
  const packet = context.buildContextPacket({
    role: "classifier",
    projectId: null,
    currentMessage: { id: 1, content: "current message text" },
    windowMessages: [{ id: 2, content: "an earlier message" }],
    liveRules: [{ id: 9, instruction: "Always do X." }],
    initialRequest: { id: 3, external_id: "req-3", content: "the original request" },
    latestReply: { content: "Here is the reply." },
  });

  const byId = new Map(packet.items.map((i) => [i.id, i]));
  assert.equal(byId.get("1")?.reason, "message under analysis");
  assert.equal(byId.get("1")?.kind, "current_message");
  assert.equal(byId.get("2")?.reason, "recent window");
  assert.equal(byId.get("2")?.kind, "window_message");
  assert.equal(byId.get("rule:9")?.reason, "project's live rules");
  assert.equal(byId.get("req-3")?.reason, "task's original request");
  assert.equal(byId.get("latest_reply")?.reason, "latest Lovable reply");
  assert.ok(packet.text_blocks.initial_request?.includes("the original request"));
  assert.ok(packet.text_blocks.latest_reply?.includes("Here is the reply."));
  assert.equal(packet.truncated, false);
  assert.deepEqual(packet.omitted, []);
});

test("buildContextPacket: over the ~6,000 char cap, lower-priority items are omitted (reason 'over context cap') and truncated is set; protected items (current message, window, rules) are never omitted", () => {
  const packet = context.buildContextPacket({
    role: "classifier",
    projectId: null,
    currentMessage: { id: 1, content: "current" },
    // A single protected window message alone already exceeds the cap.
    windowMessages: [{ id: 2, content: "w".repeat(7000) }],
    liveRules: [],
    initialRequest: { id: 3, external_id: "req-3", content: "the original request text" },
    latestReply: { content: "a short reply" },
  });

  assert.equal(packet.truncated, true);
  assert.ok(
    packet.items.some((i) => i.id === "2"),
    "the protected window message is never omitted",
  );
  assert.ok(
    packet.omitted.some((o) => o.id === "req-3" && o.reason === "over context cap"),
    "the initial request was pushed out by the cap",
  );
  assert.equal(packet.text_blocks.initial_request, null, "an omitted item is not rendered");
  assert.equal(
    packet.items.some((i) => i.id === "req-3"),
    false,
    "an omitted item does not also appear in items",
  );
});

test("buildContextPacket: current message and window are always included regardless of the cap", () => {
  const packet = context.buildContextPacket({
    role: "classifier",
    projectId: null,
    currentMessage: { id: 1, content: "x".repeat(10_000) },
    windowMessages: [],
    liveRules: [],
    initialRequest: null,
    latestReply: null,
  });
  assert.equal(packet.items.length, 1);
  assert.equal(packet.items[0]!.kind, "current_message");
  assert.equal(packet.items[0]!.chars, 10_000);
});

// ------------------------------------------------------- classify.ts wiring

test("classify.classifyPending: an older, term-matched message is included as context (not reclassified), reasons and packet ids are recorded, and the classifier still only gets the 3-message window", async () => {
  const PROJECT = "proj-context-term-match";
  store.allowProject(PROJECT, "Context term match");

  // An older message sharing 2 distinctive words ("billing", "network") and
  // a route token (/settings/billing) with the current message, well
  // outside the 3-message window -- already classified in an earlier pass
  // (real-world: it happened days ago), so this run must use it only as
  // context, never spend a second call reclassifying it.
  const older = insertMessage(
    PROJECT,
    "user",
    "The /settings/billing page throws a network error whenever I try to save.",
    ts(0),
  );
  store.insertMessageClassification({
    history_item_id: older.id,
    classification: "correction",
    tags: [],
    summary: "Billing page network error.",
    run_id: null,
  });
  const olderRowBefore = db
    .prepare(`SELECT * FROM message_classifications WHERE history_item_id = ?`)
    .get(older.id);
  // Padding, already classified, so classifyPending has only the current
  // message left to do -- keeps this test's canned-response map to one entry.
  for (let i = 1; i <= 5; i++) {
    const padding = insertMessage(PROJECT, "user", `Padding message number ${i}.`, ts(i));
    store.insertMessageClassification({
      history_item_id: padding.id,
      classification: "other",
      tags: [],
      summary: `padding ${i}`,
      run_id: null,
    });
  }
  const current = insertMessage(
    PROJECT,
    "user",
    "Users still can't save on /settings/billing -- the network error keeps happening.",
    ts(6),
  );

  const canned: Record<string, Canned> = {
    "Users still can't save on /settings/billing": {
      classification: "correction",
      tags: [],
      summary: "Billing save still broken.",
    },
  };
  const prompts: string[] = [];
  const inner = fakeCallLlmFor(canned);
  const callLlm: CallLlm = async (req) => {
    prompts.push(req.user);
    return inner(req);
  };

  const result = await classify.classifyPending(callLlm, { limit: 10, runId: undefined });
  assert.deepEqual(result, { classified: 1, failed: 0 });
  assert.equal(prompts.length, 1, "only the current message was itself classified this run");

  // The older message was used as context only: its own classification row
  // is byte-identical to what it was before this run -- no second call was
  // spent reclassifying it just because it was pulled in as context.
  const olderRowAfter = db
    .prepare(`SELECT * FROM message_classifications WHERE history_item_id = ?`)
    .get(older.id);
  assert.deepEqual(
    olderRowAfter,
    olderRowBefore,
    "the term-matched older message was not reclassified",
  );

  // The classifier's own recent-window stays capped at 3, unaffected by the
  // context packet (packet.text_blocks are appended on top, not instead).
  const windowBefore = store.listContextBefore(current.id, 3);
  assert.equal(windowBefore.length, 3);

  // The prompt actually sent included the older message's text.
  const prompt = prompts[0]!;
  assert.ok(
    prompt.includes("throws a network error whenever I try to save"),
    "the older, term-matched message's text was sent to the classifier",
  );

  // analysis_context recorded exactly what was sent: same ids.
  const row = db
    .prepare(`SELECT * FROM analysis_context WHERE target_history_item_id = ?`)
    .get(current.id) as {
    selected_json: string;
    omitted_json: string;
    truncated: number;
    strategy_version: string;
    prompt_version: string;
    role: string;
    llm_call_id: number | null;
    content_hash: string;
  };
  assert.ok(row, "a packet was recorded for this call");
  assert.equal(row.role, "classifier");
  assert.equal(
    row.llm_call_id,
    null,
    "no llm_calls row id is available to this module -- null, as the brief allows",
  );
  assert.equal(row.truncated, 0);
  assert.equal(row.strategy_version, context.CONTEXT_STRATEGY_VERSION);
  assert.equal(row.prompt_version, context.PROMPT_VERSION.classifier);
  assert.equal(row.content_hash, context.contentHashOf(current.content));

  const selected = JSON.parse(row.selected_json) as { id: string; kind: string; reason: string }[];
  const olderItem = selected.find((i) => i.kind === "older_message");
  assert.ok(olderItem, "the older message is listed as a selected item");
  assert.equal(olderItem!.id, older.external_id);
  assert.match(olderItem!.reason, /^term match: /);
  assert.ok(
    olderItem!.reason.includes("billing") || olderItem!.reason.includes("/settings/billing"),
    `reason should name a shared term: ${olderItem!.reason}`,
  );

  const windowItems = selected.filter((i) => i.kind === "window_message");
  assert.ok(windowItems.length <= 3, "the recorded window never exceeds the classifier's own cap");

  // message_classifications gained content_hash/prompt_version/strategy_version/analyzed_at.
  const stamped = db
    .prepare(
      `SELECT content_hash, prompt_version, strategy_version, analyzed_at FROM message_classifications WHERE history_item_id = ?`,
    )
    .get(current.id) as {
    content_hash: string;
    prompt_version: string;
    strategy_version: string;
    analyzed_at: string | null;
  };
  assert.equal(stamped.content_hash, context.contentHashOf(current.content));
  assert.equal(stamped.prompt_version, context.PROMPT_VERSION.classifier);
  assert.equal(stamped.strategy_version, context.CONTEXT_STRATEGY_VERSION);
  assert.ok(stamped.analyzed_at, "analyzed_at is stamped");
});

// ------------------------------------------------------- automatic setting

test("automatic_analysis_after_sync setting: defaults to false, direct SQL round-trips true/false", () => {
  // A fresh key with no row yet.
  assert.equal(context.getAutomaticAnalysisSetting(), false);
  context.setAutomaticAnalysisSetting(true);
  assert.equal(context.getAutomaticAnalysisSetting(), true);
  const row = db
    .prepare(`SELECT value FROM settings WHERE key = ?`)
    .get(context.AUTOMATIC_ANALYSIS_SETTING_KEY) as { value: string };
  assert.equal(row.value, "true");
  context.setAutomaticAnalysisSetting(false);
  assert.equal(context.getAutomaticAnalysisSetting(), false);
});

// -------------------------------------------------- beats.ts runAll wiring

const beats = await import("../src/executor/beats.js");
import type { LovableClient, LovableMessage } from "../src/executor/lovable-mcp.js";

const BEATS_PROJECT = "proj-context-beats-auto-analysis";
const BEATS_WORKSPACE = "ws-context-beats-auto-analysis";
store.allowProject(BEATS_PROJECT, "Beats auto analysis");

type Page = { messages: LovableMessage[]; next_cursor: string | null; has_more: boolean };

function beatsMsg(id: string, content: string): LovableMessage {
  return {
    message_id: id,
    role: "user",
    status: "complete",
    created_at: "2026-09-07T10:00:00.000Z",
    edit_id: `edit-${id}`,
    content,
  };
}

class FakeLovable implements LovableClient {
  pages: Record<string, Page[]> = {};
  projectKnowledge: Record<string, string> = {};
  workspaceKnowledge = "";
  skills: {
    name: string;
    description: string | null;
    content: string;
    updated_at: string | null;
  }[] = [];
  async getMe() {
    return {
      id: "u1",
      email: "a@example.com",
      name: "A",
      workspaces: [{ id: BEATS_WORKSPACE, name: "WS" }],
    };
  }
  async listProjects() {
    return [{ id: BEATS_PROJECT, name: "Beats auto analysis" }];
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
    return { skills: this.skills, complete: true };
  }
  async setProjectKnowledge(projectId: string, content: string) {
    this.projectKnowledge[projectId] = content;
  }
  async setWorkspaceKnowledge(workspaceId: string, content: string) {
    this.workspaceKnowledge = content;
  }
  async close() {}
}

function countAnalysisRequests(): number {
  return (db.prepare(`SELECT COUNT(*) as n FROM analysis_requests`).get() as { n: number }).n;
}

test("beats.runAll: automatic_analysis_after_sync off creates no analysis_requests row; on, exactly one", async () => {
  assert.equal(context.getAutomaticAnalysisSetting(), false, "default is off");

  const fakeOff = new FakeLovable();
  fakeOff.pages[BEATS_PROJECT] = [
    { messages: [beatsMsg("bm1", "one")], next_cursor: null, has_more: false },
  ];
  const before = countAnalysisRequests();
  const resultOff = await beats.runAll(fakeOff, "manual");
  assert.equal(resultOff.ok, true, resultOff.error);
  assert.equal(resultOff.ran, true);
  assert.equal(countAnalysisRequests(), before, "the setting is off -- no analysis was requested");

  context.setAutomaticAnalysisSetting(true);
  try {
    const fakeOn = new FakeLovable();
    fakeOn.pages[BEATS_PROJECT] = [
      { messages: [beatsMsg("bm2", "two")], next_cursor: null, has_more: false },
    ];
    const beforeOn = countAnalysisRequests();
    const resultOn = await beats.runAll(fakeOn, "manual");
    assert.equal(resultOn.ok, true, resultOn.error);
    assert.equal(resultOn.ran, true);
    assert.equal(
      countAnalysisRequests(),
      beforeOn + 1,
      "exactly one analysis_requests row was created",
    );
    assert.equal(store.hasOpenAnalysisRequest(), true);

    // A second successful sync while the setting stays on coalesces with
    // the still-open request rather than stacking a second one -- the same
    // guarantee "Analyse now"'s own store.requestAnalysis() already gives.
    const fakeOn2 = new FakeLovable();
    fakeOn2.pages[BEATS_PROJECT] = [
      { messages: [beatsMsg("bm3", "three")], next_cursor: null, has_more: false },
    ];
    const beforeSecond = countAnalysisRequests();
    const resultOn2 = await beats.runAll(fakeOn2, "manual");
    assert.equal(resultOn2.ok, true, resultOn2.error);
    assert.equal(countAnalysisRequests(), beforeSecond, "coalesced with the still-open request");
  } finally {
    context.setAutomaticAnalysisSetting(false);
  }
});

test("beats.runAll: a FAILED sync never queues an analysis request, even with the setting on", async () => {
  context.setAutomaticAnalysisSetting(true);
  try {
    const fake = new FakeLovable();
    fake.listMessages = async () => {
      throw new Error("network down");
    };
    const before = countAnalysisRequests();
    const result = await beats.runAll(fake, "once");
    assert.equal(result.ok, false);
    assert.equal(countAnalysisRequests(), before, "a failed sync must never trigger analysis");
  } finally {
    context.setAutomaticAnalysisSetting(false);
  }
});
