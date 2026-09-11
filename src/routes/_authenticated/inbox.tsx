import { createFileRoute, useNavigate } from "@tanstack/react-router";
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

  const query = useQuery({ queryKey: ["harness-improvements"], queryFn: fetchImprovements });
  const refresh = () => qc.invalidateQueries({ queryKey: ["harness-improvements"] });
  const open = (id: number) => navigate({ to: "/inbox", search: { improvement: id } });
  const back = () => navigate({ to: "/inbox", search: {} });

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
  const selected =
    search.improvement != null ? all.find((i) => i.id === search.improvement) : undefined;
  if (selected) {
    return (
      <ImprovementDetail item={selected} onBack={back} onChanged={refresh} backLabel="← Inbox" />
    );
  }

  // Only what still needs a decision. Everything decided is under Improvements.
  const pending = all.filter((i) => i.decision.status === "pending");

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Inbox</h1>
      {pending.length === 0 ? (
        <div className="rounded-md border border-dashed p-10 text-center text-sm text-muted-foreground">
          {all.length === 0
            ? "Improvements Harness finds in your Lovable chats will appear here."
            : "Nothing needs your decision. Everything you've decided on is under Improvements."}
        </div>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {pending.length === 1
              ? "One improvement is waiting for your decision."
              : `${pending.length} improvements are waiting for your decision.`}
          </p>
          <ul className="space-y-3">
            {pending.map((i) => (
              <li key={i.id}>
                <DecisionCard item={i} onChanged={refresh} onOpen={open} />
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
