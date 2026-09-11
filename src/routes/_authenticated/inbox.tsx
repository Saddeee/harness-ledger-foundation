import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DecisionCard, ImprovementDetail } from "@/components/harness/improvement";
import { fetchImprovements } from "@/lib/improvements-client";

export const Route = createFileRoute("/_authenticated/inbox")({
  validateSearch: (search: Record<string, unknown>): { improvement?: number } => {
    const raw = search["improvement"];
    const id = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : undefined;
    return id != null && Number.isFinite(id) ? { improvement: id } : {};
  },
  head: () => ({
    meta: [
      { title: "Inbox — Harness Ledger" },
      { name: "description", content: "Improvements waiting for your decision." },
      { property: "og:title", content: "Inbox — Harness Ledger" },
      { property: "og:description", content: "Improvements waiting for your decision." },
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
  // Items decided this visit stay visible (chip, status, decision buttons)
  // instead of vanishing from the list; cleared by "Hide decided" or by
  // leaving the page.
  const [decidedIds, setDecidedIds] = useState<Set<number>>(new Set());

  const query = useQuery({ queryKey: ["harness-improvements"], queryFn: fetchImprovements });
  const refresh = () => qc.invalidateQueries({ queryKey: ["harness-improvements"] });
  const open = (id: number) => navigate({ to: "/inbox", search: { improvement: id } });
  const back = () => navigate({ to: "/inbox", search: {} });
  const markDecided = (id: number) => {
    refresh();
    setDecidedIds((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  };

  if (query.isLoading) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Inbox</h1>
        <div className="rounded-md border p-6 text-sm text-muted-foreground">Loading…</div>
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Inbox</h1>
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
        <h1 className="text-2xl font-semibold">Inbox</h1>
        <div className="rounded-md border border-dashed p-10 text-center text-sm text-muted-foreground">
          {query.data.reason}
        </div>
      </div>
    );
  }

  const all = query.data?.improvements ?? [];
  // Still needs a decision, plus anything decided this visit (so the card
  // stays in place instead of vanishing) -- in their original order.
  const pending = all.filter((i) => i.decision.status === "pending");
  const list = all.filter((i) => i.decision.status === "pending" || decidedIds.has(i.id));
  // Previous/Next browse the pending order -- the list the user came from.
  const order = pending.map((i) => i.id);

  const selected =
    search.improvement != null ? all.find((i) => i.id === search.improvement) : undefined;
  if (selected) {
    const idx = order.indexOf(selected.id);
    return (
      <ImprovementDetail
        item={selected}
        onBack={back}
        onChanged={() => markDecided(selected.id)}
        backLabel="← Inbox"
        position={idx >= 0 ? { index: idx + 1, total: order.length } : undefined}
        onPrev={idx > 0 ? () => open(order[idx - 1]!) : undefined}
        onNext={idx >= 0 && idx < order.length - 1 ? () => open(order[idx + 1]!) : undefined}
      />
    );
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Inbox</h1>
      {list.length === 0 ? (
        <div className="rounded-md border border-dashed p-10 text-center text-sm text-muted-foreground">
          {all.length === 0
            ? "Improvements Harness finds in your Lovable chats will appear here."
            : "Nothing needs your decision. Everything you've decided on is under Improvements."}
        </div>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {pending.length === 0
              ? // Cards are still on screen (just decided), so pointing at
                // another page would be wrong -- they are right here.
                "Nothing left to decide."
              : pending.length === 1
                ? "One improvement is waiting for your decision."
                : `${pending.length} improvements are waiting for your decision.`}
          </p>
          {decidedIds.size > 0 ? (
            <button
              type="button"
              className="text-sm text-primary underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => setDecidedIds(new Set())}
            >
              Hide decided
            </button>
          ) : null}
          <ul className="space-y-3">
            {list.map((i) => (
              <li key={i.id}>
                <DecisionCard item={i} onChanged={() => markDecided(i.id)} onOpen={open} />
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
