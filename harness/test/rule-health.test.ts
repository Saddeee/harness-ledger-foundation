import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolated temp DB for this test file, set before db.ts is first imported.
process.env.HARNESS_DB_PATH = join(
  mkdtempSync(join(tmpdir(), "harness-rule-health-test-")),
  "harness.db",
);

const { db } = await import("../src/db.js");
const store = await import("../src/store.js");
const { recomputeRuleHealth } = await import("../src/analysis/health.js");
// Round 5 Task 7 / spec §5 "which count": the third appended test below
// exercises the verdict action's own hurt bump (improvements.ts, Task 3)
// end to end against a rule this file's own recomputeRuleHealth scores.
const imp = await import("../src/improvements.js");

// Round 5 Task 7: restores the default evidence_sources setting -- every
// appended test below that toggles a source calls this when it's done, so
// it never leaks into a later test (in this file or, since settings are
// process-global, any test file that happens to share this same temp DB).
function resetEvidenceSources(): void {
  store.setSettings({
    evidence_sources: JSON.stringify({
      observed: true,
      adherence: true,
      verdicts: true,
      paired: false,
    }),
  });
}

const PROJECT = "rule-health-project";
db.prepare(`INSERT INTO allowed_projects (lovable_project_id, label) VALUES (?, ?)`).run(
  PROJECT,
  "test",
);
store.upsertProject({ lovable_project_id: PROJECT, name: "Test Project" });

// A fixed "now" (today, per the environment) so every day-math in the test
// is exact rather than depending on when the suite happens to run.
const NOW = new Date("2026-09-11T00:00:00Z");
const RULE_WRITTEN_AT = "2026-09-01T00:00:00.000Z"; // 10 days before NOW

let historyId = 0;
function message(content: string, occurredAt: string, role: "user" | "assistant" = "user") {
  const row = store.upsertHistoryItem({
    project_id: PROJECT,
    kind: "message",
    external_id: `m-${(historyId += 1)}`,
    role,
    content,
    occurred_at: occurredAt,
    provenance: "lovable_mcp",
  }) as { id: number };
  return row.id;
}

function classify(historyItemId: number, classification: string, tags: string[], summary = "") {
  db.prepare(
    `INSERT INTO message_classifications (history_item_id, classification, tags_json, summary) VALUES (?, ?, ?, ?)`,
  ).run(historyItemId, classification, JSON.stringify(tags), summary);
}

function episode(startedAt: string, evidenceIds: number[], projectId: string = PROJECT) {
  const row = store.createTaskEpisode({
    project_id: projectId,
    title: `episode at ${startedAt}`,
    provenance: "llm_derived",
    started_at: startedAt,
    evidence_history_item_ids: evidenceIds,
  }) as { id: number };
  return row.id;
}

// Builds a full rule chain (correction_candidate -> learning -> rule),
// exactly as the MCP tools / the miner would, then marks it 'active' with a
// 'written' Knowledge version backdated to `writtenAt` (store.ts has no way
// to backdate a write through recordKnowledgeReadback, which always stamps
// datetime('now'), so the write row is inserted directly here).
function makeLiveRule(input: {
  predictedFailure: string;
  failureSignature: string;
  scopeTags: string[] | null; // null = leave the v9 default '["general"]'
  writtenAt: string;
  projectId?: string;
}) {
  const projectId = input.projectId ?? PROJECT;
  const episodeForRule = episode(input.writtenAt, [], projectId);
  const cc = store.createCorrectionCandidate({
    task_episode_id: episodeForRule,
    classification: "constraint_restatement",
    is_correction: true,
    reusable: true,
    proposed_scope: "project",
    summary: "seed correction for a rule fixture",
    evidence_history_item_ids: [],
  }) as { id: number };
  const learning = store.createLearning({
    correction_candidate_id: cc.id,
    observed_problem: "seed",
    desired_behavior: "seed",
    reuse_rationale: "seed",
    proposed_scope: "project",
    provenance: "llm_derived",
    created_by: "test",
  }) as { id: number };
  const rule = store.createRule({
    learning_id: learning.id,
    correction_candidate_id: cc.id,
    instruction: "Use design tokens, not hardcoded colors.",
    scope: "project",
    applies_when: "styling changes",
    predicted_failure: input.predictedFailure,
    ownership: "harness",
    created_by: "test",
  }) as { id: number };

  if (input.scopeTags) {
    db.prepare(`UPDATE rules SET scope_tags_json = ? WHERE id = ?`).run(
      JSON.stringify(input.scopeTags),
      rule.id,
    );
  }

  store.createVerificationPlan({
    rule_id: rule.id,
    failure_signature: input.failureSignature,
    failure_condition: "a styling change hardcodes a color instead of using a design token",
    created_by: "test",
    verification_definition_ids: [],
  });

  store.updateRule({ id: rule.id, state: "active", actor: "test" });

  db.prepare(
    `INSERT INTO knowledge_versions
       (rule_id, target, project_id, previous_content, new_content, previous_sha256, new_sha256, rule_ids_json, status, actor, written_at)
     VALUES (?, 'project', ?, '', '', '', '', '[]', 'written', 'test', ?)`,
  ).run(rule.id, projectId, input.writtenAt);

  return rule.id;
}

