import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "harness-analysis-test-"));
process.env.HARNESS_DB_PATH = join(tmp, "harness.db");
// Keep the auth file out of the real data directory: nothing here connects.
process.env.HARNESS_AUTH_PATH = join(tmp, "lovable-auth.json");

const { db } = await import("../src/db.js");
const store = await import("../src/store.js");
const classify = await import("../src/analysis/classify.js");
const segment = await import("../src/analysis/segment.js");
const replyText = await import("../src/analysis/reply-text.js");
import type { CallLlm, LlmRequest, LlmResult } from "../src/llm/types.js";
import { LlmBudgetExceeded } from "../src/llm/types.js";

// ------------------------------------------------------------------ fakes

type Canned = { classification: string; tags: string[]; summary: string };

/**
 * A fake CallLlm that never makes a network call: it pulls the exact
 * "Message to classify:\n<text>" text out of the assembled user prompt and
 * looks up a canned response for it, so each test controls classification
 * output per message content instead of per call order.
 */
function fakeCallLlmFor(
  canned: Record<string, Canned>,
  opts?: { budgetExceededOn?: string; throwOn?: string },
): CallLlm {
  return async function callLlm<T>(req: LlmRequest): Promise<LlmResult<T>> {
    const marker = "Message to classify:\n";
    const idx = req.user.indexOf(marker);
    const text = idx >= 0 ? req.user.slice(idx + marker.length) : req.user;

    if (opts?.budgetExceededOn && text.startsWith(opts.budgetExceededOn)) {
      throw new LlmBudgetExceeded(2_000_000, 2_000_000);
    }
    if (opts?.throwOn && text.startsWith(opts.throwOn)) {
      throw new Error("simulated provider failure");
    }
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
): { id: number } {
  return store.upsertHistoryItem({
    project_id: projectId,
    kind: "message",
    role,
    content,
    occurred_at: occurredAt,
    provenance: "lovable_mcp",
    external_id: `ext-${nextExternalId++}`,
  }) as { id: number };
}

function ts(minute: number): string {
  return `2026-09-01T10:${String(minute).padStart(2, "0")}:00.000Z`;
}

// ------------------------------------------------------------------ tests

test("humanVisibleText matches src/lib/harness-ux.ts's lovableReplyText on the same fixture", () => {
  const raw =
    '<lov-tool-use id="a" name="supabase--run_sql" integration-id="supabase" data="{\\"query\\": \\"select 1\\"}">\n</lov-tool-use>\n' +
    '<lov-tool-use id="b" name="user_messaging--message_user" integration-id="user_messaging" data="{\\"summary\\": \\"s\\", \\"message\\": \\"Heads up: the worker will wake once a minute (1,440 times a day).\\\\nSecond line.\\", \\"finished\\": false}">\n</lov-tool-use>\n' +
    '<lov-tool-use id="c" name="user_messaging--message_user" integration-id="user_messaging" data="{\\"summary\\": \\"t\\", \\"message\\": \\"The foundation is live.\\", \\"finished\\": true}">\n</lov-tool-use>';
  const text = replyText.humanVisibleText(raw);
  assert.equal(
    text,
    "Heads up: the worker will wake once a minute (1,440 times a day).\nSecond line.\n\nThe foundation is live.",
  );
  assert.ok(!text.includes("run_sql"));
  const fallback = replyText.humanVisibleText("plain assistant text " + "x".repeat(1000));
  assert.ok(fallback.length <= 601 && fallback.startsWith("plain assistant text"));
});

test("classifierUserPrompt labels context by role and renders assistant replies via humanVisibleText", () => {
  const context = [
    {
      id: 1,
      project_id: "p",
      role: "user" as const,
      content: "Build a login page.",
      occurred_at: ts(0),
    },
    {
      id: 2,
      project_id: "p",
      role: "assistant" as const,
      content:
        '<lov-tool-use id="x" name="user_messaging--message_user" data="{\\"message\\": \\"Added the login page.\\"}">\n</lov-tool-use>',
      occurred_at: ts(1),
    },
  ];
  const prompt = classify.classifierUserPrompt({ content: "It's broken now." }, context);
  assert.ok(prompt.includes("User: Build a login page."));
  assert.ok(prompt.includes("Lovable: Added the login page."));
  assert.ok(!prompt.includes("lov-tool-use"));
  assert.ok(prompt.includes("Message to classify:\nIt's broken now."));
});

test("classifierSystemPrompt embeds the full SCOPE_TAGS taxonomy and the five-value classification enum", async () => {
  const taxonomy = await import("../src/analysis/taxonomy.js");
  const prompt = classify.classifierSystemPrompt();
  for (const tag of taxonomy.SCOPE_TAGS) assert.ok(prompt.includes(tag), `missing tag ${tag}`);
  for (const value of ["new_task", "correction", "question", "approval", "other"]) {
    assert.ok(prompt.includes(value), `missing classification ${value}`);
  }
});

test("classifyPending classifies a scripted history, clamps tags/summary, and is idempotent", async () => {
  const PROJECT = "proj-classify-a";
  store.allowProject(PROJECT, "Project A");

  const m1 = insertMessage(
    PROJECT,
    "user",
    "Build a login page with email and password fields.",
    ts(0),
  );
  const a1 = insertMessage(
    PROJECT,
    "assistant",
    '<lov-tool-use id="x" name="user_messaging--message_user" data="{\\"message\\": \\"Added the login page.\\"}">\n</lov-tool-use>',
    ts(1),
  );
  const m2 = insertMessage(
    PROJECT,
    "user",
    "The login button does nothing when I click it, it's broken.",
    ts(2),
  );
  const m3 = insertMessage(PROJECT, "user", "Does this support OAuth login too?", ts(3));
  const m4 = insertMessage(
    PROJECT,
    "user",
    "Now add a dashboard that shows a chart of daily signups.",
    ts(4),
  );
  const m5 = insertMessage(
    PROJECT,
    "user",
    "The chart colors are hard to read, please use higher contrast.",
    ts(5),
  );
  const m6 = insertMessage(
    PROJECT,
    "user",
    "The dashboard never finishes loading, it just spins forever.",
    ts(6),
  );

  // listContextBefore: previous-3-messages window, oldest first, any role.
  const contextForM2 = store.listContextBefore(m2.id, 3);
  assert.deepEqual(
    contextForM2.map((c) => c.id),
    [m1.id, a1.id],
  );
  assert.equal(contextForM2[0]!.role, "user");
  assert.equal(contextForM2[1]!.role, "assistant");

  const longSummary = "y".repeat(200);
  const canned: Record<string, Canned> = {
    "Build a login page with email and password fields.": {
      classification: "new_task",
      // duplicate + an invalid tag not in SCOPE_TAGS -- both should be
      // dropped/deduped by validateClassifierOutput.
      tags: ["auth", "auth", "not-a-real-tag"],
      summary: "Add a login page with email/password auth.",
    },
    "The login button does nothing when I click it, it's broken.": {
      classification: "correction",
      tags: ["auth", "components"],
      summary: longSummary, // > 120 chars -- must be clamped
    },
    "Does this support OAuth login too?": {
      classification: "question",
      tags: ["auth"],
      summary: "Asks whether OAuth login is supported.",
    },
    "Now add a dashboard that shows a chart of daily signups.": {
      classification: "new_task",
      tags: ["components", "state"],
      summary: "Add a signups dashboard with a chart.",
    },
    "The chart colors are hard to read, please use higher contrast.": {
      classification: "correction",
      tags: ["styling", "accessibility"],
      summary: "Increase chart color contrast.",
    },
    "The dashboard never finishes loading, it just spins forever.": {
      classification: "correction",
      tags: ["performance", "state"],
      summary: "Fix dashboard infinite loading.",
    },
  };

  const first = await classify.classifyPending(fakeCallLlmFor(canned), { limit: 10 });
  assert.deepEqual(first, { classified: 6, failed: 0 });

  const classified = store.listClassifiedUserMessages(PROJECT);
  assert.equal(classified.length, 6);

  const row1 = classified.find((r) => r.history_item_id === m1.id)!;
  assert.equal(row1.classification, "new_task");
  assert.deepEqual(row1.tags, ["auth"]); // deduped, invalid tag dropped

  const row2 = classified.find((r) => r.history_item_id === m2.id)!;
  assert.equal(row2.classification, "correction");
  assert.equal(row2.summary.length, 120); // clamped
  assert.equal(row2.summary, longSummary.slice(0, 120));

  assert.equal(classified.find((r) => r.history_item_id === m3.id)!.classification, "question");
  assert.equal(classified.find((r) => r.history_item_id === m4.id)!.classification, "new_task");
  assert.equal(classified.find((r) => r.history_item_id === m5.id)!.classification, "correction");
  assert.equal(classified.find((r) => r.history_item_id === m6.id)!.classification, "correction");

  // Idempotent: nothing left to classify.
  const second = await classify.classifyPending(fakeCallLlmFor(canned), { limit: 10 });
  assert.deepEqual(second, { classified: 0, failed: 0 });

  // ---- segmentEpisodes over the same classified history ----

  const segmented = segment.segmentEpisodes(PROJECT);
  assert.deepEqual(segmented, { created: 2, attached: 4 });

  const episodes = db
    .prepare(`SELECT id, ended_at FROM task_episodes WHERE project_id = ? ORDER BY id ASC`)
    .all(PROJECT) as { id: number; ended_at: string | null }[];
  assert.equal(episodes.length, 2);

  const correctionCounts = episodes.map((ep) => {
    const row = db
      .prepare(
        `SELECT COUNT(*) as n FROM task_episode_evidence tee
         JOIN message_classifications mc ON mc.history_item_id = tee.history_item_id
         WHERE tee.task_episode_id = ? AND mc.classification = 'correction'`,
      )
      .get(ep.id) as { n: number };
    return row.n;
  });
  assert.deepEqual(correctionCounts, [1, 2]);

  // ended_at only advances on corrections (per spec), so episode 1's
  // ended_at is m2's time (the question m3 doesn't move it) and episode 2's
  // is m6's time (the last correction).
  assert.equal(episodes[0]!.ended_at, ts(2));
  assert.equal(episodes[1]!.ended_at, ts(6));

  // Every message ended up linked to an episode.
  for (const id of [m1.id, m2.id, m3.id, m4.id, m5.id, m6.id]) {
    assert.notEqual(store.episodeForHistoryItem(id), null);
  }

  // Idempotent: a second run creates and attaches nothing.
  const segmentedAgain = segment.segmentEpisodes(PROJECT);
  assert.deepEqual(segmentedAgain, { created: 0, attached: 0 });
});

test("classifyPending stops early on LlmBudgetExceeded and reports the count so far", async () => {
  const PROJECT = "proj-classify-budget";
  store.allowProject(PROJECT, "Project Budget");

  insertMessage(PROJECT, "user", "Build a settings page for notifications.", ts(0));
  const stopped = insertMessage(
    PROJECT,
    "user",
    "This call should blow the monthly token budget.",
    ts(1),
  );
  const unreached = insertMessage(PROJECT, "user", "This message must never be reached.", ts(2));

  const canned: Record<string, Canned> = {
    "Build a settings page for notifications.": {
      classification: "new_task",
      tags: ["forms"],
      summary: "Add a notification settings page.",
    },
  };

  const result = await classify.classifyPending(
    fakeCallLlmFor(canned, { budgetExceededOn: "This call should blow the monthly token budget." }),
    { limit: 10 },
  );
  assert.deepEqual(result, { classified: 1, failed: 0 });

  const classified = store.listClassifiedUserMessages(PROJECT);
  assert.equal(
    classified.length,
    1,
    "only the first message was classified before the budget stopped the run",
  );

  // listUnclassifiedUserMessages (and therefore classifyPending) has no
  // per-project filter by design -- it drains the whole pending pool across
  // every project (round-4.md Task A1). Drain these two deliberately-
  // unprocessed messages directly so they don't leak into a later test's
  // classifyPending call and get counted against its expectations.
  store.insertMessageClassification({
    history_item_id: stopped.id,
    classification: "other",
    tags: [],
    summary: "cleanup: drained after the budget-stop test",
    run_id: null,
  });
  store.insertMessageClassification({
    history_item_id: unreached.id,
    classification: "other",
    tags: [],
    summary: "cleanup: drained after the budget-stop test",
    run_id: null,
  });
});

test("classifyPending counts a non-budget provider error as failed and continues", async () => {
  const PROJECT = "proj-classify-errors";
  store.allowProject(PROJECT, "Project Errors");

  insertMessage(PROJECT, "user", "Add a pricing page with three tiers.", ts(0));
  const failing = insertMessage(
    PROJECT,
    "user",
    "This one fails with a generic provider error.",
    ts(1),
  );
  insertMessage(PROJECT, "user", "Add a footer with social links.", ts(2));

  const canned: Record<string, Canned> = {
    "Add a pricing page with three tiers.": {
      classification: "new_task",
      tags: ["components"],
      summary: "Add a pricing page.",
    },
    "Add a footer with social links.": {
      classification: "new_task",
      tags: ["components"],
      summary: "Add a footer.",
    },
  };

  const result = await classify.classifyPending(
    fakeCallLlmFor(canned, { throwOn: "This one fails with a generic provider error." }),
    { limit: 10 },
  );
  assert.deepEqual(result, { classified: 2, failed: 1 });

  // Drain the never-classified failure so it doesn't leak into a later
  // test's global classifyPending sweep.
  store.insertMessageClassification({
    history_item_id: failing.id,
    classification: "other",
    tags: [],
    summary: "cleanup: drained after the provider-error test",
    run_id: null,
  });
});

test("segmentEpisodes creates no episode for a question-only history", () => {
  const PROJECT = "proj-segment-question-only";
  store.allowProject(PROJECT, "Project Question Only");

  const m1 = insertMessage(PROJECT, "user", "Is this app using Postgres or MySQL?", ts(0));
  store.insertMessageClassification({
    history_item_id: m1.id,
    classification: "question",
    tags: ["database"],
    summary: "Asks which database is used.",
    run_id: null,
  });

  const result = segment.segmentEpisodes(PROJECT);
  assert.deepEqual(result, { created: 0, attached: 0 });

  const count = db
    .prepare(`SELECT COUNT(*) as n FROM task_episodes WHERE project_id = ?`)
    .get(PROJECT) as { n: number };
  assert.equal(count.n, 0);
  assert.equal(store.episodeForHistoryItem(m1.id), null);
});

test("segmentAllProjects sums created/attached across every allowed project", () => {
  const PROJECT_1 = "proj-segment-all-1";
  const PROJECT_2 = "proj-segment-all-2";
  store.allowProject(PROJECT_1, "All 1");
  store.allowProject(PROJECT_2, "All 2");

  const p1 = insertMessage(PROJECT_1, "user", "Set up a blog with markdown posts.", ts(0));
  store.insertMessageClassification({
    history_item_id: p1.id,
    classification: "new_task",
    tags: ["general"],
    summary: "Set up a blog.",
    run_id: null,
  });
  const p2 = insertMessage(PROJECT_2, "user", "Add a contact form with validation.", ts(0));
  store.insertMessageClassification({
    history_item_id: p2.id,
    classification: "new_task",
    tags: ["forms"],
    summary: "Add a contact form.",
    run_id: null,
  });

  const before = segment.segmentAllProjects();
  assert.ok(before.created >= 2);

  const after = segment.segmentAllProjects();
  assert.deepEqual(after, { created: 0, attached: 0 });
});
