// The History page's vertical timeline (Round 5 Task 4 / spec §3b): one
// node per Knowledge write, change Lovable made outside Harness, decision
// (accept/skip/retire/keep/re-add), Skill change, or rule verdict, for a
// single project/workspace target, newest first. Selecting a node shows its
// full text inline -- a diff is an optional toggle, never the default view
// (the owner's requirement: content visible, not only a diff behind a
// toggle). Nothing is expanded by default.
//
// ManagedBlockText and WhatChangedLines moved here from instructions.tsx
// (Round 3): this page is now the only place a "What changed" line diff is
// shown, and its version/external_change nodes are the only place a whole
// Knowledge document (with the Harness-managed block marked) is rendered.
// instructions.tsx still imports ManagedBlockText for its own collapsed
// "Full Knowledge text" section.
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/harness/decision-layout";
import { cn } from "@/lib/utils";
import { formatDate } from "@/lib/harness-ux";
import type { DiffLine, KnowledgeChanges, TimelineNode } from "@/lib/improvements-client";

const HARNESS_START = "<!-- harness:start -->";
const HARNESS_END = "<!-- harness:end -->";

const DIFF_LINE_STYLE: Record<DiffLine["kind"], string> = {
  "-": "text-red-700 dark:text-red-400",
  "+": "text-green-700 dark:text-green-400",
  " ": "text-muted-foreground",
};
const DIFF_LINE_PREFIX: Record<DiffLine["kind"], string> = {
  "-": "−",
  "+": "+",
  " ": " ",
};

// The server-computed line diff, capped at 400 lines, with removed lines in
// red and added lines in green so what changed is visible without diffing
// by hand.
export function WhatChangedLines({ changes }: { changes: KnowledgeChanges }) {
  return (
    <div className="space-y-0.5 font-mono text-xs">
      {changes.lines.map((line, i) => (
        <p key={i} className={cn("whitespace-pre-wrap break-words", DIFF_LINE_STYLE[line.kind])}>
          {DIFF_LINE_PREFIX[line.kind]}
          {line.text}
        </p>
      ))}
      {changes.truncated ? (
        <p className="pt-1 text-muted-foreground">Showing the first 400 lines of the change.</p>
      ) : null}
    </div>
  );
}

// The Harness-managed block, when present, gets its own visually marked
// area; everything the user wrote stays plain text either side of it.
export function ManagedBlockText({
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

function hasManagedBlock(content: string | null): boolean {
  return content != null && content.includes(HARNESS_START) && content.includes(HARNESS_END);
}

const ACTOR_LABEL: Record<TimelineNode["actor"], string> = {
  you: "You",
  harness: "Harness",
  lovable: "Lovable",
};

const RESTORE_TITLE = "Restore this version?";
const RESTORE_BODY = "Harness will write the earlier text back, as a new version.";

export function Timeline({
  nodes,
  onRestore,
  restoreDisabled,
}: {
  nodes: TimelineNode[];
  onRestore: (versionId: number) => void;
  restoreDisabled: boolean;
}) {
  // A single selection across the whole timeline -- only one node's full
  // text/diff is ever shown at a time. showDiff resets whenever the
  // selection changes, so a newly selected node always opens on its full
  // text first, never mid-diff from a previous selection.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showDiff, setShowDiff] = useState(false);

  function toggle(id: string) {
    setSelectedId((prev) => (prev === id ? null : id));
    setShowDiff(false);
  }

  function jumpTo(id: string) {
    setSelectedId(id);
    setShowDiff(false);
  }

  if (nodes.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Nothing has happened here yet. Rules you add, changes Harness writes, and your decisions
        will show up here.
      </p>
    );
  }

  return (
    <ol className="space-y-6 border-l pl-6">
      {nodes.map((node) => {
        const isSelected = selectedId === node.id;
        const isKnowledgeDoc = node.kind === "version" || node.kind === "external_change";
        const canRestore = node.restorable && node.version_id != null;

        return (
          <li key={node.id} className="relative">
            <span
              aria-hidden="true"
              className="absolute -left-[29px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-background bg-primary"
            />
            <button
              type="button"
              aria-expanded={isSelected}
              onClick={() => toggle(node.id)}
              className="w-full rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <p className="text-sm">
                <span className="text-muted-foreground">{formatDate(node.at)}</span>
                {" · "}
                <span className="font-medium">{node.label}</span>
                {" · "}
                <span className="text-xs uppercase tracking-wide text-muted-foreground">
                  {ACTOR_LABEL[node.actor]}
                </span>
              </p>
              {node.summary ? (
                <p className="text-xs text-muted-foreground">{node.summary}</p>
              ) : null}
            </button>

            {isSelected ? (
              <div className="mt-2 space-y-2 rounded-md border bg-muted/30 p-3">
                {node.diff ? (
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant={showDiff ? "outline" : "default"}
                      onClick={() => setShowDiff(false)}
                    >
                      Full text
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant={showDiff ? "default" : "outline"}
                      onClick={() => setShowDiff(true)}
                    >
                      Show as diff
                    </Button>
                  </div>
                ) : null}

                {showDiff && node.diff ? (
                  <WhatChangedLines changes={node.diff} />
                ) : node.content == null ? (
                  <p className="text-sm text-muted-foreground">Nothing here yet.</p>
                ) : isKnowledgeDoc ? (
                  <ManagedBlockText
                    content={node.content}
                    managedBlockPresent={hasManagedBlock(node.content)}
                  />
                ) : (
                  <pre className="whitespace-pre-wrap break-words rounded-md border bg-background p-3 font-mono text-xs">
                    {node.content}
                  </pre>
                )}

                {node.restored_from != null ? (
                  <button
                    type="button"
                    onClick={() => jumpTo(`version:${node.restored_from}`)}
                    className="text-xs text-primary underline underline-offset-2"
                  >
                    restored #{node.restored_from}
                  </button>
                ) : null}

                {node.improvement_id != null || (node.kind === "test" && node.run_id != null) ? (
                  <div className="flex flex-wrap gap-3">
                    {node.improvement_id != null ? (
                      <Link
                        to="/ledger"
                        search={{ improvement: node.improvement_id }}
                        className="text-xs text-primary underline underline-offset-2"
                      >
                        Open suggestion
                      </Link>
                    ) : null}
                    {node.kind === "test" && node.run_id != null ? (
                      <Link
                        to="/judge"
                        search={{ run: node.run_id }}
                        className="text-xs text-primary underline underline-offset-2"
                      >
                        Open comparison
                      </Link>
                    ) : null}
                  </div>
                ) : null}

                {canRestore ? (
                  <ConfirmAction
                    trigger="Restore this version"
                    title={RESTORE_TITLE}
                    body={RESTORE_BODY}
                    consequences={[]}
                    confirmLabel="Restore"
                    disabled={restoreDisabled}
                    onConfirm={() => onRestore(node.version_id!)}
                  />
                ) : null}
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