// ---- Fixture: one live rule, scope ["styling"], plus four episodes after it ----

const styledRuleId = makeLiveRule({
  predictedFailure: "inline colors instead of design tokens",
  failureSignature: "inline-colors-instead-of-design-tokens",
  scopeTags: ["styling"],
  writtenAt: RULE_WRITTEN_AT,
});

// Episode A: applicable (styling), hurt. The correction summary is prose, as
// a real classifier would write it -- never literally equal to the
// kebab-case failure signature -- so this specifically exercises the fuzzy
// slug-vs-signature Dice match, not the exact-equality shortcut.
const reqA = message("Make the CTA button blue.", "2026-09-02T00:00:00Z");
classify(reqA, "new_task", ["styling"]);
const corrA = message(
  "You used inline colors instead of the design tokens again.",
  "2026-09-02T01:00:00Z",
);
classify(
  corrA,
  "correction",
  ["styling"],
  "You used inline colors instead of the design tokens again.",
);
episode("2026-09-02T00:00:00Z", [reqA, corrA]);

// Episode B: applicable (styling), hurt via Dice similarity (>=0.7) of the
// raw correction summary against the rule's predicted failure text, rather
// than the signature-slug path.
const reqB = message("Update the card background.", "2026-09-03T00:00:00Z");
classify(reqB, "new_task", ["styling"]);
const corrB = message(
  "Still seeing inline colors used instead of design tokens on the card.",
  "2026-09-03T01:00:00Z",
);
classify(
  corrB,
  "correction",
  ["styling"],
  "Still seeing inline colors used instead of design tokens on the card.",
);
episode("2026-09-03T00:00:00Z", [reqB, corrB]);

// Episode C: applicable (styling), helped -- it DOES carry a correction, but
// one that is clearly unrelated to this rule's failure signature/prediction,
// so matchesFailure must not fire on it (a corrected episode isn't
// automatically "hurt" just for having a correction).
const reqC = message("Add a settings tab.", "2026-09-04T00:00:00Z");
classify(reqC, "new_task", ["styling"]);
const corrC = message("Please add a dark mode toggle to settings.", "2026-09-04T01:00:00Z");
classify(corrC, "correction", ["styling"], "Please add a dark mode toggle to settings.");
episode("2026-09-04T00:00:00Z", [reqC, corrC]);

// Episode D: NOT applicable to the styling rule (tags don't overlap), even
// though it carries a correction that would otherwise match the signature.
const reqD = message("Fix the webhook retry backoff.", "2026-09-05T00:00:00Z");
classify(reqD, "new_task", ["backend"]);
const corrD = message(
  "The retry still uses the design-system-bypassed color path.",
  "2026-09-05T01:00:00Z",
);
classify(corrD, "correction", ["backend"], "design-system-bypassed");
episode("2026-09-05T00:00:00Z", [reqD, corrD]);

test("recomputeRuleHealth: 3 applicable episodes, 2 hurt (prose summaries, fuzzy-matched) 1 helped (unrelated correction) -> retire_suggested", () => {
  const result = recomputeRuleHealth(NOW);
  assert.equal(result.rules, 1, "only the one live, written rule should be scored so far");
  assert.equal(result.suggested, 1);

  const health = store.getRuleHealth(styledRuleId);
  assert.ok(health);
  assert.equal(health!.applicable_tasks, 3, "episode D's tags don't overlap ['styling']");
  assert.equal(
    health!.hurt,
    2,
    "A hurts via slug(summary)~=failure_signature, B hurts via summary~=prediction -- both prose, neither literally equal",
  );
  assert.equal(
    health!.helped,
    1,
    "C has a correction, but its summary is unrelated to this rule's signature/prediction",
  );
  assert.equal(health!.status, "retire_suggested");
  assert.equal(
    health!.last_applicable_at,
    "2026-09-04T00:00:00Z",
    "latest APPLICABLE episode is C, not D",
  );
  assert.equal(health!.unused_since, null);
});

