// The Instructions page (formerly Knowledge): what Harness currently sees in
// each Lovable project's/workspace's Knowledge, and the rules it has added
// there (Round 3 §2). The write history and its per-version change diff
// moved to the History page (Round 5 §3b) -- this page shows only current.
// Checkpoint 2 2-C: the page now leads with "Needs your attention" (only
// rules whose health status is review/retire_suggested), then two top-level
// sections -- "Knowledge" (the existing per-target rules table, unchanged)
// and "Skills" (a one-line-per-proposal summary that only ever links out to
// /skills or /ledger; no Skill control of any kind lives here). Section
// headings inside "Knowledge" below keep Lovable's own term (e.g. the
// per-target heading, "Rules Harness Ledger added"), since that's what the
// user sees in Lovable itself; only the page's own title, and its name in
// the nav and URL, say "Instructions".
// Only talks to the local Harness routes (fetchKnowledge/fetchSkills/
// postExecutor/postImprovementAction) -- writing to Lovable itself happens
// in the executor process, never from this page.
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DetailSection, RecommendationCallout } from "@/components/harness/decision-layout";
import { ManagedBlockText } from "@/components/harness/timeline";
import { VerdictControl } from "@/components/harness/improvement";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  aiReviewLine,
  ALL_PROJECTS_LABEL,
  attentionBlock,
  CANCEL_WRITE_TOAST,
  formatDate,
  formatDay,
  INSTRUCTIONS_PROJECT_FILTER_LABEL,
  NOTHING_NEEDS_ATTENTION_LINE,
  observedLine,
  REMOVE_FROM_KNOWLEDGE_BODY,
  REMOVE_FROM_KNOWLEDGE_CONFIRM_LABEL,
  REMOVE_FROM_KNOWLEDGE_TITLE,
  replayEvidenceLine,
  ruleActiveLine,
  skillProposalStatusLabel,
  WORKSPACE_TARGET_LABEL,
} from "@/lib/harness-ux";
import {
  executorQueryOptions,
  fetchImprovements,
  fetchKnowledge,
  postExecutor,
  postImprovementAction,
  skillsQueryOptions,
  syncResultText,
  toastWriteOutcome,
  type KnowledgeActiveRuleWithJudgedRun,
  type KnowledgeTargetView,
  type SkillProposalListItem,
} from "@/lib/improvements-client";

// Checkpoint 3 UX fix 2: the per-project filter -- ?project=<lovable
// project id> or ?project=workspace, or omitted for "All projects". Only
// ever narrows which of the already-fetched targets/proposals are shown;
// it fetches nothing of its own.
type InstructionsSearch = { project?: string };

