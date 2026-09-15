// Projects page for the local runtime: connect/disconnect Lovable, see the
// last sync and the schedule, run a sync now, and choose which projects
// Harness is allowed to read. Only talks to the local Harness routes
// (fetchExecutor/postExecutor/fetchProjects/postProjects) -- the browser
// never reaches Lovable itself; syncing and Knowledge writes now run inline
// from the app process (Round 6 Task 2), started with the server itself.
import { Fragment, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDate } from "@/lib/harness-ux";
import {
  executorQueryOptions,
  fetchExecutor,
  fetchProjects,
  postExecutor,
  postProjects,
  syncResultText,
  type ProjectSettings,
  type ProjectsResponse,
} from "@/lib/improvements-client";

const PROJECTS_KEY = ["harness-projects"] as const;
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

const MCP_CREDITS_LINE =
  "Harness Ledger reads your chats and Knowledge through Lovable's MCP. Reading and writing Knowledge uses no credits.";

// The store's own default (harness/src/store.ts SETTING_DEFAULTS), used only
// until GET executor answers with the default actually in force.
const DEFAULT_MAX_ACTIVE_RULES = 12;

type Row = {
  id: string;
  name: string;
  allowed: boolean;
  last_synced_at: string | null;
  history_count: number | null;
  settings: ProjectSettings | null;
  test_copy_run: number | null;
};

