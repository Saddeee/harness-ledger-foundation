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

// While the runtime is still loading, `mode` is undefined -- not "local" --
// so the hosted page renders by default and nothing flashes when the answer
// turns out to be hosted (the common case in the preview environment).
function Page() {
  const runtime = useQuery(runtimeQueryOptions);
  const { connected } = Route.useSearch();
  const mode = runtime.data?.mode;
  return mode === "local" ? <LocalProjects /> : <HostedProjects connected={connected} />;
}
