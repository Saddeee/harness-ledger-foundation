// The Skills page: the workspace Skills Harness has read from Lovable, from
// the latest snapshots -- name, description, when it last changed, its
// content, and a per-skill history when more than one snapshot exists.
// Checkpoint 2 2-C: two sections, in this order -- "In Lovable" (this same
// read-only workspace list, unchanged data, just renamed from "In your
// workspace") and "Proposed by Harness Ledger" (local proposals, redesigned
// as cards: purpose, when it applies, a short procedure preview, the source
// correction, current state, and -- Checkpoint 3 S1 -- the one control that
// does change something remote: "Publish to Lovable" on an approved
// proposal not yet in Lovable, create only, never an update or delete).
// Only talks to the local Harness skills route (fetchSkills via
// skillsQueryOptions) and posts the same publish_skill_proposal action the
// suggestion detail's own Publish button does (postImprovementAction).
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmAction, DetailSection } from "@/components/harness/decision-layout";
import {
  formatDate,
  REVIEW_SKILL_LABEL,
  skillProposalAppliesWhen,
  skillProposalProcedurePreview,
  skillProposalPurpose,
  SKILL_NOT_PUBLISHED_LINE,
  skillProposalStatusLabel,
  skillProposalVersionCountLine,
  // ---- Checkpoint 3 S1 ----
  PUBLISH_SKILL_LABEL,
  PUBLISHING_SKILL_LABEL,
  PUBLISH_SKILL_TITLE,
  publishSkillConfirmBody,
  RETRY_LABEL,
  skillLovableStatusLine,
  skillPublishFailedLine,
  // ---- end Checkpoint 3 S1 ----
} from "@/lib/harness-ux";
import {
  postImprovementAction,
  skillsQueryOptions,
  type Skill,
  type SkillProposalCard,
} from "@/lib/improvements-client";

