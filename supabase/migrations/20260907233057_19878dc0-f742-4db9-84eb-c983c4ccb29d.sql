-- ============ profiles ============
CREATE TABLE public.profiles (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email text,
  role text CHECK (role IN ('operator','user')) DEFAULT 'user',
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.is_operator(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE user_id = _user_id AND role = 'operator')
$$;

CREATE POLICY "profiles_select_own" ON public.profiles FOR SELECT TO authenticated USING (user_id = auth.uid() OR public.is_operator(auth.uid()));
CREATE POLICY "profiles_update_own" ON public.profiles FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE is_first boolean;
BEGIN
  SELECT NOT EXISTS (SELECT 1 FROM public.profiles) INTO is_first;
  INSERT INTO public.profiles (user_id, email, role)
  VALUES (NEW.id, NEW.email, CASE WHEN is_first THEN 'operator' ELSE 'user' END)
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============ core tables ============
CREATE TABLE public.workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  owner_user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  lovable_workspace_id text,
  name text,
  plan text,
  can_write_workspace_knowledge boolean DEFAULT false,
  can_write_skills boolean DEFAULT false,
  UNIQUE (owner_user_id, lovable_workspace_id)
);

CREATE TABLE public.projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  owner_user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  lovable_project_id text,
  workspace_id uuid REFERENCES public.workspaces(id) ON DELETE SET NULL,
  name text,
  github_repo text,
  can_read boolean DEFAULT false,
  can_write_knowledge boolean DEFAULT false,
  can_replay boolean DEFAULT false,
  autonomy_level int DEFAULT 1,
  is_demo boolean DEFAULT false,
  is_global_demo boolean DEFAULT false,
  mine_cursor text,
  watch_cursor text,
  last_mined_at timestamptz,
  last_watched_at timestamptz,
  UNIQUE (owner_user_id, lovable_project_id)
);

CREATE TABLE public.history_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  owner_user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  project_id uuid REFERENCES public.projects(id) ON DELETE CASCADE,
  lovable_message_id text,
  role text CHECK (role IN ('user','ai')),
  content_redacted text,
  status text,
  commit_sha text,
  edit_id text,
  cost_credits numeric,
  sent_at timestamptz,
  classification text,
  tags text[],
  task_id uuid,
  is_global_demo boolean DEFAULT false,
  redaction_count int DEFAULT 0,
  UNIQUE (project_id, lovable_message_id)
);

CREATE TABLE public.history_edits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  owner_user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  project_id uuid REFERENCES public.projects(id) ON DELETE CASCADE,
  lovable_edit_id text,
  type text,
  commit_sha text,
  commit_message text,
  status text,
  created_at_remote timestamptz,
  UNIQUE (project_id, lovable_edit_id)
);

CREATE TABLE public.tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  owner_user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  project_id uuid REFERENCES public.projects(id) ON DELETE CASCADE,
  first_message_id uuid REFERENCES public.history_messages(id) ON DELETE SET NULL,
  title text,
  tags text[],
  corrections_count int DEFAULT 0,
  credits_spent numeric DEFAULT 0,
  first_build_commit text,
  final_commit text,
  started_at timestamptz,
  ended_at timestamptz,
  is_global_demo boolean DEFAULT false
);

ALTER TABLE public.history_messages
  ADD CONSTRAINT history_messages_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE SET NULL;

CREATE TABLE public.learnings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  owner_user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  kind text CHECK (kind IN ('rule','skill')),
  level text CHECK (level IN ('project','workspace')),
  state text CHECK (state IN ('candidate','proposed','approved','rejected','applied','promoted','retired','rolled_back')) DEFAULT 'proposed',
  text text,
  skill_name text,
  skill_body text,
  scope_tags text[],
  prediction text,
  failure_signature text,
  evidence_message_ids uuid[],
  confidence numeric,
  project_id uuid REFERENCES public.projects(id) ON DELETE CASCADE,
  workspace_id uuid REFERENCES public.workspaces(id) ON DELETE CASCADE,
  evidence_level text[] DEFAULT '{mined}',
  helped int DEFAULT 0,
  hurt int DEFAULT 0,
  neutral int DEFAULT 0,
  cited int DEFAULT 0,
  applicable_runs int DEFAULT 0,
  reject_reason text,
  applied_at timestamptz,
  retired_at timestamptz,
  retired_reason text,
  is_global_demo boolean DEFAULT false
);

CREATE TABLE public.knowledge_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  owner_user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  target text CHECK (target IN ('project','workspace')),
  project_id uuid REFERENCES public.projects(id) ON DELETE CASCADE,
  workspace_id uuid REFERENCES public.workspaces(id) ON DELETE CASCADE,
  content text,
  char_count int,
  learning_ids uuid[],
  written_by text CHECK (written_by IN ('app','user','rollback')),
  written_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.skill_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  owner_user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  workspace_id uuid REFERENCES public.workspaces(id) ON DELETE CASCADE,
  skill_name text,
  content text,
  learning_id uuid REFERENCES public.learnings(id) ON DELETE SET NULL,
  written_by text,
  written_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.replays (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  owner_user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  learning_id uuid REFERENCES public.learnings(id) ON DELETE CASCADE,
  task_id uuid REFERENCES public.tasks(id) ON DELETE SET NULL,
  arm text CHECK (arm IN ('with','without','ablation')),
  fork_project_id text,
  fork_state text,
  lovable_message_id text,
  thread_id text,
  status text DEFAULT 'pending_approval',
  commit_sha text,
  cost_credits numeric,
  diff_summary text,
  score numeric,
  per_correction jsonb,
  observed_failures text[],
  reviewer_verdict text,
  human_verdict text,
  agrees_with_reviewer boolean,
  approved_by uuid,
  started_at timestamptz,
  finished_at timestamptz,
  error text
);

