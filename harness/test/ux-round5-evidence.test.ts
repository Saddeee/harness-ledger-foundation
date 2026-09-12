// Round 5 Task 7 / spec §5: structural + unit tests for honest evidence
// wording, the verdict buttons, and the Settings › Evidence section. Same
// lightweight, dependency-free readApp/codeOnly pattern as
// ux-round4-retire.test.ts (kept in its own file -- other files are edited
// concurrently this round).
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

const HARNESS_UX = "lib/harness-ux.ts";
const INSTRUCTIONS_PAGE = "routes/_authenticated/instructions.tsx";
const IMPROVEMENT = "components/harness/improvement.tsx";
const SETTINGS = "components/harness/local-settings.tsx";

// ---- healthLine: "helped" leaves the UI (spec §5.1) ----

test("healthLine: never says 'helped', for a scripted range of health inputs", () => {
  const scripts: (ux.HealthLike | null)[] = [
    null,
    { applicable_tasks: 0, hurt: 0, last_applicable_at: null },
    { applicable_tasks: 6, hurt: 1, last_applicable_at: "2026-09-03T00:00:00Z" },
    { applicable_tasks: 1, hurt: 0, last_applicable_at: null },
    { applicable_tasks: 12, hurt: 12, last_applicable_at: "2026-01-01T00:00:00Z" },
  ];
  for (const health of scripts) {
    const line = ux.healthLine(health);
    if (line != null) assert.ok(!/helped/i.test(line), `healthLine leaked "helped": ${line}`);
  }
  // The spec's own example line, verbatim.
  assert.equal(
    ux.healthLine({ applicable_tasks: 6, hurt: 1, last_applicable_at: "2026-09-03T00:00:00Z" }),
    "Since added: 6 builds in this area · 1 repeat correction · last used 3 Sep · observed from your real builds",
  );
  assert.equal(
    ux.healthLine({ applicable_tasks: 0, hurt: 0, last_applicable_at: null }),
    "No builds in this area yet",
  );
});

// ---- verdictLine / adherenceLine (spec §5.2, §5 item 3) ----

test("verdictLine: 'You said: <verdict>, <day>', mapping helped/did_not_help/not_sure", () => {
  assert.equal(ux.verdictLine(null), null);
  assert.equal(
    ux.verdictLine({ verdict: "helped", created_at: "2026-09-05T00:00:00Z" }),
    "You said: helped, 5 Sep",
  );
  assert.equal(
    ux.verdictLine({ verdict: "did_not_help", created_at: "2026-09-05T00:00:00Z" }),
    "You said: didn't help, 5 Sep",
  );
  assert.equal(
    ux.verdictLine({ verdict: "not_sure", created_at: "2026-09-05T00:00:00Z" }),
    "You said: not sure, 5 Sep",
  );
});

test("adherenceLine: 'Followed in N of M builds it applied to · judged by AI, with quotes'; null until followed+broke > 0", () => {
  assert.equal(ux.adherenceLine(null), null);
  assert.equal(ux.adherenceLine({ followed: 0, broke: 0, not_applicable: 3 }), null);
  assert.equal(
    ux.adherenceLine({ followed: 5, broke: 1, not_applicable: 2 }),
    "Followed in 5 of 6 builds it applied to · judged by AI, with quotes",
  );
});

test("evidenceSourceLines: four sentences, each ending 'has run for this rule' or 'hasn't run for this rule yet', the paired line always says not available yet", () => {
  const none = ux.evidenceSourceLines({ observed: false, adherence: false, verdicts: false });
  assert.equal(none.length, 4);
  assert.ok(none[0]!.endsWith("This hasn't run for this rule yet."));
  assert.ok(none[1]!.endsWith("This hasn't run for this rule yet."));
  assert.ok(none[2]!.endsWith("This hasn't run for this rule yet."));
  assert.ok(none[3]!.includes("not available yet"));

  const all = ux.evidenceSourceLines({ observed: true, adherence: true, verdicts: true });
  assert.ok(all[0]!.endsWith("This has run for this rule."));
  assert.ok(all[1]!.endsWith("This has run for this rule."));
  assert.ok(all[2]!.endsWith("This has run for this rule."));

  // Paired is never gated on `sources` -- Phase B isn't built regardless.
  assert.ok(all[3]!.includes("not available yet"));
});

// ---- verdict buttons: Instructions row and the Suggestions detail ----

test("instructions.tsx and improvement.tsx: both post action: verdict, and both render the shared VerdictButtons group", () => {
  for (const rel of [INSTRUCTIONS_PAGE, IMPROVEMENT]) {
    const code = codeOnly(readApp(rel));
    assert.match(code, /action:\s*"verdict"/, `${rel} missing action: "verdict"`);
    assert.match(code, /<VerdictButtons\b/, `${rel} missing <VerdictButtons`);
  }
  // The group itself -- aria-label and the three labels, verbatim -- is
  // defined once, in improvement.tsx; instructions.tsx imports the
  // component rather than re-declaring it (checked separately below).
  const buttonsSource = readApp(IMPROVEMENT);
  assert.match(codeOnly(buttonsSource), /aria-label="Did this rule help\?"/);
  for (const label of ["Helped", "Didn't help", "Not sure"]) {
    assert.ok(buttonsSource.includes(label), `missing verdict button label "${label}"`);
  }
});

