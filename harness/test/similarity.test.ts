import { test } from "node:test";
import assert from "node:assert/strict";
import { dice } from "../src/analysis/similarity.js";

test("dice: identical strings score 1", () => {
  assert.equal(dice("design system bypassed", "design system bypassed"), 1);
  assert.equal(dice("", ""), 1);
});

test("dice: completely disjoint strings score 0", () => {
  assert.equal(dice("abc", "xyz"), 0);
  assert.equal(dice("a", "b"), 0);
});

test("dice: case and whitespace are normalised before comparing", () => {
  assert.equal(dice("Design System Bypassed", "design system bypassed"), 1);
  assert.equal(dice("hello   world", "hello world"), 1);
});

// Classic textbook example for the bigram Dice coefficient: "night" vs
// "nacht" share exactly one bigram ("ht") out of 4 + 4, so 2*1/8 = 0.25.
test("dice: known example (night vs nacht) is 0.25", () => {
  assert.equal(dice("night", "nacht"), 0.25);
});

test("dice: is symmetric", () => {
  assert.equal(dice("night", "nacht"), dice("nacht", "night"));
});

test("dice: near-duplicate correction summaries score high", () => {
  const a = "inline colors instead of design tokens";
  const b = "inline colors used instead of design tokens";
  assert.ok(dice(a, b) >= 0.7, `expected >= 0.7, got ${dice(a, b)}`);
});
