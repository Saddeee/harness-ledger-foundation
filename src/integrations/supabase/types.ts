export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      builds: {
        Row: {
          commit_sha: string | null
          created_at: string
          expectation_before: string | null
          findings: Json | null
          history_message_id: string | null
          id: string
          model: string | null
          observed_failures: string[] | null
          owner_user_id: string | null
          project_id: string | null
          reviewed_at: string | null
          task_id: string | null
          verdict: string | null
        }
        Insert: {
          commit_sha?: string | null
          created_at?: string
          expectation_before?: string | null
          findings?: Json | null
          history_message_id?: string | null
          id?: string
          model?: string | null
          observed_failures?: string[] | null
          owner_user_id?: string | null
          project_id?: string | null
          reviewed_at?: string | null
          task_id?: string | null
          verdict?: string | null
        }
        Update: {
          commit_sha?: string | null
          created_at?: string
          expectation_before?: string | null
          findings?: Json | null
          history_message_id?: string | null
          id?: string
          model?: string | null
          observed_failures?: string[] | null
          owner_user_id?: string | null
          project_id?: string | null
          reviewed_at?: string | null
          task_id?: string | null
          verdict?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "builds_history_message_id_fkey"
            columns: ["history_message_id"]
            isOneToOne: false
            referencedRelation: "history_messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "builds_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "builds_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      credit_ledger: {
        Row: {
          cost_credits: number | null
          created_at: string
          id: string
          kind: string | null
          month: string | null
          owner_user_id: string | null
          reference_id: string | null
        }
        Insert: {
          cost_credits?: number | null
          created_at?: string
          id?: string
          kind?: string | null
          month?: string | null
          owner_user_id?: string | null
          reference_id?: string | null
        }
        Update: {
          cost_credits?: number | null
          created_at?: string
          id?: string
          kind?: string | null
          month?: string | null
          owner_user_id?: string | null
          reference_id?: string | null
        }
        Relationships: []
      }
      events: {
        Row: {
          created_at: string
          id: string
          kind: string | null
          owner_user_id: string | null
          payload: Json | null
          ref_id: string | null
          ref_table: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          kind?: string | null
          owner_user_id?: string | null
          payload?: Json | null
          ref_id?: string | null
          ref_table?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          kind?: string | null
          owner_user_id?: string | null
          payload?: Json | null
          ref_id?: string | null
          ref_table?: string | null
        }
        Relationships: []
      }
      history_edits: {
        Row: {
          commit_message: string | null
          commit_sha: string | null
          created_at: string
          created_at_remote: string | null
          id: string
          lovable_edit_id: string | null
          owner_user_id: string | null
          project_id: string | null
          status: string | null
          type: string | null
        }
        Insert: {
          commit_message?: string | null
          commit_sha?: string | null
          created_at?: string
          created_at_remote?: string | null
          id?: string
          lovable_edit_id?: string | null
          owner_user_id?: string | null
          project_id?: string | null
          status?: string | null
          type?: string | null
        }
        Update: {
          commit_message?: string | null
          commit_sha?: string | null
          created_at?: string
          created_at_remote?: string | null
          id?: string
          lovable_edit_id?: string | null
          owner_user_id?: string | null
          project_id?: string | null
          status?: string | null
          type?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "history_edits_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      history_messages: {
        Row: {
          classification: string | null
          commit_sha: string | null
          content_redacted: string | null
          cost_credits: number | null
          created_at: string
          edit_id: string | null
          id: string
          is_global_demo: boolean | null
          lovable_message_id: string | null
          owner_user_id: string | null
          project_id: string | null
          redaction_count: number | null
          role: string | null
          sent_at: string | null
          status: string | null
          tags: string[] | null
          task_id: string | null
        }
        Insert: {
          classification?: string | null
          commit_sha?: string | null
          content_redacted?: string | null
          cost_credits?: number | null
          created_at?: string
          edit_id?: string | null
          id?: string
          is_global_demo?: boolean | null
          lovable_message_id?: string | null
          owner_user_id?: string | null
          project_id?: string | null
          redaction_count?: number | null
          role?: string | null
          sent_at?: string | null
          status?: string | null
          tags?: string[] | null
          task_id?: string | null
        }
        Update: {
          classification?: string | null
          commit_sha?: string | null
          content_redacted?: string | null
          cost_credits?: number | null
          created_at?: string
          edit_id?: string | null
          id?: string
          is_global_demo?: boolean | null
          lovable_message_id?: string | null
          owner_user_id?: string | null
          project_id?: string | null
          redaction_count?: number | null
          role?: string | null
          sent_at?: string | null
          status?: string | null
          tags?: string[] | null
          task_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "history_messages_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "history_messages_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      job_queue: {
        Row: {
          attempts: number | null
          created_at: string
          error: string | null
          id: string
          kind: string | null
          locked_at: string | null
          owner_user_id: string | null
          payload: Json | null
          run_after: string
          status: string | null
        }
        Insert: {
          attempts?: number | null
          created_at?: string
          error?: string | null
          id?: string
          kind?: string | null
          locked_at?: string | null
          owner_user_id?: string | null
          payload?: Json | null
          run_after?: string
          status?: string | null
        }
        Update: {
          attempts?: number | null
          created_at?: string
          error?: string | null
          id?: string
          kind?: string | null
          locked_at?: string | null
          owner_user_id?: string | null
          payload?: Json | null
          run_after?: string
          status?: string | null
        }
        Relationships: []
      }
      judge_audits: {
        Row: {
          corrections_recalled: number | null
          corrections_total: number | null
          created_at: string
          details: Json | null
          id: string
          model: string | null
          owner_user_id: string | null
          project_id: string | null
          task_id: string | null
        }
        Insert: {
          corrections_recalled?: number | null
          corrections_total?: number | null
          created_at?: string
          details?: Json | null
          id?: string
          model?: string | null
          owner_user_id?: string | null
          project_id?: string | null
          task_id?: string | null
        }
        Update: {
          corrections_recalled?: number | null
          corrections_total?: number | null
          created_at?: string
          details?: Json | null
          id?: string
          model?: string | null
          owner_user_id?: string | null
          project_id?: string | null
          task_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "judge_audits_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "judge_audits_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      knowledge_versions: {
        Row: {
          char_count: number | null
          content: string | null
          created_at: string
          id: string
          learning_ids: string[] | null
          owner_user_id: string | null
          project_id: string | null
          target: string | null
          workspace_id: string | null
          written_at: string
          written_by: string | null
        }
        Insert: {
          char_count?: number | null
          content?: string | null
          created_at?: string
          id?: string
          learning_ids?: string[] | null
          owner_user_id?: string | null
          project_id?: string | null
          target?: string | null
          workspace_id?: string | null
          written_at?: string
          written_by?: string | null
        }
        Update: {
          char_count?: number | null
          content?: string | null
          created_at?: string
          id?: string
          learning_ids?: string[] | null
          owner_user_id?: string | null
          project_id?: string | null
          target?: string | null
          workspace_id?: string | null
          written_at?: string
          written_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "knowledge_versions_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "knowledge_versions_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      learnings: {
        Row: {
          applicable_runs: number | null
          applied_at: string | null
          cited: number | null
          confidence: number | null
          created_at: string
          evidence_level: string[] | null
          evidence_message_ids: string[] | null
          failure_signature: string | null
          helped: number | null
          hurt: number | null
          id: string
          is_global_demo: boolean | null
          kind: string | null
          level: string | null
          neutral: number | null
          owner_user_id: string | null
          prediction: string | null
          project_id: string | null
          reject_reason: string | null
          retired_at: string | null
          retired_reason: string | null
          scope_tags: string[] | null
          skill_body: string | null
          skill_name: string | null
          state: string | null
          text: string | null
          workspace_id: string | null
        }
        Insert: {
          applicable_runs?: number | null
          applied_at?: string | null
          cited?: number | null
          confidence?: number | null
          created_at?: string
          evidence_level?: string[] | null
          evidence_message_ids?: string[] | null
          failure_signature?: string | null
          helped?: number | null
          hurt?: number | null
          id?: string
          is_global_demo?: boolean | null
          kind?: string | null
          level?: string | null
          neutral?: number | null
          owner_user_id?: string | null
          prediction?: string | null
          project_id?: string | null
          reject_reason?: string | null
          retired_at?: string | null
          retired_reason?: string | null
          scope_tags?: string[] | null
          skill_body?: string | null
          skill_name?: string | null
          state?: string | null
          text?: string | null
          workspace_id?: string | null
        }
        Update: {
          applicable_runs?: number | null
          applied_at?: string | null
          cited?: number | null
          confidence?: number | null
          created_at?: string
          evidence_level?: string[] | null
          evidence_message_ids?: string[] | null
          failure_signature?: string | null
          helped?: number | null
          hurt?: number | null
          id?: string
          is_global_demo?: boolean | null
          kind?: string | null
          level?: string | null
          neutral?: number | null
          owner_user_id?: string | null
          prediction?: string | null
          project_id?: string | null
          reject_reason?: string | null
          retired_at?: string | null
          retired_reason?: string | null
          scope_tags?: string[] | null
          skill_body?: string | null
          skill_name?: string | null
          state?: string | null
          text?: string | null
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "learnings_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "learnings_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      llm_calls: {
        Row: {
          created_at: string
          est_cost_usd: number | null
          id: string
          latency_ms: number | null
          model: string | null
          owner_user_id: string | null
          provider: string | null
          ref_id: string | null
          ref_table: string | null
          role: string | null
          tokens_in: number | null
          tokens_out: number | null
        }
        Insert: {
          created_at?: string
          est_cost_usd?: number | null
          id?: string
          latency_ms?: number | null
          model?: string | null
          owner_user_id?: string | null
          provider?: string | null
          ref_id?: string | null
          ref_table?: string | null
          role?: string | null
          tokens_in?: number | null
          tokens_out?: number | null
        }
        Update: {
          created_at?: string
          est_cost_usd?: number | null
          id?: string
          latency_ms?: number | null
          model?: string | null
          owner_user_id?: string | null
          provider?: string | null
          ref_id?: string | null
          ref_table?: string | null
          role?: string | null
          tokens_in?: number | null
          tokens_out?: number | null
        }
        Relationships: []
      }
      lovable_connections: {
        Row: {
          access_token: string | null
          created_at: string
          email: string | null
          expires_at: string | null
          id: string
          lovable_user_id: string | null
          owner_user_id: string | null
          refresh_token: string | null
          scope: string | null
          status: string | null
        }
        Insert: {
          access_token?: string | null
          created_at?: string
          email?: string | null
          expires_at?: string | null
          id?: string
          lovable_user_id?: string | null
          owner_user_id?: string | null
          refresh_token?: string | null
          scope?: string | null
          status?: string | null
        }
        Update: {
          access_token?: string | null
          created_at?: string
          email?: string | null
          expires_at?: string | null
          id?: string
          lovable_user_id?: string | null
          owner_user_id?: string | null
          refresh_token?: string | null
          scope?: string | null
          status?: string | null
        }
        Relationships: []
      }
      oauth_states: {
        Row: {
          code_verifier: string | null
          created_at: string
          owner_user_id: string | null
          redirect_to: string | null
          state: string
        }
        Insert: {
          code_verifier?: string | null
          created_at?: string
          owner_user_id?: string | null
          redirect_to?: string | null
          state: string
        }
        Update: {
          code_verifier?: string | null
          created_at?: string
          owner_user_id?: string | null
          redirect_to?: string | null
          state?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string
          email: string | null
          role: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          email?: string | null
          role?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          email?: string | null
          role?: string | null
          user_id?: string
        }
        Relationships: []
      }
      projects: {
        Row: {
          autonomy_level: number | null
          can_read: boolean | null
          can_replay: boolean | null
          can_write_knowledge: boolean | null
          created_at: string
          github_repo: string | null
          id: string
          is_demo: boolean | null
          is_global_demo: boolean | null
          last_mined_at: string | null
          last_watched_at: string | null
          lovable_project_id: string | null
          mine_cursor: string | null
          name: string | null
          owner_user_id: string | null
          watch_cursor: string | null
          workspace_id: string | null
        }
        Insert: {
          autonomy_level?: number | null
          can_read?: boolean | null
          can_replay?: boolean | null
          can_write_knowledge?: boolean | null
          created_at?: string
          github_repo?: string | null
          id?: string
          is_demo?: boolean | null
          is_global_demo?: boolean | null
          last_mined_at?: string | null
          last_watched_at?: string | null
          lovable_project_id?: string | null
          mine_cursor?: string | null
          name?: string | null
          owner_user_id?: string | null
          watch_cursor?: string | null
          workspace_id?: string | null
        }
        Update: {
          autonomy_level?: number | null
          can_read?: boolean | null
          can_replay?: boolean | null
          can_write_knowledge?: boolean | null
          created_at?: string
          github_repo?: string | null
          id?: string
          is_demo?: boolean | null
          is_global_demo?: boolean | null
          last_mined_at?: string | null
          last_watched_at?: string | null
          lovable_project_id?: string | null
          mine_cursor?: string | null
          name?: string | null
          owner_user_id?: string | null
          watch_cursor?: string | null
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "projects_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      replays: {
        Row: {
          agrees_with_reviewer: boolean | null
          approved_by: string | null
          arm: string | null
          commit_sha: string | null
          cost_credits: number | null
          created_at: string
          diff_summary: string | null
          error: string | null
          finished_at: string | null
          fork_project_id: string | null
          fork_state: string | null
          human_verdict: string | null
          id: string
          learning_id: string | null
          lovable_message_id: string | null
          observed_failures: string[] | null
          owner_user_id: string | null
          per_correction: Json | null
          reviewer_verdict: string | null
          score: number | null
          started_at: string | null
          status: string | null
          task_id: string | null
          thread_id: string | null
        }
        Insert: {
          agrees_with_reviewer?: boolean | null
          approved_by?: string | null
          arm?: string | null
          commit_sha?: string | null
          cost_credits?: number | null
          created_at?: string
          diff_summary?: string | null
          error?: string | null
          finished_at?: string | null
          fork_project_id?: string | null
          fork_state?: string | null
          human_verdict?: string | null
          id?: string
          learning_id?: string | null
          lovable_message_id?: string | null
          observed_failures?: string[] | null
          owner_user_id?: string | null
          per_correction?: Json | null
          reviewer_verdict?: string | null
          score?: number | null
          started_at?: string | null
          status?: string | null
          task_id?: string | null
          thread_id?: string | null
        }
        Update: {
          agrees_with_reviewer?: boolean | null
          approved_by?: string | null
          arm?: string | null
          commit_sha?: string | null
          cost_credits?: number | null
          created_at?: string
          diff_summary?: string | null
          error?: string | null
          finished_at?: string | null
          fork_project_id?: string | null
          fork_state?: string | null
          human_verdict?: string | null
          id?: string
          learning_id?: string | null
          lovable_message_id?: string | null
          observed_failures?: string[] | null
          owner_user_id?: string | null
          per_correction?: Json | null
          reviewer_verdict?: string | null
          score?: number | null
          started_at?: string | null
          status?: string | null
          task_id?: string | null
          thread_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "replays_learning_id_fkey"
            columns: ["learning_id"]
            isOneToOne: false
            referencedRelation: "learnings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "replays_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      rule_evaluations: {
        Row: {
          applicable: boolean | null
          build_id: string | null
          cited: boolean | null
          created_at: string
          evidence: string | null
          id: string
          learning_id: string | null
          outcome: string | null
          owner_user_id: string | null
          replay_id: string | null
        }
        Insert: {
          applicable?: boolean | null
          build_id?: string | null
          cited?: boolean | null
          created_at?: string
          evidence?: string | null
          id?: string
          learning_id?: string | null
          outcome?: string | null
          owner_user_id?: string | null
          replay_id?: string | null
        }
        Update: {
          applicable?: boolean | null
          build_id?: string | null
          cited?: boolean | null
          created_at?: string
          evidence?: string | null
          id?: string
          learning_id?: string | null
          outcome?: string | null
          owner_user_id?: string | null
          replay_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "rule_evaluations_build_id_fkey"
            columns: ["build_id"]
            isOneToOne: false
            referencedRelation: "builds"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rule_evaluations_learning_id_fkey"
            columns: ["learning_id"]
            isOneToOne: false
            referencedRelation: "learnings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rule_evaluations_replay_id_fkey"
            columns: ["replay_id"]
            isOneToOne: false
            referencedRelation: "replays"
            referencedColumns: ["id"]
          },
        ]
      }
      settings: {
        Row: {
          created_at: string
          id: string
          key: string | null
          owner_user_id: string | null
          value: Json | null
        }
        Insert: {
          created_at?: string
          id?: string
          key?: string | null
          owner_user_id?: string | null
          value?: Json | null
        }
        Update: {
          created_at?: string
          id?: string
          key?: string | null
          owner_user_id?: string | null
          value?: Json | null
        }
        Relationships: []
      }
      skill_versions: {
        Row: {
          content: string | null
          created_at: string
          id: string
          learning_id: string | null
          owner_user_id: string | null
          skill_name: string | null
          workspace_id: string | null
          written_at: string
          written_by: string | null
        }
        Insert: {
          content?: string | null
          created_at?: string
          id?: string
          learning_id?: string | null
          owner_user_id?: string | null
          skill_name?: string | null
          workspace_id?: string | null
          written_at?: string
          written_by?: string | null
        }
        Update: {
          content?: string | null
          created_at?: string
          id?: string
          learning_id?: string | null
          owner_user_id?: string | null
          skill_name?: string | null
          workspace_id?: string | null
          written_at?: string
          written_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "skill_versions_learning_id_fkey"
            columns: ["learning_id"]
            isOneToOne: false
            referencedRelation: "learnings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "skill_versions_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      tasks: {
        Row: {
          corrections_count: number | null
          created_at: string
          credits_spent: number | null
          ended_at: string | null
          final_commit: string | null
          first_build_commit: string | null
          first_message_id: string | null
          id: string
          is_global_demo: boolean | null
          owner_user_id: string | null
          project_id: string | null
          started_at: string | null
          tags: string[] | null
          title: string | null
        }
        Insert: {
          corrections_count?: number | null
          created_at?: string
          credits_spent?: number | null
          ended_at?: string | null
          final_commit?: string | null
          first_build_commit?: string | null
          first_message_id?: string | null
          id?: string
          is_global_demo?: boolean | null
          owner_user_id?: string | null
          project_id?: string | null
          started_at?: string | null
          tags?: string[] | null
          title?: string | null
        }
        Update: {
          corrections_count?: number | null
          created_at?: string
          credits_spent?: number | null
          ended_at?: string | null
          final_commit?: string | null
          first_build_commit?: string | null
          first_message_id?: string | null
          id?: string
          is_global_demo?: boolean | null
          owner_user_id?: string | null
          project_id?: string | null
          started_at?: string | null
          tags?: string[] | null
          title?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tasks_first_message_id_fkey"
            columns: ["first_message_id"]
            isOneToOne: false
            referencedRelation: "history_messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      workspaces: {
        Row: {
          can_write_skills: boolean | null
          can_write_workspace_knowledge: boolean | null
          created_at: string
          id: string
          lovable_workspace_id: string | null
          name: string | null
          owner_user_id: string | null
          plan: string | null
        }
        Insert: {
          can_write_skills?: boolean | null
          can_write_workspace_knowledge?: boolean | null
          created_at?: string
          id?: string
          lovable_workspace_id?: string | null
          name?: string | null
          owner_user_id?: string | null
          plan?: string | null
        }
        Update: {
          can_write_skills?: boolean | null
          can_write_workspace_knowledge?: boolean | null
          created_at?: string
          id?: string
          lovable_workspace_id?: string | null
          name?: string | null
          owner_user_id?: string | null
          plan?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      credit_month_totals: {
        Row: {
          month: string | null
          owner_user_id: string | null
          total: number | null
        }
        Relationships: []
      }
    }
    Functions: {
      claim_jobs: {
        Args: { p_limit: number }
        Returns: {
          attempts: number | null
          created_at: string
          error: string | null
          id: string
          kind: string | null
          locked_at: string | null
          owner_user_id: string | null
          payload: Json | null
          run_after: string
          status: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "job_queue"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      is_operator: { Args: { _user_id: string }; Returns: boolean }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
