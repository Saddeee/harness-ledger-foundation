// The Knowledge page: what Harness currently sees in each Lovable
// project's/workspace's Knowledge, the rules it added, and the version
// history of every write. Skills moved to their own route/page (Round 3
// Task 2). Only talks to the local Harness routes
// (fetchKnowledge/postKnowledge/postExecutor) -- writing to Lovable itself
// happens in the executor process, never from this page.
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmAction, DetailSection } from "@/components/harness/decision-layout";
import { formatDate } from "@/lib/harness-ux";
import {
  executorQueryOptions,
  fetchKnowledge,
  postExecutor,
  postKnowledge,
  type KnowledgeActiveRule,
  type KnowledgeTargetView,
  type KnowledgeVersionSummary,
} from "@/lib/improvements-client";

export const Route = createFileRoute("/_authenticated/knowledge")({
  head: () => ({
    meta: [
      { title: "Knowledge — Harness Ledger" },
      {
        name: "description",
        content: "What Harness has written to your Lovable Knowledge, and its history.",
      },
      { property: "og:title", content: "Knowledge — Harness Ledger" },
      {
        property: "og:description",
        content: "What Harness has written to your Lovable Knowledge, and its history.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Page,
});

const HARNESS_START = "<!-- harness:start -->";
const HARNESS_END = "<!-- harness:end -->";
const COLLAPSE_LINES = 12;

// ---- Copy for each version's status. Never implies more happened than the
// record shows -- "written" only when the executor actually wrote it. ----
function versionStatusLine(v: KnowledgeVersionSummary): string {
  const base = (() => {
    switch (v.status) {
      case "written":
        return v.restored_from_version_id != null
          ? `Reverted to an earlier version${v.written_at ? `, ${formatDate(v.written_at)}` : ""}`
          : `Written to Lovable${v.written_at ? `, ${formatDate(v.written_at)}` : ""}`;
      case "pending":
        return "Staged — will be written at the next sync";
      case "stale":
        return "Needs attention — Knowledge changed in Lovable before this could be written";
      case "failed":
        return "Adding failed";
      case "cancelled":
        return "Cancelled — you changed your decision";
      default:
        return v.status;
    }
  })();
  return v.restored_from_version_id != null
    ? `${base} · restored from #${v.restored_from_version_id}`
    : base;
}

// The Harness-managed block, when present, gets its own visually marked
// area; everything the user wrote stays plain text either side of it.
function ManagedBlockText({
  content,
  managedBlockPresent,
}: {
  content: string;
  managedBlockPresent: boolean;
}) {
  const plain = (
    <pre className="whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-3 font-mono text-xs">
      {content}
    </pre>
  );
  if (!managedBlockPresent) return plain;

  const startIdx = content.indexOf(HARNESS_START);
  const endIdx = content.indexOf(HARNESS_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) return plain;

  const before = content.slice(0, startIdx);
  const managed = content.slice(startIdx + HARNESS_START.length, endIdx).trim();
  const after = content.slice(endIdx + HARNESS_END.length);

  return (
    <div className="space-y-2 rounded-md border bg-muted/30 p-3 font-mono text-xs">
      {before ? <pre className="whitespace-pre-wrap break-words">{before}</pre> : null}
      <div className="rounded-md border bg-background p-2">
        <p className="mb-1 font-sans text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Added by Harness
        </p>
        <pre className="whitespace-pre-wrap break-words">{managed}</pre>
      </div>
      {after ? <pre className="whitespace-pre-wrap break-words">{after}</pre> : null}
    </div>
  );
}

// Collapsed after ~12 lines so a long Knowledge document doesn't dominate
// the page; "Show all" reveals the rest, with the managed block marked.
// Text that already carries a Harness-managed block is never collapsed: the
// truncated preview would drop or split the "Added by Harness" marking, and
// seeing what Harness added is the whole point of this page.
function KnowledgeText({
  content,
  managedBlockPresent,
}: {
  content: string;
  managedBlockPresent: boolean;
}) {
  const [showAll, setShowAll] = useState(false);
  if (!content) {
    return <p className="text-sm text-muted-foreground">Nothing here yet.</p>;
  }
  const lines = content.split("\n");
  const isLong = lines.length > COLLAPSE_LINES && !managedBlockPresent;

  if (isLong && !showAll) {
    const preview = lines.slice(0, COLLAPSE_LINES).join("\n");
    return (
      <div className="space-y-2">
        <pre className="whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-3 font-mono text-xs">
          {preview}
        </pre>
        <Button variant="outline" size="sm" onClick={() => setShowAll(true)}>
          Show all
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <ManagedBlockText content={content} managedBlockPresent={managedBlockPresent} />
      {isLong ? (
        <Button variant="outline" size="sm" onClick={() => setShowAll(false)}>
          Show less
        </Button>
      ) : null}
    </div>
  );
}

function ActiveRulesList({ rules }: { rules: KnowledgeActiveRule[] }) {
  if (rules.length === 0) {
    return <p className="text-sm text-muted-foreground">No rules yet.</p>;
  }
  return (
    <ul className="space-y-1">
      {rules.map((r) => {
        const text =
          r.text ||
          (r.improvement_id != null ? `Improvement #${r.improvement_id}` : `Rule #${r.id}`);
        return (
          <li key={r.id} className="text-sm">
            {r.improvement_id != null ? (
              <Link
                to="/ledger"
                search={{ improvement: r.improvement_id }}
                className="text-primary underline underline-offset-2"
              >
                {text}
              </Link>
            ) : (
              <span>{text}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function TargetSection({
  target,
  nextRunAt,
  restoreDisabled,
  onRestore,
  syncing,
  onSyncNow,
}: {
  target: KnowledgeTargetView;
  nextRunAt: string | null | undefined;
  restoreDisabled: boolean;
  onRestore: (versionId: number) => void;
  syncing: boolean;
  onSyncNow: () => void;
}) {
  const statusLine = target.current
    ? `Read from Lovable at ${formatDate(target.current.fetched_at)}`
    : "Not read yet — press Sync now";

  const writtenIds = target.versions.filter((v) => v.status === "written").map((v) => v.id);
  const newestWrittenId = writtenIds.length > 0 ? Math.max(...writtenIds) : null;
  const historyDesc = [...target.versions].sort((a, b) => b.id - a.id);

  return (
    <section className="space-y-4 rounded-md border p-4">
      <div>
        <h2 className="text-lg font-semibold">{target.name}</h2>
        <p className="text-sm text-muted-foreground">{statusLine}</p>
      </div>

      <KnowledgeText
        content={target.current?.content ?? ""}
        managedBlockPresent={target.managed_block_present}
      />

      <div className="space-y-2">
        <h3 className="text-sm font-medium">Rules Harness added</h3>
        <ActiveRulesList rules={target.active_rules} />
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-medium">History</h3>
        {historyDesc.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing written yet.</p>
        ) : (
          <ul className="space-y-2">
            {historyDesc.map((v) => (
              <li key={v.id} className="rounded-md border bg-background p-2 text-sm">
                <p>
                  {formatDate(v.created_at)} · {versionStatusLine(v)}
                </p>
                {v.status === "written" && v.id !== newestWrittenId ? (
                  <div className="mt-2">
                    <ConfirmAction
                      trigger="Restore this version"
                      title="Restore this version?"
                      body="Harness will write the earlier text back, as a new version."
                      consequences={[]}
                      confirmLabel="Restore"
                      disabled={restoreDisabled}
                      onConfirm={() => onRestore(v.id)}
                    />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      {target.pending_write ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/30 p-3 text-sm">
          <p>
            {nextRunAt
              ? `One change is staged. It will be written at the next sync, ${formatDate(nextRunAt)}.`
              : "One change is staged. It will be written at the next sync."}
          </p>
          <Button size="sm" onClick={onSyncNow} disabled={syncing}>
            {syncing ? "Syncing…" : "Sync now"}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function Page() {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ["harness-knowledge"], queryFn: fetchKnowledge });
  const executor = useQuery(executorQueryOptions);

  const restore = useMutation({
    mutationFn: (versionId: number) => postKnowledge({ action: "restore", version_id: versionId }),
    onSuccess: () => {
      toast.success("Restore staged — it will be written at the next sync");
      void qc.invalidateQueries({ queryKey: ["harness-knowledge"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Restore failed"),
  });

  const syncNow = useMutation({
    mutationFn: () => postExecutor({ action: "sync_now" }),
    onSuccess: () => {
      toast.success("Sync requested");
      void qc.invalidateQueries({ queryKey: ["harness-knowledge"] });
      void qc.invalidateQueries({ queryKey: executorQueryOptions.queryKey });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Sync failed"),
  });

  if (query.isLoading) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Knowledge</h1>
        <div className="rounded-md border p-6 text-sm text-muted-foreground">Loading…</div>
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Knowledge</h1>
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
        <h1 className="text-2xl font-semibold">Knowledge</h1>
        <p className="text-sm text-muted-foreground">
          Knowledge is available when Harness runs on your machine.
        </p>
      </div>
    );
  }

  const data = query.data;
  const targets = data?.targets ?? [];
  const awaiting = data?.awaiting_analysis ?? 0;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">Knowledge</h1>
        <Button
          variant="outline"
          size="sm"
          onClick={() => syncNow.mutate()}
          disabled={syncNow.isPending}
        >
          {syncNow.isPending ? "Syncing…" : "Sync now"}
        </Button>
      </div>

      {awaiting > 0 ? (
        <div className="rounded-md border bg-muted/30 p-3 text-sm">
          <p>
            {awaiting === 1
              ? "1 synced message is waiting for analysis."
              : `${awaiting} synced messages are waiting for analysis.`}
          </p>
          <p className="text-xs text-muted-foreground">
            Analysis uses Harness's own AI and runs when you ask for it.
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
        targets.map((t) => (
          <TargetSection
            key={`${t.target}-${t.id}`}
            target={t}
            nextRunAt={executor.data?.next_run_at}
            restoreDisabled={restore.isPending}
            onRestore={(versionId) => restore.mutate(versionId)}
            syncing={syncNow.isPending}
            onSyncNow={() => syncNow.mutate()}
          />
        ))
      )}
    </div>
  );
}
