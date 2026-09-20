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
  // Round 8 Task 5 (review item 9): re-pinned with intent -- the judging
  // screen's own build-column titles renamed from "Historical result"/
  // "Replay with rule" to "What Lovable built before"/"Rebuilt with the
  // rule" (harness-ux.ts's HISTORICAL_RESULT_TITLE/REPLAY_WITH_RULE_TITLE).
  assert.match(readme, /What Lovable built before/);
  assert.match(readme, /Rebuilt with the rule/);
  assert.match(
    readme,
    /Creating project copies currently uses no Lovable builder credits\. Running a Lovable build in a copy consumes normal builder credits\./,
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
    /Harness Ledger currently has a developer-oriented local setup\. If Node\.js and an AI provider are already configured, setup usually takes a few minutes\./, // 2026-09-20 clone check: measured 26 s with a warm cache
  );
  assert.match(readme, /npm run setup/);
  assert.match(readme, /npm run harness:start/);
  assert.match(
    readme,
    /## Instructions managed by Harness Ledger\n<!-- Manage this section in Harness Ledger\./,
  );
});

test("README: status section agrees with the capability manifest", async () => {
  const { CAPABILITIES } = await import("../src/capabilities.js");
  const working = readme.slice(
    readme.indexOf("### Working in the local prototype"),
    readme.indexOf("### Current limitations"),
  );
  assert.match(readme, /capability manifest/);
  for (const c of CAPABILITIES) {
    if (c.status === "planned" || c.status === "blocked") {
      // A planned or blocked capability must not be listed as working.
      const key = c.label.split(" (")[0]!;
      assert.ok(
        !working.includes(key),
        `README lists "${key}" as working but the manifest says ${c.status}`,
      );
    }
  }
  // Checkpoint 3 S1: updated with intent -- remote_skill_write moved to
  // "working" (create only) after one approved live write on 2026-09-19.
  assert.match(readme, /Publish an approved Skill proposal[^\n]*verified with one live write/);
  assert.match(readme, /Remote Skill publishing creates a new Skill only[^\n]*not wired/);
  assert.match(readme, /Paired comparison[^\n]*planned/i);
  assert.match(readme, /Behavioural verification[^\n]*planned/i);
  assert.match(readme, /Hosted authorization is blocked/);
});

test("README: Inbox is the single decision queue; no separate Suggestions page is offered", () => {
  assert.match(readme, /Inbox contains everything that needs your attention/);
  const pagesTable = readme.slice(
    readme.indexOf("## 2. What it shows you"),
    readme.indexOf("## 3. Getting started"),
  );
  assert.ok(!/\| \*\*Suggestions\*\*/.test(pagesTable), "no Suggestions page row");
  // Round 8 Task 3 (review item 5): Overview merged into the Inbox, so it
  // no longer has a row of its own -- Inbox's row now answers both
  // questions ("is Harness Ledger ready" and "what needs my attention").
  assert.ok(!/\| \*\*Overview\*\*/.test(pagesTable), "no separate Overview page row");
  for (const page of [
    "**Inbox**",
    "**Instructions**",
    "**Skills**",
    "**Tests**",
    "**History**",
    "**Projects**",
    "**Settings**",
  ]) {
    assert.ok(pagesTable.includes(page), `pages table missing ${page}`);
  }
});

// 2026-09-20 clone check: a fresh install shows Get started until Lovable is
// connected, so the demo section must tell the reader about Skip onboarding.
test("README: the demo section says how to get past Get started", () => {
  assert.match(readme, /harness:demo -- --add[\s\S]{0,400}\*\*Skip onboarding\*\*/);
});
