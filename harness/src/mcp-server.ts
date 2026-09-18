// Harness MCP: an agent's window onto Harness Ledger. Every tool below is a
// thin wrapper over harness/src/adapter.ts -- the exact module the web app's
// own routes (src/routes/api/public/harness/*.ts) import -- so an MCP caller
// can never do anything the web app's buttons could not also do: the same
// decision-mode gating, the same monthly Lovable credit budget, the same
// project allowlist, the same fresh-read/sha-check/read-back sequence on a
// Knowledge write. This file never imports "./store.js" directly (see
// harness/test/mcp-server.test.ts's structural test) -- every read and
// every mutation goes through adapter.ts, the same boundary the web app is
// held to.
//
// D5 (DECISIONS.md) replaces the previous 33-tool surface: raw store
// primitives that bypassed improvements.ts's checks (update_rule,
// create_rule, review_correction_candidate, record_knowledge_readback) and
// ten experiment-plan/verification-plan/resource tools that wrote tables
// nothing in the live product reads (docs/audit/mcp-security.md). The 13
// tools here were the full replacement surface; Checkpoint 2 2-F added the
// 5 Skill-proposal tools below (18 total) -- still every one a thin
// wrapper over adapter.ts, still no other way to mutate Harness Ledger
// state through this server. No tool here (old or new) takes a raw Lovable
// project id for deletion, and none has "resource" or "safe" in its name --
// see harness/test/safe-to-delete.test.ts.
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as adapter from "./adapter.js";
import type { Improvement } from "./adapter.js";

const SERVER_INSTRUCTIONS =
  "Harness Ledger MCP lets your agent operate Harness Ledger with the same permissions as the web app. " +
  "Lovable MCP (a different server) lets Harness Ledger operate Lovable.";

/** Every mutating tool's actor string, so the audit trail (rule_revisions,
 * events) can tell an MCP-driven decision apart from one made by clicking a
 * button in the browser -- the checks that run are identical either way. */
const MCP_ACTOR = "agent via Harness Ledger MCP";

const PARITY_NOTE =
  " Goes through the exact same adapter.ts call the web app's own button uses, " +
  "so it is gated by the same decision mode, Lovable credit budget and project allowlist, " +
  "and refuses in exactly the same words.";
const READ_ONLY_NOTE = " Read-only: reads exactly what the equivalent page in the web app shows.";

function jsonResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function registerTool(
  server: McpServer,
  name: string,
  description: string,
  shape: z.ZodRawShape,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (input: any) => unknown | Promise<unknown>,
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server.tool(name, description, shape, async (input: any) => {
    try {
      return jsonResult(await handler(input));
    } catch (err) {
      return {
        isError: true,
        content: [
          { type: "text" as const, text: err instanceof Error ? err.message : String(err) },
        ],
      };
    }
  });
}

/** Same fail-closed default the web app's own isConnected() helper uses
 * (src/routes/api/public/harness/improvements.ts): a status read that
 * throws (no auth file yet, a corrupt one) reads as "not connected", never
 * as an error a caller has to handle. */
function isConnected(): boolean {
  try {
    return adapter.lovableAuthStatus().connected;
  } catch {
    return false;
  }
}

type Target = { target: "project" | "workspace"; id: string; name: string };

/** Every project/workspace target this local runtime knows about, mirroring
 * src/routes/api/public/harness/knowledge.ts's own resolveTargets -- with
 * the web-only loadHarnessExecutor() workspace fallback replaced by the
 * plain adapter.lovableAuthStatus() re-export (Checkpoint 2026-09-18 WP6),
 * since mcp-server.ts cannot import anything under src/. */
