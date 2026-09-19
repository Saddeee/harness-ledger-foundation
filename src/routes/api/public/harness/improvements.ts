// Server-only bridge to the local Harness SQLite adapter, mirroring
// corrections.ts. An "improvement" is the user-facing view of one piece of
// Lovable feedback: correction + rule + proof plan presented as a single
// item. Every action here maps onto the existing local mutations (human
// decision, review, rule update); nothing reaches Lovable.
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

/** Real connected status via the executor bundle, same pattern knowledge.ts's
 * own POST handler already uses -- never throws (a load/status failure just
 * reads as "not connected", the same fail-closed default TestInfo itself
 * uses when `connected` is omitted). */
async function isConnected(): Promise<boolean> {
  try {
    const executor = await loadHarnessExecutor();
    return executor ? executor.auth.status().connected : false;
  } catch {
    return false;
  }
}

async function handleGet({ request }: { request: Request }) {
  const unauthorized = await requireAuth(request);
  if (unauthorized) return unauthorized;

  const adapter = await loadHarnessAdapter();
  if (!adapter) return Response.json(hostedPreviewBody());
  try {
    // Round 6 Task 6b / spec §6: the judging screen's own read -- same
    // route as the improvements list (?run=<id>), not a seventh one.
    const runParam = new URL(request.url).searchParams.get("run");
    if (runParam !== null) {
      const runId = Number(runParam);
      if (!Number.isInteger(runId)) {
        return Response.json({ error: "run must be an integer" }, { status: 400 });
      }
      const run = adapter.buildExperimentRunView(runId);
      if (!run) {
        return Response.json({ available: false, reason: `run ${runId} not found` });
      }
      return Response.json({ available: true, run });
    }

    // Round 6c part B: the Tests page's own read -- same route as
    // everything else here (?runs=1), not a seventh one.
    if (new URL(request.url).searchParams.get("runs") !== null) {
      return Response.json({ available: true, runs: adapter.listTestRunSummaries() });
    }

    // Checkpoint 3 I1: the Inbox's own read (?inbox=1) -- same route as
    // everything else here, not a seventh one. adapter.listInboxItems is
    // the single Inbox aggregation the whole app reads (see its own header
    // comment); this branch adds no logic of its own beyond the connected
    // flag every other branch here already computes the same way.
    if (new URL(request.url).searchParams.get("inbox") !== null) {
      const connected = await isConnected();
      return Response.json({
        available: true,
        items: adapter.listInboxItems({ connected }),
        count: adapter.inboxCount({ connected }),
      });
    }

    const settings = adapter.getSettings();
    return Response.json({
      available: true,
      improvements: adapter.listImprovements({ connected: await isConnected() }),
      // Task C3 / spec §4b display + §5 notifications: a server-computed
      // count (pending improvements + open retirement proposals) for the
      // sidebar badge, and when the Inbox was last opened, for the "New"
      // marker. Additive -- the improvements list itself is unchanged.
      counts: {
        ...adapter.countInboxItems(),
        // Round 5 Task 6 / spec §4: the Inbox's automatic-mode empty state
        // ("Harness accepted N suggestions automatically since your last
        // visit") -- 0 when the setting is "" (never visited), same
        // convention as the "New" marker above.
        auto_accepted_since_seen: settings.inbox_last_seen_at
          ? adapter.countAutoAcceptedSince(settings.inbox_last_seen_at)
          : 0,
      },
      last_seen_at: settings.inbox_last_seen_at,
    });
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

  // Task C3: "mark_seen" records that the Inbox was just opened -- not an
  // Improvement mutation (it returns no improvement), so it's handled here
  // rather than going through improvementAction's discriminated union.
  if (body["action"] === "mark_seen") {
    try {
      adapter.setSettings({ inbox_last_seen_at: new Date().toISOString() });
      return Response.json({ available: true, ok: true });
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
    }
  }

  // Round 8 Task 2 (review item 2): "Dismiss" on a failed action -- purely
  // local (adapter.dismissInboxItem), never an Improvement mutation, so it's
  // handled here the same way "mark_seen" is, before the discriminated-union
  // action below.
  if (body["action"] === "dismiss_inbox_item") {
    try {
      const itemId = String(body["item_id"] ?? "");
      const result = adapter.dismissInboxItem(itemId);
      return Response.json({ available: true, ok: result.ok, item_id: result.item_id });
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
    }
  }

  // Round 6 Task 2: "Try again" on a not-written outcome -- re-runs
  // executeVersionNow on the exact version that didn't write (reopening it
  // first if it's stale/failed), addressed by version id alone. Not an
  // improvementAction (there is no new decision), so it's handled here
  // too, before the discriminated-union action below; `id` (the
  // improvement whose card is asking) is only used to refetch it for the
  // response.
  if (body["action"] === "retry_write") {
    try {
      const versionId = Number(body["version_id"]);
      if (!Number.isInteger(versionId)) throw new Error("version_id must be an integer");
      const write = await adapter.retryKnowledgeWrite(versionId);
      const id = Number(body["id"]);
      const improvement = Number.isInteger(id)
        ? adapter.getImprovement(id, { connected: await isConnected() })
        : null;
      return Response.json({ available: true, ...(improvement ? { improvement } : {}), write });
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
    }
  }

  try {
    // Round 6 Task 2 / spec §2: a decision the user just pressed writes to
    // Lovable in this same request when Harness is connected -- see
    // improvementActionAndWrite's own header comment
    // (harness/src/executor/beats.ts). Every response now carries `write`
    // alongside the item for the actions that attempt one.
    const improvement = await adapter.improvementActionAndWrite(body);
    return Response.json({ available: true, improvement, write: improvement.write });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}

export const Route = createFileRoute("/api/public/harness/improvements")({
  server: { handlers: { GET: handleGet, POST: handlePost } },
});
