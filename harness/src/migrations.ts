// Explicit, ordered, additive schema migrations. Each runs at most once
// (tracked in schema_migrations) inside a transaction. Never destructive --
// no migration here may DROP or recreate a table with existing data.
export type Migration = { version: number; name: string; sql: string };

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "checkpoint_a_foundation",
    sql: `
      -- Permission list: which Lovable projects Claude Code may touch on Harness's behalf.
      -- Deliberately no MCP tool can INSERT into this table -- it is curated
      -- out-of-band (npm run seed) so an agent can never grant itself a new project.
      CREATE TABLE IF NOT EXISTS allowed_projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lovable_project_id TEXT NOT NULL UNIQUE,
        label TEXT,
        added_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Cached, redacted metadata about approved projects (never raw file contents).
      CREATE TABLE IF NOT EXISTS projects (
        lovable_project_id TEXT PRIMARY KEY,
        name TEXT,
        status TEXT,
        url TEXT,
        tech_stack TEXT,
        raw_json TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS test_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        note TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        ref TEXT,
        payload TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
  },
  {
    version: 2,
    name: "checkpoint_b_correction_pipeline",
    sql: `
      -- Every table below that represents imported/derived evidence or a
      -- synthesized record carries a provenance tag from this fixed set:
      --   lovable_mcp | git_history | build_log | spec | manual | llm_derived

      -- A point-in-time capture of a Lovable project's metadata (superset of
      -- the lightweight 'projects' cache -- this one is append-only history).
      CREATE TABLE IF NOT EXISTS project_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lovable_project_id TEXT NOT NULL REFERENCES allowed_projects(lovable_project_id),
        label TEXT,
        snapshot_json TEXT NOT NULL,
        provenance TEXT NOT NULL CHECK (provenance IN ('lovable_mcp','git_history','build_log','spec','manual','llm_derived')),
        source_ref TEXT,
        captured_at TEXT NOT NULL DEFAULT (datetime('now')),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_project_snapshots_project ON project_snapshots(lovable_project_id);

      -- A single piece of raw evidence: a chat message, a diff, an edit-history
      -- row, a build-log.md row, a SPEC.md excerpt, or a manually recorded quote.
      -- Idempotent per (project_id, kind, external_id) so re-mining is safe.
      CREATE TABLE IF NOT EXISTS history_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT REFERENCES allowed_projects(lovable_project_id),
        kind TEXT NOT NULL CHECK (kind IN ('message','diff','edit','build_log_row','spec_excerpt','manual_note')),
        external_id TEXT,
        role TEXT CHECK (role IS NULL OR role IN ('user','assistant','system','operator')),
        content TEXT NOT NULL,
        occurred_at TEXT,
        provenance TEXT NOT NULL CHECK (provenance IN ('lovable_mcp','git_history','build_log','spec','manual','llm_derived')),
        source_ref TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(project_id, kind, external_id)
      );
      CREATE INDEX IF NOT EXISTS idx_history_items_project ON history_items(project_id);

      CREATE TABLE IF NOT EXISTS task_episodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT REFERENCES allowed_projects(lovable_project_id),
        title TEXT NOT NULL,
        summary TEXT,
        status TEXT NOT NULL DEFAULT 'reconstructed' CHECK (status IN ('reconstructed','reviewed')),
        provenance TEXT NOT NULL CHECK (provenance IN ('lovable_mcp','git_history','build_log','spec','manual','llm_derived')),
        started_at TEXT,
        ended_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Many-to-many: which history_items support a given task_episode.
      CREATE TABLE IF NOT EXISTS task_episode_evidence (
        task_episode_id INTEGER NOT NULL REFERENCES task_episodes(id),
        history_item_id INTEGER NOT NULL REFERENCES history_items(id),
        PRIMARY KEY (task_episode_id, history_item_id)
      );

      CREATE TABLE IF NOT EXISTS correction_candidates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_episode_id INTEGER NOT NULL REFERENCES task_episodes(id),
        classification TEXT NOT NULL CHECK (classification IN (
          'defect_correction','constraint_restatement','missing_requirement',
          'preference_revision','scope_extension','new_task','question','approval','other'
        )),
        is_correction INTEGER NOT NULL CHECK (is_correction IN (0,1)),
        reusable INTEGER CHECK (reusable IN (0,1)),
        proposed_scope TEXT CHECK (proposed_scope IN ('project','workspace','one_time')),
        summary TEXT NOT NULL,
        confidence REAL CHECK (confidence >= 0 AND confidence <= 1),
        evidence_reason TEXT,
        reviewed INTEGER NOT NULL DEFAULT 0 CHECK (reviewed IN (0,1)),
        reviewed_at TEXT,
        excluded_from_learning INTEGER NOT NULL DEFAULT 0 CHECK (excluded_from_learning IN (0,1)),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS correction_candidate_evidence (
        correction_candidate_id INTEGER NOT NULL REFERENCES correction_candidates(id),
        history_item_id INTEGER NOT NULL REFERENCES history_items(id),
        PRIMARY KEY (correction_candidate_id, history_item_id)
      );

      -- Audit trail of AI-authored decisions (classification etc.): who/what
      -- produced a structured output, and whether a human reviewed it.
      CREATE TABLE IF NOT EXISTS agent_actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor TEXT NOT NULL CHECK (actor IN ('claude','human','system')),
        action TEXT NOT NULL,
        target_table TEXT NOT NULL,
        target_id INTEGER NOT NULL,
        provider TEXT,
        model TEXT,
        role TEXT,
        structured_output TEXT,
        human_reviewed INTEGER NOT NULL DEFAULT 0 CHECK (human_reviewed IN (0,1)),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_agent_actions_target ON agent_actions(target_table, target_id);

      CREATE TABLE IF NOT EXISTS learnings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        correction_candidate_id INTEGER NOT NULL REFERENCES correction_candidates(id),
        observed_problem TEXT NOT NULL,
        desired_behavior TEXT NOT NULL,
        reuse_rationale TEXT NOT NULL,
        proposed_scope TEXT NOT NULL CHECK (proposed_scope IN ('project','workspace')),
        applicability TEXT,
        confidence REAL CHECK (confidence >= 0 AND confidence <= 1),
        overlap_notes TEXT,
        provenance TEXT NOT NULL CHECK (provenance IN ('lovable_mcp','git_history','build_log','spec','manual','llm_derived')),
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        learning_id INTEGER NOT NULL REFERENCES learnings(id),
        correction_candidate_id INTEGER NOT NULL REFERENCES correction_candidates(id),
        instruction TEXT NOT NULL,
        scope TEXT NOT NULL CHECK (scope IN ('project','workspace')),
        applies_when TEXT NOT NULL,
        predicted_failure TEXT NOT NULL,
        ownership TEXT NOT NULL CHECK (ownership IN ('user','harness')),
        state TEXT NOT NULL DEFAULT 'proposed' CHECK (state IN (
          'proposed','approved','testing','supported','active','questioned',
          'disabled','retired','rolled_back','rejected'
        )),
        evidence_level TEXT NOT NULL DEFAULT 'proposed' CHECK (evidence_level IN (
          'proposed','human_grounded','verifiable','historical_support',
          'controlled_support','repeated_controlled_support','field_supported'
        )),
        overlap_notes TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS rule_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rule_id INTEGER NOT NULL REFERENCES rules(id),
        previous_instruction TEXT NOT NULL,
        previous_state TEXT NOT NULL,
        new_instruction TEXT NOT NULL,
        new_state TEXT NOT NULL,
        reason TEXT,
        actor TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_rule_revisions_rule ON rule_revisions(rule_id);
    `,
  },
  {
    version: 3,
    name: "checkpoint_c_verification_and_experiments",
    sql: `
      -- A reusable check definition. Deliberately no arbitrary-shell-command
      -- verifier type exists -- 'structural' inspects file/diff text for
      -- known patterns (in code, not a general command runner), 'diff_pattern'
      -- matches a diff against a declared pattern, 'ai_rubric' asks an LLM a
      -- fixed set of questions, 'human_only' has no automated check at all.
      CREATE TABLE IF NOT EXISTS verification_definitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope TEXT NOT NULL CHECK (scope IN ('project','workspace')),
        project_id TEXT REFERENCES allowed_projects(lovable_project_id),
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        verifier_type TEXT NOT NULL CHECK (verifier_type IN ('structural','diff_pattern','ai_rubric','human_only')),
        configuration TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('lovable_mcp','git_history','build_log','spec','manual','llm_derived')),
        ownership TEXT NOT NULL CHECK (ownership IN ('user','harness')),
        confidence REAL CHECK (confidence >= 0 AND confidence <= 1),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK ((scope = 'project' AND project_id IS NOT NULL) OR (scope = 'workspace' AND project_id IS NULL))
      );

      CREATE TABLE IF NOT EXISTS rule_verification_links (
        rule_id INTEGER NOT NULL REFERENCES rules(id),
        verification_definition_id INTEGER NOT NULL REFERENCES verification_definitions(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (rule_id, verification_definition_id)
      );

      CREATE TABLE IF NOT EXISTS verification_plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rule_id INTEGER NOT NULL REFERENCES rules(id),
        failure_signature TEXT NOT NULL,
        failure_condition TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- One row per verifier attached to a plan, carrying that verifier's own
      -- run result -- a plan can combine e.g. one structural + one ai_rubric
      -- item, each independently passed/failed/unclear/not_run.
      CREATE TABLE IF NOT EXISTS verification_plan_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        verification_plan_id INTEGER NOT NULL REFERENCES verification_plans(id),
        verification_definition_id INTEGER NOT NULL REFERENCES verification_definitions(id),
        status TEXT NOT NULL DEFAULT 'not_run' CHECK (status IN ('passed','failed','unclear','not_run')),
        evidence TEXT,
        evidence_type TEXT CHECK (evidence_type IS NULL OR evidence_type IN (
          'structural_scan','diff_pattern_match','ai_rubric_response','human_note'
        )),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_verification_plan_items_plan ON verification_plan_items(verification_plan_id);

      -- A proposed (never auto-executed) experiment. status stays 'proposed'
      -- until a human explicitly moves it -- no tool in this checkpoint can
      -- execute one.
      CREATE TABLE IF NOT EXISTS experiment_plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rule_id INTEGER NOT NULL REFERENCES rules(id),
        source_project_id TEXT NOT NULL REFERENCES allowed_projects(lovable_project_id),
        task_episode_id INTEGER REFERENCES task_episodes(id),
        experiment_type TEXT NOT NULL CHECK (experiment_type IN ('treatment_only','paired_control_treatment','ablation')),
        starting_state_quality TEXT NOT NULL CHECK (starting_state_quality IN ('controlled_equivalent','approximate','historical_only','blocked')),
        control_configuration TEXT NOT NULL,
        treatment_configuration TEXT NOT NULL,
        exact_prompt TEXT NOT NULL,
        protected_checks TEXT NOT NULL,
        estimated_credits REAL NOT NULL,
        max_permitted_credits REAL NOT NULL,
        resource_strategy TEXT NOT NULL,
        cleanup_requirements TEXT NOT NULL,
        risks TEXT NOT NULL,
        success_conditions TEXT NOT NULL,
        inconclusive_conditions TEXT NOT NULL,
        stop_conditions TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','rejected')),
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS experiment_plan_verification_links (
        experiment_plan_id INTEGER NOT NULL REFERENCES experiment_plans(id),
        verification_definition_id INTEGER NOT NULL REFERENCES verification_definitions(id),
        PRIMARY KEY (experiment_plan_id, verification_definition_id)
      );

      -- safe_to_delete defaults false and NOTHING in this checkpoint's tools
      -- may set it true implicitly (e.g. merely because a row was inserted
      -- this session) -- see update_experiment_resource_status in adapter.ts.
      CREATE TABLE IF NOT EXISTS experiment_resources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        experiment_plan_id INTEGER NOT NULL REFERENCES experiment_plans(id),
        lovable_resource_id TEXT,
        resource_type TEXT NOT NULL CHECK (resource_type IN ('remix_project','variant','skill','other')),
        experiment_arm TEXT NOT NULL CHECK (experiment_arm IN ('control','treatment','ablation')),
        source_project_id TEXT NOT NULL REFERENCES allowed_projects(lovable_project_id),
        safe_to_modify INTEGER NOT NULL DEFAULT 0 CHECK (safe_to_modify IN (0,1)),
        safe_to_delete INTEGER NOT NULL DEFAULT 0 CHECK (safe_to_delete IN (0,1)),
        creation_status TEXT NOT NULL DEFAULT 'planned' CHECK (creation_status IN ('planned','creating','created','failed')),
        cleanup_status TEXT NOT NULL DEFAULT 'not_required' CHECK (cleanup_status IN ('not_required','pending','cleaned','failed')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        cleaned_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_experiment_resources_plan ON experiment_resources(experiment_plan_id);
    `,
  },
  {
    version: 4,
    name: "checkpoint_d_knowledge_versioning",
    sql: `
      -- Workspace a project belongs to (needed to address workspace Knowledge).
      ALTER TABLE projects ADD COLUMN workspace_id TEXT;

      -- A verbatim copy of Lovable Knowledge as read at a point in time. Every
      -- preview and every pending write is composed from one of these, so the
      -- executor can detect that Lovable changed underneath us (sha256 check)
      -- before it writes anything.
      CREATE TABLE IF NOT EXISTS knowledge_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target TEXT NOT NULL CHECK (target IN ('project','workspace')),
        project_id TEXT REFERENCES allowed_projects(lovable_project_id),
        workspace_id TEXT,
        content TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
        fetched_by TEXT NOT NULL,
        CHECK ((target = 'project' AND project_id IS NOT NULL) OR (target = 'workspace' AND workspace_id IS NOT NULL))
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_snapshots_target ON knowledge_snapshots(target, project_id, workspace_id);

      -- Append-only history of every Knowledge write Harness intends or made.
      -- A row starts 'pending' (approved in the UI, not yet executed); the
      -- executor moves it to 'written' only after a read-back hash matches,
      -- 'stale' if Lovable's live content no longer matches the snapshot the
      -- write was composed from, or 'failed'. A restore is a NEW row that
      -- points at the version it restores -- history is never rewritten.
      CREATE TABLE IF NOT EXISTS knowledge_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rule_id INTEGER REFERENCES rules(id),
        target TEXT NOT NULL CHECK (target IN ('project','workspace')),
        project_id TEXT REFERENCES allowed_projects(lovable_project_id),
        workspace_id TEXT,
        previous_content TEXT NOT NULL,
        new_content TEXT NOT NULL,
        previous_sha256 TEXT NOT NULL,
        new_sha256 TEXT NOT NULL,
        rule_ids_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','written','stale','failed')),
        actor TEXT NOT NULL,
        reason TEXT,
        restored_from_version_id INTEGER REFERENCES knowledge_versions(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        written_at TEXT,
        verified_at TEXT,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_versions_rule ON knowledge_versions(rule_id);
      CREATE INDEX IF NOT EXISTS idx_knowledge_versions_status ON knowledge_versions(status);
    `,
  },
  {
    version: 5,
    name: "checkpoint_e_executor_settings",
    sql: `
      -- Key/value settings for the executor and knowledge composition (sync
      -- cadence, the local sync window, the Knowledge character cap, and
      -- whether a write needs human approval before the executor applies
      -- it). Missing keys fall back to SETTING_DEFAULTS in store.ts.
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')));

      -- A verbatim copy of a Lovable Skill as read at a point in time,
      -- mirroring knowledge_snapshots' append-only, sha256-deduped shape.
      CREATE TABLE IF NOT EXISTS skill_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT, content TEXT NOT NULL, sha256 TEXT NOT NULL, updated_at_remote TEXT, fetched_at TEXT NOT NULL DEFAULT (datetime('now')), fetched_by TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_skill_snapshots_ws_name ON skill_snapshots(workspace_id, name, id);

      -- One row per executor run (scheduled, a manual "sync now", or a
      -- one-off). finished_at stays NULL while the run is in progress.
      CREATE TABLE IF NOT EXISTS sync_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL CHECK (kind IN ('scheduled','manual','once')), started_at TEXT NOT NULL DEFAULT (datetime('now')), finished_at TEXT, ok INTEGER, error TEXT, counts_json TEXT NOT NULL DEFAULT '{}');

      -- A "sync now" request from the UI, coalesced: only one 'requested'
      -- row exists at a time until a run takes it.
      CREATE TABLE IF NOT EXISTS sync_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, requested_at TEXT NOT NULL DEFAULT (datetime('now')), status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','running','done')), run_id INTEGER REFERENCES sync_runs(id));
    `,
  },
  {
    version: 6,
    name: "checkpoint_e_sync_cursors",
    sql: `
      -- Where a history sync ran out of its per-pass page budget. The next
      -- pass resumes paging into older history from this cursor, and the row
      -- is deleted once that project's history is fully read, so a project
      -- with more messages than one pass can carry is never silently
      -- truncated.
      CREATE TABLE IF NOT EXISTS sync_cursors (project_id TEXT PRIMARY KEY, cursor TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    `,
  },
  {
    version: 7,
    name: "checkpoint_g_cancelled_writes",
    sql: `
      -- Cancelling a staged Knowledge write (a decision changed -- skip,
      -- reopen, or switching to test-first -- before the executor got to
      -- it) is not a failure and must not read as one. SQLite cannot ALTER
      -- a CHECK constraint, so this rebuilds knowledge_versions with the
      -- same columns and a status CHECK widened to include 'cancelled',
      -- preserving every existing row.
      --
      -- No other table has a foreign key into knowledge_versions -- only
      -- its own self-referencing restored_from_version_id -- so this is
      -- safe without disabling foreign key enforcement (verified: DROP
      -- TABLE does not re-validate a table's own self-reference, and a
      -- single INSERT...SELECT checks its self-referencing FK once at the
      -- end of the statement, by which every row is already present). The
      -- PRAGMA bracket below follows SQLite's own recommended recipe for
      -- this kind of rebuild regardless; db.ts runs each migration inside
      -- a transaction, where toggling foreign_keys is a documented no-op,
      -- so today these two statements are inert -- kept for defense in
      -- depth / forward-compatibility if that ever changes.
      PRAGMA foreign_keys=OFF;

      CREATE TABLE knowledge_versions_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rule_id INTEGER REFERENCES rules(id),
        target TEXT NOT NULL CHECK (target IN ('project','workspace')),
        project_id TEXT REFERENCES allowed_projects(lovable_project_id),
        workspace_id TEXT,
        previous_content TEXT NOT NULL,
        new_content TEXT NOT NULL,
        previous_sha256 TEXT NOT NULL,
        new_sha256 TEXT NOT NULL,
        rule_ids_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','written','stale','failed','cancelled')),
        actor TEXT NOT NULL,
        reason TEXT,
        restored_from_version_id INTEGER REFERENCES knowledge_versions_new(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        written_at TEXT,
        verified_at TEXT,
        error TEXT
      );
      INSERT INTO knowledge_versions_new SELECT * FROM knowledge_versions ORDER BY id;
      DROP TABLE knowledge_versions;
      ALTER TABLE knowledge_versions_new RENAME TO knowledge_versions;
      CREATE INDEX IF NOT EXISTS idx_knowledge_versions_rule ON knowledge_versions(rule_id);
      CREATE INDEX IF NOT EXISTS idx_knowledge_versions_status ON knowledge_versions(status);

      PRAGMA foreign_keys=ON;
    `,
  },
  {
    version: 8,
    name: "round3_settings_and_llm",
    sql: `
      -- Per-project overrides of the two global defaults (settings.max_active_rules
      -- and "auto-write on"). No row means "use the defaults" -- see
      -- getProjectSettings/effectiveMaxActiveRules in store.ts. No REFERENCES to
      -- allowed_projects, matching sync_cursors' shape, so disallowing a project
      -- never needs the foreign_keys pragma dance to clean this table up.
      CREATE TABLE IF NOT EXISTS project_settings (
        project_id TEXT PRIMARY KEY,
        max_active_rules INTEGER,
        auto_write INTEGER NOT NULL DEFAULT 1 CHECK (auto_write IN (0,1)),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Empty until AI analysis actually ships (see spec section 8, "still out
      -- of scope"): this only gives the Settings page's "Spent this month"
      -- line something real to sum once it does.
      CREATE TABLE IF NOT EXISTS llm_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_llm_calls_created_at ON llm_calls(created_at);
    `,
  },
  {
    version: 9,
    name: "round4_analysis_and_health",
    sql: `
      -- The analysis pipeline (Round 4 Task A0) needs a per-call token
      -- estimate (the pre-call budget-guard number, kept alongside the
      -- post-call real tokens_in/tokens_out for audit) and, once analysis
      -- runs exist (Task A3), which run produced a given call.
      ALTER TABLE llm_calls ADD COLUMN estimated_tokens INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE llm_calls ADD COLUMN run_id INTEGER;

      -- One row per classified user history_item (Task A1): the pipeline's
      -- own classification, distinct from correction_candidates.classification
      -- (a human-reviewed judgment on a whole task episode, not a single
      -- message) -- see the round-4 spec/exploration for why these are two
      -- different enums answering two different questions.
      CREATE TABLE IF NOT EXISTS message_classifications (
        history_item_id INTEGER PRIMARY KEY REFERENCES history_items(id),
        classification TEXT NOT NULL CHECK (classification IN ('new_task','correction','question','approval','other')),
        tags_json TEXT NOT NULL DEFAULT '[]',
        summary TEXT NOT NULL DEFAULT '',
        run_id INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- "Analyse now" mirrors sync_requests/sync_runs exactly (Task A3):
      -- analysis_runs first (the table analysis_requests.run_id points into),
      -- then the coalesced request row.
      CREATE TABLE IF NOT EXISTS analysis_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL DEFAULT 'manual',
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        finished_at TEXT,
        ok INTEGER,
        error TEXT,
        counts_json TEXT NOT NULL DEFAULT '{}',
        tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL
      );
      CREATE TABLE IF NOT EXISTS analysis_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        requested_at TEXT NOT NULL DEFAULT (datetime('now')),
        status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','running','done')),
        run_id INTEGER
      );

      -- Per-rule outcome tracking (Task C1/4b): applicable/helped/hurt counts
      -- and the retirement signal, recomputed after every sync/analysis run.
      CREATE TABLE IF NOT EXISTS rule_health (
        rule_id INTEGER PRIMARY KEY REFERENCES rules(id),
        applicable_tasks INTEGER NOT NULL DEFAULT 0,
        helped INTEGER NOT NULL DEFAULT 0,
        hurt INTEGER NOT NULL DEFAULT 0,
        last_applicable_at TEXT,
        contradicted_by_rule_id INTEGER,
        unused_since TEXT,
        status TEXT NOT NULL DEFAULT 'healthy' CHECK (status IN ('healthy','watch','retire_suggested','snoozed')),
        snoozed_until TEXT,
        computed_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_rule_health_status ON rule_health(status);

      -- The miner (Task A2) and health computation (Task C1) tag rules by
      -- scope so applicability can be checked without an LLM call; a rule
      -- with no more specific tag applies everywhere ("general").
      ALTER TABLE rules ADD COLUMN scope_tags_json TEXT NOT NULL DEFAULT '["general"]';

      -- Retirement proposals (Task C2): a human-reviewed Inbox item kind,
      -- separate from correction_candidates because it proposes retiring an
      -- existing rule rather than adding a new one.
      CREATE TABLE IF NOT EXISTS retire_proposals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rule_id INTEGER NOT NULL REFERENCES rules(id),
        reason TEXT NOT NULL CHECK (reason IN ('hurt','contradiction','unused')),
        evidence_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','retired','kept')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        decided_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_retire_proposals_status ON retire_proposals(status);

      -- Note: task_episode_evidence (checkpoint B, v2) already carries
      -- history_item_id -- no separate task-episode <-> history-item link
      -- table is needed for segmentation (Task A1) to reuse.

      -- Budget moves from a USD estimate to a token count (a Claude Code
      -- subscription has no per-call price) -- see store.ts's SettingKey.
      -- llm_monthly_token_budget / rule_unused_after_days are added to
      -- SETTING_DEFAULTS in application code; missing settings rows already
      -- fall back to SETTING_DEFAULTS there, so no INSERT is needed here,
      -- only removing the row this replaces.
      DELETE FROM settings WHERE key = 'llm_monthly_budget_usd';
    `,
  },
  {
    version: 10,
    name: "round4_health_baseline",
    sql: `
      -- Round 4 fix wave item 4: "Re-add" (Task C2, improvements.ts) resets
      -- a rule's health window instead of leaving stale pre-retirement
      -- hurt/contradiction signal in force forever. baseline_at is null
      -- until the rule is ever re-added; recomputeRuleHealth
      -- (harness/src/analysis/health.ts) then uses
      -- max(first_written_at, baseline_at) as the episode window start.
      ALTER TABLE rule_health ADD COLUMN baseline_at TEXT;
    `,
  },
  {
    version: 11,
    name: "round5_feedback_evidence",
    sql: `
      -- Round 5 Task 1: a correction_candidate's decision can now carry why
      -- it was skipped (spec §4b) and who decided it (a human, or the
      -- decision_mode='automatic' path store.ts's setSettings validates
      -- below) -- both null on every pre-existing row (undecided/human by
      -- default, matching current behavior exactly).
      ALTER TABLE correction_candidates ADD COLUMN skip_reason TEXT CHECK (skip_reason IN ('not_useful','wrong_wording','one_time','already_covered'));
      ALTER TABLE correction_candidates ADD COLUMN decided_by TEXT;   -- 'user' | 'automatic'; null = undecided

      -- A human's (or the judge role's) verdict on a rule as a whole --
      -- "did this actually help" -- independent of per-episode adherence
      -- below. Many rows per rule; the latest one is what the Instructions
      -- page shows.
      CREATE TABLE IF NOT EXISTS rule_verdicts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rule_id INTEGER NOT NULL REFERENCES rules(id),
        verdict TEXT NOT NULL CHECK (verdict IN ('helped','did_not_help','not_sure')),
        note TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_rule_verdicts_rule ON rule_verdicts(rule_id, id);

      -- Per-episode adherence check: did a given task_episode actually
      -- follow this rule. One row per (rule, episode) -- the unique
      -- constraint makes re-judging the same pair a no-op insert, so a
      -- re-run of the judge role never double-counts adherenceCounts.
      CREATE TABLE IF NOT EXISTS rule_adherence (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rule_id INTEGER NOT NULL REFERENCES rules(id),
        task_episode_id INTEGER NOT NULL REFERENCES task_episodes(id),
        verdict TEXT NOT NULL CHECK (verdict IN ('followed','broke','not_applicable')),
        quote TEXT,
        llm_call_id INTEGER,
        run_id INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (rule_id, task_episode_id)
      );
      -- llm_models: rename the stored role key miner -> rule_writer and add judge, once.
      UPDATE settings SET value = replace(value, '"miner":', '"rule_writer":') WHERE key = 'llm_models' AND value LIKE '%"miner":%';
    `,
  },
  {
    version: 12,
    name: "round6_experiments",
    sql: `
      -- Round 6 Task 1: the paired-test experiment (spec: copy the user's
      -- project at the message that opened the corrected episode, replay the
      -- rule against the copy, let the user judge the copy against what
      -- Lovable actually did). One row per attempt; status walks
      -- queued -> copying -> building -> judging -> judged, or fails/
      -- cancels at any point. copy_* / original_* columns are filled in as
      -- each stage completes -- most are NULL until then. copy_deleted tracks
      -- whether the copy project itself (a real, credit-bearing Lovable
      -- project) has been cleaned up yet; listUndeletedCopies (store.ts)
      -- is the executor's own reminder to sweep these, independent of
      -- keep_test_copies (the setting below), which only controls whether
      -- cleanup happens automatically.
      CREATE TABLE IF NOT EXISTS experiment_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rule_id INTEGER NOT NULL REFERENCES rules(id),
        correction_candidate_id INTEGER NOT NULL REFERENCES correction_candidates(id),
        task_episode_id INTEGER NOT NULL REFERENCES task_episodes(id),
        source_project_id TEXT NOT NULL,
        copy_project_id TEXT,
        request_message_external_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','copying','building','judging','judged','failed','cancelled')),
        stage_note TEXT,
        copy_message_id TEXT, copy_thread_id TEXT, copy_commit_sha TEXT,
        copy_summary TEXT, copy_reply TEXT, copy_diff_json TEXT,
        original_commit_sha TEXT, original_diff_json TEXT,
        cost_credits REAL,
        copy_deleted INTEGER NOT NULL DEFAULT 0 CHECK (copy_deleted IN (0,1)),
        copy_cleanup_note TEXT,
        edits_since_episode INTEGER,
        score REAL, verdicts_json TEXT,
        error TEXT,
        started_at TEXT NOT NULL DEFAULT (datetime('now')), heartbeat_at TEXT, finished_at TEXT, judged_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_experiment_runs_status ON experiment_runs(status);

      -- Every credited Lovable call an experiment makes (chat only -- reads
      -- are free) gets its own row here, not just a running total on
      -- experiment_runs, so creditsThisMonth (store.ts) can bound spend
      -- across every run in the current calendar month regardless of how
      -- many runs contributed, and a run that spans a month boundary still
      -- attributes each call to the month it actually happened in.
      CREATE TABLE IF NOT EXISTS credit_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES experiment_runs(id),
        cost_credits REAL NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- rule_verdicts (v11, Round 5 Task 1) kept every verdict as its own
      -- row with no way to tell "the current one" from history other than
      -- "highest id" -- fine for a single reader, but recordRuleVerdict's
      -- new upsert semantics (store.ts) need exactly one row per rule
      -- flagged current so a second click of the same verdict can compare
      -- against it without a MAX(id) scan. superseded = 0 is current;
      -- superseded = 1 is history, kept forever (never deleted).
      ALTER TABLE rule_verdicts ADD COLUMN superseded INTEGER NOT NULL DEFAULT 0 CHECK (superseded IN (0,1));

      -- Backfill: every existing rule_verdicts row defaulted to superseded=0
      -- above. A rule with more than one row would now violate the partial
      -- unique index below, so mark every row except the newest (highest id)
      -- per rule_id as superseded=1 first.
      UPDATE rule_verdicts SET superseded = 1
      WHERE id NOT IN (SELECT MAX(id) FROM rule_verdicts GROUP BY rule_id);

      -- rule_verdicts: one current row per rule (history kept only on change)
      CREATE UNIQUE INDEX IF NOT EXISTS idx_rule_verdicts_current ON rule_verdicts(rule_id) WHERE superseded = 0;
    `,
  },
  {
    version: 13,
    name: "round6c_experiment_feedback",
    sql: `
      -- Round 6c part B: the Tests page's own feedback box -- a free-text
      -- note the owner can leave on any paired-test run, any status, from
      -- either the Tests page or the judging screen. Null on every existing
      -- row (nobody has left a note yet); feedback_at is stamped whenever a
      -- note is saved or cleared (store.ts's setExperimentFeedback), never
      -- touched by the runner's own stage writes (updateExperimentRun).
      ALTER TABLE experiment_runs ADD COLUMN feedback TEXT;
      ALTER TABLE experiment_runs ADD COLUMN feedback_at TEXT;
    `,
  },
  {
    version: 14,
    name: "round7_per_correction_mining_and_visible_builds",
    sql: `
      -- One suggestion per correction: every correction message the Rule
      -- writer has already been asked about, and what came of it, so an
      -- episode with a second, uncovered correction is mined again while a
      -- "no rule here" answer is never re-asked on every Analyse now.
      CREATE TABLE IF NOT EXISTS correction_mining (
        history_item_id INTEGER PRIMARY KEY REFERENCES history_items(id),
        outcome TEXT NOT NULL CHECK (outcome IN ('proposed','no_proposal','duplicate','skipped_repeat')),
        correction_candidate_id INTEGER REFERENCES correction_candidates(id),
        run_id INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Proof you can look at: both builds are real Lovable projects. The
      -- "with the rule" copy already exists (copy_project_id); a second,
      -- free copy of the project right after the original request shows the
      -- original build. Screenshots, the original build's own summary, and
      -- the corrections as they were judged (so a later change to what a
      -- rule's corrections are never re-labels an old verdict).
      ALTER TABLE experiment_runs ADD COLUMN show_original INTEGER NOT NULL DEFAULT 0 CHECK (show_original IN (0,1));
      ALTER TABLE experiment_runs ADD COLUMN original_copy_project_id TEXT;
      ALTER TABLE experiment_runs ADD COLUMN original_copy_deleted INTEGER NOT NULL DEFAULT 0 CHECK (original_copy_deleted IN (0,1));
      ALTER TABLE experiment_runs ADD COLUMN original_copy_error TEXT;
      ALTER TABLE experiment_runs ADD COLUMN original_summary TEXT;
      ALTER TABLE experiment_runs ADD COLUMN copy_screenshot_url TEXT;
      ALTER TABLE experiment_runs ADD COLUMN original_screenshot_url TEXT;
      ALTER TABLE experiment_runs ADD COLUMN judged_corrections_json TEXT;
    `,
  },
  {
    version: 15,
    name: "round7_skill_deletions",
    sql: `
      -- A skill deleted in Lovable used to stay "current" forever: the sync
      -- only recorded skills it saw. A deletion is now its own snapshot row
      -- (content empty, deleted = 1), so the Skills page drops it and
      -- History shows when it went away.
      ALTER TABLE skill_snapshots ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0,1));
    `,
  },
  {
    version: 16,
    name: "round7_retire_changed_mind",
    sql: `
      -- A new retirement reason: you asked Lovable for the opposite of a
      -- live rule (evidence = that message's history_item id). SQLite can't
      -- alter a CHECK constraint, so the table is rebuilt with every row kept.
      CREATE TABLE retire_proposals_v16 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rule_id INTEGER NOT NULL REFERENCES rules(id),
        reason TEXT NOT NULL CHECK (reason IN ('hurt','contradiction','unused','changed_mind')),
        evidence_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','retired','kept')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        decided_at TEXT
      );
      INSERT INTO retire_proposals_v16 (id, rule_id, reason, evidence_json, status, created_at, decided_at)
        SELECT id, rule_id, reason, evidence_json, status, created_at, decided_at FROM retire_proposals;
      DROP TABLE retire_proposals;
      ALTER TABLE retire_proposals_v16 RENAME TO retire_proposals;
      CREATE INDEX IF NOT EXISTS idx_retire_proposals_status ON retire_proposals(status);
    `,
  },
  {
    version: 17,
    name: "round7_analysis_progress",
    sql: `
      -- The step an analysis run is on and how far it has got, so the Inbox
      -- can show progress while it runs: {"stage": ..., "done": n, "total": n}.
      ALTER TABLE analysis_runs ADD COLUMN progress_json TEXT;
    `,
  },
  {
    version: 18,
    name: "checkpoint_replay_environment",
    sql: `
      -- Truth about what a test really was. Every run so far made ONE new
      -- Lovable build (the "with the rule" copy) next to a free copy of the
      -- historical build, so it is a historical replay, never a paired
      -- comparison with a fresh control. The environment record says which
      -- Project Knowledge the replay started from and how it was chosen
      -- (exact_historical / nearest_earlier_version / current_fallback /
      -- unavailable), which rules were live at the time, what could not be
      -- reconstructed (Lovable's project memory, workspace Knowledge, Skills,
      -- the builder version), and how comparable the result is.
      ALTER TABLE experiment_runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'historical_replay'
        CHECK (kind IN ('historical_replay','paired_comparison'));
      ALTER TABLE experiment_runs ADD COLUMN environment_json TEXT;
    `,
  },
  {
    version: 19,
    name: "checkpoint_skill_proposals",
    sql: `
      -- Skills as a first-class destination. A suggestion recommends where
      -- its lesson belongs (Knowledge, a Skill, or both), says why, names the
      -- alternative, and records who chose (the Rule writer or the user). A
      -- Skill proposal is the draft SKILL.md itself, kept and versioned
      -- locally; writing it to Lovable is not wired yet (lovable_state stays
      -- 'not_created'), and the UI says so.
      ALTER TABLE correction_candidates ADD COLUMN destination TEXT NOT NULL DEFAULT 'knowledge'
        CHECK (destination IN ('knowledge','skill','both'));
      ALTER TABLE correction_candidates ADD COLUMN destination_reason TEXT;
      ALTER TABLE correction_candidates ADD COLUMN destination_alternative TEXT;
      ALTER TABLE correction_candidates ADD COLUMN destination_chosen_by TEXT
        CHECK (destination_chosen_by IN ('rule_writer','user'));

      CREATE TABLE IF NOT EXISTS skill_proposals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        correction_candidate_id INTEGER NOT NULL REFERENCES correction_candidates(id),
        rule_id INTEGER REFERENCES rules(id),
        name TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'proposed'
          CHECK (status IN ('proposed','approved','retired','skipped')),
        ownership TEXT NOT NULL DEFAULT 'harness' CHECK (ownership IN ('harness','user')),
        lovable_state TEXT NOT NULL DEFAULT 'not_created' CHECK (lovable_state IN ('not_created')),
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_skill_proposals_candidate ON skill_proposals(correction_candidate_id);

      CREATE TABLE IF NOT EXISTS skill_proposal_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        skill_proposal_id INTEGER NOT NULL REFERENCES skill_proposals(id),
        previous_name TEXT,
        previous_content TEXT,
        previous_status TEXT,
        new_name TEXT NOT NULL,
        new_content TEXT NOT NULL,
        new_status TEXT NOT NULL,
        reason TEXT NOT NULL,
        actor TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_skill_proposal_revisions_proposal
        ON skill_proposal_revisions(skill_proposal_id, id);
    `,
  },
  {
    version: 20,
    name: "checkpoint_analysis_context",
    sql: `
      -- What each model call was shown, and why. One row per LLM call that
      -- classified or proposed: the selected context items (ids and reasons),
      -- what was left out although relevant, the approximate token size,
      -- truncation, and the strategy/prompt versions -- so an analysis can be
      -- explained and repeated.
      CREATE TABLE IF NOT EXISTS analysis_context (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER,
        llm_call_id INTEGER,
        role TEXT NOT NULL,
        target_history_item_id INTEGER,
        target_correction_candidate_id INTEGER,
        selected_json TEXT NOT NULL DEFAULT '[]',
        omitted_json TEXT NOT NULL DEFAULT '[]',
        approx_tokens INTEGER,
        truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0,1)),
        strategy_version TEXT NOT NULL,
        prompt_version TEXT,
        content_hash TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_analysis_context_run ON analysis_context(run_id);

      -- A classification remembers what it was computed from, so a changed
      -- message, prompt or strategy can be found without re-asking everything.
      ALTER TABLE message_classifications ADD COLUMN content_hash TEXT;
      ALTER TABLE message_classifications ADD COLUMN prompt_version TEXT;
      ALTER TABLE message_classifications ADD COLUMN strategy_version TEXT;
      ALTER TABLE message_classifications ADD COLUMN analyzed_at TEXT;

      -- "Reanalyse history" is a separate, scoped request: which projects,
      -- which date range, whether records a person already decided on are
      -- included, and why. Ordinary Analyse now stays 'incremental'.
      ALTER TABLE analysis_requests ADD COLUMN mode TEXT NOT NULL DEFAULT 'incremental'
        CHECK (mode IN ('incremental','reanalyse'));
      ALTER TABLE analysis_requests ADD COLUMN scope_json TEXT;

      -- A newer analysis that disagrees with a decision a person made never
      -- overwrites it: it opens a review item instead.
      CREATE TABLE IF NOT EXISTS analysis_disagreements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        correction_candidate_id INTEGER NOT NULL REFERENCES correction_candidates(id),
        run_id INTEGER,
        previous_json TEXT NOT NULL,
        proposed_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','accepted','dismissed')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        decided_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_analysis_disagreements_status ON analysis_disagreements(status);
    `,
  },
  {
    version: 21,
    name: "checkpoint_rule_usefulness",
    sql: `
      -- "Is this rule still useful?" replaces "Did this rule help?". Verdict
      -- values become keep / review / retire / not_sure (old rows are mapped:
      -- helped -> keep, did_not_help -> review). rule_health gains a
      -- 'review' status (inactivity or repeated issues ask for a look, they do
      -- not retire) and separate observed/AI-review counters so no number
      -- mixes sources. SQLite cannot alter a CHECK, so both tables are rebuilt
      -- with every row kept.
      CREATE TABLE rule_verdicts_v21 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rule_id INTEGER NOT NULL REFERENCES rules(id),
        verdict TEXT NOT NULL CHECK (verdict IN ('keep','review','retire','not_sure')),
        note TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        superseded INTEGER NOT NULL DEFAULT 0 CHECK (superseded IN (0,1))
      );
      INSERT INTO rule_verdicts_v21 (id, rule_id, verdict, note, created_at, superseded)
        SELECT id, rule_id,
               CASE verdict WHEN 'helped' THEN 'keep' WHEN 'did_not_help' THEN 'review' ELSE 'not_sure' END,
               note, created_at, superseded
        FROM rule_verdicts;
      DROP TABLE rule_verdicts;
      ALTER TABLE rule_verdicts_v21 RENAME TO rule_verdicts;
      CREATE INDEX IF NOT EXISTS idx_rule_verdicts_rule ON rule_verdicts(rule_id, id);

      CREATE TABLE rule_health_v21 (
        rule_id INTEGER PRIMARY KEY REFERENCES rules(id),
        applicable_tasks INTEGER NOT NULL DEFAULT 0,
        helped INTEGER NOT NULL DEFAULT 0,
        hurt INTEGER NOT NULL DEFAULT 0,
        last_applicable_at TEXT,
        contradicted_by_rule_id INTEGER,
        unused_since TEXT,
        status TEXT NOT NULL DEFAULT 'healthy'
          CHECK (status IN ('healthy','watch','review','retire_suggested','snoozed')),
        snoozed_until TEXT,
        computed_at TEXT NOT NULL DEFAULT (datetime('now')),
        baseline_at TEXT,
        observed_repeat INTEGER NOT NULL DEFAULT 0,
        observed_clear INTEGER NOT NULL DEFAULT 0,
        ai_not_followed INTEGER NOT NULL DEFAULT 0,
        ai_followed INTEGER NOT NULL DEFAULT 0,
        review_reason TEXT
      );
      INSERT INTO rule_health_v21 (rule_id, applicable_tasks, helped, hurt, last_applicable_at,
          contradicted_by_rule_id, unused_since, status, snoozed_until, computed_at, baseline_at)
        SELECT rule_id, applicable_tasks, helped, hurt, last_applicable_at,
          contradicted_by_rule_id, unused_since, status, snoozed_until, computed_at, baseline_at
        FROM rule_health;
      DROP TABLE rule_health;
      ALTER TABLE rule_health_v21 RENAME TO rule_health;
      CREATE INDEX IF NOT EXISTS idx_rule_health_status ON rule_health(status);

      -- An opposite request is classified before it questions a rule.
      ALTER TABLE retire_proposals ADD COLUMN contradiction_kind TEXT
        CHECK (contradiction_kind IN ('one_task_exception','temporary_override','project_specific_override',
                                      'permanent_preference_change','genuine_contradiction','unclear'));
    `,
  },
  {
    version: 22,
    name: "checkpoint2_deletion_confirmation",
    sql: `
      -- A copy is "deleted" only once Lovable no longer lists it. A 2xx on
      -- the delete request means "deletion requested"; a follow-up read that
      -- proves absence means "confirmed"; anything else stays visible as
      -- uncertainty. Existing rows: copy_deleted = 1 becomes 'requested'
      -- (never confirmed by a read-back before this version).
      ALTER TABLE experiment_runs ADD COLUMN copy_deletion_status TEXT NOT NULL DEFAULT 'none'
        CHECK (copy_deletion_status IN ('none','requested','confirmed','failed'));
      ALTER TABLE experiment_runs ADD COLUMN original_copy_deletion_status TEXT NOT NULL DEFAULT 'none'
        CHECK (original_copy_deletion_status IN ('none','requested','confirmed','failed'));
      UPDATE experiment_runs SET copy_deletion_status = 'requested' WHERE copy_deleted = 1;
      UPDATE experiment_runs SET original_copy_deletion_status = 'requested' WHERE original_copy_deleted = 1;
    `,
  },
  {
    version: 23,
    name: "checkpoint3_skill_publish",
    sql: `
      -- Checkpoint 3 S1 (D4 superseded): a Skill proposal can now actually be
      -- published to Lovable. SQLite cannot alter a CHECK, so skill_proposals
      -- is rebuilt the same way v7/v21 rebuilt knowledge_versions/
      -- rule_verdicts/rule_health -- except, unlike those, skill_proposals IS
      -- referenced by another table's foreign key (skill_proposal_revisions.
      -- skill_proposal_id). db.ts runs every migration inside a transaction,
      -- where toggling PRAGMA foreign_keys is a documented no-op (see the v7
      -- migration's own comment on this), so DROP TABLE skill_proposals
      -- while skill_proposal_revisions still references it fails with a
      -- foreign key constraint error -- verified by trying it. The fix:
      -- remove the child table first (into a plain backup with no
      -- constraints of its own, so dropping it is never blocked), rebuild
      -- the parent with nothing left referencing it, then recreate the
      -- child with its original schema and restore its rows -- by then the
      -- parent already has the same ids, so the child's foreign key is
      -- satisfied on insert.
      CREATE TABLE skill_proposal_revisions_v23_backup AS SELECT * FROM skill_proposal_revisions;
      DROP TABLE skill_proposal_revisions;

      CREATE TABLE skill_proposals_v23 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        correction_candidate_id INTEGER NOT NULL REFERENCES correction_candidates(id),
        rule_id INTEGER REFERENCES rules(id),
        name TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'proposed'
          CHECK (status IN ('proposed','approved','retired','skipped')),
        ownership TEXT NOT NULL DEFAULT 'harness' CHECK (ownership IN ('harness','user')),
        lovable_state TEXT NOT NULL DEFAULT 'not_created'
          CHECK (lovable_state IN ('not_created','created','failed')),
        lovable_written_at TEXT,
        lovable_readback_ok INTEGER CHECK (lovable_readback_ok IN (0,1)),
        lovable_error TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO skill_proposals_v23
          (id, correction_candidate_id, rule_id, name, content, status, ownership,
           lovable_state, created_by, created_at, updated_at)
        SELECT id, correction_candidate_id, rule_id, name, content, status, ownership,
               lovable_state, created_by, created_at, updated_at
        FROM skill_proposals;
      DROP TABLE skill_proposals;
      ALTER TABLE skill_proposals_v23 RENAME TO skill_proposals;
      CREATE INDEX IF NOT EXISTS idx_skill_proposals_candidate ON skill_proposals(correction_candidate_id);

      CREATE TABLE skill_proposal_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        skill_proposal_id INTEGER NOT NULL REFERENCES skill_proposals(id),
        previous_name TEXT,
        previous_content TEXT,
        previous_status TEXT,
        new_name TEXT NOT NULL,
        new_content TEXT NOT NULL,
        new_status TEXT NOT NULL,
        reason TEXT NOT NULL,
        actor TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO skill_proposal_revisions
          (id, skill_proposal_id, previous_name, previous_content, previous_status,
           new_name, new_content, new_status, reason, actor, created_at)
        SELECT id, skill_proposal_id, previous_name, previous_content, previous_status,
               new_name, new_content, new_status, reason, actor, created_at
        FROM skill_proposal_revisions_v23_backup
        ORDER BY id;
      DROP TABLE skill_proposal_revisions_v23_backup;
      CREATE INDEX IF NOT EXISTS idx_skill_proposal_revisions_proposal
        ON skill_proposal_revisions(skill_proposal_id, id);
    `,
  },
];
