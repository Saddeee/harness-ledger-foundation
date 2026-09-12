import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  DecisionCard,
  ImprovementDetail,
  type Improvement,
} from "@/components/harness/improvement";
import { fetchImprovements, postImprovementAction } from "@/lib/improvements-client";

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

// A just-decided item stays where it was, but as a compact one-line
// confirmation instead of a full card: the Inbox holds only what still needs
// a decision, so once it's decided it isn't "in the Inbox" any more -- it
// just hasn't left the screen yet. Kept in component state only, so a reload
// shows a clean Inbox (the item is simply gone -- it lives under
// Improvements now).
function ConfirmationRow({
  item,
  message,
  busy,
  onUndo,
  onView,
}: {
  item: Improvement;
  message: string;
  busy: boolean;
  onUndo: () => void;
  onView: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-card p-4">
      <p className="min-w-0 flex-1 text-sm">
        <span className="font-medium">{item.title}</span>
        {" — "}
        {message}
      </p>
      <div className="flex items-center gap-3">
        {item.kind === "retire" ? null : (
          <button
            type="button"
            disabled={busy}
            className="text-sm text-primary underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            onClick={onUndo}
          >
            Undo
          </button>
        )}
        <button
          type="button"
          className="text-sm text-primary underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onView}
        >
          View in Improvements
        </button>
      </div>
    </div>
  );
}

function Page() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const search = Route.useSearch();
  // Items decided this visit: id -> the exact toast text, so the
  // confirmation row says the same thing the toast said. Cleared by "Undo"
  // or by leaving the page (component state only -- a reload starts clean).
  const [confirmed, setConfirmed] = useState<Map<number, string>>(new Map());
  const [undoing, setUndoing] = useState<Set<number>>(new Set());

  const query = useQuery({ queryKey: ["harness-improvements"], queryFn: fetchImprovements });
  const refresh = () => qc.invalidateQueries({ queryKey: ["harness-improvements"] });

  // Task C3 / spec §5 "new since your last visit": read the *previous*
  // last_seen_at from the first successful load of this visit, before
  // marking the Inbox seen (which updates that same setting to now) --
  // frozen in a ref for the rest of this visit, so later refetches (the
  // sidebar's 60s poll shares this query) don't move the goalposts while
  // the page stays open. "" (never visited) reads as the beginning of time,
  // so a first-ever visit marks everything new.
  const previousLastSeenAt = useRef<string | null>(null);
  const markedSeen = useRef(false);
  useEffect(() => {
    if (markedSeen.current) return;
    if (!query.data || query.data.available === false) return;
    previousLastSeenAt.current = query.data.last_seen_at ?? null;
    markedSeen.current = true;
    void postImprovementAction({ action: "mark_seen" });
  }, [query.data]);
  const isNew = (item: Improvement): boolean => {
    const previous = previousLastSeenAt.current;
    if (!previous) return true;
    const createdAt = new Date(item.created_at).getTime();
    const previousAt = new Date(previous).getTime();
    return !Number.isNaN(createdAt) && !Number.isNaN(previousAt) && createdAt > previousAt;
  };
  const open = (id: number) => navigate({ to: "/inbox", search: { improvement: id } });
  const back = () => navigate({ to: "/inbox", search: {} });
  const viewInImprovements = (id: number) =>
    navigate({ to: "/ledger", search: { improvement: id } });
  const confirmDecision = (id: number, msg: string) => {
    refresh();
    setConfirmed((prev) => {
      const next = new Map(prev);
      next.set(id, msg);
      return next;
    });
  };
  // Reopens the item through the shared action helper, then waits for the
  // refetch to land before dropping the confirmation row -- so the item
  // turns straight into a pending card instead of briefly disappearing.
  const undo = async (id: number) => {
    setUndoing((prev) => new Set(prev).add(id));
    try {
      await postImprovementAction({ action: "reopen", id });
      await refresh();
      setConfirmed((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "action failed");
    } finally {
      setUndoing((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
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
  // Still needs a decision, plus anything decided this visit (shown as a
  // confirmation row instead of a card) -- in their original order, so
  // nothing jumps around on screen.
  const pending = all.filter((i) => i.decision.status === "pending");
  const list = all.filter((i) => i.decision.status === "pending" || confirmed.has(i.id));
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
        onChanged={(msg) => confirmDecision(selected.id, msg)}
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
          {pending.length > 0 ? (
            <p className="text-sm text-muted-foreground">
              {pending.length === 1
                ? "One improvement is waiting for your decision."
                : `${pending.length} improvements are waiting for your decision.`}
            </p>
          ) : null}
          <ul className="space-y-3">
            {list.map((i) => (
              <li key={i.id}>
                {confirmed.has(i.id) ? (
                  <ConfirmationRow
                    item={i}
                    message={confirmed.get(i.id)!}
                    busy={undoing.has(i.id)}
                    onUndo={() => void undo(i.id)}
                    onView={() => viewInImprovements(i.id)}
                  />
                ) : (
                  <DecisionCard
                    item={i}
                    onChanged={(msg) => confirmDecision(i.id, msg)}
                    onOpen={open}
                    isNew={isNew(i)}
                  />
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
