// Checkpoint 3 I1: the Inbox aggregation and its lifecycle -- every source
// listInboxItems folds in (pending suggestions, in-progress/judging/failed
// runs, rule health, open retire proposals, stale/failed Knowledge writes,
// open analysis disagreements), each proven to appear while open and
// disappear once decided/resolved/superseded. Same disposable-temp-DB
// fixture pattern as improvements.test.ts and skill-proposals.test.ts --
// never the real DB (see harness/data/, never touched here).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.HARNESS_DB_PATH = join(
  mkdtempSync(join(tmpdir(), "harness-inbox-lifecycle-test-")),
  "harness.db",
);

const { db } = await import("../src/db.js");
const store = await import("../src/store.js");
const imp = await import("../src/improvements.js");
const reanalyse = await import("../src/analysis/reanalyse.js");

// ---- fixtures ----

let projSeq = 0;
/** A fresh allowed project, isolated from every other test in this file --
 * needed wherever a test seeds knowledge_versions rows directly (the Inbox
 * groups those by target/project, so two tests sharing a project would see
 * each other's rows as "the newest for this target"). */
function freshProject(): string {
  projSeq += 1;
  const id = `inbox-lifecycle-project-${projSeq}`;
  db.prepare(`INSERT INTO allowed_projects (lovable_project_id, label) VALUES (?, ?)`).run(id, id);
  store.upsertProject({ lovable_project_id: id, name: `Inbox Test Project ${projSeq}` });
  return id;
}

let msgSeq = 0;
function msg(projectId: string, role: "user" | "assistant", content: string) {
  msgSeq += 1;
  return store.upsertHistoryItem({
    project_id: projectId,
    kind: "message",
    role,
    content,
    occurred_at: "2026-09-10T10:00:00.000Z",
    provenance: "lovable_mcp",
    external_id: `inbox-ext-${msgSeq}`,
  }) as { id: number };
}

/** A fresh correction/learning/rule chain, exactly like a real suggestion --
 * mirrors skill-proposals.test.ts's own seedSuggestion helper (same file
 * pattern, kept local here since test files never import each other). */
