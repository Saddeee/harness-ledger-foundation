import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Harness Ledger" },
      { name: "description", content: "Harness Ledger" },
      { property: "og:title", content: "Harness Ledger" },
      { property: "og:description", content: "Harness Ledger" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Index,
});

function Index() {
  return (
    <main className="flex min-h-screen items-center justify-center">
      <h1 className="text-4xl font-semibold">Harness Ledger</h1>
    </main>
  );
}
