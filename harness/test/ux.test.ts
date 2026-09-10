// Tests for the guided-UX presentation logic (checkpoint C.1/C.2). The logic
// module lives in the root app (src/lib/harness-ux.ts) but is dependency-free,
// so it's tested here with the same node:test runner as the data layer.
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
const PAGES = [
  "routes/_authenticated/inbox.tsx",
  "routes/_authenticated/ledger.tsx",
  "routes/_authenticated/overview.tsx",
  DETAIL,
  LAYOUT,
];

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
  assert.match(detail, /<AdvancedDetails title="More detail">/);
  assert.match(detail, /Developer view/);
  // the developer view is the last thing inside More detail
  assert.ok(detail.indexOf("developer-view:start") > detail.indexOf('title="More detail"'));
  assert.ok(detail.indexOf("developer-view:end") < detail.lastIndexOf("</AdvancedDetails>"));
});

test("action consequence text is present in every decision confirmation", () => {
  const detail = readApp(DETAIL);
  assert.match(detail, /Nothing is written to Lovable yet — adding isn't switched on\. You'll approve the exact Knowledge text first\./);
  assert.match(detail, /Reviewing is free and changes nothing in Lovable\./);
  for (const title of ["Add to all my projects?", "Add to this project only?", "Skip this improvement?"]) {
    assert.ok(detail.includes(title), title);
  }
  assert.match(detail, /Adding to Lovable isn't switched on yet — Harness saves your choice and shows you the exact Knowledge text before anything is written\./);
});

test("stage rendering uses the human note, never a state word alone", () => {
  const layout = readApp(LAYOUT);
  assert.match(layout, /\{s\.note\}/);
  assert.match(layout, /STAGE_LABELS\[s\.key\]/);
  assert.match(layout, /aria-current=\{s\.state === "current" \? "step" : undefined\}/);
  assert.ok(!/you are here/.test(codeOnly(layout)));
});

test("decisionSentence reflects the real lifecycle without implying Lovable changed", () => {
  const pending = ux.decisionSentence({ decision: { status: "pending", decided_at: null }, destination: null, inLovable: false });
  assert.equal(pending, "Waiting for your decision.");
  const accepted = ux.decisionSentence({
    decision: { status: "accepted", decided_at: "2026-09-09T14:38:48Z" },
    destination: "workspace",
    inLovable: false,
  });
  assert.match(accepted, /^You chose: add to all my projects, on 9 Sep\. Not added to Lovable yet\.$/);
  const skipped = ux.decisionSentence({ decision: { status: "skipped", decided_at: null }, destination: null, inLovable: false });
  assert.equal(skipped, "You skipped this improvement.");
  const added = ux.decisionSentence({
    decision: { status: "accepted", decided_at: null },
    destination: "project",
    inLovable: true,
  });
  assert.equal(added, "You chose: add to this project only. Added to Lovable.");
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
  const detail = codeOnly(readApp(DETAIL));
  assert.ok(count(detail, "Lovable credits") <= 2, `Lovable credits x${count(detail, "Lovable credits")}`);
  assert.equal(count(detail, "Harness analysis"), 1);
  for (const page of PAGES.filter((p) => p !== DETAIL)) {
    let code = codeOnly(readApp(page));
    if (page.endsWith("overview.tsx")) {
      // the pre-existing hosted "Credits this month" budget card is out of scope;
      // only the Next-up card is ours
      code = code.slice(code.indexOf("function NextActionCard"), code.indexOf("function Overview"));
    }
    assert.equal(count(code, "credits"), 0, `${page} mentions credits`);
  }
  // the client lib carries the contract field name lovable_credits_max, but no user-facing credit copy
  assert.equal(count(codeOnly(readApp("lib/improvements-client.ts")), "Lovable credits"), 0);
  assert.equal(count(codeOnly(readApp("lib/harness-ux.ts")), "credits"), 0, "harness-ux.ts must not carry credit copy");
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
  for (const page of ["routes/_authenticated/inbox.tsx", "routes/_authenticated/ledger.tsx", "routes/_authenticated/overview.tsx", "lib/improvements-client.ts", LAYOUT]) {
    const code = codeOnly(readApp(page));
    for (const word of ["checkpoint", "message_id", "provenance"]) {
      assert.ok(!new RegExp(word, "i").test(code), `${word} leaks into ${page}`);
    }
  }
});

test("no experiment execution action is exposed; the only run control is disabled", () => {
  for (const page of PAGES) {
    const code = codeOnly(readApp(page));
    assert.ok(!/run_experiment|execute_experiment|remix_project|send_message|"run_proof"|action: "run"/.test(code), page);
  }
  const detail = readApp(DETAIL);
  assert.match(detail, /<Button disabled aria-disabled className="w-full sm:w-auto">\s*Run proof/);
  assert.match(detail, /Not available yet\./);
});

test("pages only fetch local harness routes and only the improvements endpoint", () => {
  for (const page of ["routes/_authenticated/inbox.tsx", "routes/_authenticated/ledger.tsx", "routes/_authenticated/overview.tsx", "lib/improvements-client.ts", DETAIL]) {
    const code = codeOnly(readApp(page));
    const targets = [...code.matchAll(/fetch\("([^"]+)"/g)].map((m) => m[1]);
    for (const t of targets) assert.match(t!, /^\/api\/public\/harness\/improvements$/, `${page} fetches ${t}`);
    assert.ok(!/lovable\.dev|set_project_knowledge|setProjectKnowledge|createWorkspaceSkill/i.test(code), page);
  }
  assert.ok(readApp("routes/_authenticated/inbox.tsx").includes("fetchImprovements"));
  assert.ok(readApp("routes/_authenticated/ledger.tsx").includes("fetchImprovements"));
});

test("Inbox cards are whole-card buttons with no separate Review button; nav says Improvements", () => {
  const layout = readApp(LAYOUT);
  assert.match(layout, /export function ClickableCard/);
  assert.match(layout, /<button\s+type="button"/);
  const detail = readApp(DETAIL);
  assert.match(detail, /<ClickableCard onClick=/);
  assert.ok(!/>\s*Review\s*<\/Button>/.test(detail));
  assert.ok(!/>\s*Review\s*<\/Button>/.test(readApp("routes/_authenticated/inbox.tsx")));
  assert.match(readApp("routes/_authenticated/route.tsx"), /label: "Improvements"/);
  assert.ok(!/label: "Ledger"/.test(readApp("routes/_authenticated/route.tsx")));
});

test("evidence rendering only knows two authors and labels them for a person", () => {
  const detail = readApp(DETAIL);
  assert.match(detail, /"Lovable replied" : "You asked Lovable"/);
  assert.match(detail, /Show full response/);
  assert.match(detail, /lovableReplyText\(m\.text\)/);
});
