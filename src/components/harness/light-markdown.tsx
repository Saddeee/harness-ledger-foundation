// Owner review round 7 fix 3: "some text has ** which is hard to read
// sometimes." Renders Lovable's own assistant text (already run through
// lovableReplyText/humanVisibleText, which strips <lov-tool-use> blocks)
// through parseLightMarkdown (src/lib/light-markdown.ts) into plain React
// elements -- **bold** -> <strong>, `code` -> <code>, a #/##/### line -> a
// <p className="font-medium"> (never a real heading, so the page's own
// hierarchy stays intact), "- "/"* "/"1. " lines -> a list, blank lines ->
// paragraph breaks. No dangerouslySetInnerHTML anywhere, so there is no way
// for stored text to inject real HTML.
import type { ReactNode } from "react";
import { Fragment } from "react";
import {
  parseLightMarkdown,
  type LightMarkdownBlock,
  type LightMarkdownInline,
} from "@/lib/light-markdown";

function renderInline(inline: LightMarkdownInline[]): ReactNode[] {
  return inline.map((node, i) => {
    if (node.type === "bold") return <strong key={i}>{node.text}</strong>;
    if (node.type === "code") return <code key={i}>{node.text}</code>;
    return <Fragment key={i}>{node.text}</Fragment>;
  });
}

function renderBlock(block: LightMarkdownBlock, key: number): ReactNode {
  if (block.type === "heading") {
    return (
      <p key={key} className="font-medium">
        {renderInline(block.inline)}
      </p>
    );
  }
  if (block.type === "list") {
    const items = block.items.map((item, i) => <li key={i}>{renderInline(item)}</li>);
    return block.ordered ? (
      <ol key={key} className="list-decimal space-y-0.5 pl-5">
        {items}
      </ol>
    ) : (
      <ul key={key} className="list-disc space-y-0.5 pl-5">
        {items}
      </ul>
    );
  }
  return (
    <p key={key} className="whitespace-pre-wrap">
      {renderInline(block.inline)}
    </p>
  );
}

export function LightMarkdown({ text, className }: { text: string; className?: string }) {
  const blocks = parseLightMarkdown(text ?? "");
  return (
    <div className={className ?? "space-y-2"}>
      {blocks.map((block, i) => renderBlock(block, i))}
    </div>
  );
}
