// Copy for the public landing page (src/routes/index.tsx). Every sentence
// here describes what the local prototype verifiably does today; anything
// planned is under LIMITATIONS or marked "not yet". Pinned by
// harness/test/ux-landing.test.ts. No metrics, no testimonials, no invented
// results: the only numbers on the page are the step numbers.

export const HERO_TITLE = "Teach Lovable once. Keep the lesson.";
export const HERO_TEXT =
  "Harness Ledger turns your corrections into versioned Knowledge and Skills, tests them against real project history, and shows whether they still deserve to remain.";

export const HERO_ACTIONS = {
  how: "See how it works",
  run: "Run locally",
  source: "View source",
  mcp: "Use through MCP",
  preview: "Open hosted preview",
} as const;

export const SOURCE_URL = "https://github.com/Saddeee/harness-ledger-foundation";

export const STORY_TITLE = "How it works";
export const STORY_STEPS = [
  {
    title: "Correct Lovable",
    text: 'You chat with Lovable as usual. When you say "no, use kronor" or "keep the login page", that is a correction.',
  },
  {
    title: "Harness finds a reusable lesson",
    text: "Sync reads your chats, Knowledge and Skills on a schedule. Analysis, on your command, finds corrections worth keeping.",
  },
  {
    title: "Choose Knowledge or Skill",
    text: "Each suggestion recommends where the lesson belongs and why. You can change it.",
  },
  {
    title: "Review or edit the instruction",
    text: "The exact text is shown with the messages it came from. Edit the wording, approve, or skip.",
  },
  {
    title: "Test against a real previous request",
    text: "Optionally rebuild the original request in a temporary copy with the instruction added, next to the historical result.",
  },
  {
    title: "Add the instruction",
    text: "Knowledge is written inside a block Harness Ledger owns, read back, and versioned. Nothing outside the block is touched.",
  },
  {
    title: "Observe later builds",
    text: "Later relevant builds are checked for the same issue, and an AI review reads Lovable's replies. The two are reported separately.",
  },
  {
    title: "Revise, retire, or restore",
    text: "Every instruction can be reworded, moved, retired, or restored from any earlier version.",
  },
] as const;

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
  "Today Harness Ledger writes Knowledge to Lovable. Skills are read, versioned, proposed and edited locally; creating or changing a Skill in Lovable is not wired yet.";

export const EVIDENCE_TITLE = "Evidence, in three levels";
export const EVIDENCE_LEVELS = [
  {
    name: "Historical replay",
    status: "Available",
    text: "The original request is built once more in a copy of the project as it was just before that request, with the instruction added, and shown next to the historical result. One new Lovable build.",
  },
  {
    name: "Paired comparison",
    status: "Planned",
    text: "Two fresh builds from the same historical state: a control without the instruction and a treatment with it. Both run in today's Lovable, so the instruction is the intended difference.",
  },
  {
    name: "Repeated paired evidence",
    status: "Planned",
    text: "More than one paired comparison supporting the same instruction.",
  },
] as const;
export const EVIDENCE_CAVEAT =
  "None of these is proof. Every test shows what it could not control: Lovable's own project memory, workspace Knowledge, Skills and the builder version come from today, not from the time of the request. The replay page lists them every time.";

export const SAFETY_TITLE = "What keeps your project safe";
export const SAFETY_POINTS = [
  "Knowledge is written only inside a marked block; everything outside it is preserved byte for byte.",
  "A manual edit inside the block causes a conflict; it is never overwritten automatically.",
  "Skills you wrote yourself are never changed by Harness Ledger.",
  "Every write is versioned, read back, and can be undone or restored.",
  "Only projects you allow are read. Test prompts go to temporary copies, never to your project.",
  "Lovable credits and AI tokens each have a monthly budget; nothing is spent without a button that says so.",
  "Lovable tokens and provider keys stay in restricted local files, never in the database or logs.",
] as const;

export const ARCHITECTURE_TITLE = "How it runs";
export const ARCHITECTURE_CHAIN = [
  "Local Harness Ledger",
  "local product core",
  "Lovable MCP and API adapter",
  "your Lovable projects",
] as const;
export const ARCHITECTURE_MCP_LINE =
  "Lovable MCP lets Harness operate Lovable. Harness MCP lets your agent operate Harness.";
export const ARCHITECTURE_MCP_TEXT =
  "Harness MCP is an optional interface: your own agent can list suggestions, decide on them, start a replay, read test evidence, and restore Knowledge versions with exactly the permissions the web app enforces.";

export const HOSTED_TITLE = "About the hosted version";
export const HOSTED_TEXT =
  "The operational prototype runs locally today because local Lovable clients can complete the supported localhost authorization flow. The hosted Lovable deployment presents the product and preserves the hosted adapter for a future approved application authorization path.";

export const LIMITATIONS_TITLE = "Current limitations";
export const LIMITATIONS = [
  "Skills cannot yet be created or changed in Lovable from Harness Ledger; Skill proposals live locally with their versions.",
  "Paired comparison is not implemented; the available test is a historical replay.",
  "Behavioural checks (for example, that a login route still works) are not implemented; screenshots show visual results only.",
  "Historical context is reconstructed from Harness Ledger's own snapshots; Lovable's project memory, workspace Knowledge and Skills at the time cannot be restored.",
  "Hosted authorization is not available; the workflow runs locally.",
  "Setup is developer-oriented: Node.js, a terminal, and either the Claude Code CLI or an API key.",
] as const;

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
