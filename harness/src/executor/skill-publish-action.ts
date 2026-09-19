/**
 * Checkpoint 3 S1: the `publish_skill_proposal` action -- the one place a
 * Harness-owned, approved Skill proposal is actually created in Lovable.
 * Lives in executor/ (not improvements.ts, which must never import anything
 * Lovable-related -- see its own "no Lovable import" test), and is
 * intercepted in beats.ts's improvementActionAndWrite before
 * peekActionKind, the same way "test" and "delete_copy" are (see
 * experiments-actions.ts's own header comment for why each Lovable-touching
 * action gets its own module rather than living in beats.ts directly).
 *
 * Split the same way beats.ts splits executeVersionNow (takes its Lovable
 * dependency as an argument, directly testable with a fake) from
 * runVersionNow (checks connection, opens/closes the real client):
 * `publishSkillProposal` does the actual work against an injected client;
 * `publishSkillProposalAction` is what beats.ts calls, and is the only one
 * that ever opens a real connection.
 *
 * Never called from the automatic sync loop (beats.ts's runAll): publishing
 * a Skill spends nothing and changes a shared workspace resource, but it is
 * still a real, one-way create in Lovable that only ever runs when a person
 * (or an MCP caller acting with the same permissions) explicitly posts this
 * action -- see harness/test/skill-publish.test.ts's "automatic loop never
 * publishes" test.
 */
import { z } from "zod";
import * as store from "../store.js";
import { getImprovement, type Improvement } from "../improvements.js";
import { composeSkillMarkdown, normalizeSkillName } from "../skills/publish.js";
import { redact } from "./redact.js";
import { status } from "./lovable-auth.js";
import { openLovableClient } from "./lovable-mcp.js";
import type { LovableClient, LovableReader } from "./lovable-mcp.js";

const publishSkillProposalInput = z.object({
  action: z.literal("publish_skill_proposal"),
  proposal_id: z.number().int(),
});

/** True for any input shaped like a `publish_skill_proposal` action --
 * checked BEFORE the input is otherwise validated (parse, inside the action
 * itself, does the real validation), same convention as isTestAction/
 * isDeleteCopyAction in experiments-actions.ts. */
export function isPublishSkillProposalAction(input: unknown): boolean {
  return (
    typeof input === "object" &&
    input !== null &&
    (input as Record<string, unknown>)["action"] === "publish_skill_proposal"
  );
}

// Same sentence beats.ts's own write-eligible actions use for "not
// connected" -- kept as a local copy rather than importing beats.ts's
// (unexported) constant, since beats.ts imports this module to wire the
// action in and a two-way import would make the two modules load-order
// dependent for no real benefit.
const NOT_CONNECTED_REASON = "Harness Ledger is not connected — connect on the Projects page.";

/** The workspace every allowed project belongs to, same resolution order
 * skills.ts's own route uses (and beats.ts's resolveWorkspaceId mirrors for
 * the sync path): whatever a project row already records, else the
 * connected account's first workspace. Kept local (not imported from
 * beats.ts) for the same load-order reason as NOT_CONNECTED_REASON above. */
async function resolveWorkspaceIdForPublish(client: LovableReader): Promise<string | null> {
  const allowed = store.getAllowedProjects() as { lovable_project_id: string }[];
  for (const p of allowed) {
    const meta = store.getProjectMeta(p.lovable_project_id);
    if (meta?.workspace_id) return meta.workspace_id;
  }
  const me = await client.getMe();
  return me.workspaces[0]?.id ?? null;
}

/**
 * Publishes one approved, Harness-owned Skill proposal as a new workspace
 * Skill in Lovable, against an already-open client -- exported for direct
 * testing with a fake (harness/test/skill-publish.test.ts), the same way
 * beats.ts's executeVersionNow is.
 *
 * Preconditions (each its own plain-language refusal, thrown as an Error so
 * the route turns it into a 400 -- same convention every other
 * improvementAction case uses): the proposal exists, is Harness Ledger's
 * own, is approved, and is not already in Lovable; its stored name must
 * already be the name Lovable would normalise it to (edit_skill_proposal
 * renames it first -- no silent renames).
 *
 * From resolving the workspace onward -- refusing a name collision with an
 * existing workspace Skill (Harness Ledger creates, it never overwrites),
 * composing the SKILL.md, creating it, reading it back and comparing -- any
 * throw is recorded as this proposal's `lovable_state: 'failed'` (message
 * redacted, never a raw Lovable error that might carry a token) and
 * rethrown, so the caller surfaces it and the Inbox can offer Retry.
 */
