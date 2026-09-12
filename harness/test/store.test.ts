import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolated temp DB for this test file, set before db.ts is first imported.
process.env.HARNESS_DB_PATH = join(mkdtempSync(join(tmpdir(), "harness-test-")), "harness.db");

const { db, schemaVersion } = await import("../src/db.js");
const store = await import("../src/store.js");

const PROJECT = "test-project-id";

test("schema migration: applies all migrations exactly once, expected tables exist", () => {
  assert.equal(schemaVersion(), 11);
  const rows = db.prepare(`SELECT version FROM schema_migrations ORDER BY version`).all() as {
    version: number;
  }[];
  assert.deepEqual(
    rows.map((r) => r.version),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  );
  const tableNames = new Set(
    (
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]
    ).map((r) => r.name),
  );
  for (const t of [
    "allowed_projects",
    "projects",
    "test_records",
    "events", // checkpoint A
    "project_snapshots",
    "history_items",
    "task_episodes",
    "task_episode_evidence",
    "correction_candidates",
    "correction_candidate_evidence",
    "agent_actions",
    "learnings",
    "rules",
    "rule_revisions", // checkpoint B
    "settings",
    "skill_snapshots",
    "sync_runs",
    "sync_requests", // checkpoint E (v5)
    "project_settings",
    "llm_calls", // round 3 (v8)
    "message_classifications",
    "analysis_requests",
    "analysis_runs",
    "rule_health",
    "retire_proposals", // round 4 (v9)
    "rule_verdicts",
    "rule_adherence", // round 5 (v11)
  ]) {
    assert.ok(tableNames.has(t), `expected table ${t} to exist`);
  }
});

test("allowed project validation: rejects unseeded project, accepts seeded one", () => {
  assert.equal(store.isAllowedProject(PROJECT), false);
  assert.throws(
    () =>
      store.createTaskEpisode({
        project_id: PROJECT,
        title: "should fail",
        provenance: "manual",
      }),
    store.NotAllowedProjectError,
  );

  db.prepare(`INSERT INTO allowed_projects (lovable_project_id, label) VALUES (?, ?)`).run(
    PROJECT,
    "test seed",
  );
  assert.equal(store.isAllowedProject(PROJECT), true);
});

let episodeId: number;
test("evidence provenance: enum is enforced, valid values persist", () => {
  assert.throws(() =>
    store.upsertHistoryItem({
      project_id: PROJECT,
      kind: "manual_note",
      content: "bad provenance",
      // @ts-expect-error deliberately invalid
      provenance: "not_a_real_source",
    }),
  );

  const item = store.upsertHistoryItem({
    project_id: PROJECT,
    kind: "manual_note",
    external_id: "operator-quote-1",
    role: "operator",
    content: "the every-minute cron is unacceptable",
    provenance: "manual",
  }) as { id: number; provenance: string };
  assert.equal(item.provenance, "manual");

  const episode = store.createTaskEpisode({
    project_id: PROJECT,
    title: "cron scheduling correction",
    provenance: "llm_derived",
    evidence_history_item_ids: [item.id],
  }) as { id: number };
  episodeId = episode.id;
  const links = db
    .prepare(`SELECT * FROM task_episode_evidence WHERE task_episode_id = ?`)
    .all(episode.id);
  assert.equal(links.length, 1);
});

let correctionId: number;
test("correction review update: each action mutates the expected fields and sets reviewed", () => {
  const item = store.upsertHistoryItem({
    project_id: PROJECT,
    kind: "manual_note",
    content: "evidence for classification",
    provenance: "manual",
  }) as { id: number };

  const cc = store.createCorrectionCandidate({
    task_episode_id: episodeId,
    classification: "other",
    is_correction: true,
    summary: "initial guess",
    evidence_history_item_ids: [item.id],
  }) as { id: number; reviewed: number };
  correctionId = cc.id;
  assert.equal(cc.reviewed, 0);

  let updated = store.reviewCorrectionCandidate({
    id: correctionId,
    action: "reclassify",
    classification: "constraint_restatement",
  }) as Record<string, unknown>;
  assert.equal(updated.classification, "constraint_restatement");
  assert.equal(updated.reviewed, 1);

  updated = store.reviewCorrectionCandidate({
    id: correctionId,
    action: "mark_reusable",
  }) as Record<string, unknown>;
  assert.equal(updated.reusable, 1);

  updated = store.reviewCorrectionCandidate({
    id: correctionId,
    action: "change_scope",
    proposed_scope: "project",
  }) as Record<string, unknown>;
  assert.equal(updated.proposed_scope, "project");

  updated = store.reviewCorrectionCandidate({ id: correctionId, action: "exclude" }) as Record<
    string,
    unknown
  >;
  assert.equal(updated.excluded_from_learning, 1);
});

let ruleId: number;
test("rule edit creating a revision: instruction change is versioned, no-op change is not", () => {
  const learning = store.createLearning({
    correction_candidate_id: correctionId,
    observed_problem: "background worker polled every minute",
    desired_behavior: "no autonomous schedule without explicit user opt-in",
    reuse_rationale: "same failure mode applies to any future background job",
    proposed_scope: "workspace",
    provenance: "llm_derived",
    created_by: "claude-checkpoint-b",
  }) as { id: number };

  const rule = store.createRule({
    learning_id: learning.id,
    correction_candidate_id: correctionId,
    instruction:
      "Never schedule a credit- or token-spending job more often than the user explicitly requests.",
    scope: "workspace",
    applies_when: "adding any pg_cron job or other recurring background trigger",
    predicted_failure:
      "an autonomous high-frequency job runs unattended and the user rejects it after the fact",
    ownership: "harness",
    created_by: "claude-checkpoint-b",
  }) as { id: number; state: string };
  ruleId = rule.id;
  assert.equal(rule.state, "proposed");

  const revisedInstruction =
    "Never schedule a credit- or token-spending job more often than weekly by default.";
  const edited = store.updateRule({
    id: ruleId,
    instruction: revisedInstruction,
    actor: "operator",
    reason: "tighten wording",
  }) as { instruction: string };
  assert.equal(edited.instruction, revisedInstruction);

  let revisions = db.prepare(`SELECT * FROM rule_revisions WHERE rule_id = ?`).all(ruleId);
  assert.equal(revisions.length, 1);

  // No-op update (same instruction, same state) must not create a second revision.
  store.updateRule({ id: ruleId, instruction: revisedInstruction, actor: "operator" });
  revisions = db.prepare(`SELECT * FROM rule_revisions WHERE rule_id = ?`).all(ruleId);
  assert.equal(revisions.length, 1);
});

