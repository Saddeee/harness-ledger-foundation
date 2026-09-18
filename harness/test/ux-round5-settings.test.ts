// Round 5 Task 6 / spec §4, §4b, §1: structural tests for the Decisions
// settings section, the "one model by default" AI analysis simplification,
// the executor route's three new settings fields, and the "Accepted
// automatically" marker on a decided item. Same lightweight, dependency-
// free readApp/codeOnly helpers as ux-round4-retire.test.ts (kept in its
// own file per the task instructions -- other files are edited concurrently
// this round).
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
      return (
        !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*") && !t.startsWith("{/*")
      );
    })
    .join("\n");
}

const SETTINGS = "components/harness/local-settings.tsx";
const EXECUTOR_ROUTE = "routes/api/public/harness/executor.ts";
const IMPROVEMENTS_ROUTE = "routes/api/public/harness/improvements.ts";
const CLIENT = "lib/improvements-client.ts";
const LEDGER = "routes/_authenticated/ledger.tsx";
const IMPROVEMENT = "components/harness/improvement.tsx";
const INBOX = "routes/_authenticated/inbox.tsx";

// ---- Decisions section (spec §4/§4b) ----

test("local-settings.tsx: a Decisions section (h2) exists, above AI analysis and Sync schedule", () => {
  const raw = readApp(SETTINGS);
  assert.ok(raw.includes(">Decisions<"), "Decisions section heading is missing");

  const decisionsAt = raw.indexOf(">Decisions<");
  const syncAt = raw.indexOf(">Sync schedule<");
  const aiAt = raw.indexOf(">AI analysis<");
  assert.ok(decisionsAt >= 0 && syncAt > decisionsAt, "Decisions must come before Sync schedule");
  assert.ok(aiAt > decisionsAt, "Decisions must come before AI analysis");
});

test("local-settings.tsx: the radio pair uses the spec's exact copy, and the default is 'ask'", () => {
  const raw = readApp(SETTINGS);
  const code = codeOnly(raw);

  // Checkpoint 2 (spec §14): only the two mode names, plus the shared
  // explanation and the autonomy note from onboarding-copy.ts, and the
  // unimplemented fine-grained controls named as planned.
  assert.ok(raw.includes('const ASK_LABEL = "Ask me first";'));
  assert.ok(raw.includes('const AUTOMATIC_LABEL = "Automatic";'));
  assert.ok(raw.includes("{MODE_EXPLANATION}") && raw.includes("{MODE_AUTONOMY_NOTE}"));
  assert.ok(
    raw.includes(
      "Planned, not available yet: per-Skill permissions, frequency limits and risk restrictions.",
    ),
  );

  assert.match(code, /DEFAULT_DECISION_MODE:\s*"ask"\s*\|\s*"automatic"\s*=\s*"ask"/);
  assert.match(code, /useState<"ask" \| "automatic">\(DEFAULT_DECISION_MODE\)/);
  assert.match(code, /<RadioGroup\s+value=\{decisionMode\}/);
  assert.match(code, /value="ask"/);
  assert.match(code, /value="automatic"/);
});

test("local-settings.tsx: 'Confidence needed' (0.5-1, step 0.05) shows only in automatic mode", () => {
  const code = codeOnly(readApp(SETTINGS));
  assert.match(code, /Confidence needed/);
  assert.match(
    code,
    /id="decision-auto-confidence"[\s\S]{0,200}min=\{0\.5\}[\s\S]{0,80}max=\{1\}[\s\S]{0,80}step=\{0\.05\}/,
  );
  // Gated on decisionMode === "automatic" -- the confidence field is not a
  // permanent fixture of the section.
  const gateIdx = code.indexOf('decisionMode === "automatic" ?');
  const fieldIdx = code.indexOf('id="decision-auto-confidence"');
  assert.ok(
    gateIdx >= 0 && fieldIdx > gateIdx,
    "the confidence field must be inside the automatic-mode gate",
  );
});

test("local-settings.tsx: the feedback line reads the accepted/skipped/verdicts counts and explains the loop", () => {
  const code = codeOnly(readApp(SETTINGS));
  assert.match(code, /From your decisions so far:/);
  assert.match(code, /accepted, \$\{.*\} skipped, \$\{.*\} verdicts/);
  assert.match(
    code,
    /Harness Ledger shows the Rule writer what you accepted and skipped, and won't re-propose what you skipped\./,
  );
  assert.match(code, /action:\s*"settings"[\s\S]{0,120}decision_mode:\s*decisionMode/);
  assert.match(code, /decision_auto_confidence:\s*autoConfidence/);
});

// ---- AI analysis: one model by default, Advanced per-role (spec §1) ----

test("local-settings.tsx: one provider Select + one model Input for analysis, applied to every role on save", () => {
  const code = codeOnly(readApp(SETTINGS));
  assert.match(code, /Model for analysis/);
  assert.match(code, /id="llm-model-provider"/);
  assert.match(code, /id="llm-model-model"/);
  assert.match(code, /llmModels\.rule_writer\.provider/);
  assert.match(code, /llmModels\.rule_writer\.model/);

  // The save path normalises every role from rule_writer -- confirmed by
  // every LLM_ROLES key appearing as a target of the same spread.
  const saveFn = code.slice(
    code.indexOf("const saveAiAnalysis = useMutation("),
    code.indexOf("const removeLlmKey = useMutation("),
  );
  for (const role of ["classifier", "rule_writer", "judge", "reviewer", "proposer"]) {
    assert.match(
      saveFn,
      new RegExp(`${role}:\\s*\\{\\s*\\.\\.\\.llmModels\\.rule_writer\\s*\\}`),
      `saveAiAnalysis must apply the single model to role "${role}"`,
    );
  }
});

test("local-settings.tsx: the one-model save gate tracks perRoleEdited, not whether Advanced is/was open", () => {
  const raw = readApp(SETTINGS);
  const code = codeOnly(raw);

  // Fix round 1 item 2: merely opening Advanced to look must not leave the
  // save gate keyed off it -- there must be no advancedOpen state left at
  // all, and the gate itself must read perRoleEdited.
  assert.ok(!/advancedOpen/.test(code), "advancedOpen must be fully removed");
  assert.match(code, /const \[perRoleEdited, setPerRoleEdited\] = useState\(false\)/);

  const saveFn = code.slice(
    code.indexOf("const saveAiAnalysis = useMutation("),
    code.indexOf("const removeLlmKey = useMutation("),
  );
  assert.match(saveFn, /const modelsToSave: LlmModels = perRoleEdited\s*\n\s*\? llmModels/);
  // Reset only once a save actually applied the models (never on a
  // settingsError, which leaves per-role edits still un-persisted).
  assert.match(saveFn, /setPerRoleEdited\(false\)/);

  // Any per-role row's own onChange (both the provider Select and the
  // model Input, for every LLM_ROLES row via the shared map) marks
  // perRoleEdited -- not the primary fields' onChange, which stay bound to
  // llmModels.rule_writer only.
  const detailsBody = code.slice(
    code.indexOf('<details className="rounded-md border">'),
    code.indexOf("</details>"),
  );
  assert.equal(
    (detailsBody.match(/setPerRoleEdited\(true\)/g) ?? []).length,
    2,
    "both per-role fields (provider Select and model Input) must set perRoleEdited",
  );

  // The primary fields' own onChange handlers (outside the details) must
  // never themselves flip perRoleEdited.
  const primaryFieldsBody = code.slice(
    code.indexOf('<p className="text-sm font-medium">Model for analysis</p>'),
    code.indexOf('<details className="rounded-md border">'),
  );
  assert.ok(
    !/setPerRoleEdited/.test(primaryFieldsBody),
    "editing the primary fields must not itself mark perRoleEdited",
  );
});

test("local-settings.tsx: the primary fields show a muted note when roles differ and nothing has been edited per-role yet", () => {
  const raw = readApp(SETTINGS);
  const code = codeOnly(raw);
  assert.ok(
    raw.includes(
      "Roles currently use different models; saving these fields applies them to every role.",
    ),
  );
  assert.match(code, /rolesDiffer\(llmModels\) && !perRoleEdited/);
});

test("local-settings.tsx: 'Advanced: different models per role' is a collapsed <details> wrapping the five role rows, with a note when they differ", () => {
  const raw = readApp(SETTINGS);
  const code = codeOnly(raw);

  const detailsTags = [...code.matchAll(/<details[^>]*>/g)];
  assert.ok(detailsTags.length > 0, "expected at least one <details> element");
  for (const tag of detailsTags)
    assert.ok(!/\sopen\b/.test(tag[0]), `<details> must not be open: ${tag[0]}`);

  assert.ok(raw.includes("Advanced: different models per role"));
  assert.match(code, /function rolesDiffer/);
  assert.match(code, /Roles use different models\./);

  // The per-role rows (one per LLM_ROLES entry) live after the Advanced
  // summary, not before it -- i.e. genuinely wrapped, not just present
  // somewhere on the page.
  const advancedAt = raw.indexOf("Advanced: different models per role");
  const roleRowsAt = raw.indexOf("llm-role-provider-${key}");
  assert.ok(
    advancedAt >= 0 && roleRowsAt > advancedAt,
    "the per-role rows must be inside the details",
  );
});

// ---- executor.ts: the three new settings fields ----

test("executor.ts: GET settings carries decision_mode, decision_auto_confidence, evidence_sources and feedback", () => {
  const code = codeOnly(readApp(EXECUTOR_ROUTE));
  assert.match(code, /decision_mode:\s*settings\.decision_mode/);
  assert.match(code, /decision_auto_confidence:\s*Number\(settings\.decision_auto_confidence\)/);
  assert.match(code, /evidence_sources:\s*JSON\.parse\(settings\.evidence_sources\)/);
  assert.match(code, /feedback:\s*adapter\.feedbackStats\(\)/);
});

test("executor.ts: POST settings accepts decision_mode, decision_auto_confidence and evidence_sources (as a JSON string)", () => {
  const code = codeOnly(readApp(EXECUTOR_ROUTE));
  const settingsAction = code.slice(
    code.indexOf('if (action === "settings")'),
    code.indexOf('if (action === "llm_settings")'),
  );
  assert.match(settingsAction, /patch\["decision_mode"\]\s*=\s*String\(body\["decision_mode"\]\)/);
  assert.match(
    settingsAction,
    /patch\["decision_auto_confidence"\]\s*=\s*String\(body\["decision_auto_confidence"\]\)/,
  );
  assert.match(settingsAction, /patch\["evidence_sources"\]/);
  assert.match(settingsAction, /JSON\.stringify\(body\["evidence_sources"\]\)/);
});

test("improvements-client.ts: ExecutorResponse.settings carries the Decisions fields", () => {
  const code = codeOnly(readApp(CLIENT));
  assert.match(code, /settings\?:\s*ExecutorSettings/);
  assert.match(code, /decision_mode:\s*"ask"\s*\|\s*"automatic"/);
  assert.match(code, /decision_auto_confidence:\s*number/);
  assert.match(code, /feedback:\s*FeedbackStats/);
});

test("improvements.ts route: counts carries auto_accepted_since_seen, 0 when inbox_last_seen_at is empty", () => {
  const code = codeOnly(readApp(IMPROVEMENTS_ROUTE));
  assert.match(code, /auto_accepted_since_seen:\s*settings\.inbox_last_seen_at/);
  assert.match(code, /adapter\.countAutoAcceptedSince\(settings\.inbox_last_seen_at\)/);
  assert.match(code, /:\s*0,/, "the ternary's false branch must fall back to 0");
});

// ---- "Accepted automatically" marker (spec §4 visibility) ----

test("ledger.tsx and improvement.tsx: a decided item shows an 'Accepted automatically' badge next to the group badge when decided_by === 'automatic'", () => {
  const combined = codeOnly(readApp(LEDGER) + readApp(IMPROVEMENT));
  assert.match(combined, /Accepted automatically/);
  assert.match(combined, /item\.decided_by === "automatic"/);

  // ledger.tsx never builds its own badge -- every decided item's card
  // comes from DecisionCard's own (shared, non-compact) rendering, so the
  // marker only has to exist there once, not duplicated per caller.
  const ledgerCode = codeOnly(readApp(LEDGER));
  assert.match(ledgerCode, /<DecisionCard item=\{i\} onChanged=\{refresh\} onOpen=\{open\} \/>/);
  assert.ok(
    !/Accepted automatically/.test(ledgerCode),
    "ledger.tsx itself renders no badge directly",
  );

  // The badge sits beside the existing group Badge, only for a decided
  // (non-pending) item -- inside the same `pending ? ... : (...)` branch.
  const detailCode = codeOnly(readApp(IMPROVEMENT));
  const badgeBranch = detailCode.slice(
    detailCode.indexOf("{pending ? ("),
    detailCode.indexOf("{pending ? (", detailCode.indexOf("{pending ? (") + 1),
  );
  assert.match(badgeBranch, /Badge variant="secondary">\{groupOf\(item\)\}/);
  assert.match(badgeBranch, /Accepted automatically/);
});

test("inbox.tsx: the empty state names how many Harness Ledger accepted automatically since the last visit, in automatic mode only", () => {
  const code = codeOnly(readApp(INBOX));
  assert.match(code, /executorQueryOptions/);
  assert.match(code, /executor\.data\?\.settings\?\.decision_mode === "automatic"/);
  assert.match(code, /auto_accepted_since_seen/);
  assert.match(
    code,
    /Nothing needs your decision\. Harness Ledger accepted \$\{autoAcceptedSince\} suggestion\$\{autoAcceptedSince === 1 \? "" : "s"\} automatically since your last visit; see Suggestions\./,
  );
  // The plain line still exists for ask mode / nothing auto-accepted yet.
  assert.ok(
    readApp(INBOX).includes(
      "Nothing needs your decision. Everything you've decided on is under Suggestions.",
    ),
  );
});
