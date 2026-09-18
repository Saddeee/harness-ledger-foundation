// The History page (Round 5 Task 4 / spec §3b): the owner's "git graph" --
// one vertical timeline per project/workspace target, newest first, of
// every Knowledge write Harness made, every change Lovable saw that Harness
// didn't make, every accept/skip/retire/keep/re-add decision, every Skill
// change, and every rule verdict. The Instructions page's old per-version
// "What changed" list lives here now; Instructions shows only what is
// current. Checkpoint 2 2-C: the selected target's own current Knowledge
// text now has its own "Current Knowledge" box at the top of this page,
// visually separate from the timeline below it (Instructions already shows
// the same text per target; this is the same fact, read here for "what is
// true right now, before I read how it got here"). Only talks to the local
// Harness routes (fetchKnowledge for the target list and its current text,
// fetchTimeline for the selected target's nodes, postKnowledge for "Undo
// this change" / "Go back to before this change").
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ManagedBlockText, Timeline } from "@/components/harness/timeline";
import { formatDate } from "@/lib/harness-ux";
import {
  executorQueryOptions,
  fetchKnowledge,
  fetchTimeline,
  postKnowledge,
  toastWriteOutcome,
} from "@/lib/improvements-client";

type HistorySearch = { target?: "project" | "workspace"; id?: string };

export const Route = createFileRoute("/_authenticated/history")({
  validateSearch: (search: Record<string, unknown>): HistorySearch => {
    const rawTarget = search["target"];
    const target = rawTarget === "project" || rawTarget === "workspace" ? rawTarget : undefined;
    const rawId = search["id"];
    const id = typeof rawId === "string" && rawId ? rawId : undefined;
    return target && id ? { target, id } : {};
  },
  head: () => ({
    meta: [
      { title: "History — Harness Ledger" },
      {
        name: "description",
        content: "Everything Harness Ledger has done to your Lovable Knowledge, per project.",
      },
      { property: "og:title", content: "History — Harness Ledger" },
      {
        property: "og:description",
        content: "Everything Harness Ledger has done to your Lovable Knowledge, per project.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Page,
});

const DEMO_REMOVE_COMMAND = "npm run harness:demo -- --remove";
const EMPTY_LINE =
  "Nothing has happened here yet. Rules you add, changes Harness Ledger writes, and your decisions about those rules will show up here. Skipped suggestions are under Suggestions.";

function Page() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const search = Route.useSearch();

  const knowledge = useQuery({ queryKey: ["harness-knowledge"], queryFn: fetchKnowledge });
  const executor = useQuery(executorQueryOptions);

  // Derived before the loading/error returns below so every hook here is
  // called on every render, never skipped -- selected is undefined while
  // knowledge is still loading, which just keeps the timeline query disabled.
  const targets = knowledge.data?.targets ?? [];
  const defaultTarget = targets.find((t) => t.target === "project") ?? targets[0];
  const selected =
    search.target && search.id
      ? (targets.find((t) => t.target === search.target && t.id === search.id) ?? defaultTarget)
      : defaultTarget;

  const target = selected?.target;
  const id = selected?.id;
  const timeline = useQuery({
    queryKey: ["harness-timeline", target, id],
    queryFn: () => fetchTimeline(target!, id!),
    enabled: !!target && !!id,
  });

  const restore = useMutation({
    mutationFn: (versionId: number) => postKnowledge({ action: "restore", version_id: versionId }),
    onSuccess: (data) => {
      // Round 6 Task 2 / spec §2: restore writes immediately when Harness
      // is connected -- the toast reads the real outcome.
      toastWriteOutcome(data.write, "Change undone.");
      void qc.invalidateQueries({ queryKey: ["harness-knowledge"] });
      void qc.invalidateQueries({ queryKey: ["harness-timeline"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Restore failed"),
  });

  if (knowledge.isLoading) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">History</h1>
        <div className="rounded-md border p-6 text-sm text-muted-foreground">Loading…</div>
      </div>
    );
  }
  if (knowledge.isError) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">History</h1>
        <div
          role="alert"
          className="rounded-md border border-destructive/50 bg-destructive/5 p-6 text-sm text-destructive"
        >
          {knowledge.error instanceof Error ? knowledge.error.message : "Failed to load."}
        </div>
      </div>
    );
  }
  if (knowledge.data && knowledge.data.available === false) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">History</h1>
        <p className="text-sm text-muted-foreground">
          Knowledge is available when Harness Ledger runs on your machine.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">History</h1>
      </div>

      {knowledge.data?.demo_loaded ? (
        <div className="rounded-md border bg-muted/30 p-3 text-sm">
          <p>
            Demo data is loaded so you can see how history looks. Remove it with{" "}
            <code className="rounded bg-background px-1 py-0.5 text-xs">{DEMO_REMOVE_COMMAND}</code>
            .
          </p>
        </div>
      ) : null}

      {targets.length === 0 ? (
        <div className="rounded-md border border-dashed p-10 text-center text-sm text-muted-foreground">
          {executor.data?.connection?.connected === false
            ? "Connect Lovable on the Projects page, then press Sync now."
            : "Nothing to show yet. Allow a project on the Projects page, then press Sync now."}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Target">
            {targets.map((t) => {
              const isSelected = selected?.target === t.target && selected.id === t.id;
              return (
                <Button
                  key={`${t.target}-${t.id}`}
                  type="button"
                  variant={isSelected ? "default" : "outline"}
                  size="sm"
                  aria-pressed={isSelected}
                  onClick={() =>
                    navigate({ to: "/history", search: { target: t.target, id: t.id } })
                  }
                >
                  {t.name}
                </Button>
              );
            })}
          </div>

          {/* Checkpoint 2 2-C: "Current Knowledge" -- the newest written
              version or latest snapshot for the selected target, in its own
              box, visually separate from the event timeline below it. */}
          <section className="space-y-2 rounded-md border p-4" aria-labelledby="current-knowledge">
            <h2 id="current-knowledge" className="text-lg font-semibold">
              Current Knowledge
            </h2>
            <p className="text-sm text-muted-foreground">
              {selected?.current
                ? `Read from Lovable at ${formatDate(selected.current.fetched_at)}`
                : "Not read yet — press Sync now on the Instructions page."}
            </p>
            {selected?.current?.content ? (
              <ManagedBlockText
                content={selected.current.content}
                managedBlockPresent={selected.managed_block_present}
              />
            ) : (
              <p className="text-sm text-muted-foreground">Nothing here yet.</p>
            )}
          </section>

          {timeline.isLoading ? (
            <div className="rounded-md border p-6 text-sm text-muted-foreground">Loading…</div>
          ) : timeline.isError ? (
            <div
              role="alert"
              className="rounded-md border border-destructive/50 bg-destructive/5 p-6 text-sm text-destructive"
            >
              {timeline.error instanceof Error ? timeline.error.message : "Failed to load."}
            </div>
          ) : (timeline.data?.nodes ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">{EMPTY_LINE}</p>
          ) : (
            <Timeline
              nodes={timeline.data?.nodes ?? []}
              onRestore={(versionId) => restore.mutate(versionId)}
              restoreDisabled={restore.isPending}
            />
          )}
        </>
      )}
    </div>
  );
}