test("approval does not produce a Lovable action: local-only by construction, DB reflects it", () => {
  const source = readFileSync(new URL("../src/store.ts", import.meta.url), "utf8");
  const code = source
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  // "lovable_project_id" etc. are plain string/field names, not imports or calls --
  // the real check is that no import statement or network call touches Lovable.
  assert.ok(
    !/^\s*import.*lovable/im.test(code),
    "store.ts must not import anything Lovable-related",
  );
  assert.ok(
    !/fetch\(|http\.request|https\.request/.test(code),
    "store.ts must not make network calls",
  );

  const approved = store.updateRule({ id: ruleId, state: "approved", actor: "operator" }) as {
    state: string;
  };
  assert.equal(approved.state, "approved");

  const revisions = db.prepare(`SELECT * FROM rule_revisions WHERE rule_id = ?`).all(ruleId) as {
    new_state: string;
  }[];
  assert.equal(revisions.at(-1)?.new_state, "approved");
});

test("idempotent history-item upsert: same (project_id, kind, external_id) updates in place, not duplicates", () => {
  const first = store.upsertHistoryItem({
    project_id: PROJECT,
    kind: "message",
    external_id: "msg-idempotent-1",
    role: "user",
    content: "first version",
    provenance: "lovable_mcp",
  }) as { id: number };

  const second = store.upsertHistoryItem({
    project_id: PROJECT,
    kind: "message",
    external_id: "msg-idempotent-1",
    role: "user",
    content: "second version",
    provenance: "lovable_mcp",
  }) as { id: number; content: string };

  assert.equal(second.id, first.id);
  assert.equal(second.content, "second version");

  const count = (
    db
      .prepare(
        `SELECT COUNT(*) as n FROM history_items WHERE project_id = ? AND kind = 'message' AND external_id = ?`,
      )
      .get(PROJECT, "msg-idempotent-1") as { n: number }
  ).n;
  assert.equal(count, 1);
});

test("get_rule / list_project_rules expose the full chain", () => {
  const full = store.getRule(ruleId) as {
    rule: { id: number };
    learning: unknown;
    correction_candidate: unknown;
  };
  assert.equal(full.rule.id, ruleId);
  assert.ok(full.learning);
  assert.ok(full.correction_candidate);

  const projectRules = store.listProjectRules(PROJECT) as { id: number }[];
  assert.ok(projectRules.some((r) => r.id === ruleId));
});

// ---- Checkpoint E (v5): settings, skill snapshots, sync runs/requests ----

test("v5 settings: defaults, validation, persistence", () => {
  assert.equal(store.getSetting("sync_interval_minutes"), "60");
  assert.deepEqual(store.getSettings().sync_window_start_hour, "10");
  const next = store.setSettings({
    sync_interval_minutes: "30",
    sync_window_start_hour: "8",
    sync_window_end_hour: "20",
  });
  assert.equal(next.sync_interval_minutes, "30");
  assert.throws(() => store.setSettings({ sync_interval_minutes: "5" }), /15/);
  assert.throws(
    () => store.setSettings({ sync_window_start_hour: "22", sync_window_end_hour: "10" }),
    /before/,
  );
  assert.throws(() => store.setSettings({ knowledge_char_cap: "20000" }), /10000/);
  assert.throws(() => store.setSettings({ sync_enabled: "yes" }), /true|false/);
});

test("v5 skill snapshots dedupe by content and return latest per name", () => {
  const a = store.recordSkillSnapshot({
    workspace_id: "ws1",
    name: "deploy",
    description: "d",
    content: "v1",
    updated_at_remote: null,
    fetched_by: "test",
  });
  const b = store.recordSkillSnapshot({
    workspace_id: "ws1",
    name: "deploy",
    description: "d",
    content: "v1",
    updated_at_remote: null,
    fetched_by: "test",
  });
  const c = store.recordSkillSnapshot({
    workspace_id: "ws1",
    name: "deploy",
    description: "d",
    content: "v2",
    updated_at_remote: null,
    fetched_by: "test",
  });
  assert.equal(a.inserted, true);
  assert.equal(b.inserted, false);
  assert.equal(c.inserted, true);
  const latest = store.latestSkillSnapshots("ws1");
  assert.equal(latest.length, 1);
  assert.equal(latest[0]!.content, "v2");
});

test("v5 sync runs and requests", () => {
  assert.equal(store.latestSyncRun(), null);
  const r1 = store.requestSync();
  const r2 = store.requestSync();
  assert.equal(r1.created, true);
  assert.equal(r2.created, false);
  assert.equal(r1.id, r2.id);
  const run = store.startSyncRun("manual");
  assert.ok(store.runningSyncRun());
  assert.equal(store.takeSyncRequest(run), r1.id);
  assert.equal(store.takeSyncRequest(run), null);
  store.completeSyncRequest(r1.id);
  store.finishSyncRun(run, { ok: true, counts: { messages: 3 } });
  assert.equal(store.runningSyncRun(), null);
  assert.deepEqual(store.latestSyncRun()?.counts, { messages: 3 });
});

test("v5 allow/disallow project and history stats", () => {
  store.allowProject("p-new", "New");
  assert.ok(
    store
      .getAllowedProjects()
      .some((p) => (p as { lovable_project_id: string }).lovable_project_id === "p-new"),
  );
  store.upsertHistoryItem({
    project_id: "p-new",
    kind: "message",
    external_id: "m1",
    role: "user",
    content: "hi",
    occurred_at: "2026-09-11T10:00:00Z",
    provenance: "manual",
  });
  assert.equal(store.countHistoryItemsAwaitingAnalysis() >= 1, true);
  assert.ok(store.latestHistoryExternalIds("p-new", 10).has("m1"));
  assert.equal(store.listHistoryStats().find((s) => s.project_id === "p-new")?.history_count, 1);
  store.disallowProject("p-new");
  assert.ok(
    !store
      .getAllowedProjects()
      .some((p) => (p as { lovable_project_id: string }).lovable_project_id === "p-new"),
  );
  // Disallowing only stops future reads: the ledger keeps what it already
  // recorded, so the history row must survive the FK-pragma delete.
  const remaining = db
    .prepare(`SELECT COUNT(*) n FROM history_items WHERE project_id = ?`)
    .get("p-new") as { n: number };
  assert.equal(remaining.n, 1);
});

// ---- Round 3 (v8): AI-analysis settings, per-project settings, llm_calls ----

test("v9 settings: llm_provider/llm_models/llm_monthly_token_budget/rule_unused_after_days/max_active_rules defaults and validation", () => {
  assert.equal(store.getSetting("llm_provider"), "openai");
  assert.equal(store.getSetting("llm_monthly_token_budget"), "2000000");
  assert.equal(store.getSetting("rule_unused_after_days"), "60");
  assert.equal(store.getSetting("max_active_rules"), "12");
  const defaultModels = JSON.parse(store.getSetting("llm_models"));
  assert.deepEqual(Object.keys(defaultModels).sort(), [
    "classifier",
    "judge",
    "proposer",
    "reviewer",
    "rule_writer",
  ]);
  assert.deepEqual(defaultModels.classifier, { provider: "openai", model: "gpt-5.4-mini" });
  assert.deepEqual(defaultModels.rule_writer, { provider: "openai", model: "gpt-5.5" });
  assert.deepEqual(defaultModels.judge, { provider: "openai", model: "gpt-5.4-mini" });

  assert.throws(
    () => store.setSettings({ llm_provider: "cohere" }),
    /openai|anthropic|google|claude_code/,
  );
  const okProvider = store.setSettings({ llm_provider: "anthropic" });
  assert.equal(okProvider.llm_provider, "anthropic");
  // claude_code (the local CLI / subscription provider) is an allowed value too.
  assert.equal(store.setSettings({ llm_provider: "claude_code" }).llm_provider, "claude_code");
  store.setSettings({ llm_provider: "openai" });

  assert.throws(
    () => store.setSettings({ llm_monthly_token_budget: "99999" }),
    /100000.*50000000|between/,
  );
  assert.throws(
    () => store.setSettings({ llm_monthly_token_budget: "50000001" }),
    /100000.*50000000|between/,
  );
  assert.equal(
    store.setSettings({ llm_monthly_token_budget: "3000000" }).llm_monthly_token_budget,
    "3000000",
  );

  assert.throws(() => store.setSettings({ rule_unused_after_days: "6" }), /7.*365|between/);
  assert.throws(() => store.setSettings({ rule_unused_after_days: "366" }), /7.*365|between/);
  assert.equal(store.setSettings({ rule_unused_after_days: "90" }).rule_unused_after_days, "90");

  // llm_monthly_budget_usd no longer exists as a setting at all.
  assert.ok(!("llm_monthly_budget_usd" in store.getSettings()));

  assert.throws(() => store.setSettings({ max_active_rules: "0" }), /1.*50|between/);
  assert.throws(() => store.setSettings({ max_active_rules: "51" }), /1.*50|between/);
  assert.equal(store.setSettings({ max_active_rules: "20" }).max_active_rules, "20");

  assert.throws(() => store.setSettings({ llm_models: "not json" }), /json/i);
  assert.throws(
    () =>
      store.setSettings({
        llm_models: JSON.stringify({ classifier: { provider: "openai", model: "x" } }),
      }),
    /classifier|rule_writer|reviewer|proposer|roles/i,
  );
  assert.throws(
    () =>
      store.setSettings({
        llm_models: JSON.stringify({
          classifier: { provider: "not-a-provider", model: "x" },
          rule_writer: { provider: "openai", model: "x" },
          reviewer: { provider: "openai", model: "x" },
          proposer: { provider: "openai", model: "x" },
        }),
      }),
    /provider/i,
  );
  assert.throws(
    () =>
      store.setSettings({
        llm_models: JSON.stringify({
          classifier: { provider: "openai", model: "" },
          rule_writer: { provider: "openai", model: "x" },
          reviewer: { provider: "openai", model: "x" },
          proposer: { provider: "openai", model: "x" },
        }),
      }),
    /model/i,
  );
  // Round 5 Task 1: a payload missing rule_writer/reviewer/etc is rejected
  // (still missing a required role) even if it uses the old "miner" name
  // for what should be rule_writer -- "miner" is simply not a role.
  assert.throws(
    () =>
      store.setSettings({
        llm_models: JSON.stringify({
          classifier: { provider: "openai", model: "x" },
          miner: { provider: "openai", model: "x" },
          reviewer: { provider: "openai", model: "x" },
          proposer: { provider: "openai", model: "x" },
        }),
      }),
    /must define at least the roles/,
  );
  // And once every required role is genuinely present, a leftover/unknown
  // "miner" key alongside them is rejected outright -- it's not silently
  // accepted or auto-migrated (only migration v11's one-time settings-row
  // rewrite handles the old key, and only for its own literal string).
  assert.throws(
    () =>
      store.setSettings({
        llm_models: JSON.stringify({
          classifier: { provider: "openai", model: "x" },
          rule_writer: { provider: "openai", model: "x" },
          reviewer: { provider: "openai", model: "x" },
          proposer: { provider: "openai", model: "x" },
          miner: { provider: "openai", model: "x" },
        }),
      }),
    /unknown role "miner"/,
  );
  const goodModels = {
    classifier: { provider: "anthropic", model: "claude-x" },
    rule_writer: { provider: "openai", model: "gpt-x" },
    reviewer: { provider: "google", model: "gemini-x" },
    proposer: { provider: "openai", model: "gpt-x" },
  };
  // "judge" is optional: a payload missing it entirely is accepted.
  const updated = store.setSettings({ llm_models: JSON.stringify(goodModels) });
  assert.deepEqual(JSON.parse(updated.llm_models), goodModels);

  // A role's provider may be claude_code (no API key needed).
  const withClaudeCode = {
    ...goodModels,
    classifier: { provider: "claude_code", model: "haiku" },
  };
  const updated2 = store.setSettings({ llm_models: JSON.stringify(withClaudeCode) });
  assert.deepEqual(JSON.parse(updated2.llm_models), withClaudeCode);

  // A payload that does include judge is accepted and stored as-is too.
  const withJudge = { ...goodModels, judge: { provider: "openai", model: "gpt-judge" } };
  const updated3 = store.setSettings({ llm_models: JSON.stringify(withJudge) });
  assert.deepEqual(JSON.parse(updated3.llm_models), withJudge);

  store.setSettings({ llm_models: JSON.stringify(goodModels) });

  // A rejected patch leaves every existing setting untouched.
  const before = store.getSettings();
  assert.throws(() => store.setSettings({ max_active_rules: "999", llm_provider: "openai" }));
  assert.deepEqual(store.getSettings(), before);
});

test("v8 project settings: defaults, override, effective max, validation", () => {
  store.allowProject("ps-project", "Project settings test");
  assert.deepEqual(store.getProjectSettings("ps-project"), {
    max_active_rules: null,
    auto_write: true,
  });
  assert.equal(
    store.effectiveMaxActiveRules("ps-project"),
    Number(store.getSetting("max_active_rules")),
  );

  const patched = store.setProjectSettings("ps-project", {
    max_active_rules: 3,
    auto_write: false,
  });
  assert.deepEqual(patched, { max_active_rules: 3, auto_write: false });
  assert.deepEqual(store.getProjectSettings("ps-project"), {
    max_active_rules: 3,
    auto_write: false,
  });
  assert.equal(store.effectiveMaxActiveRules("ps-project"), 3);

  // Partial patch only touches the given fields.
  store.setProjectSettings("ps-project", { auto_write: true });
  assert.deepEqual(store.getProjectSettings("ps-project"), {
    max_active_rules: 3,
    auto_write: true,
  });

  // null clears the override back to "use the default".
  store.setProjectSettings("ps-project", { max_active_rules: null });
  assert.equal(store.getProjectSettings("ps-project").max_active_rules, null);
  assert.equal(
    store.effectiveMaxActiveRules("ps-project"),
    Number(store.getSetting("max_active_rules")),
  );

  assert.throws(
    () => store.setProjectSettings("ps-project", { max_active_rules: 0 }),
    /1.*50|between/,
  );
  assert.throws(
    () => store.setProjectSettings("ps-project", { max_active_rules: 51 }),
    /1.*50|between/,
  );
  assert.throws(
    () => store.setProjectSettings("not-allowed-project", { auto_write: false }),
    store.NotAllowedProjectError,
  );
});

test("v8 llm_calls: insert, sum this month, list", () => {
  assert.equal(store.sumLlmCostThisMonth(), 0);
  store.insertLlmCall({
    role: "classifier",
    provider: "openai",
    model: "gpt-5.4-mini",
    tokens_in: 100,
    tokens_out: 20,
    cost_usd: 0.02,
  });
  store.insertLlmCall({
    role: "rule_writer",
    provider: "openai",
    model: "gpt-5.5",
    tokens_in: 500,
    tokens_out: 200,
    cost_usd: 0.5,
  });
  assert.ok(Math.abs(store.sumLlmCostThisMonth() - 0.52) < 1e-9);
  const calls = store.listLlmCalls(10) as { role: string; provider: string; model: string }[];
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.role, "rule_writer"); // most recent first
});

