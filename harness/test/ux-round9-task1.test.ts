// Round 9 Task 1 / spec §2-§4: the instruction state model, its fixed
// action set per state, and the plain evidence sentences everything later
// in the round builds on. Same dynamic-import-from-.ts pattern as
// ux.test.ts (harness/test runs under tsx, importing the frontend's own
// dependency-free src/lib/harness-ux.ts directly -- no build step).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  instructionState,
  instructionStateLine,
  actionsForState,
  INSTRUCTION_ACTION_LABELS,
  observedSentence,
  aiCheckSentence,
  evidenceDisagreementLine,
  attentionBlock,
  VERDICT_CHOICES_SHOWN,
  VERDICT_QUESTION,
  openLabel,
} from "../../src/lib/harness-ux";

const pending = { decision: { status: "pending" as const, retired: false } };
test("state: pending is suggested; judged not_supported flips to suggested_not_helped", () => {
  assert.equal(instructionState(pending), "suggested");
  assert.equal(
    instructionState({ ...pending, conclusion: { kind: "not_supported" } }),
    "suggested_not_helped",
  );
});
test("state: judging run wins over suggested", () => {
  assert.equal(
    instructionState({ ...pending, test: { run: { status: "judging", judged_at: null } } }),
    "waiting_judge",
  );
});
test("state: written+accepted is live; review_reason makes it live_attention unless snoozed", () => {
  const live = {
    decision: { status: "accepted" as const, retired: false },
    lovable: { write_status: "written" },
  };
  assert.equal(instructionState(live), "live");
  assert.equal(
    instructionState({ ...live, health: { review_reason: "repeated_issue", status: "review" } }),
    "live_attention",
  );
  assert.equal(
    instructionState({ ...live, health: { review_reason: "repeated_issue", status: "snoozed" } }),
    "live",
  );
});
test("state: retired and skipped", () => {
  assert.equal(instructionState({ decision: { status: "accepted", retired: true } }), "retired");
  assert.equal(instructionState({ decision: { status: "skipped", retired: false } }), "skipped");
});
// Fix round 1 (controller ruling): an accepted, non-retired decision is
// "live" no matter what lovable.write_status says -- re-offering Add/Skip
// on an already-decided item would re-ask a decision already made.
test("state: accepted is live regardless of write_status -- pending, stale, failed, reverted, or absent", () => {
  const accepted = { decision: { status: "accepted" as const, retired: false } };
  assert.equal(instructionState({ ...accepted, lovable: { write_status: "pending" } }), "live");
  assert.equal(instructionState({ ...accepted, lovable: { write_status: "stale" } }), "live");
  assert.equal(instructionState({ ...accepted, lovable: { write_status: "failed" } }), "live");
  assert.equal(instructionState({ ...accepted, lovable: { write_status: "reverted" } }), "live");
  assert.equal(instructionState(accepted), "live", "no lovable field at all is still live");
  assert.equal(
    instructionState({
      ...accepted,
      lovable: { write_status: "pending" },
      health: { review_reason: "repeated_issue", status: "review" },
    }),
    "live_attention",
    "live_attention does not require a written state either",
  );
});
test("actions: fixed order, emphasis only changes", () => {
  assert.deepEqual(actionsForState("suggested"), {
    primary: "add",
    secondary: "skip",
    small: ["edit", "open"],
    emphasis: "primary",
    note: null,
  });
  const nh = actionsForState("suggested_not_helped");
  assert.equal(nh.primary, "add");
  assert.equal(nh.secondary, "skip");
  assert.equal(nh.emphasis, "secondary");
  assert.equal(nh.note, "The test suggests this instruction would not have helped.");
  assert.deepEqual(actionsForState("waiting_judge"), {
    primary: "judge",
    secondary: null,
    small: ["open"],
    emphasis: "primary",
    note: null,
  });
  assert.deepEqual(actionsForState("live"), {
    primary: "keep",
    secondary: "retire",
    small: ["test", "open"],
    emphasis: "primary",
    note: null,
  });
  assert.deepEqual(actionsForState("live_attention"), actionsForState("live"));
  assert.deepEqual(actionsForState("retired"), {
    primary: "readd",
    secondary: null,
    small: ["open"],
    emphasis: "primary",
    note: null,
  });
  assert.deepEqual(actionsForState("skipped"), actionsForState("retired"));
  assert.equal(INSTRUCTION_ACTION_LABELS.judge, "Judge");
  assert.equal(openLabel("Compare builds"), "Open Compare builds");
});
test("state line", () => {
  assert.equal(instructionStateLine({ state: "suggested" }), "Suggested");
  assert.match(
    instructionStateLine({ state: "live", written_at: "2026-09-13T11:20:00Z" }),
    /^In Lovable since 13 Sep$/,
  );
  assert.match(
    instructionStateLine({
      state: "live",
      written_at: "2026-09-13T11:20:00Z",
      decided_by: "automatic",
    }),
    /^In Lovable since 13 Sep · accepted automatically$/,
  );
  assert.match(
    instructionStateLine({ state: "retired", decided_at: "2026-09-14T00:00:00Z" }),
    /^Retired 14 Sep$/,
  );
  assert.match(
    instructionStateLine({ state: "skipped", decided_at: "2026-09-14T00:00:00Z" }),
    /^Skipped 14 Sep$/,
  );
  assert.equal(instructionStateLine({ state: "waiting_judge" }), "Waiting for your answer");
  // Fix round 1: write_status !== "written" reads as the user's own
  // decision ("Accepted <day>"), never a claim about Lovable's own state.
  assert.match(
    instructionStateLine({
      state: "live",
      write_status: "pending",
      decided_at: "2026-09-13T11:20:00Z",
    }),
    /^Accepted 13 Sep$/,
  );
  assert.match(
    instructionStateLine({
      state: "live",
      write_status: "failed",
      decided_at: "2026-09-13T11:20:00Z",
      decided_by: "automatic",
    }),
    /^Accepted 13 Sep · accepted automatically$/,
  );
});
test("evidence sentences", () => {
  assert.equal(
    observedSentence({ observed_repeat: 0, observed_clear: 0 }),
    "No later build has needed this yet.",
  );
  assert.equal(
    observedSentence({ observed_repeat: 0, observed_clear: 3 }),
    "You have not had to correct this again in 3 later builds.",
  );
  assert.equal(
    observedSentence({ observed_repeat: 0, observed_clear: 1 }),
    "You have not had to correct this again in 1 later build.",
  );
  assert.equal(
    observedSentence({ observed_repeat: 2, observed_clear: 1 }),
    "You corrected this again in 2 of 3 later builds.",
  );
  assert.equal(aiCheckSentence({ ai_not_followed: 0, ai_followed: 0 }), null);
  assert.equal(
    aiCheckSentence({ ai_not_followed: 0, ai_followed: 2 }),
    "Lovable's replies show the instruction was followed in all 2 later builds.",
  );
  assert.equal(
    aiCheckSentence({ ai_not_followed: 3, ai_followed: 0 }),
    "Lovable's replies show the instruction was not followed in 3 of 3 later builds.",
  );
  assert.equal(
    evidenceDisagreementLine({
      observed_repeat: 0,
      observed_clear: 3,
      ai_not_followed: 3,
      ai_followed: 0,
    }),
    "You did not correct it, but Lovable's replies say it was not followed. Read the quote and decide.",
  );
  assert.equal(
    evidenceDisagreementLine({
      observed_repeat: 1,
      observed_clear: 2,
      ai_not_followed: 3,
      ai_followed: 0,
    }),
    null,
  );
});
test("attention: snoozed never asks; repeated_issue uses the plain sentence", () => {
  assert.equal(
    attentionBlock({
      review_reason: "repeated_issue",
      status: "snoozed",
      observed_repeat: 0,
      observed_clear: 3,
      ai_not_followed: 3,
    } as never),
    null,
  );
  const b = attentionBlock({
    review_reason: "repeated_issue",
    status: "review",
    observed_repeat: 0,
    observed_clear: 3,
    ai_not_followed: 3,
    ai_followed: 0,
    hurt: 0,
    applicable_tasks: 3,
  } as never);
  assert.equal(
    b?.line,
    "Lovable's replies show the instruction was not followed in 3 of 3 later builds.",
  );
  assert.doesNotMatch(b?.line ?? "", /AI review marked/);
});
// Fix round 1: a legacy-only health row (no observed_repeat/observed_clear,
// only the older applicable_tasks/hurt pair) must still read the repeat it
// actually has, via observedLine's own legacy conversion -- not read as an
// all-zero "No later build has needed this yet." under "Needs attention".
test("attention: a legacy-only health row (no observed_repeat/observed_clear) still reports its repeat", () => {
  const legacy = attentionBlock({
    review_reason: "repeated_issue",
    applicable_tasks: 4,
    hurt: 2,
    last_applicable_at: null,
  } as never);
  assert.equal(legacy?.title, "Needs attention");
  assert.equal(legacy?.line, "You corrected this again in 2 of 4 later builds.");
});
test("verdict choices shown are Keep and Retire only", () => {
  assert.deepEqual(VERDICT_CHOICES_SHOWN, ["keep", "retire"]);
  assert.equal(VERDICT_QUESTION, "Is this instruction still useful?");
});
