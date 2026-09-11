import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lineDiff } from "../src/diff.js";

// knowledge.js pulls in store.js/db.js (for the char-cap setting), so give it
// an isolated temp DB before importing it, same as every other test file
// that touches the knowledge composer -- diff.ts itself has no such
// dependency and stays a plain static import above.
process.env.HARNESS_DB_PATH = join(mkdtempSync(join(tmpdir(), "harness-diff-test-")), "harness.db");
const { composeManagedKnowledge } = await import("../src/knowledge.js");

test("identical documents diff to zero added/removed and no lines, including both empty", () => {
  assert.deepEqual(lineDiff("a\nb\nc", "a\nb\nc"), { added: 0, removed: 0, lines: [] });
  assert.deepEqual(lineDiff("", ""), { added: 0, removed: 0, lines: [] });
  assert.deepEqual(lineDiff("only one line", "only one line"), { added: 0, removed: 0, lines: [] });
});

test("one line changed: remove-then-add at the changed line, unchanged lines kept as context", () => {
  const out = lineDiff("a\nb\nc", "a\nX\nc");
  assert.equal(out.added, 1);
  assert.equal(out.removed, 1);
  assert.deepEqual(out.lines, [
    { kind: " ", text: "a" },
    { kind: "-", text: "b" },
    { kind: "+", text: "X" },
    { kind: " ", text: "c" },
  ]);
});

test("insert at end: only an added line, nothing removed", () => {
  const out = lineDiff("a\nb", "a\nb\nc");
  assert.equal(out.added, 1);
  assert.equal(out.removed, 0);
  assert.deepEqual(out.lines, [
    { kind: " ", text: "a" },
    { kind: " ", text: "b" },
    { kind: "+", text: "c" },
  ]);
});

test("delete at start: only a removed line, nothing added", () => {
  const out = lineDiff("a\nb\nc", "b\nc");
  assert.equal(out.added, 0);
  assert.equal(out.removed, 1);
  assert.deepEqual(out.lines, [
    { kind: "-", text: "a" },
    { kind: " ", text: "b" },
    { kind: " ", text: "c" },
  ]);
});

test("whole-document replace: every old line removed, every new line added, no shared context", () => {
  const out = lineDiff("a\nb\nc", "x\ny\nz");
  assert.equal(out.added, 3);
  assert.equal(out.removed, 3);
  assert.deepEqual(out.lines, [
    { kind: "-", text: "a" },
    { kind: "-", text: "b" },
    { kind: "-", text: "c" },
    { kind: "+", text: "x" },
    { kind: "+", text: "y" },
    { kind: "+", text: "z" },
  ]);
});

test("context collapsing on a 50-line document with two distant single-line edits", () => {
  const before = Array.from({ length: 50 }, (_, i) => `line${i + 1}`).join("\n");
  const afterLines = Array.from({ length: 50 }, (_, i) => `line${i + 1}`);
  afterLines[4] = "line5-changed"; // line 5 (1-indexed)
  afterLines[44] = "line45-changed"; // line 45 (1-indexed)
  const after = afterLines.join("\n");

  const out = lineDiff(before, after, 2);
  assert.equal(out.added, 2);
  assert.equal(out.removed, 2);

  // Only the two 2-line-context windows around each edit survive; the ~40
  // untouched lines between and around them are dropped, not ellipsized.
  assert.deepEqual(out.lines, [
    { kind: " ", text: "line3" },
    { kind: " ", text: "line4" },
    { kind: "-", text: "line5" },
    { kind: "+", text: "line5-changed" },
    { kind: " ", text: "line6" },
    { kind: " ", text: "line7" },
    { kind: " ", text: "line43" },
    { kind: " ", text: "line44" },
    { kind: "-", text: "line45" },
    { kind: "+", text: "line45-changed" },
    { kind: " ", text: "line46" },
    { kind: " ", text: "line47" },
  ]);
  assert.ok(!out.lines.some((l) => l.text === "line20"), "far-away unchanged lines must be dropped");
  assert.ok(!out.lines.some((l) => l.text === "line30"), "far-away unchanged lines must be dropped");

  // The default context is 2.
  assert.deepEqual(lineDiff(before, after).lines, out.lines);
});

test("a trailing newline alone never produces a spurious line delta", () => {
  // Same two lines of real content; only one side is newline-terminated.
  assert.deepEqual(lineDiff("a\nb\n", "a\nb"), { added: 0, removed: 0, lines: [] });
  assert.deepEqual(lineDiff("a\nb", "a\nb\n"), { added: 0, removed: 0, lines: [] });
  assert.deepEqual(lineDiff("a\nb\n", "a\nb\n"), { added: 0, removed: 0, lines: [] });

  // A genuinely blank last line (two trailing newlines, not one) still counts.
  const withBlankLine = lineDiff("a\nb", "a\nb\n\n");
  assert.equal(withBlankLine.added, 1);
  assert.equal(withBlankLine.removed, 0);
  assert.deepEqual(withBlankLine.lines, [
    { kind: " ", text: "a" },
    { kind: " ", text: "b" },
    { kind: "+", text: "" },
  ]);
});

test("composeManagedKnowledge's output diffs cleanly against input that ends in a newline: no spurious blank-line delta", () => {
  const base =
    "# Project Knowledge\n\nThis project was built with Lovable. Add your own notes above this line.\n";
  const composed = composeManagedKnowledge(base, [
    { id: 1, instruction: "Demo: never add a cron job without asking." },
  ]);
  assert.ok(base.endsWith("\n"), "precondition: the input ends with a newline");
  assert.ok(!composed.final_content.endsWith("\n"), "precondition: the managed block adds no trailing newline");

  const out = lineDiff(base, composed.final_content);
  // Nothing is ever removed here -- composing only appends. If the trailing
  // newline weren't normalized away, `base`'s phantom last line would show
  // up as a spurious "-" with no corresponding "+" on the other side.
  assert.equal(out.removed, 0);
  assert.ok(out.added > 0);
  assert.ok(!out.lines.some((l) => l.kind === "-"));
});

test("lineDiff is deterministic: repeated calls on the same input produce identical output", () => {
  const before = "alpha\nbeta\ngamma\ndelta";
  const after = "alpha\nBETA\ngamma\nDELTA\nepsilon";
  const first = lineDiff(before, after);
  const second = lineDiff(before, after);
  assert.deepEqual(first, second);
});
