// Server-only bridge to the local Harness SQLite adapter for the Skills
// page: the latest content of every Skill the executor last read from the
// connected workspace, plus each Skill's full snapshot history with a
// server-computed line diff between consecutive snapshots (mirroring the
// knowledge route's "What changed" view). Read-only -- nothing here writes
// to Lovable; fetching a fresh Skill snapshot happens in the executor
// process (harness/src/executor/beats.ts), not here.
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

type Adapter = NonNullable<Awaited<ReturnType<typeof loadHarnessAdapter>>>;

// Same "which workspace" resolution as knowledge.ts: prefer an allowed
// project's known workspace, fall back to the connected executor's first
// workspace.
async function resolveWorkspaceId(adapter: Adapter): Promise<string | null> {
  const executor = await loadHarnessExecutor();
  const allowed = adapter.getAllowedProjects() as { lovable_project_id: string }[];
  let workspaceId: string | null = null;
  for (const p of allowed) {
    const meta = adapter.getProjectMeta(p.lovable_project_id) as {
      workspace_id: string | null;
    } | null;
    if (!workspaceId && meta?.workspace_id) workspaceId = meta.workspace_id;
  }
  if (!workspaceId && executor) {
    try {
      workspaceId = executor.auth.status().workspaces[0]?.id ?? null;
    } catch {
      workspaceId = null;
    }
  }
  return workspaceId;
}

async function buildSkillsResponse(adapter: Adapter) {
  const workspaceId = await resolveWorkspaceId(adapter);

  if (!workspaceId) {
    return { available: true as const, workspace_id: null, fetched_at: null, skills: [] };
  }

  const snapshots = adapter.latestSkillSnapshots(workspaceId);
  const fetched_at = snapshots.length
    ? snapshots.reduce(
        (max, s) => (s.fetched_at > max ? s.fetched_at : max),
        snapshots[0]!.fetched_at,
      )
    : null;

  const skills = snapshots.map((s) => {
    const rows = adapter.listSkillSnapshots(workspaceId, s.name);
    let previousContent = "";
    const history = rows.map((row) => {
      const diff = adapter.lineDiff(previousContent, row.content);
      previousContent = row.content;
      return {
        sha256: row.sha256,
        fetched_at: row.fetched_at,
        added: diff.added,
        removed: diff.removed,
      };
    });
    return {
      name: s.name,
      description: s.description,
      content: s.content,
      sha256: s.sha256,
      updated_at_remote: s.updated_at_remote,
      fetched_at: s.fetched_at,
      history,
    };
  });

  return { available: true as const, workspace_id: workspaceId, fetched_at, skills };
}

async function handleGet({ request }: { request: Request }) {
  const unauthorized = await requireAuth(request);
  if (unauthorized) return unauthorized;

  const adapter = await loadHarnessAdapter();
  if (!adapter) return Response.json(hostedPreviewBody());

  try {
    return Response.json(await buildSkillsResponse(adapter));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export const Route = createFileRoute("/api/public/harness/skills")({
  server: { handlers: { GET: handleGet } },
});
