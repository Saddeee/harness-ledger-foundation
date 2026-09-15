import { createFileRoute } from "@tanstack/react-router";

async function handle({ request }: { request: Request }) {
  const { requireCronOrUser, UnauthorizedError } = await import("@/lib/server/auth");
  let userId: string;
  try {
    const caller = await requireCronOrUser(request);
    if (caller.kind !== "user") return new Response("Signed-in user required", { status: 401 });
    userId = caller.userId;
  } catch (e) {
    if (e instanceof UnauthorizedError) return new Response("Unauthorized", { status: 401 });
    throw e;
  }

  const { db } = await import("@/lib/server/db");
  const { logEvent } = await import("@/lib/server/events");
  const { getClientId, getRedirectUri } = await import("@/lib/server/app-origin");
  const {
    randomToken,
    s256,
    LOVABLE_AUTHORIZE_URL,
    LOVABLE_SCOPE,
    getConnection,
    needsRefresh,
    refreshConnection,
  } = await import("@/lib/server/lovable");

  // Opportunistic refresh of an existing connection that is close to expiry.
  const existing = await getConnection(userId);
  if (existing?.refresh_token && needsRefresh(existing.expires_at)) {
    try {
      await refreshConnection(userId, request);
    } catch {
      // Falls through to a fresh authorization.
    }
  }

  const state = randomToken(24);
  const codeVerifier = randomToken(48);
  const { error } = await db.from("oauth_states").insert({
    state,
    code_verifier: codeVerifier,
    owner_user_id: userId,
    redirect_to: "/projects?connected=1",
  });
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const params = new URLSearchParams({
    response_type: "code",
    client_id: getClientId(request),
    redirect_uri: getRedirectUri(request),
    scope: LOVABLE_SCOPE,
    state,
    code_challenge: await s256(codeVerifier),
    code_challenge_method: "S256",
  });
  const url = `${LOVABLE_AUTHORIZE_URL}?${params.toString()}`;
  await logEvent(userId, "oauth.started", "oauth_states", null, { state });
  return Response.json({ url });
}

export const Route = createFileRoute("/api/public/lovable/oauth-start")({
  server: { handlers: { POST: handle } },
});