// A fully isolated project/episode set (never touched by any rule fixture
// above or below) so this is a pure unit test of the read shape.
const PROJECT2 = "rule-health-project-2";
test("store.listEpisodesAfter: tags are the union of classified messages; corrections carry a summary, falling back to the first 200 chars of the message", () => {
  db.prepare(`INSERT INTO allowed_projects (lovable_project_id, label) VALUES (?, ?)`).run(
    PROJECT2,
    "test2",
  );
  store.upsertProject({ lovable_project_id: PROJECT2, name: "Test Project 2" });

  const since = "2026-01-01T00:00:00.000Z";
  const req = message("A task with two tags across its messages.", "2026-02-01T00:00:00Z");
  classify(req, "new_task", ["alpha"]);
  const explicit = message("A correction with an explicit summary.", "2026-02-01T01:00:00Z");
  classify(explicit, "correction", ["beta"], "explicit-summary-text");
  const longContent = "x".repeat(250);
  const noSummary = message(longContent, "2026-02-01T02:00:00Z");
  classify(noSummary, "correction", ["alpha"], "");
  const ep = episode("2026-02-01T00:00:00Z", [req, explicit, noSummary], PROJECT2);

  // Before the cutoff: must never appear.
  const earlierReq = message("earlier, out of range", "2025-12-01T00:00:00Z");
  classify(earlierReq, "new_task", ["alpha"]);
  episode("2025-12-01T00:00:00Z", [earlierReq], PROJECT2);

  const episodes = store.listEpisodesAfter(PROJECT2, since);
  assert.equal(episodes.length, 1, "the earlier episode must be excluded");
  const found = episodes[0]!;
  assert.equal(found.id, ep);
  assert.deepEqual([...found.tags].sort(), ["alpha", "beta"]);
  assert.equal(found.corrections.length, 2);
  const withExplicit = found.corrections.find((c) => c.history_item_id === explicit)!;
  assert.equal(withExplicit.summary, "explicit-summary-text");
  const withFallback = found.corrections.find((c) => c.history_item_id === noSummary)!;
  assert.equal(withFallback.summary, longContent.slice(0, 200));
  assert.equal(withFallback.summary.length, 200);
});

test("snoozeRuleHealth: status becomes snoozed, and a later recompute keeps it snoozed while still in effect", () => {
  const untilIso = "2026-10-11T00:00:00.000Z"; // 30 days after NOW
  const snoozed = store.snoozeRuleHealth(styledRuleId, untilIso);
  assert.equal(snoozed.status, "snoozed");
  assert.equal(snoozed.snoozed_until, untilIso);

  const recomputed = recomputeRuleHealth(NOW);
  assert.equal(recomputed.suggested, 0, "a snoozed rule must not count toward 'suggested'");
  const health = store.getRuleHealth(styledRuleId)!;
  assert.equal(health.status, "snoozed");
  assert.equal(
    health.snoozed_until,
    untilIso,
    "recompute must carry the snooze forward, not clear it",
  );

  // Once the snooze has expired, the same underlying signal resumes.
  const afterExpiry = new Date("2026-11-15T00:00:00Z");
  recomputeRuleHealth(afterExpiry);
  assert.equal(store.getRuleHealth(styledRuleId)!.status, "retire_suggested");
});

