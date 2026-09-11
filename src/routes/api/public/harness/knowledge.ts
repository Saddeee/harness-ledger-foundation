// Server-only bridge to the local Harness SQLite adapter for the Knowledge
// page: what Lovable Knowledge currently looks like per project/workspace,
// which rules are active in each, the version history of writes Harness has
// made, and any Skills the executor last read. Nothing here writes to
// Lovable directly -- "restore" only stages a new pending version; the
// executor process performs the actual write.
import { createFileRoute } from "@tanstack/react-router";
import {
  hostedPreviewBody,
  loadHarnessAdapter,
  loadHarnessExecutor,
} from "@/lib/server/harness-runtime";

const HARNESS_START_MARKER = "<!-- harness:start -->";

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

type Target = { target: "project" | "workspace"; id: string; name: string };

function versionMatchesTarget(
  v: { target: string; project_id: string | null; workspace_id: string | null },
  t: Target,
): boolean {
  if (v.target !== t.target) return false;
  return t.target === "project" ? v.project_id === t.id : v.workspace_id === t.id;
}

async function buildKnowledgeResponse(adapter: Adapter) {
  const executor = await loadHarnessExecutor();

  const allowed = adapter.getAllowedProjects() as { lovable_project_id: string }[];
  const targets: Target[] = [];
  let workspaceId: string | null = null;

  for (const p of allowed) {
    const meta = adapter.getProjectMeta(p.lovable_project_id) as {
      name: string | null;
      workspace_id: string | null;
    } | null;
    targets.push({
      target: "project",
      id: p.lovable_project_id,
      name: meta?.name ?? p.lovable_project_id,
    });
    if (!workspaceId && meta?.workspace_id) workspaceId = meta.workspace_id;
  }

  if (!workspaceId && executor) {
    try {
      workspaceId = executor.auth.status().workspaces[0]?.id ?? null;
    } catch {
      workspaceId = null;
    }
  }
  if (workspaceId) targets.push({ target: "workspace", id: workspaceId, name: "Workspace" });

  const allVersions = adapter.listKnowledgeVersions() as {
    id: number;
    target: string;
    project_id: string | null;
    workspace_id: string | null;
    status: string;
    created_at: string;
    written_at: string | null;
    actor: string;
    reason: string | null;
    restored_from_version_id: number | null;
    new_content: string;
  }[];
  const pendingWrites = adapter.listPendingKnowledgeWrites() as {
    id: number;
    target: string;
    project_id: string | null;
    workspace_id: string | null;
    created_at: string;
  }[];

  const targetsOut = targets.map((t) => {
    const current = adapter.latestKnowledgeSnapshot(t.target, t.id);
    const activeRules = adapter.activeRulesForTarget(t.target, t.id) as {
      id: number;
      instruction: string;
    }[];
    const versions = allVersions
      .filter((v) => versionMatchesTarget(v, t))
      .map((v) => ({
        id: v.id,
        status: v.status,
        created_at: v.created_at,
        written_at: v.written_at,
        actor: v.actor,
        reason: v.reason,
        restored_from_version_id: v.restored_from_version_id,
        char_count: v.new_content.length,
      }));
    const pendingForTarget = pendingWrites
      .filter((p) => versionMatchesTarget(p, t))
      .sort((a, b) => b.id - a.id)[0];

    return {
      target: t.target,
      id: t.id,
      name: t.name,
      current: current
        ? { content: current.content, sha256: current.sha256, fetched_at: current.fetched_at }
        : null,
      managed_block_present: current ? current.content.includes(HARNESS_START_MARKER) : false,
      active_rules: activeRules.map((r) => ({
        id: r.id,
        text: r.instruction,
        improvement_id: adapter.getCorrectionIdForRule(r.id),
      })),
      versions,
      pending_write: pendingForTarget
        ? { version_id: pendingForTarget.id, created_at: pendingForTarget.created_at }
        : null,
    };
  });

  let skills: {
    fetched_at: string;
    items: {
      name: string;
      description: string | null;
      updated_at: string | null;
      content: string;
    }[];
  } | null = null;
  if (workspaceId) {
    const snapshots = adapter.latestSkillSnapshots(workspaceId);
    if (snapshots.length > 0) {
      const fetched_at = snapshots.reduce(
        (max, s) => (s.fetched_at > max ? s.fetched_at : max),
        snapshots[0]!.fetched_at,
      );
      skills = {
        fetched_at,
        items: snapshots.map((s) => ({
          name: s.name,
          description: s.description,
          updated_at: s.updated_at_remote,
          content: s.content,
        })),
      };
    }
  }

  return {
    available: true as const,
    targets: targetsOut,
    skills,
    awaiting_analysis: adapter.countHistoryItemsAwaitingAnalysis(),
  };
}

async function handleGet({ request }: { request: Request }) {
  const unauthorized = await requireAuth(request);
  if (unauthorized) return unauthorized;

  const adapter = await loadHarnessAdapter();
  if (!adapter) return Response.json(hostedPreviewBody());

  try {
    return Response.json(await buildKnowledgeResponse(adapter));
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
    if (body["action"] !== "restore") throw new Error(`unknown action: ${String(body["action"])}`);
    const versionId = Number(body["version_id"]);
    if (!Number.isInteger(versionId)) throw new Error("version_id must be an integer");
    const version = adapter.createRestoreVersion(versionId, "operator (local UI)") as {
      id: number;
    };
    return Response.json({ available: true, version_id: version.id });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}

export const Route = createFileRoute("/api/public/harness/knowledge")({
  server: { handlers: { GET: handleGet, POST: handlePost } },
});
