import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Checkpoint 2026-09-18: the README is a product claim. These tests keep its
// links valid and its wording within what the code does: the test feature is
// a historical replay (never "proof" or a "paired test"), copies are not
// called free without the credit qualification, the hosted limitation is
// authorization (not a missing API), Skills are not described as writable in
// Lovable, and the status section has the three required headings.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const readme = readFileSync(join(ROOT, "README.md"), "utf8");

/** GitHub's heading slug: lowercase, spaces to dashes, punctuation dropped. */
function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[`*_~]/g, "")
    .replace(/[^\p{L}\p{N} -]/gu, "")
    .replace(/ /g, "-");
}

const headings = readme
  .split("\n")
  .filter((l) => /^#{1,6} /.test(l))
  .map((l) => slug(l.replace(/^#{1,6} /, "")));

test("README: every in-page anchor points at a heading", () => {
  const anchors = [...readme.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]!);
  assert.ok(anchors.length > 5, "expected a table of contents");
  for (const a of anchors) {
    assert.ok(
      headings.includes(a),
      `anchor #${a} has no heading (headings: ${headings.join(", ")})`,
    );
  }
});

test("README: every relative link and image exists on disk; no raw HTML anchors or copied markup", () => {
  const links = [...readme.matchAll(/\]\(([^)#][^)]*)\)/g)]
    .map((m) => m[1]!)
    .filter((l) => !/^https?:\/\//.test(l) && !l.startsWith("mailto:"));
  for (const l of links) {
    assert.ok(existsSync(join(ROOT, l.split(" ")[0]!)), `relative link target missing: ${l}`);
  }
  assert.ok(!/<a\s+href/i.test(readme), "use plain Markdown links, not <a href>");
  assert.ok(!/&lt;|&gt;|&amp;/.test(readme), "HTML entities copied into Markdown");
  const externals = [...readme.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => m[1]!);
  for (const u of externals) assert.doesNotThrow(() => new URL(u), `malformed URL ${u}`);
});

test("README: the test feature is a historical replay, never proof or a paired test; copies are not unqualified 'free'", () => {
  assert.ok(!/paired test/i.test(readme), "'paired test' must not appear");
  assert.ok(!/^#+ .*proof/im.test(readme), "no heading may promise proof");
  assert.match(readme, /Historical result/);
  assert.match(readme, /Replay with rule/);
  assert.match(
    readme,
    /Creating project copies currently uses no Lovable builder credits\. Running a Lovable build inside a copy consumes normal Lovable builder credits\./,
  );
  assert.ok(!/copies themselves are free/i.test(readme));
  assert.ok(
    !/both builds/i.test(readme),
    "'both builds' conflates a historical artifact with a new build",
  );
});

test("README: hosted limitation is authorization, Skills are not described as written to Lovable, status headings exist", () => {
  assert.ok(!/no public Lovable API/i.test(readme), "the operations exist through Lovable MCP/API");
  assert.match(readme, /The current limitation is hosted authorization/);
  assert.match(readme, /Client Not Found/);
  assert.match(readme, /## .*Working in the local prototype/);
  assert.match(readme, /## .*Current limitations/);
  assert.match(readme, /## .*Next/);
  assert.match(readme, /## .*Use Harness Ledger through MCP/);
  assert.match(
    readme,
    /Lovable MCP lets Harness Ledger operate Lovable\. Harness Ledger MCP lets your agent operate Harness Ledger\./,
  );
  assert.match(readme, /not wired/i, "Skill writes to Lovable must be stated as not wired");
  assert.match(
    readme,
    /Synced project data is stored locally\. During analysis, selected chat, build, Knowledge and Skill context is sent only to the AI provider you configured\./,
  );
});

test("README: setup promise and the managed block example match the code", () => {
  assert.match(
    readme,
    /Harness Ledger currently has a developer-oriented local setup\. If Node\.js and an AI provider are already configured, setup usually takes around ten minutes\./,
  );
  assert.match(readme, /npm run setup/);
  assert.match(readme, /npm run harness:start/);
  assert.match(
    readme,
    /## Instructions managed by Harness Ledger\n<!-- Manage this section in Harness Ledger\./,
  );
});
