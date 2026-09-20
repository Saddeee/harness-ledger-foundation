import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/scoreboard")({
  head: () => ({
    meta: [
      { title: "Scoreboard — Harness Ledger" },
      { name: "description", content: "Instruction scores from real builds will appear here." },
      { property: "og:title", content: "Scoreboard — Harness Ledger" },
      {
        property: "og:description",
        content: "Instruction scores from real builds will appear here.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Page,
});

function Page() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Scoreboard</h1>
      <div className="rounded-md border border-dashed p-10 text-center text-sm text-muted-foreground">
        Instruction scores from real builds will appear here.
      </div>
    </div>
  );
}
