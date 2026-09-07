export const SETTINGS_DEFAULTS: Record<string, unknown> = {
  monthly_credit_budget: 40,
  require_replay_approval: true,
  keep_forks: false,
  drift_check_every_n: 4,
  max_active_rules: 12,
  knowledge_char_cap: 9000,
  one_change_per_day: true,
  kill_switch: false,
  llm_provider: "lovable",
  llm_models: {
    classifier: "google/gemini-3.1-flash-lite",
    miner: "google/gemini-3.7-flash",
    reviewer: "google/gemini-3.7-flash",
    proposer: "google/gemini-3.7-flash",
  },
};

export const SETTINGS_KEYS = Object.keys(SETTINGS_DEFAULTS);
