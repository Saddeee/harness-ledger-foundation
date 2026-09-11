// Round 3 Task 3b: the Instructions and Skills pages, the "What changed"
// view, AI analysis and defaults settings, and per-project settings. Kept in
// its own file per the task instructions (other tests are being edited
// concurrently); the same lightweight, dependency-free local helpers are
// duplicated here on purpose (same pattern as ux.test.ts / ux-decision.test.ts).
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
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*") && !t.startsWith("{/*");
    })
    .join("\n");
}
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const SHELL = "routes/_authenticated/route.tsx";
const INSTRUCTIONS_PAGE = "routes/_authenticated/instructions.tsx";
const SKILLS_PAGE = "routes/_authenticated/skills.tsx";
const KNOWLEDGE_PAGE = "routes/_authenticated/knowledge.tsx";
const VERSIONS_PAGE = "routes/_authenticated/versions.tsx";
const LOCAL_SETTINGS = "components/harness/local-settings.tsx";
const LOCAL_PROJECTS = "components/harness/local-projects.tsx";
const DETAIL = "components/harness/improvement.tsx";
const CLIENT = "lib/improvements-client.ts";

const TOUCHED_PAGES = [
  INSTRUCTIONS_PAGE,
  SKILLS_PAGE,
  KNOWLEDGE_PAGE,
  VERSIONS_PAGE,
  LOCAL_SETTINGS,
  LOCAL_PROJECTS,
  DETAIL,
  SHELL,
];

// ---- 1. Nav: six items, in order ----

test("nav: Inbox, Improvements, Instructions, Skills, Projects, Settings -- six items, in order", () => {
  const shell = codeOnly(readApp(SHELL));
  const order = [
    'label: "Inbox"',
    'label: "Improvements"',
    'label: "Instructions"',
    'label: "Skills"',
    'label: "Projects"',
    'label: "Settings"',
  ];
  assert.equal(count(shell, 'label: "'), 6, "exactly six nav items");
  let last = -1;
  for (const marker of order) {
    const at = shell.indexOf(marker);
    assert.ok(at > last, `expected ${marker} after the previous nav item`);
    last = at;
  }
  assert.match(shell, /\{ to: "\/instructions", label: "Instructions" \}/);
  assert.match(shell, /\{ to: "\/skills", label: "Skills" \}/);
  assert.ok(!/label: "Knowledge"/.test(shell), "Knowledge is no longer a nav label");
});

// ---- 2. /instructions: What changed view + demo notice ----

test("instructions.tsx: What changed toggle, per-version diff summary, demo notice, everything else kept", () => {
  const raw = readApp(INSTRUCTIONS_PAGE);
  const code = codeOnly(raw);

  for (const text of [
    "What changed",
    "lines",
    "Demo data is loaded so you can see how history looks.",
    "harness:demo -- --remove",
    "Showing the first 400 lines of the change.",
    "no text change",
  ]) {
    assert.ok(raw.includes(text), `instructions.tsx missing "${text}"`);
  }
  // the "+N lines" summary is a literal JSX text node followed by an
  // expression container, i.e. the raw source contains "+{"
  assert.ok(raw.includes("+{"), 'instructions.tsx missing a literal "+{" (the +N lines summary)');
  // the remove command is rendered inside <code>
  assert.match(code, /<code[^>]*>\s*\{DEMO_REMOVE_COMMAND\}/);
  assert.match(code, /demo_loaded/);

  // the diff renders changes.added / changes.removed / changes.lines / changes.truncated
  assert.match(code, /changes\.added/);
  assert.match(code, /changes\.removed/);
  assert.match(code, /changes\.lines/);
  assert.match(code, /changes\.truncated/);
  // removed lines red, added lines green, context muted
  assert.match(code, /"-":\s*"text-red-700/);
  assert.match(code, /"\+":\s*"text-green-700/);
  assert.match(code, /" ":\s*"text-muted-foreground"/);
  // monospace, wraps
  assert.match(code, /font-mono text-xs/);
  assert.match(code, /whitespace-pre-wrap break-words/);

  // everything else on the page stays (Round 3 §1: body headings keep
  // Lovable's own term)
  for (const text of ["Rules Harness added", "Show all", "Restore this version?", "waiting for analysis"]) {
    assert.ok(raw.includes(text), `instructions.tsx missing "${text}"`);
  }
  assert.ok(!code.includes("Skills"), "Skills UI must not live on the Instructions page");

  // no <details open>
  for (const tag of code.match(/<details[^>]*>/g) ?? []) assert.ok(!/\sopen\b/.test(tag));

  // only the knowledge/executor client helpers, never a raw fetch
  assert.match(code, /fetchKnowledge/);
  assert.match(code, /postKnowledge\(/);
  assert.match(code, /postExecutor\(/);
  assert.ok(!/\bfetch\(/.test(code), "instructions.tsx must not call fetch directly");
});

// ---- 3. /skills ----

test("skills.tsx: heading, read-only line, per-skill fields, history, empty state", () => {
  const raw = readApp(SKILLS_PAGE);
  const code = codeOnly(raw);

  assert.match(code, /<h1[^>]*>Skills<\/h1>/);
  assert.ok(raw.includes("Harness reads your workspace Skills; it does not write them yet."));
  assert.ok(
    raw.includes("Your workspace has no Skills yet. Harness will show them here as soon as it reads one."),
  );

  // per-skill: name, description, last changed, collapsed content, history when > 1
  assert.match(code, /skill\.name/);
  assert.match(code, /skill\.description/);
  assert.match(code, /Last changed \{formatDate\(/);
  assert.match(code, /skill\.content/);
  assert.match(code, /skill\.history\.length > 1/);
  assert.match(code, /h\.added/);
  assert.match(code, /h\.removed/);

  // loading / error / unavailable, mirroring the other pages
  assert.match(code, /Loading…/);
  assert.match(code, /role="alert"/);
  assert.match(code, /available === false/);

  // no <details open>
  for (const tag of code.match(/<details[^>]*>/g) ?? []) assert.ok(!/\sopen\b/.test(tag));

  // only the skills client helper, never a raw fetch
  assert.match(code, /skillsQueryOptions/);
  assert.ok(!/\bfetch\(/.test(code), "skills.tsx must not call fetch directly");
  assert.ok(
    !/fetchImprovements|postImprovementAction|fetchProjects\(|postProjects\(|fetchExecutor\(|fetchKnowledge/.test(code),
    "skills.tsx only uses the skills client helper",
  );
});

// ---- 4. /knowledge and /versions redirect to /instructions ----

test("knowledge.tsx and versions.tsx both redirect to /instructions", () => {
  for (const page of [KNOWLEDGE_PAGE, VERSIONS_PAGE]) {
    const code = codeOnly(readApp(page));
    assert.match(code, /throw redirect\(\{ to: "\/instructions", replace: true \}\)/);
    assert.ok(!/component:/.test(code), `${page} should be a pure redirect`);
  }
});

// ---- 5. Settings: AI analysis + Defaults for projects ----

test("local-settings.tsx: AI analysis and Defaults for projects, in the right order, honest copy", () => {
  const raw = readApp(LOCAL_SETTINGS);
  const code = codeOnly(raw);

  for (const text of [
    "AI analysis",
    "Defaults for projects",
    "Analysis is not switched on yet. Your key and choices are stored for when it is; nothing is sent to any provider today.",
    "Key saved, ends in",
  ]) {
    assert.ok(raw.includes(text), `local-settings.tsx missing "${text}"`);
  }
  assert.match(raw, /type="password"/);

  // four role rows
  for (const roleLabel of ["Classifier", "Miner", "Reviewer", "Proposer"]) {
    assert.ok(raw.includes(roleLabel), `local-settings.tsx missing role label "${roleLabel}"`);
  }

  // budget: 1-1000, spent this month from spent_usd
  assert.match(code, /Monthly budget \(USD, 1–1000\)/);
  assert.match(code, /min=\{1\}/);
  assert.match(code, /max=\{1000\}/);
  assert.match(code, /Spent this month: \$\{spentUsd\.toFixed\(2\)\}/);

  // posts
  assert.match(code, /action: "llm_settings"/);
  assert.match(code, /action: "llm_key"/);
  assert.match(code, /action: "llm_key_remove"/);
  assert.match(code, /action: "defaults"/);
  assert.match(code, /max_active_rules:\s*maxActiveRules/);

  // prefilled from llm.models
  assert.match(code, /llm\.models/);
  assert.match(code, /llmModels\[key\]\.provider/);
  assert.match(code, /llmModels\[key\]\.model/);

  // section order: Sync schedule, Knowledge limit, AI analysis,
  // Defaults for projects, Approval
  const order = ["Sync schedule", "Knowledge limit", "AI analysis", "Defaults for projects", "Approval"];
  let last = -1;
  for (const marker of order) {
    const at = raw.indexOf(`>${marker}<`);
    assert.ok(at > last, `expected section "${marker}" after the previous one`);
    last = at;
  }

  // API 400 errors surface as a toast (postExecutor throws -> onError -> toast.error)
  assert.match(code, /onError:.*toast\.error\(/s);

  // a key is never rendered as visible text or logged -- only ever bound as
  // a password-masked input's controlled value
  assert.ok(!/console\.log/.test(code));
  assert.ok(!/>\s*\{keyInput\}\s*</.test(raw), "the raw key input value is never rendered as text");

  for (const tag of code.match(/<details[^>]*>/g) ?? []) assert.ok(!/\sopen\b/.test(tag));

  // "classifier" is the one legitimate exception (a role label); the rest
  // of the internal-vocabulary ban still holds
  for (const word of ["checkpoint", "message_id", "provenance", "confidence"]) {
    assert.ok(!new RegExp(word, "i").test(code), `${word} leaks into local-settings.tsx`);
  }

  assert.ok(!/\bfetch\(/.test(code), "local-settings.tsx must not call fetch directly");
});

test("local-settings.tsx: 'credit' appears only in the schedule sentence; the budget label never mentions it", () => {
  const raw = readApp(LOCAL_SETTINGS);
  assert.equal(count(raw, "credit"), 1);
  assert.ok(!/Monthly budget[^<]*credit/i.test(raw));
});

// ---- 6. Projects: per-project settings ----

test("local-projects.tsx: expand control, max active rules, auto-write switch, project_settings post", () => {
  const raw = readApp(LOCAL_PROJECTS);
  const code = codeOnly(raw);

  assert.ok(raw.includes("Write approved changes automatically"));
  assert.match(code, /Max active rules/);
  assert.match(code, /use default \(\$\{defaultMaxActiveRules\}\)/);
  assert.match(code, /action: "project_settings"/);
  assert.match(code, /lovable_project_id: projectId/);
  assert.match(code, /max_active_rules:\s*maxActiveRules\.trim\(\) === "" \? null : Number\(maxActiveRules\)/);
  assert.match(code, /auto_write: autoWrite/);

  // uses `settings` from the projects GET
  assert.match(code, /p\.settings/);
  assert.match(code, /known\?\.settings/);
  assert.match(code, /ProjectSettings/);

  // expand control (chevron/"Settings" button), collapsed by default
  assert.match(code, /aria-expanded=\{expandedId === p\.id\}/);
  assert.match(code, /Settings/);

  for (const tag of code.match(/<details[^>]*>/g) ?? []) assert.ok(!/\sopen\b/.test(tag));
  assert.ok(!/\bfetch\(/.test(code), "local-projects.tsx must not call fetch directly");
});

test("local-projects.tsx: 'credit' still appears only in the one MCP sentence", () => {
  const raw = readApp(LOCAL_PROJECTS);
  assert.equal(count(raw, "credit"), 1);
});

// ---- 7. Add dialog: over_rules ----

test("improvement.tsx AddConfirm: over_rules disables confirm and shows the retire-a-rule alert", () => {
  const detail = codeOnly(readApp(DETAIL));
  const confirm = detail.slice(detail.indexOf("function AddConfirm"), detail.indexOf("function SkipConfirm"));

  assert.match(detail, /const overRules = preview\?\.over_rules === true;/);
  assert.match(confirm, /confirmDisabled=\{overCap \|\| overRules \|\| choice == null\}/);
  assert.match(confirm, /\{overRules \? \(/);
  assert.match(confirm, /role="alert"/);
  assert.match(confirm, /overRulesLine\(preview\.active_rules_count\)/);

  const raw = readApp(DETAIL);
  assert.match(
    raw,
    /return `This project already has \$\{activeRulesCount\} active rules\. Retire one on the Instructions page first\.`;/,
  );

  // cost wording stays within bounds even with the new alert
  assert.ok(count(detail, "Lovable credits") <= 2);
  assert.equal(count(detail, "Harness analysis"), 1);
});

// ---- 8. No <details open> anywhere in the touched pages ----

test("no <details open> anywhere in the Round 3 Task 3b pages", () => {
  for (const page of TOUCHED_PAGES) {
    const raw = readApp(page);
    for (const tag of codeOnly(raw).match(/<details[^>]*>/g) ?? []) {
      assert.ok(!/\sopen\b/.test(tag), `${page}: collapsed by default, got: ${tag}`);
    }
    assert.ok(!/<details open/.test(raw), `${page} has a literal <details open`);
  }
});

// ---- 9. Only the six harness routes are ever fetched ----

test("only the six local harness routes are fetched anywhere in the touched pages, and the client set is unchanged", () => {
  for (const page of [INSTRUCTIONS_PAGE, SKILLS_PAGE, LOCAL_SETTINGS, LOCAL_PROJECTS, DETAIL]) {
    const code = codeOnly(readApp(page));
    const targets = [...code.matchAll(/fetch\("([^"]+)"/g)].map((m) => m[1]);
    for (const t of targets) {
      assert.match(t!, /^\/api\/public\/harness\/(improvements|runtime|knowledge|executor|projects|skills)$/, `${page} fetches ${t}`);
    }
  }
  const client = codeOnly(readApp(CLIENT));
  const targets = new Set([...client.matchAll(/fetch\("([^"]+)"/g)].map((m) => m[1]));
  assert.deepEqual(
    [...targets].sort(),
    [
      "/api/public/harness/executor",
      "/api/public/harness/improvements",
      "/api/public/harness/knowledge",
      "/api/public/harness/projects",
      "/api/public/harness/runtime",
      "/api/public/harness/skills",
    ],
  );
});

// ---- 10. No internal vocabulary, no spec/Claude Code mentions ----

test("no internal vocabulary or spec/Claude Code mentions in the Round 3 Task 3b pages", () => {
  for (const page of [INSTRUCTIONS_PAGE, SKILLS_PAGE, LOCAL_PROJECTS, DETAIL]) {
    const raw = readApp(page);
    // DETAIL's Developer view is allowed internal vocabulary (same carve-out
    // as ux.test.ts's "no internal vocabulary" test); everything else on
    // every page here is fully user-facing.
    const start = raw.indexOf("developer-view:start");
    const end = raw.indexOf("developer-view:end");
    const userFacing = start > 0 && end > start ? raw.slice(0, start) + raw.slice(end) : raw;
    const code = codeOnly(userFacing);
    for (const word of ["checkpoint", "message_id", "provenance", "confidence", "classifier"]) {
      assert.ok(!new RegExp(word, "i").test(code), `${word} leaks into ${page}`);
    }
    assert.ok(!/\bspec\b/i.test(code), `${page} mentions "spec" outside a comment`);
    assert.ok(!/claude code/i.test(code), `${page} mentions Claude Code`);
  }
  // local-settings.tsx keeps the same ban minus "classifier" (a legitimate
  // AI-analysis role label there -- see the local-pages test file)
  const settingsCode = codeOnly(readApp(LOCAL_SETTINGS));
  for (const word of ["checkpoint", "message_id", "provenance", "confidence"]) {
    assert.ok(!new RegExp(word, "i").test(settingsCode), `${word} leaks into local-settings.tsx`);
  }
  assert.ok(!/\bspec\b/i.test(settingsCode));
  assert.ok(!/claude code/i.test(settingsCode));
});

// ---- 11. KnowledgePreview client type carries over_rules/active_rules_count ----

test("improvements-client.ts: KnowledgePreview carries active_rules_count and over_rules", () => {
  const client = codeOnly(readApp(CLIENT));
  const preview = client.slice(client.indexOf("export type KnowledgePreview"), client.indexOf("export type KnowledgeVersion"));
  assert.match(preview, /active_rules_count: number;/);
  assert.match(preview, /over_rules: boolean;/);
});