// ---- Round 4 (v9): estimated_tokens/run_id on llm_calls, token-budget sum ----

test("v9 llm_calls: estimated_tokens/run_id columns, sumLlmTokensThisMonth", () => {
  const before = store.sumLlmTokensThisMonth();
  store.insertLlmCall({
    role: "classifier",
    provider: "claude_code",
    model: "sonnet",
    tokens_in: 300,
    tokens_out: 40,
    estimated_tokens: 1800,
    run_id: 7,
  });
  store.insertLlmCall({
    role: "rule_writer",
    provider: "openai",
    model: "gpt-5.5",
    tokens_in: 900,
    tokens_out: 150,
    cost_usd: 0.01,
  });
  assert.equal(store.sumLlmTokensThisMonth() - before, 300 + 40 + 900 + 150);
  const calls = store.listLlmCalls(10) as {
    role: string;
    estimated_tokens: number;
    run_id: number | null;
    cost_usd: number;
  }[];
  const claudeCodeCall = calls.find((c) => c.role === "classifier")!;
  assert.equal(claudeCodeCall.estimated_tokens, 1800);
  assert.equal(claudeCodeCall.run_id, 7);
  assert.equal(claudeCodeCall.cost_usd, 0); // no cost_usd given -> defaults to 0, not null (column is NOT NULL)
  const ruleWriterCall = calls.find((c) => c.role === "rule_writer")!;
  assert.equal(ruleWriterCall.estimated_tokens, 0); // defaults to 0 when omitted
  assert.equal(ruleWriterCall.run_id, null);
});

