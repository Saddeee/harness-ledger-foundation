// Composition of the Harness-managed section of Lovable Knowledge. No
// network: given the current Knowledge text and the rules that should be in
// the managed block, produce the exact text to write. The only local-store
// read is the configurable character cap (knowledge_char_cap in settings,
// default 9000 below). Everything outside the markers is preserved
// byte-for-byte; Harness only ever regenerates what sits between them.
import { createHash } from "node:crypto";
import { getSetting } from "./store.js";

export const HARNESS_START = "<!-- harness:start -->";
export const HARNESS_END = "<!-- harness:end -->";
export const MANAGED_HEADING =
  "## Instructions managed by Harness Ledger (edit above this line, not inside)";
// Lovable's hard limit is 10,000 characters; Harness keeps headroom.
export const KNOWLEDGE_CAP = 9000;

export class MalformedMarkersError extends Error {
  constructor(detail: string) {
    super(
      `Knowledge has malformed Harness markers (${detail}); refusing to compose rather than risk overwriting your text`,
    );
    this.name = "MalformedMarkersError";
  }
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export type ManagedRule = { id: number; instruction: string };

export function buildManagedBlock(rules: ManagedRule[]): string {
  const lines = [...rules].sort((a, b) => a.id - b.id).map((r) => `- ${r.instruction}`);
  return `${HARNESS_START}\n${MANAGED_HEADING}\n${lines.join("\n")}\n${HARNESS_END}`;
}

export type Composed = {
  user_text: string;
  managed_block: string;
  final_content: string;
  char_count: number;
  over_cap: boolean;
  active_rules_count: number;
  over_rules: boolean;
};

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

// `maxActiveRules` is the effective cap for the target this is being
// composed for -- a project target's own override (or the global default
// when it has none), or the global default outright for a workspace target.
// Omitting it (nothing to enforce yet, e.g. a caller with no opinion) never
// flags over_rules.
export function composeManagedKnowledge(
  currentContent: string,
  rules: ManagedRule[],
  maxActiveRules?: number,
): Composed {
  const managed_block = buildManagedBlock(rules);
  const starts = countOccurrences(currentContent, HARNESS_START);
  const ends = countOccurrences(currentContent, HARNESS_END);

  if (starts > 1 || ends > 1) throw new MalformedMarkersError("more than one start or end marker");
  if (starts !== ends)
    throw new MalformedMarkersError(
      starts ? "start marker without end marker" : "end marker without start marker",
    );

  let user_text: string;
  let final_content: string;

  if (starts === 0) {
    user_text = currentContent;
    final_content = currentContent === "" ? managed_block : `${currentContent}\n\n${managed_block}`;
  } else {
    const startIdx = currentContent.indexOf(HARNESS_START);
    const endIdx = currentContent.indexOf(HARNESS_END);
    if (endIdx < startIdx)
      throw new MalformedMarkersError("end marker appears before start marker");
    const before = currentContent.slice(0, startIdx);
    const after = currentContent.slice(endIdx + HARNESS_END.length);
    user_text = before + after;
    final_content = before + managed_block + after;
  }

  return {
    user_text,
    managed_block,
    final_content,
    char_count: final_content.length,
    over_cap: final_content.length > Number(getSetting("knowledge_char_cap")),
    active_rules_count: rules.length,
    over_rules: maxActiveRules !== undefined && rules.length > maxActiveRules,
  };
}

// ---- Round 6 Task 2 ----
// The raw Harness-managed block as it stands in a piece of Knowledge text
// right now (markers included), or null when there isn't exactly one
// well-formed pair -- used by executeVersionNow (executor/beats.ts) to tell
// "the surrounding text changed" (safe to recompose) apart from "someone
// edited inside the markers" (never safe to overwrite). Deliberately
// tolerant: malformed markers just read as "no block" here rather than
// throwing -- composeManagedKnowledge above is the one place that must
// refuse outright, since it is the one about to write.
export function extractManagedBlock(content: string): string | null {
  const starts = countOccurrences(content, HARNESS_START);
  const ends = countOccurrences(content, HARNESS_END);
  if (starts !== 1 || ends !== 1) return null;
  const startIdx = content.indexOf(HARNESS_START);
  const endIdx = content.indexOf(HARNESS_END);
  if (endIdx < startIdx) return null;
  return content.slice(startIdx, endIdx + HARNESS_END.length);
}
