import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const Route = createFileRoute("/_authenticated/overview")({
  head: () => ({
    meta: [
      { title: "Overview — Harness Ledger" },
      { name: "description", content: "This month's credit usage and job queue status." },
      { property: "og:title", content: "Overview — Harness Ledger" },
      { property: "og:description", content: "This month's credit usage and job queue status." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Overview,
});

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

async function harnessHeaders(): Promise<HeadersInit> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

type NextAction = { text: string; label: string; improvementId: number; to: "/inbox" | "/ledger" };

type ImprovementSummary = {
  id: number;
  decision: { status: "pending" | "accepted" | "skipped" };
  stages: { key: string; state: string }[];
};

// Only the single most useful next user action; nothing else. Silently
// absent when the local runtime isn't available (hosted preview).
function NextActionCard() {
  const navigate = useNavigate();
  const { data } = useQuery({
    queryKey: ["harness-next-action"],
    queryFn: async (): Promise<NextAction | null> => {
      const res = await fetch("/api/public/harness/improvements", {
        headers: await harnessHeaders(),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as {
        available: boolean;
        improvements?: ImprovementSummary[];
      };
      if (!body.available) return null;
      const all = body.improvements ?? [];

      const pending = all.filter((i) => i.decision.status === "pending");
      const firstPending = pending[0];
      if (firstPending) {
        return {
          text:
            pending.length === 1
              ? "One improvement is waiting for your decision."
              : `${pending.length} improvements are waiting for your decision.`,
          label: "Review",
          improvementId: firstPending.id,
          to: "/inbox",
        };
      }
      const waitingForProof = all.filter(
        (i) =>
          i.decision.status === "accepted" &&
          !i.stages.some((s) => s.key === "proof" && s.state === "complete"),
      );
      const firstWaiting = waitingForProof[0];
      if (firstWaiting) {
        return {
          text:
            waitingForProof.length === 1
              ? "One improvement is waiting for proof — running it isn't available yet."
              : `${waitingForProof.length} improvements are waiting for proof — running it isn't available yet.`,
          label: "View",
          improvementId: firstWaiting.id,
          // decided items live under Improvements, not Inbox
          to: "/ledger",
        };
      }
      return null;
    },
  });

  if (!data) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Next up</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm">{data.text}</p>
        <Button
          size="sm"
          onClick={() => navigate({ to: data.to, search: { improvement: data.improvementId } })}
        >
          {data.label}
        </Button>
      </CardContent>
    </Card>
  );
}

function Overview() {
  const { data } = useQuery({
    queryKey: ["overview"],
    queryFn: async () => {
      const month = currentMonth();
      const [budgetRes, totalRes, jobsRes] = await Promise.all([
        supabase.from("settings").select("value").eq("key", "monthly_credit_budget").maybeSingle(),
        supabase.from("credit_month_totals").select("total").eq("month", month).maybeSingle(),
        supabase.from("job_queue").select("status").in("status", ["queued", "running"]),
      ]);
      const budget = Number(budgetRes.data?.value ?? 0);
      const used = Number(totalRes.data?.total ?? 0);
      const jobs = jobsRes.data ?? [];
      return {
        budget,
        used,
        queued: jobs.filter((j) => j.status === "queued").length,
        running: jobs.filter((j) => j.status === "running").length,
      };
    },
    refetchInterval: 15000,
  });

  const budget = data?.budget ?? 0;
  const used = data?.used ?? 0;
  const pct = budget > 0 ? Math.min(100, (used / budget) * 100) : 0;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Overview</h1>

      <NextActionCard />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Credits this month</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Progress value={pct} />
          <p className="text-sm text-muted-foreground">
            {used} of {budget} credits used ({Math.round(pct)}%)
          </p>
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Queued jobs</CardTitle>
          </CardHeader>
          <CardContent className="text-3xl font-semibold">{data?.queued ?? 0}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Running jobs</CardTitle>
          </CardHeader>
          <CardContent className="text-3xl font-semibold">{data?.running ?? 0}</CardContent>
        </Card>
      </div>
    </div>
  );
}
