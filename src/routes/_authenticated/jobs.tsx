import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/jobs")({
  head: () => ({
    meta: [
      { title: "Jobs — Harness Ledger" },
      { name: "description", content: "Background job queue and live event log." },
      { property: "og:title", content: "Jobs — Harness Ledger" },
      { property: "og:description", content: "Background job queue and live event log." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: JobsPage,
});

function JobsPage() {
  const qc = useQueryClient();

  const jobs = useQuery({
    queryKey: ["job_queue"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("job_queue")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return data;
    },
    refetchInterval: 10000,
  });

  const events = useQuery({
    queryKey: ["events"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("events")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return data;
    },
  });

  useEffect(() => {
    const channel = supabase
      .channel("events-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "events" }, () => {
        qc.invalidateQueries({ queryKey: ["events"] });
        qc.invalidateQueries({ queryKey: ["job_queue"] });
      })
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [qc]);

  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <h1 className="text-2xl font-semibold">Jobs</h1>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Kind</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Attempts</TableHead>
              <TableHead>Run after</TableHead>
              <TableHead>Error</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(jobs.data ?? []).length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground">
                  No jobs yet.
                </TableCell>
              </TableRow>
            ) : (
              (jobs.data ?? []).map((j) => (
                <TableRow key={j.id}>
                  <TableCell>{j.kind}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{j.status}</Badge>
                  </TableCell>
                  <TableCell>{j.attempts}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {j.run_after ? new Date(j.run_after).toLocaleString() : ""}
                  </TableCell>
                  <TableCell className="max-w-xs truncate text-xs">{j.error ?? ""}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <div className="space-y-3">
        <h2 className="text-lg font-semibold">Latest events</h2>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Ref</TableHead>
              <TableHead>Payload</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(events.data ?? []).length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="text-muted-foreground">
                  No events yet.
                </TableCell>
              </TableRow>
            ) : (
              (events.data ?? []).map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="text-xs text-muted-foreground">
                    {new Date(e.created_at).toLocaleString()}
                  </TableCell>
                  <TableCell>{e.kind}</TableCell>
                  <TableCell className="text-xs">
                    {e.ref_table}
                    {e.ref_id ? `:${e.ref_id.slice(0, 8)}` : ""}
                  </TableCell>
                  <TableCell className="max-w-md truncate font-mono text-xs">
                    {e.payload ? JSON.stringify(e.payload) : ""}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
