// Round 4 Task A1: the fixed scope-tag taxonomy the classifier picks from
// (classify.ts) and that later tasks (segmentation's episode tags, C1's
// rule_health applicability check) validate against. Kept as a plain array,
// not a DB CHECK constraint, so `message_classifications.tags_json` (free
// JSON) and `rules.scope_tags_json` (Task C1/A2) can add a tag later with no
// migration -- only this list and the classifier/miner prompts change.
export const SCOPE_TAGS = [
  "routing",
  "forms",
  "auth",
  "data-model",
  "database",
  "styling",
  "design-system",
  "components",
  "state",
  "api",
  "edge-functions",
  "testing",
  "performance",
  "accessibility",
  "copy",
  "i18n",
  "deployment",
  "general",
] as const;

export type ScopeTag = (typeof SCOPE_TAGS)[number];

const SCOPE_TAG_SET: ReadonlySet<string> = new Set(SCOPE_TAGS);

export function isScopeTag(value: unknown): value is ScopeTag {
  return typeof value === "string" && SCOPE_TAG_SET.has(value);
}
