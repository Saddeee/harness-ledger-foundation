// Round 5 Task 2 / spec §1, §6: structural tests for the vocabulary copy changes
// (Suggestions vs Improvements, Rule writer vs Miner, Judge role, landing credits line).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ux = await import("../../src/lib/harness-ux.ts");

function readApp(rel: string): string {
  return readFileSync(new URL(`../../src/${rel}`, import.meta.url), "utf8");
}
function codeOnly(source: string): string {
  return source
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return (
        !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*") && !t.startsWith("{/*")
      );
    })
    .join("\n");
}

const ROUTE = "routes/_authenticated/route.tsx";
const IMPROVEMENT = "components/harness/improvement.tsx";
const INBOX = "routes/_authenticated/inbox.tsx";
const LEDGER = "routes/_authenticated/ledger.tsx";
const INSTRUCTIONS = "routes/_authenticated/instructions.tsx";
const SETTINGS = "components/harness/local-settings.tsx";
const LANDING = "routes/index.tsx";

test("harness-ux.ts: proveCostLine() returns the new copy without parameters", () => {
  assert.equal(
    ux.proveCostLine(),
    "Uses Lovable credits like any build; the cost is recorded after the test.",
  );
});

test("harness-ux.ts: HOW_IT_WORKS_STEPS[1].text mentions 'AI analysis'", () => {
  assert.match(
    ux.HOW_IT_WORKS_STEPS[1].text,
    /AI analysis/,
    "step 2 text should say 'AI analysis'",
  );
});

test("harness-ux.ts: LANDING_INTRO says 'rule you approve'", () => {
  assert.match(ux.LANDING_INTRO, /rule you approve/, "LANDING_INTRO should reference 'rule'");
});

test("harness-ux.ts: LANDING_CREDITS_LINE exists with correct content", () => {
  assert.ok(ux.LANDING_CREDITS_LINE);
  assert.match(
    ux.LANDING_CREDITS_LINE,
    /Spend them on making Lovable better/,
    "LANDING_CREDITS_LINE should mention spending credits",
  );
  assert.match(
    ux.LANDING_CREDITS_LINE,
    /records what each test cost/,
    "LANDING_CREDITS_LINE should mention recording cost",
  );
});

test("nav: Inbox, Suggestions, Instructions, History, Tests, Skills, Projects, Settings in that order", () => {
  // Round 6c part B: Tests joins the sidebar between History and Skills --
  // this is the NAV-order pin the Tests-page task named explicitly, updated
  // here with intent rather than left to bit-rot against a stale list.
  const code = codeOnly(readApp(ROUTE));
  const navMatch = code.match(
    /const NAV = \[[^\]]*\{ to: "\/([^"]+)", label: "([^"]+)" \}[^\]]*\]/s,
  );
  assert.ok(navMatch, "NAV must be defined with route/label tuples");
  // Extract all items from the NAV array
  const allItems = code.match(/\{ to: "\/([^"]+)", label: "([^"]+)" \}/g);
  assert.ok(allItems, "NAV items must exist");
  const items = allItems.map((item) => {
    const m = item.match(/to: "\/([^"]+)", label: "([^"]+)"/);
    return m ? { route: m[1], label: m[2] } : null;
  });
  assert.deepEqual(items, [
    { route: "inbox", label: "Inbox" },
    { route: "ledger", label: "Suggestions" },
    { route: "instructions", label: "Instructions" },
    { route: "history", label: "History" },
    { route: "tests", label: "Tests" },
    { route: "skills", label: "Skills" },
    { route: "projects", label: "Projects" },
    { route: "settings", label: "Settings" },
  ]);
});

test("local-settings.tsx: LLM_ROLES labels contain 'Rule writer' and 'Judge', not 'Miner'", () => {
  const code = codeOnly(readApp(SETTINGS));
  const hasRuleWriter = /label:\s*"Rule writer"/i.test(code);
  const hasJudge = /label:\s*"Judge"/i.test(code);
  const hasMiner = /label:\s*"Miner"/i.test(code);
  assert.ok(hasRuleWriter, "LLM_ROLES must contain 'Rule writer' label");
  assert.ok(hasJudge, "LLM_ROLES must contain 'Judge' label");
  assert.ok(!hasMiner, "LLM_ROLES must not contain 'Miner' label");
});

test("landing page: renders LANDING_CREDITS_LINE", () => {
  const code = codeOnly(readApp(LANDING));
  assert.match(code, /LANDING_CREDITS_LINE/, "landing must import LANDING_CREDITS_LINE");
  assert.match(code, /\{LANDING_CREDITS_LINE\}/, "landing must render LANDING_CREDITS_LINE");
});

test("no user-facing 'improvement' word survives in the guarded pages", () => {
  const GUARDED = [IMPROVEMENT, INBOX, LEDGER, INSTRUCTIONS, SETTINGS];

  // Exact identifier/technical substrings that legitimately contain the word
  // Plain strings, replaced verbatim (split/join), never regexes
  const IDENTIFIERS = [
    "improvements-client",
    "harness-improvements",
    "/api/public/harness/improvements",
    "improvement_id",
    "improvements_id",
    "ImprovementDetail",
    "ImprovementHealth",
    "ImprovementGroup",
    "ImprovementsResponse",
    "Improvement[]",
    "Improvement;",
    "Improvement,",
    "Improvement }",
    "Improvement)",
    "Improvement |",
    "type Improvement",
    "Improvement =",
    "postImprovementAction",
    "fetchImprovements",
    "improvementGroup",
    "`improvement-${",
    "search.improvement",
    'search["improvement"]',
    "search={{ improvement",
    "{ improvement:",
    "improvement: id",
    "improvement?:",
    // Round 6 Task 4 / spec §4: VerdictControl reads the verdict action's
    // own response off `data.improvement?.changed`/`.effect` -- the API's
    // own field name, never rendered to the user.
    "improvement?.",
    "improvement:",
    "improvement }",
    "(improvement",
    "improvement)",
    "improvement,",
    "improvement.",
    "?.improvements",
    "@/lib/improvements-client",
    "@/components/harness/improvement",
    "improvements.tsx",
    "improvement.tsx",
  ];

  function stripIdentifiers(src: string): string {
    let out = src;
    for (const id of IDENTIFIERS) out = out.split(id).join(" ");
    return out;
  }

  for (const rel of GUARDED) {
    const stripped = stripIdentifiers(codeOnly(readApp(rel)));
    const hits = [...stripped.matchAll(/[^\n]{0,40}\bimprovements?\b[^\n]{0,40}/gi)].map((m) =>
      m[0].trim(),
    );
    assert.deepEqual(
      hits,
      [],
      `${rel} still says "improvement" in user-facing text: ${JSON.stringify(hits)}`,
    );
  }
});

test("no copy contains a digit followed by 'credit'", () => {
  const files = [IMPROVEMENT, INBOX, LEDGER, INSTRUCTIONS, SETTINGS, LANDING];
  for (const file of files) {
    const raw = readApp(file);
    const violations = raw.match(/\d\s*credits?\b/gi);
    assert.ok(
      !violations || violations.length === 0,
      `${file}: copy must not contain digit followed by "credit"`,
    );
  }
});
