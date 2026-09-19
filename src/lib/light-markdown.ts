// Owner review round 7 fix 3: "some text has ** which is hard to read
// sometimes." Lovable's assistant replies (history_items.content) and the
// judge page's stored summaries/replies are Lovable's own markdown-ish text,
// stored verbatim -- **bold**, `code`, #/##/### headings, and "- "/"* "/"1. "
// list markers. There is no markdown library in this project and this file
// must not add one: it's a small, pure, dependency-free parser (no React, no
// imports) so harness/test can unit-test it directly with tsx, the same way
// harness-ux.ts's pure functions are tested. src/components/harness/
// light-markdown.tsx turns its output into React elements -- with NO raw
// HTML, so nothing here is ever a vector for HTML injection: everything not
// recognised as one of this limited subset stays literal text.

export type LightMarkdownInline =
  | { type: "text"; text: string }
  // `text` is the bold span verbatim; `inline` is the same span with any
  // `code` inside it parsed (Lovable writes **`src/lib/x.ts`** for file
  // names), so a renderer never shows the backticks literally.
  | { type: "bold"; text: string; inline: LightMarkdownInline[] }
  | { type: "code"; text: string };

export type LightMarkdownBlock =
  | { type: "paragraph"; inline: LightMarkdownInline[] }
  | { type: "heading"; inline: LightMarkdownInline[] }
  | { type: "list"; ordered: boolean; items: LightMarkdownInline[][] };

// `**bold**` and `` `code` `` -- a single left-to-right scan. An opening
// marker with no matching close (e.g. a stray "**" with nothing after it in
// this line) is never consumed: both characters fall through to plain text,
// which is what "unmatched ** left literal" means for a caller.
// Only `` `code` `` spans, for the inside of a bold span.
function parseCodeOnly(text: string): LightMarkdownInline[] {
  const nodes: LightMarkdownInline[] = [];
  let buf = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end !== -1) {
        if (buf) nodes.push({ type: "text", text: buf });
        buf = "";
        nodes.push({ type: "code", text: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    buf += text[i];
    i++;
  }
  if (buf) nodes.push({ type: "text", text: buf });
  return nodes;
}

function parseInline(text: string): LightMarkdownInline[] {
  const nodes: LightMarkdownInline[] = [];
  let buf = "";
  let i = 0;

  const flush = () => {
    if (buf) {
      nodes.push({ type: "text", text: buf });
      buf = "";
    }
  };

  while (i < text.length) {
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end !== -1) {
        flush();
        nodes.push({ type: "code", text: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (text[i] === "*" && text[i + 1] === "*") {
      const end = text.indexOf("**", i + 2);
      if (end !== -1) {
        flush();
        const inner = text.slice(i + 2, end);
        nodes.push({ type: "bold", text: inner, inline: parseCodeOnly(inner) });
        i = end + 2;
        continue;
      }
    }
    buf += text[i];
    i++;
  }
  flush();
  return nodes;
}

const HEADING_LINE = /^#{1,6}\s+(.*)$/;
const BULLET_LINE = /^[-*]\s+(.*)$/;
const NUMBERED_LINE = /^\d+\.\s+(.*)$/;

/** Converts a limited, safe subset of markdown-ish text into a plain block
 * tree: `**bold**`, `` `code` ``, a line starting with `#`/`##`/`###` (etc.)
 * as a heading line, `- `/`* `/`1. ` as list items, and a blank line as a
 * paragraph break. Everything else stays literal text -- there is no
 * fallback to raw HTML anywhere in this parser or its output. */
export function parseLightMarkdown(text: string): LightMarkdownBlock[] {
  const blocks: LightMarkdownBlock[] = [];
  const lines = (text ?? "").split("\n");

  let paraLines: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushPara = () => {
    if (paraLines.length > 0) {
      blocks.push({ type: "paragraph", inline: parseInline(paraLines.join("\n")) });
      paraLines = [];
    }
  };
  const flushList = () => {
    if (list) {
      blocks.push({ type: "list", ordered: list.ordered, items: list.items.map(parseInline) });
      list = null;
    }
  };

  for (const line of lines) {
    if (line.trim() === "") {
      // A blank line ends a paragraph but not a list: Lovable separates its
      // "1. **file**" items with blank lines and numbers every one "1.", so
      // ending the list here would restart the numbering at 1 for each item.
      flushPara();
      continue;
    }

    const heading = line.match(HEADING_LINE);
    if (heading) {
      flushPara();
      flushList();
      blocks.push({ type: "heading", inline: parseInline(heading[1] ?? "") });
      continue;
    }

    const bullet = line.match(BULLET_LINE);
    const numbered = bullet ? null : line.match(NUMBERED_LINE);
    if (bullet || numbered) {
      flushPara();
      const ordered = numbered != null;
      const content = (bullet ?? numbered)![1] ?? "";
      if (list && list.ordered === ordered) {
        list.items.push(content);
      } else {
        flushList();
        list = { ordered, items: [content] };
      }
      continue;
    }

    flushList();
    paraLines.push(line);
  }
  flushPara();
  flushList();
  return blocks;
}
