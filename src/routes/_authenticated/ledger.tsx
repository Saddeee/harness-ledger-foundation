import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ImprovementCard, ImprovementDetail } from "@/components/harness/improvement";
import { fetchImprovements, stageComplete, type Improvement } from "@/lib/improvements-client";

export const Route = createFileRoute("/_authenticated/ledger")({
  validateSearch: (search: Record<string, unknown>) => ({
    improvement:
      typeof search["improvement"] === "number"
        ? search["improvement"]
        : typeof search["improvement"] === "string"
          ? Number(search["improvement"])
          : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Improvements — Harness Ledger" },
      { name: "description", content: "Everything Harness has learned from your Lovable chats." },
      { property: "og:title", content: "Improvements — Harness Ledger" },
      {
        property: "og:description",
        content: "Everything Harness has learned from your Lovable chats.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Page,
});

const GROUPS: { title: string; matches: (i: Improvement) => boolean }[] = [
  { title: "Needs your decision", matches: (i) => i.decision.status === "pending" },
  {
    title: "Waiting for proof",
    matches: (i) => i.decision.status === "accepted" && !stageComplete(i, "proof"),
  },
  {
    title: "Ready to add",
    matches: (i) =>
      i.decision.status === "accepted" &&
      stageComplete(i, "proof") &&
      !stageComplete(i, "in_lovable"),
  },
  { title: "In Lovable", matches: (i) => stageComplete(i, "in_lovable") },
  { title: "Skipped", matches: (i) => i.decision.status === "skipped" },
];

function Page() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const search = Route.useSearch();
  const [filter, setFilter] = useState<string>("all");

  const query = useQuery({ queryKey: ["harness-improvements"], queryFn: fetchImprovements });
  const refresh = () => qc.invalidateQueries({ queryKey: ["harness-improvements"] });
  const open = (id: number) => navigate({ to: "/ledger", search: { improvement: id } });
  const back = () => navigate({ to: "/ledger", search: { improvement: undefined } });

  if (query.isLoading) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Improvements</h1>
        <div className="rounded-md border p-6 text-sm text-muted-foreground">Loading…</div>
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Improvements</h1>
        <div
          role="alert"
          className="rounded-md border border-destructive/50 bg-destructive/5 p-6 text-sm text-destructive"
        >
          {query.error instanceof Error ? query.error.message : "Failed to load."}
        </div>
      </div>
    );
  }
  if (query.data && query.data.available === false) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Improvements</h1>
        <div className="rounded-md border border-dashed p-10 text-center text-sm text-muted-foreground">
          {query.data.reason}
        </div>
      </div>
    );
  }

  const all = query.data?.improvements ?? [];
  const selected =
    search.improvement != null ? all.find((i) => i.id === search.improvement) : undefined;
  if (selected) {
    return (
      <ImprovementDetail
        item={selected}
        onBack={back}
        onChanged={refresh}
        backLabel="← Improvements"
      />
    );
  }

  const showFilters = all.length > 5;
  const groups = GROUPS.filter((g) => filter === "all" || g.title === filter);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Improvements</h1>
        <p className="text-sm text-muted-foreground">
          {all.length === 0
            ? "Nothing here yet."
            : "Everything Harness has learned from your Lovable chats, and where each one stands."}
        </p>
      </div>

      {showFilters ? (
        <details className="rounded-md border">
          <summary className="cursor-pointer px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            Filter
          </summary>
          <div className="flex flex-wrap gap-2 border-t p-3">
            {["all", ...GROUPS.map((g) => g.title)].map((t) => (
              <Button
                key={t}
                size="sm"
                variant={filter === t ? "default" : "outline"}
                onClick={() => setFilter(t)}
              >
                {t === "all" ? "All" : t}
              </Button>
            ))}
          </div>
        </details>
      ) : null}

      {all.length === 0 ? (
        <div className="rounded-md border border-dashed p-10 text-center text-sm text-muted-foreground">
          Improvements Harness finds in your Lovable chats will appear here.
        </div>
      ) : (
        groups.map((g) => {
          const items = all.filter(g.matches);
          if (items.length === 0) return null;
          return (
            <section key={g.title} aria-labelledby={`group-${g.title}`} className="space-y-2">
              <h2 id={`group-${g.title}`} className="text-lg font-semibold">
                {g.title}{" "}
                <span className="text-sm font-normal text-muted-foreground">({items.length})</span>
              </h2>
              <ul className="space-y-3">
                {items.map((i) => (
                  <li key={i.id}>
                    <ImprovementCard item={i} onOpen={open} />
                  </li>
                ))}
              </ul>
            </section>
          );
        })
      )}
    </div>
  );
}