test("v9 rules.scope_tags_json: defaults to general, existing rows backfilled", () => {
  const cols = (db.prepare(`PRAGMA table_info(rules)`).all() as { name: string }[]).map(
    (c) => c.name,
  );
  assert.ok(cols.includes("scope_tags_json"));
  const row = db.prepare(`SELECT scope_tags_json FROM rules WHERE id = ?`).get(ruleId) as {
    scope_tags_json: string;
  };
  assert.deepEqual(JSON.parse(row.scope_tags_json), ["general"]);
});

test("v9 new tables: message_classifications, analysis_requests/runs, rule_health, retire_proposals enforce their CHECK constraints", () => {
  db.prepare(
    `INSERT INTO history_items (project_id, external_id, kind, role, content, occurred_at, provenance)
     VALUES (?, ?, 'message', 'user', 'hi', datetime('now'), 'manual')`,
  ).run(PROJECT, `mc-${ruleId}`);
  const hi = db
    .prepare(`SELECT id FROM history_items WHERE external_id = ?`)
    .get(`mc-${ruleId}`) as {
    id: number;
  };

  db.prepare(
    `INSERT INTO message_classifications (history_item_id, classification) VALUES (?, 'correction')`,
  ).run(hi.id);
  assert.throws(() =>
    db
      .prepare(
        `INSERT INTO message_classifications (history_item_id, classification) VALUES (?, 'bogus')`,
      )
      .run(hi.id),
  );

  const run = db
    .prepare(`INSERT INTO analysis_runs (kind) VALUES ('manual') RETURNING id`)
    .get() as { id: number };
  db.prepare(`INSERT INTO analysis_requests (run_id) VALUES (?)`).run(run.id);
  assert.throws(() => db.prepare(`INSERT INTO analysis_requests (status) VALUES ('bogus')`).run());

  db.prepare(`INSERT INTO rule_health (rule_id) VALUES (?)`).run(ruleId);
  const health = db.prepare(`SELECT * FROM rule_health WHERE rule_id = ?`).get(ruleId) as {
    status: string;
    applicable_tasks: number;
  };
  assert.equal(health.status, "healthy");
  assert.equal(health.applicable_tasks, 0);
  assert.throws(() =>
    db.prepare(`INSERT INTO rule_health (rule_id, status) VALUES (999999, 'bogus')`).run(),
  );

  db.prepare(`INSERT INTO retire_proposals (rule_id, reason) VALUES (?, 'unused')`).run(ruleId);
  assert.throws(() =>
    db.prepare(`INSERT INTO retire_proposals (rule_id, reason) VALUES (?, 'bogus')`).run(ruleId),
  );
});

