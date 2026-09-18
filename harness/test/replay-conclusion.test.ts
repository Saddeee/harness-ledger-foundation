// Checkpoint 2 2-D: replayConclusion (harness/src/executor/replay-environment.ts)
// -- the derived one-word conclusion for a historical replay
// (historical_support / not_supported / possibly_harmful / inconclusive),
// or null when there is nothing to derive one from. Pure, table-driven:
// each row below exercises exactly one branch of the function, in the same
// order the function itself checks them (no verdicts -> regression flag ->
// unimplemented kind -> unknown/not_comparable quality -> decided-empty ->
// the noShare/yesCount arithmetic), so a future change to the ordering
// shows up as a specific row failing, not a vague diff.
import { test } from "node:test";
import assert from "node:assert/strict";

const { replayConclusion } = await import("../src/executor/replay-environment.js");

type Verdict = "yes" | "no" | "unclear";
type Kind = "historical_replay" | "paired_comparison";
type Quality =
  "controlled" | "partially_controlled" | "historical_approximation" | "not_comparable";
type Conclusion =
  "historical_support" | "not_supported" | "possibly_harmful" | "inconclusive" | null;

const REPLAY: Kind = "historical_replay";
const APPROX: Quality = "historical_approximation";

const CASES: {
  name: string;
  input: {
    kind: Kind;
    quality: Quality | null;
    verdicts: Verdict[] | null;
    regression_flag?: boolean | null;
  };
  expect: Conclusion;
}[] = [
  {
    name: "not judged yet (verdicts null) -> null, whatever else is true",
    input: { kind: REPLAY, quality: APPROX, verdicts: null },
    expect: null,
  },
  {
    name: "judged with zero corrections (verdicts []) -> null (no verdicts to derive from)",
    input: { kind: REPLAY, quality: APPROX, verdicts: [] },
    expect: null,
  },
  {
    name: "regression flagged wins over a unanimous 'no' -- possibly_harmful, not historical_support",
    input: { kind: REPLAY, quality: APPROX, verdicts: ["no", "no"], regression_flag: true },
    expect: "possibly_harmful",
  },
  {
    name: "regression flagged wins even over not_comparable quality",
    input: { kind: REPLAY, quality: "not_comparable", verdicts: ["yes"], regression_flag: true },
    expect: "possibly_harmful",
  },
  {
    name: "regression flagged wins even for a kind this function has no other rule for",
    input: { kind: "paired_comparison", quality: APPROX, verdicts: ["no"], regression_flag: true },
    expect: "possibly_harmful",
  },
  {
    name: "regression_flag false is not flagged -- falls through to the ordinary rules",
    input: { kind: REPLAY, quality: APPROX, verdicts: ["no", "no"], regression_flag: false },
    expect: "historical_support",
  },
  {
    name: "paired_comparison (not implemented) -> null, not a guess",
    input: { kind: "paired_comparison", quality: "partially_controlled", verdicts: ["no"] },
    expect: null,
  },
  {
    name: "quality missing entirely (no environment record) -> null",
    input: { kind: REPLAY, quality: null, verdicts: ["no"] },
    expect: null,
  },
  {
    name: "not_comparable quality (historical code state unavailable) -> inconclusive",
    input: { kind: REPLAY, quality: "not_comparable", verdicts: ["no", "yes"] },
    expect: "inconclusive",
  },
  {
    name: "all verdicts unclear (decided is empty) -> inconclusive",
    input: { kind: REPLAY, quality: APPROX, verdicts: ["unclear", "unclear"] },
    expect: "inconclusive",
  },
  {
    name: "a single 'no' verdict (noShare 1.0, no 'yes') -> historical_support",
    input: { kind: REPLAY, quality: APPROX, verdicts: ["no"] },
    expect: "historical_support",
  },
  {
    name: "unanimous 'no' across several corrections -> historical_support",
    input: { kind: REPLAY, quality: APPROX, verdicts: ["no", "no", "no"] },
    expect: "historical_support",
  },
  {
    name: "'no' + 'unclear' (unclear set aside; decided is unanimous 'no') -> historical_support",
    input: { kind: REPLAY, quality: APPROX, verdicts: ["no", "unclear"] },
    expect: "historical_support",
  },
  {
    name: "noShare exactly 0.75 with some 'yes' (3 no, 1 yes) -> historical_support",
    input: { kind: REPLAY, quality: APPROX, verdicts: ["no", "no", "no", "yes"] },
    expect: "historical_support",
  },
  {
    name: "noShare below 0.75 with some 'yes' (2 no, 1 yes) -> inconclusive, not historical_support",
    input: { kind: REPLAY, quality: APPROX, verdicts: ["no", "no", "yes"] },
    expect: "inconclusive",
  },
  {
    name: "noShare exactly 0.5 with a 'yes' present (1 no, 1 yes) -> inconclusive",
    input: { kind: REPLAY, quality: APPROX, verdicts: ["no", "yes"] },
    expect: "inconclusive",
  },
  {
    name: "a single 'yes' verdict (all decided are 'yes') -> not_supported",
    input: { kind: REPLAY, quality: APPROX, verdicts: ["yes"] },
    expect: "not_supported",
  },
  {
    name: "unanimous 'yes' across several corrections -> not_supported",
    input: { kind: REPLAY, quality: APPROX, verdicts: ["yes", "yes", "yes"] },
    expect: "not_supported",
  },
  {
    name: "'yes' + 'unclear' (decided is unanimous 'yes') -> not_supported",
    input: { kind: REPLAY, quality: APPROX, verdicts: ["yes", "unclear"] },
    expect: "not_supported",
  },
  {
    name: "noShare below 0.5, no 'yes' among decided is impossible here but a minority 'no' with majority 'yes' (1 no, 2 yes) -> inconclusive",
    input: { kind: REPLAY, quality: APPROX, verdicts: ["no", "yes", "yes"] },
    expect: "inconclusive",
  },
  {
    name: "partially_controlled quality on a historical_replay run still uses the same arithmetic (D2: unreachable in practice, but the function does not special-case it)",
    input: { kind: REPLAY, quality: "partially_controlled", verdicts: ["no", "no"] },
    expect: "historical_support",
  },
];

for (const { name, input, expect: expected } of CASES) {
  test(`replayConclusion: ${name}`, () => {
    assert.equal(replayConclusion(input), expected);
  });
}

// Never a fifth label -- CONCLUSION_LABELS (src/lib/harness-ux.ts) and this
// function's own return type both cover exactly these four plus null; a
// historical replay's quality never reaches "controlled" (D2), so
// "controlled_support" is never a value this function can produce.
test("replayConclusion: return value is always one of the four honest outcomes, or null", () => {
  const possible = new Set([
    "historical_support",
    "not_supported",
    "possibly_harmful",
    "inconclusive",
    null,
  ]);
  for (const { input } of CASES) {
    assert.ok(possible.has(replayConclusion(input)));
  }
});
