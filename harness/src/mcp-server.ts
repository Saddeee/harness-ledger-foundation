import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as store from "./store.js";

const server = new McpServer({ name: "harness-mcp", version: "0.2.0" });

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function tool(
  name: string,
  description: string,
  shape: z.ZodRawShape,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (input: any) => unknown,
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server.tool(name, description, shape, async (input: any) => {
    try {
      return json(handler(input));
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
      };
    }
  });
}

const provenance = z.enum(["lovable_mcp", "git_history", "build_log", "spec", "manual", "llm_derived"]);
const classification = z.enum([
  "defect_correction", "constraint_restatement", "missing_requirement",
  "preference_revision", "scope_extension", "new_task", "question", "approval", "other",
]);
const ruleState = z.enum([
  "proposed", "approved", "testing", "supported", "active", "questioned",
  "disabled", "retired", "rolled_back", "rejected",
]);

// ---- Checkpoint A ----

tool("health", "Report local Harness service health and DB path.", {}, () => store.health());

tool(
  "create_test_record",
  "Insert a throwaway test record (proves writes work end to end).",
  { note: z.string().optional() },
  (input) => store.createTestRecord(input.note),
);

tool(
  "get_allowed_projects",
  "List Lovable project IDs this Harness instance permits Claude Code to read or act on. Read-only: curated out-of-band (npm run seed), never by an agent.",
  {},
  () => store.getAllowedProjects(),
);

tool(
  "upsert_project",
  "Store or update cached, redacted metadata for an approved Lovable project.",
  {
    lovable_project_id: z.string(),
    name: z.string().optional(),
    status: z.string().optional(),
    url: z.string().optional(),
    tech_stack: z.string().optional(),
    raw_json: z.string().optional(),
  },
  (input) => store.upsertProject(input),
);

tool(
  "append_event",
  "Append an audit-log event.",
  { kind: z.string(), ref: z.string().optional(), payload: z.unknown().optional() },
  (input) => store.insertEvent(input.kind, input.ref, input.payload),
);

tool(
  "list_events",
  "List recent audit-log events, newest first.",
  { limit: z.number().int().positive().max(500).optional() },
  (input) => store.listEvents(input.limit ?? 50),
);

// ---- Checkpoint B: correction pipeline ----

tool(
  "create_project_snapshot",
  "Store a point-in-time metadata snapshot for an allowed Lovable project. Rejects projects not in allowed_projects.",
  {
    lovable_project_id: z.string(),
    label: z.string().optional(),
    snapshot_json: z.string(),
    provenance,
    source_ref: z.string().optional(),
  },
  (input) => store.createProjectSnapshot(input),
);

tool(
  "upsert_history_item",
  "Store or update one piece of raw evidence (a chat message, diff, edit, build-log row, spec excerpt, or manual note). Idempotent per (project_id, kind, external_id).",
  {
    project_id: z.string().optional(),
    kind: z.enum(["message", "diff", "edit", "build_log_row", "spec_excerpt", "manual_note"]),
    external_id: z.string().optional(),
    role: z.enum(["user", "assistant", "system", "operator"]).optional(),
    content: z.string(),
    occurred_at: z.string().optional(),
    provenance,
    source_ref: z.string().optional(),
  },
  (input) => store.upsertHistoryItem(input),
);

tool(
  "create_task_episode",
  "Create a reconstructed task episode for an allowed project (or a cross-project one if project_id is omitted), optionally linking evidence history_item ids.",
  {
    project_id: z.string().optional(),
    title: z.string(),
    summary: z.string().optional(),
    provenance,
    started_at: z.string().optional(),
    ended_at: z.string().optional(),
    evidence_history_item_ids: z.array(z.number().int()).optional(),
  },
  (input) => store.createTaskEpisode(input),
);

tool(
  "update_task_episode",
  "Update a task episode's title/summary/status/end time, and/or attach more evidence.",
  {
    id: z.number().int(),
    title: z.string().optional(),
    summary: z.string().optional(),
    status: z.enum(["reconstructed", "reviewed"]).optional(),
    ended_at: z.string().optional(),
    add_evidence_history_item_ids: z.array(z.number().int()).optional(),
  },
  (input) => store.updateTaskEpisode(input),
);

