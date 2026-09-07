import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/versions")({
  head: () => ({
    meta: [
      { title: "Versions — Harness Ledger" },
      { name: "description", content: "Knowledge and skill version history will appear here." },
      { property: "og:title", content: "Versions — Harness Ledger" },
      { property: "og:description", content: "Knowledge and skill version history will appear here." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Page,
});

function Page() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Versions</h1>
      <div className="rounded-md border border-dashed p-10 text-center text-sm text-muted-foreground">
        Knowledge and skill version history will appear here.
      </div>
    </div>
  );
}
