// Round 4 fix wave item 1 (Critical): a pure, recursive validator that a
// structured-output JSON schema is compatible with OpenAI's Structured
// Outputs strict mode and Anthropic's strict tool-input schemas -- both
// reject a property missing from `required`, an object without
// `additionalProperties: false`, and length/range constraint keywords
// (minLength/maxLength/minimum/maximum/pattern). Run once per schema at
// dispatch time (harness/src/llm/index.ts's createCallLlm) so a schema that
// drifts out of strict-compatibility fails loudly at the call site, not
// silently via a provider error (or, worse, a provider that quietly ignores
// the offending keyword).
//
// "Optional" values under strict mode are expressed as a nullable type
// (e.g. `{"type": ["string", "null"]}`) rather than an absent key --
// harness/src/analysis/propose.ts's RULE_WRITER_JSON_SCHEMA (formerly
// mine.ts's MINER_JSON_SCHEMA) is the worked example this validator is
// written against.

type JsonSchemaNode = {
  type?: string | string[];
  properties?: Record<string, unknown>;
  required?: unknown;
  additionalProperties?: unknown;
  items?: unknown;
  [key: string]: unknown;
};

/** Keywords OpenAI Structured Outputs strict mode and Anthropic's strict tool schemas both reject. */
const FORBIDDEN_KEYWORDS = ["minLength", "maxLength", "minimum", "maximum", "pattern"] as const;

function isPlainSchemaObject(node: unknown): node is JsonSchemaNode {
  return typeof node === "object" && node !== null && !Array.isArray(node);
}

function walk(node: unknown, path: string): void {
  if (!isPlainSchemaObject(node)) return;

  for (const keyword of FORBIDDEN_KEYWORDS) {
    if (keyword in node) {
      throw new Error(
        `assertStrictCompatible: forbidden keyword "${keyword}" at ${path} -- strict mode ` +
          `(OpenAI Structured Outputs / Anthropic strict tools) rejects length/range constraints; ` +
          `enforce this bound in post-hoc validation instead`,
      );
    }
  }

  // An object schema is one with a `properties` map (whether or not it also
  // declares `type: "object"` -- the schemas this validates always do, but
  // this check doesn't depend on it).
  if (node.properties !== undefined) {
    if (!isPlainSchemaObject(node.properties)) {
      throw new Error(`assertStrictCompatible: "properties" at ${path} must be an object`);
    }
    if (node.additionalProperties !== false) {
      throw new Error(
        `assertStrictCompatible: object at ${path} must set additionalProperties: false`,
      );
    }
    const required = Array.isArray(node.required) ? node.required : [];
    const requiredSet = new Set(required);
    const keys = Object.keys(node.properties);
    for (const key of keys) {
      if (!requiredSet.has(key)) {
        throw new Error(
          `assertStrictCompatible: property "${key}" at ${path} is missing from "required" -- ` +
            `strict mode requires every property to be listed as required (express an optional ` +
            `value as a nullable type instead, e.g. {"type": ["string", "null"]})`,
        );
      }
    }
    for (const key of keys) {
      walk((node.properties as Record<string, unknown>)[key], `${path}.${key}`);
    }
  }

  if (node.items !== undefined) {
    walk(node.items, `${path}[]`);
  }
}

/**
 * Throws when `schema` is not strict-mode compatible: a property missing
 * from `required`, an object missing `additionalProperties: false`, or a
 * forbidden length/range keyword anywhere in the tree (including nested
 * `properties`/`items`). Never mutates or returns anything -- callers keep
 * using their own schema object.
 */
export function assertStrictCompatible(schema: object, name = "schema"): void {
  walk(schema, name);
}