// ---- Round 5 Task 1: migration v11, settings, verdicts/adherence, feedback/evidence reads ----

test("v11 migration (round5_feedback_evidence): correction_candidates gets skip_reason/decided_by, rule_verdicts/rule_adherence tables exist, and a v10 llm_models value's miner key is rewritten to rule_writer", async () => {
  const { default: Database } = await import("better-sqlite3");
  const { MIGRATIONS } = await import("../src/migrations.js");

  const tmpDb = new Database(":memory:");
  tmpDb.pragma("foreign_keys = ON");
  const upToV10 = [...MIGRATIONS]
    .filter((m) => m.version <= 10)
    .sort((a, b) => a.version - b.version);
  for (const m of upToV10) tmpDb.exec(m.sql);

  // Seed a pre-round-5 settings row exactly like a real deployment's: old
  // role name "miner", no "judge" entry at all.
  const oldModels = {
    classifier: { provider: "openai", model: "gpt-5.4-mini" },
    miner: { provider: "openai", model: "gpt-5.5" },
    reviewer: { provider: "openai", model: "gpt-5.5" },
    proposer: { provider: "openai", model: "gpt-5.5" },
  };
  tmpDb
    .prepare(`INSERT INTO settings (key, value) VALUES ('llm_models', ?)`)
    .run(JSON.stringify(oldModels));

  const v11 = MIGRATIONS.find((m) => m.version === 11)!;
  tmpDb.exec(v11.sql);

  const row = tmpDb.prepare(`SELECT value FROM settings WHERE key = 'llm_models'`).get() as {
    value: string;
  };
  const rewritten = JSON.parse(row.value);
  assert.deepEqual(Object.keys(rewritten).sort(), [
    "classifier",
    "proposer",
    "reviewer",
    "rule_writer",
  ]);
  assert.deepEqual(rewritten.rule_writer, { provider: "openai", model: "gpt-5.5" });
  assert.ok(!("miner" in rewritten), "the old miner key is gone");
  assert.ok(
    !("judge" in rewritten),
    "migration v11 never invents a judge entry in SQL -- getLlmModels resolves it by fallback",
  );

  const ccCols = (
    tmpDb.prepare(`PRAGMA table_info(correction_candidates)`).all() as { name: string }[]
  ).map((c) => c.name);
  assert.ok(ccCols.includes("skip_reason"));
  assert.ok(ccCols.includes("decided_by"));

  tmpDb
    .prepare(
      `INSERT INTO allowed_projects (lovable_project_id, label) VALUES ('v11-test-project', 'p')`,
    )
    .run();
  tmpDb
    .prepare(
      `INSERT INTO task_episodes (project_id, title, provenance) VALUES ('v11-test-project', 'e', 'manual')`,
    )
    .run();
  const ep = tmpDb.prepare(`SELECT id FROM task_episodes`).get() as { id: number };
  tmpDb
    .prepare(
      `INSERT INTO correction_candidates (task_episode_id, classification, is_correction, summary) VALUES (?, 'other', 1, 's')`,
    )
    .run(ep.id);
  const cc = tmpDb.prepare(`SELECT id FROM correction_candidates`).get() as { id: number };
  assert.doesNotThrow(() =>
    tmpDb
      .prepare(
        `UPDATE correction_candidates SET skip_reason = 'not_useful', decided_by = 'automatic' WHERE id = ?`,
      )
      .run(cc.id),
  );
  assert.throws(() =>
    tmpDb.prepare(`UPDATE correction_candidates SET skip_reason = 'bogus' WHERE id = ?`).run(cc.id),
  );

  const rvCols = (
    tmpDb.prepare(`PRAGMA table_info(rule_verdicts)`).all() as { name: string }[]
  ).map((c) => c.name);
  assert.deepEqual(rvCols.sort(), ["created_at", "id", "note", "rule_id", "verdict"].sort());
  const raCols = (
    tmpDb.prepare(`PRAGMA table_info(rule_adherence)`).all() as { name: string }[]
  ).map((c) => c.name);
  assert.deepEqual(
    raCols.sort(),
    [
      "created_at",
      "id",
      "llm_call_id",
      "quote",
      "rule_id",
      "run_id",
      "task_episode_id",
      "verdict",
    ].sort(),
  );

  tmpDb.close();
});

