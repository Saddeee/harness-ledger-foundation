// Service-role database access for server routes / server functions.
// Wraps the generated admin client; do not duplicate its key handling here.
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export const db = supabaseAdmin;
export { supabaseAdmin };
