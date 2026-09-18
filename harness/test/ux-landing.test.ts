import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Checkpoint 2026-09-18: the public landing page. Pins the hero, the story,
// the honest status lines and the absence of anything the product cannot
// back (metrics, testimonials, "proof", writable Skills, a paired comparison
// that exists). Reads the source files as text, like every other ux test.
const copy = await import("../../src/lib/landing-copy.ts");

const INDEX = new URL("../../src/routes/index.tsx", import.meta.url);
const raw = readFileSync(INDEX, "utf8");
const code = raw
  .split("\n")
  .filter((l) => !l.trim().startsWith("//"))
  .join("\n");

test("landing: hero title and supporting text, verbatim", () => {
  assert.equal(copy.HERO_TITLE, "Teach Lovable once. Keep the lesson.");
  assert.equal(
    copy.HERO_TEXT,
    "Harness Ledger turns your corrections into versioned Knowledge and Skills, tests them against real project history, and shows whether they still deserve to remain.",
  );
  assert.deepEqual(Object.values(copy.HERO_ACTIONS), [
    "Open Harness Ledger",
    "See how it works",
    "Run locally",
    "View source",
    "Use through MCP",
  ]);
});

test("landing: the eight story steps, in order", () => {
  assert.deepEqual(
    copy.STORY_STEPS.map((s) => s.title),
    [
      "Correct Lovable",
      "Harness Ledger finds a reusable lesson",
      "Choose Knowledge or Skill",
      "Review or edit the instruction",
      "Test against a real previous request",
      "Add the instruction",
      "Observe later builds",
      "Revise, retire, or restore",
    ],
  );
});

test("landing: Knowledge vs Skills comparison and the honest Skills status", () => {
  assert.deepEqual(
    copy.PRIMITIVES.map((p) => p.name),
    ["Knowledge", "Skills", "Knowledge plus Skill"],
  );
  assert.match(copy.PRIMITIVES_STATUS, /not wired yet/);
});

test("landing: three evidence levels, none called proof, uncontrolled context named", () => {
  assert.deepEqual(
    copy.EVIDENCE_LEVELS.map((l) => [l.name, l.status]),
    [
      ["Historical replay", "Available"],
      ["Paired comparison", "Planned"],
      ["Repeated paired evidence", "Planned"],
    ],
  );
  assert.match(copy.EVIDENCE_CAVEAT, /None of these is proof/);
  assert.match(
    copy.EVIDENCE_CAVEAT,
    /project memory, workspace Knowledge, Skills and the builder version/,
  );
});

test("landing: the MCP sentence and the hosted status wording, verbatim", () => {
  assert.equal(
    copy.ARCHITECTURE_MCP_LINE,
    "Lovable MCP lets Harness Ledger operate Lovable. Harness Ledger MCP lets your agent operate Harness Ledger.",
  );
  assert.equal(
    copy.HOSTED_TEXT,
    "The operational prototype runs locally today because local Lovable clients can complete the supported localhost authorization flow. The hosted Lovable deployment presents the product and preserves the hosted adapter for a future approved application authorization path.",
  );
  assert.equal(
    copy.RUN_LOCALLY_TEXT,
    "Harness Ledger currently has a developer-oriented local setup. If Node.js and an AI provider are already configured, setup usually takes around ten minutes.",
  );
});

test("landing: limitations name Skills, paired comparison, behavioural checks, history, hosted, setup", () => {
  const joined = copy.LIMITATIONS.join(" ");
  for (const needle of [
    "Skills cannot yet be created",
    "Paired comparison is not implemented",
    "Behavioural checks",
    "Historical context",
    "Hosted authorization",
    "developer-oriented",
  ]) {
    assert.ok(joined.includes(needle), `limitation missing: ${needle}`);
  }
});

test("landing page source: sections in order, hosted status and limitations collapsed, no fetch, no redirect, no fake assets", () => {
  const order = [
    "HERO_TITLE",
    'id="how-it-works"',
    "PRIMITIVES_TITLE",
    "EVIDENCE_TITLE",
    "SAFETY_TITLE",
    'id="how-it-runs"',
    'id="run-locally"',
    "HOSTED_TITLE",
    "LIMITATIONS_TITLE",
  ];
  let last = -1;
  for (const marker of order) {
    const idx = code.indexOf(marker, last + 1);
    assert.ok(idx > last, `landing page section out of order or missing: ${marker}`);
    last = idx;
  }
  assert.ok(!/navigate\(|redirect\(/.test(code), "the landing page never redirects");
  assert.ok(!/fetch\(/.test(code), "the landing page fetches nothing");
  assert.ok(!/<img|<video|\.png|\.mp4/.test(code), "no screenshots, recordings or images");
  assert.match(code, /signedIn \? "\/inbox" : "\/login"/);
  // Collapsed by default: no <details open>.
  assert.ok(!/<details[^>]*\bopen\b/.test(code), "details must be collapsed by default");
  const banned = [
    /\bproves\b/i,
    /\bproven\b/i,
    /\bpaired test\b/i,
    /testimonial/i,
    /customers?\b/i,
    /\d+%/,
    /\bhelped\b/,
  ];
  const allCopy = Object.values(copy)
    .flatMap((v) => (Array.isArray(v) ? v.map((x) => JSON.stringify(x)) : [String(v)]))
    .join("\n");
  for (const re of banned) {
    assert.ok(!re.test(allCopy), `landing copy must not match ${re}`);
  }
});
