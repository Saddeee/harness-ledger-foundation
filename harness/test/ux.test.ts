// Tests for the guided-UX presentation logic (checkpoint C.1). The logic
// module lives in the root app (src/lib/harness-ux.ts) but is dependency-free,
// so it's tested here with the same node:test runner as the data layer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ux = await import("../../src/lib/harness-ux.ts");

function readApp(rel: string): string {
  return readFileSync(new URL(`../../src/${rel}`, import.meta.url), "utf8");
}
function codeOnly(source: string): string {
  return source
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*"))
    .join("\n");
}

test("enum-to-label mappings: every spec'd example maps to the required plain-language label", () => {
  assert.equal(ux.label(ux.CLASSIFICATION_LABELS, "constraint_restatement"), "Existing expectation was missed");
  assert.equal(ux.label(ux.CLASSIFICATION_LABELS, "preference_revision"), "You changed the preferred approach");
  assert.equal(ux.label(ux.CLASSIFICATION_LABELS, "missing_requirement"), "Part of the request was missed");
  assert.equal(ux.label(ux.CLASSIFICATION_LABELS, "defect_correction"), "Lovable made an implementation mistake");
  assert.equal(ux.label(ux.SCOPE_LABELS, "workspace"), "Use across my projects");
  assert.equal(ux.label(ux.SCOPE_LABELS, "project"), "Use only in this project");
  assert.equal(ux.label(ux.EVIDENCE_LEVEL_LABELS, "proposed"), "Not tested yet");
  assert.equal(ux.label(ux.VERIFIER_TYPE_LABELS, "structural"), "Automatic check");
  assert.equal(ux.label(ux.VERIFIER_TYPE_LABELS, "ai_rubric"), "AI review");
  assert.equal(ux.label(ux.VERIFIER_STATUS_LABELS, "not_run"), "Not tested");
  assert.equal(ux.label(ux.EXPERIMENT_TYPE_LABELS, "paired_control_treatment"), "Compare with and without the rule");
  assert.equal(ux.label(ux.FIELD_LABELS, "predicted_failure"), "Problem this should prevent");
  // every internal enum value used by the store has a label (no raw value leaks by omission)
  for (const v of ["proposed", "approved", "testing", "supported", "active", "questioned", "disabled", "retired", "rolled_back", "rejected"]) {
    assert.notEqual(ux.label(ux.RULE_STATE_LABELS, v), v, `rule state ${v} needs a label`);
  }
  // unknown values fall back to the raw value rather than crashing
  assert.equal(ux.label(ux.SCOPE_LABELS, "galaxy"), "galaxy");
});

test("default technical sections are collapsed: AdvancedDetails/DetailSection render <details> without an open attribute", () => {
  const src = codeOnly(readApp("components/harness/decision-layout.tsx"));
  const detailsTags = src.match(/<details[^>]*>/g) ?? [];
  assert.ok(detailsTags.length >= 2, "expected the collapsible components to use <details>");
  for (const tag of detailsTags) assert.ok(!/\sopen\b/.test(tag), `collapsed by default, got: ${tag}`);
  // pages must wrap technical content in AdvancedDetails, not render it inline
  for (const page of ["routes/_authenticated/inbox.tsx", "routes/_authenticated/ledger.tsx"]) {
    assert.ok(/<AdvancedDetails title="Advanced details">/.test(readApp(page)), `${page} uses AdvancedDetails`);
  }
});

test("action consequence text is visible: primary actions carry explicit consequences", () => {
  const confirm = ux.correctionPrimaryAction({ reviewed: false, excludedFromLearning: false, hasRule: false });
  assert.equal(confirm.kind, "confirm");
  assert.match(confirm.consequence, /Nothing will be changed in Lovable/);
  assert.match(confirm.consequence, /No Lovable credits/);

  const approve = ux.rulePrimaryAction("proposed");
  assert.equal(approve.kind, "approve");
  assert.match(approve.consequence, /Nothing will be changed in Lovable/);
  assert.match(approve.consequence, /No Lovable credits/);

  const reviewTest = ux.rulePrimaryAction("approved");
  assert.equal(reviewTest.kind, "review_test");
  assert.match(reviewTest.consequence, /nothing will be executed/i);
});