test("v11 settings: decision_mode/decision_auto_confidence/evidence_sources defaults and validation", () => {
  assert.equal(store.getSetting("decision_mode"), "ask");
  assert.equal(store.getSetting("decision_auto_confidence"), "0.8");
  assert.deepEqual(JSON.parse(store.getSetting("evidence_sources")), {
    observed: true,
    adherence: true,
    verdicts: true,
    paired: false,
  });

  assert.throws(() => store.setSettings({ decision_mode: "sometimes" }), /"ask" or "automatic"/);
  assert.equal(store.setSettings({ decision_mode: "automatic" }).decision_mode, "automatic");
  store.setSettings({ decision_mode: "ask" });

  assert.throws(() => store.setSettings({ decision_auto_confidence: "0.4" }), /0\.5.*1|between/);
  assert.equal(
    store.setSettings({ decision_auto_confidence: "0.5" }).decision_auto_confidence,
    "0.5",
  );
  assert.equal(store.setSettings({ decision_auto_confidence: "1" }).decision_auto_confidence, "1");
  assert.throws(() => store.setSettings({ decision_auto_confidence: "1.1" }), /0\.5.*1|between/);
  assert.equal(
    store.setSettings({ decision_auto_confidence: "0.8" }).decision_auto_confidence,
    "0.8",
  );

  assert.throws(() => store.setSettings({ evidence_sources: "not json" }), /json/i);
  assert.throws(
    () =>
      store.setSettings({
        evidence_sources: JSON.stringify({ observed: true, adherence: true, verdicts: true }),
      }),
    /observed|adherence|verdicts|paired/i,
  );
  assert.throws(
    () =>
      store.setSettings({
        evidence_sources: JSON.stringify({
          observed: "yes",
          adherence: true,
          verdicts: true,
          paired: false,
        }),
      }),
    /boolean/i,
  );
  const customSources = { observed: false, adherence: true, verdicts: false, paired: true };
  const updated = store.setSettings({ evidence_sources: JSON.stringify(customSources) });
  assert.deepEqual(JSON.parse(updated.evidence_sources), customSources);
  assert.deepEqual(store.getEvidenceSources(), customSources);

  // restore the default for later tests/assertions in this file
  store.setSettings({
    evidence_sources: JSON.stringify({
      observed: true,
      adherence: true,
      verdicts: true,
      paired: false,
    }),
  });
});

test("getLlmModels: judge falls back to the rule_writer entry when absent from the stored llm_models value, and is read as-is when present", () => {
  const withoutJudge = {
    classifier: { provider: "anthropic", model: "claude-classify" },
    rule_writer: { provider: "google", model: "gemini-write" },
    reviewer: { provider: "openai", model: "gpt-review" },
    proposer: { provider: "openai", model: "gpt-propose" },
  };
  store.setSettings({ llm_models: JSON.stringify(withoutJudge) });
  const resolved = store.getLlmModels();
  assert.deepEqual(resolved.judge, withoutJudge.rule_writer);
  assert.deepEqual(resolved.rule_writer, withoutJudge.rule_writer);
  assert.deepEqual(resolved.classifier, withoutJudge.classifier);
  assert.deepEqual(resolved.reviewer, withoutJudge.reviewer);
  assert.deepEqual(resolved.proposer, withoutJudge.proposer);

  const withJudge = { ...withoutJudge, judge: { provider: "openai", model: "gpt-judge" } };
  store.setSettings({ llm_models: JSON.stringify(withJudge) });
  assert.deepEqual(store.getLlmModels().judge, withJudge.judge);

  // restore the full default set (this file's other llm_models assertions
  // expect it) for later tests in this file
  store.setSettings({ llm_models: store.SETTING_DEFAULTS.llm_models });
});

