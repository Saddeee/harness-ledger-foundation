// The hosted runtime's Projects page: connect Lovable via OAuth, sync
// workspaces/projects from Supabase, and choose per-project read/write/
// replay permissions. Moved out of the route file unchanged so the route
// can switch between this and the local runtime's Projects page; the
// `connected` search param (set after the OAuth redirect back) is passed in
// as a prop instead of read via `Route.useSearch()`, so this component
// doesn't need to import the route module itself.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { callApi } from "@/lib/api-client";
import type { Database } from "@/integrations/supabase/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type WorkspacePatch = Database["public"]["Tables"]["workspaces"]["Update"];
type ProjectPatch = Database["public"]["Tables"]["projects"]["Update"];

type Connection = {
  email: string | null;
  expires_at: string | null;
  status: string | null;
  lovable_user_id: string | null;
} | null;

export function HostedProjects({ connected }: { connected: number | undefined }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (connected) toast.success("Lovable connected");
  }, [connected]);

  const connection = useQuery({
    queryKey: ["lovable_connection"],
    queryFn: () =>
      callApi<{ connection: Connection }>("/api/public/lovable/connection", { method: "GET" }).then(
        (r) => r.connection,
      ),
  });

  const workspaces = useQuery({
    queryKey: ["workspaces"],
    queryFn: async () => {
      const { data, error } = await supabase.from("workspaces").select("*").order("name");
      if (error) throw error;
      return data;
    },
  });

  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: async () => {
      const { data, error } = await supabase.from("projects").select("*").order("name");
      if (error) throw error;
      return data;
    },
  });

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const connect = () =>
    run("connect", async () => {
      const { url } = await callApi<{ url: string }>("/api/public/lovable/oauth-start");
      window.location.href = url;
    });

  const disconnect = () =>
    run("disconnect", async () => {
      await callApi("/api/public/lovable/connection", { method: "DELETE" });
      toast.success("Disconnected");
      qc.invalidateQueries({ queryKey: ["lovable_connection"] });
    });

  const sync = () =>
    run("sync", async () => {
      const r = await callApi<{ workspaces: number; projects: number }>(
        "/api/public/lovable/sync-projects",
      );
      toast.success(`Synced ${r.workspaces} workspace(s), ${r.projects} project(s)`);
      qc.invalidateQueries({ queryKey: ["workspaces"] });
      qc.invalidateQueries({ queryKey: ["projects"] });
      qc.invalidateQueries({ queryKey: ["lovable_connection"] });
    });

  const updateWorkspace = useMutation({
    mutationFn: async (v: { id: string; patch: WorkspacePatch }) => {
      const { error } = await supabase.from("workspaces").update(v.patch).eq("id", v.id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["workspaces"] }),
    onError: (e) => toast.error(e.message),
  });

  const updateProject = useMutation({
    mutationFn: async (v: { id: string; patch: ProjectPatch }) => {
      const { error } = await supabase.from("projects").update(v.patch).eq("id", v.id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
    onError: (e) => toast.error(e.message),
  });

  const conn = connection.data ?? null;

  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Projects</h1>
          <div className="flex gap-2">
            {conn ? (
              <Button variant="outline" onClick={disconnect} disabled={busy !== null}>
                {busy === "disconnect" ? "Disconnecting…" : "Disconnect"}
              </Button>
            ) : null}
            <Button
              variant={conn ? "outline" : "default"}
              onClick={connect}
              disabled={busy !== null}
            >
              {busy === "connect" ? "Redirecting…" : conn ? "Reconnect Lovable" : "Connect Lovable"}
            </Button>
            <Button onClick={sync} disabled={busy !== null || !conn}>
              {busy === "sync" ? "Syncing…" : "Sync projects"}
            </Button>
          </div>
        </div>
        <div className="text-sm text-muted-foreground">
          {connection.isLoading ? (
            "Checking connection…"
          ) : conn ? (
            <span>
              Connected as{" "}
              <span className="text-foreground">{conn.email ?? conn.lovable_user_id}</span> ·
              expires {conn.expires_at ? new Date(conn.expires_at).toLocaleString() : "—"} ·{" "}
              <Badge variant="outline">{conn.status ?? "unknown"}</Badge>
            </span>
          ) : (
            "Not connected."
          )}
        </div>
      </div>

      {(workspaces.data ?? []).length === 0 ? (
        <div className="rounded-md border border-dashed p-10 text-center text-sm text-muted-foreground">
          No workspaces yet. Connect Lovable, then press Sync projects.
        </div>
      ) : (
        (workspaces.data ?? []).map((ws) => {
          const wsProjects = (projects.data ?? []).filter((p) => p.workspace_id === ws.id);
          return (
            <section key={ws.id} className="space-y-3">
              <div className="flex flex-wrap items-center gap-6">
                <h2 className="text-lg font-medium">
                  {ws.name ?? ws.lovable_workspace_id}{" "}
                  {ws.plan ? <Badge variant="secondary">{ws.plan}</Badge> : null}
                </h2>
                <label className="flex items-center gap-2 text-sm">
                  <Switch
                    checked={!!ws.can_write_workspace_knowledge}
                    onCheckedChange={(v) =>
                      updateWorkspace.mutate({
                        id: ws.id,
                        patch: { can_write_workspace_knowledge: v },
                      })
                    }
                  />
                  Write workspace Knowledge
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <Switch
                    checked={!!ws.can_write_skills}
                    onCheckedChange={(v) =>
                      updateWorkspace.mutate({ id: ws.id, patch: { can_write_skills: v } })
                    }
                  />
                  Write Skills
                </label>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Project</TableHead>
                    <TableHead>Read</TableHead>
                    <TableHead>Write Knowledge</TableHead>
                    <TableHead>Replay</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {wsProjects.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={4} className="text-muted-foreground">
                        No projects in this workspace.
                      </TableCell>
                    </TableRow>
                  ) : (
                    wsProjects.map((p) => (
                      <TableRow key={p.id}>
                        <TableCell>
                          <div>{p.name ?? p.lovable_project_id}</div>
                          <div className="text-xs text-muted-foreground">
                            {p.lovable_project_id}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Switch
                            checked={!!p.can_read}
                            onCheckedChange={(v) =>
                              updateProject.mutate({
                                id: p.id,
                                // Turning read off also disables write and replay.
                                patch: v
                                  ? { can_read: true }
                                  : {
                                      can_read: false,
                                      can_write_knowledge: false,
                                      can_replay: false,
                                    },
                              })
                            }
                          />
                        </TableCell>
                        <TableCell>
                          <Switch
                            checked={!!p.can_write_knowledge}
                            disabled={!p.can_read}
                            onCheckedChange={(v) =>
                              updateProject.mutate({ id: p.id, patch: { can_write_knowledge: v } })
                            }
                          />
                        </TableCell>
                        <TableCell>
                          <Switch
                            checked={!!p.can_replay}
                            disabled={!p.can_read}
                            onCheckedChange={(v) =>
                              updateProject.mutate({ id: p.id, patch: { can_replay: v } })
                            }
                          />
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </section>
          );
        })
      )}
    </div>
  );
}
