// Server-only bridge to the local Harness SQLite adapter. Never imports
// better-sqlite3 or harness/src/store.ts directly -- only reaches it through
// loadHarnessAdapter(), which is a no-op on any deployment where
// HARNESS_RUNTIME != "local" (i.e. the hosted preview). No arbitrary SQL and
// no generic mutation endpoint: every action here is one of the six named
// review actions, or a summary edit, both validated by the adapter.
import { createFileRoute } from "@tanstack/react-router";
import { hostedPreviewBody, loadHarnessAdapter } from "@/lib/server/harness-runtime";

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

async function handleGet({ request }: { request: Request }) {
  const unauthorized = await requireAuth(request);
  if (unauthorized) return unauthorized;

  const adapter = await loadHarnessAdapter();
  if (!adapter) return Response.json(hostedPreviewBody());
  try {
    return Response.json({ available: true, corrections: adapter.listCorrections() });
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
    if (body["kind"] === "edit_summary") {
      const updated = adapter.editCorrectionSummary(body);
      return Response.json({ available: true, correction: updated });
    }
    if (body["kind"] === "human_decision") {
      const updated = adapter.recordHumanCorrectionDecision(body);
      return Response.json({ available: true, correction: updated });
    }
    // default: a review action (confirm / reclassify / mark_one_time / mark_reusable / change_scope / exclude)
    const updated = adapter.reviewCorrection(body);
    return Response.json({ available: true, correction: updated });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}

export const Route = createFileRoute("/api/public/harness/corrections")({
  server: { handlers: { GET: handleGet, POST: handlePost } },
});
