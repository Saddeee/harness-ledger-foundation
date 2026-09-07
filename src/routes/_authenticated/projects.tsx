import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/projects")({
  head: () => ({
    meta: [
      { title: "Projects — Harness Ledger" },
      { name: "description", content: "Connected Lovable projects will appear here." },
      { property: "og:title", content: "Projects — Harness Ledger" },
      { property: "og:description", content: "Connected Lovable projects will appear here." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Page,
});

function Page() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Projects</h1>
      <div className="rounded-md border border-dashed p-10 text-center text-sm text-muted-foreground">
        Connected Lovable projects will appear here.
      </div>
    </div>
  );
}
