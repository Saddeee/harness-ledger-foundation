REVOKE ALL ON FUNCTION public.claim_jobs(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_jobs(int) TO service_role;

REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO service_role, supabase_auth_admin;

REVOKE ALL ON FUNCTION public.is_operator(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_operator(uuid) TO authenticated, service_role;