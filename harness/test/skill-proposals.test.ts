// Checkpoint 2026-09-18 WP4 (D4): Skills as a first-class destination, local
// lifecycle. set_content_destination (create/retire a Skill proposal as the
// user changes their mind), edit_skill_proposal (a revision), approve/retire,
// restore_skill_proposal_revision, the user-owned refusal, and "accept" with
// a Skill destination never staging a Knowledge write. Same fixture pattern
// as improvements.test.ts (its own temp DB, one shared correction/rule chain
// per file, seeded once at module load).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HARNESS_DB_PATH = join(
  mkdtempSync(join(tmpdir(), "harness-skill-proposals-test-")),
  "harness.db",
);

const { db } = await import("../src/db.js");
const store = await import("../src/store.js");
const imp = await import("../src/improvements.js");

const PROJECT = "skill-proposals-test-project";
db.prepare(`INSERT INTO allowed_projects (lovable_project_id, label) VALUES (?, ?)`).run(
  PROJECT,
  "test",
);
store.upsertProject({ lovable_project_id: PROJECT, name: "Skill Proposals Test" });

let nextExternalId = 0;
function msg(role: "user" | "assistant", content: string) {
  return store.upsertHistoryItem({
    project_id: PROJECT,
    kind: "message",
    role,
    content,
    occurred_at: "2026-09-10T10:00:00.000Z",
    provenance: "lovable_mcp",
    external_id: `sp-ext-${nextExternalId++}`,
  }) as { id: number };
}

/** A fresh correction/learning/rule chain, exactly like a real suggestion --
 * `destination` seeds correction_candidates.destination directly (as the
 * Rule writer would have) so each test can start from any of the three
 * values without going through propose.ts's own LLM call. */
function seedSuggestion(opts: {
  instruction: string;
  destination?: "knowledge" | "skill" | "both";
  // Defaults to true whenever destination includes a Skill (the real
  // propose.ts flow always pairs the two) -- pass false to model a
  // candidate whose destination is "skill"/"both" but has no proposal on
  // file yet (e.g. a rule that predates this checkpoint).
  withSkillProposal?: boolean;
}): { candidateId: number; ruleId: number } {
  const request = msg("user", `Build feature for ${opts.instruction}`);
  const correction = msg("user", `Fix: ${opts.instruction}`);
  const episode = store.createTaskEpisode({
    project_id: PROJECT,
    title: opts.instruction,
    provenance: "llm_derived",
    evidence_history_item_ids: [request.id, correction.id],
  }) as { id: number };
  const candidate = store.createCorrectionCandidate({
    task_episode_id: episode.id,
    classification: "constraint_restatement",
    is_correction: true,
    reusable: true,
    proposed_scope: "project",
    summary: opts.instruction,
    evidence_history_item_ids: [request.id, correction.id],
    destination: opts.destination ?? "knowledge",
    destination_chosen_by: opts.destination ? "rule_writer" : undefined,
  }) as { id: number };
  const learning = store.createLearning({
    correction_candidate_id: candidate.id,
    observed_problem: opts.instruction,
    desired_behavior: opts.instruction,
    reuse_rationale: "r",
    proposed_scope: "project",
    provenance: "llm_derived",
    created_by: "test",
  }) as { id: number };
  const rule = store.createRule({
    learning_id: learning.id,
    correction_candidate_id: candidate.id,
    instruction: opts.instruction,
    scope: "project",
    applies_when: "always",
    predicted_failure: "p",
    ownership: "harness",
    created_by: "test",
  }) as { id: number };
  // Mirrors propose.ts's own behavior: a candidate whose destination
  // includes a Skill always comes with a skill_proposals row (see
  // proposeRules -- the Rule writer never leaves one of these two facts
  // true without the other).
  const wantsSkillProposal =
    opts.withSkillProposal ?? (opts.destination === "skill" || opts.destination === "both");
  if (wantsSkillProposal) {
    store.createSkillProposal({
      correction_candidate_id: candidate.id,
      rule_id: rule.id,
      name: `${opts.instruction
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")}`,
      content: `# ${opts.instruction}\n\n1. Step one.\n2. Step two.\n3. Step three.\n`,
      ownership: "harness",
      created_by: "test seed",
      reason: "proposed by the Rule writer",
    });
  }
  return { candidateId: candidate.id, ruleId: rule.id };
}

// ---- set_content_destination: creates and retires/skips a Skill proposal ----

