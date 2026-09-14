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
      `Knowledge has malformed Harness Ledger markers (${detail}); refusing to compose rather than risk overwriting your text`,
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
/** What Lovable's MCP get_project_knowledge/get_workspace_knowledge return
 * for Knowledge that is empty (the REST API returns ""). Taken at face value
 * it was written back to Lovable as real text ahead of Harness's block. */
export const LOVABLE_EMPTY_PLACEHOLDER = "(empty)";

/** Knowledge text as Lovable really holds it: the MCP's "(empty)" placeholder
 * reads as "". */
export function realKnowledgeText(content: string): string {
  return content.trim() === LOVABLE_EMPTY_PLACEHOLDER ? "" : content;
}

export function composeManagedKnowledge(
  rawCurrentContent: string,
  rules: ManagedRule[],
  maxActiveRules?: number,
): Composed {
  // No rules left: Harness keeps no block at all (an empty heading would sit
  // in every agent's context); adding a rule later creates it again.
  const managed_block = rules.length > 0 ? buildManagedBlock(rules) : "";
  const currentContent = realKnowledgeText(rawCurrentContent);
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
    final_content =
      managed_block === ""
        ? currentContent
        : currentContent === ""
          ? managed_block
          : `${currentContent}\n\n${managed_block}`;
  } else {
    const startIdx = currentContent.indexOf(HARNESS_START);
    const endIdx = currentContent.indexOf(HARNESS_END);
    if (endIdx < startIdx)
      throw new MalformedMarkersError("end marker appears before start marker");
    let before = currentContent.slice(0, startIdx);
    const after = currentContent.slice(endIdx + HARNESS_END.length);
    // Residue of the placeholder bug: "(empty)" written ahead of the block
    // is not the user's text; drop it rather than keep it forever.
    if (after.trim() === "" && before.trim() === LOVABLE_EMPTY_PLACEHOLDER) before = "";
    user_text = before + after;
    if (managed_block === "") {
      // Drop the "\n\n" Harness put between the user's text and its block.
      if (before.endsWith("\n\n")) before = before.slice(0, -2);
      else if (before === "" && after.startsWith("\n\n")) {
        final_content = after.slice(2);
        return finish(final_content);
      }
    }
    final_content = before + managed_block + after;
  }

  return finish(final_content);

  function finish(content: string): Composed {
    return {
      user_text,
      managed_block,
      final_content: content,
      char_count: content.length,
      over_cap: content.length > Number(getSetting("knowledge_char_cap")),
      active_rules_count: rules.length,
      over_rules: maxActiveRules !== undefined && rules.length > maxActiveRules,
    };
  }
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