export const Route = createFileRoute("/_authenticated/instructions")({
  validateSearch: (search: Record<string, unknown>): InstructionsSearch => {
    const raw = search["project"];
    const project = typeof raw === "string" && raw ? raw : undefined;
    return project ? { project } : {};
  },
  head: () => ({
    meta: [
      { title: "Instructions — Harness Ledger" },
      {
        name: "description",
        content: "What Harness Ledger has written to your Lovable Knowledge, and its history.",
      },
      { property: "og:title", content: "Instructions — Harness Ledger" },
      {
        property: "og:description",
        content: "What Harness Ledger has written to your Lovable Knowledge, and its history.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Page,
});

const COLLAPSE_LINES = 12;
const DEMO_REMOVE_COMMAND = "npm run harness:demo -- --remove";

// Round 5 Task 3/4 / spec §3a: the rules table's Status column.
const RULE_STATUS_LABEL: Record<NonNullable<KnowledgeActiveRuleWithJudgedRun["status"]>, string> = {
  written: "In Lovable",
  pending: "Staged",
  stale: "Write needs attention",
  failed: "Write needs attention",
  testing: "Testing",
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
// since-added date, what's been observed (with the shared VerdictControl),
// and one "…" menu with the row's trailing actions. spec §4.
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
  rule: KnowledgeActiveRuleWithJudgedRun;
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

  // Checkpoint 2 2-C (spec §9): the health status decides which line this
  // row leads with -- the attention block for 'review'/'retire_suggested',
  // else the plain "is it live and replay-tested" fact. observedLine/
  // aiReviewLine/the VerdictControl's own verdictLine/replayEvidenceLine
  // each stay their own line below it, never merged into one sentence.
  const healthStatus = rule.health?.status ?? null;
  const needsAttention = healthStatus === "review" || healthStatus === "retire_suggested";
  const attention = needsAttention ? attentionBlock(rule.health ?? null) : null;
  const observed = observedLine(rule.health ?? null);
  const aiReview = aiReviewLine(rule.health ?? null);
  const replayLine = replayEvidenceLine(rule.judged_run ?? null);

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
        {attention ? (
          <div className="space-y-0.5">
            <p className="text-xs font-medium">{attention.title}</p>
            <p className="text-xs text-muted-foreground">{attention.line}</p>
            <p className="text-xs text-muted-foreground">{attention.recommendation}</p>
            {improvementId != null ? (
              <Link
                to="/ledger"
                search={{ improvement: improvementId }}
                className="text-xs text-primary underline underline-offset-2"
              >
                {attention.action}
              </Link>
            ) : null}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">{ruleActiveLine(rule.judged_run != null)}</p>
        )}
        {observed ? <p className="text-xs text-muted-foreground">{observed}</p> : null}
        {aiReview ? <p className="text-xs text-muted-foreground">{aiReview}</p> : null}
        {/* Round 6 Task 4 / spec §4: the same compact, inline verdict
            control as the Suggestions card -- one visible control here,
            instead of a separate row of "Helped/Didn't help/Not sure"
            buttons plus its own "You said..." line (verdictLine is rendered
            inside VerdictControl itself once a verdict exists). */}
        <VerdictControl ruleId={rule.id} verdict={rule.verdict ?? null} />
        {replayLine ? <p className="text-xs text-muted-foreground">{replayLine}</p> : null}
        {/* adherence-line */}
      </TableCell>
      <TableCell onClick={(e) => e.stopPropagation()}>
        {/* Round 6 Task 4 / spec §4: the row's trailing actions collapse
            into one "…" menu -- Remove from Knowledge (the AlertDialog
            confirm nested inside its own menu item, the standard pattern
            for a confirm triggered from a menu) and Open suggestion. */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="sm" aria-label="Rule actions">
              …
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <DropdownMenuItem onSelect={(e) => e.preventDefault()}>
                  Remove from Knowledge
                </DropdownMenuItem>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{REMOVE_FROM_KNOWLEDGE_TITLE}</AlertDialogTitle>
                  <AlertDialogDescription>{REMOVE_FROM_KNOWLEDGE_BODY}</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction disabled={retireBusy} onClick={() => onRetire(rule.id)}>
                    {REMOVE_FROM_KNOWLEDGE_CONFIRM_LABEL}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
            {improvementId != null ? (
              <DropdownMenuItem onSelect={goToSuggestion}>Open suggestion</DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  );
}

function RulesTable({
  rules,
  retireBusy,
  onRetire,
}: {
  rules: KnowledgeActiveRuleWithJudgedRun[];
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
  rules: KnowledgeActiveRuleWithJudgedRun[];
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
  syncing,
  onSyncNow,
  retireBusy,
  onRetire,
  readdBusy,
  onReadd,
  cancelWriteBusy,
  onCancelWrite,
}: {
  target: KnowledgeTargetView;
  syncing: boolean;
  onSyncNow: () => void;
  retireBusy: boolean;
  onRetire: (ruleId: number) => void;
  readdBusy: boolean;
  onReadd: (improvementId: number) => void;
  cancelWriteBusy: boolean;
  onCancelWrite: (versionId: number) => void;
}) {
  const statusLine = target.current
    ? `Read from Lovable at ${formatDate(target.current.fetched_at)}`
    : "Not read yet — press Sync now";
  const content = target.current?.content ?? "";

  // Round 6c part A / item 2: the workspace target's heading gets a plain-
  // language retitle and a one-line explanation of what it actually is --
  // the owner asked "what is Workspace?" and "Workspace" alone (Lovable's
  // own name for the target) didn't answer that.
  const isWorkspace = target.target === "workspace";

  return (
    <section className="space-y-4 rounded-md border p-4">
      <div>
        <h2 className="text-lg font-semibold">
          {isWorkspace ? "All your projects (workspace Knowledge)" : target.name}
        </h2>
        {isWorkspace ? (
          <p className="text-sm text-muted-foreground">
            Rules you add to all your projects live here; Lovable applies them to every project in
            this workspace.
          </p>
        ) : null}
        <p className="text-sm text-muted-foreground">{statusLine}</p>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-medium">Rules Harness Ledger added</h3>
        <RulesTable
          rules={target.active_rules as KnowledgeActiveRuleWithJudgedRun[]}
          retireBusy={retireBusy}
          onRetire={onRetire}
        />
        <RetiredRulesList
          rules={target.retired_rules as KnowledgeActiveRuleWithJudgedRun[]}
          readdBusy={readdBusy}
          onReadd={onReadd}
        />
      </div>

      <DetailSection
        title={`Full Knowledge text as Lovable sees it (${content.length} characters)`}
      >
        <KnowledgeText content={content} managedBlockPresent={target.managed_block_present} />
      </DetailSection>

      {target.pending_write ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/30 p-3 text-sm">
          {/* Round 6 Tasks 2-3 / spec §§2-3: pressing a decision writes
              immediately when Harness is connected -- reaching this staged
              state at all now means the write failed or Harness was
              disconnected at accept time. The sync button below retries it;
              the cancel button is the only place a staged write can be
              cancelled. */}
          <p>One change is staged, not yet written to Lovable.</p>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={cancelWriteBusy}
              onClick={() => onCancelWrite(target.pending_write!.version_id)}
            >
              Cancel
            </Button>
            <Button size="sm" onClick={onSyncNow} disabled={syncing}>
              {syncing ? "Syncing…" : "Sync now"}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

// ---- Checkpoint 2 2-C: "Needs your attention" -- across every target, only
// the rules whose health status is 'review' or 'retire_suggested' (never
// 'snoozed': a snoozed rule was already reviewed and asked not to resurface
// for a while). Each item repeats the same attentionBlock() a rule's own
// row shows inline (spec §9) so the two never disagree, plus which
// project/workspace it's in and a "Review rule" link to its Suggestions
// detail. ----
type AttentionItem = {
  key: string;
  targetName: string;
  ruleText: string;
  improvementId: number | null;
  block: NonNullable<ReturnType<typeof attentionBlock>>;
};

function collectAttentionItems(targets: KnowledgeTargetView[]): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const t of targets) {
    for (const r of t.active_rules as KnowledgeActiveRuleWithJudgedRun[]) {
      const status = r.health?.status ?? null;
      if (status !== "review" && status !== "retire_suggested") continue;
      const block = attentionBlock(r.health ?? null);
      if (!block) continue;
      items.push({
        key: `${t.target}-${t.id}-${r.id}`,
        targetName: t.name,
        ruleText: r.text || `Rule #${r.id}`,
        improvementId: r.improvement_id,
        block,
      });
    }
  }
  return items;
}

function NeedsAttentionSection({ items }: { items: AttentionItem[] }) {
  return (
    <section aria-labelledby="needs-attention" className="space-y-3">
      <h2 id="needs-attention" className="text-lg font-semibold">
        Needs your attention
      </h2>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{NOTHING_NEEDS_ATTENTION_LINE}</p>
      ) : (
        <ul className="space-y-3">
          {items.map((it) => (
            <li key={it.key} className="space-y-2 rounded-md border p-4">
              <p className="text-xs text-muted-foreground">{it.targetName}</p>
              <RecommendationCallout
                title={it.block.title}
                recommendation={it.block.recommendation}
                why={it.block.line}
              />
              <p className="text-sm font-medium">{it.ruleText}</p>
              {it.improvementId != null ? (
                <Link
                  to="/ledger"
                  search={{ improvement: it.improvementId }}
                  className="text-sm text-primary underline underline-offset-2"
                >
                  {it.block.action}
                </Link>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---- Checkpoint 2 2-C: the "Skills" section -- links out to /skills and
// lists Harness Ledger's own Skill proposals in one line each; nothing
// here implies a remote create/update/enable/disable of anything. ----
function SkillsSection({ proposals }: { proposals: SkillProposalListItem[] }) {
  return (
    <section aria-labelledby="instructions-skills" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="instructions-skills" className="text-lg font-semibold">
          Skills
        </h2>
        <Link to="/skills" className="text-sm text-primary underline underline-offset-2">
          Open Skills
        </Link>
      </div>
      {proposals.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Harness Ledger hasn't proposed a Skill from any suggestion yet.
        </p>
      ) : (
        <ul className="space-y-1">
          {proposals.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-2 text-sm">
              <Link
                to="/ledger"
                search={{ improvement: p.correction_candidate_id }}
                className="text-primary underline underline-offset-2"
              >
                {p.name}
              </Link>
              <span className="text-xs text-muted-foreground">
                {skillProposalStatusLabel(p.status)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Page() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const search = Route.useSearch();
  const query = useQuery({ queryKey: ["harness-knowledge"], queryFn: fetchKnowledge });
  const executor = useQuery(executorQueryOptions);
  const skills = useQuery(skillsQueryOptions);
  // Checkpoint 3 UX fix 2: a Skill proposal has no scope of its own, only the
  // project its correction came from -- read from the same improvements list
  // the sidebar badge and Overview already poll ("harness-improvements"),
  // dedupe by react-query, not a fetch of its own.
  const improvementsQuery = useQuery({
    queryKey: ["harness-improvements"],
    queryFn: fetchImprovements,
  });

  const syncNow = useMutation({
    mutationFn: () => postExecutor({ action: "sync_now" }),
    onSuccess: (data) => {
      toast.success(syncResultText(data));
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
    onSuccess: (data) => {
      toastWriteOutcome(data.write, "Retired.");
      void qc.invalidateQueries({ queryKey: ["harness-knowledge"] });
      void qc.invalidateQueries({ queryKey: ["harness-improvements"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Retire failed"),
  });

  const readdRule = useMutation({
    mutationFn: (improvementId: number) =>
      postImprovementAction({ action: "readd", id: improvementId }),
    onSuccess: (data) => {
      toastWriteOutcome(data.write, "Re-added.");
      void qc.invalidateQueries({ queryKey: ["harness-knowledge"] });
      void qc.invalidateQueries({ queryKey: ["harness-improvements"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Re-add failed"),
  });

  // Round 6 Task 3 / spec §3: Cancel on the pending-write banner -- only
  // reachable now when a write failed or Harness was disconnected at the
  // moment the decision was pressed. Never writes to Lovable itself (the
  // whole point is that nothing was written yet), so there's no `write`
  // outcome to read back, just the plain toast.
  const cancelWrite = useMutation({
    mutationFn: (versionId: number) =>
      postImprovementAction({ action: "cancel_write", version_id: versionId }),
    // Addendum to Round 6 Task 4 (Round 6 Task 3 fix 2): when the rule
    // stayed live (only a later, not-yet-written rewrite was dropped), the
    // response carries its own exact note -- read it instead of the fixed
    // CANCEL_WRITE_TOAST, which claims the item went "back in your Inbox"
    // (it never left; the rule is still accepted and written).
    onSuccess: (data) => {
      toast.success(data.improvement?.cancel_note ?? CANCEL_WRITE_TOAST);
      void qc.invalidateQueries({ queryKey: ["harness-knowledge"] });
      void qc.invalidateQueries({ queryKey: ["harness-improvements"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Cancel failed"),
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
          Knowledge is available when Harness Ledger runs on your machine.
        </p>
      </div>
    );
  }

  const data = query.data;
  const targets = data?.targets ?? [];
  // Round 6c part A / item 2: the workspace target only earns its own
  // section once there's something in it -- otherwise it's a confusing
  // empty card. "Content" here is the same thing the section itself would
  // show: rules (active or retired), a staged write ("versions" in
  // flight), or actual Knowledge text.
  const workspaceTarget = targets.find((t) => t.target === "workspace");
  const workspaceHasContent =
    workspaceTarget != null &&
    (workspaceTarget.active_rules.length > 0 ||
      workspaceTarget.retired_rules.length > 0 ||
      (workspaceTarget.current?.content ?? "").trim().length > 0 ||
      workspaceTarget.pending_write != null);

  // ---- Checkpoint 3 UX fix 2: per-project filter (?project=) ----
  const projectOptions = targets
    .filter((t) => t.target === "project")
    .map((t) => ({ value: t.id, label: t.name }));
  const selectedTarget: { target: "project" | "workspace"; id: string } | null =
    search.project === "workspace"
      ? workspaceTarget
        ? { target: "workspace", id: workspaceTarget.id }
        : null
      : search.project
        ? { target: "project", id: search.project }
        : null;
  const visibleTargets = selectedTarget
    ? targets.filter((t) => t.target === selectedTarget.target && t.id === selectedTarget.id)
    : targets;
  const showWorkspaceFallbackNote =
    !workspaceHasContent && (!selectedTarget || selectedTarget.target === "workspace");
  // A Skill proposal has no scope of its own; it belongs to whichever
  // project's correction produced it (a Skill is never workspace-scoped the
  // way a rule can be), so the Workspace filter always shows none.
  const skillProposalProjectId = (id: number): string | null => {
    for (const imp of improvementsQuery.data?.improvements ?? []) {
      if (imp.skill_proposal?.id === id) return imp.project.id;
    }
    return null;
  };
  // ---- end Checkpoint 3 UX fix 2 ----

  const attentionItems = collectAttentionItems(visibleTargets);
  const skillProposals = skills.data?.proposals ?? [];
  const visibleSkillProposals =
    selectedTarget == null
      ? skillProposals
      : selectedTarget.target === "workspace"
        ? []
        : skillProposals.filter((p) => skillProposalProjectId(p.id) === selectedTarget.id);

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

      {/* Round 8 Task 1 item 8: the shared AnalyseNotice moved to Settings >
          AI analysis -- the Inbox's own one-line analysisStatusLine now
          covers "is there anything new to analyse" wherever a decision
          about that needs making; this page never repeated it. */}

      {targets.length === 0 ? (
        <div className="rounded-md border border-dashed p-10 text-center text-sm text-muted-foreground">
          {executor.data?.connection?.connected === false
            ? "Connect Lovable on the Projects page, then press Sync now."
            : "Nothing to show yet. Allow a project on the Projects page, then press Sync now."}
        </div>
      ) : (
        <>
          {/* Checkpoint 3 UX fix 2: All projects plus one option per
              allowed project plus the workspace target (only offered once
              one actually exists) -- narrows Needs your attention,
              Knowledge and Skills below to the chosen target; changes the
              URL (?project=) so an Overview/Inbox link can open here already
              scoped. */}
          <div
            className="flex flex-wrap items-center gap-2"
            role="group"
            aria-label={INSTRUCTIONS_PROJECT_FILTER_LABEL}
          >
            <span className="text-sm font-medium text-muted-foreground">
              {INSTRUCTIONS_PROJECT_FILTER_LABEL}
            </span>
            <Button
              type="button"
              variant={!search.project ? "default" : "outline"}
              size="sm"
              aria-pressed={!search.project}
              onClick={() => navigate({ to: "/instructions", search: {} })}
            >
              {ALL_PROJECTS_LABEL}
            </Button>
            {projectOptions.map((o) => (
              <Button
                key={o.value}
                type="button"
                variant={search.project === o.value ? "default" : "outline"}
                size="sm"
                aria-pressed={search.project === o.value}
                onClick={() => navigate({ to: "/instructions", search: { project: o.value } })}
              >
                {o.label}
              </Button>
            ))}
            {workspaceTarget ? (
              <Button
                type="button"
                variant={search.project === "workspace" ? "default" : "outline"}
                size="sm"
                aria-pressed={search.project === "workspace"}
                onClick={() => navigate({ to: "/instructions", search: { project: "workspace" } })}
              >
                {WORKSPACE_TARGET_LABEL}
              </Button>
            ) : null}
          </div>

          <NeedsAttentionSection items={attentionItems} />

          <section aria-labelledby="instructions-knowledge" className="space-y-6">
            <h2 id="instructions-knowledge" className="text-lg font-semibold">
              Knowledge
            </h2>
            {selectedTarget && visibleTargets.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing to show for this filter.</p>
            ) : (
              <>
                {visibleTargets.map((t) =>
                  t.target === "workspace" && !workspaceHasContent ? null : (
                    <TargetSection
                      key={`${t.target}-${t.id}`}
                      target={t}
                      syncing={syncNow.isPending}
                      onSyncNow={() => syncNow.mutate()}
                      retireBusy={retireRule.isPending}
                      onRetire={(ruleId) => retireRule.mutate(ruleId)}
                      readdBusy={readdRule.isPending}
                      onReadd={(improvementId) => readdRule.mutate(improvementId)}
                      cancelWriteBusy={cancelWrite.isPending}
                      onCancelWrite={(versionId) => cancelWrite.mutate(versionId)}
                    />
                  ),
                )}
                {showWorkspaceFallbackNote ? (
                  <p className="text-sm text-muted-foreground">
                    No workspace-wide rules yet. Choose "Add to all my projects" on a suggestion to
                    create one.
                  </p>
                ) : null}
              </>
            )}
          </section>

          <SkillsSection proposals={visibleSkillProposals} />
        </>
      )}
    </div>
  );
}
