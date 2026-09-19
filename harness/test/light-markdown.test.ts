// Owner review round 7 fix 3: "some text has ** which is hard to read
// sometimes." Unit tests for the pure parser (src/lib/light-markdown.ts) --
// no React, so it's imported and tested directly the same way ux.test.ts
// tests harness-ux.ts's pure functions.
import { test } from "node:test";
import assert from "node:assert/strict";

const { parseLightMarkdown } = await import("../../src/lib/light-markdown.ts");

test("parseLightMarkdown: bold text becomes a bold inline node", () => {
  const blocks = parseLightMarkdown("This is **bold** text.");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]!.type, "paragraph");
  const inline = (blocks[0] as { inline: unknown[] }).inline;
  assert.deepEqual(inline, [
    { type: "text", text: "This is " },
    { type: "bold", text: "bold", inline: [{ type: "text", text: "bold" }] },
    { type: "text", text: " text." },
  ]);
});

test("parseLightMarkdown: backtick code becomes a code inline node", () => {
  const blocks = parseLightMarkdown("Run `npm test` first.");
  const inline = (blocks[0] as { inline: unknown[] }).inline;
  assert.deepEqual(inline, [
    { type: "text", text: "Run " },
    { type: "code", text: "npm test" },
    { type: "text", text: " first." },
  ]);
});

test("parseLightMarkdown: a line starting with # is a heading block, not a real <h*>", () => {
  const blocks = parseLightMarkdown("### Summary\nSome body text.");
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0]!.type, "heading");
  assert.deepEqual((blocks[0] as { inline: unknown[] }).inline, [
    { type: "text", text: "Summary" },
  ]);
  assert.equal(blocks[1]!.type, "paragraph");
});

test("parseLightMarkdown: '- ' and '* ' lines become one unordered list block", () => {
  const blocks = parseLightMarkdown("- first\n- second\n* third");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]!.type, "list");
  const list = blocks[0] as { ordered: boolean; items: unknown[][] };
  assert.equal(list.ordered, false);
  assert.equal(list.items.length, 3);
  assert.deepEqual(list.items[0], [{ type: "text", text: "first" }]);
});

test("parseLightMarkdown: '1. ' lines become one ordered list block", () => {
  const blocks = parseLightMarkdown("1. step one\n2. step two");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]!.type, "list");
  const list = blocks[0] as { ordered: boolean; items: unknown[][] };
  assert.equal(list.ordered, true);
  assert.equal(list.items.length, 2);
});

test("parseLightMarkdown: a blank line ends a paragraph, starting a new one", () => {
  const blocks = parseLightMarkdown("First paragraph.\n\nSecond paragraph.");
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0]!.type, "paragraph");
  assert.equal(blocks[1]!.type, "paragraph");
});

test("parseLightMarkdown: an unmatched ** is left as literal text, not eaten", () => {
  const blocks = parseLightMarkdown("This has ** but no closing marker.");
  const inline = (blocks[0] as { inline: { type: string; text: string }[] }).inline;
  const joined = inline.map((n) => n.text).join("");
  assert.equal(joined, "This has ** but no closing marker.");
  // Every node must be plain text -- nothing was mistaken for bold.
  assert.ok(inline.every((n) => n.type === "text"));
});

test("parseLightMarkdown: no HTML injection -- a literal <script> tag stays literal text", () => {
  const blocks = parseLightMarkdown("Ignore this: <script>alert(1)</script>");
  const inline = (blocks[0] as { inline: { type: string; text: string }[] }).inline;
  assert.ok(
    inline.every((n) => n.type === "text"),
    "never parsed as anything but text",
  );
  const joined = inline.map((n) => n.text).join("");
  assert.match(joined, /<script>alert\(1\)<\/script>/);
});

test("parseLightMarkdown: empty/blank input returns no blocks", () => {
  assert.deepEqual(parseLightMarkdown(""), []);
  assert.deepEqual(parseLightMarkdown("\n\n"), []);
});

test("parseLightMarkdown: code inside bold is parsed, so **`file.ts`** never shows its backticks", () => {
  const blocks = parseLightMarkdown("1. **`src/lib/bookings.ts`** — Booking types");
  const list = blocks[0] as { ordered: boolean; items: { type: string; inline?: unknown[] }[][] };
  assert.equal(list.ordered, true);
  const first = list.items[0]![0]!;
  assert.equal(first.type, "bold");
  assert.deepEqual(first.inline, [{ type: "code", text: "src/lib/bookings.ts" }]);
});

test("parseLightMarkdown: blank lines between list items keep one list (Lovable numbers every item '1.')", () => {
  const blocks = parseLightMarkdown("1. **a**\n\n1. **b**\n\n1. **c**\n\nAfterwards.");
  assert.equal(blocks.length, 2);
  const list = blocks[0] as { type: string; ordered: boolean; items: unknown[] };
  assert.equal(list.type, "list");
  assert.equal(list.ordered, true);
  assert.equal(list.items.length, 3);
  assert.equal(blocks[1]!.type, "paragraph");
});
