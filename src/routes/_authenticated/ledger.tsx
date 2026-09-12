import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DecisionCard, ImprovementDetail } from "@/components/harness/improvement";
import { IMPROVEMENT_GROUPS, type ImprovementGroup } from "@/lib/harness-ux";
import { fetchImprovements, groupOf, type Improvement } from "@/lib/improvements-client";

export const Route = createFileRoute("/_authenticated/ledger")({
  validateSearch: (search: Record<string, unknown>): { improvement?: number } => {
    const raw = search["improvement"];
    const id = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : undefined;
    return id != null && Number.isFinite(id) ? { improvement: id } : {};
  },
  head: () => ({
    meta: [
      { title: "Suggestions — Harness Ledger" },
      { name: "description", content: "Where each suggestion stands." },
      { property: "og:title", content: "Suggestions — Harness Ledger" },
      { property: "og:description", content: "Where each suggestion stands." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Page,
});

function Page() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const search = Route.useSearch();
  const [filter, setFilter] = useState<string>("all");

  const query = useQuery({ queryKey: ["harness-improvements"], queryFn: fetchImprovements });
  const refresh = () => qc.invalidateQueries({ queryKey: ["harness-improvements"] });
  const open = (id: number) => navigate({ to: "/ledger", search: { improvement: id } });
  const back = () => navigate({ to: "/ledger", search: {} });

  if (query.isLoading) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Suggestions</h1>
        <div className="rounded-md border p-6 text-sm text-muted-foreground">Loading…</div>
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Suggestions</h1>
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
        <h1 className="text-2xl font-semibold">Suggestions</h1>
        <div className="rounded-md border border-dashed p-10 text-center text-sm text-muted-foreground">
          {query.data.reason}
        </div>
      </div>
    );
  }

  const all = query.data?.improvements ?? [];
  // Pending items live in Inbox, not here.
  const grouped = new Map<ImprovementGroup, Improvement[]>();
  for (const item of all) {
    const g = groupOf(item);
    if (!g) continue;
    grouped.set(g, [...(grouped.get(g) ?? []), item]);
  }
  // Previous/Next browse the grouped order -- the list the user came from.
  const order = IMPROVEMENT_GROUPS.flatMap((g) => grouped.get(g) ?? []).map((i) => i.id);

  const selected =
    search.improvement != null ? all.find((i) => i.id === search.improvement) : undefined;
  if (selected) {
    const idx = order.indexOf(selected.id);
    return (
      <ImprovementDetail
        item={selected}
        onBack={back}
        onChanged={refresh}
        backLabel="← Suggestions"
        position={idx >= 0 ? { index: idx + 1, total: order.length } : undefined}
        onPrev={idx > 0 ? () => open(order[idx - 1]!) : undefined}
        onNext={idx >= 0 && idx < order.length - 1 ? () => open(order[idx + 1]!) : undefined}
      />
    );
  }

  const listed = [...grouped.values()].reduce((n, arr) => n + arr.length, 0);
  const showFilters = listed > 5;
  const groups = IMPROVEMENT_GROUPS.filter(
    (g) => (filter === "all" || g === filter) && (grouped.get(g)?.length ?? 0) > 0,
  );

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Suggestions</h1>

      {showFilters ? (
        <details className="rounded-md border">
          <summary className="cursor-pointer px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            Filter
          </summary>
          <div className="flex flex-wrap gap-2 border-t p-3">
            {["all", ...IMPROVEMENT_GROUPS].map((t) => (
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

      {listed === 0 ? (
        <div className="rounded-md border border-dashed p-10 text-center text-sm text-muted-foreground">
          {all.length === 0
            ? "Suggestions Harness finds in your Lovable chats will appear here."
            : "Nothing decided yet — what's waiting for you is in Inbox."}
        </div>
      ) : (
        groups.map((g) => {
          const items = grouped.get(g) ?? [];
          return (
            <section key={g} aria-labelledby={`group-${g}`} className="space-y-2">
              <h2 id={`group-${g}`} className="text-lg font-semibold">
                {g}{" "}
                <span className="text-sm font-normal text-muted-foreground">({items.length})</span>
              </h2>
              <ul className="space-y-3">
                {items.map((i) => (
                  <li key={i.id}>
                    <DecisionCard item={i} onChanged={refresh} onOpen={open} />
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
