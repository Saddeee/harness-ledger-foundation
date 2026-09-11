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
  return codeOnly(readApp(DETAIL));
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

test("default technical sections are collapsed and the detail page wraps them in Details + Developer view", () => {
  const layout = codeOnly(readApp(LAYOUT));
  for (const tag of layout.match(/<details[^>]*>/g) ?? []) assert.ok(!/\sopen\b/.test(tag), `collapsed by default, got: ${tag}`);
  const detail = readApp(DETAIL);
  for (const tag of codeOnly(detail).match(/<details[^>]*>/g) ?? []) assert.ok(!/\sopen\b/.test(tag), `collapsed by default, got: ${tag}`);
  assert.match(detail, /<AdvancedDetails title="Details">/);
  assert.ok(!/title="More detail"/.test(detail));
  assert.match(detail, /Developer view/);
  assert.ok(detail.indexOf("developer-view:start") > detail.indexOf('title="Details"'));
  assert.ok(detail.indexOf("developer-view:end") < detail.lastIndexOf("</AdvancedDetails>"));
});

test("detail page order: back, decision card, wording, why, What happened, Details (stage bar inside), developer view last", () => {
  const detail = codeOnly(readApp(DETAIL));
  const body = detail.slice(detail.indexOf("export function ImprovementDetail"));
  const order = [
    "{backLabel}",
    "<DecisionCard item={item}",
    "Change the wording",
    "{whyFor(item.classification)}",
    "What happened",
    'title="Details"',
    "<ProcessProgress",
    "How Harness read this",
    "Wording history",
  ];
  let last = -1;
  for (const marker of order) {
    const at = body.indexOf(marker);
    assert.ok(at > last, `expected "${marker}" after the previous marker (at ${at}, previous ${last})`);
    last = at;
  }
  assert.match(body, /<DecisionCard item=\{item\}[^>]*busy=\{busy\}[^>]*run=\{run\}[^>]*titleAs="h1"/);
  const raw = readApp(DETAIL);
  assert.ok(raw.indexOf("developer-view:start") > raw.indexOf('title="Details"'));
  // proof is hidden until it can run
  assert.ok(!/Run proof|Prove it first|How Harness would prove this|PROVE_INTRO|proveCostLine/.test(body));
});

