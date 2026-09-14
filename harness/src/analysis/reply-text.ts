// Round 4 Task A1: pure port of `src/lib/harness-ux.ts`'s `lovableReplyText`
// into harness/, so the analysis pipeline (which runs server-side here, not
// in the web app) can render an assistant's human-visible reply text without
// importing React-app code. Keep this in lockstep with harness-ux.ts's
// version -- harness/test/analysis-classify.test.ts asserts the two agree on
// the exact fixture used by harness/test/ux.test.ts's
// "lovableReplyText extracts..." test.

function excerpt(text: string | null | undefined, max = 240): string {
  if (!text) return "";
  const t = text.trim().replace(/\s+/g, " ");
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${cut.slice(0, lastSpace > 80 ? lastSpace : max)}…`;
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

const MESSAGE_USER_BLOCK =
  /<lov-tool-use\b[^>]*?name="user_messaging--message_user"[^>]*?data="((?:[^"\\]|\\.)*)"/g;
const LOV_TOOL_USE_BLOCK = /<lov-tool-use\b(?:[^>"]|"(?:[^"\\]|\\.)*")*>[\s\S]*?<\/lov-tool-use>/g;
const LOV_OTHER_TAG = /<\/?lov-[\w-]+\b(?:[^>"]|"(?:[^"\\]|\\.)*")*\/?>/g;

/**
 * The human-visible part of a raw Lovable assistant `history_items.content`
 * blob: the text from `user_messaging--message_user` tool-use blocks,
 * joined in document order -- never the raw activity log (tool calls, file
 * diffs, etc.). Falls back to a truncated excerpt of the raw content when
 * there are no such blocks, so a plain-text reply (or unparsed content)
 * never becomes an empty string.
 */
export function humanVisibleText(raw: string): string {
  const out: string[] = [];
  for (const match of raw.matchAll(MESSAGE_USER_BLOCK)) {
    const attr = match[1] ?? "";
    const unescaped = decodeHtmlEntities(attr).replace(/\\(["\\])/g, "$1");
    try {
      const parsed = JSON.parse(unescaped) as { message?: unknown };
      if (typeof parsed.message === "string" && parsed.message.trim())
        out.push(parsed.message.trim());
    } catch {
      // not a parsable block; skip it
    }
  }
  if (out.length > 0) return out.join("\n\n");
  // Lovable's current replies have no message_user blocks: what the person
  // saw is the plain text between and after the tool-use blocks. Quoted
  // attribute values may contain ">" and escaped quotes, hence the pattern.
  if (/<lov-[\w-]+\b/.test(raw)) {
    return raw
      .replace(LOV_TOOL_USE_BLOCK, "\n\n")
      .replace(LOV_OTHER_TAG, "\n\n")
      .split(/\n{2,}/)
      .map((chunk) => chunk.trim())
      .filter(Boolean)
      .join("\n\n");
  }
  return excerpt(raw, 600);
}
