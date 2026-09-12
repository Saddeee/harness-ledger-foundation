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
];
