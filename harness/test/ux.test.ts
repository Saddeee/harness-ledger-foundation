// Tests for the guided-UX presentation logic (checkpoints C.1/C.2/D0). The
// logic module lives in the root app (src/lib/harness-ux.ts) but is
// dependency-free, so it's tested here with the same node:test runner as the
// data layer. Page sources are checked structurally (no DOM).
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
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*") && !t.startsWith("{/*");
    })
    .join("\n");
}
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const DETAIL = "components/harness/improvement.tsx";
const LAYOUT = "components/harness/decision-layout.tsx";
const INBOX = "routes/_authenticated/inbox.tsx";
const LEDGER = "routes/_authenticated/ledger.tsx";
const SHELL = "routes/_authenticated/route.tsx";
const CLIENT = "lib/improvements-client.ts";
const PAGES = [INBOX, LEDGER, DETAIL, LAYOUT];

// Everything a person can read on the detail page: the component plus the
// copy constants it pulls from harness-ux.ts (rendered through helpers).
function detailCopy(): string {
  return codeOnly(readApp(DETAIL)) + "\n" + ux.PROVE_INTRO + " " + ux.proveCostLine(6);
}

test("enum-to-label mappings: every spec'd example maps to the required plain-language label", () => {
  assert.equal(ux.label(ux.CLASSIFICATION_LABELS, "constraint_restatement"), "Existing expectation was missed");
  assert.equal(ux.label(ux.CLASSIFICATION_LABELS, "preference_revision"), "You changed the preferred approach");
  assert.equal(ux.label(ux.CLASSIFICATION_LABELS, "missing_requirement"), "Part of the request was missed");
  assert.equal(ux.label(ux.CLASSIFICATION_LABELS, "defect_correction"), "Lovable made an implementation mistake");
  assert.equal(ux.label(ux.SCOPE_LABELS, "workspace"), "Use across my projects");
  assert.equal(ux.label(ux.SCOPE_LABELS, "project"), "Use only in this project");
  assert.equal(ux.label(ux.EVIDENCE_LEVEL_LABELS, "proposed"), "Not tested yet");
  assert.equal(ux.label(ux.VERIFIER_TYPE_LABELS, "structural"), "Automatic check");
  assert.equal(ux.label(ux.VERIFIER_TYPE_LABELS, "ai_rubric"), "AI review");
  assert.equal(ux.label(ux.VERIFIER_STATUS_LABELS, "not_run"), "Not tested");
  assert.equal(ux.label(ux.EXPERIMENT_TYPE_LABELS, "paired_control_treatment"), "Compare with and without the rule");
  assert.equal(ux.label(ux.FIELD_LABELS, "predicted_failure"), "Problem this should prevent");
  assert.deepEqual(Object.values(ux.STAGE_LABELS), ["Found", "Your review", "Proof", "In Lovable"]);
  assert.deepEqual(Object.values(ux.DESTINATION_LABELS), [
    "This project's Knowledge",
    "Workspace Knowledge (all my projects)",
    "As a Skill",
  ]);
  for (const v of ["proposed", "approved", "testing", "supported", "active", "questioned", "disabled", "retired", "rolled_back", "rejected"]) {
    assert.notEqual(ux.label(ux.RULE_STATE_LABELS, v), v, `rule state ${v} needs a label`);
  }
  assert.equal(ux.label(ux.SCOPE_LABELS, "galaxy"), "galaxy");
});

test("lay 'why' templates never invent specifics and always fall back", () => {
  assert.match(ux.whyFor("constraint_restatement"), /^Lovable missed something you already expected\./);
  assert.match(ux.whyFor("preference_revision"), /^You changed how you want this done\./);
  assert.match(ux.whyFor("missing_requirement"), /^Part of what you needed wasn't in the request\./);
  assert.match(ux.whyFor("defect_correction"), /^Lovable made a mistake you had to fix\./);
  assert.equal(ux.whyFor("other"), ux.whyFor(null));
  for (const t of Object.values(ux.WHY_TEMPLATES)) assert.ok(!/cron|pg_cron|queue|credit/i.test(t), t);
});

test("default technical sections are collapsed and the detail page wraps them in More detail + Developer view", () => {
  const layout = codeOnly(readApp(LAYOUT));
  for (const tag of layout.match(/<details[^>]*>/g) ?? []) assert.ok(!/\sopen\b/.test(tag), `collapsed by default, got: ${tag}`);
  const detail = readApp(DETAIL);
  for (const tag of codeOnly(detail).match(/<details[^>]*>/g) ?? []) assert.ok(!/\sopen\b/.test(tag), `collapsed by default, got: ${tag}`);
  assert.match(detail, /<AdvancedDetails title="More detail">/);
  assert.match(detail, /Developer view/);
  // the developer view is the last thing inside More detail
  assert.ok(detail.indexOf("developer-view:start") > detail.indexOf('title="More detail"'));
  assert.ok(detail.indexOf("developer-view:end") < detail.lastIndexOf("</AdvancedDetails>"));
});

test("detail page order: project, instruction, why, decision panel, stage bar, What happened, proof, More detail", () => {
  const detail = codeOnly(readApp(DETAIL));
  const body = detail.slice(detail.indexOf("export function ImprovementDetail"));
  const order = [
    ">Project<",
    "{item.proposed_instruction}",
    "Change the wording",
    "{whyFor(item.classification)}",
    "<DecisionPanel",
    "<ProcessProgress",
    "What happened",
    "How Harness would prove this",
    'title="More detail"',
  ];
  let last = -1;
  for (const marker of order) {
    const at = body.indexOf(marker);
    assert.ok(at > last, `expected "${marker}" after the previous marker (at ${at}, previous ${last})`);
    last = at;
  }
  // the developer view is the last thing on the page (marker lives in a JSX comment)
  const raw = readApp(DETAIL);
  assert.ok(raw.indexOf("developer-view:start") > raw.indexOf('title="More detail"'));
});

test("decision panel: heading, three destinations with Skill disabled, nothing pre-selected, Add gated on a choice", () => {
  const detail = codeOnly(readApp(DETAIL));
  const panel = detail.slice(detail.indexOf("function DecisionPanel"), detail.indexOf("export function ImprovementDetail"));
  assert.match(panel, /What do you want to do with this\?/);
  assert.match(panel, /Add it to Lovable now/);
  assert.match(panel, /useState<Choice \| null>\(null\)/, "no destination is pre-selected");
  assert.ok(!/item\.destination/.test(panel), "the stale stored destination must not seed the panel");
  assert.match(panel, /\{ key: "project" \}/);
  assert.match(panel, /\{ key: "workspace" \}/);
  assert.match(panel, /\{ key: "skill", disabled: true, note: SKILL_NOT_ON \}/);
  assert.match(detail, /const SKILL_NOT_ON = "Not available yet";/);
  assert.match(panel, /role="radio"/);
  assert.match(panel, /aria-checked=\{choice === c\.key\}/);
  assert.match(panel, /trigger="Add"/);
  assert.match(panel, /disabled=\{destination == null\}/);
  // Decide later / Skip are ghost buttons; Decide later has no dialog and is per-browser only
  assert.match(panel, /"Decide now" : "Decide later"/);
  assert.match(panel, /onDeferredChange\(!deferred\)/);
  assert.match(detail, /const DEFERRED_PREFIX = "harness\.deferred:";|setDeferred\(item\.id, on\)/);
  assert.match(codeOnly(readApp(CLIENT)), /const DEFERRED_PREFIX = "harness\.deferred:";/);
  assert.match(panel, /<SkipConfirm/);
  assert.match(detail, /trigger="Skip"\s+variant="ghost"/);
  assert.match(detail, /title="Skip this improvement\?"/);
});

test("Prove it first: exact copy with the cost inline, Run proof disabled, no proof POST", () => {
  const detail = codeOnly(readApp(DETAIL));
  assert.equal(
    ux.PROVE_INTRO,
    "Harness runs the same request twice in a temporary copy of this project, with and without the instruction, and shows you the difference.",
  );
  assert.equal(ux.proveCostLine(6), "Uses up to 6 Lovable credits.");
  assert.equal(ux.proveCostLine(null), "Uses up to 6 Lovable credits.");
  assert.match(detail, /\{PROVE_INTRO\} \{proveCostLine\(item\.proof\?\.lovable_credits_max\)\}/);
  assert.match(detail, /<Button disabled aria-disabled className="w-full sm:w-auto">\s*Run proof/);
  assert.match(detail, /const PROOF_NOT_ON = "Proof isn't switched on yet\.";/);
  for (const page of PAGES) {
    const code = codeOnly(readApp(page));
    assert.ok(!/run_experiment|execute_experiment|remix_project|send_message|"run_proof"|action: "run"|action: "prove"/.test(code), page);
  }
});

test("Add confirmation: exact preview lines, no-snapshot variant, over-cap guard, post-accept line", () => {
  const detail = codeOnly(readApp(DETAIL));
  const confirm = detail.slice(detail.indexOf("function AddConfirm"), detail.indexOf("function SkipConfirm"));
  assert.match(confirm, /title=\{`Add to \$\{targetLabel\}\?`\}/);
  assert.match(confirm, /Your existing Knowledge \(unchanged\)/);
  assert.match(confirm, /\{preview\.managed_block\}/);
  assert.match(confirm, /\{preview\.char_count\} of \{KNOWLEDGE_CHAR_LIMIT\.toLocaleString\("en-US"\)\} characters/);
  assert.equal(ux.KNOWLEDGE_CHAR_LIMIT, 10000);
  assert.match(detail, /"Uses no Lovable credits\.",/);
  assert.match(detail, /"You can restore the previous version at any time\.",/);
  assert.match(confirm, /consequences=\{preview \? PREVIEW_CONSEQUENCES : \[\]\}/);
  // no snapshot yet -> save the choice, say so, and promise the read-back
  assert.match(
    detail,
    /const NO_SNAPSHOT_BODY =\s*"Harness hasn't read your current Knowledge yet\. Your choice is saved; Harness will show you the exact text before writing\.";/,
  );
  assert.match(confirm, /confirmLabel=\{preview \? "Add" : "Save choice"\}/);
  // over the cap -> the confirm button is disabled and the reason is shown
  assert.match(
    detail,
    /const OVER_CAP_LINE =\s*"This would exceed the Knowledge limit — shorten the instruction or your existing Knowledge first\.";/,
  );
  assert.match(confirm, /confirmDisabled=\{overCap\}/);
  assert.match(confirm, /\{overCap \? \(/);
  // the confirmation posts the contract action, nothing else
  assert.match(confirm, /\{ action: "accept", id: item\.id, destination \}/);
  // afterwards: inline line + Open to the Improvements detail
  assert.match(detail, /const SAVED_LINE = "Saved — now under Improvements › Waiting to be added\.";/);
  assert.match(detail, /\{justAccepted && accepted \? \(/);
  assert.match(detail, /navigate\(\{ to: "\/ledger", search: \{ improvement: item\.id \} \}\)/);
  // the layout supports the preview slot and a disabled confirm
  const layout = codeOnly(readApp(LAYOUT));
  assert.match(layout, /children\?: ReactNode;/);
  assert.match(layout, /<AlertDialogAction onClick=\{onConfirm\} disabled=\{confirmDisabled\}>/);
});

test("stage rendering uses the human note, never a state word alone; chip reads 'Needs your decision'", () => {
  const layout = readApp(LAYOUT);
  assert.match(layout, /\{s\.note\}/);
  assert.match(layout, /STAGE_LABELS\[s\.key\]/);
  assert.match(layout, /aria-current=\{s\.state === "current" \? "step" : undefined\}/);
  assert.ok(!/you are here/.test(codeOnly(layout)));
  assert.equal(ux.PENDING_CHIP, "Needs your decision");
  const detail = codeOnly(readApp(DETAIL));
  assert.match(detail, /deferred\s*\?\s*"Decide later"\s*:\s*PENDING_CHIP/);
});

test("lovableStatusLine / decisionSentence / improvementGroup follow the write lifecycle without implying Lovable changed", () => {
  assert.equal(ux.lovableStatusLine(null), "Waiting for Harness to add it");
  assert.equal(ux.lovableStatusLine({ write_status: "none", written_at: null }), "Waiting for Harness to add it");
  assert.equal(ux.lovableStatusLine({ write_status: "pending", written_at: null }), "Waiting for Harness to add it");
  assert.equal(ux.lovableStatusLine({ write_status: "written", written_at: "2026-09-10T08:00:00Z" }), "Added to Lovable, 10 Sep");
  assert.equal(
    ux.lovableStatusLine({ write_status: "stale", written_at: null, stale_reason: null }),
    "Needs attention: Knowledge changed in Lovable — review the text again",
  );
  assert.equal(ux.lovableStatusLine({ write_status: "failed", written_at: null }), "Needs attention: adding failed — see More detail");

  const pending = ux.decisionSentence({ decision: { status: "pending", decided_at: null }, destination: null });
  assert.equal(pending, "Waiting for your decision.");
  const accepted = ux.decisionSentence({
    decision: { status: "accepted", decided_at: "2026-09-09T14:38:48Z" },
    destination: "workspace",
    lovable: { write_status: "pending", written_at: null },
  });
  assert.equal(accepted, "You chose: add to all my projects, on 9 Sep. Waiting for Harness to add it.");
  const skipped = ux.decisionSentence({ decision: { status: "skipped", decided_at: null }, destination: null });
  assert.equal(skipped, "You skipped this improvement.");
  const added = ux.decisionSentence({
    decision: { status: "accepted", decided_at: null },
    destination: "project",
    lovable: { write_status: "written", written_at: "2026-09-10T08:00:00Z" },
  });
  assert.equal(added, "You chose: add to this project only. Added to Lovable, 10 Sep.");

  assert.deepEqual([...ux.IMPROVEMENT_GROUPS], [
    "Waiting to be added", "Proof in progress", "Proof done", "In Lovable", "Needs attention", "Decide later", "Skipped",
  ]);
  const g = (status: "pending" | "accepted" | "skipped", writeStatus: ux.LovableWriteStatus | null, proofOutcome: string | null = null, deferred = false) =>
    ux.improvementGroup({ status, deferred, writeStatus, proofOutcome });
  assert.equal(g("pending", null), null, "pending items belong in Inbox, not Improvements");
  assert.equal(g("pending", null, null, true), "Decide later");
  assert.equal(g("skipped", null), "Skipped");
  assert.equal(g("accepted", "none"), "Waiting to be added");
  assert.equal(g("accepted", "pending"), "Waiting to be added");
  assert.equal(g("accepted", "pending", "not_run"), "Waiting to be added");
  assert.equal(g("accepted", "written"), "In Lovable");
  assert.equal(g("accepted", "stale"), "Needs attention");
  assert.equal(g("accepted", "failed"), "Needs attention");
  assert.equal(g("accepted", "none", "passed"), "Proof done");
});

test("Improvements page: contract groups only, non-empty only, no subtitle, restore only under In Lovable", () => {
  const ledger = codeOnly(readApp(LEDGER));
  assert.match(ledger, /IMPROVEMENT_GROUPS\.filter\(/);
  assert.match(ledger, /\(grouped\.get\(g\)\?\.length \?\? 0\) > 0/);
  assert.ok(!/Everything Harness has learned/.test(ledger), "no subtitle on Improvements");
  assert.ok(!/Needs your decision|Waiting for proof|Ready to add/.test(ledger), "old group names are gone");
  assert.match(ledger, /g === "In Lovable" \? \(/);
  assert.match(ledger, /trigger="Restore previous version"/);
  assert.match(ledger, /const RESTORE_TITLE = "Restore the previous Knowledge\?";/);
  assert.match(ledger, /const RESTORE_BODY = "Harness will write the earlier text back, as a new version\.";/);
  assert.match(ledger, /\{ action: "restore", id: item\.id, version_id: versionId \}/);
  const inbox = codeOnly(readApp(INBOX));
  assert.ok(!/is waiting for your decision/.test(inbox), "no subtitle on Inbox");
  assert.match(inbox, /i\.decision\.status === "pending"/, "Decide-later items stay in Inbox");
});

test("wording history: reasons only for changes made in this UI; anything else is 'Updated by Harness'", () => {
  assert.equal(
    ux.wordingChangeLine({ changed_at: "2026-09-09T10:00:00Z", reason: "tighter", actor: "operator (local UI)" }),
    "You changed the wording on 9 Sep — tighter.",
  );
  assert.equal(
    ux.wordingChangeLine({ changed_at: "2026-09-09T10:00:00Z", reason: "internal classifier note", actor: "claude-checkpoint-b" }),
    "Updated by Harness on 9 Sep.",
  );
  assert.equal(ux.wordingChangeLine({ changed_at: "2026-09-09T10:00:00Z", reason: "x", actor: "operator" }), "You changed the wording on 9 Sep.");
  assert.match(codeOnly(readApp(DETAIL)), /\{wordingChangeLine\(w\)\}/);
});

test("Overview is gone: the route only redirects to Inbox and nothing links to /overview", () => {
  const overview = codeOnly(readApp("routes/_authenticated/overview.tsx"));
  assert.match(overview, /throw redirect\(\{ to: "\/inbox", replace: true \}\)/);
  assert.ok(!/component:/.test(overview), "no component; it is a pure redirect");
  for (const page of [
    INBOX,
    LEDGER,
    SHELL,
    CLIENT,
    DETAIL,
    LAYOUT,
    "routes/login.tsx",
    "routes/index.tsx",
    "routes/_authenticated/settings.tsx",
  ]) {
    assert.ok(!/["'`]\/overview["'`]/.test(codeOnly(readApp(page))), `${page} still links to /overview`);
  }
});

test("Settings: hosted usage cards live under Advanced, gated to the hosted runtime, with a link to Jobs", () => {
  const settings = codeOnly(readApp("routes/_authenticated/settings.tsx"));
  assert.match(settings, /function AdvancedSection/);
  assert.match(settings, /if \(runtime\.data\?\.mode !== "hosted"\) return null;/);
  assert.match(settings, /<summary[^>]*>\s*Advanced\s*<\/summary>/);
  assert.match(settings, /<Link to="\/jobs"/);
  assert.match(settings, /Credits this month/);
  assert.match(settings, /<AdvancedSection \/>/);
  assert.ok(!/queryKey: \["overview"\]/.test(settings));
});

test("nav: Inbox, Improvements, Projects, Settings in every runtime; How Harness works links to the landing page", () => {
  const shell = codeOnly(readApp(SHELL));
  assert.match(shell, /\{ to: "\/inbox", label: "Inbox" \}/);
  assert.match(shell, /\{ to: "\/ledger", label: "Improvements" \}/);
  assert.match(shell, /\{ to: "\/projects", label: "Projects" \}/);
  assert.match(shell, /\{ to: "\/settings", label: "Settings" \}/);
  assert.equal(count(shell, 'label: "'), 4, "exactly four nav items");
  assert.ok(!/LOCAL_NAV|runtimeQueryOptions|mode === "local"/.test(shell), "nav never depends on the runtime");
  assert.ok(!/label: "Ledger"|label: "Overview"/.test(shell));
  assert.match(shell, /<Link to="\/"[^>]*>\s*How Harness works\s*<\/Link>/);
  const client = codeOnly(readApp(CLIENT));
  assert.ok(!/HowItWorks|howItWorks|HOW_IT_WORKS/.test(client), "no onboarding state in the client lib");
  assert.match(client, /staleTime: Infinity/);
  assert.match(client, /json\.mode === "local" \? "local" : "hosted"/, "anything but a confirmed local answer is hosted");
});

test("formatDate / formatDay produce '8 Sep, HH:MM' style and pass non-dates through", () => {
  assert.match(ux.formatDay("2026-09-08T10:31:23Z"), /^8 Sep$/);
  assert.match(ux.formatDate("2026-09-08T10:31:23Z"), /^8 Sep, \d{2}:\d{2}$/);
  assert.equal(ux.formatDate("not a date"), "not a date");
  assert.equal(ux.formatDate(null), "");
});

test("lovableReplyText extracts what the user saw in the Lovable chat from a verbatim assistant message", () => {
  const raw =
    '<lov-tool-use id="a" name="supabase--run_sql" integration-id="supabase" data="{\\"query\\": \\"select 1\\"}">\n</lov-tool-use>\n' +
    '<lov-tool-use id="b" name="user_messaging--message_user" integration-id="user_messaging" data="{\\"summary\\": \\"s\\", \\"message\\": \\"Heads up: the worker will wake once a minute (1,440 times a day).\\\\nSecond line.\\", \\"finished\\": false}">\n</lov-tool-use>\n' +
    '<lov-tool-use id="c" name="user_messaging--message_user" integration-id="user_messaging" data="{\\"summary\\": \\"t\\", \\"message\\": \\"The foundation is live.\\", \\"finished\\": true}">\n</lov-tool-use>';
  const text = ux.lovableReplyText(raw);
  assert.equal(text, "Heads up: the worker will wake once a minute (1,440 times a day).\nSecond line.\n\nThe foundation is live.");
  assert.ok(!text.includes("run_sql"));
  // no message blocks -> readable fallback, not an empty string
  const fallback = ux.lovableReplyText("plain assistant text " + "x".repeat(1000));
  assert.ok(fallback.length <= 601 && fallback.startsWith("plain assistant text"));
});

test("cost wording: 'Lovable credits' at most twice on the detail page, 'Harness analysis' exactly once, nowhere else", () => {
  const detail = detailCopy();
  assert.ok(count(detail, "Lovable credits") <= 2, `Lovable credits x${count(detail, "Lovable credits")}`);
  assert.equal(count(detail, "Harness analysis"), 1);
  assert.equal(count(codeOnly(readApp(DETAIL)), "credit"), count(codeOnly(readApp(DETAIL)), "Lovable credits") + count(codeOnly(readApp(DETAIL)), "lovable_credits_max"));
  for (const page of [INBOX, LEDGER, LAYOUT]) {
    assert.equal(count(codeOnly(readApp(page)), "credit"), 0, `${page} mentions credits`);
  }
  // the client lib carries the contract field name lovable_credits_max, but no user-facing credit copy
  assert.equal(count(codeOnly(readApp(CLIENT)), "Lovable credits"), 0);
  // harness-ux.ts carries exactly the two approved lines (proof cost, onboarding step 3)
  const uxSource = codeOnly(readApp("lib/harness-ux.ts"));
  assert.equal(count(uxSource, "Lovable credits"), 2);
  assert.equal(count(uxSource, "credit"), 2);
});

test("no internal vocabulary in user-facing JSX outside the Developer view", () => {
  const detail = readApp(DETAIL);
  const start = detail.indexOf("developer-view:start");
  const end = detail.indexOf("developer-view:end");
  assert.ok(start > 0 && end > start);
  const userFacing = codeOnly(detail.slice(0, start) + detail.slice(end));
  for (const word of ["checkpoint", "message_id", "provenance", "confidence", "classifier"]) {
    assert.ok(!new RegExp(word, "i").test(userFacing), `${word} leaks into the user-facing detail`);
  }
  for (const page of [INBOX, LEDGER, SHELL, CLIENT, LAYOUT, "lib/harness-ux.ts", "routes/_authenticated/settings.tsx"]) {
    const code = codeOnly(readApp(page));
    for (const word of ["checkpoint", "message_id", "provenance", "confidence"]) {
      assert.ok(!new RegExp(word, "i").test(code), `${word} leaks into ${page}`);
    }
  }
});

test("pages only fetch local harness routes: improvements and runtime, nothing else", () => {
  for (const page of [INBOX, LEDGER, SHELL, CLIENT, DETAIL]) {
    const code = codeOnly(readApp(page));
    const targets = [...code.matchAll(/fetch\("([^"]+)"/g)].map((m) => m[1]);
    for (const t of targets) assert.match(t!, /^\/api\/public\/harness\/(improvements|runtime)$/, `${page} fetches ${t}`);
    assert.ok(!/lovable\.dev|set_project_knowledge|setProjectKnowledge|createWorkspaceSkill/i.test(code), page);
  }
  const client = codeOnly(readApp(CLIENT));
  assert.match(client, /fetch\("\/api\/public\/harness\/improvements"/);
  assert.match(client, /fetch\("\/api\/public\/harness\/runtime"/);
  assert.ok(readApp(INBOX).includes("fetchImprovements"));
  assert.ok(readApp(LEDGER).includes("fetchImprovements"));
  // the only actions the UI can send
  const actions = [...codeOnly(readApp(DETAIL) + readApp(LEDGER)).matchAll(/action: "([a-z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(actions)].sort(), ["accept", "change_wording", "reopen", "restore", "skip"]);
});

test("Inbox cards are whole-card buttons with no separate Review button; nav says Improvements", () => {
  const layout = readApp(LAYOUT);
  assert.match(layout, /export function ClickableCard/);
  assert.match(layout, /<button\s+type="button"/);
  const detail = readApp(DETAIL);
  assert.match(detail, /<ClickableCard onClick=/);
  assert.ok(!/>\s*Review\s*<\/Button>/.test(detail));
  assert.ok(!/>\s*Review\s*<\/Button>/.test(readApp(INBOX)));
});

test("evidence rendering only knows two authors and labels them for a person", () => {
  const detail = readApp(DETAIL);
  assert.match(detail, /"Lovable replied" : "You asked Lovable"/);
  assert.match(detail, /Show full response/);
  assert.match(detail, /lovableReplyText\(m\.text\)/);
});