test("process stage calculated correctly for the real current state and for edge states", () => {
  // Current real state: correction reviewed, rule approved, experiment proposed, nothing run.
  const current = ux.computeStages({
    reviewed: true,
    excludedFromLearning: false,
    ruleState: "approved",
    experimentStatus: "proposed",
    experimentStartingState: "controlled_equivalent",
    testOutcome: "not_run",
  });
  assert.deepEqual(
    current.map((s) => [s.key, s.state]),
    [["found", "complete"], ["review", "complete"], ["test", "current"], ["add", "future"]],
  );

  // Unreviewed correction: Review is current, nothing later.
  const unreviewed = ux.computeStages({
    reviewed: false, excludedFromLearning: false, ruleState: null, experimentStatus: null, experimentStartingState: null, testOutcome: null,
  });
  assert.deepEqual(unreviewed.map((s) => s.state), ["complete", "current", "future", "future"]);

  // Excluded: review blocked and everything after blocked.
  const excluded = ux.computeStages({
    reviewed: true, excludedFromLearning: true, ruleState: null, experimentStatus: null, experimentStartingState: null, testOutcome: null,
  });
  assert.deepEqual(excluded.map((s) => s.state), ["complete", "blocked", "blocked", "blocked"]);

  // Blocked experiment starting state: test blocked, never "current".
  const blockedTest = ux.computeStages({
    reviewed: true, excludedFromLearning: false, ruleState: "approved", experimentStatus: "proposed", experimentStartingState: "blocked", testOutcome: null,
  });
  assert.equal(blockedTest[2]!.state, "blocked");

  // Active rule: everything complete.
  const active = ux.computeStages({
    reviewed: true, excludedFromLearning: false, ruleState: "active", experimentStatus: "approved", experimentStartingState: "controlled_equivalent", testOutcome: "passed",
  });
  assert.deepEqual(active.map((s) => s.state), ["complete", "complete", "complete", "complete"]);
  // Nothing in the current real state ever claims a test ran or Lovable changed.
  assert.notEqual(current[2]!.state, "complete");
  assert.notEqual(current[3]!.state, "complete");
});

test("primary action chosen from lifecycle state", () => {
  assert.equal(ux.correctionPrimaryAction({ reviewed: false, excludedFromLearning: false, hasRule: false }).label, "Yes, continue");
  assert.equal(ux.correctionPrimaryAction({ reviewed: true, excludedFromLearning: false, hasRule: true }).kind, "view_rule");
  assert.equal(ux.correctionPrimaryAction({ reviewed: true, excludedFromLearning: true, hasRule: true }).kind, "none");
  assert.equal(ux.rulePrimaryAction("proposed").label, "Approve rule");
  assert.equal(ux.rulePrimaryAction("approved").label, "Review the proposed test");
  assert.equal(ux.rulePrimaryAction("rejected").kind, "return_to_proposed");
  assert.equal(ux.rulePrimaryAction("active").kind, "none");
  assert.equal(ux.ruleStatusSentence("approved", "not_run"), "Approved, not tested, not added to Lovable.");
});

test("approval confirmation explicitly states no Lovable change and no credit spend", () => {
  assert.equal(ux.APPROVAL_CONFIRMATION.body, "This confirms that the rule represents a reusable instruction.");
  assert.equal(ux.APPROVAL_CONFIRMATION.noLovableChange, "Nothing will be changed in Lovable.");
  assert.equal(ux.APPROVAL_CONFIRMATION.noCredits, "No Lovable credits will be used.");
  // and the page actually wires all three strings into the dialog
  const ledger = readApp("routes/_authenticated/ledger.tsx");
  assert.match(ledger, /APPROVAL_CONFIRMATION\.body/);
  assert.match(ledger, /APPROVAL_CONFIRMATION\.noLovableChange/);
  assert.match(ledger, /APPROVAL_CONFIRMATION\.noCredits/);
  // the correction "Yes, continue" confirmation says the same
  assert.equal(ux.CONTINUE_CONFIRMATION.noLovableChange, "Nothing will be changed in Lovable.");
  assert.equal(ux.CONTINUE_CONFIRMATION.noCredits, "No Lovable credits will be used.");
});