test("instructions.tsx: imports VerdictButtons from improvement.tsx rather than re-declaring it", () => {
  const code = codeOnly(readApp(INSTRUCTIONS_PAGE));
  assert.match(
    code,
    /import\s*\{\s*VerdictButtons\s*\}\s*from\s*"@\/components\/harness\/improvement"/,
  );
});

test("instructions.tsx: a verdict exists -> 'You said' plus a Change link that shows the buttons again", () => {
  const code = codeOnly(readApp(INSTRUCTIONS_PAGE));
  assert.match(code, /verdictLine\(rule\.verdict\)/);
  assert.match(code, />\s*Change\s*</);
  assert.match(code, /setShowVerdictButtons/);
});

test("improvement.tsx: DecidedStatus shows verdict buttons only for a live (accepted + written) rule, and the adherence line via adherenceLine", () => {
  const code = codeOnly(readApp(IMPROVEMENT));
  assert.match(code, /verdictEligible\s*=\s*accepted\s*&&\s*written\s*&&\s*ruleId\s*!=\s*null/);
  assert.match(code, /adherenceLine\(item\.health\.adherence\)/);
});

test("improvement.tsx: the Details paragraph 'How Harness judges whether a rule helps' lists evidenceSourceLines and a collapsed Quotes list", () => {
  const raw = readApp(IMPROVEMENT);
  const code = codeOnly(raw);
  assert.ok(raw.includes("How Harness judges whether a rule helps"));
  assert.match(code, /evidenceSourceLines\(/);
  assert.ok(raw.includes(">Quotes<") || raw.includes(">\n                Quotes"));
  // Every <details> in the file stays collapsed.
  for (const tag of raw.match(/<details[^>]*>/g) ?? []) {
    assert.ok(!/\sopen\b/.test(tag), `<details> must not be open: ${tag}`);
  }
});

// ---- Settings › Evidence (spec §5 "which count") ----

test("local-settings.tsx: an Evidence section (h2) exists, right after Decisions", () => {
  const raw = readApp(SETTINGS);
  assert.ok(raw.includes(">Evidence<"), "Evidence section heading is missing");

  const decisionsAt = raw.indexOf(">Decisions<");
  const evidenceAt = raw.indexOf(">Evidence<");
  const syncAt = raw.indexOf(">Sync schedule<");
  assert.ok(decisionsAt >= 0 && evidenceAt > decisionsAt, "Evidence must come after Decisions");
  assert.ok(syncAt > evidenceAt, "Evidence must come before Sync schedule");
});

test("local-settings.tsx: the Evidence section's intro and four checkbox labels match the spec verbatim; paired is disabled and unchecked", () => {
  const raw = readApp(SETTINGS);
  const code = codeOnly(raw);

  assert.ok(
    raw.includes(
      "Signals that count towards a rule's health and retirement. Every signal is always shown; this only changes what can trigger a retirement suggestion.",
    ),
    "Evidence intro copy must match the spec verbatim",
  );

  for (const label of [
    "Repeat corrections observed in your real builds",
    "AI adherence check (with quotes)",
    "Your verdicts",
    "Paired tests (not available yet)",
  ]) {
    assert.ok(raw.includes(label), `local-settings.tsx missing Evidence label "${label}"`);
  }

  // Four checkboxes, one per source.
  for (const id of [
    "evidence-observed",
    "evidence-adherence",
    "evidence-verdicts",
    "evidence-paired",
  ]) {
    assert.match(code, new RegExp(`id="${id}"`), `missing checkbox id="${id}"`);
  }

  // Paired stays disabled and unchecked -- Phase B isn't built.
  const pairedBlock = code.slice(
    code.indexOf('id="evidence-paired"') - 40,
    code.indexOf('id="evidence-paired"') + 120,
  );
  assert.match(pairedBlock, /checked=\{false\}/);
  assert.match(pairedBlock, /disabled/);

  // Posts the settings action with evidence_sources.
  assert.match(code, /action:\s*"settings"[\s\S]{0,80}evidence_sources:\s*evidenceSources/);
});

// ---- Global honesty constraints ----

test("harness-ux.ts: no digit followed by 'credit'", () => {
  const raw = readApp(HARNESS_UX);
  assert.ok(!/\d\s*credit/i.test(raw), "harness-ux.ts must not show a credit number");
});

test("no 'spec'/'checkpoint' leaks into user-facing copy (comments freely cite the spec; code must not)", () => {
  for (const rel of [HARNESS_UX, INSTRUCTIONS_PAGE, IMPROVEMENT, SETTINGS]) {
    const code = codeOnly(readApp(rel));
    assert.ok(!/\bspec\b/i.test(code), `"spec" leaks into ${rel} outside a comment`);
    assert.ok(!/checkpoint/i.test(code), `"checkpoint" leaks into ${rel} outside a comment`);
  }
});
