import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { runtimeQueryOptions } from "@/lib/improvements-client";
import { HostedProjects } from "@/components/harness/hosted-projects";
import { LocalProjects } from "@/components/harness/local-projects";

export const Route = createFileRoute("/_authenticated/projects")({
  validateSearch: (s: Record<string, unknown>) => ({
    connected: s["connected"] === 1 || s["connected"] === "1" ? 1 : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Projects — Harness Ledger" },
      { name: "description", content: "Connect Lovable and choose which projects to work on." },
      { property: "og:title", content: "Projects — Harness Ledger" },
      {
        property: "og:description",
        content: "Connect Lovable and choose which projects to work on.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Page,
});

// Render nothing until the runtime answers: the hosted page fetches the
// hosted-only Lovable connection route on mount, which fails (500) on a
// local runtime if it renders even briefly while `mode` is still loading.
function Page() {
  const runtime = useQuery(runtimeQueryOptions);
  const { connected } = Route.useSearch();
  const mode = runtime.data?.mode;
  if (runtime.isLoading) return null;
  return mode === "local" ? <LocalProjects /> : <HostedProjects connected={connected} />;
}