test("decision card: three buttons for pending items, Change decision for decided ones, no Skill, no Decide later", () => {
  const detail = codeOnly(readApp(DETAIL));
  const card = detail.slice(detail.indexOf("export function DecisionCard"), detail.indexOf("export function ImprovementDetail"));
  assert.match(detail, /const ADD_LABELS: Record<Destination, string> = \{\s*project: "Add to this project",\s*workspace: "Add to all my projects",\s*\};/);
  assert.match(card, /<AddConfirm item=\{item\} destination="project" busy=\{busy\} run=\{run\} \/>/);
  assert.match(card, /<AddConfirm item=\{item\} destination="workspace" busy=\{busy\} run=\{run\} variant="outline" \/>/);
  assert.match(card, /<SkipConfirm item=\{item\} busy=\{busy\} run=\{run\} \/>/);
  assert.match(card, /\{onOpen \? \(/);
  assert.match(card, /onClick=\{\(\) => onOpen\(item\.id\)\}/);
  assert.ok(!/>\s*Details\s*<\/button>/.test(card), "no separate Details link; the card opens the item");
  assert.match(card, /<DecidedStatus item=\{item\} busy=\{busy\} run=\{run\} \/>/);
  const decided = detail.slice(detail.indexOf("function DecidedStatus"), detail.indexOf("export function DecisionCard"));
  assert.match(decided, />\s*Change decision\s*<\/summary>/);
  assert.match(decided, /trigger=\{`\$\{ADD_LABELS\[d\]\} instead`\}/);
  assert.match(decided, /trigger="Try adding again"/);
  assert.match(decided, /trigger="Restore previous version"/);
  assert.match(decided, /\{ action: "restore", id: item\.id, version_id: latestWritten\.id \}/);
  assert.match(decided, /\{ action: "reopen", id: item\.id \}/);
  assert.match(decided, /\{decisionSentence\(/);
  for (const gone of ["Skill", "SKILL_NOT_ON", "Decide later", "Decide now", "isDeferred", "setDeferred", "DecisionPanel", "role=\"radio\"", "justAccepted", "PENDING_CHIP"]) {
    assert.ok(!detail.includes(gone), `${gone} should be gone from the detail component`);
  }
  const client = codeOnly(readApp(CLIENT));
  assert.ok(!/DEFERRED_PREFIX|isDeferred|setDeferred|localStorage/.test(client), "no per-browser state left");
  assert.match(client, /export function groupOf\(item: Improvement\): ImprovementGroup \| null/);
  assert.match(detail, /trigger="Skip"\s+variant="ghost"/);
  assert.match(detail, /title="Skip this improvement\?"/);
});

test("proof copy stays defined for later but nothing on screen runs or mentions a proof", () => {
  assert.equal(
    ux.PROVE_INTRO,
    "Harness runs the same request twice in a temporary copy of this project, with and without the instruction, and shows you the difference.",
  );
  assert.equal(ux.proveCostLine(6), "Uses up to 6 Lovable credits.");
  assert.equal(ux.proveCostLine(null), "Uses up to 6 Lovable credits.");
  for (const page of PAGES) {
    const code = codeOnly(readApp(page));
    assert.ok(!/run_experiment|execute_experiment|remix_project|send_message|"run_proof"|action: "run"|action: "prove"/.test(code), page);
    assert.ok(!/Run proof|PROVE_INTRO|proveCostLine/.test(code), `${page} still shows proof UI`);
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
  assert.match(confirm, /\{ action: "accept", id: item\.id, destination \}, SAVED_LINE/);
  // afterwards: a toast says where it went; the card re-renders as decided
  assert.match(detail, /const SAVED_LINE = "Saved — now under Improvements › Waiting to be added\.";/);
  assert.ok(!/useNavigate/.test(detail), "the component never navigates");
  // the layout supports the preview slot and a disabled confirm
  const layout = codeOnly(readApp(LAYOUT));
  assert.match(layout, /children\?: ReactNode;/);
  assert.match(layout, /<AlertDialogAction onClick=\{onConfirm\} disabled=\{confirmDisabled\}>/);
});

test("stage rendering uses the human note, never a state word alone; decided cards show the group chip", () => {
  const layout = readApp(LAYOUT);
  assert.match(layout, /\{s\.note\}/);
  assert.match(layout, /STAGE_LABELS\[s\.key\]/);
  assert.match(layout, /aria-current=\{s\.state === "current" \? "step" : undefined\}/);
  assert.ok(!/you are here/.test(codeOnly(layout)));
  assert.ok(!/ClickableCard/.test(layout), "whole-card buttons are gone; the buttons are the decision");
  const detail = codeOnly(readApp(DETAIL));
  assert.match(detail, /\{pending \? null : <Badge variant="secondary">\{groupOf\(item\)\}<\/Badge>\}/);
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
  assert.equal(ux.lovableStatusLine({ write_status: "failed", written_at: null }), "Needs attention: adding failed — see Details");

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
    "Waiting to be added", "Proof in progress", "Proof done", "In Lovable", "Needs attention", "Skipped",
  ]);
  const g = (status: "pending" | "accepted" | "skipped", writeStatus: ux.LovableWriteStatus | null, proofOutcome: string | null = null) =>
    ux.improvementGroup({ status, writeStatus, proofOutcome });
  assert.equal(g("pending", null), null, "pending items belong in Inbox, not Improvements");
  assert.equal(g("skipped", null), "Skipped");
  assert.equal(g("accepted", "none"), "Waiting to be added");
  assert.equal(g("accepted", "pending"), "Waiting to be added");
  assert.equal(g("accepted", "pending", "not_run"), "Waiting to be added");
  assert.equal(g("accepted", "written"), "In Lovable");
  assert.equal(g("accepted", "stale"), "Needs attention");
  assert.equal(g("accepted", "failed"), "Needs attention");
  assert.equal(g("accepted", "none", "passed"), "Proof done");
});

test("Improvements page: contract groups only, non-empty only, decision cards, restore lives in the card", () => {
  const ledger = codeOnly(readApp(LEDGER));
  assert.match(ledger, /IMPROVEMENT_GROUPS\.filter\(/);
  assert.match(ledger, /\(grouped\.get\(g\)\?\.length \?\? 0\) > 0/);
  assert.ok(!/Everything Harness has learned/.test(ledger), "no subtitle on Improvements");
  assert.ok(!/Needs your decision|Waiting for proof|Ready to add|Decide later/.test(ledger), "old group names are gone");
  assert.match(ledger, /<DecisionCard item=\{i\} onChanged=\{refresh\} onOpen=\{open\} \/>/);
  assert.ok(!/Restore previous version|action: "restore"|ConfirmAction|ImprovementCard|ClickableCard/.test(ledger));
  assert.ok(!/export function ImprovementCard/.test(readApp(DETAIL)), "the temporary wrapper is gone");
  const inbox = codeOnly(readApp(INBOX));
  assert.match(inbox, /i\.decision\.status === "pending"/, "only pending items are in Inbox");
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

test("Inbox: a count line, then decision cards you can act on without opening them", () => {
  const inbox = codeOnly(readApp(INBOX));
  assert.match(inbox, /<DecisionCard item=\{i\} onChanged=\{refresh\} onOpen=\{open\} \/>/);
  assert.match(inbox, /"One improvement is waiting for your decision\."/);
  assert.match(inbox, /`\$\{pending\.length\} improvements are waiting for your decision\.`/);
  assert.ok(!/ImprovementCard|ClickableCard|isDeferred/.test(inbox));
  assert.ok(!/>\s*Review\s*<\/Button>/.test(inbox));
});

test("evidence rendering only knows two authors and labels them for a person", () => {
  const detail = readApp(DETAIL);
  assert.match(detail, /"Lovable replied" : "You asked Lovable"/);
  assert.match(detail, /Show full response/);
  assert.match(detail, /lovableReplyText\(m\.text\)/);
});

test("landing page: public, three steps from HOW_IT_WORKS_STEPS, one button, never redirects", () => {
  assert.deepEqual(
    ux.HOW_IT_WORKS_STEPS.map((s) => s.title),
    ["Found", "Add or skip", "Nothing changes until you say so"],
  );
  assert.deepEqual(
    ux.HOW_IT_WORKS_STEPS.map((s) => s.text),
    [
      "Harness reads your Lovable chats and spots where you corrected Lovable.",
      "It proposes one instruction per correction. You add it to this project, to all your projects, or skip it.",
      "You see the exact text before it is written, and you can restore the previous version. Reviewing never uses Lovable credits.",
    ],
  );
  const landing = codeOnly(readApp("routes/index.tsx"));
  assert.match(landing, /HOW_IT_WORKS_STEPS\.map/);
  assert.match(landing, /Harness turns the corrections you give Lovable into standing instructions/);
  assert.match(landing, /signedIn \? "\/inbox" : "\/login"/);
  assert.match(landing, /signedIn \? "Open Inbox" : "Sign in"/);
  assert.ok(!/navigate\(|redirect\(/.test(landing), "the landing page never redirects");
  assert.equal(count(landing, "<Button"), 1, "one button");
  assert.ok(!/fetch\(/.test(landing), "the landing page fetches nothing");
  const login = codeOnly(readApp("routes/login.tsx"));
  assert.equal(count(login, 'to: "/inbox"'), 3);
  assert.match(login, /emailRedirectTo: `\$\{window\.location\.origin\}\/inbox`/);
});