// Per-project overrides of the two global defaults (spec §5): how many
// active rules this project may carry, and whether the executor is allowed
// to write approved changes for it automatically.
function ProjectSettingsPanel({
  projectId,
  settings,
  defaultMaxActiveRules,
  onSaved,
}: {
  projectId: string;
  settings: ProjectSettings;
  defaultMaxActiveRules: number;
  onSaved: () => void;
}) {
  const [maxActiveRules, setMaxActiveRules] = useState(
    settings.max_active_rules == null ? "" : String(settings.max_active_rules),
  );
  const [autoWrite, setAutoWrite] = useState(settings.auto_write);

  const save = useMutation({
    mutationFn: () =>
      postProjects({
        action: "project_settings",
        lovable_project_id: projectId,
        max_active_rules: maxActiveRules.trim() === "" ? null : Number(maxActiveRules),
        auto_write: autoWrite,
      }),
    onSuccess: () => {
      toast.success("Project settings saved");
      onSaved();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not save project settings"),
  });

  return (
    <div className="space-y-4 rounded-md border bg-muted/30 p-4">
      <div className="space-y-2">
        <Label htmlFor={`max-active-rules-${projectId}`}>Max active rules</Label>
        <Input
          id={`max-active-rules-${projectId}`}
          type="number"
          min={1}
          max={50}
          placeholder={`use default (${defaultMaxActiveRules})`}
          value={maxActiveRules}
          onChange={(e) => setMaxActiveRules(e.target.value)}
          disabled={save.isPending}
          className="max-w-[16rem]"
        />
      </div>
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={`auto-write-${projectId}`}>Write approved changes automatically</Label>
        <Switch
          id={`auto-write-${projectId}`}
          checked={autoWrite}
          onCheckedChange={setAutoWrite}
          disabled={save.isPending}
        />
      </div>
      <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
        {save.isPending ? "Saving…" : "Save"}
      </Button>
    </div>
  );
}

function lastSyncLine(
  lastRun:
    | {
        started_at: string;
        finished_at: string | null;
        ok: boolean | null;
        error: string | null;
        counts: Record<string, number>;
      }
    | null
    | undefined,
): string {
  if (!lastRun) return "No sync has run yet.";
  if (lastRun.ok === false) return `Last sync failed: ${lastRun.error ?? "unknown error"}`;
  const messages = lastRun.counts?.["messages"] ?? 0;
  const snapshots = lastRun.counts?.["knowledge_snapshots"] ?? 0;
  const when = lastRun.finished_at ?? lastRun.started_at;
  return `Last sync ${formatDate(when)}: ${messages} message${messages === 1 ? "" : "s"}, ${snapshots} Knowledge snapshot${snapshots === 1 ? "" : "s"}`;
}

export function LocalProjects() {
  const qc = useQueryClient();
  const executor = useQuery(executorQueryOptions);
  const projects = useQuery({ queryKey: PROJECTS_KEY, queryFn: fetchProjects });
  const [connecting, setConnecting] = useState(false);
  // The login URL, kept so it can be opened by hand if the browser blocked the tab.
  const [connectUrl, setConnectUrl] = useState<string | null>(null);

  // Polls GET executor every 3 s until the connection shows as connected,
  // and gives up after 10 minutes so a closed/abandoned OAuth tab doesn't
  // poll forever.
  useEffect(() => {
    if (!connecting) return;
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    const timer = setInterval(() => {
      if (Date.now() > deadline) {
        setConnecting(false);
        return;
      }
      fetchExecutor()
        .then((status) => {
          if (status.connection?.connected) {
            setConnecting(false);
            toast.success("Lovable connected");
            void qc.invalidateQueries({ queryKey: executorQueryOptions.queryKey });
            void qc.invalidateQueries({ queryKey: PROJECTS_KEY });
          }
        })
        .catch(() => {
          // transient errors just wait for the next tick
        });
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [connecting, qc]);

  const connect = useMutation({
    mutationFn: () => postExecutor({ action: "connect" }),
    onSuccess: (r) => {
      const url = (r as { url?: string }).url;
      if (url) {
        setConnectUrl(url);
        window.open(url, "_blank", "noopener");
      }
      setConnecting(true);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not start connecting"),
  });

  const disconnect = useMutation({
    mutationFn: () => postExecutor({ action: "disconnect" }),
    onSuccess: () => {
      toast.success("Disconnected");
      void qc.invalidateQueries({ queryKey: executorQueryOptions.queryKey });
      void qc.invalidateQueries({ queryKey: PROJECTS_KEY });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Disconnect failed"),
  });

  const syncNow = useMutation({
    mutationFn: () => postExecutor({ action: "sync_now" }),
    onSuccess: (data) => {
      toast.success(syncResultText(data));
      void qc.invalidateQueries({ queryKey: executorQueryOptions.queryKey });
      void qc.invalidateQueries({ queryKey: PROJECTS_KEY });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Sync failed"),
  });

  // Which row is mid-flight, so one slow toggle doesn't freeze every other
  // switch in the table.
  const [togglingId, setTogglingId] = useState<string | null>(null);

  // Which row's per-project settings panel is open (spec §5); at most one at
  // a time.
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const setAllowed = useMutation({
    mutationFn: (v: { id: string; name: string; allow: boolean }) =>
      v.allow
        ? postProjects({ action: "allow", lovable_project_id: v.id, label: v.name })
        : postProjects({ action: "disallow", lovable_project_id: v.id }),
    // Flip the switch immediately and put it back if the server refuses.
    onMutate: async (v) => {
      setTogglingId(v.id);
      await qc.cancelQueries({ queryKey: PROJECTS_KEY });
      const previous = qc.getQueryData<ProjectsResponse>(PROJECTS_KEY);
      if (previous?.all) {
        qc.setQueryData<ProjectsResponse>(PROJECTS_KEY, {
          ...previous,
          all: previous.all.map((p) => (p.id === v.id ? { ...p, allowed: v.allow } : p)),
        });
      }
      return { previous };
    },
    onError: (e, _v, ctx) => {
      if (ctx?.previous) qc.setQueryData<ProjectsResponse>(PROJECTS_KEY, ctx.previous);
      toast.error(e instanceof Error ? e.message : "Could not update the project");
    },
    onSettled: () => {
      setTogglingId(null);
      void qc.invalidateQueries({ queryKey: PROJECTS_KEY });
    },
  });

  if (executor.isLoading || projects.isLoading) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Projects</h1>
        <div className="rounded-md border p-6 text-sm text-muted-foreground">Loading…</div>
      </div>
    );
  }

  const conn = executor.data?.connection ?? { connected: false, email: null, workspaces: [] };
  const schedule = executor.data?.schedule;
  const lastRun = executor.data?.last_run ?? null;
  const nextRunAt = executor.data?.next_run_at ?? null;
  const running = Boolean(executor.data?.running);
  // Round 6 Task 2 / spec §2: which process is currently driving the
  // schedule -- the app itself (started with the server) or a separately
  // running `npm run harness:executor` loop.
  const scheduleHolder = executor.data?.schedule_holder ?? null;
  const scheduleHolderLine = scheduleHolder
    ? scheduleHolder.owner === "app"
      ? "Schedule: running in the app"
      : "Schedule: running in the executor process"
    : "Schedule: not running";

  const defaultMaxActiveRules =
    executor.data?.defaults?.max_active_rules ?? DEFAULT_MAX_ACTIVE_RULES;

  const allowedRows = projects.data?.allowed ?? [];
  const allRows = projects.data?.all;
  const rows: Row[] = allRows
    ? allRows.map((p) => {
        const known = allowedRows.find((a) => a.id === p.id);
        return {
          id: p.id,
          name: p.name,
          allowed: p.allowed,
          last_synced_at: known?.last_synced_at ?? null,
          history_count: known?.history_count ?? null,
          settings: known?.settings ?? null,
          test_copy_run: p.test_copy_run ?? null,
        };
      })
    : allowedRows.map((p) => ({
        id: p.id,
        name: p.name,
        allowed: true,
        last_synced_at: p.last_synced_at,
        history_count: p.history_count,
        settings: p.settings,
        test_copy_run: null,
      }));

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold">Projects</h1>

      <section className="space-y-2 rounded-md border p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm">
            {conn.connected ? (
              <>
                Connected to Lovable as{" "}
                <span className="font-medium">{conn.email ?? "your account"}</span>
              </>
            ) : (
              "Not connected to Lovable."
            )}
          </p>
          {conn.connected ? (
            <Button
              variant="outline"
              onClick={() => disconnect.mutate()}
              disabled={disconnect.isPending}
            >
              {disconnect.isPending ? "Disconnecting…" : "Disconnect"}
            </Button>
          ) : (
            <Button onClick={() => connect.mutate()} disabled={connect.isPending || connecting}>
              {connect.isPending || connecting ? "Waiting for Lovable…" : "Connect Lovable"}
            </Button>
          )}
        </div>
        {connecting && !conn.connected && connectUrl ? (
          <p className="text-sm">
            Lovable's login didn't open?{" "}
            <a href={connectUrl} target="_blank" rel="noopener noreferrer" className="underline">
              Open it here
            </a>
            . Approve access there and this page updates by itself.
          </p>
        ) : null}
        <p className="text-sm text-muted-foreground">{MCP_CREDITS_LINE}</p>
      </section>

      <section className="space-y-2 rounded-md border p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="space-y-1 text-sm">
            <p>{lastSyncLine(lastRun)}</p>
            {nextRunAt ? (
              <p className="text-muted-foreground">Syncs again at {formatDate(nextRunAt)}</p>
            ) : schedule && !schedule.enabled ? (
              <p className="text-muted-foreground">Scheduled sync is off.</p>
            ) : null}
            <p className="text-muted-foreground">{scheduleHolderLine}</p>
          </div>
          <Button onClick={() => syncNow.mutate()} disabled={running || syncNow.isPending}>
            {running || syncNow.isPending ? "Syncing…" : "Sync now"}
          </Button>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Projects</h2>
        {projects.data?.lovable_error ? (
          <p className="text-sm text-destructive">{projects.data.lovable_error}</p>
        ) : null}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Project</TableHead>
              <TableHead>Allowed</TableHead>
              <TableHead>Last synced</TableHead>
              <TableHead>Messages synced</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="text-muted-foreground">
                  No projects yet.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((p) => (
                <Fragment key={p.id}>
                  <TableRow>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        {p.allowed && p.settings ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-6 px-1 text-xs"
                            aria-expanded={expandedId === p.id}
                            onClick={() => setExpandedId((cur) => (cur === p.id ? null : p.id))}
                          >
                            {expandedId === p.id ? "▾" : "▸"} Settings
                          </Button>
                        ) : null}
                        <span>{p.name}</span>
                        {p.test_copy_run != null ? (
                          <span className="rounded border px-1.5 py-0.5 text-xs text-muted-foreground">
                            {`Test copy · test ${p.test_copy_run}`}
                          </span>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Switch
                        checked={p.allowed}
                        disabled={togglingId === p.id}
                        onCheckedChange={(v) =>
                          setAllowed.mutate({ id: p.id, name: p.name, allow: v })
                        }
                      />
                    </TableCell>
                    <TableCell>{p.last_synced_at ? formatDate(p.last_synced_at) : "—"}</TableCell>
                    <TableCell>{p.history_count ?? "—"}</TableCell>
                  </TableRow>
                  {expandedId === p.id && p.settings ? (
                    <TableRow>
                      <TableCell colSpan={4}>
                        <ProjectSettingsPanel
                          projectId={p.id}
                          settings={p.settings}
                          defaultMaxActiveRules={defaultMaxActiveRules}
                          onSaved={() => void qc.invalidateQueries({ queryKey: PROJECTS_KEY })}
                        />
                      </TableCell>
                    </TableRow>
                  ) : null}
                </Fragment>
              ))
            )}
          </TableBody>
        </Table>
      </section>
    </div>
  );
}
