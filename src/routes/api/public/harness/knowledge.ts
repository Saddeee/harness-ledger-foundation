// Server-only bridge to the local Harness SQLite adapter for the Knowledge
// page: what Lovable Knowledge currently looks like per project/workspace,
// which rules are active in each, and the version history of writes Harness
// has made (each version carries a server-computed "What changed" line
// diff). Skills moved to skills.ts (Round 3 Task 2). Nothing here writes to
// Lovable directly -- "restore" only stages a new pending version; the
// executor process performs the actual write.
import { createFileRoute } from "@tanstack/react-router";
import {
  hostedPreviewBody,
  loadHarnessAdapter,
  loadHarnessExecutor,
} from "@/lib/server/harness-runtime";

const HARNESS_START_MARKER = "<!-- harness:start -->";

// Spec section 2: "What changed" is capped so a huge rewrite still renders
// quickly; the UI is told when it was cut so it can offer "Show full change"
// against the raw content instead.
const MAX_DIFF_LINES = 400;

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
    previous_content: string;
    new_content: string;
  }[];
  const pendingWrites = adapter.listPendingKnowledgeWrites() as {
    id: number;
    target: string;
    project_id: string | null;
    workspace_id: string | null;
    created_at: string;
  }[];

  // Task C3 / spec §4/§4b: each live rule's "since added" health line.
  // first_written_at comes from listLiveRulesWithTargets (the same live-rule
  // scan rule_health itself is computed from); looked up once here rather
  // than per rule below.
  const firstWrittenAtByRuleId = new Map(
    (adapter.listLiveRulesWithTargets() as { id: number; first_written_at: string | null }[]).map(
      (r) => [r.id, r.first_written_at],
    ),
  );

  const targetsOut = targets.map((t) => {
    const current = adapter.latestKnowledgeSnapshot(t.target, t.id);
    const activeRules = adapter.activeRulesForTarget(t.target, t.id) as {
      id: number;
      instruction: string;
    }[];
    const retiredRules = adapter.retiredRulesForTarget(t.target, t.id) as {
      id: number;
      instruction: string;
    }[];
    const versions = allVersions
      .filter((v) => versionMatchesTarget(v, t))
      .map((v) => {
        const diff = adapter.lineDiff(v.previous_content, v.new_content);
        const truncated = diff.lines.length > MAX_DIFF_LINES;
        return {
          id: v.id,
          status: v.status,
          created_at: v.created_at,
          written_at: v.written_at,
          actor: v.actor,
          reason: v.reason,
          restored_from_version_id: v.restored_from_version_id,
          char_count: v.new_content.length,
          changes: {
            added: diff.added,
            removed: diff.removed,
            lines: truncated ? diff.lines.slice(0, MAX_DIFF_LINES) : diff.lines,
            truncated,
          },
        };
      });
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
      active_rules: activeRules.map((r) => {
        const health = adapter.getRuleHealth(r.id) as {
          applicable_tasks: number;
          helped: number;
          hurt: number;
          last_applicable_at: string | null;
        } | null;
        return {
          id: r.id,
          text: r.instruction,
          improvement_id: adapter.getCorrectionIdForRule(r.id),
          health: health
            ? {
                applicable_tasks: health.applicable_tasks,
                helped: health.helped,
                hurt: health.hurt,
                last_applicable_at: health.last_applicable_at,
                since: firstWrittenAtByRuleId.get(r.id) ?? null,
              }
            : null,
        };
      }),
      retired_rules: retiredRules.map((r) => ({
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

  return {
    available: true as const,
    targets: targetsOut,
    demo_loaded: adapter.demoLoaded(),
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
