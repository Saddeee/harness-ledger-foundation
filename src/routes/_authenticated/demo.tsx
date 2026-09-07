import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/demo")({
  head: () => ({
    meta: [
      { title: "Demo — Harness Ledger" },
      { name: "description", content: "Demo scenarios will appear here." },
      { property: "og:title", content: "Demo — Harness Ledger" },
      { property: "og:description", content: "Demo scenarios will appear here." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Page,
});

function Page() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Demo</h1>
      <div className="rounded-md border border-dashed p-10 text-center text-sm text-muted-foreground">
        Demo scenarios will appear here.
      </div>
    </div>
  );
}
