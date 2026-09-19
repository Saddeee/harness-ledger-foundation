// Typed mirror of harness/src/capabilities.ts for the web app.
//
// The web app (src/) cannot import from harness/src (a separate Node/SQLite package), so this
// file carries a literal copy of the same CAPABILITIES array. harness/test/capabilities.test.ts
// asserts this array deep-equals the harness one on every test run, so the two cannot silently
// drift -- if you change one, change the other in the same commit.
//
// No React, no imports -- dependency-free like src/lib/harness-ux.ts, so it can also be
// unit-tested from harness/test via tsx.

export type CapabilityStatus = "working" | "partial" | "planned" | "blocked";
export type CapabilityRuntime = "local" | "hosted" | "both";

export type Capability = {
  id: string;
  label: string;
  status: CapabilityStatus;
  runtime: CapabilityRuntime;
  /** ISO date (YYYY-MM-DD) the capability was last verified, or null if never verified. */
  verified_at: string | null;
  /**
   * A pointer to the evidence: a test file (e.g. "harness/test/executor.test.ts"), a doc
   * reference (a test file, or a short note about a live
   * observation, or a combination joined with "; ". Null if there is nothing to point to yet.
   */
  verification: string | null;
  /** One plain-words sentence describing what does not work yet. May be "". */
  limitation: string;
};

