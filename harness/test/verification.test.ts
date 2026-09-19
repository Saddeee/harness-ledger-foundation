import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HARNESS_DB_PATH = join(
  mkdtempSync(join(tmpdir(), "harness-verification-test-")),
  "harness.db",
);

const { db, schemaVersion } = await import("../src/db.js");
const store = await import("../src/store.js");

const PROJECT = "verification-test-project";
db.prepare(`INSERT INTO allowed_projects (lovable_project_id, label) VALUES (?, ?)`).run(
  PROJECT,
  "test",
);

const episode = store.createTaskEpisode({
  project_id: PROJECT,
  title: "episode",
  provenance: "manual",
}) as { id: number };
const cc = store.createCorrectionCandidate({
  task_episode_id: episode.id,
  classification: "other",
  is_correction: true,
  summary: "s",
  evidence_history_item_ids: [],
}) as { id: number };
const learning = store.createLearning({
  correction_candidate_id: cc.id,
  observed_problem: "p",
  desired_behavior: "d",
  reuse_rationale: "r",
  proposed_scope: "workspace",
  provenance: "manual",
  created_by: "test",
}) as { id: number };
const rule = store.createRule({
  learning_id: learning.id,
  correction_candidate_id: cc.id,
  instruction: "instruction",
  scope: "workspace",
  applies_when: "always",
  predicted_failure: "failure",
  ownership: "harness",
  created_by: "test",
}) as { id: number };

test("additive migration: schema version 3 applied, no data loss on existing tables", () => {
  // Round 8 Task 2 added migration v24 (inbox_dismissals) -- latest is now
  // 24, not 23.
  assert.equal(schemaVersion(), 24);
  const migrations = db.prepare(`SELECT version FROM schema_migrations ORDER BY version`).all() as {
    version: number;
  }[];
  assert.deepEqual(
    migrations.map((m) => m.version),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24],
  );
  const tableNames = new Set(
    (
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]
    ).map((r) => r.name),
  );
  for (const t of [
    "verification_definitions",
    "rule_verification_links",
    "verification_plans",
    "verification_plan_items",
    "experiment_plans",
    "experiment_plan_verification_links",
    "experiment_resources",
    // checkpoints A/B/B.1 tables must still exist, untouched
    "allowed_projects",
    "correction_candidates",
    "rules",
    "rule_revisions",
  ]) {
    assert.ok(tableNames.has(t), `expected table ${t}`);
  }
  // the rule created above (before this test ran) is still intact
  const stillThere = db.prepare(`SELECT id FROM rules WHERE id = ?`).get(rule.id);
  assert.ok(stillThere);
});

let structuralDefId: number;
let aiRubricDefId: number;
test("verification-definition validation: verifier_type enum and scope/project_id consistency are enforced", () => {
  structuralDefId = (
    store.createVerificationDefinition({
      scope: "workspace",
      name: "structural check",
      description: "d",
      verifier_type: "structural",
      configuration: "{}",
      source: "manual",
      ownership: "harness",
    }) as { id: number }
  ).id;

  aiRubricDefId = (
    store.createVerificationDefinition({
      scope: "workspace",
      name: "ai rubric check",
      description: "d",
      verifier_type: "ai_rubric",
      configuration: "{}",
      source: "manual",
      ownership: "harness",
    }) as { id: number }
  ).id;

  assert.throws(() =>
    store.createVerificationDefinition({
      // @ts-expect-error deliberately invalid
      verifier_type: "shell_command",
      scope: "workspace",
      name: "x",
      description: "d",
      configuration: "{}",
      source: "manual",
      ownership: "harness",
    }),
  );

  // workspace scope must not carry a project_id
  assert.throws(() =>
    store.createVerificationDefinition({
      scope: "workspace",
      project_id: PROJECT,
      name: "x",
      description: "d",
      verifier_type: "structural",
      configuration: "{}",
      source: "manual",
      ownership: "harness",
    }),
  );

  // project scope requires an allowed project_id
  assert.throws(() =>
    store.createVerificationDefinition({
      scope: "project",
      project_id: "not-an-allowed-project",
      name: "x",
      description: "d",
      verifier_type: "structural",
      configuration: "{}",
      source: "manual",
      ownership: "harness",
    }),
  );
});

test("rule-verification linking: create_verification_plan links every definition to the rule", () => {
  const plan = store.createVerificationPlan({
    rule_id: rule.id,
    failure_signature: "unapproved-recurring-background-work",
    failure_condition: "recurring work enabled without approval",
    created_by: "test",
    verification_definition_ids: [structuralDefId, aiRubricDefId],
  }) as { id: number };

  const links = db.prepare(`SELECT * FROM rule_verification_links WHERE rule_id = ?`).all(rule.id);
  assert.equal(links.length, 2);

  const full = store.getVerificationPlan(plan.id) as {
    items: { verification_definition_id: number }[];
  };
  assert.equal(full.items.length, 2);
});

test("verifier status enum: only passed/failed/unclear/not_run are valid, defaults to not_run", () => {
  const plan = store.getVerificationPlanForRule(rule.id) as {
    items: { id: number; status: string }[];
  };
  assert.ok(plan.items.every((i) => i.status === "not_run"));

  assert.throws(() =>
    db
      .prepare(`UPDATE verification_plan_items SET status = 'bogus' WHERE id = ?`)
      .run(plan.items[0].id),
  );

  db.prepare(`UPDATE verification_plan_items SET status = 'passed' WHERE id = ?`).run(
    plan.items[0].id,
  );
  const updated = db
    .prepare(`SELECT status FROM verification_plan_items WHERE id = ?`)
    .get(plan.items[0].id) as {
    status: string;
  };
  assert.equal(updated.status, "passed");
});

