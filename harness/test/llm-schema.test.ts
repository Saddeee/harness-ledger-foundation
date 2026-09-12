// Round 4 fix wave item 1: harness/src/llm/schema.ts's assertStrictCompatible,
// plus a check that the two real production schemas (classifier, rule
// writer) are themselves strict-mode compatible. classify.ts/propose.ts
// import store.js, so this file needs an isolated temp DB set up first, same
// convention as analysis-classify.test.ts/analysis-propose.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HARNESS_DB_PATH = join(
  mkdtempSync(join(tmpdir(), "harness-llm-schema-test-")),
  "harness.db",
);

const { assertStrictCompatible } = await import("../src/llm/schema.js");
const { CLASSIFIER_JSON_SCHEMA } = await import("../src/analysis/classify.js");
const { RULE_WRITER_JSON_SCHEMA } = await import("../src/analysis/propose.js");
const { JUDGE_JSON_SCHEMA } = await import("../src/analysis/adherence.js");

test("assertStrictCompatible: the real CLASSIFIER_JSON_SCHEMA passes", () => {
  assert.doesNotThrow(() =>
    assertStrictCompatible(CLASSIFIER_JSON_SCHEMA, "message_classification"),
  );
});

test("assertStrictCompatible: the real RULE_WRITER_JSON_SCHEMA passes", () => {
  assert.doesNotThrow(() => assertStrictCompatible(RULE_WRITER_JSON_SCHEMA, "mined_rule_proposal"));
});

test("assertStrictCompatible: the real JUDGE_JSON_SCHEMA passes", () => {
  assert.doesNotThrow(() => assertStrictCompatible(JUDGE_JSON_SCHEMA, "rule_adherence_judgment"));
});

test("assertStrictCompatible: a schema with an optional (not-required) property fails", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["a"],
    properties: {
      a: { type: "string" },
      b: { type: "string" },
    },
  };
  assert.throws(() => assertStrictCompatible(schema), /missing from "required"/);
});

test("assertStrictCompatible: a schema missing additionalProperties: false fails", () => {
  const schema = {
    type: "object",
    required: ["a"],
    properties: { a: { type: "string" } },
  };
  assert.throws(() => assertStrictCompatible(schema), /additionalProperties: false/);
});

test("assertStrictCompatible: maxLength anywhere in the tree fails", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["a"],
    properties: { a: { type: "string", maxLength: 10 } },
  };
  assert.throws(() => assertStrictCompatible(schema), /forbidden keyword "maxLength"/);
});

test("assertStrictCompatible: minimum/maximum/pattern/minLength all fail", () => {
  for (const bad of [
    {
      type: "object",
      additionalProperties: false,
      required: ["a"],
      properties: { a: { type: "number", minimum: 0 } },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["a"],
      properties: { a: { type: "number", maximum: 1 } },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["a"],
      properties: { a: { type: "string", pattern: "^x" } },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["a"],
      properties: { a: { type: "string", minLength: 1 } },
    },
  ]) {
    assert.throws(() => assertStrictCompatible(bad));
  }
});

test("assertStrictCompatible: a forbidden keyword nested inside items/properties still fails", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["items"],
    properties: {
      items: { type: "array", items: { type: "string", maxLength: 5 } },
    },
  };
  assert.throws(
    () => assertStrictCompatible(schema),
    /forbidden keyword "maxLength" at schema\.items\[\]/,
  );
});

test("assertStrictCompatible: a compliant schema with nested nullable properties passes", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["a", "b"],
    properties: {
      a: { type: "boolean" },
      b: { type: ["string", "null"] },
    },
  };
  assert.doesNotThrow(() => assertStrictCompatible(schema));
});