test("advanced details preserve provenance: story derivation keeps every evidence item and its provenance", () => {
  const evidence = [
    { id: 1, kind: "message", role: "user", content: "Build X with a cron", occurred_at: "2026-09-07T23:29:36Z", provenance: "lovable_mcp" },
    { id: 2, kind: "message", role: "assistant", content: "Built with a per-minute cron", occurred_at: "2026-09-07T23:35:46Z", provenance: "lovable_mcp" },
    { id: 3, kind: "manual_note", role: "operator", content: "this is unacceptable", occurred_at: "2026-09-07T23:47:00Z", provenance: "manual" },
    { id: 4, kind: "build_log_row", role: null, content: "unscheduled", occurred_at: "2026-09-07T23:47:00Z", provenance: "build_log" },
    { id: 5, kind: "diff", role: null, content: "refactor", occurred_at: "2026-09-08T10:35:01Z", provenance: "lovable_mcp" },
  ];
  const story = ux.storyFromEvidence(evidence);
  assert.equal(story.requested?.id, 1);
  assert.equal(story.built?.id, 2);
  assert.equal(story.feedback?.id, 3);
  assert.equal(story.feedback?.provenance, "manual");
  assert.deepEqual(story.changed.map((e) => e.id), [4, 5]);
  // the story never invents content: each part is a real evidence item, provenance intact
  for (const part of [story.requested, story.built, story.feedback, ...story.changed]) {
    assert.ok(evidence.some((e) => e.id === part!.id && e.provenance === part!.provenance));
  }
  // and the pages render provenance for every evidence item in Advanced details
  for (const page of ["routes/_authenticated/inbox.tsx", "routes/_authenticated/ledger.tsx"]) {
    assert.match(readApp(page), /Evidence sources \(/);
    assert.match(readApp(page), /e\.provenance/);
  }
});

test("excerpt and firstSentence shorten without losing meaning", () => {
  assert.equal(ux.firstSentence("First one. Second one."), "First one.");
  assert.equal(ux.firstSentence("No terminator"), "No terminator");
  const long = "word ".repeat(100).trim();
  const short = ux.excerpt(long, 50);
  assert.ok(short.length <= 51 && short.endsWith("…"));
  assert.equal(ux.ruleTitle("Do not enable recurring background work by default. Prefer user-triggered execution."), "Do not enable recurring background work by default.");
});

test("no experiment execution action is exposed by the UI", () => {
  for (const page of ["routes/_authenticated/inbox.tsx", "routes/_authenticated/ledger.tsx", "routes/_authenticated/overview.tsx", "components/harness/decision-layout.tsx"]) {
    const code = codeOnly(readApp(page));
    assert.ok(!/run_experiment|execute_experiment|remix_project|send_message|\/api\/public\/harness\/experiments/.test(code), page);
  }
  // the only "Run test" control is rendered disabled with an explanation
  const ledger = readApp("routes/_authenticated/ledger.tsx");
  assert.match(ledger, /label="Run test"\s+disabled/);
});

test("no Lovable write is triggered by the UI: pages only call local harness routes", () => {
  for (const page of ["routes/_authenticated/inbox.tsx", "routes/_authenticated/ledger.tsx", "routes/_authenticated/overview.tsx"]) {
    const code = codeOnly(readApp(page));
    const fetchTargets = [...code.matchAll(/fetch\("([^"]+)"/g)].map((m) => m[1]);
    assert.ok(fetchTargets.length > 0, `${page} fetches something`);
    for (const t of fetchTargets) assert.match(t!, /^\/api\/public\/harness\//, `${page} fetches ${t}`);
    assert.ok(!/lovable\.dev|set_project_knowledge|setProjectKnowledge|createWorkspaceSkill/i.test(code), page);
  }
});
