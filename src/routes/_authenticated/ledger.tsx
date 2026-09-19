import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ImprovementDetail } from "@/components/harness/improvement";
import { fetchImprovements } from "@/lib/improvements-client";

// Checkpoint 3 I2: the Inbox is the single decision queue now -- this route
// keeps existing bookmarks and the old /improvements, /suggestions redirects
// working, but it is no longer a page of its own. Opened without
// ?improvement=, it redirects straight to /inbox (beforeLoad, not a
// post-render <Navigate>, so nothing here ever renders -- and never fetches
// -- before bouncing). Opened with ?improvement=<id>, it renders the exact
// same ImprovementDetail the Inbox links to; Previous/Next browse every
// improvement Harness Ledger knows about (not just what's currently in the
// Inbox), since a decided item is still a valid deep link here.
export const Route = createFileRoute("/_authenticated/ledger")({
  validateSearch: (search: Record<string, unknown>): { improvement?: number } => {
    const raw = search["improvement"];
    const id = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : undefined;
    return id != null && Number.isFinite(id) ? { improvement: id } : {};
  },
  beforeLoad: ({ search }) => {
    if (search.improvement == null) throw redirect({ to: "/inbox" });
  },
  head: () => ({
    meta: [
      { title: "Suggestion — Harness Ledger" },
      { name: "description", content: "Where this suggestion stands." },
      { property: "og:title", content: "Suggestion — Harness Ledger" },
      { property: "og:description", content: "Where this suggestion stands." },
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
  const open = (id: number) => navigate({ to: "/ledger", search: { improvement: id } });
  const back = () => navigate({ to: "/inbox" });

  if (query.isLoading) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Suggestion</h1>
        <div className="rounded-md border p-6 text-sm text-muted-foreground">Loading…</div>
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Suggestion</h1>
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
        <h1 className="text-2xl font-semibold">Suggestion</h1>
        <div className="rounded-md border border-dashed p-10 text-center text-sm text-muted-foreground">
          {query.data.reason}
        </div>
      </div>
    );
  }

  // Checkpoint 3 I2: this route no longer renders a list of its own (see
  // beforeLoad above) -- Previous/Next now browse every improvement Harness
  // Ledger knows about, in the order the API returns them, not the old
  // Open/Waiting-to-be-written/Waiting-to-be-tested/Decided-earlier grouping
  // (that grouped page is gone; the Inbox is the only queue now).
  const all = query.data?.improvements ?? [];
  const order = all.map((i) => i.id);

  const selected =
    search.improvement != null ? all.find((i) => i.id === search.improvement) : undefined;
  if (selected) {
    const idx = order.indexOf(selected.id);
    return (
      <ImprovementDetail
        item={selected}
        onBack={back}
        onChanged={refresh}
        backLabel="← Inbox"
        position={idx >= 0 ? { index: idx + 1, total: order.length } : undefined}
        onPrev={idx > 0 ? () => open(order[idx - 1]!) : undefined}
        onNext={idx >= 0 && idx < order.length - 1 ? () => open(order[idx + 1]!) : undefined}
      />
    );
  }

  // search.improvement named an id that no longer exists (or a stale link) --
  // beforeLoad only guards the "no id at all" case, since it can't check the
  // list itself (no data yet at that point). Send the owner back to the
  // Inbox rather than showing an empty husk of the old grouped page.
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Suggestion</h1>
      <div className="rounded-md border border-dashed p-10 text-center text-sm text-muted-foreground">
        That suggestion could not be found.{" "}
        <button
          type="button"
          className="text-primary underline underline-offset-2"
          onClick={() => navigate({ to: "/inbox" })}
        >
          Back to Inbox
        </button>
      </div>
    </div>
  );
}
