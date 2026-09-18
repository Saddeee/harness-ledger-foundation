// Machine-readable capability manifest for Harness Ledger.
//
// This is the single source of truth for "what does Harness Ledger actually do, and how do we
// know". README and landing-page claims are generated from this list rather than written by
// hand, so a claim cannot outlive the evidence behind it. Keep entries honest: `status` and
// `verification` must reflect what is actually tested or actually observed live, not what is
// intended. See harness/test/capabilities.test.ts for the checks this file must satisfy, and
// `src/lib/capabilities-copy.ts` for the web app's copy of this same array (kept identical by a
// deep-equal test so the two cannot drift).

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
   * reference (e.g. "DECISIONS.md §D3", "docs/audit/replay.md"), or a short note about a live
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
    verification: "harness/test/executor-auth.test.ts; docs/HANDOFF.md",
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
    verification: "DECISIONS.md §D3",
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
      "Skill proposals are drafted and versioned locally; they are not published to Lovable yet.",
  },
  {
    id: "remote_skill_write",
    label: "Create or update a Skill in Lovable",
    status: "blocked",
    runtime: "local",
    verified_at: null,
    verification: "DECISIONS.md §D4",
    limitation:
      "Lovable's REST Skill endpoints are deprecated with no replacement, and a write through Lovable's MCP has not been tried; it needs one approved live write to verify.",
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
    verification: "docs/audit/setup-hosted-privacy.md",
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