tool(
  "create_correction_candidate",
  "Create a structured correction candidate for a task episode, linked to its supporting evidence.",
  {
    task_episode_id: z.number().int(),
    classification,
    is_correction: z.boolean(),
    reusable: z.boolean().optional(),
    proposed_scope: z.enum(["project", "workspace", "one_time"]).optional(),
    summary: z.string(),
    confidence: z.number().min(0).max(1).optional(),
    evidence_reason: z.string().optional(),
    evidence_history_item_ids: z.array(z.number().int()),
    classification_meta: z
      .object({
        provider: z.string(),
        model: z.string(),
        role: z.string(),
        structured_output: z.unknown(),
      })
      .optional(),
  },
  (input) => store.createCorrectionCandidate(input),
);

tool(
  "review_correction_candidate",
  "Apply a human review action to a correction candidate: confirm, reclassify, mark_one_time, mark_reusable, change_scope, or exclude.",
  {
    id: z.number().int(),
    action: z.enum(["confirm", "reclassify", "mark_one_time", "mark_reusable", "change_scope", "exclude"]),
    classification: classification.optional(),
    proposed_scope: z.enum(["project", "workspace", "one_time"]).optional(),
    reviewer: z.string().optional(),
  },
  (input) => store.reviewCorrectionCandidate(input),
);

tool(
  "create_learning",
  "Create a learning from a reviewed correction candidate. Refuses a 4th learning on the same correction candidate.",
  {
    correction_candidate_id: z.number().int(),
    observed_problem: z.string(),
    desired_behavior: z.string(),
    reuse_rationale: z.string(),
    proposed_scope: z.enum(["project", "workspace"]),
    applicability: z.string().optional(),
    confidence: z.number().min(0).max(1).optional(),
    overlap_notes: z.string().optional(),
    provenance,
    created_by: z.string(),
  },
  (input) => store.createLearning(input),
);

tool(
  "create_rule",
  "Create a proposed rule from a learning. Never touches Lovable -- state starts at 'proposed' and stays local until a later checkpoint.",
  {
    learning_id: z.number().int(),
    correction_candidate_id: z.number().int(),
    instruction: z.string(),
    scope: z.enum(["project", "workspace"]),
    applies_when: z.string(),
    predicted_failure: z.string(),
    ownership: z.enum(["user", "harness"]),
    overlap_notes: z.string().optional(),
    created_by: z.string(),
  },
  (input) => store.createRule(input),
);

tool(
  "update_rule",
  "Edit a rule's instruction and/or change its state (approve/reject/return to proposed/etc). Always creates a rule_revision preserving the previous text. Local-only: never writes Lovable Knowledge, never touches a Skill, never runs an experiment.",
  {
    id: z.number().int(),
    instruction: z.string().optional(),
    state: ruleState.optional(),
    reason: z.string().optional(),
    actor: z.string(),
  },
  (input) => store.updateRule(input),
);

tool(
  "get_rule",
  "Get a rule with its revision history, linked learning, and linked correction candidate.",
  { id: z.number().int() },
  (input) => store.getRule(input.id),
);

tool(
  "list_project_rules",
  "List rules, optionally filtered to one Lovable project (via its task episodes).",
  { project_id: z.string().optional() },
  (input) => store.listProjectRules(input.project_id),
);

// ---- Checkpoint C: verification and experiment planning ----
// None of these tools execute a verifier or an experiment -- they only
// define and record plans. There is deliberately no arbitrary-SQL or
// generic-remote-operation tool anywhere in this file.

const verifierType = z.enum(["structural", "diff_pattern", "ai_rubric", "human_only"]);
const scope = z.enum(["project", "workspace"]);
const provenanceEnum = z.enum(["lovable_mcp", "git_history", "build_log", "spec", "manual", "llm_derived"]);

tool(
  "create_verification_definition",
  "Define a reusable check (structural, diff_pattern, ai_rubric, or human_only). Does not run it.",
  {
    scope,
    project_id: z.string().optional(),
    name: z.string(),
    description: z.string(),
    verifier_type: verifierType,
    configuration: z.string(),
    source: provenanceEnum,
    ownership: z.enum(["user", "harness"]),
    confidence: z.number().min(0).max(1).optional(),
    enabled: z.boolean().optional(),
  },
  (input) => store.createVerificationDefinition(input),
);

