// Server-only bridge to the local Harness SQLite adapter for the
// Instructions page: what Lovable Knowledge currently looks like per
// project/workspace and which rules are active in each. The full write
// history moved to the History page's timeline (Round 5 Task 3/4, see the
// `timeline=` branch below and harness/src/improvements.ts's buildTimeline).
// Skills moved to skills.ts (Round 3 Task 2). Nothing here writes to
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

type KnowledgeVersionStatus = "written" | "pending" | "stale" | "failed";
type ActiveRuleStatus = KnowledgeVersionStatus | "testing";

// Task 3 / spec §3a: the Instructions page's rules table status column --
// the newest non-cancelled knowledge_version for the rule, or "testing"
// when nothing has been staged yet because the rule is waiting on a
// "Test it first" run rather than a normal write.
function ruleStatus(
  ruleVersions: { status: string }[],
  improvement: { decision: { test_first: boolean }; lovable: { write_status: string } } | null,
): ActiveRuleStatus {
  const latest = ruleVersions.find((v) => v.status !== "cancelled");
  if (latest) return latest.status as KnowledgeVersionStatus;
  if (improvement?.decision.test_first && improvement.lovable.write_status === "none")
    return "testing";
  // No version yet and not test-first: e.g. accepted before Harness had
  // ever read a Knowledge snapshot to compose against (stagePendingWrite /
  // stageApprovedWrites in improvements.ts) -- a real write is expected at
  // the next sync, so "pending" is the closest honest status.
  return "pending";
}

// Every project/workspace target this local runtime knows about, with the
// display name each carries on the Knowledge and History pages -- shared by
// buildKnowledgeResponse's own targets list and the `timeline=` branch
// below, which needs the same name resolution for one target picked by id.
async function resolveTargets(adapter: Adapter): Promise<Target[]> {
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

  return targets;
}

async function buildKnowledgeResponse(adapter: Adapter) {
  const targets = await resolveTargets(adapter);

  const allVersions = adapter.listKnowledgeVersions() as {
    id: number;
    rule_id: number | null;
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
        const improvementId = adapter.getCorrectionIdForRule(r.id);
        const improvement = improvementId != null ? adapter.getImprovement(improvementId) : null;
        const ruleVersions = allVersions.filter((v) => v.rule_id === r.id);
        const latestVerdict = adapter.latestRuleVerdict(r.id) as {
          verdict: "helped" | "did_not_help" | "not_sure";
          created_at: string;
        } | null;
        const adherenceRows = adapter.listRuleAdherence(r.id) as unknown[];
        return {
          id: r.id,
          text: r.instruction,
          improvement_id: improvementId,
          health: health
            ? {
                applicable_tasks: health.applicable_tasks,
                helped: health.helped,
                hurt: health.hurt,
                last_applicable_at: health.last_applicable_at,
                since: firstWrittenAtByRuleId.get(r.id) ?? null,
              }
            : null,
          // Round 5 Task 3 / spec §3a: the rules table's Status/Since/
          // Observed columns.
          status: ruleStatus(ruleVersions, improvement),
          since: firstWrittenAtByRuleId.get(r.id) ?? null,
          verdict: latestVerdict
            ? { verdict: latestVerdict.verdict, created_at: latestVerdict.created_at }
            : null,
          adherence: adherenceRows.length > 0 ? adapter.adherenceCounts(r.id) : null,
        };
      }),
      retired_rules: retiredRules.map((r) => ({
        id: r.id,
        text: r.instruction,
        improvement_id: adapter.getCorrectionIdForRule(r.id),
      })),
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

// Round 5 Task 3 / spec §3b: the History page's per-target timeline, at
// GET .../knowledge?timeline=project:<id> or ?timeline=workspace:<id>. The
// node-building itself is a pure read in harness/src/improvements.ts
// (buildTimeline); this only resolves the target's display name, the same
// way buildKnowledgeResponse's own targets list does.
async function buildTimelineResponse(
  adapter: Adapter,
  target: "project" | "workspace",
  id: string,
) {
  const targets = await resolveTargets(adapter);
  const found = targets.find((t) => t.target === target && t.id === id);
  const name =
    found?.name ??
    (target === "workspace"
      ? "Workspace"
      : ((adapter.getProjectMeta(id) as { name: string | null } | null)?.name ?? id));
  return {
    available: true as const,
    target,
    id,
    name,
    nodes: adapter.buildTimeline(target, id),
  };
}

async function handleGet({ request }: { request: Request }) {
  const unauthorized = await requireAuth(request);
  if (unauthorized) return unauthorized;

  const adapter = await loadHarnessAdapter();
  if (!adapter) return Response.json(hostedPreviewBody());

  try {
    const timelineParam = new URL(request.url).searchParams.get("timeline");
    if (timelineParam !== null) {
      const sep = timelineParam.indexOf(":");
      const target = sep === -1 ? "" : timelineParam.slice(0, sep);
      const id = sep === -1 ? "" : timelineParam.slice(sep + 1);
      if (target !== "project" && target !== "workspace")
        throw new Error(`invalid timeline target: "${timelineParam}"`);
      return Response.json(await buildTimelineResponse(adapter, target, id));
    }
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
