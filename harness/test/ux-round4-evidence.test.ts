// Tests for Task D1: Evidence links ("Open in Lovable" on each quoted message).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function readApp(rel: string): string {
  return readFileSync(new URL(`../../src/${rel}`, import.meta.url), "utf8");
}

function codeOnly(source: string): string {
  return source
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*") && !t.startsWith("{/*");
    })
    .join("\n");
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const DETAIL = "components/harness/improvement.tsx";

test("MessageBlock: Open in Lovable link on each user message, with correct attributes", () => {
  const detail = readApp(DETAIL);
  const code = codeOnly(detail);

  // Link text must exist
  assert.match(code, /Open in Lovable/, "MessageBlock contains 'Open in Lovable' text");

  // Security attributes
  assert.match(code, /rel="noopener noreferrer"/, "link has security attributes");

  // URL pattern
  assert.match(code, /lovable\.dev\/projects\//, "link goes to lovable.dev/projects/");

  // Verify the link only appears for non-Lovable messages
  const messageBlock = detail.slice(detail.indexOf("function MessageBlock"), detail.indexOf("export function ImprovementDetail"));
  assert.match(messageBlock, /\{\!isLovable && projectId/, "link only shown when isLovable is false and projectId exists");
});

test("MessageBlock: cost wording still correct ('Lovable credits' ≤ 2, 'Harness Ledger analysis' exactly 1)", () => {
  const detail = codeOnly(readApp(DETAIL));
  assert.ok(count(detail, "Lovable credits") <= 2, `Lovable credits x${count(detail, "Lovable credits")}`);
  assert.equal(count(detail, "Harness Ledger analysis"), 1, "Harness Ledger analysis mentioned exactly once");
});

test("MessageBlock: no <details open attribute", () => {
  const detail = codeOnly(readApp(DETAIL));
  for (const tag of detail.match(/<details[^>]*>/g) ?? []) {
    assert.ok(!/\sopen\b/.test(tag), `details should be collapsed by default, got: ${tag}`);
  }
});

test("MessageBlock: projectId prop passed from ImprovementDetail", () => {
  const detail = readApp(DETAIL);
  const code = codeOnly(detail);
  // Check that MessageBlock receives projectId prop
  assert.match(code, /projectId=\{item\.project\.id\}/, "ImprovementDetail passes item.project.id to MessageBlock");
  // Check MessageBlock accepts projectId
  assert.match(code, /function MessageBlock\(\{ m, projectId \}/, "MessageBlock accepts projectId parameter");
});
