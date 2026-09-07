import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { SETTINGS_DEFAULTS } from "@/lib/settings-defaults";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

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

function SettingsPage() {
  const qc = useQueryClient();
  const [values, setValues] = useState<Values>({ ...SETTINGS_DEFAULTS });
  const [modelsText, setModelsText] = useState(
    JSON.stringify(SETTINGS_DEFAULTS["llm_models"], null, 2),
  );
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
    setModelsText(JSON.stringify(next["llm_models"] ?? {}, null, 2));
  }, [data]);

  async function save() {
    let models: unknown;
    try {
      models = JSON.parse(modelsText);
    } catch {
      toast.error("Model list is not valid JSON");
      return;
    }
    setSaving(true);
    const { data: userData } = await supabase.auth.getUser();
    const userId = userData.user?.id;
    const rows = Object.keys(SETTINGS_DEFAULTS).map((key) => ({
      owner_user_id: userId!,
      key,
      value: (key === "llm_models" ? models : values[key]) as never,
    }));
    const { error } = await supabase.from("settings").upsert(rows, {
      onConflict: "owner_user_id,key",
    });
    setSaving(false);
    if (error) toast.error(error.message);
    else {
      toast.success("Settings saved");
      qc.invalidateQueries({ queryKey: ["settings"] });
      qc.invalidateQueries({ queryKey: ["overview"] });
    }
  }

  const numberKeys = [
    "monthly_credit_budget",
    "drift_check_every_n",
    "max_active_rules",
    "knowledge_char_cap",
  ];
  const boolKeys = ["require_replay_approval", "keep_forks", "one_change_per_day", "kill_switch"];

  return (
    <div className="max-w-xl space-y-6">
      <h1 className="text-2xl font-semibold">Settings</h1>

      <div className="space-y-4">
        {numberKeys.map((key) => (
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

        {boolKeys.map((key) => (
          <div key={key} className="flex items-center justify-between rounded-md border p-3">
            <Label htmlFor={key}>{key.replace(/_/g, " ")}</Label>
            <Switch
              id={key}
              checked={Boolean(values[key])}
              onCheckedChange={(checked) => setValues((v) => ({ ...v, [key]: checked }))}
            />
          </div>
        ))}

        <div className="space-y-2">
          <Label htmlFor="llm_provider">llm provider</Label>
          <Input
            id="llm_provider"
            value={String(values["llm_provider"] ?? "")}
            onChange={(e) => setValues((v) => ({ ...v, llm_provider: e.target.value }))}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="llm_models">llm models (JSON)</Label>
          <Textarea
            id="llm_models"
            rows={7}
            className="font-mono text-xs"
            value={modelsText}
            onChange={(e) => setModelsText(e.target.value)}
          />
        </div>

        <Button onClick={save} disabled={saving}>
          Save settings
        </Button>
      </div>
    </div>
  );
}
