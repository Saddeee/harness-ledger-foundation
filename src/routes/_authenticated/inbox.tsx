import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/inbox")({
  head: () => ({
    meta: [
      { title: "Inbox — Harness Ledger" },
      { name: "description", content: "Mined tasks awaiting triage will appear here." },
      { property: "og:title", content: "Inbox — Harness Ledger" },
      { property: "og:description", content: "Mined tasks awaiting triage will appear here." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Page,
});

function Page() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Inbox</h1>
      <div className="rounded-md border border-dashed p-10 text-center text-sm text-muted-foreground">
        Mined tasks awaiting triage will appear here.
      </div>
    </div>
  );
}