// ---- fixtures shared by the verdict/adherence/feedback tests below ----

const R5_PROJECT = "round5-task1-project";

function r5CreateRule(instruction: string): number {
  const msg = store.upsertHistoryItem({
    project_id: R5_PROJECT,
    kind: "message",
    role: "user",
    content: `seed message for: ${instruction}`,
    provenance: "manual",
  }) as { id: number };
  const episode = store.createTaskEpisode({
    project_id: R5_PROJECT,
    title: "round5 task1 fixture",
    provenance: "manual",
    evidence_history_item_ids: [msg.id],
  }) as { id: number };
  const candidate = store.createCorrectionCandidate({
    task_episode_id: episode.id,
    classification: "constraint_restatement",
    is_correction: true,
    reusable: true,
    proposed_scope: "project",
    summary: "seed",
    evidence_history_item_ids: [msg.id],
  }) as { id: number };
  const learning = store.createLearning({
    correction_candidate_id: candidate.id,
    observed_problem: "seed",
    desired_behavior: instruction,
    reuse_rationale: "seed",
    proposed_scope: "project",
    provenance: "manual",
    created_by: "round5 task1 test seed",
  }) as { id: number };
  const rule = store.createRule({
    learning_id: learning.id,
    correction_candidate_id: candidate.id,
    instruction,
    scope: "project",
    applies_when: "seed",
    predicted_failure: "seed",
    ownership: "user",
    created_by: "round5 task1 test seed",
  }) as { id: number };
  return rule.id;
}

function r5CreateEpisode(startedAt: string): number {
  const episode = store.createTaskEpisode({
    project_id: R5_PROJECT,
    title: "round5 task1 episode fixture",
    provenance: "manual",
    started_at: startedAt,
  }) as { id: number };
  return episode.id;
}

test("recordRuleVerdict/latestRuleVerdict/listRuleVerdicts: newest verdict wins, full history is kept", () => {
  store.allowProject(R5_PROJECT, "Round 5 Task 1 fixtures");
  const ruleId2 = r5CreateRule("Always seed round5 task1 rule fixtures identically.");

  assert.equal(store.latestRuleVerdict(ruleId2), null);
  assert.deepEqual(store.listRuleVerdicts(ruleId2), []);

  const first = store.recordRuleVerdict({ rule_id: ruleId2, verdict: "not_sure" });
  assert.equal(typeof first.id, "number");
  const second = store.recordRuleVerdict({
    rule_id: ruleId2,
    verdict: "helped",
    note: "confirmed on the next task",
  });

  const latest = store.latestRuleVerdict(ruleId2);
  assert.equal(latest?.id, second.id);
  assert.equal(latest?.verdict, "helped");
  assert.equal(latest?.note, "confirmed on the next task");

  const all = store.listRuleVerdicts(ruleId2);
  assert.deepEqual(
    all.map((v) => v.id),
    [second.id, first.id],
    "newest first",
  );
  assert.equal(all[1]!.note, null);
});

test("recordRuleAdherence: unique (rule, episode) pair -- a second insert is ignored, not duplicated -- and adherenceCounts tallies by verdict", () => {
  const ruleId3 = r5CreateRule("Always keep adherence fixtures independent of verdict fixtures.");
  const episodeA = r5CreateEpisode("2026-09-05T00:00:00.000Z");
  const episodeB = r5CreateEpisode("2026-09-05T00:01:00.000Z");
  const episodeC = r5CreateEpisode("2026-09-05T00:02:00.000Z");

  store.recordRuleAdherence({
    rule_id: ruleId3,
    task_episode_id: episodeA,
    verdict: "followed",
    quote: "did the thing",
    llm_call_id: null,
    run_id: null,
  });
  store.recordRuleAdherence({
    rule_id: ruleId3,
    task_episode_id: episodeB,
    verdict: "broke",
    quote: null,
    llm_call_id: null,
    run_id: null,
  });
  store.recordRuleAdherence({
    rule_id: ruleId3,
    task_episode_id: episodeC,
    verdict: "not_applicable",
    quote: null,
    llm_call_id: null,
    run_id: null,
  });

  // Re-judging the same (rule, episode) pair with a different verdict is a
  // no-op insert -- the original verdict stands.
  store.recordRuleAdherence({
    rule_id: ruleId3,
    task_episode_id: episodeA,
    verdict: "broke",
    quote: "changed my mind",
    llm_call_id: null,
    run_id: null,
  });

  const counts = store.adherenceCounts(ruleId3);
  assert.deepEqual(counts, { followed: 1, broke: 1, not_applicable: 1 });

  const list = store.listRuleAdherence(ruleId3);
  assert.equal(list.length, 3);
  const forA = list.find((r) => r.task_episode_id === episodeA);
  assert.equal(
    forA?.verdict,
    "followed",
    "the ignored duplicate did not overwrite the first verdict",
  );
  assert.equal(forA?.quote, "did the thing");
});

test("listUnjudgedEpisodesForRule: episodes after sinceIso with no rule_adherence row for this rule, excluding judged ones", () => {
  const ruleId4 = r5CreateRule("Always keep unjudged-episode fixtures independent of the others.");
  const before = r5CreateEpisode("2026-09-01T00:00:00.000Z");
  const judged = r5CreateEpisode("2026-09-06T00:00:00.000Z");
  const unjudged = r5CreateEpisode("2026-09-06T00:01:00.000Z");

  store.recordRuleAdherence({
    rule_id: ruleId4,
    task_episode_id: judged,
    verdict: "followed",
    quote: null,
    llm_call_id: null,
    run_id: null,
  });

  const result = store.listUnjudgedEpisodesForRule(
    ruleId4,
    "2026-09-05T00:00:00.000Z",
    R5_PROJECT,
    50,
  );
  const ids = result.map((e) => e.id);
  assert.ok(!ids.includes(before), "episodes at/before sinceIso are excluded");
  assert.ok(!ids.includes(judged), "an already-judged episode is excluded");
  assert.ok(ids.includes(unjudged), "an unjudged episode after sinceIso is included");
});

