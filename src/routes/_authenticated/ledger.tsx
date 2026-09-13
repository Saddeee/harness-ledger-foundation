import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DecisionCard, ImprovementDetail } from "@/components/harness/improvement";
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

// Round 6c part A / item 1: Suggestions holds only things that still need or
// await a decision -- once a rule is live in Lovable (or reverted back out
// of it), it isn't a "suggestion" any more; it's a rule, and rules live on
// the Instructions page's rules table. So this page no longer iterates
// IMPROVEMENT_GROUPS generically -- it builds four fixed sections from the
// same grouped data:
//   Open              -- still-pending items (incl. retirement proposals,
//                         which are always decision.status "pending") plus
//                         "Needs attention" (a failed/stale write) -- both
//                         need something from the owner right now.
//   Waiting to be written -- accepted, connected, not written yet (rare now
//                         that Accept writes inline).
//   Waiting to be tested -- a test is running or awaiting a verdict.
//   Decided earlier    -- Retired + Skipped, collapsed: settled, rarely
//                         revisited, but Re-add/Reopen still reachable.
// "In Lovable" and "Reverted" are never listed here -- only pointed at, if
// any exist, since those rules are already on the Instructions page.
function Page() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const search = Route.useSearch();

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
  const grouped = new Map<string, Improvement[]>();
  for (const item of all) {
    const g = groupOf(item);
    if (!g) continue;
    grouped.set(g, [...(grouped.get(g) ?? []), item]);
  }
  const pending = all.filter((i) => i.decision.status === "pending");
  const needsAttention = grouped.get("Needs attention") ?? [];
  const waitingToBeWritten = grouped.get("Waiting to be written") ?? [];
  const waitingToBeTested = grouped.get("Waiting to be tested") ?? [];
  const decidedEarlier = [...(grouped.get("Retired") ?? []), ...(grouped.get("Skipped") ?? [])];
  const inLovableElsewhere =
    (grouped.get("In Lovable")?.length ?? 0) + (grouped.get("Reverted")?.length ?? 0);

  // Still needs a decision, plus anything with a broken write -- both belong
  // at the top, under one "Open" heading (spec: item 1).
  const openItems = [...pending, ...needsAttention];

  // Previous/Next browse the on-page order top to bottom -- the same order
  // the sections render in below.
  const order = [...openItems, ...waitingToBeWritten, ...waitingToBeTested, ...decidedEarlier].map(
    (i) => i.id,
  );

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

  const sectionsTotal =
    openItems.length + waitingToBeWritten.length + waitingToBeTested.length + decidedEarlier.length;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Suggestions</h1>

      {inLovableElsewhere > 0 ? (
        <p className="text-sm text-muted-foreground">
          Rules already in Lovable are on the{" "}
          <Link to="/instructions" className="underline underline-offset-2 hover:no-underline">
            Instructions page
          </Link>
          .
        </p>
      ) : null}

      {sectionsTotal === 0 ? (
        <div className="rounded-md border border-dashed p-10 text-center text-sm text-muted-foreground">
          {all.length === 0
            ? "Suggestions Harness finds in your Lovable chats will appear here."
            : "Nothing needs a decision right now."}
        </div>
      ) : (
        <>
          {openItems.length > 0 ? (
            <section aria-labelledby="group-open" className="space-y-2">
              <h2 id="group-open" className="text-lg font-semibold">
                Open{" "}
                <span className="text-sm font-normal text-muted-foreground">
                  ({openItems.length})
                </span>
              </h2>
              <ul className="space-y-3">
                {openItems.map((i) => (
                  <li key={i.id}>
                    <DecisionCard item={i} onChanged={refresh} onOpen={open} />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {waitingToBeWritten.length > 0 ? (
            <section aria-labelledby="group-waiting-to-be-written" className="space-y-2">
              <h2 id="group-waiting-to-be-written" className="text-lg font-semibold">
                Waiting to be written{" "}
                <span className="text-sm font-normal text-muted-foreground">
                  ({waitingToBeWritten.length})
                </span>
              </h2>
              <ul className="space-y-3">
                {waitingToBeWritten.map((i) => (
                  <li key={i.id}>
                    <DecisionCard item={i} onChanged={refresh} onOpen={open} />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {waitingToBeTested.length > 0 ? (
            <section aria-labelledby="group-waiting-to-be-tested" className="space-y-2">
              <h2 id="group-waiting-to-be-tested" className="text-lg font-semibold">
                Waiting to be tested{" "}
                <span className="text-sm font-normal text-muted-foreground">
                  ({waitingToBeTested.length})
                </span>
              </h2>
              <ul className="space-y-3">
                {waitingToBeTested.map((i) => (
                  <li key={i.id}>
                    <DecisionCard item={i} onChanged={refresh} onOpen={open} />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {decidedEarlier.length > 0 ? (
            <details className="rounded-md border">
              <summary className="cursor-pointer px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                Decided earlier ({decidedEarlier.length})
              </summary>
              <ul className="space-y-3 border-t p-3">
                {decidedEarlier.map((i) => (
                  <li key={i.id}>
                    <DecisionCard item={i} onChanged={refresh} onOpen={open} />
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      )}
    </div>
  );
}
