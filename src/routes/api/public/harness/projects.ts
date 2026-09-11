// Server-only bridge for the Projects page: the allow-list (with sync
// stats and each project's own max-active-rules/auto-write settings) plus,
// when Lovable is connected, the workspace's full project list so the owner
// can pick which ones to allow. The allow-list write itself never touches
// Lovable -- it only curates allowed_projects, exactly like `npm run seed`
// does out of band, and "project_settings" only curates project_settings.
// Listing Lovable's projects is the one other place (besides "connect") the
// web server is allowed to reach the executor's Lovable client, and only
// through a 10-minute cache.
import { createFileRoute } from "@tanstack/react-router";
import {
  hostedPreviewBody,
  loadHarnessAdapter,
  loadHarnessExecutor,
} from "@/lib/server/harness-runtime";

async function requireAuth(request: Request): Promise<Response | null> {
  const { requireCronOrUser, UnauthorizedError } = await import("@/lib/server/auth");
  try {
    await requireCronOrUser(request);
    return null;
  } catch (e) {
    if (e instanceof UnauthorizedError) return new Response("Unauthorized", { status: 401 });
    throw e;
  }
}

type Executor = NonNullable<Awaited<ReturnType<typeof loadHarnessExecutor>>>;

const PROJECTS_CACHE_TTL_MS = 10 * 60 * 1000;
let projectsCache: {
  workspaceId: string;
  fetchedAt: number;
  projects: { id: string; name: string }[];
} | null = null;

async function cachedListProjects(
  executor: Executor,
  workspaceId: string,
): Promise<{ id: string; name: string }[]> {
  const now = Date.now();
  if (
    projectsCache &&
    projectsCache.workspaceId === workspaceId &&
    now - projectsCache.fetchedAt < PROJECTS_CACHE_TTL_MS
  ) {
    return projectsCache.projects;
  }
  const client = await executor.mcp.openLovableClient();
  try {
    const projects = await client.listProjects(workspaceId);
    projectsCache = { workspaceId, fetchedAt: now, projects };
    return projects;
  } finally {
    await client.close().catch(() => {});
  }
}

async function handleGet({ request }: { request: Request }) {
  const unauthorized = await requireAuth(request);
  if (unauthorized) return unauthorized;

  const adapter = await loadHarnessAdapter();
  if (!adapter) return Response.json(hostedPreviewBody());

  try {
    const allowedRows = adapter.getAllowedProjects() as {
      lovable_project_id: string;
      label: string | null;
    }[];
    const stats = adapter.listHistoryStats() as {
      project_id: string;
      history_count: number;
      last_synced_at: string | null;
    }[];
    const statsByProject = new Map(stats.map((s) => [s.project_id, s]));

    let workspaceId: string | null = null;
    const allowed = allowedRows.map((row) => {
      const meta = adapter.getProjectMeta(row.lovable_project_id) as {
        name: string | null;
        workspace_id: string | null;
      } | null;
      if (!workspaceId && meta?.workspace_id) workspaceId = meta.workspace_id;
      const s = statsByProject.get(row.lovable_project_id);
      return {
        id: row.lovable_project_id,
        name: meta?.name ?? row.label ?? row.lovable_project_id,
        last_synced_at: s?.last_synced_at ?? null,
        history_count: s?.history_count ?? 0,
        settings: adapter.getProjectSettings(row.lovable_project_id),
      };
    });

    const body: Record<string, unknown> = { available: true, allowed };

    const executor = await loadHarnessExecutor();
    if (executor) {
      try {
        const status = executor.auth.status();
        if (status.connected) {
          if (!workspaceId) workspaceId = status.workspaces[0]?.id ?? null;
          if (workspaceId) {
            const list = await cachedListProjects(executor, workspaceId);
            const allowedIds = new Set(allowedRows.map((r) => r.lovable_project_id));
            body["all"] = list.map((p) => ({
              id: p.id,
              name: p.name,
              allowed: allowedIds.has(p.id),
            }));
          }
        }
      } catch (e) {
        body["lovable_error"] = e instanceof Error ? e.message : String(e);
      }
    }

    return Response.json(body);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

async function handlePost({ request }: { request: Request }) {
  const unauthorized = await requireAuth(request);
  if (unauthorized) return unauthorized;

  const adapter = await loadHarnessAdapter();
  if (!adapter) return Response.json(hostedPreviewBody(), { status: 200 });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  try {
    const id = typeof body["lovable_project_id"] === "string" ? body["lovable_project_id"] : "";
    if (!id) throw new Error("lovable_project_id is required");

    if (body["action"] === "allow") {
      const label =
        typeof body["label"] === "string" && body["label"].length > 0 ? body["label"] : id;
      const project = adapter.allowProject(id, label);
      return Response.json({ available: true, project });
    }

    if (body["action"] === "disallow") {
      adapter.disallowProject(id);
      return Response.json({ available: true });
    }

    if (body["action"] === "project_settings") {
      const patch: { max_active_rules?: number | null; auto_write?: boolean } = {};
      if (body["max_active_rules"] !== undefined)
        patch.max_active_rules =
          body["max_active_rules"] === null ? null : Number(body["max_active_rules"]);
      if (body["auto_write"] !== undefined) patch.auto_write = Boolean(body["auto_write"]);
      const settings = adapter.setProjectSettings(id, patch);
      return Response.json({ available: true, settings });
    }

    throw new Error(`unknown action: ${String(body["action"])}`);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}

export const Route = createFileRoute("/api/public/harness/projects")({
  server: { handlers: { GET: handleGet, POST: handlePost } },
});
