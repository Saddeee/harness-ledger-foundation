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
];
