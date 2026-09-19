// Copy for the public landing page (src/routes/index.tsx). Every sentence
// here describes what the local prototype verifiably does today; anything
// planned is under LIMITATIONS or marked so. Pinned by
// harness/test/ux-landing.test.ts and checked against the capability
// manifest (src/lib/capabilities-copy.ts) by harness/test/capabilities.test.ts.
// No metrics, no testimonials, no invented results, no images.

export const HERO_TITLE = "Teach Lovable once. Keep the lesson.";
export const HERO_TEXT =
  "Harness Ledger learns from the corrections you give Lovable, turns reusable lessons into Knowledge or Skills, and helps you decide whether those instructions should remain.";

export const HERO_ACTIONS = {
  open: "Open Harness Ledger",
  how: "See how it works",
  run: "Run locally",
  source: "View source",
  mcp: "Use through MCP",
} as const;

export const SOURCE_URL = "https://github.com/Saddeee/harness-ledger-foundation";

// 2. The five-step product loop.
export const LOOP_TITLE = "The loop";
export const LOOP_STEPS = [
  {
    title: "Correct Lovable",
    text: 'Chat as usual. "No, use kronor" or "keep the login page" is a correction.',
  },
  {
    title: "Harness Ledger finds the lesson",
    text: "Sync reads new chats, Knowledge and Skills. Analyse, when you press it, finds the corrections worth keeping.",
  },
  {
    title: "Review Knowledge or Skill",
    text: "Inbox contains everything that needs your attention. Each suggestion says where the lesson belongs and why; edit the wording or change the destination.",
  },
  {
    title: "Test if you want",
    text: "Rebuild the original request in a temporary copy with the instruction added, next to what happened before.",
  },
  {
    title: "Add to Lovable, then observe",
    text: "Knowledge is written in a block Harness Ledger owns, read back and versioned. Later builds are checked, and you can revise, retire or restore.",
  },
] as const;

// 3. Knowledge versus Skills.
export const PRIMITIVES_TITLE = "Knowledge and Skills";
export const PRIMITIVES = [
  {
    name: "Knowledge",
    text: "Short standing rules and project context. Always available to Lovable on every request.",
  },
  {
    name: "Skills",
    text: "Task-specific procedures and checklists. Used only when the task calls for them.",
  },
  {
    name: "Knowledge plus Skill",
    text: "A short reminder in Knowledge connected to a detailed workflow in a Skill.",
  },
] as const;
export const PRIMITIVES_STATUS =
  "Today Harness Ledger writes Knowledge to Lovable, and can publish an approved Skill proposal as a new workspace Skill; it never updates or deletes a Skill, including ones it published.";

// 4. Historical replay evidence.
export const EVIDENCE_TITLE = "Test a rule against a previous correction";
export const EVIDENCE_TEXT =
  "The original request is built once more in a copy of the project as it was just before that request, with the instruction added, and shown next to the historical result. You judge whether the correction would still be needed. Every replay is labelled a historical approximation and lists what it could not control: Lovable's own project memory, workspace Knowledge, Skills and the builder version come from today.";
export const EVIDENCE_LEVELS = [
  { name: "Historical replay", status: "Available" },
  { name: "Paired comparison", status: "Planned" },
  { name: "Repeated paired evidence", status: "Planned" },
] as const;
export const EVIDENCE_COST_LINE =
  "Creating project copies currently uses no Lovable builder credits. Running a Lovable build in a copy consumes normal builder credits.";

// 5. Versioning and rollback.
export const VERSIONING_TITLE = "Every change is a version";
export const VERSIONING_POINTS = [
  "Knowledge is written only inside a marked block; everything outside it is preserved byte for byte.",
  "A manual edit inside the block causes a conflict; it is never overwritten automatically.",
  "Every write is read back and kept as a version. Restore any of them from History.",
  "Skills you wrote yourself are never changed by Harness Ledger.",
] as const;

// 6. Ask me first versus Automatic.
export const MODES_TITLE = "Ask me first, or Automatic";
export const MODES_TEXT =
  "Both modes sync, analyse and recommend. Ask me first waits for approval before persistent or credit-spending actions. Automatic performs only the actions, projects and budgets the user has allowed.";
export const MODES_NOTE =
  "More capable models may improve automation, but autonomy is earned through observed reliability, not assumed from the model name.";

// 7. Local architecture today.
export const ARCHITECTURE_TITLE = "How it runs today";
export const ARCHITECTURE_CHAIN = [
  "Harness Ledger on your machine",
  "product core",
  "Lovable MCP and API adapter",
  "your Lovable projects",
] as const;
export const ARCHITECTURE_TEXT =
  "Synced data stays in a local SQLite file. During analysis, selected context goes only to the AI provider you configured. Lovable tokens and provider keys stay in restricted local files.";
export const HOSTED_TEXT =
  "The operational prototype currently runs locally because local Lovable clients can complete the supported sign-in flow. The hosted Lovable app presents the product and preserves the hosted adapter for an approved hosted authorization path.";

// 8. Harness Ledger MCP.
export const MCP_TITLE = "Use it through MCP";
export const MCP_LINE =
  "Lovable MCP lets Harness Ledger operate Lovable. Harness Ledger MCP lets your agent operate Harness Ledger.";
export const MCP_TEXT =
  "Your own agent can list suggestions, decide on them, review Skill proposals, start a replay, read test evidence and restore Knowledge versions, with exactly the permissions the app enforces.";

// 9. Current limitations.
export const LIMITATIONS_TITLE = "Current limitations";
export const LIMITATIONS = [
  "Publishing a Skill to Lovable only ever creates a new one; Harness Ledger never updates or deletes a Skill, including ones it published.",
  "Paired comparison (two fresh builds, one with and one without the instruction) is planned, not built.",
  "Behavioural checks (for example, that a login route still works) are planned; screenshots show visual results only.",
  "Historical context comes from Harness Ledger's own snapshots; Lovable's project memory, workspace Knowledge and Skills at the time cannot be restored.",
  "Hosted authorization is not available; the workflow runs locally, with a developer-oriented setup.",
] as const;

// 10. Run locally.
export const RUN_LOCALLY_TITLE = "Run it locally";
export const RUN_LOCALLY_TEXT =
  "Harness Ledger currently has a developer-oriented local setup. If Node.js and an AI provider are already configured, setup usually takes around ten minutes.";
export const RUN_LOCALLY_COMMANDS = [
  "git clone https://github.com/Saddeee/harness-ledger-foundation.git",
  "cd harness-ledger-foundation",
  "npm run setup",
  "npm run harness:start",
] as const;
export const README_URL = `${SOURCE_URL}#readme`;
export const MCP_DOC_URL = `${SOURCE_URL}#use-harness-ledger-through-mcp`;

// 11. View source.
export const SOURCE_TITLE = "View source";
export const SOURCE_TEXT =
  "Everything on this page is checked by tests against a capability manifest in the repository. No license has been chosen yet.";