function resolveTargets(): Target[] {
  const allowed = adapter.getAllowedProjects() as { lovable_project_id: string }[];
  const targets: Target[] = [];
  let workspaceId: string | null = null;
  for (const p of allowed) {
    const meta = adapter.getProjectMeta(p.lovable_project_id) as {
      name: string | null;
      workspace_id: string | null;
    } | null;
    targets.push({
      target: "project",
      id: p.lovable_project_id,
      name: meta?.name ?? p.lovable_project_id,
    });
    if (!workspaceId && meta?.workspace_id) workspaceId = meta.workspace_id;
  }
  if (!workspaceId) {
    try {
      workspaceId = adapter.lovableAuthStatus().workspaces[0]?.id ?? null;
    } catch {
      workspaceId = null;
    }
  }
  if (workspaceId) targets.push({ target: "workspace", id: workspaceId, name: "Workspace" });
  return targets;
}

/** Same workspace resolution as src/routes/api/public/harness/skills.ts's
 * resolveWorkspaceId, minus the web-only executor loader. */
function resolveWorkspaceId(): string | null {
  const allowed = adapter.getAllowedProjects() as { lovable_project_id: string }[];
  for (const p of allowed) {
    const meta = adapter.getProjectMeta(p.lovable_project_id) as {
      workspace_id: string | null;
    } | null;
    if (meta?.workspace_id) return meta.workspace_id;
  }
  try {
    return adapter.lovableAuthStatus().workspaces[0]?.id ?? null;
  } catch {
    return null;
  }
}

function statusLine(item: Improvement): string {
  if (item.kind === "retire") {
    return `retirement proposed for rule ${item.retire?.rule_id ?? "?"} (reason: ${
      item.retire?.reason ?? "unknown"
    })`;
  }
  if (item.decision.retired) return "retired";
  if (item.decision.status === "pending") return "pending decision";
  if (item.decision.status === "skipped") return "skipped";
  const dest = item.destination ? ` to ${item.destination}` : "";
  return `accepted${dest} (knowledge write: ${item.lovable.write_status})`;
}

/** id, rule text, corrections, destination fields if present, status line --
 * the same fields the Inbox card shows, trimmed of the developer-only
 * fields (verification plans, raw events) the full Improvement view carries
 * for the app's own debug panel. */
function trimSuggestion(item: Improvement) {
  return {
    id: item.id,
    kind: item.kind,
    rule_text: item.proposed_instruction,
    correction: { classification: item.classification, summary: item.title },
    destination: item.destination,
    status: statusLine(item),
  };
}

const decideAction = z.enum([
  "accept_project",
  "accept_workspace",
  "skip",
  "test_first",
  "change_wording",
]);
const skipReason = z.enum(["not_useful", "wrong_wording", "one_time", "already_covered"]);

/** Maps decide_suggestion's own vocabulary onto exactly the action bodies
 * improvements.ts's actionInput union (and beats.ts's "test" interception)
 * already accept -- the same bodies the web app's buttons send. */
function mapDecideAction(input: {
  id: number;
  action: z.infer<typeof decideAction>;
  skip_reason?: z.infer<typeof skipReason>;
  new_instruction?: string;
}): unknown {
  switch (input.action) {
    case "accept_project":
      return { action: "accept", id: input.id, destination: "project" };
    case "accept_workspace":
      return { action: "accept", id: input.id, destination: "workspace" };
    case "skip":
      return {
        action: "skip",
        id: input.id,
        ...(input.skip_reason ? { reason: input.skip_reason } : {}),
      };
    case "test_first":
      // Mirrors the Inbox's "Add and test it first" choice (Round 7:
      // src/components/harness/improvement.tsx AddConfirm) -- that dialog
      // calls exactly { action: "test", id, show_original: true }, never
      // accept with a test_first flag (the old staging-only path Round 7
      // retired). show_original defaults true, matching that dialog's own
      // default.
      return { action: "test", id: input.id, show_original: true };
    case "change_wording":
      if (!input.new_instruction) {
        throw new Error("new_instruction is required for the change_wording action");
      }
      return { action: "change_wording", id: input.id, instruction: input.new_instruction };
  }
}

function matchesTarget(
  v: { target: string; project_id: string | null; workspace_id: string | null },
  target: "project" | "workspace",
  targetId: string,
): boolean {
  if (v.target !== target) return false;
  return target === "project" ? v.project_id === targetId : v.workspace_id === targetId;
}