test("snoozeRuleHealth: upserts a minimal all-zero row when rule_health has never scored the rule (Task C2's 'Keep' can fire before any recompute)", () => {
  // Written long enough ago, with a tag no fixture episode carries, that
  // this rule is genuinely "unused" -- so the underlying signal still
  // warrants retire_suggested once recomputed, and snoozing it is
  // meaningful (as opposed to a rule with nothing wrong, where a recompute
  // correctly reports 'healthy' regardless of any stored snoozed_until).
  const freshRuleId = makeLiveRule({
    predictedFailure: "never recomputed",
    failureSignature: "never-recomputed",
    scopeTags: ["never-recomputed-tag"],
    writtenAt: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(
    store.getRuleHealth(freshRuleId),
    null,
    "precondition: no prior recompute for this rule",
  );

  const untilIso = "2026-10-11T00:00:00.000Z";
  const snoozed = store.snoozeRuleHealth(freshRuleId, untilIso);
  assert.equal(snoozed.status, "snoozed");
  assert.equal(snoozed.snoozed_until, untilIso);
  assert.equal(snoozed.applicable_tasks, 0);
  assert.equal(snoozed.helped, 0);
  assert.equal(snoozed.hurt, 0);
  assert.equal(snoozed.last_applicable_at, null);
  assert.equal(snoozed.contradicted_by_rule_id, null);
  assert.equal(snoozed.unused_since, null);

  // A subsequent recompute fills in the real counts (still zero here, since
  // this rule's tag matches no fixture episode) and finds it unused, but
  // preserves the snooze instead of reporting retire_suggested.
  recomputeRuleHealth(NOW);
  const after = store.getRuleHealth(freshRuleId)!;
  assert.equal(after.status, "snoozed");
  assert.equal(after.snoozed_until, untilIso);
  assert.equal(after.unused_since, "2026-01-01T00:00:00.000Z");
});

test("recomputeRuleHealth: a rule scoped 'general' applies to every episode regardless of tags", () => {
  const generalRuleId = makeLiveRule({
    predictedFailure:
      "an unrelated, generic mistake that shares no wording with any correction below",
    failureSignature: "totally-unrelated-signature",
    scopeTags: null, // keep the v9 default: '["general"]'
    writtenAt: RULE_WRITTEN_AT,
  });

  const result = recomputeRuleHealth(NOW);
  assert.ok(result.rules >= 2);

  const health = store.getRuleHealth(generalRuleId)!;
  // Episodes A, B, C, D all started after RULE_WRITTEN_AT, so a 'general'
  // rule must count all four as applicable -- including D, which the
  // styling-scoped rule above excluded for having no overlapping tag.
  assert.equal(health.applicable_tasks, 4);
  assert.equal(
    health.hurt,
    0,
    "none of the fixture's correction summaries are close to this rule's own signature/prediction",
  );
  assert.equal(health.helped, 4);
  assert.equal(health.status, "healthy");
});

test("recomputeRuleHealth: unused after the configured number of days -> retire_suggested with unused_since", () => {
  const unusedAfterDays = Number(store.getSetting("rule_unused_after_days"));
  assert.ok(unusedAfterDays > 0);

  const writtenAt = "2026-06-01T00:00:00.000Z"; // well over rule_unused_after_days before NOW
  const unusedRuleId = makeLiveRule({
    predictedFailure: "a performance regression that never shows up in any fixture episode",
    failureSignature: "performance-regression",
    scopeTags: ["performance"], // no fixture episode is tagged 'performance'
    writtenAt,
  });

  recomputeRuleHealth(NOW);
  const health = store.getRuleHealth(unusedRuleId)!;
  assert.equal(health.applicable_tasks, 0);
  assert.equal(health.status, "retire_suggested");
  assert.equal(health.unused_since, writtenAt);
});

test("recomputeRuleHealth: hurt but below the retirement threshold -> watch", () => {
  const watchRuleId = makeLiveRule({
    predictedFailure: "a lone infra regression",
    failureSignature: "lone-infra-regression",
    scopeTags: ["infra"], // a tag no other fixture episode uses, for isolation
    writtenAt: RULE_WRITTEN_AT,
  });

  const req = message("Touch the infra queue again.", "2026-09-07T00:00:00Z");
  classify(req, "new_task", ["infra"]);
  const corr = message("Same infra regression as before.", "2026-09-07T01:00:00Z");
  classify(corr, "correction", ["infra"], "lone-infra-regression");
  episode("2026-09-07T00:00:00Z", [req, corr]);

  recomputeRuleHealth(NOW);
  const health = store.getRuleHealth(watchRuleId)!;
  assert.equal(health.applicable_tasks, 1);
  assert.equal(health.hurt, 1);
  assert.equal(
    health.status,
    "watch",
    "hurt but applicable_tasks < 3, so retirement isn't suggested yet",
  );
});

test("listLiveRulesWithTargets / recomputeRuleHealth: a rule with no written Knowledge version is skipped", () => {
  const episodeForRule = episode(RULE_WRITTEN_AT, []);
  const cc = store.createCorrectionCandidate({
    task_episode_id: episodeForRule,
    classification: "constraint_restatement",
    is_correction: true,
    reusable: true,
    proposed_scope: "project",
    summary: "never written",
    evidence_history_item_ids: [],
  }) as { id: number };
  const learning = store.createLearning({
    correction_candidate_id: cc.id,
    observed_problem: "seed",
    desired_behavior: "seed",
    reuse_rationale: "seed",
    proposed_scope: "project",
    provenance: "llm_derived",
    created_by: "test",
  }) as { id: number };
  const rule = store.createRule({
    learning_id: learning.id,
    correction_candidate_id: cc.id,
    instruction: "Never written to Lovable.",
    scope: "project",
    applies_when: "n/a",
    predicted_failure: "n/a",
    ownership: "harness",
    created_by: "test",
  }) as { id: number };
  // Approved/active, but never given a 'written' knowledge_versions row.
  store.updateRule({ id: rule.id, state: "active", actor: "test" });

  const live = store.listLiveRulesWithTargets();
  assert.equal(
    live.some((r) => r.id === rule.id),
    false,
  );

  const before = store.listRuleHealth().length;
  recomputeRuleHealth(NOW);
  const after = store.listRuleHealth().length;
  assert.equal(
    after,
    before,
    "no rule_health row should be created for a rule that was never written",
  );
  assert.equal(store.getRuleHealth(rule.id), null);
});

// ---- Round 5 Task 7 / spec §5 "which count": evidence_sources gating ----

test("recomputeRuleHealth: a rule_adherence 'broke' row counts as hurt only when evidence_sources.adherence is enabled", () => {
  const ruleId = makeLiveRule({
    predictedFailure: "an accessibility regression judged only by the AI adherence check",
    failureSignature: "adherence-broke-signature",
    scopeTags: ["adherence-broke-tag"],
    writtenAt: RULE_WRITTEN_AT,
  });

  // No correction at all -- the tag-based scan alone would count this as
  // "helped" (a build without a repeat), never hurt.
  const req = message("Add an icon-only button.", "2026-09-08T00:00:00Z");
  classify(req, "new_task", ["adherence-broke-tag"]);
  const epId = episode("2026-09-08T00:00:00Z", [req]);

  store.recordRuleAdherence({
    rule_id: ruleId,
    task_episode_id: epId,
    verdict: "broke",
    quote: "the button has no accessible label",
    llm_call_id: null,
    run_id: null,
  });

  assert.equal(store.getEvidenceSources().adherence, true, "default has adherence enabled");
  recomputeRuleHealth(NOW);
  let health = store.getRuleHealth(ruleId)!;
  assert.equal(health.applicable_tasks, 1);
  assert.equal(
    health.helped,
    1,
    "no correction matched, so the tag-based scan still counts it as a build without a repeat",
  );
  assert.equal(health.hurt, 1, "the broke adherence row adds one more hurt on top of that");

  store.setSettings({
    evidence_sources: JSON.stringify({
      observed: true,
      adherence: false,
      verdicts: true,
      paired: false,
    }),
  });
  recomputeRuleHealth(NOW);
  health = store.getRuleHealth(ruleId)!;
  assert.equal(health.hurt, 0, "with adherence disabled, the broke row no longer counts as hurt");

  resetEvidenceSources();
});

test("recomputeRuleHealth: a matching correction does not count as hurt when evidence_sources.observed is disabled", () => {
  const ruleId = makeLiveRule({
    predictedFailure: "a form validation regression",
    failureSignature: "form-validation-regression",
    scopeTags: ["observed-off-tag"],
    writtenAt: RULE_WRITTEN_AT,
  });

  const req = message("Add a signup form.", "2026-09-09T00:00:00Z");
  classify(req, "new_task", ["observed-off-tag"]);
  const corr = message("The form validation regression is back.", "2026-09-09T01:00:00Z");
  classify(corr, "correction", ["observed-off-tag"], "form-validation-regression");
  episode("2026-09-09T00:00:00Z", [req, corr]);

  recomputeRuleHealth(NOW);
  let health = store.getRuleHealth(ruleId)!;
  assert.equal(health.hurt, 1, "matches by default, with observed enabled");

  store.setSettings({
    evidence_sources: JSON.stringify({
      observed: false,
      adherence: true,
      verdicts: true,
      paired: false,
    }),
  });
  recomputeRuleHealth(NOW);
  health = store.getRuleHealth(ruleId)!;
  assert.equal(
    health.hurt,
    0,
    "with observed disabled, the same correction no longer counts as hurt",
  );
  assert.equal(health.applicable_tasks, 1, "the episode is still counted as applicable");
  assert.equal(health.helped, 1, "and now falls into the 'without a repeat' bucket instead");

  resetEvidenceSources();
});

test("verdict action: a did_not_help verdict bumps rule_health.hurt only when evidence_sources.verdicts is enabled, and the bump survives a later recompute (Round 5 fix wave item 1: derived, not mutated)", () => {
  const ruleId = makeLiveRule({
    predictedFailure: "a rule scored only to exercise the verdict-driven hurt bump",
    failureSignature: "verdict-gate-signature",
    scopeTags: ["verdict-gate-tag"], // a tag no fixture episode uses, for isolation
    writtenAt: RULE_WRITTEN_AT,
  });
  recomputeRuleHealth(NOW); // seeds a rule_health row (hurt: 0 -- no episodes carry this tag)
  assert.equal(store.getRuleHealth(ruleId)!.hurt, 0);

  assert.equal(store.getEvidenceSources().verdicts, true, "default has verdicts enabled");
  // The action itself now just records the verdict and calls
  // recomputeRuleHealth (health.ts reads it back via store.latestRuleVerdict)
  // instead of writing hurt+1 into the stored row directly, so the bump
  // shows up immediately here...
  imp.improvementAction({ action: "verdict", rule_id: ruleId, verdict: "did_not_help" });
  assert.equal(
    store.getRuleHealth(ruleId)!.hurt,
    1,
    "hurt bumps by one when verdicts evidence is enabled",
  );

  // ...and, being a derived input rather than a one-off mutation, survives
  // an unrelated later recompute (an executor sync, an analysis run) intact
  // instead of that recompute clobbering it back to 0.
  recomputeRuleHealth(NOW);
  assert.equal(
    store.getRuleHealth(ruleId)!.hurt,
    1,
    "a later recompute does not lose the verdict-driven hurt",
  );

  store.setSettings({
    evidence_sources: JSON.stringify({
      observed: true,
      adherence: true,
      verdicts: false,
      paired: false,
    }),
  });
  imp.improvementAction({ action: "verdict", rule_id: ruleId, verdict: "did_not_help" });
  assert.equal(
    store.getRuleHealth(ruleId)!.hurt,
    1,
    "a second did_not_help does not bump hurt again while verdicts evidence is disabled",
  );

  resetEvidenceSources();
});

// ---- Fix round 1 item 1: a broke adherence row must count hurt at most
// once per episode, whatever the source. ----

test("recomputeRuleHealth: a broke adherence row counts hurt at most once per episode, whatever the source", () => {
  // Case 1: an episode with BOTH a matching correction (tag-scan hurt) AND
  // a broke adherence row -- must still be hurt exactly once, not twice.
  const ruleId = makeLiveRule({
    predictedFailure: "a regression judged both by the correction match and the AI adherence check",
    failureSignature: "double-count-signature",
    scopeTags: ["double-count-tag"],
    writtenAt: RULE_WRITTEN_AT,
  });
  const req = message("Ship the double-counted feature.", "2026-09-10T00:00:00Z");
  classify(req, "new_task", ["double-count-tag"]);
  const corr = message("Same double-count regression as before.", "2026-09-10T01:00:00Z");
  classify(corr, "correction", ["double-count-tag"], "double-count-signature");
  const epId = episode("2026-09-10T00:00:00Z", [req, corr]);
  store.recordRuleAdherence({
    rule_id: ruleId,
    task_episode_id: epId,
    verdict: "broke",
    quote: "still broken",
    llm_call_id: null,
    run_id: null,
  });

  recomputeRuleHealth(NOW);
  let health = store.getRuleHealth(ruleId)!;
  assert.equal(health.applicable_tasks, 1);
  assert.equal(
    health.hurt,
    1,
    "the matching correction and the broke row are the same episode -- hurt must not double-count it",
  );

  // Case 2: a broke row for an episode the tag-based scan never counted at
  // all (its tags don't overlap the rule's scope) -- mirrors the `followed`
  // guard: adds exactly one applicable_tasks and one hurt, not zero.
  const onlyBrokeRuleId = makeLiveRule({
    predictedFailure: "a regression only the AI adherence check ever caught",
    failureSignature: "only-broke-signature",
    scopeTags: ["only-broke-tag"],
    writtenAt: RULE_WRITTEN_AT,
  });
  const unrelatedReq = message(
    "Touch something this rule's tag doesn't cover.",
    "2026-09-10T02:00:00Z",
  );
  classify(unrelatedReq, "new_task", ["some-other-tag"]);
  const onlyBrokeEpId = episode("2026-09-10T02:00:00Z", [unrelatedReq]);
  store.recordRuleAdherence({
    rule_id: onlyBrokeRuleId,
    task_episode_id: onlyBrokeEpId,
    verdict: "broke",
    quote: "broke it, even though the tags never overlapped",
    llm_call_id: null,
    run_id: null,
  });

  recomputeRuleHealth(NOW);
  const onlyBrokeHealth = store.getRuleHealth(onlyBrokeRuleId)!;
  assert.equal(
    onlyBrokeHealth.applicable_tasks,
    1,
    "the broke row alone adds one applicable_tasks, mirroring the followed guard",
  );
  assert.equal(onlyBrokeHealth.hurt, 1);

  // Case 3: with adherence evidence disabled, the broke row from case 1
  // changes nothing -- hurt still comes only from the matching correction.
  store.setSettings({
    evidence_sources: JSON.stringify({
      observed: true,
      adherence: false,
      verdicts: true,
      paired: false,
    }),
  });
  recomputeRuleHealth(NOW);
  health = store.getRuleHealth(ruleId)!;
  assert.equal(health.applicable_tasks, 1);
  assert.equal(
    health.hurt,
    1,
    "the broke row is ignored with adherence disabled; the correction alone still counts",
  );

  resetEvidenceSources();
});

// ---- Round 5 fix wave item 1: a verdict's hurt is a derived input to
// recomputeRuleHealth, so it survives being recomputed instead of a
// recompute silently clobbering a hurt+1 some earlier caller wrote
// directly into the stored row. ----

test("recomputeRuleHealth: a did_not_help verdict survives recompute", () => {
  const ruleId = makeLiveRule({
    predictedFailure: "a rule scored only to exercise the verdict surviving recompute",
    failureSignature: "verdict-survives-recompute-signature",
    scopeTags: ["verdict-survives-recompute-tag"], // no fixture episode uses this tag
    writtenAt: RULE_WRITTEN_AT,
  });
  recomputeRuleHealth(NOW);
  assert.equal(store.getRuleHealth(ruleId)!.hurt, 0, "no episodes, no verdict yet -- hurt is 0");

  store.recordRuleVerdict({ rule_id: ruleId, verdict: "did_not_help" });

  recomputeRuleHealth(NOW);
  assert.equal(
    store.getRuleHealth(ruleId)!.hurt,
    1,
    "recomputeRuleHealth reads the verdict back itself, so hurt reflects it right away",
  );

  recomputeRuleHealth(NOW);
  assert.equal(
    store.getRuleHealth(ruleId)!.hurt,
    1,
    "recomputing a second time does not count the same verdict twice -- it survives, exactly once",
  );

  resetEvidenceSources();
});

test("recomputeRuleHealth: a did_not_help verdict contributes nothing when evidence_sources.verdicts is disabled", () => {
  const ruleId = makeLiveRule({
    predictedFailure: "a rule scored only to exercise the verdicts-evidence-off gate",
    failureSignature: "verdict-off-signature",
    scopeTags: ["verdict-off-tag"], // no fixture episode uses this tag
    writtenAt: RULE_WRITTEN_AT,
  });
  store.recordRuleVerdict({ rule_id: ruleId, verdict: "did_not_help" });

  store.setSettings({
    evidence_sources: JSON.stringify({
      observed: true,
      adherence: true,
      verdicts: false,
      paired: false,
    }),
  });
  recomputeRuleHealth(NOW);
  assert.equal(
    store.getRuleHealth(ruleId)!.hurt,
    0,
    "with verdicts evidence disabled, the did_not_help verdict adds no hurt",
  );
  assert.equal(store.getRuleHealth(ruleId)!.applicable_tasks, 0);

  resetEvidenceSources();
});

// ---- Round 6 Task 6b / spec §6: paired-test evidence gating -- a judged
// run's score, not an episode the tag-based scan already walks, decides
// helped/hurt here (see health.ts's own comment for why there's no episode
// to de-duplicate against). Own rule per test, own scope tag no fixture
// episode carries, same convention every other appended block above uses. ----

/** A live rule with its own correction candidate + episode (makeLiveRule
 * above returns only the rule id -- createExperimentRun needs a real
 * correction_candidate_id/task_episode_id to attach a run to). */
function makeLiveRuleWithCandidate(input: { writtenAt: string; scopeTags: string[] }): {
  ruleId: number;
  correctionId: number;
  episodeId: number;
} {
  const episodeId = episode(input.writtenAt, [], PROJECT);
  const cc = store.createCorrectionCandidate({
    task_episode_id: episodeId,
    classification: "constraint_restatement",
    is_correction: true,
    reusable: true,
    proposed_scope: "project",
    summary: "seed correction for a paired-test fixture",
    evidence_history_item_ids: [],
  }) as { id: number };
  const learning = store.createLearning({
    correction_candidate_id: cc.id,
    observed_problem: "seed",
    desired_behavior: "seed",
    reuse_rationale: "seed",
    proposed_scope: "project",
    provenance: "llm_derived",
    created_by: "test",
  }) as { id: number };
  const rule = store.createRule({
    learning_id: learning.id,
    correction_candidate_id: cc.id,
    instruction: "A rule scored only via a paired test.",
    scope: "project",
    applies_when: "n/a",
    predicted_failure: "n/a",
    ownership: "harness",
    created_by: "test",
  }) as { id: number };
  db.prepare(`UPDATE rules SET scope_tags_json = ? WHERE id = ?`).run(
    JSON.stringify(input.scopeTags),
    rule.id,
  );
  store.updateRule({ id: rule.id, state: "active", actor: "test" });
  db.prepare(
    `INSERT INTO knowledge_versions
       (rule_id, target, project_id, previous_content, new_content, previous_sha256, new_sha256, rule_ids_json, status, actor, written_at)
     VALUES (?, 'project', ?, '', '', '', '', '[]', 'written', 'test', ?)`,
  ).run(rule.id, PROJECT, input.writtenAt);
  return { ruleId: rule.id, correctionId: cc.id, episodeId };
}

let pairedRunSeq = 0;
function makeJudgedRun(input: {
  ruleId: number;
  correctionId: number;
  episodeId: number;
  score: number;
  judgedAt: string;
  verdicts?: ("yes" | "no" | "unclear")[];
}): void {
  pairedRunSeq += 1;
  const { id } = store.createExperimentRun({
    rule_id: input.ruleId,
    correction_candidate_id: input.correctionId,
    task_episode_id: input.episodeId,
    source_project_id: PROJECT,
    request_message_external_id: `aimsg_paired_gate_${pairedRunSeq}`,
  });
  store.updateExperimentRun(id, {
    status: "judged",
    score: input.score,
    judged_at: input.judgedAt,
    ...(input.verdicts ? { verdicts_json: JSON.stringify(input.verdicts) } : {}),
  });
}

function setPaired(on: boolean): void {
  store.setSettings({
    evidence_sources: JSON.stringify({
      observed: true,
      adherence: true,
      verdicts: true,
      paired: on,
    }),
  });
}

test("recomputeRuleHealth: a judged paired-test run with score >= 0.5 counts as one build without a repeat, when evidence_sources.paired is on", () => {
  const { ruleId, correctionId, episodeId } = makeLiveRuleWithCandidate({
    writtenAt: RULE_WRITTEN_AT,
    scopeTags: ["paired-gate-helped-tag"],
  });
  makeJudgedRun({ ruleId, correctionId, episodeId, score: 1, judgedAt: "2026-09-05T00:00:00Z" });

  setPaired(true);
  recomputeRuleHealth(NOW);
  const health = store.getRuleHealth(ruleId)!;
  assert.equal(health.applicable_tasks, 1);
  assert.equal(health.helped, 1);
  assert.equal(health.hurt, 0);

  resetEvidenceSources();
});

test("recomputeRuleHealth: a judged paired-test run with score 0 counts as one hurt, when evidence_sources.paired is on", () => {
  const { ruleId, correctionId, episodeId } = makeLiveRuleWithCandidate({
    writtenAt: RULE_WRITTEN_AT,
    scopeTags: ["paired-gate-hurt-tag"],
  });
  makeJudgedRun({ ruleId, correctionId, episodeId, score: 0, judgedAt: "2026-09-05T00:00:00Z" });

  setPaired(true);
  recomputeRuleHealth(NOW);
  const health = store.getRuleHealth(ruleId)!;
  assert.equal(health.applicable_tasks, 1);
  assert.equal(health.helped, 0);
  assert.equal(health.hurt, 1);

  resetEvidenceSources();
});

test("recomputeRuleHealth: a judged paired-test run contributes nothing when evidence_sources.paired is off", () => {
  const { ruleId, correctionId, episodeId } = makeLiveRuleWithCandidate({
    writtenAt: RULE_WRITTEN_AT,
    scopeTags: ["paired-gate-defaultoff-tag"],
  });
  makeJudgedRun({ ruleId, correctionId, episodeId, score: 0, judgedAt: "2026-09-05T00:00:00Z" });

  // resetEvidenceSources' own default already has paired: false.
  recomputeRuleHealth(NOW);
  const health = store.getRuleHealth(ruleId)!;
  assert.equal(health.applicable_tasks, 0);
  assert.equal(health.hurt, 0);
});

test("recomputeRuleHealth: a judged paired-test run before the rule's own window start does not count, even with paired on", () => {
  const { ruleId, correctionId, episodeId } = makeLiveRuleWithCandidate({
    writtenAt: RULE_WRITTEN_AT,
    scopeTags: ["paired-gate-beforewindow-tag"],
  });
  // Judged before RULE_WRITTEN_AT -- a stray run from before this rule's
  // current life (mirrors windowStart's own re-add reasoning).
  makeJudgedRun({ ruleId, correctionId, episodeId, score: 0, judgedAt: "2026-08-01T00:00:00Z" });

  setPaired(true);
  recomputeRuleHealth(NOW);
  const health = store.getRuleHealth(ruleId)!;
  assert.equal(health.applicable_tasks, 0);
  assert.equal(health.hurt, 0);

  resetEvidenceSources();
});

test("recomputeRuleHealth: a judged paired-test run with a middling score (0 < score < 0.5) counts towards neither helped nor hurt", () => {
  const { ruleId, correctionId, episodeId } = makeLiveRuleWithCandidate({
    writtenAt: RULE_WRITTEN_AT,
    scopeTags: ["paired-gate-middle-tag"],
  });
  makeJudgedRun({ ruleId, correctionId, episodeId, score: 0.25, judgedAt: "2026-09-05T00:00:00Z" });

  setPaired(true);
  recomputeRuleHealth(NOW);
  const health = store.getRuleHealth(ruleId)!;
  assert.equal(health.applicable_tasks, 0);
  assert.equal(health.helped, 0);
  assert.equal(health.hurt, 0);

  resetEvidenceSources();
});

test("recomputeRuleHealth: a paired test judged all 'Unclear' is not a hurt -- nothing was judged still needed", () => {
  // Live run 4 was judged Unclear; its score (no / corrections) is 0, which
  // counted as one hurt against the rule.
  const { ruleId, correctionId, episodeId } = makeLiveRuleWithCandidate({
    writtenAt: RULE_WRITTEN_AT,
    scopeTags: ["paired-gate-unclear-tag"],
  });
  makeJudgedRun({ ruleId, correctionId, episodeId, score: 0, judgedAt: "2026-09-05T00:00:00Z", verdicts: ["unclear"] });
  makeJudgedRun({ ruleId, correctionId, episodeId, score: 0.5, judgedAt: "2026-09-06T00:00:00Z", verdicts: ["no", "unclear"] });
  makeJudgedRun({ ruleId, correctionId, episodeId, score: 0, judgedAt: "2026-09-07T00:00:00Z", verdicts: ["yes", "unclear"] });

  setPaired(true);
  recomputeRuleHealth(NOW);
  const health = store.getRuleHealth(ruleId)!;
  assert.equal(health.applicable_tasks, 2, "the all-unclear run counts for nothing");
  assert.equal(health.helped, 1, "no + unclear: every decided correction was resolved");
  assert.equal(health.hurt, 1, "yes + unclear: still needed, nothing resolved");
  resetEvidenceSources();
});
