// The Instructions page (formerly Knowledge): what Harness currently sees in
// each Lovable project's/workspace's Knowledge, and the rules it has added
// there (Round 3 §2). The write history and its per-version change diff
// moved to the History page (Round 5 §3b) -- this page shows only current.
// Skills live on their own route/page. Section headings below the title
// keep Lovable's own term, "Knowledge" (e.g. the per-target heading, "Rules
// Harness added"), since that's what the user sees in Lovable itself; only
// the page's own title, and its name in the nav and URL, say "Instructions".
// Only talks to the local Harness routes (fetchKnowledge/postExecutor/
// postImprovementAction) -- writing to Lovable itself happens in the
// executor process, never from this page.
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { AnalyseNotice } from "@/components/harness/analyse-notice";
import { ConfirmAction, DetailSection } from "@/components/harness/decision-layout";
import { ManagedBlockText } from "@/components/harness/timeline";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDate, formatDay, healthLine } from "@/lib/harness-ux";
import {
  executorQueryOptions,
  fetchKnowledge,
  postExecutor,
  postImprovementAction,
  type KnowledgeActiveRule,
  type KnowledgeTargetView,
} from "@/lib/improvements-client";

export const Route = createFileRoute("/_authenticated/instructions")({
  head: () => ({
    meta: [
      { title: "Instructions — Harness Ledger" },
      {
        name: "description",
        content: "What Harness has written to your Lovable Knowledge, and its history.",
      },
      { property: "og:title", content: "Instructions — Harness Ledger" },
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

const COLLAPSE_LINES = 12;
const DEMO_REMOVE_COMMAND = "npm run harness:demo -- --remove";

// Task C2 / spec §4b-§5: manual Retire from this page uses the same confirm
// copy as the Inbox's retirement proposal card (improvement.tsx).
const RETIRE_TITLE = "Retire this rule?";
const RETIRE_BODY = "Harness will rewrite your Knowledge without it at the next sync.";
const RETIRE_CONSEQUENCES = ["You can re-add it later from Suggestions."];

// Round 5 Task 3/4 / spec §3a: the rules table's Status column.
const RULE_STATUS_LABEL: Record<NonNullable<KnowledgeActiveRule["status"]>, string> = {
  written: "In Lovable",
  pending: "Staged",
  stale: "Needs attention",
  failed: "Needs attention",
  testing: "Testing",
};

// spec §5.2: the muted "You said: ..." line under a rule's Observed column.
const VERDICT_TEXT: Record<"helped" | "did_not_help" | "not_sure", string> = {
  helped: "helped",
  did_not_help: "didn't help",
  not_sure: "not sure",
};

// The Harness-managed block, when present, gets its own visually marked
// area; everything the user wrote stays plain text either side of it.
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

// One row per active rule: the rule text -- a keyboard-focusable Link when
// there's a Suggestions detail to open, plain text otherwise -- status,
// since-added date, what's been observed, and the Retire action. spec §3a.
// Fix round 1: the row itself keeps its native table-row semantics (no ARIA
// role or tab-stop override) -- clicking anywhere in the row still
// navigates, as a mouse-only convenience, but the rule is reachable by
// keyboard through the Link/Button in its own cell, not by tabbing to the
// row.
const RULE_LINK_CLASS =
  "text-left hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function RuleRow({
  rule,
  retireBusy,
  onRetire,
}: {
  rule: KnowledgeActiveRule;
  retireBusy: boolean;
  onRetire: (ruleId: number) => void;
}) {
  const navigate = useNavigate();
  const improvementId = rule.improvement_id;
  const goToSuggestion = () => {
    if (improvementId != null) navigate({ to: "/ledger", search: { improvement: improvementId } });
  };

  const text =
    rule.text || (improvementId != null ? `Suggestion #${improvementId}` : `Rule #${rule.id}`);
  const status = rule.status ? RULE_STATUS_LABEL[rule.status] : "—";
  const since = rule.since ? formatDay(rule.since) : "—";
  const observed = healthLine(rule.health ?? null);

  return (
    <TableRow
      {...(improvementId != null ? { onClick: goToSuggestion, className: "cursor-pointer" } : {})}
    >
      <TableCell>
        {improvementId != null ? (
          <Link to="/ledger" search={{ improvement: improvementId }} className={RULE_LINK_CLASS}>
            {text}
          </Link>
        ) : (
          <span>{text}</span>
        )}
      </TableCell>
      <TableCell>{status}</TableCell>
      <TableCell>{since}</TableCell>
      <TableCell>
        <p className="text-xs text-muted-foreground">{observed ?? "no builds yet"}</p>
        {rule.verdict ? (
          <p className="text-xs text-muted-foreground">
            You said: {VERDICT_TEXT[rule.verdict.verdict]}, {formatDay(rule.verdict.created_at)}
          </p>
        ) : null}
        {rule.adherence && rule.adherence.followed + rule.adherence.broke > 0 ? (
          <p className="text-xs text-muted-foreground">
            Followed in {rule.adherence.followed} of{" "}
            {rule.adherence.followed + rule.adherence.broke} builds it applied to · judged by AI
          </p>
        ) : null}
        {/* adherence-line */}
      </TableCell>
      <TableCell onClick={(e) => e.stopPropagation()}>
        <div className="flex flex-col items-end gap-2">
          <ConfirmAction
            trigger="Retire"
            variant="outline"
            title={RETIRE_TITLE}
            body={RETIRE_BODY}
            consequences={RETIRE_CONSEQUENCES}
            confirmLabel="Retire"
            disabled={retireBusy}
            onConfirm={() => onRetire(rule.id)}
          />
          {/* verdict-buttons */}
        </div>
      </TableCell>
    </TableRow>
  );
}

function RulesTable({
  rules,
  retireBusy,
  onRetire,
}: {
  rules: KnowledgeActiveRule[];
  retireBusy: boolean;
  onRetire: (ruleId: number) => void;
}) {
  if (rules.length === 0) {
    return <p className="text-sm text-muted-foreground">No rules yet.</p>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Rule</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Since</TableHead>
          <TableHead>Observed</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {rules.map((r) => (
          <RuleRow key={r.id} rule={r} retireBusy={retireBusy} onRetire={onRetire} />
        ))}
      </TableBody>
    </Table>
  );
}

// Collapsed by default -- a project with no retired rules never shows this
// at all, and one that does keeps the rules table the focus.
function RetiredRulesList({
  rules,
  readdBusy,
  onReadd,
}: {
  rules: KnowledgeActiveRule[];
  readdBusy: boolean;
  onReadd: (improvementId: number) => void;
}) {
  if (rules.length === 0) return null;
  return (
    <details className="rounded-md border">
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        Retired rules ({rules.length})
      </summary>
      <ul className="space-y-2 border-t px-3 py-3">
        {rules.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="text-muted-foreground">{r.text || `Rule #${r.id}`}</span>
            {r.improvement_id != null ? (
              <Button
                variant="outline"
                size="sm"
                disabled={readdBusy}
                onClick={() => onReadd(r.improvement_id!)}
              >
                Re-add
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </details>
  );
}

function TargetSection({
  target,
  nextRunAt,
  syncing,
  onSyncNow,
  retireBusy,
  onRetire,
  readdBusy,
  onReadd,
}: {
  target: KnowledgeTargetView;
  nextRunAt: string | null | undefined;
  syncing: boolean;
  onSyncNow: () => void;
  retireBusy: boolean;
  onRetire: (ruleId: number) => void;
  readdBusy: boolean;
  onReadd: (improvementId: number) => void;
}) {
  const statusLine = target.current
    ? `Read from Lovable at ${formatDate(target.current.fetched_at)}`
    : "Not read yet — press Sync now";
  const content = target.current?.content ?? "";

  return (
    <section className="space-y-4 rounded-md border p-4">
      <div>
        <h2 className="text-lg font-semibold">{target.name}</h2>
        <p className="text-sm text-muted-foreground">{statusLine}</p>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-medium">Rules Harness added</h3>
        <RulesTable rules={target.active_rules} retireBusy={retireBusy} onRetire={onRetire} />
        <RetiredRulesList rules={target.retired_rules} readdBusy={readdBusy} onReadd={onReadd} />
      </div>

      <DetailSection
        title={`Full Knowledge text as Lovable sees it (${content.length} characters)`}
      >
        <KnowledgeText content={content} managedBlockPresent={target.managed_block_present} />
      </DetailSection>

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

  const syncNow = useMutation({
    mutationFn: () => postExecutor({ action: "sync_now" }),
    onSuccess: () => {
      toast.success("Sync requested");
      void qc.invalidateQueries({ queryKey: ["harness-knowledge"] });
      void qc.invalidateQueries({ queryKey: executorQueryOptions.queryKey });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Sync failed"),
  });

  // Task C2 / spec §4b-§5: manual Retire and Re-add, the same action path
  // the Inbox's retirement proposal card uses -- both invalidate the
  // Improvements list too, since a rule's own card there changes group.
  const retireRule = useMutation({
    mutationFn: (ruleId: number) => postImprovementAction({ action: "retire", rule_id: ruleId }),
    onSuccess: () => {
      toast.success("Retired — Harness will rewrite your Knowledge at the next sync.");
      void qc.invalidateQueries({ queryKey: ["harness-knowledge"] });
      void qc.invalidateQueries({ queryKey: ["harness-improvements"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Retire failed"),
  });

  const readdRule = useMutation({
    mutationFn: (improvementId: number) =>
      postImprovementAction({ action: "readd", id: improvementId }),
    onSuccess: () => {
      toast.success("Re-added — will be written at the next sync");
      void qc.invalidateQueries({ queryKey: ["harness-knowledge"] });
      void qc.invalidateQueries({ queryKey: ["harness-improvements"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Re-add failed"),
  });

  if (query.isLoading) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Instructions</h1>
        <div className="rounded-md border p-6 text-sm text-muted-foreground">Loading…</div>
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Instructions</h1>
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
        <h1 className="text-2xl font-semibold">Instructions</h1>
        <p className="text-sm text-muted-foreground">
          Knowledge is available when Harness runs on your machine.
        </p>
      </div>
    );
  }

  const data = query.data;
  const targets = data?.targets ?? [];

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">Instructions</h1>
        <Button
          variant="outline"
          size="sm"
          onClick={() => syncNow.mutate()}
          disabled={syncNow.isPending}
        >
          {syncNow.isPending ? "Syncing…" : "Sync now"}
        </Button>
      </div>

      {data?.demo_loaded ? (
        <div className="rounded-md border bg-muted/30 p-3 text-sm">
          <p>
            Demo data is loaded so you can see how history looks. Remove it with{" "}
            <code className="rounded bg-background px-1 py-0.5 text-xs">{DEMO_REMOVE_COMMAND}</code>
            .
          </p>
        </div>
      ) : null}

      <AnalyseNotice />

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
            syncing={syncNow.isPending}
            onSyncNow={() => syncNow.mutate()}
            retireBusy={retireRule.isPending}
            onRetire={(ruleId) => retireRule.mutate(ruleId)}
            readdBusy={readdRule.isPending}
            onReadd={(improvementId) => readdRule.mutate(improvementId)}
          />
        ))
      )}
    </div>
  );
}