export function createHarnessMcpServer(): McpServer {
  const server = new McpServer(
    { name: "harness-mcp", version: "0.3.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );

  registerTool(
    server,
    "health",
    "Report local Harness Ledger service health and the SQLite database path." + READ_ONLY_NOTE,
    {},
    () => adapter.health(),
  );

  registerTool(
    server,
    "list_suggestions",
    "List Harness Ledger's suggestions (the same items the Inbox and Improvements pages show): " +
      "id, rule text, the underlying correction, destination, and a plain status line. " +
      "filter: 'open' (awaiting a decision, the default), 'decided' (accepted or skipped), or 'all'." +
      READ_ONLY_NOTE,
    { filter: z.enum(["open", "decided", "all"]).optional() },
    (input: { filter?: "open" | "decided" | "all" }) => {
      const filter = input.filter ?? "open";
      const items = adapter.listImprovements({ connected: isConnected() });
      const open = (item: Improvement) =>
        item.kind === "retire" ? true : item.decision.status === "pending";
      const filtered = items.filter((item) =>
        filter === "all" ? true : filter === "open" ? open(item) : !open(item),
      );
      return filtered.map(trimSuggestion);
    },
  );

  registerTool(
    server,
    "explain_suggestion",
    "Full detail for one suggestion (the same view the Inbox/Improvements card expands into), " +
      "plus a preview of the Knowledge block Harness Ledger would write for its destination." +
      READ_ONLY_NOTE,
    { id: z.number().int() },
    (input: { id: number }) => {
      const item = adapter.getImprovement(input.id, { connected: isConnected() });
      if (!item) throw new Error(`suggestion ${input.id} not found`);
      const destination =
        item.destination === "project" || item.destination === "workspace"
          ? item.destination
          : null;
      const knowledge_preview = destination ? item.lovable.previews[destination] : null;
      return { ...item, knowledge_preview };
    },
  );

  registerTool(
    server,
    "decide_suggestion",
    "Decide one suggestion: accept_project, accept_workspace, skip (with an optional " +
      "skip_reason), test_first (queue a historical replay before deciding, like 'Add and " +
      "test it first'), or change_wording (with new_instruction). Calls adapter.ts's " +
      "improvementActionAndWrite -- the exact function the web app's Inbox/Improvements POST " +
      "route calls -- so an accept writes to Lovable Knowledge immediately when connected, " +
      "exactly like pressing the button, and a refusal (not connected, over budget, a test " +
      "already running) comes back worded exactly as the app would show it." +
      PARITY_NOTE,
    {
      id: z.number().int(),
      action: decideAction,
      skip_reason: skipReason.optional(),
      new_instruction: z.string().min(1).max(2000).optional(),
    },
    (input: {
      id: number;
      action: z.infer<typeof decideAction>;
      skip_reason?: z.infer<typeof skipReason>;
      new_instruction?: string;
    }) => adapter.improvementActionAndWrite(mapDecideAction(input), MCP_ACTOR),
  );

  registerTool(
    server,
    "list_rules",
    "Active and retired rules per Knowledge target (project or workspace), the same " +
      "adapter.activeRulesForTarget/retiredRulesForTarget reads the Instructions page uses. " +
      "Pass project_id to see just that project's rules; omit it to see every allowed " +
      "project plus the workspace." +
      READ_ONLY_NOTE,
    { project_id: z.string().optional() },
    (input: { project_id?: string }) => {
      const targets: Target[] = input.project_id
        ? [
            {
              target: "project",
              id: input.project_id,
              name:
                (adapter.getProjectMeta(input.project_id) as { name: string | null } | null)
                  ?.name ?? input.project_id,
            },
          ]
        : resolveTargets();
      return targets.map((t) => ({
        target: t.target,
        id: t.id,
        name: t.name,
        active_rules: (
          adapter.activeRulesForTarget(t.target, t.id) as { id: number; instruction: string }[]
        ).map((r) => ({ id: r.id, text: r.instruction })),
        retired_rules: (
          adapter.retiredRulesForTarget(t.target, t.id) as { id: number; instruction: string }[]
        ).map((r) => ({ id: r.id, text: r.instruction })),
      }));
    },
  );

  registerTool(
    server,
    "list_skills",
    "The connected workspace's current Skill snapshots -- the same adapter.latestSkillSnapshots " +
      "read the Skills page uses for its top-level list (not each Skill's full version history)." +
      READ_ONLY_NOTE,
    {},
    () => {
      const workspaceId = resolveWorkspaceId();
      if (!workspaceId) return { workspace_id: null, fetched_at: null, skills: [] };
      const snapshots = adapter.latestSkillSnapshots(workspaceId);
      const fetched_at = snapshots.length
        ? snapshots.reduce(
            (max, s) => (s.fetched_at > max ? s.fetched_at : max),
            snapshots[0]!.fetched_at,
          )
        : null;
      return {
        workspace_id: workspaceId,
        fetched_at,
        skills: snapshots.map((s) => ({
          name: s.name,
          description: s.description,
          content: s.content,
          sha256: s.sha256,
          updated_at_remote: s.updated_at_remote,
          fetched_at: s.fetched_at,
        })),
      };
    },
  );

  registerTool(
    server,
    "start_replay",
    "Start a historical replay for one suggestion -- the same 'Test this rule' action the " +
      "Tests/Improvements pages offer (adapter.improvementActionAndWrite's 'test' " +
      "interception: startExperiment then kickExperimentRunner, queued, not awaited here). " +
      "show_original also makes a free copy of the original build to compare against. " +
      "Refuses -- with the exact same sentence the app shows -- when Harness Ledger is not " +
      "connected, a replay is already running, or this would exceed the monthly Lovable " +
      "credit budget." +
      PARITY_NOTE,
    { id: z.number().int(), show_original: z.boolean().optional() },
    (input: { id: number; show_original?: boolean }) =>
      adapter.improvementActionAndWrite(
        { action: "test", id: input.id, show_original: input.show_original },
        MCP_ACTOR,
      ),
  );

  registerTool(
    server,
    "get_replay",
    "One historical replay run's full detail (adapter.buildExperimentRunView) -- the same " +
      "view the judging screen renders." +
      READ_ONLY_NOTE,
    { run_id: z.number().int() },
    (input: { run_id: number }) => {
      const run = adapter.buildExperimentRunView(input.run_id);
      return run
        ? { available: true, run }
        : { available: false, reason: `run ${input.run_id} not found` };
    },
  );

  registerTool(
    server,
    "list_replays",
    "Every historical replay run, summarized -- adapter.listTestRunSummaries, the same read " +
      "the Tests page lists." +
      READ_ONLY_NOTE,
    {},
    () => ({ available: true, runs: adapter.listTestRunSummaries() }),
  );

  registerTool(
    server,
    "list_knowledge_versions",
    "Full Knowledge write history for one target (project or workspace) -- the same rows the " +
      "History and Instructions pages read via adapter.listKnowledgeVersions, filtered to the " +
      "target given." +
      READ_ONLY_NOTE,
    { target: z.enum(["project", "workspace"]), target_id: z.string() },
    (input: { target: "project" | "workspace"; target_id: string }) =>
      (
        adapter.listKnowledgeVersions() as {
          target: string;
          project_id: string | null;
          workspace_id: string | null;
        }[]
      ).filter((v) => matchesTarget(v, input.target, input.target_id)),
  );

  registerTool(
    server,
    "restore_knowledge_version",
    "Restore a previously written Knowledge version -- the same action the History page's " +
      "'Restore' button takes: adapter.createRestoreVersion stages the old content as a new " +
      "pending write, then adapter.retryKnowledgeWrite runs it through the same write path " +
      "every other write uses (fresh read, sha check against what Harness Ledger expects to be " +
      "live, then a read-back) -- it refuses, worded the same way, if Harness Ledger is not " +
      "connected or the live content no longer matches." +
      PARITY_NOTE,
    { version_id: z.number().int() },
    async (input: { version_id: number }) => {
      const version = adapter.createRestoreVersion(input.version_id, MCP_ACTOR) as { id: number };
      const write = await adapter.retryKnowledgeWrite(version.id);
      return { version_id: version.id, write };
    },
  );

  registerTool(
    server,
    "rule_observations",
    "One rule's health/adherence/verdict view -- the same observed-corrections, AI-adherence " +
      "and human-verdict lines the Instructions page shows for a rule, read via " +
      "adapter.getRuleHealth/listRuleAdherence/adherenceCounts/latestRuleVerdict." +
      READ_ONLY_NOTE,
    { rule_id: z.number().int() },
    (input: { rule_id: number }) => {
      const health = adapter.getRuleHealth(input.rule_id) as {
        applicable_tasks: number;
        helped: number;
        hurt: number;
        last_applicable_at: string | null;
      } | null;
      const verdict = adapter.latestRuleVerdict(input.rule_id);
      const adherenceRows = adapter.listRuleAdherence(input.rule_id);
      const adherence = adherenceRows.length > 0 ? adapter.adherenceCounts(input.rule_id) : null;
      const live = (
        adapter.listLiveRulesWithTargets() as { id: number; first_written_at: string | null }[]
      ).find((r) => r.id === input.rule_id);
      return {
        rule_id: input.rule_id,
        health: health
          ? {
              applicable_tasks: health.applicable_tasks,
              helped: health.helped,
              hurt: health.hurt,
              last_applicable_at: health.last_applicable_at,
              since: live?.first_written_at ?? null,
            }
          : null,
        verdict,
        adherence,
        adherence_quotes: adherenceRows,
      };
    },
  );

  registerTool(
    server,
    "timeline",
    "The History page's own per-target timeline (adapter.buildTimeline): every decision, " +
      "write and restore recorded against a project or workspace's Knowledge, oldest first." +
      READ_ONLY_NOTE,
    { target: z.enum(["project", "workspace"]), target_id: z.string() },
    (input: { target: "project" | "workspace"; target_id: string }) => ({
      target: input.target,
      id: input.target_id,
      nodes: adapter.buildTimeline(input.target, input.target_id),
    }),
  );

  // ---- Checkpoint 2 2-F ----
  // Skill-proposal tools (D4/DECISIONS.md): a Skill proposal is a draft kept
  // and versioned locally in Harness Ledger -- ownership ('harness' vs
  // 'user'), every revision, and the audit trail all live here, never in
  // Lovable. `lovable_state` is always 'not_created': creating or updating a
  // Skill in Lovable itself is not wired in this checkpoint, and every
  // description below says so. Every mutating tool goes through
  // adapter.improvementActionAndWrite with the exact WP4 action body the
  // Skills page's own buttons send, so a user-owned proposal refuses with
  // the exact sentence the app shows (SkillProposalOwnershipError, thrown
  // from store.ts) -- see harness/test/mcp-server.test.ts.

  registerTool(
    server,
    "list_skill_proposals",
    "Harness Ledger's own local Skill proposals -- drafts this app proposed from a suggestion and " +
      "keeps versioned itself, never published to Lovable (creating or updating a Skill in Lovable " +
      "is not wired in this checkpoint). The same adapter.listSkillProposalsForSkillsView read the " +
      "Skills page's own 'Proposed by Harness Ledger' section uses: id, name, status, ownership " +
      "('harness' or 'user'), lovable_state (always 'not_created'), version_count, and the " +
      "suggestion each proposal belongs to. Ownership, versioning and audit are all the app's own." +
      READ_ONLY_NOTE,
    {},
    () =>
      adapter.listSkillProposalsForSkillsView().map((p) => ({
        id: p.id,
        name: p.name,
        status: p.status,
        ownership: p.ownership,
        lovable_state: p.lovable_state,
        version_count: p.version_count,
        suggestion_id: p.correction_candidate_id,
        updated_at: p.updated_at,
      })),
  );

  registerTool(
    server,
    "get_skill_proposal",
    "One suggestion's Skill proposal, addressed by suggestion_id (the same id list_suggestions/ " +
      "decide_suggestion use) -- its full content, status, ownership, and every revision, i.e. " +
      "adapter.getImprovement(...).skill_proposal, the same field the Inbox/Improvements card " +
      "reads. lovable_state is always 'not_created': this Skill exists only in Harness Ledger -- " +
      "it has never been created or updated in Lovable, and ownership/versioning/audit for it are " +
      "entirely the app's own, not Lovable's." +
      READ_ONLY_NOTE,
    { suggestion_id: z.number().int() },
    (input: { suggestion_id: number }) => {
      const item = adapter.getImprovement(input.suggestion_id, { connected: isConnected() });
      if (!item) throw new Error(`suggestion ${input.suggestion_id} not found`);
      if (!item.skill_proposal) {
        return {
          available: false,
          reason: `suggestion ${input.suggestion_id} has no Skill proposal`,
        };
      }
      return { available: true, proposal: item.skill_proposal };
    },
  );

  registerTool(
    server,
    "edit_skill_proposal",
    "Edit a Skill proposal's name/content as a new versioned revision -- " +
      "adapter.improvementActionAndWrite('edit_skill_proposal'), the exact call the Skills page's " +
      "own editor makes. The edit, its revision history and its audit trail all stay in Harness Ledger " +
      "Ledger; nothing is published to Lovable. Refuses, with the exact sentence the app shows, on " +
      "a proposal the user owns -- Harness Ledger never edits a Skill it did not itself propose." +
      PARITY_NOTE,
    {
      proposal_id: z.number().int(),
      name: z.string().min(1).max(200),
      content: z.string().min(1).max(20000),
    },
    (input: { proposal_id: number; name: string; content: string }) =>
      adapter.improvementActionAndWrite(
        {
          action: "edit_skill_proposal",
          proposal_id: input.proposal_id,
          name: input.name,
          content: input.content,
        },
        MCP_ACTOR,
      ),
  );

  registerTool(
    server,
    "approve_skill_proposal",
    "Approve a Skill proposal -- adapter.improvementActionAndWrite('approve_skill_proposal'), the " +
      "same action the Skills page's own Approve button takes. Approving only changes Harness Ledger " +
      "Ledger's own record (a new versioned revision); it never publishes the Skill to Lovable in " +
      "this checkpoint. Refuses, worded exactly the way the app does, on a proposal the user owns." +
      PARITY_NOTE,
    { proposal_id: z.number().int() },
    (input: { proposal_id: number }) =>
      adapter.improvementActionAndWrite(
        { action: "approve_skill_proposal", proposal_id: input.proposal_id },
        MCP_ACTOR,
      ),
  );

  registerTool(
    server,
    "restore_skill_proposal_revision",
    "Restore a Skill proposal's name/content from one of its own earlier revisions (its status is " +
      "left exactly as it is now) -- adapter.improvementActionAndWrite('restore_skill_proposal_" +
      "revision'), the same action the Skills page's version history offers. Ownership, versioning " +
      "and the audit trail for this are entirely Harness Ledger's own; nothing here touches " +
      "Lovable. Refuses, worded exactly the way the app does, on a proposal the user owns." +
      PARITY_NOTE,
    { proposal_id: z.number().int(), revision_id: z.number().int() },
    (input: { proposal_id: number; revision_id: number }) =>
      adapter.improvementActionAndWrite(
        {
          action: "restore_skill_proposal_revision",
          proposal_id: input.proposal_id,
          revision_id: input.revision_id,
        },
        MCP_ACTOR,
      ),
  );
  // ---- end Checkpoint 2 2-F ----

  return server;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const server = createHarnessMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
