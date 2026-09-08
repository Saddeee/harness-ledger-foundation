import { createFileRoute } from "@tanstack/react-router";

// Called directly (never scheduled) when a connection is about to expire.
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

  const { refreshConnection } = await import("@/lib/server/lovable");
  try {
    const conn = await refreshConnection(userId, request);
    return Response.json({ ok: true, expires_at: conn.expires_at });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}

export const Route = createFileRoute("/api/public/lovable/oauth-refresh")({
  server: { handlers: { POST: handle } },
});
