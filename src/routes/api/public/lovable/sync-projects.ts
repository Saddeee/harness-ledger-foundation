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
  const { getLovableClient } = await import("@/lib/server/lovable");

  try {
    const client = await getLovableClient(userId, request);
    const { workspaces } = await client.listWorkspaces();
    let projectCount = 0;

    for (const ws of workspaces) {
      // Only identity fields are written; permission flags on existing rows are untouched.
      const { data: wsRow, error: wsErr } = await db
        .from("workspaces")
        .upsert(
          { owner_user_id: userId, lovable_workspace_id: ws.id, name: ws.name, plan: ws.plan },
          { onConflict: "owner_user_id,lovable_workspace_id" },
        )
        .select("id")
        .single();
      if (wsErr) throw wsErr;

      let cursor: string | undefined;
      do {
        const page = await client.listProjects(ws.id, { cursor, limit: 100 });
        const items = page.projects ?? [];
        if (items.length > 0) {
          const { error: pErr } = await db.from("projects").upsert(
            items.map((p) => ({
              owner_user_id: userId,
              workspace_id: wsRow.id,
              lovable_project_id: p.id,
              name: p.display_name ?? p.name ?? p.id,
            })),
            { onConflict: "owner_user_id,lovable_project_id" },
          );
          if (pErr) throw pErr;
          projectCount += items.length;
        }
        cursor = page.pagination?.has_more ? (page.pagination.next_cursor ?? undefined) : undefined;
      } while (cursor);
    }

    await logEvent(userId, "projects.synced", "workspaces", null, {
      workspaces: workspaces.length,
      projects: projectCount,
    });
    return Response.json({ ok: true, workspaces: workspaces.length, projects: projectCount });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await logEvent(userId, "projects.sync_failed", "workspaces", null, { error: message });
    return Response.json({ error: message }, { status: 400 });
  }
}

export const Route = createFileRoute("/api/public/lovable/sync-projects")({
  server: { handlers: { POST: handle } },
});
