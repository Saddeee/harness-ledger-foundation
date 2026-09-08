// Server-only bridge to the local Harness SQLite adapter, mirroring
// corrections.ts. "state" updates here only ever change a local rule row
// (see harness/src/store.ts updateRule) -- there is no code path in this
// route, the adapter, or the store that calls Lovable, writes Knowledge,
// touches a Skill, or spends a credit.
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
    return Response.json({ available: true, rules: adapter.listRules() });
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
    const updated = adapter.updateRuleAction(body);
    return Response.json({ available: true, rule: updated });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}

export const Route = createFileRoute("/api/public/harness/rules")({
  server: { handlers: { GET: handleGet, POST: handlePost } },
});