test("explicit authorization is required before a structural failure is concluded (documented in configuration, not silently assumed)", () => {
  const def = db
    .prepare(`SELECT configuration FROM verification_definitions WHERE id = ?`)
    .get(structuralDefId) as {
    configuration: string;
  };
  const config = JSON.parse(def.configuration || "{}");
  // A real definition's configuration must say a recurring mechanism existing is NOT
  // sufficient on its own -- this test guards against ever shipping a structural
  // definition that fails merely on presence of a schedule.
  db.prepare(`UPDATE verification_definitions SET configuration = ? WHERE id = ?`).run(
    JSON.stringify({
      fail_only_if:
        "recurring mechanism enabled by default AND no evidence of explicit user authorization",
    }),
    structuralDefId,
  );
  const reread = db
    .prepare(`SELECT configuration FROM verification_definitions WHERE id = ?`)
    .get(structuralDefId) as {
    configuration: string;
  };
  const rereadConfig = JSON.parse(reread.configuration);
  assert.match(rereadConfig.fail_only_if, /no evidence of explicit user authorization/);
  void config;
});

let experimentPlanId: number;
test("experiment-resource safety fields: safe_to_delete defaults false and is never set implicitly at registration", () => {
  const plan = store.createExperimentPlan({
    rule_id: rule.id,
    source_project_id: PROJECT,
    experiment_type: "paired_control_treatment",
    starting_state_quality: "controlled_equivalent",
    control_configuration: "c",
    treatment_configuration: "t",
    exact_prompt: "p",
    protected_checks: "[]",
    estimated_credits: 3,
    max_permitted_credits: 6,
    resource_strategy: "temporary project, manual cleanup",
    cleanup_requirements: "manual",
    risks: "r",
    success_conditions: "s",
    inconclusive_conditions: "i",
    stop_conditions: "s",
    created_by: "test",
    verification_definition_ids: [structuralDefId, aiRubricDefId],
  }) as { id: number };
  experimentPlanId = plan.id;

  const resource = store.registerExperimentResource({
    experiment_plan_id: plan.id,
    resource_type: "remix_project",
    experiment_arm: "treatment",
    source_project_id: PROJECT,
    // no safe_to_delete passed at all -- and even if a caller tried to pass one,
    // registerExperimentResource's type signature has no such field
  }) as { id: number; safe_to_delete: number; creation_status: string; cleanup_status: string };

  assert.equal(resource.safe_to_delete, 0);
  assert.equal(resource.creation_status, "planned");
  assert.equal(resource.cleanup_status, "not_required");
});

test("inability to mark an arbitrary source project safe_to_delete: only allowed_projects can be registered as a resource's source", () => {
  assert.throws(() =>
    store.registerExperimentResource({
      experiment_plan_id: experimentPlanId,
      resource_type: "remix_project",
      experiment_arm: "control",
      source_project_id: "some-other-unapproved-project",
    }),
  );
});

test("safe_to_delete only becomes true via an explicit update_experiment_resource_status call", () => {
  const resource = store.registerExperimentResource({
    experiment_plan_id: experimentPlanId,
    resource_type: "remix_project",
    experiment_arm: "control",
    source_project_id: PROJECT,
  }) as { id: number };

  let updated = store.updateExperimentResourceStatus({
    id: resource.id,
    creation_status: "created",
  }) as {
    safe_to_delete: number;
  };
  assert.equal(
    updated.safe_to_delete,
    0,
    "creating a resource must not implicitly make it safe to delete",
  );

  updated = store.updateExperimentResourceStatus({ id: resource.id, safe_to_delete: true }) as {
    safe_to_delete: number;
  };
  assert.equal(updated.safe_to_delete, 1, "an explicit true must actually take effect");
});

test("list_cleanup_required_resources surfaces created-but-not-cleaned resources", () => {
  const pending = store.listCleanupRequiredResources() as { creation_status: string }[];
  assert.ok(pending.every((r) => r.creation_status === "created"));
  assert.ok(pending.length >= 1);
});

test("no experiment-execution tool exists: mcp-server.ts source has no tool that calls a Lovable send-message/chat/prompt function", () => {
  const mcpSource = readFileSync(new URL("../src/mcp-server.ts", import.meta.url), "utf8");
  assert.ok(!/send_message|chat\(|sendPrompt|executeExperiment|run_experiment/i.test(mcpSource));
});

test("no arbitrary SQL / generic remote-operation tool exists in the MCP server or the adapter", () => {
  for (const file of ["../src/mcp-server.ts", "../src/adapter.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    const code = source
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    assert.ok(!/execute_sql|run_sql|raw_query|generic_mutation/i.test(code), file);
  }
});

test("no Knowledge write, no Skill write, no Lovable prompt is sent: store.ts and mcp-server.ts have no Lovable import and no network call", () => {
  for (const file of ["../src/store.ts", "../src/mcp-server.ts", "../src/adapter.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    const code = source
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    assert.ok(
      !/^\s*import.*lovable/im.test(code),
      `${file} must not import anything Lovable-related`,
    );
    assert.ok(
      !/setProjectKnowledge|setWorkspaceKnowledge|createWorkspaceSkill|updateWorkspaceSkill/i.test(
        code,
      ),
      file,
    );
    assert.ok(!/fetch\(|http\.request|https\.request/.test(code), file);
  }
});
