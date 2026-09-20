// Round 9 Task 2: the one project chip row every list page uses -- Inbox
// and Instructions used to hand-roll the exact same "Show" segmented
// control (same copy, same variant rules, same "All projects" first chip),
// and the owner review round 7 fix 1 comment on Inbox even said so in so
// many words. Tests and History gain it here too rather than growing their
// own fourth copy. Options are filtered through isTestCopyProject inside
// the component itself, not left to each page to remember -- a Lovable
// test copy (Harness Ledger's own throwaway build for a replay) must never
// be offered as a project choice anywhere.
import { Button } from "@/components/ui/button";
import {
  ALL_PROJECTS_LABEL,
  INSTRUCTIONS_PROJECT_FILTER_LABEL,
  isTestCopyProject,
  WORKSPACE_TARGET_LABEL,
} from "@/lib/harness-ux";

export type ProjectFilterOption = { id: string; name: string };

export function ProjectFilter({
  options,
  value,
  onChange,
  includeWorkspace = false,
  label = INSTRUCTIONS_PROJECT_FILTER_LABEL,
}: {
  options: ProjectFilterOption[];
  value: string | "all";
  onChange: (value: string | "all") => void;
  includeWorkspace?: boolean;
  label?: string;
}) {
  const visibleOptions = options.filter((o) => !isTestCopyProject(o.name));

  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label={label}>
      <span className="text-sm font-medium text-muted-foreground">{label}</span>
      <Button
        type="button"
        variant={value === "all" ? "default" : "outline"}
        size="sm"
        aria-pressed={value === "all"}
        onClick={() => onChange("all")}
      >
        {ALL_PROJECTS_LABEL}
      </Button>
      {visibleOptions.map((o) => (
        <Button
          key={o.id}
          type="button"
          variant={value === o.id ? "default" : "outline"}
          size="sm"
          aria-pressed={value === o.id}
          onClick={() => onChange(o.id)}
        >
          {o.name}
        </Button>
      ))}
      {includeWorkspace ? (
        <Button
          type="button"
          variant={value === "workspace" ? "default" : "outline"}
          size="sm"
          aria-pressed={value === "workspace"}
          onClick={() => onChange("workspace")}
        >
          {WORKSPACE_TARGET_LABEL}
        </Button>
      ) : null}
    </div>
  );
}

export { isTestCopyProject };
