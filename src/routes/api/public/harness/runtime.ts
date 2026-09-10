// Reports which runtime the app is in so the UI can hide hosted-era screens
// locally and hide local-only actions in the hosted preview. "local" iff the
// local Harness adapter can be loaded (HARNESS_RUNTIME=local and the compiled
// harness/dist is present); otherwise "hosted". No data is exposed.
import { createFileRoute } from "@tanstack/react-router";
import { loadHarnessAdapter } from "@/lib/server/harness-runtime";

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
  return Response.json({ mode: adapter ? "local" : "hosted" });
}

export const Route = createFileRoute("/api/public/harness/runtime")({
  server: { handlers: { GET: handleGet } },
});