test("set_content_destination: knowledge -> skill creates a deterministic Skill proposal (no LLM call)", () => {
  const { candidateId } = seedSuggestion({ instruction: "Always run the deploy checklist." });
  const before = imp.getImprovement(candidateId)!;
  assert.equal(before.skill_proposal, null);

  const after = imp.improvementAction({
    action: "set_content_destination",
    id: candidateId,
    destination: "skill",
  });
  assert.equal(after.content_destination?.value, "skill");
  assert.equal(after.content_destination?.chosen_by, "user");
  assert.ok(after.skill_proposal);
  assert.equal(after.skill_proposal?.status, "proposed");
  assert.equal(after.skill_proposal?.ownership, "harness");
  assert.equal(after.skill_proposal?.lovable_state, "not_created");
  assert.match(after.skill_proposal!.name, /^[a-z0-9-]+$/);
  assert.match(after.skill_proposal!.content, /^# /);
  assert.match(after.skill_proposal!.content, /1\. Inspect the existing implementation\./);
  assert.match(after.skill_proposal!.content, /2\. Apply: Always run the deploy checklist\./);
  assert.match(after.skill_proposal!.content, /3\. Verify the result\./);
});

test("set_content_destination: skill -> knowledge skips a still-proposed Skill; approved -> knowledge retires it", () => {
  const { candidateId } = seedSuggestion({ instruction: "Always lint before committing." });
  imp.improvementAction({
    action: "set_content_destination",
    id: candidateId,
    destination: "skill",
  });
  let item = imp.getImprovement(candidateId)!;
  const proposalId = item.skill_proposal!.id;

  item = imp.improvementAction({
    action: "set_content_destination",
    id: candidateId,
    destination: "knowledge",
  });
  assert.equal(item.content_destination?.value, "knowledge");
  const skippedRow = store.getSkillProposal(proposalId)!;
  assert.equal(skippedRow.status, "skipped");

  // Back to skill (creates a fresh proposal since the old one is skipped),
  // then approve it, then back to knowledge -- this time it's retired, not
  // skipped, because it had already been approved.
  imp.improvementAction({
    action: "set_content_destination",
    id: candidateId,
    destination: "skill",
  });
  item = imp.getImprovement(candidateId)!;
  const secondProposalId = item.skill_proposal!.id;
  assert.notEqual(secondProposalId, proposalId);
  imp.improvementAction({ action: "approve_skill_proposal", proposal_id: secondProposalId });
  imp.improvementAction({
    action: "set_content_destination",
    id: candidateId,
    destination: "knowledge",
  });
  const retiredRow = store.getSkillProposal(secondProposalId)!;
  assert.equal(retiredRow.status, "retired");
});

// ---- edit / approve / retire / restore ----

test("edit_skill_proposal creates a revision; approve_skill_proposal / retire_skill_proposal change status with their own revisions", () => {
  const { candidateId } = seedSuggestion({
    instruction: "Always add a health check endpoint.",
    destination: "skill",
  });
  const seeded = imp.getImprovement(candidateId)!;
  const proposalId = seeded.skill_proposal!.id;
  assert.equal(seeded.skill_proposal!.revisions.length, 1, "the first revision, from proposing it");

  const edited = imp.improvementAction({
    action: "edit_skill_proposal",
    proposal_id: proposalId,
    name: "health-check-endpoint",
    content: "# Health check endpoint\n\n1. Add /health.\n2. Return 200.\n",
  });
  assert.equal(edited.skill_proposal?.name, "health-check-endpoint");
  assert.match(edited.skill_proposal!.content, /Return 200/);
  assert.equal(edited.skill_proposal?.revisions.length, 2);

  const approved = imp.improvementAction({
    action: "approve_skill_proposal",
    proposal_id: proposalId,
  });
  assert.equal(approved.skill_proposal?.status, "approved");
  assert.equal(approved.skill_proposal?.revisions.length, 3);

  const retired = imp.improvementAction({
    action: "retire_skill_proposal",
    proposal_id: proposalId,
  });
  assert.equal(retired.skill_proposal?.status, "retired");
  assert.equal(retired.skill_proposal?.revisions.length, 4);
});

test("restore_skill_proposal_revision restores name/content from an earlier revision, as a new revision", () => {
  const { candidateId } = seedSuggestion({
    instruction: "Always tag releases with semver.",
    destination: "skill",
  });
  const seeded = imp.getImprovement(candidateId)!;
  const proposalId = seeded.skill_proposal!.id;
  const originalName = seeded.skill_proposal!.name;
  const originalContent = seeded.skill_proposal!.content;
  const firstRevisionId = seeded.skill_proposal!.revisions[0]!.id;

  imp.improvementAction({
    action: "edit_skill_proposal",
    proposal_id: proposalId,
    name: "renamed-skill",
    content: "# Renamed\n\n1. Different.\n2. Content.\n3. Entirely.\n",
  });

  const restored = imp.improvementAction({
    action: "restore_skill_proposal_revision",
    proposal_id: proposalId,
    revision_id: firstRevisionId,
  });
  assert.equal(restored.skill_proposal?.name, originalName);
  assert.equal(restored.skill_proposal?.content, originalContent);
  const lastRevision = restored.skill_proposal!.revisions.at(-1)!;
  assert.equal(lastRevision.reason, `restored revision ${firstRevisionId}`);
});

test("a user-owned Skill proposal refuses edit/approve/retire/restore with the exact honesty sentence", () => {
  const { candidateId } = seedSuggestion({
    instruction: "Always use the shared design tokens.",
    destination: "skill",
  });
  const seeded = imp.getImprovement(candidateId)!;
  const proposalId = seeded.skill_proposal!.id;
  db.prepare(`UPDATE skill_proposals SET ownership = 'user' WHERE id = ?`).run(proposalId);

  const REFUSAL = "This Skill is yours; Harness Ledger does not change user-owned Skills.";
  assert.throws(
    () =>
      imp.improvementAction({
        action: "edit_skill_proposal",
        proposal_id: proposalId,
        name: "x",
        content: "y",
      }),
    { message: REFUSAL },
  );
  assert.throws(() =>
    imp.improvementAction({ action: "approve_skill_proposal", proposal_id: proposalId }),
  );
  assert.throws(() =>
    imp.improvementAction({ action: "retire_skill_proposal", proposal_id: proposalId }),
  );
  assert.throws(() =>
    imp.improvementAction({
      action: "restore_skill_proposal_revision",
      proposal_id: proposalId,
      revision_id: seeded.skill_proposal!.revisions[0]!.id,
    }),
  );
  // Untouched by every refused call.
  const stillUser = store.getSkillProposal(proposalId)!;
  assert.equal(stillUser.ownership, "user");
  assert.equal(stillUser.status, "proposed");
});

// ---- accept with a Skill destination never stages a Knowledge write ----

test("accept with destination 'skill' approves the Skill proposal and never stages a Knowledge write", () => {
  const { candidateId, ruleId } = seedSuggestion({
    instruction: "Always run migrations before seeding demo data.",
    destination: "skill",
  });

  const before = (
    db.prepare(`SELECT COUNT(*) n FROM knowledge_versions WHERE rule_id = ?`).get(ruleId) as {
      n: number;
    }
  ).n;
  assert.equal(before, 0);

  const item = imp.improvementAction({ action: "accept", id: candidateId, destination: "skill" });
  assert.equal(item.decision.status, "accepted");
  assert.ok(item.skill_proposal);
  assert.equal(item.skill_proposal?.status, "approved");

  const after = (
    db.prepare(`SELECT COUNT(*) n FROM knowledge_versions WHERE rule_id = ?`).get(ruleId) as {
      n: number;
    }
  ).n;
  assert.equal(after, 0, "no pending (or any) knowledge_versions row for a Skill-only accept");

  const pending = db
    .prepare(`SELECT COUNT(*) n FROM knowledge_versions WHERE rule_id = ? AND status = 'pending'`)
    .get(ruleId) as { n: number };
  assert.equal(pending.n, 0);
});

test("accept with destination 'skill' for a candidate the Rule writer marked 'skill' too creates the proposal when none exists yet", () => {
  const { candidateId, ruleId } = seedSuggestion({
    instruction: "Always regenerate the OpenAPI spec after a route change.",
    destination: "skill",
    withSkillProposal: false,
  });
  const seeded = imp.getImprovement(candidateId)!;
  assert.equal(
    seeded.skill_proposal,
    null,
    "no proposal yet -- the Rule writer fixture didn't add one",
  );

  const item = imp.improvementAction({ action: "accept", id: candidateId, destination: "skill" });
  assert.ok(item.skill_proposal, "accept creates one deterministically when none existed");
  assert.equal(item.skill_proposal?.status, "approved");

  const versions = db
    .prepare(`SELECT COUNT(*) n FROM knowledge_versions WHERE rule_id = ?`)
    .get(ruleId) as { n: number };
  assert.equal(versions.n, 0);
});