export const Route = createFileRoute("/_authenticated/skills")({
  head: () => ({
    meta: [
      { title: "Skills — Harness Ledger" },
      {
        name: "description",
        content:
          "The workspace Skills Harness Ledger can read from Lovable, and the Skill proposals it can publish there.",
      },
      { property: "og:title", content: "Skills — Harness Ledger" },
      {
        property: "og:description",
        content:
          "The workspace Skills Harness Ledger can read from Lovable, and the Skill proposals it can publish there.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Page,
});

const READ_ONLY_LINE =
  "Harness Ledger reads your workspace Skills, and can publish an approved proposal as a new one; it never updates or deletes a Skill.";
const EMPTY_LINE =
  "Your workspace has no Skills yet. Harness Ledger will show them here as soon as it reads one.";

// Checkpoint 2 2-C: "In Lovable" comes first (this is what Lovable itself
// already has), "Proposed by Harness Ledger" second (drafts nothing has
// published yet) -- the reverse of the WP4 ordering, an intentional change:
// what's real in Lovable now leads, what Harness Ledger is only proposing
// follows.
const WORKSPACE_HEADING = "In Lovable";
const PROPOSED_HEADING = "Proposed by Harness Ledger";
const PROPOSED_EMPTY_LINE = "Harness Ledger hasn't proposed a Skill from any suggestion yet.";

// Checkpoint 2 2-C: each proposal card shows name, purpose, when it
// applies, a short procedure preview, the source correction (linking back
// to /ledger with its own summary text), current state, and a single
// primary action -- "Review Skill" -- that only ever navigates to the
// suggestion detail. Checkpoint 3 S1 adds the one control that does change
// something remote: while lovable_state is "not_created", the honest
// "Not published to Lovable yet." line; once the proposal is approved, a
// "Publish to Lovable" button next to it (create only, refused if a Skill
// of that name already exists); once published, skillLovableStatusLine's
// own line instead; if publishing failed, the error and a Retry.
function ProposalCard({ proposal }: { proposal: SkillProposalCard }) {
  const purpose = skillProposalPurpose(proposal.content, proposal.correction_summary);
  const appliesWhen = skillProposalAppliesWhen(proposal.applies_when, proposal.destination_reason);
  const steps = skillProposalProcedurePreview(proposal.content);
  const qc = useQueryClient();
  const publish = useMutation({
    mutationFn: () =>
      postImprovementAction({ action: "publish_skill_proposal", proposal_id: proposal.id }),
    onSuccess: () => {
      toast.success("Publishing…");
      void qc.invalidateQueries({ queryKey: ["harness-skills"] });
    },
    onError: (e) =>
      toast.error(e instanceof Error ? e.message : "Could not publish this Skill to Lovable"),
  });

  return (
    <li className="space-y-2 rounded-md border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-medium">{proposal.name}</p>
        <span className="text-xs text-muted-foreground">
          {skillProposalStatusLabel(proposal.status)}
        </span>
        <span className="text-xs text-muted-foreground">
          {skillProposalVersionCountLine(proposal.version_count)}
        </span>
      </div>

      {purpose ? <p className="text-sm">{purpose}</p> : null}
      {appliesWhen ? (
        <p className="text-xs text-muted-foreground">When it applies: {appliesWhen}</p>
      ) : null}
      {steps.length > 0 ? (
        <ol className="list-decimal space-y-0.5 pl-5 text-xs text-muted-foreground">
          {steps.map((step, i) => (
            <li key={i}>{step}</li>
          ))}
        </ol>
      ) : null}

      {proposal.correction_summary ? (
        <p className="text-xs text-muted-foreground">
          From:{" "}
          <Link
            to="/ledger"
            search={{ improvement: proposal.correction_candidate_id }}
            className="text-primary underline underline-offset-2"
          >
            {proposal.correction_summary}
          </Link>
        </p>
      ) : null}

      {proposal.lovable_state === "created" ? (
        <p className="text-xs text-muted-foreground">{skillLovableStatusLine(proposal)}</p>
      ) : proposal.lovable_state === "failed" ? (
        <p className="text-xs text-muted-foreground">
          {skillPublishFailedLine(proposal.lovable_error)}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">{SKILL_NOT_PUBLISHED_LINE}</p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button asChild size="sm" variant="outline">
          <Link to="/ledger" search={{ improvement: proposal.correction_candidate_id }}>
            {REVIEW_SKILL_LABEL}
          </Link>
        </Button>
        {proposal.status === "approved" && proposal.lovable_state === "not_created" ? (
          <ConfirmAction
            trigger={publish.isPending ? PUBLISHING_SKILL_LABEL : PUBLISH_SKILL_LABEL}
            variant="outline"
            size="sm"
            title={PUBLISH_SKILL_TITLE}
            body={publishSkillConfirmBody(proposal.name)}
            consequences={[]}
            confirmLabel={PUBLISH_SKILL_LABEL}
            disabled={publish.isPending}
            onConfirm={() => publish.mutate()}
          />
        ) : null}
        {proposal.lovable_state === "failed" ? (
          <Button size="sm" disabled={publish.isPending} onClick={() => publish.mutate()}>
            {RETRY_LABEL}
          </Button>
        ) : null}
      </div>
    </li>
  );
}

function SkillSection({ skill, workspaceId }: { skill: Skill; workspaceId: string | null }) {
  const lastChanged = skill.updated_at_remote ?? skill.fetched_at;
  return (
    <section className="space-y-3 rounded-md border p-4">
      <div>
        <h2 className="text-lg font-semibold">{skill.name}</h2>
        {skill.description ? (
          <p className="text-sm text-muted-foreground">{skill.description}</p>
        ) : null}
      </div>

      <p className="text-sm text-muted-foreground">Last changed {formatDate(lastChanged)}</p>

      <DetailSection title="Content">
        <pre className="whitespace-pre-wrap break-words font-mono text-xs">{skill.content}</pre>
      </DetailSection>

      {skill.history.length > 1 && workspaceId ? (
        <Link
          to="/history"
          search={{ target: "workspace", id: workspaceId }}
          className="text-sm text-primary underline underline-offset-2"
        >
          See on the History page
        </Link>
      ) : null}
    </section>
  );
}

function Page() {
  const query = useQuery(skillsQueryOptions);

  if (query.isLoading) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Skills</h1>
        <div className="rounded-md border p-6 text-sm text-muted-foreground">Loading…</div>
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Skills</h1>
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
        <h1 className="text-2xl font-semibold">Skills</h1>
        <p className="text-sm text-muted-foreground">
          Skills are available when Harness Ledger runs on your machine.
        </p>
      </div>
    );
  }

  const skills = query.data?.skills ?? [];
  const proposals = (query.data?.proposals ?? []) as SkillProposalCard[];
  const workspaceId = query.data?.workspace_id ?? null;

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold">Skills</h1>

      <section aria-labelledby="workspace-skills" className="space-y-3">
        <h2 id="workspace-skills" className="text-lg font-semibold">
          {WORKSPACE_HEADING}
        </h2>
        <p className="text-sm text-muted-foreground">{READ_ONLY_LINE}</p>

        {skills.length === 0 ? (
          <div className="rounded-md border border-dashed p-10 text-center text-sm text-muted-foreground">
            {EMPTY_LINE}
          </div>
        ) : (
          skills.map((s) => <SkillSection key={s.name} skill={s} workspaceId={workspaceId} />)
        )}
      </section>

      <section aria-labelledby="proposed-skills" className="space-y-3">
        <h2 id="proposed-skills" className="text-lg font-semibold">
          {PROPOSED_HEADING}
        </h2>
        {proposals.length === 0 ? (
          <p className="text-sm text-muted-foreground">{PROPOSED_EMPTY_LINE}</p>
        ) : (
          <ul className="space-y-3">
            {proposals.map((p) => (
              <ProposalCard key={p.id} proposal={p} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
