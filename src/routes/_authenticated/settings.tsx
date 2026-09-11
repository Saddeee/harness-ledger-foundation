import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { SETTINGS_DEFAULTS } from "@/lib/settings-defaults";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { runtimeQueryOptions } from "@/lib/improvements-client";
import { LocalSettings } from "@/components/harness/local-settings";

export const Route = createFileRoute("/_authenticated/settings")({
  head: () => ({
    meta: [
      { title: "Settings — Harness Ledger" },
      { name: "description", content: "Budgets, autonomy and model settings for Harness Ledger." },
      { property: "og:title", content: "Settings — Harness Ledger" },
      {
        property: "og:description",
        content: "Budgets, autonomy and model settings for Harness Ledger.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: SettingsPage,
});

type Values = Record<string, unknown>;

// The hosted form only shows the two keys that still have a consumer in the
// hosted runtime: kill_switch (the hosted worker's autonomy guard) and
// monthly_credit_budget (shown under Advanced below). Every other legacy
// key (drift/rule/replay/LLM settings) has no reader left and is gone from
// this page.
const HOSTED_NUMBER_KEYS = ["monthly_credit_budget"];
const HOSTED_BOOL_KEYS = ["kill_switch"];

// While the runtime is still loading, `mode` is undefined -- not "local" --
// so the hosted form renders by default, same as Projects.
function SettingsPage() {
  const runtime = useQuery(runtimeQueryOptions);
  const mode = runtime.data?.mode;
  return mode === "local" ? <LocalSettings /> : <HostedSettings />;
}

function HostedSettings() {
  const qc = useQueryClient();
  const [values, setValues] = useState<Values>({ ...SETTINGS_DEFAULTS });
  const [saving, setSaving] = useState(false);

  const { data } = useQuery({
    queryKey: ["settings"],
    queryFn: async () => {
      const { data, error } = await supabase.from("settings").select("key, value");
      if (error) throw error;
      return data;
    },
  });

  useEffect(() => {
    if (!data) return;
    const next: Values = { ...SETTINGS_DEFAULTS };
    for (const row of data) next[row.key as string] = row.value;
    setValues(next);
  }, [data]);

  async function save() {
    setSaving(true);
    const { data: userData } = await supabase.auth.getUser();
    const userId = userData.user?.id;
    const rows = [...HOSTED_NUMBER_KEYS, ...HOSTED_BOOL_KEYS].map((key) => ({
      owner_user_id: userId!,
      key,
      value: values[key] as never,
    }));
    const { error } = await supabase.from("settings").upsert(rows, {
      onConflict: "owner_user_id,key",
    });
    setSaving(false);
    if (error) toast.error(error.message);
    else {
      toast.success("Settings saved");
      qc.invalidateQueries({ queryKey: ["settings"] });
      qc.invalidateQueries({ queryKey: ["hosted-usage"] });
    }
  }

  return (
    <div className="max-w-xl space-y-6">
      <h1 className="text-2xl font-semibold">Settings</h1>

      <div className="space-y-4">
        {HOSTED_NUMBER_KEYS.map((key) => (
          <div key={key} className="space-y-2">
            <Label htmlFor={key}>{key.replace(/_/g, " ")}</Label>
            <Input
              id={key}
              type="number"
              value={String(values[key] ?? "")}
              onChange={(e) => setValues((v) => ({ ...v, [key]: Number(e.target.value) }))}
            />
          </div>
        ))}

        {HOSTED_BOOL_KEYS.map((key) => (
          <div key={key} className="flex items-center justify-between rounded-md border p-3">
            <Label htmlFor={key}>{key.replace(/_/g, " ")}</Label>
            <Switch
              id={key}
              checked={Boolean(values[key])}
              onCheckedChange={(checked) => setValues((v) => ({ ...v, [key]: checked }))}
            />
          </div>
        ))}

        <Button onClick={save} disabled={saving}>
          Save settings
        </Button>
      </div>

      <AdvancedSection />
    </div>
  );
}

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

// Hosted-runtime widgets (Supabase-backed) that used to live on Overview.
// Only meaningful in the hosted preview; the local runtime has no job queue
// and no hosted credit budget, so this renders nothing there.
function AdvancedSection() {
  const runtime = useQuery(runtimeQueryOptions);
  const { data } = useQuery({
    queryKey: ["hosted-usage"],
    enabled: runtime.data?.mode === "hosted",
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

  if (runtime.data?.mode !== "hosted") return null;

  const budget = data?.budget ?? 0;
  const used = data?.used ?? 0;
  const pct = budget > 0 ? Math.min(100, (used / budget) * 100) : 0;

  return (
    <details className="rounded-md border">
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        Advanced
      </summary>
      <div className="space-y-4 border-t p-3">
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
        <Link to="/jobs" className="text-sm text-primary underline underline-offset-2">
          Job queue and event log
        </Link>
      </div>
    </details>
  );
}
