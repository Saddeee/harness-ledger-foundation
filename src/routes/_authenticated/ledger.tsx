import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/ledger")({
  head: () => ({
    meta: [
      { title: "Ledger — Harness Ledger" },
      { name: "description", content: "Proposed and applied learnings will appear here." },
      { property: "og:title", content: "Ledger — Harness Ledger" },
      { property: "og:description", content: "Proposed and applied learnings will appear here." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Page,
});

function Page() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Ledger</h1>
      <div className="rounded-md border border-dashed p-10 text-center text-sm text-muted-foreground">
        Proposed and applied learnings will appear here.
      </div>
    </div>
  );
}