export async function publishSkillProposal(
  proposalId: number,
  client: LovableClient,
  actor: string,
): Promise<Improvement> {
  const proposal = store.getSkillProposal(proposalId);
  if (!proposal) throw new Error(`skill proposal ${proposalId} not found`);
  if (proposal.ownership !== "harness") throw new store.SkillProposalOwnershipError();
  if (proposal.status !== "approved") {
    throw new Error("Approve the Skill before publishing it.");
  }
  if (proposal.lovable_state === "created") {
    throw new Error("This Skill is already in Lovable.");
  }
  const normalizedName = normalizeSkillName(proposal.name);
  if (normalizedName !== proposal.name) {
    throw new Error(
      `Rename this proposal to "${normalizedName}" with Edit before publishing -- Lovable Skill ` +
        "names must be lowercase letters, numbers and dashes only.",
    );
  }

  try {
    const workspaceId = await resolveWorkspaceIdForPublish(client);
    if (!workspaceId) throw new Error("Could not determine your Lovable workspace.");

    const existingSkills = store.latestSkillSnapshots(workspaceId);
    if (existingSkills.some((s) => s.name === proposal.name)) {
      throw new Error(
        `A Skill named ${proposal.name} already exists in your workspace. Rename the proposal first.`,
      );
    }

    const markdown = composeSkillMarkdown(proposal.name, proposal.content);
    await client.createWorkspaceSkill(workspaceId, proposal.name, markdown);
    const readBack = await client.getWorkspaceSkill(workspaceId, proposal.name);
    const readbackOk = readBack != null && readBack.content.trimEnd() === markdown.trimEnd();

    store.setSkillProposalLovableState({
      id: proposalId,
      lovable_state: "created",
      written_at: new Date().toISOString(),
      readback_ok: readbackOk,
      actor,
      reason: "published to Lovable",
    });

    // The read-back is a real read of Lovable: record it as the latest
    // skill snapshot, the same write the sync path (beats.ts's
    // snapshotSkills) uses, so the Skills page shows it right away rather
    // than waiting for the next sync.
    if (readBack) {
      store.recordSkillSnapshot({
        workspace_id: workspaceId,
        name: proposal.name,
        description: readBack.description,
        content: readBack.content,
        updated_at_remote: null,
        fetched_by: "executor",
      });
    }
  } catch (err) {
    const message = redact(err instanceof Error ? err.message : String(err)).text;
    try {
      store.setSkillProposalLovableState({
        id: proposalId,
        lovable_state: "failed",
        error: message,
        actor,
        reason: `publish failed: ${message}`,
      });
    } catch {
      // Never let a store error mask the original publish failure below.
    }
    throw new Error(message);
  }

  const improvement = getImprovement(proposal.correction_candidate_id, { connected: true });
  if (!improvement) throw new Error(`improvement for skill proposal ${proposalId} not found`);
  return improvement;
}

/** What beats.ts's improvementActionAndWrite calls: validates the input,
 * refuses immediately (no client ever opened) when not connected -- same
 * "not connected" sentence and same convention as runVersionNow -- then
 * opens the real Lovable client, delegates to publishSkillProposal, and
 * always closes the client. */
export async function publishSkillProposalAction(
  input: unknown,
  actor = "operator (local UI)",
): Promise<Improvement> {
  const { proposal_id } = publishSkillProposalInput.parse(input);
  if (!status().connected) throw new Error(NOT_CONNECTED_REASON);

  const client = await openLovableClient();
  try {
    return await publishSkillProposal(proposal_id, client, actor);
  } finally {
    await client.close().catch(() => {});
  }
}
