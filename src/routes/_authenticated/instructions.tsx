// The Instructions page (formerly Knowledge): what Harness currently sees in
// each Lovable project's/workspace's Knowledge, and the instructions it has
// added there (Round 3 §2). The write history and its per-version change
// diff moved to the History page (Round 5 §3b) -- this page shows only
// current.
// Round 9 Task 5 / spec §5: one heading per project (an <h2>, not a card),
// one bordered row per instruction underneath -- the shared InstructionActions
// component at size="row" (Round 9 Task 3), then the collapsed "Full
// Knowledge text as Lovable sees it" fold. No "Needs your attention"
// section any more (spec §1 principle 6: the Inbox owns attention -- see
// RuleAttentionCard in improvement.tsx -- this page never asks the same
// question twice), no per-row "..." menu, no per-row Keep/Review/Retire/
// Not-sure VerdictControl. "Skills" stays, a one-line-per-proposal summary
// that only ever links out to /skills or /ledger; no Skill control of any
// kind lives here.
// Only talks to the local Harness routes (fetchKnowledge/fetchSkills/
// postExecutor/postImprovementAction) -- writing to Lovable itself happens
// in the executor process, never from this page.
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { AdvancedDetails, DetailSection } from "@/components/harness/decision-layout";
import { ManagedBlockText } from "@/components/harness/timeline";
import { InstructionActions, useRun, type Run } from "@/components/harness/improvement";
import { ProjectFilter } from "@/components/harness/project-filter";
import {
  aiCheckSentence,
  attentionBlock,
  CANCEL_WRITE_TOAST,
  formatDate,
  instructionFallbackText,
  instructionState,
  instructionStateLine,
  INSTRUCTIONS_ADDED_HEADING,
  isTestCopyProject,
  NO_INSTRUCTIONS_YET_LINE,
  NO_WORKSPACE_INSTRUCTIONS_LINE,
  observedSentence,
  retiredInstructionsFoldLabel,
  skillProposalStatusLabel,
  WORKSPACE_TARGET_EXPLANATION,
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
  type KnowledgeActiveRule,
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

// Round 9 Task 5 / spec §2: RULE_STATUS_LABEL (In Lovable/Staged/Write
// needs attention/Testing) is gone -- a row's own state line is now the
// same instructionStateLine every page shows (Round 9 Task 1), passed
// write_status: "written" below (see RuleRow), so it only ever distinguishes
// In Lovable/Retired, never the in-flight write lifecycle. That lifecycle
// stays visible where it's actionable -- the target-level pending-write
// banner further down -- never duplicated per row.

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

// Round 9 Task 5 / spec §1 principle 1, §5: one object, one shape -- a row
// is the shared InstructionActions component at size="row", the same
// text/state-line/evidence/actions shape Inbox and the detail page render
// at their own sizes, never a bespoke layout of its own. `retired` decides
// the state (instructionState's own precedence already treats a retired
// decision as terminal, ahead of health) -- the same component renders
// both an active row and a row inside the collapsed Retired fold below.
function RuleRow({
  rule,
  retired,
  busy,
  run,
}: {
  rule: KnowledgeActiveRule;
  retired: boolean;
  busy: boolean;
  run: Run;
}) {
  const improvementId = rule.improvement_id;
  const text = rule.text || instructionFallbackText(rule.id);
  const state = instructionState({
    decision: { status: "accepted", retired },
    health: rule.health ?? null,
  });
  // The row's own "since" (added, or -- once the knowledge route reports
  // one -- last changed for a retired row) drives whichever of
  // written_at/decided_at instructionStateLine's own state actually reads;
  // write_status is always "written" here -- a row is either live (in
  // Lovable) or retired, never a staged/failed/testing write of its own
  // (that in-flight lifecycle stays on the target's pending-write banner,
  // never duplicated per row).
  const stateLine = instructionStateLine({
    state,
    decided_at: rule.since ?? null,
    written_at: rule.since ?? null,
    write_status: "written",
  });
  const attention = state === "live_attention" ? attentionBlock(rule.health ?? null) : null;
  const observed = retired ? null : observedSentence(rule.health ?? null);
  const aiCheck = retired ? null : aiCheckSentence(rule.health ?? null);
  const openHref =
    improvementId != null ? `/ledger?improvement=${improvementId}&from=instructions` : undefined;

  return (
    <article className="space-y-2 rounded-md border p-4">
      <p className="text-base font-medium">{text}</p>
      <p className="text-xs text-muted-foreground">{stateLine}</p>
      {/* spec §3: an attention row says why in one line, above the actions -- never a different action set from an ordinary live row's own. */}
      {attention ? <p className="text-xs text-muted-foreground">{attention.line}</p> : null}
      {observed ? <p className="text-xs text-muted-foreground">{observed}</p> : null}
      {aiCheck ? <p className="text-xs text-muted-foreground">{aiCheck}</p> : null}
      <InstructionActions
        rule={{ rule_id: rule.id, improvement_id: improvementId }}
        state={state}
        size="row"
        busy={busy}
        run={run}
        {...(openHref ? { openHref } : {})}
      />
    </article>
  );
}

// Collapsed by default -- a project with no retired instructions never
// shows this at all. Reuses AdvancedDetails (its own "rounded-md border"
// fold, defined once in decision-layout.tsx) rather than a second,
// hand-rolled bordered wrapper of its own -- rows are the only bordered
// boxes this page defines directly (spec §5).
function RetiredInstructionsFold({
  rules,
  busy,
  run,
}: {
  rules: KnowledgeActiveRule[];
  busy: boolean;
  run: Run;
}) {
  if (rules.length === 0) return null;
  return (
    <AdvancedDetails title={retiredInstructionsFoldLabel(rules.length)}>
      <div className="space-y-3">
        {rules.map((r) => (
          <RuleRow key={r.id} rule={r} retired busy={busy} run={run} />
        ))}
      </div>
    </AdvancedDetails>
  );
}

// Round 9 Task 5 / spec §5: the target heading is an <h2>, not a card --
// this function's own root renders no "rounded-md border" of its own at
// all (rows, and the AdvancedDetails/DetailSection folds they and the
// Knowledge text sit inside, are the only bordered boxes on this page).
function TargetSection({
  target,
  syncing,
  onSyncNow,
  busy,
  run,
  cancelWriteBusy,
  onCancelWrite,
}: {
  target: KnowledgeTargetView;
  syncing: boolean;
  onSyncNow: () => void;
  busy: boolean;
  run: Run;
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
  // own name for the target) didn't answer that. Round 9 Task 2 renamed the
  // label itself to WORKSPACE_TARGET_LABEL ("All my projects"); Round 9
  // Task 5 keeps the same explanatory sub-line, reworded to say
  // "instructions" (spec §2 vocabulary).
  const isWorkspace = target.target === "workspace";

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">
          {isWorkspace ? WORKSPACE_TARGET_LABEL : target.name}
        </h2>
        {isWorkspace ? (
          <p className="text-sm text-muted-foreground">{WORKSPACE_TARGET_EXPLANATION}</p>
        ) : null}
        <p className="text-sm text-muted-foreground">{statusLine}</p>
      </div>

      {/* Round 9 Task 5 / spec §5: a project with no instructions renders
          just the heading above, this one line, and the Knowledge fold
          below -- no card, no empty "Instructions Harness Ledger added"
          heading over nothing. */}
      {target.active_rules.length === 0 ? (
        <p className="text-sm text-muted-foreground">{NO_INSTRUCTIONS_YET_LINE}</p>
      ) : (
        <div className="space-y-3">
          <h3 className="text-sm font-medium">{INSTRUCTIONS_ADDED_HEADING}</h3>
          {target.active_rules.map((r) => (
            <RuleRow key={r.id} rule={r} retired={false} busy={busy} run={run} />
          ))}
        </div>
      )}
      <RetiredInstructionsFold rules={target.retired_rules} busy={busy} run={run} />

      <DetailSection
        title={`Full Knowledge text as Lovable sees it (${content.length} characters)`}
      >
        <KnowledgeText content={content} managedBlockPresent={target.managed_block_present} />
      </DetailSection>

      {target.pending_write ? (
        // Round 9 Task 5 / spec §5: this banner's own "Sync now" is kept
        // (it's the only way to retry a write that failed or never went
        // out, not a duplicate of the page header's own button, which
        // re-reads every target's Knowledge instead) -- but it's no longer
        // a bordered box of its own; a tinted background is enough to mark
        // it as a notice, and rows stay the only bordered boxes here.
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/30 p-3 text-sm">
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

// Round 9 Task 5 / spec §1 principle 6, §5: "Needs your attention" is gone
// from this page outright -- every decision it asked for is decidable on
// the Inbox's own attention card (RuleAttentionCard, improvement.tsx),
// which already reuses this same attentionBlock() helper for its "why"
// line; this page repeats the same fact on each live row instead of asking
// it again in a second section above (spec principle 4: no contradictions,
// never two places disagreeing about whether attention is needed).

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

  // Round 9 Task 5 / spec §3: every row's Keep/Retire/Test/Re-add now goes
  // through the one shared InstructionActions component (Round 9 Task 3),
  // which needs the same busy/run pair useRun already gives every other
  // caller (Inbox, the detail page) -- replaces this page's own hand-rolled
  // retire/readd useMutations (Task C2's original manual-Retire/Re-add
  // path), both of which invalidated the same two queries this does.
  const { busy: rowBusy, run: rowRun } = useRun((msg) => {
    toast.success(msg);
    void qc.invalidateQueries({ queryKey: ["harness-knowledge"] });
    void qc.invalidateQueries({ queryKey: ["harness-improvements"] });
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
  // Round 9 Task 5: a Lovable test copy (a throwaway project Harness Ledger
  // itself made for a historical replay) never earns its own section here
  // -- ProjectFilter already hides it from the filter chips (Round 9 Task
  // 2), this drops it from the section list itself too.
  const targets = (data?.targets ?? []).filter(
    (t) => t.target !== "project" || !isTestCopyProject(t.name),
  );
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
    .map((t) => ({ id: t.id, name: t.name }));
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
          {/* Round 9 Task 2: the shared ProjectFilter -- All projects plus
              one chip per allowed project plus the workspace target (only
              offered once one actually exists) -- narrows Knowledge and
              Skills below to the chosen target; changes the URL
              (?project=) so an Overview/Inbox link can open here already
              scoped. */}
          <ProjectFilter
            options={projectOptions}
            value={search.project ?? "all"}
            onChange={(v) =>
              navigate({ to: "/instructions", search: v === "all" ? {} : { project: v } })
            }
            includeWorkspace={workspaceTarget != null}
          />

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
                      busy={rowBusy}
                      run={rowRun}
                      cancelWriteBusy={cancelWrite.isPending}
                      onCancelWrite={(versionId) => cancelWrite.mutate(versionId)}
                    />
                  ),
                )}
                {showWorkspaceFallbackNote ? (
                  <p className="text-sm text-muted-foreground">{NO_WORKSPACE_INSTRUCTIONS_LINE}</p>
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
