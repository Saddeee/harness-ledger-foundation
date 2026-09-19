import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Checkpoint 2: the public landing page, understandable in under a minute.
// Pins the hero, the five-step loop, the section order, the honest status
// lines, and validates the page's claims against the capability manifest
// (src/lib/capabilities-copy.ts). No images, no metrics, no testimonials.
//
// 2026-09-19 demo round: the hosted page is a front door -- "Start here"
// leads the page, the hero's action set and isLocalHost() split hosted vs.
// local visitors, and RUN_LOCALLY_TITLE/TEXT were folded into Start here.
const copy = await import("../../src/lib/landing-copy.ts");
const { CAPABILITIES } = await import("../../src/lib/capabilities-copy.ts");

const INDEX = new URL("../../src/routes/index.tsx", import.meta.url);
const raw = readFileSync(INDEX, "utf8");
const code = raw
  .split("\n")
  .filter((l) => !l.trim().startsWith("//"))
  .join("\n");

function status(id: string): string {
  const c = CAPABILITIES.find((x) => x.id === id);
  assert.ok(c, `capability ${id} missing from the manifest`);
  return c!.status;
}

test("landing: isLocalHost tells a visitor's own machine from the hosted front door", () => {
  assert.equal(copy.isLocalHost("127.0.0.1"), true);
  assert.equal(copy.isLocalHost("localhost"), true);
  assert.equal(copy.isLocalHost("[::1]"), true);
  assert.equal(copy.isLocalHost("harness-ledger-foundation.lovable.app"), false);
  assert.equal(copy.isLocalHost("example.com"), false);
});

test("landing: hero title, status line, product promise and actions, verbatim", () => {
  assert.equal(copy.HERO_TITLE, "Teach Lovable once. Keep the lesson.");
  assert.equal(
    copy.HERO_TEXT,
    "Harness Ledger learns from the corrections you give Lovable, turns reusable lessons into Knowledge or Skills, and helps you decide whether those instructions should remain.",
  );
  assert.equal(
    copy.HERO_STATUS,
    "A local prototype. This page is the front door; the product runs on your computer.",
  );
  assert.deepEqual(Object.values(copy.HERO_ACTIONS), [
    "Open Harness Ledger",
    "Run it on your computer",
    "See how it works",
    "View source",
    "Use through MCP",
    "Already running it on your machine?",
    "Open the app",
  ]);
});

test("landing: Start here leads with three setup steps, in order", () => {
  assert.equal(copy.START_TITLE, "Start here");
  assert.match(copy.START_TEXT, /takes about ten minutes/);
  assert.deepEqual(
    copy.START_STEPS.map((s) => s.title),
    ["Clone and start", "Open the app and connect Lovable", "Pick an AI provider and analyse"],
  );
  assert.match(copy.START_NEEDS, /Node\.js 22\.12 or newer/);
});

test("landing: Why this page can't run the product, verbatim reasoning", () => {
  assert.equal(copy.WHY_LOCAL_TITLE, "Why this page can't run the product");
  assert.match(copy.WHY_LOCAL_TEXT, /Client Not Found/);
  assert.match(copy.WHY_LOCAL_TEXT, /localhost callback/);
  assert.equal(copy.WHY_LOCAL_NOTE, "Signing in here only shows empty preview pages.");
});

test("landing: the five-step loop, in order", () => {
  assert.deepEqual(
    copy.LOOP_STEPS.map((s) => s.title),
    [
      "Correct Lovable",
      "Harness Ledger finds the lesson",
      "Review Knowledge or Skill",
      "Test if you want",
      "Add to Lovable, then observe",
    ],
  );
});

test("landing: claims match the capability manifest", () => {
  assert.equal(status("knowledge_write"), "working");
  assert.equal(status("local_skill_proposal"), "working");
  // Checkpoint 3 S1: updated with intent -- remote_skill_write moved from
  // "blocked" to "working" after one approved live write (create only).
  assert.equal(status("remote_skill_write"), "working");
  assert.match(copy.PRIMITIVES_STATUS, /never updates or deletes a Skill/);
  assert.equal(status("historical_replay"), "working");
  assert.equal(status("paired_comparison"), "planned");
  assert.deepEqual(
    copy.EVIDENCE_LEVELS.map((l) => [l.name, l.status]),
    [
      ["Historical replay", "Available"],
      ["Paired comparison", "Planned"],
      ["Repeated paired evidence", "Planned"],
    ],
  );
  assert.equal(status("hosted_lovable_execution"), "blocked");
  assert.equal(
    copy.HOSTED_TEXT,
    "The workflow runs locally because only a local client can complete Lovable's sign-in flow. The Lovable-hosted page presents the product and keeps the hosted adapter for an approved hosted authorization path.",
  );
  assert.equal(status("harness_ledger_mcp"), "working");
  assert.equal(
    copy.MCP_LINE,
    "Lovable MCP lets Harness Ledger operate Lovable. Harness Ledger MCP lets your agent operate Harness Ledger.",
  );
  assert.equal(status("behavioral_verification"), "planned");
  assert.ok(copy.LIMITATIONS.some((l) => /Behavioural checks/.test(l)));
  assert.equal(
    copy.EVIDENCE_COST_LINE,
    "Creating project copies currently uses no Lovable builder credits. Running a Lovable build in a copy consumes normal builder credits.",
  );
  assert.equal(
    copy.MODES_TEXT,
    "Both modes sync, analyse and recommend. Ask me first waits for approval before persistent or credit-spending actions. Automatic performs only the actions, projects and budgets the user has allowed.",
  );
});

test("landing page source: sections in the required order, limitations collapsed, no fetch, no redirect, no fake assets, one product name", () => {
  const order = [
    "HERO_TITLE",
    "START_TITLE",
    "WHY_LOCAL_TITLE",
    "LOOP_TITLE",
    "PRIMITIVES_TITLE",
    "EVIDENCE_TITLE",
    "VERSIONING_TITLE",
    "MODES_TITLE",
    "ARCHITECTURE_TITLE",
    "MCP_TITLE",
    "LIMITATIONS_TITLE",
    "SOURCE_TITLE",
  ];
  let last = -1;
  for (const marker of order) {
    const idx = code.indexOf(`{${marker}}`, last + 1);
    assert.ok(idx > last, `landing page section out of order or missing: ${marker}`);
    last = idx;
  }
  assert.ok(!/navigate\(|redirect\(/.test(code), "the landing page never redirects");
  assert.ok(!/fetch\(/.test(code), "the landing page fetches nothing");
  assert.ok(!/<img|<video|\.png|\.mp4/.test(code), "no screenshots, recordings or images");
  assert.match(code, /signedIn \? "\/inbox" : "\/login"/);
  assert.ok(!/<details[^>]*\bopen\b/.test(code), "details must be collapsed by default");
  const banned = [
    /\bproves\b/i,
    /\bproven\b/i,
    /\bpaired test\b/i,
    /testimonial/i,
    /customers?\b/i,
    /\d+%/,
    /\bhelped\b/,
    /\bHarness(?! Ledger)\b/,
  ];
  const allCopy = Object.values(copy)
    .filter((v) => typeof v !== "function")
    .flatMap((v) => (Array.isArray(v) ? v.map((x) => JSON.stringify(x)) : [String(v)]))
    .join("\n");
  for (const re of banned) {
    assert.ok(!re.test(allCopy), `landing copy must not match ${re}`);
  }
});