test("feedbackStats/listAcceptedRuleTexts/listSkippedSuggestions/listWordingEdits/tagAcceptanceRates: a scripted accept/skip/verdict scenario", () => {
  const before = store.feedbackStats();
  const beforeTagRates = store.tagAcceptanceRates();
  const TAG = "round5-task1-tag";

  function taggedEpisode(): { episodeId: number; msgId: number } {
    const msg = store.upsertHistoryItem({
      project_id: R5_PROJECT,
      kind: "message",
      role: "user",
      content: "tagged fixture message",
      provenance: "manual",
    }) as { id: number };
    store.insertMessageClassification({
      history_item_id: msg.id,
      classification: "correction",
      tags: [TAG],
      summary: "tagged fixture",
    });
    const episode = store.createTaskEpisode({
      project_id: R5_PROJECT,
      title: "tagged fixture episode",
      provenance: "manual",
      evidence_history_item_ids: [msg.id],
    }) as { id: number };
    return { episodeId: episode.id, msgId: msg.id };
  }

  // -- an accepted candidate, with a rule promoted to 'active' --
  const accepted = taggedEpisode();
  const acceptedCandidate = store.createCorrectionCandidate({
    task_episode_id: accepted.episodeId,
    classification: "constraint_restatement",
    is_correction: true,
    reusable: true,
    proposed_scope: "project",
    summary: "accepted fixture",
    evidence_history_item_ids: [accepted.msgId],
  }) as { id: number };
  db.prepare(
    `UPDATE correction_candidates SET reviewed = 1, reusable = 1, excluded_from_learning = 0, decided_by = 'user' WHERE id = ?`,
  ).run(acceptedCandidate.id);
  const acceptedLearning = store.createLearning({
    correction_candidate_id: acceptedCandidate.id,
    observed_problem: "seed",
    desired_behavior: "Always accept round5 task1 fixtures identically.",
    reuse_rationale: "seed",
    proposed_scope: "project",
    provenance: "manual",
    created_by: "round5 task1 test seed",
  }) as { id: number };
  const acceptedRule = store.createRule({
    learning_id: acceptedLearning.id,
    correction_candidate_id: acceptedCandidate.id,
    instruction: "Always accept round5 task1 fixtures identically.",
    scope: "project",
    applies_when: "seed",
    predicted_failure: "seed",
    ownership: "user",
    created_by: "round5 task1 test seed",
  }) as { id: number };
  store.updateRule({ id: acceptedRule.id, state: "active", actor: "test" });
  const revisedInstruction = "Always accept round5 task1 fixtures identically, revised.";
  store.updateRule({
    id: acceptedRule.id,
    instruction: revisedInstruction,
    actor: "test",
    reason: "round5 task1 wording edit fixture",
  });

  // -- a skipped candidate, with a skip reason and an automatic decision --
  const skipped = taggedEpisode();
  const skippedCandidate = store.createCorrectionCandidate({
    task_episode_id: skipped.episodeId,
    classification: "other",
    is_correction: false,
    summary: "skipped fixture",
    evidence_history_item_ids: [skipped.msgId],
  }) as { id: number };
  store.reviewCorrectionCandidate({ id: skippedCandidate.id, action: "exclude" });
  store.setCandidateSkipReason(skippedCandidate.id, "not_useful");
  store.setCandidateDecidedBy(skippedCandidate.id, "automatic");

  // -- two rule verdicts on the accepted rule --
  store.recordRuleVerdict({ rule_id: acceptedRule.id, verdict: "helped" });
  store.recordRuleVerdict({ rule_id: acceptedRule.id, verdict: "helped" });

  const after = store.feedbackStats();
  assert.equal(after.accepted - before.accepted, 1);
  assert.equal(after.skipped - before.skipped, 1);
  assert.equal(after.verdicts - before.verdicts, 2);
  assert.equal(after.automatic - before.automatic, 1);

  const acceptedTexts = store.listAcceptedRuleTexts(500);
  assert.ok(
    acceptedTexts.some((r) => r.instruction === revisedInstruction && r.scope === "project"),
    "the active, revised instruction appears in listAcceptedRuleTexts",
  );

  const skippedList = store.listSkippedSuggestions(500);
  const skippedEntry = skippedList.find((s) => s.summary === "skipped fixture");
  assert.ok(skippedEntry, "the skipped candidate appears in listSkippedSuggestions");
  assert.equal(skippedEntry!.skip_reason, "not_useful");
  assert.equal(
    skippedEntry!.instruction,
    null,
    "no rule was ever created for the skipped candidate",
  );

  const wordingEdits = store.listWordingEdits(500);
  assert.ok(
    wordingEdits.some(
      (w) =>
        w.to === revisedInstruction &&
        w.from === "Always accept round5 task1 fixtures identically.",
    ),
    "the instruction change appears in listWordingEdits",
  );

  const afterTagRates = store.tagAcceptanceRates();
  const beforeTag = beforeTagRates[TAG] ?? { accepted: 0, skipped: 0 };
  const afterTag = afterTagRates[TAG];
  assert.ok(afterTag, "the fixture's tag appears in tagAcceptanceRates");
  assert.equal(afterTag!.accepted - beforeTag.accepted, 1);
  assert.equal(afterTag!.skipped - beforeTag.skipped, 1);
});
// ---- end Round 5 Task 1 ----
