// The Skills page: the workspace Skills Harness has read from Lovable, from
// the latest snapshots -- name, description, when it last changed, its
// content, and a per-skill history when more than one snapshot exists. Read
// only: Harness does not write Skills yet. Only talks to the local Harness
// skills route (fetchSkills via skillsQueryOptions).
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { DetailSection } from "@/components/harness/decision-layout";
import { formatDate } from "@/lib/harness-ux";
import { skillsQueryOptions, type Skill } from "@/lib/improvements-client";

export const Route = createFileRoute("/_authenticated/skills")({
  head: () => ({
    meta: [
      { title: "Skills — Harness Ledger" },
      {
        name: "description",
        content: "The workspace Skills Harness Ledger can currently read from Lovable.",
      },
      { property: "og:title", content: "Skills — Harness Ledger" },
      {
        property: "og:description",
        content: "The workspace Skills Harness Ledger can currently read from Lovable.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Page,
});

const READ_ONLY_LINE = "Harness Ledger reads your workspace Skills; it does not write them yet.";
const EMPTY_LINE =
  "Your workspace has no Skills yet. Harness Ledger will show them here as soon as it reads one.";

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
  const workspaceId = query.data?.workspace_id ?? null;

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold">Skills</h1>
      <p className="text-sm text-muted-foreground">{READ_ONLY_LINE}</p>

      {skills.length === 0 ? (
        <div className="rounded-md border border-dashed p-10 text-center text-sm text-muted-foreground">
          {EMPTY_LINE}
        </div>
      ) : (
        skills.map((s) => <SkillSection key={s.name} skill={s} workspaceId={workspaceId} />)
      )}
    </div>
  );
}
