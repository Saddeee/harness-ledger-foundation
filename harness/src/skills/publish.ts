/**
 * Checkpoint 3 S1: pure SKILL.md composition for publishing a Skill
 * proposal to Lovable. No Lovable import, no store import -- this module
 * only turns a proposal's stored name/content into the exact markdown
 * `create_workspace_skill` expects, and normalises a proposed name into the
 * shape Lovable requires. Unit-tested directly (harness/test/
 * skill-publish.test.ts); the executor (executor/skill-publish-action.ts)
 * is the only caller that also talks to Lovable.
 */

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const MAX_DESCRIPTION_LENGTH = 200;
const MAX_NAME_LENGTH = 64;

/** Lowercase kebab-case, `[a-z0-9-]` only, dashes collapsed, at most 64
 * characters, no leading/trailing dash. Lovable's own Skill name shape --
 * the action refuses to publish when a proposal's stored name does not
 * already normalise to itself (see executor/skill-publish-action.ts), so a
 * user renames once, up front, with edit_skill_proposal rather than the
 * published name silently drifting from the name shown in Harness Ledger. */
export function normalizeSkillName(name: string): string {
  const kebab = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return kebab.slice(0, MAX_NAME_LENGTH).replace(/-+$/, "");
}

function firstNonEmptyLine(content: string): string | null {
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

/** A one-line description for the frontmatter: the first `# ` heading's
 * text, else the first non-empty line -- either way collapsed to one line
 * and capped at 200 characters, since Lovable's frontmatter has no room for
 * a multi-line description. */
function deriveDescription(content: string): string {
  const headingMatch = content.match(/^#\s+(.+?)\s*$/m);
  const candidate = headingMatch ? headingMatch[1]! : (firstNonEmptyLine(content) ?? "");
  return candidate.replace(/\s+/g, " ").trim().slice(0, MAX_DESCRIPTION_LENGTH);
}

type FrontmatterLine = { key: string | null; raw: string };

function parseFrontmatterLines(body: string): FrontmatterLine[] {
  return body.split("\n").map((raw) => {
    const m = raw.match(/^([A-Za-z0-9_-]+):/);
    return { key: m ? m[1]! : null, raw };
  });
}

/**
 * Lovable's required SKILL.md shape: `---\nname: <name>\ndescription:
 * <text>\n---\n<content>`. When `content` already starts with a frontmatter
 * block, it is kept -- but `name` is always forced to the proposal's own
 * `name` (Lovable requires the frontmatter name to match the Skill being
 * created), and a `description` is added only when the existing frontmatter
 * has none. Otherwise, a frontmatter block is derived and prepended: the
 * description comes from the content's first `# ` heading, falling back to
 * its first non-empty line.
 */
export function composeSkillMarkdown(name: string, content: string): string {
  const match = content.match(FRONTMATTER_RE);
  if (!match) {
    const description = deriveDescription(content);
    return `---\nname: ${name}\ndescription: ${description}\n---\n${content}`;
  }

  const fmBody = match[1]!;
  const rest = content.slice(match[0].length);
  const lines = parseFrontmatterLines(fmBody);
  let hasName = false;
  let hasDescription = false;
  const rewritten = lines.map((line) => {
    if (line.key === "name") {
      hasName = true;
      return `name: ${name}`;
    }
    if (line.key === "description") hasDescription = true;
    return line.raw;
  });
  if (!hasName) rewritten.unshift(`name: ${name}`);
  if (!hasDescription) rewritten.push(`description: ${deriveDescription(rest)}`);
  return `---\n${rewritten.join("\n")}\n---\n${rest}`;
}
