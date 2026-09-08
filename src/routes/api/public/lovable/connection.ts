import { createFileRoute } from "@tanstack/react-router";

// lovable_connections has no client policies, so status/disconnect go through here.
async function authed(request: Request): Promise<string | Response> {
  const { requireCronOrUser, UnauthorizedError } = await import("@/lib/server/auth");
  try {
    const caller = await requireCronOrUser(request);
    if (caller.kind !== "user") return new Response("Signed-in user required", { status: 401 });
    return caller.userId;
  } catch (e) {
    if (e instanceof UnauthorizedError) return new Response("Unauthorized", { status: 401 });
    throw e;
  }
}

export const Route = createFileRoute("/api/public/lovable/connection")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const userId = await authed(request);
        if (userId instanceof Response) return userId;
        const { db } = await import("@/lib/server/db");
        const { data, error } = await db
          .from("lovable_connections")
          .select("email, expires_at, status, lovable_user_id")
          .eq("owner_user_id", userId)
          .maybeSingle();
        if (error) return Response.json({ error: error.message }, { status: 500 });
        return Response.json({ connection: data });
      },
      DELETE: async ({ request }) => {
        const userId = await authed(request);
        if (userId instanceof Response) return userId;
        const { db } = await import("@/lib/server/db");
        const { logEvent } = await import("@/lib/server/events");
        const { error } = await db.from("lovable_connections").delete().eq("owner_user_id", userId);
        if (error) return Response.json({ error: error.message }, { status: 500 });
        await logEvent(userId, "connection.deleted", "lovable_connections", null, {});
        return Response.json({ ok: true });
      },
    },
  },
});
