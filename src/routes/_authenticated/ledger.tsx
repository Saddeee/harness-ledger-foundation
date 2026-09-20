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
// same ImprovementDetail the Inbox links to; a decided item is still a valid
// deep link here.
// Round 9 Task 4 / spec §5 Detail: Previous/Next (and the "N of M" counter)
// are gone outright -- one instruction, one shape, read top to bottom, never
// a browsing widget of its own (spec principle 1). `from` (optional,
// "instructions") is new: the Instructions page (Round 9 Task 5) links here
// with it so the back link reads "← Instructions" and returns there, instead
// of always assuming the Inbox.
export const Route = createFileRoute("/_authenticated/ledger")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { improvement?: number; from?: "inbox" | "instructions" } => {
    const raw = search["improvement"];
    const id = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : undefined;
    const from = search["from"];
    return {
      ...(id != null && Number.isFinite(id) ? { improvement: id } : {}),
      ...(from === "instructions" ? { from } : {}),
    };
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
  const fromInstructions = search.from === "instructions";
  const back = () => navigate({ to: fromInstructions ? "/instructions" : "/inbox" });

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
  // beforeLoad above); the Inbox (or Instructions, when `from` says so) is
  // the only queue now. Round 9 Task 4 / spec §5: no Previous/Next, no
  // "N of M" counter -- one instruction, one shape, read top to bottom.
  const all = query.data?.improvements ?? [];

  const selected =
    search.improvement != null ? all.find((i) => i.id === search.improvement) : undefined;
  if (selected) {
    return (
      <ImprovementDetail
        item={selected}
        onBack={back}
        onChanged={refresh}
        backLabel={fromInstructions ? "← Instructions" : "← Inbox"}
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
