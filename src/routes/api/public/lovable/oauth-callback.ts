import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const Body = z.object({ code: z.string().min(1).max(4096), state: z.string().min(1).max(512) });
const STATE_TTL_MS = 10 * 60 * 1000;

// No caller auth: the request is authenticated by the one-time state.
async function handle({ request }: { request: Request }) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Missing code or state" }, { status: 400 });
  const { code, state } = parsed.data;

  const { db } = await import("@/lib/server/db");
  const { logEvent } = await import("@/lib/server/events");
  const { exchangeCode, expiresAtFrom, LOVABLE_API_BASE } = await import("@/lib/server/lovable");
  const { LovableClient } = await import("@lovable.dev/sdk");

  const { data: st } = await db.from("oauth_states").select("*").eq("state", state).maybeSingle();
  if (!st || !st.owner_user_id || !st.code_verifier) {
    return Response.json({ error: "Unknown or expired state" }, { status: 400 });
  }
  if (Date.now() - new Date(st.created_at).getTime() > STATE_TTL_MS) {
    await db.from("oauth_states").delete().eq("state", state);
    return Response.json({ error: "State expired; start again" }, { status: 400 });
  }
  const ownerUserId = st.owner_user_id;

  try {
    const tok = await exchangeCode(code, st.code_verifier, request);

    const me = await new LovableClient({
      bearerToken: tok.access_token,
      baseUrl: LOVABLE_API_BASE,
    }).me();

    const { data: row, error } = await db
      .from("lovable_connections")
      .upsert(
        {
          owner_user_id: ownerUserId,
          access_token: tok.access_token,
          refresh_token: tok.refresh_token ?? null,
          expires_at: expiresAtFrom(tok.expires_in),
          scope: tok.scope ?? null,
          lovable_user_id: me.id,
          email: me.email,
          status: "active",
        },
        { onConflict: "owner_user_id" },
      )
      .select("id")
      .single();
    if (error) throw error;

    await db.from("oauth_states").delete().eq("state", state);
    await logEvent(ownerUserId, "connection.created", "lovable_connections", row.id, {
      lovable_user_id: me.id,
      email: me.email,
    });
    return Response.json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await logEvent(ownerUserId, "oauth.failed", "oauth_states", null, { error: message });
    return Response.json({ error: message }, { status: 400 });
  }
}

export const Route = createFileRoute("/api/public/lovable/oauth-callback")({
  server: { handlers: { POST: handle } },
});