CREATE TABLE public.builds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  owner_user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  project_id uuid REFERENCES public.projects(id) ON DELETE CASCADE,
  history_message_id uuid REFERENCES public.history_messages(id) ON DELETE SET NULL,
  commit_sha text,
  task_id uuid REFERENCES public.tasks(id) ON DELETE SET NULL,
  expectation_before text,
  verdict text,
  observed_failures text[],
  findings jsonb,
  model text,
  reviewed_at timestamptz
);

CREATE TABLE public.rule_evaluations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  owner_user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  learning_id uuid REFERENCES public.learnings(id) ON DELETE CASCADE,
  build_id uuid REFERENCES public.builds(id) ON DELETE SET NULL,
  replay_id uuid REFERENCES public.replays(id) ON DELETE SET NULL,
  applicable boolean,
  outcome text CHECK (outcome IN ('helped','hurt','neutral')),
  cited boolean DEFAULT false,
  evidence text
);

CREATE TABLE public.judge_audits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  owner_user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  project_id uuid REFERENCES public.projects(id) ON DELETE CASCADE,
  task_id uuid REFERENCES public.tasks(id) ON DELETE SET NULL,
  model text,
  corrections_total int,
  corrections_recalled int,
  details jsonb
);

CREATE TABLE public.credit_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  owner_user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  kind text CHECK (kind IN ('replay','demo_generation','other')),
  reference_id uuid,
  cost_credits numeric,
  month text
);

CREATE TABLE public.llm_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  owner_user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  role text,
  provider text,
  model text,
  tokens_in int,
  tokens_out int,
  latency_ms int,
  est_cost_usd numeric,
  ref_table text,
  ref_id uuid
);

CREATE TABLE public.settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  owner_user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  key text,
  value jsonb,
  UNIQUE (owner_user_id, key)
);

CREATE TABLE public.events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  owner_user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  kind text,
  ref_table text,
  ref_id uuid,
  payload jsonb
);

CREATE TABLE public.job_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  owner_user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  kind text,
  payload jsonb,
  status text CHECK (status IN ('queued','running','done','failed')) DEFAULT 'queued',
  attempts int DEFAULT 0,
  run_after timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  error text
);

-- ============ service-role-only tables ============
CREATE TABLE public.lovable_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  owner_user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  lovable_user_id text,
  email text,
  access_token text,
  refresh_token text,
  expires_at timestamptz,
  scope text,
  status text DEFAULT 'active'
);
GRANT ALL ON public.lovable_connections TO service_role;
ALTER TABLE public.lovable_connections ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.oauth_states (
  state text PRIMARY KEY,
  code_verifier text,
  owner_user_id uuid,
  redirect_to text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.oauth_states TO service_role;
ALTER TABLE public.oauth_states ENABLE ROW LEVEL SECURITY;

-- ============ grants + RLS for owner tables ============
DO $$
DECLARE
  t text;
  owner_tables text[] := ARRAY['workspaces','projects','history_messages','history_edits','tasks','learnings','knowledge_versions','skill_versions','replays','builds','rule_evaluations','judge_audits','credit_ledger','llm_calls','settings','events','job_queue'];
  has_demo boolean;
BEGIN
  FOREACH t IN ARRAY owner_tables LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (owner_user_id = auth.uid() OR public.is_operator(auth.uid()))', t||'_select_own', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (owner_user_id = auth.uid())', t||'_insert_own', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (owner_user_id = auth.uid()) WITH CHECK (owner_user_id = auth.uid())', t||'_update_own', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (owner_user_id = auth.uid())', t||'_delete_own', t);

    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = t AND column_name = 'is_global_demo'
    ) INTO has_demo;
    IF has_demo THEN
      EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (is_global_demo = true)', t||'_select_global_demo', t);
    END IF;
  END LOOP;
END;
$$;

-- ============ view ============
CREATE VIEW public.credit_month_totals
WITH (security_invoker = true) AS
SELECT owner_user_id, month, SUM(cost_credits) AS total
FROM public.credit_ledger
GROUP BY owner_user_id, month;

GRANT SELECT ON public.credit_month_totals TO authenticated;
GRANT ALL ON public.credit_month_totals TO service_role;

-- ============ claim_jobs ============
CREATE OR REPLACE FUNCTION public.claim_jobs(p_limit int)
RETURNS SETOF public.job_queue
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  WITH picked AS (
    SELECT id FROM public.job_queue
    WHERE status = 'queued' AND run_after <= now()
    ORDER BY run_after
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.job_queue j
  SET status = 'running', locked_at = now(), attempts = j.attempts + 1
  FROM picked
  WHERE j.id = picked.id
  RETURNING j.*;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_jobs(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_jobs(int) TO service_role;

-- ============ realtime on events ============
ALTER TABLE public.events REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.events;