function seedSuggestion(opts: {
  projectId: string;
  instruction: string;
  destination?: "knowledge" | "skill" | "both";
}): { candidateId: number; ruleId: number; episodeId: number } {
  const request = msg(opts.projectId, "user", `Build feature for ${opts.instruction}`);
  const correction = msg(opts.projectId, "user", `Fix: ${opts.instruction}`);
  const episode = store.createTaskEpisode({
    project_id: opts.projectId,
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
  if (opts.destination === "skill" || opts.destination === "both") {
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
  return { candidateId: candidate.id, ruleId: rule.id, episodeId: episode.id };
}

/** A live rule (state 'active', a written Knowledge version at this
 * project) -- same technique as rule-health.test.ts's own makeLiveRule
 * (store.ts has no way to mark a version 'written' without a real
 * read-back, so the row is inserted directly here). */
function makeLiveRule(projectId: string, ruleId: number): void {
  store.updateRule({ id: ruleId, state: "active", actor: "test" });
  db.prepare(
    `INSERT INTO knowledge_versions
       (rule_id, target, project_id, previous_content, new_content, previous_sha256, new_sha256, rule_ids_json, status, actor, written_at)
     VALUES (?, 'project', ?, '', '', '', '', '[]', 'written', 'test', datetime('now'))`,
  ).run(ruleId, projectId);
}

function createRun(
  candidateId: number,
  ruleId: number,
  episodeId: number,
  projectId: string,
): { id: number } {
  return store.createExperimentRun({
    rule_id: ruleId,
    correction_candidate_id: candidateId,
    task_episode_id: episodeId,
    source_project_id: projectId,
    request_message_external_id: `inbox-run-req-${ruleId}`,
  });
}

function inboxItems() {
  return imp.listInboxItems({ connected: false });
}

function assertCountMatches(): void {
  assert.equal(
    imp.inboxCount({ connected: false }),
    inboxItems().length,
    "inboxCount() must equal listInboxItems().length",
  );
}

function findItem(id: string) {
  return inboxItems().find((i) => i.id === id) ?? null;
}

// ---- 1. new_instruction: open Knowledge suggestion, once, with a judged
// run's conclusion carried on the same item ----

test("an open Knowledge suggestion appears exactly once as new_instruction, and a judged run's conclusion rides along on it", () => {
  const projectId = freshProject();
  const { candidateId, ruleId, episodeId } = seedSuggestion({
    projectId,
    instruction: "Always validate emails before submit.",
  });

  const before = inboxItems().filter((i) => i.id === `suggestion:${candidateId}`);
  assert.equal(before.length, 1, "exactly one Inbox item for this suggestion");
  assert.equal(before[0]!.type, "new_instruction");
  assert.equal(before[0]!.conclusion, null);
  assertCountMatches();

  const run = createRun(candidateId, ruleId, episodeId, projectId);
  store.updateExperimentRun(run.id, {
    status: "judged",
    environment_json: JSON.stringify({ version: 1, quality: "controlled" }),
    verdicts_json: JSON.stringify(["no", "no", "no"]),
    judged_at: "2026-09-11T00:00:00Z",
  });

  const items = inboxItems().filter((i) => i.id === `suggestion:${candidateId}`);
  assert.equal(items.length, 1, "still exactly one item -- the judged run is not a second item");
  assert.equal(items[0]!.type, "new_instruction");
  assert.ok(items[0]!.run, "the judged run rides along on the suggestion item");
  assert.equal(items[0]!.run!.id, run.id);
  assert.equal(items[0]!.conclusion, "historical_support");
  // The run itself never becomes its own test_result item once judged.
  assert.equal(findItem(`run:${run.id}`), null);
  assertCountMatches();
});

// ---- 2. accept: leaves the Inbox, the rule reads live in Instructions,
// a decision node appears in the timeline ----

test("accepting a suggestion removes it from the Inbox, the rule reads live in Instructions, and a decision node appears in buildTimeline", () => {
  const projectId = freshProject();
  const { candidateId, ruleId } = seedSuggestion({
    projectId,
    instruction: "Always run migrations before seeding demo data.",
  });
  assert.ok(findItem(`suggestion:${candidateId}`), "pending suggestion starts in the Inbox");

  imp.improvementAction({ action: "accept", id: candidateId, destination: "project" });

  assert.equal(findItem(`suggestion:${candidateId}`), null, "accepted suggestion leaves the Inbox");
  assertCountMatches();

  // Instructions data: the same read src/routes/api/public/harness/knowledge.ts
  // uses (activeRulesForTarget), re-exported on the adapter unchanged.
  const activeRules = store.activeRulesForTarget("project", projectId) as { id: number }[];
  assert.ok(
    activeRules.some((r) => r.id === ruleId),
    "the accepted rule reads live in the Instructions data",
  );

  const timeline = imp.buildTimeline("project", projectId);
  const decision = timeline.find(
    (n) => n.kind === "decision" && n.rule_ids.includes(ruleId) && n.label === "You accepted",
  );
  assert.ok(decision, "a decision node for the accept appears in buildTimeline");
});

// ---- 3. skip: leaves the Inbox, a "skipped" decision node appears ----

test("skipping a suggestion removes it from the Inbox and a skipped decision node appears in buildTimeline", () => {
  const projectId = freshProject();
  const { candidateId, ruleId } = seedSuggestion({
    projectId,
    instruction: "Never enable recurring background jobs by default.",
  });
  // Seed one knowledge_versions row for this rule/target so buildTimeline's
  // rule scan (activeRulesForTarget ∪ retiredRulesForTarget ∪ every rule any
  // version belongs to) has a way to find this rule at all -- a rejected
  // rule (what "skip" leaves behind) matches neither of the first two sets.
  db.prepare(
    `INSERT INTO knowledge_versions
       (rule_id, target, project_id, previous_content, new_content, previous_sha256, new_sha256, rule_ids_json, status, actor)
     VALUES (?, 'project', ?, '', '', '', '', '[]', 'cancelled', 'test')`,
  ).run(ruleId, projectId);

  imp.improvementAction({ action: "skip", id: candidateId });

  assert.equal(findItem(`suggestion:${candidateId}`), null, "skipped suggestion leaves the Inbox");
  assertCountMatches();

  const timeline = imp.buildTimeline("project", projectId);
  const decision = timeline.find(
    (n) => n.kind === "decision" && n.rule_ids.includes(ruleId) && n.label === "You skipped",
  );
  assert.ok(decision, "a 'You skipped' decision node appears in buildTimeline");
});

// ---- 4. new_skill: a Skill-destination suggestion, approving its Skill
// proposal decides the suggestion and removes it from the Inbox ----

test("a Skill-destination suggestion appears as new_skill; approving its Skill proposal removes it from the Inbox and decides the suggestion", () => {
  const projectId = freshProject();
  const { candidateId } = seedSuggestion({
    projectId,
    instruction: "Always add a health check endpoint.",
    destination: "skill",
  });

  const before = findItem(`suggestion:${candidateId}`);
  assert.ok(before, "the Skill-destination suggestion starts in the Inbox");
  assert.equal(before!.type, "new_skill");
  assertCountMatches();

  const proposalId = imp.getImprovement(candidateId)!.skill_proposal!.id;
  imp.improvementAction({ action: "approve_skill_proposal", proposal_id: proposalId });

  assert.equal(
    findItem(`suggestion:${candidateId}`),
    null,
    "approving the Skill proposal removes the suggestion from the Inbox",
  );
  assertCountMatches();

  const decided = imp.getImprovement(candidateId)!;
  assert.equal(
    decided.decision.status,
    "accepted",
    "approving a skill-only suggestion's Skill IS its decision",
  );

  const skillsView = store.listSkillProposalsForSkillsView();
  assert.ok(
    skillsView.some((p) => p.id === proposalId && p.status === "approved"),
    "the approved proposal appears in listSkillProposalsForSkillsView",
  );
});

// ---- 5. test_result: a judging run ----

test("a run with status judging appears as test_result and in listTestRunSummaries", () => {
  const projectId = freshProject();
  const { candidateId, ruleId, episodeId } = seedSuggestion({
    projectId,
    instruction: "Always paginate large list views.",
  });
  const run = createRun(candidateId, ruleId, episodeId, projectId);
  store.updateExperimentRun(run.id, { status: "judging" });

  const item = findItem(`run:${run.id}`);
  assert.ok(item, "the judging run appears in the Inbox");
  assert.equal(item!.type, "test_result");
  assert.equal(item!.link.page, "judge");
  assert.equal(item!.link.run_id, run.id);
  assertCountMatches();

  const summaries = imp.listTestRunSummaries();
  assert.ok(
    summaries.some((r) => r.id === run.id && r.status === "judging"),
    "the run appears in listTestRunSummaries",
  );
});

// ---- 6. rule_attention: a rule needing review, and an open retire
// proposal (never duplicated even when both signals fire on the same rule)

test("a rule with health status review appears as rule_attention and in the Instructions read; an open retire proposal appears once, not twice", () => {
  const projectId = freshProject();

  // 6a: health status "review", no open proposal.
  const reviewOnly = seedSuggestion({ projectId, instruction: "Always debounce search input." });
  makeLiveRule(projectId, reviewOnly.ruleId);
  store.upsertRuleHealth({
    rule_id: reviewOnly.ruleId,
    applicable_tasks: 2,
    helped: 1,
    hurt: 1,
    last_applicable_at: "2026-09-10T00:00:00Z",
    contradicted_by_rule_id: null,
    unused_since: null,
    status: "review",
    snoozed_until: null,
    review_reason: "inactive",
  });

  const reviewItem = findItem(`rule:${reviewOnly.ruleId}`);
  assert.ok(reviewItem, "the review-status rule appears as rule_attention");
  assert.equal(reviewItem!.type, "rule_attention");
  assertCountMatches();

  const activeRules = store.activeRulesForTarget("project", projectId) as { id: number }[];
  assert.ok(
    activeRules.some((r) => r.id === reviewOnly.ruleId),
    "the rule also reads live in the Instructions data",
  );
  assert.equal(store.getRuleHealth(reviewOnly.ruleId)!.status, "review");

  // 6b: an open retire proposal AND a "review" health row on the same rule
  // -- must still surface as exactly one rule_attention item.
  const both = seedSuggestion({ projectId, instruction: "Always cache API responses." });
  makeLiveRule(projectId, both.ruleId);
  store.upsertRuleHealth({
    rule_id: both.ruleId,
    applicable_tasks: 3,
    helped: 0,
    hurt: 3,
    last_applicable_at: "2026-09-10T00:00:00Z",
    contradicted_by_rule_id: null,
    unused_since: null,
    status: "review",
    snoozed_until: null,
    review_reason: "repeated_issue",
  });
  store.createRetireProposal({ rule_id: both.ruleId, reason: "hurt", evidence: [] });

  const bothItems = inboxItems().filter((i) => i.id === `rule:${both.ruleId}`);
  assert.equal(
    bothItems.length,
    1,
    "a rule with both an open proposal and a review health status is still one item, not two",
  );
  assert.equal(bothItems[0]!.type, "rule_attention");
  assertCountMatches();
});

// ---- 7. conflict / action_failed from knowledge_versions, gated to the
// newest version per target ----

test("a stale newest knowledge version is a conflict, a failed one is action_failed, and an older stale version a later written one supersedes is neither", () => {
  const projectId = freshProject();
  const { ruleId } = seedSuggestion({
    projectId,
    instruction: "Always show a loading state for async actions.",
  });

  // Older stale version, then a newer WRITTEN one for the same target --
  // superseded, must not appear at all.
  const v1 = store.createPendingKnowledgeVersion({
    rule_id: ruleId,
    target: "project",
    project_id: projectId,
    previous_content: "",
    new_content: "old content",
    rule_ids: [ruleId],
    actor: "test",
  });
  store.markKnowledgeWriteStale(v1.id, "Knowledge changed underneath this write");
  const v2 = store.createPendingKnowledgeVersion({
    rule_id: ruleId,
    target: "project",
    project_id: projectId,
    previous_content: "old content",
    new_content: "new content",
    rule_ids: [ruleId],
    actor: "test",
  });
  store.recordKnowledgeReadback(v2.id, "new content");

  assert.equal(findItem(`write:${v1.id}`), null, "the superseded stale version is not an item");
  assert.equal(findItem(`write:${v2.id}`), null, "a written version is never an item");
  assertCountMatches();

  // A fresh target: newest version stale -> conflict.
  const staleProject = freshProject();
  const { ruleId: staleRuleId } = seedSuggestion({
    projectId: staleProject,
    instruction: "Always confirm destructive actions.",
  });
  const staleVersion = store.createPendingKnowledgeVersion({
    rule_id: staleRuleId,
    target: "project",
    project_id: staleProject,
    previous_content: "",
    new_content: "x",
    rule_ids: [staleRuleId],
    actor: "test",
  });
  store.markKnowledgeWriteStale(staleVersion.id, "Knowledge changed in Lovable");
  const staleItem = findItem(`write:${staleVersion.id}`);
  assert.ok(staleItem, "the newest stale version for its target is a conflict");
  assert.equal(staleItem!.type, "conflict");
  assertCountMatches();

  // Another fresh target: newest version failed -> action_failed.
  const failedProject = freshProject();
  const { ruleId: failedRuleId } = seedSuggestion({
    projectId: failedProject,
    instruction: "Always retry a failed network request once.",
  });
  const failedVersion = store.createPendingKnowledgeVersion({
    rule_id: failedRuleId,
    target: "project",
    project_id: failedProject,
    previous_content: "",
    new_content: "y",
    rule_ids: [failedRuleId],
    actor: "test",
  });
  store.markKnowledgeWriteFailed(failedVersion.id, "Lovable returned a 500");
  const failedItem = findItem(`write:${failedVersion.id}`);
  assert.ok(failedItem, "the newest failed version for its target is action_failed");
  assert.equal(failedItem!.type, "action_failed");
  assert.equal(failedItem!.summary, "Lovable returned a 500");
  assertCountMatches();
});

// ---- 8. conflict from an open analysis disagreement ----

// A full DisagreementSnapshot (see analysis/reanalyse.ts) -- acceptDisagreement
// writes every one of these fields into message_classifications, so each must
// be a value that column would actually accept (a real history_item_id, and
// a classification from message_classifications' own enum, which is NOT the
// same enum correction_candidates.classification uses).
function disagreementSnapshot(historyItemId: number, classification: "correction" | "other") {
  return JSON.stringify({
    history_item_id: historyItemId,
    classification,
    tags: ["general"],
    summary: `snapshot: ${classification}`,
    content_hash: null,
    prompt_version: null,
  });
}

test("an open analysis disagreement appears as conflict; accepting or dismissing it removes it", () => {
  const projectId = freshProject();
  const { candidateId: acceptCandidateId } = seedSuggestion({
    projectId,
    instruction: "Always sanitize user-provided HTML.",
  });
  const acceptHistoryItem = msg(projectId, "user", "disagreement fixture message (accept)");
  const acceptRow = db
    .prepare(
      `INSERT INTO analysis_disagreements (correction_candidate_id, previous_json, proposed_json)
       VALUES (?, ?, ?) RETURNING id`,
    )
    .get(
      acceptCandidateId,
      disagreementSnapshot(acceptHistoryItem.id, "other"),
      disagreementSnapshot(acceptHistoryItem.id, "correction"),
    ) as { id: number };

  const item = findItem(`disagreement:${acceptRow.id}`);
  assert.ok(item, "the open disagreement appears as a conflict");
  assert.equal(item!.type, "conflict");
  assertCountMatches();

  reanalyse.acceptDisagreement(acceptRow.id);
  assert.equal(
    findItem(`disagreement:${acceptRow.id}`),
    null,
    "accepting the disagreement removes it from the Inbox",
  );
  assertCountMatches();

  const { candidateId: dismissCandidateId } = seedSuggestion({
    projectId,
    instruction: "Always debounce the search box.",
  });
  const dismissHistoryItem = msg(projectId, "user", "disagreement fixture message (dismiss)");
  const dismissRow = db
    .prepare(
      `INSERT INTO analysis_disagreements (correction_candidate_id, previous_json, proposed_json)
       VALUES (?, ?, ?) RETURNING id`,
    )
    .get(
      dismissCandidateId,
      disagreementSnapshot(dismissHistoryItem.id, "other"),
      disagreementSnapshot(dismissHistoryItem.id, "correction"),
    ) as { id: number };
  assert.ok(findItem(`disagreement:${dismissRow.id}`));

  reanalyse.dismissDisagreement(dismissRow.id);
  assert.equal(
    findItem(`disagreement:${dismissRow.id}`),
    null,
    "dismissing the disagreement removes it from the Inbox",
  );
  assertCountMatches();
});

// ---- 9. action_failed from a run, until a newer run for the same rule ----

test("a failed run appears as action_failed until a newer run exists for the same rule", () => {
  const projectId = freshProject();
  const { candidateId, ruleId, episodeId } = seedSuggestion({
    projectId,
    instruction: "Always show an empty state for zero results.",
  });
  const oldRun = createRun(candidateId, ruleId, episodeId, projectId);
  store.updateExperimentRun(oldRun.id, {
    status: "failed",
    error: "The remix timed out",
    finished_at: "2026-09-11T00:00:00Z",
  });

  const failedItem = findItem(`run:${oldRun.id}`);
  assert.ok(failedItem, "the failed run appears as action_failed");
  assert.equal(failedItem!.type, "action_failed");
  assert.equal(failedItem!.summary, "The remix timed out");
  assertCountMatches();

  // A newer run for the SAME rule supersedes it.
  createRun(candidateId, ruleId, episodeId, projectId);
  assert.equal(
    findItem(`run:${oldRun.id}`),
    null,
    "a newer run for the same rule supersedes the failed one",
  );
  assertCountMatches();
});

// ---- 10 is covered throughout: assertCountMatches() runs after every
// state change above.

// ---- 11. structural: exactly one listInboxItems definition, and the
// improvements route's ?inbox=1 branch calls adapter.listInboxItems ----

test("structural: listInboxItems is defined exactly once, and the improvements route's ?inbox=1 branch calls adapter.listInboxItems", () => {
  const root = fileURLToPath(new URL("../..", import.meta.url));

  function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") return [];
        return walk(full);
      }
      return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
    });
  }

  const searchDirs = [join(root, "harness/src"), join(root, "src/routes/api")];
  let definitionCount = 0;
  const definitionFiles: string[] = [];
  for (const dir of searchDirs) {
    if (!statSync(dir, { throwIfNoEntry: false })) continue;
    for (const file of walk(dir)) {
      const code = readFileSync(file, "utf8");
      const matches = code.match(/(^|\s)function\s+listInboxItems\s*\(/g) ?? [];
      if (matches.length > 0) {
        definitionCount += matches.length;
        definitionFiles.push(file.replace(root, ""));
      }
    }
  }
  assert.equal(
    definitionCount,
    1,
    `listInboxItems must be defined exactly once, found in: ${definitionFiles.join(", ")}`,
  );

  const routeSrc = readFileSync(
    join(root, "src/routes/api/public/harness/improvements.ts"),
    "utf8",
  );
  assert.match(routeSrc, /searchParams\.get\("inbox"\)/, "the route must branch on ?inbox=1");
  assert.match(
    routeSrc,
    /adapter\.listInboxItems\(/,
    "the route's inbox branch must call adapter.listInboxItems",
  );
});

// ---- 12. budget/permission parity: the appended Inbox block adds no
// mutation of its own ----

test("budget/permission parity: the appended Checkpoint 3 I1 Inbox block contains no db.prepare INSERT/UPDATE/DELETE", () => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const source = readFileSync(join(root, "harness/src/improvements.ts"), "utf8");
  const start = source.indexOf("// ---- Checkpoint 3 I1: Inbox ----");
  const end = source.indexOf("// ---- end Checkpoint 3 I1: Inbox ----");
  assert.ok(start >= 0 && end > start, "the Checkpoint 3 I1 Inbox block markers must be present");
  const block = source.slice(start, end);
  const mutating = block.match(/db\.prepare\(\s*[`"'][^`"']*(INSERT|UPDATE|DELETE)/gi) ?? [];
  assert.deepEqual(mutating, [], "the appended Inbox block must add no db.prepare mutation");
});

// ---- 13. Checkpoint 3 S1: a failed Skill publish is action_failed, a
// created one is never an Inbox item ----

test("a Skill proposal whose last publish attempt failed is action_failed, and disappears once it's published", () => {
  const projectId = freshProject();
  const { candidateId } = seedSuggestion({
    projectId,
    instruction: "Always run the release checklist for inbox lifecycle.",
    destination: "skill",
  });
  const before = imp.getImprovement(candidateId)!;
  const proposalId = before.skill_proposal!.id;
  store.setSkillProposalStatus({ id: proposalId, status: "approved", actor: "test" });

  // Nothing attempted yet: no Inbox item from this proposal.
  assert.ok(!imp.listInboxItems({ connected: false }).some((i) => i.id === `skill:${proposalId}`));

  store.setSkillProposalLovableState({
    id: proposalId,
    lovable_state: "failed",
    error: "Lovable returned a 500",
    actor: "test",
    reason: "publish failed: Lovable returned a 500",
  });
  const failedItem = imp
    .listInboxItems({ connected: false })
    .find((i) => i.id === `skill:${proposalId}`);
  assert.ok(failedItem, "a failed publish attempt is an Inbox item");
  assert.equal(failedItem!.type, "action_failed");
  assert.equal(failedItem!.summary, "Lovable returned a 500");
  assert.equal(failedItem!.recommended_action, "retry");
  assert.deepEqual(failedItem!.link, { page: "skills" });

  store.setSkillProposalLovableState({
    id: proposalId,
    lovable_state: "created",
    written_at: new Date().toISOString(),
    readback_ok: true,
    actor: "test",
    reason: "published to Lovable",
  });
  assert.ok(
    !imp.listInboxItems({ connected: false }).some((i) => i.id === `skill:${proposalId}`),
    "a created Skill is never an Inbox item",
  );
});
