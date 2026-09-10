import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { HOW_IT_WORKS_STEPS } from "@/lib/harness-ux";
import {
  HOW_IT_WORKS_EVENT,
  fetchImprovements,
  groupOf,
  isDeferred,
  isHowItWorksDismissed,
  runtimeQueryOptions,
  setHowItWorksDismissed,
} from "@/lib/improvements-client";

export const Route = createFileRoute("/_authenticated/overview")({
  head: () => ({
    meta: [
      { title: "Overview — Harness Ledger" },
      { name: "description", content: "What needs your attention next." },
      { property: "og:title", content: "Overview — Harness Ledger" },
      { property: "og:description", content: "What needs your attention next." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Overview,
});

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

// The only place the product explains itself. Dismissable; the sidebar
// footer link brings it back.
function HowItWorksCard() {
  const [dismissed, setDismissed] = useState(() => isHowItWorksDismissed());
  useEffect(() => {
    const show = () => setDismissed(false);
    window.addEventListener(HOW_IT_WORKS_EVENT, show);
    return () => window.removeEventListener(HOW_IT_WORKS_EVENT, show);
  }, []);
  if (dismissed) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">How Harness works</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          {HOW_IT_WORKS_STEPS.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setHowItWorksDismissed(true);
            setDismissed(true);
          }}
        >
          Got it
        </Button>
      </CardContent>
    </Card>
  );
}

type NextAction = { text: string; label: string; improvementId: number; to: "/inbox" | "/ledger" };

// Only the single most useful next user action; nothing else. Silently
// absent when the local runtime isn't available (hosted preview).
function NextActionCard() {
  const navigate = useNavigate();
  const { data } = useQuery({
    queryKey: ["harness-next-action"],
    queryFn: async (): Promise<NextAction | null> => {
      const body = await fetchImprovements().catch(() => null);
      if (!body || !body.available) return null;
      const all = body.improvements ?? [];

      const pending = all.filter((i) => i.decision.status === "pending" && !isDeferred(i.id));
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
      const needsAttention = all.filter((i) => groupOf(i, false) === "Needs attention");
      const firstAttention = needsAttention[0];
      if (firstAttention) {
        return {
          text:
            needsAttention.length === 1
              ? "One improvement needs attention."
              : `${needsAttention.length} improvements need attention.`,
          label: "View",
          improvementId: firstAttention.id,
          to: "/ledger",
        };
      }
      const waiting = all.filter((i) => groupOf(i, false) === "Waiting to be added");
      const firstWaiting = waiting[0];
      if (firstWaiting) {
        return {
          text:
            waiting.length === 1
              ? "One improvement is waiting for Harness to add it to Lovable."
              : `${waiting.length} improvements are waiting for Harness to add them to Lovable.`,
          label: "View",
          improvementId: firstWaiting.id,
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

// Hosted-runtime widgets (Supabase-backed). Only meaningful in the hosted
// preview; the local runtime has no job queue and no hosted credit budget.
function HostedCards() {
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
    <>
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
    </>
  );
}

function Overview() {
  const runtime = useQuery(runtimeQueryOptions);
  // Undefined while loading -> treated as hosted, so nothing flashes away.
  const mode = runtime.data?.mode;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Overview</h1>

      {mode === "local" ? <HowItWorksCard /> : null}

      <NextActionCard />

      {mode === "hosted" || mode === undefined ? <HostedCards /> : null}
    </div>
  );
}