export const CAPABILITIES: readonly Capability[] = [
  {
    id: "lovable_local_connection",
    label: "Connect to Lovable (local runtime)",
    status: "working",
    runtime: "local",
    verified_at: "2026-09-15",
    verification: "harness/test/executor-auth.test.ts; live connection in use since 2026-09-11",
    limitation:
      "Works through the local runtime's own loopback sign-in; hosted third-party authorization does not work yet.",
  },
  {
    id: "sync",
    label: "Sync chats, Knowledge and Skills from Lovable",
    status: "working",
    runtime: "local",
    verified_at: "2026-09-18",
    verification: "harness/test/executor.test.ts",
    limitation: "",
  },
  {
    id: "analysis",
    label: "Analyse synced messages for corrections and rules",
    status: "working",
    runtime: "local",
    verified_at: "2026-09-18",
    verification:
      "harness/test/analysis-run.test.ts; harness/test/analysis-classify.test.ts; harness/test/analysis-context.test.ts",
    limitation:
      "Live model output for the newer destination and contradiction-kind fields has not been exercised against a real provider yet.",
  },
  {
    id: "knowledge_proposal",
    label: "Propose Knowledge or Skill instructions from a correction",
    status: "working",
    runtime: "local",
    verified_at: "2026-09-18",
    verification: "harness/test/analysis-propose.test.ts",
    limitation:
      "The proposal schema is unit-tested; real model output for a live proposal has not been exercised in this checkpoint.",
  },
  {
    id: "knowledge_write",
    label: "Write an accepted rule into Lovable Knowledge",
    status: "working",
    runtime: "local",
    verified_at: "2026-09-13",
    verification: "harness/test/executor.test.ts; live write, Round 7 (2026-09-13)",
    limitation: "",
  },
  {
    id: "knowledge_versioning",
    label: "Version every Knowledge change",
    status: "working",
    runtime: "local",
    verified_at: "2026-09-18",
    verification: "harness/test/knowledge.test.ts",
    limitation: "",
  },
  {
    id: "knowledge_restore",
    label: "Restore an earlier Knowledge version",
    status: "working",
    runtime: "local",
    verified_at: "2026-09-14",
    verification: "harness/test/knowledge.test.ts; live restore, 2026-09-14",
    limitation: "",
  },
  {
    id: "historical_replay",
    label: "Test a rule against a previous correction (historical replay)",
    status: "working",
    runtime: "local",
    verified_at: "2026-09-18",
    verification: "harness/test/experiments.test.ts; harness/test/replay-environment.test.ts",
    limitation:
      "The replay environment record is verified on backfilled historical runs and fake-server tests; no new live replay has been run since.",
  },
  {
    id: "paired_comparison",
    label: "Paired comparison (fresh control and treatment builds)",
    status: "planned",
    runtime: "local",
    verified_at: null,
    verification: null,
    limitation:
      "Not built yet: it needs a two-arm run design and two live Lovable builds to verify, which costs credits the owner has not approved spending.",
  },
  {
    id: "rule_observation",
    label: "Observe whether a live build followed an active rule",
    status: "working",
    runtime: "local",
    verified_at: "2026-09-18",
    verification: "harness/test/rule-health.test.ts",
    limitation:
      "Observed signals and the AI Judge's review are reported as separate lines; neither is treated as showing that the rule caused an outcome.",
  },
  {
    id: "local_skill_proposal",
    label: "Draft, edit and version a Skill proposal locally",
    status: "working",
    runtime: "local",
    verified_at: "2026-09-18",
    verification: "harness/test/skill-proposals.test.ts",
    limitation:
      "Skill proposals are drafted and versioned locally; publishing one to Lovable is the separate remote_skill_write capability below.",
  },
  {
    id: "remote_skill_write",
    label: "Create a new Skill in Lovable",
    status: "working",
    runtime: "local",
    verified_at: "2026-09-19",
    verification: "harness/test/skill-publish.test.ts",
    limitation:
      "Harness Ledger creates new workspace Skills only; it never updates or deletes a Skill, including ones it published. Verified with one live write on 2026-09-19.",
  },
  {
    id: "harness_ledger_mcp",
    label: "Harness Ledger MCP server",
    status: "working",
    runtime: "local",
    verified_at: "2026-09-18",
    verification: "harness/test/mcp-server.test.ts",
    limitation:
      "Exercised over an in-memory transport only; a real stdio client has not been tried.",
  },
  {
    id: "behavioral_verification",
    label: "Automatically verify a rule was followed in a live build",
    status: "planned",
    runtime: "local",
    verified_at: null,
    verification: null,
    limitation:
      "Not built yet: there is no automated check beyond the AI Judge's review of the build's reply.",
  },
  {
    id: "hosted_lovable_execution",
    label: "Run Harness Ledger as a hosted application",
    status: "blocked",
    runtime: "hosted",
    verified_at: null,
    verification: null,
    limitation:
      'Lovable\'s authorization server rejects the hosted OAuth client with "Client Not Found"; the operations exist but hosted sign-in does not work yet.',
  },
  {
    id: "reanalyse_history",
    label: "Reanalyse history with a scoped, estimated pass",
    status: "working",
    runtime: "local",
    verified_at: "2026-09-18",
    verification: "harness/test/analysis-reanalyse.test.ts",
    limitation: "Verified with fake model calls only; not yet exercised against a live provider.",
  },
  {
    id: "openai_compatibility",
    label: "Use an OpenAI-compatible model provider",
    status: "partial",
    runtime: "local",
    verified_at: null,
    verification: "harness/test/llm-openai-compat.test.ts",
    limitation: "Being added now; not yet verified end to end.",
  },
  {
    id: "setup_scripts",
    label: "One-command local setup",
    status: "working",
    runtime: "local",
    verified_at: "2026-09-18",
    verification: "harness/test/setup-scripts.test.ts",
    limitation: "",
  },
  {
    id: "onboarding",
    label: "Guided first-run onboarding",
    status: "partial",
    runtime: "local",
    verified_at: null,
    verification: "harness/test/ux-onboarding.test.ts",
    limitation: "Being built now; not yet verified end to end.",
  },
];

export function capabilitiesByStatus(status: CapabilityStatus): readonly Capability[] {
  return CAPABILITIES.filter((c) => c.status === status);
}

export function capabilityLabel(id: string): string | undefined {
  return CAPABILITIES.find((c) => c.id === id)?.label;
}