tool(
  "update_verification_definition",
  "Edit a verification definition's text/configuration or enable/disable it. Bumps its version.",
  {
    id: z.number().int(),
    name: z.string().optional(),
    description: z.string().optional(),
    configuration: z.string().optional(),
    confidence: z.number().min(0).max(1).optional(),
    enabled: z.boolean().optional(),
  },
  (input) => store.updateVerificationDefinition(input),
);

tool(
  "link_verification_to_rule",
  "Attach an existing verification definition to a rule.",
  { rule_id: z.number().int(), verification_definition_id: z.number().int() },
  (input) => store.linkVerificationToRule(input.rule_id, input.verification_definition_id),
);

tool(
  "create_verification_plan",
  "Create a verification plan for a rule: a failure signature/condition plus one or more verification definitions, each starting as not_run.",
  {
    rule_id: z.number().int(),
    failure_signature: z.string(),
    failure_condition: z.string(),
    created_by: z.string(),
    verification_definition_ids: z.array(z.number().int()).min(1),
  },
  (input) => store.createVerificationPlan(input),
);

tool(
  "get_verification_plan",
  "Get a verification plan with its items (each item's verifier type and current passed/failed/unclear/not_run status).",
  { id: z.number().int() },
  (input) => store.getVerificationPlan(input.id),
);

tool(
  "create_experiment_plan",
  "Record a proposed experiment plan (status always starts 'proposed'). Does not create any Lovable resource or send any prompt.",
  {
    rule_id: z.number().int(),
    source_project_id: z.string(),
    task_episode_id: z.number().int().optional(),
    experiment_type: z.enum(["treatment_only", "paired_control_treatment", "ablation"]),
    starting_state_quality: z.enum(["controlled_equivalent", "approximate", "historical_only", "blocked"]),
    control_configuration: z.string(),
    treatment_configuration: z.string(),
    exact_prompt: z.string(),
    protected_checks: z.string(),
    estimated_credits: z.number(),
    max_permitted_credits: z.number(),
    resource_strategy: z.string(),
    cleanup_requirements: z.string(),
    risks: z.string(),
    success_conditions: z.string(),
    inconclusive_conditions: z.string(),
    stop_conditions: z.string(),
    created_by: z.string(),
    verification_definition_ids: z.array(z.number().int()),
  },
  (input) => store.createExperimentPlan(input),
);

tool(
  "get_experiment_plan",
  "Get an experiment plan with its linked verification definitions and any registered resources.",
  { id: z.number().int() },
  (input) => store.getExperimentPlan(input.id),
);

tool(
  "register_experiment_resource",
  "Register a resource an experiment plan intends to use (e.g. a remix). safe_to_delete always starts false regardless of input -- set it later, explicitly, via update_experiment_resource_status.",
  {
    experiment_plan_id: z.number().int(),
    resource_type: z.enum(["remix_project", "variant", "skill", "other"]),
    experiment_arm: z.enum(["control", "treatment", "ablation"]),
    source_project_id: z.string(),
    safe_to_modify: z.boolean().optional(),
    lovable_resource_id: z.string().optional(),
  },
  (input) => store.registerExperimentResource(input),
);

tool(
  "update_experiment_resource_status",
  "Update a resource's lifecycle status. safe_to_delete only ever changes when explicitly passed here -- it is never inferred.",
  {
    id: z.number().int(),
    lovable_resource_id: z.string().optional(),
    creation_status: z.enum(["planned", "creating", "created", "failed"]).optional(),
    cleanup_status: z.enum(["not_required", "pending", "cleaned", "failed"]).optional(),
    safe_to_delete: z.boolean().optional(),
    cleaned_at: z.string().optional(),
  },
  (input) => store.updateExperimentResourceStatus(input),
);

tool(
  "list_cleanup_required_resources",
  "List experiment resources that were created and still need cleanup.",
  {},
  () => store.listCleanupRequiredResources(),
);

const transport = new StdioServerTransport();
await server.connect(transport);
