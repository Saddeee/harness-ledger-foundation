// Settings page for the local runtime: the sync schedule, the Knowledge
// character cap, AI analysis (provider/key/per-role models/budget -- stored
// only, analysis itself is not switched on), the defaults new projects get,
// and a read-only note about approval. Only talks to the executor route
// (fetchExecutor/postExecutor) -- nothing on this page ever writes to
// Lovable itself; it only changes what the executor does on its own
// schedule, and what Harness stores for when analysis ships.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  executorQueryOptions,
  postExecutor,
  type ExecutorSchedule,
  type LlmModels,
  type LlmProvider,
  type LlmRole,
} from "@/lib/improvements-client";

const DEFAULT_SCHEDULE: ExecutorSchedule = {
  enabled: true,
  interval_minutes: 60,
  window_start_hour: 10,
  window_end_hour: 22,
};
// The store's own default (harness/src/store.ts SETTING_DEFAULTS), used only
// until GET executor answers with the cap actually in force.
const DEFAULT_CAP = 9000;

const SCHEDULE_LINE =
  "Syncing reads your Lovable chats and Knowledge. It uses no Lovable credits and no AI.";
const CAP_LINE = "Lovable allows 10,000 characters; Harness keeps a margin.";
const APPROVAL_LINE = "Nothing is written to Lovable until you approve it here.";

// ---- AI analysis (Round 3 §4). Stored only -- analysis itself doesn't run
// yet, so nothing here ever calls a provider. ----
const LLM_PROVIDERS: { value: LlmProvider; label: string }[] = [
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "google", label: "Google" },
];
const LLM_ROLES: { key: LlmRole; label: string; hint: string }[] = [
  {
    key: "classifier",
    label: "Classifier",
    hint: "Sorts each chat message: new request, correction, question or approval.",
  },
  {
    key: "miner",
    label: "Miner",
    hint: "Turns your corrections into proposed instructions.",
  },
  {
    key: "reviewer",
    label: "Reviewer",
    hint: "Judges a build or a test result.",
  },
  {
    key: "proposer",
    label: "Proposer",
    hint: "Suggests an instruction when a build fails and none covers it.",
  },
];
const DEFAULT_LLM_PROVIDER: LlmProvider = "openai";
const DEFAULT_LLM_MODELS: LlmModels = {
  classifier: { provider: "openai", model: "" },
  miner: { provider: "openai", model: "" },
  reviewer: { provider: "openai", model: "" },
  proposer: { provider: "openai", model: "" },
};
const DEFAULT_BUDGET_USD = 10;
const AI_ANALYSIS_LINE =
  "Analysis is not switched on yet. Your key and choices are stored for when it is; nothing is sent to any provider today.";

// The store's own default (harness/src/store.ts SETTING_DEFAULTS), used only
// until GET executor answers with the default actually in force.
const DEFAULT_MAX_ACTIVE_RULES = 12;

export function LocalSettings() {
  const qc = useQueryClient();
  const executor = useQuery(executorQueryOptions);

  const [schedule, setSchedule] = useState<ExecutorSchedule>(DEFAULT_SCHEDULE);
  const [cap, setCap] = useState(DEFAULT_CAP);

  const [llmProvider, setLlmProvider] = useState<LlmProvider>(DEFAULT_LLM_PROVIDER);
  const [llmModels, setLlmModels] = useState<LlmModels>(DEFAULT_LLM_MODELS);
  const [budget, setBudget] = useState(DEFAULT_BUDGET_USD);
  const [keyInput, setKeyInput] = useState("");
  const [maxActiveRules, setMaxActiveRules] = useState(DEFAULT_MAX_ACTIVE_RULES);

  useEffect(() => {
    if (executor.data?.schedule) setSchedule(executor.data.schedule);
  }, [executor.data?.schedule]);

  useEffect(() => {
    const saved = executor.data?.settings?.knowledge_char_cap;
    if (saved != null) setCap(saved);
  }, [executor.data?.settings?.knowledge_char_cap]);

  useEffect(() => {
    const llm = executor.data?.llm;
    if (!llm) return;
    setLlmProvider(llm.provider);
    setLlmModels(llm.models);
    setBudget(llm.monthly_budget_usd);
  }, [executor.data?.llm]);

  useEffect(() => {
    const saved = executor.data?.defaults?.max_active_rules;
    if (saved != null) setMaxActiveRules(saved);
  }, [executor.data?.defaults?.max_active_rules]);

  const keyStatus = executor.data?.llm?.keys?.[llmProvider] ?? { has_key: false, last4: null };
  const spentUsd = executor.data?.llm?.spent_usd ?? 0;

  const saveSchedule = useMutation({
    mutationFn: () =>
      postExecutor({
        action: "schedule",
        enabled: schedule.enabled,
        interval_minutes: schedule.interval_minutes,
        window_start_hour: schedule.window_start_hour,
        window_end_hour: schedule.window_end_hour,
      }),
    onSuccess: () => {
      toast.success("Sync schedule saved");
      void qc.invalidateQueries({ queryKey: executorQueryOptions.queryKey });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not save the schedule"),
  });

  const saveCap = useMutation({
    mutationFn: () => postExecutor({ action: "settings", knowledge_char_cap: cap }),
    onSuccess: () => {
      toast.success("Knowledge limit saved");
      void qc.invalidateQueries({ queryKey: executorQueryOptions.queryKey });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not save the limit"),
  });

  // One save action for the whole section: if a key was typed, it's saved
  // first (so a settings save never silently drops it), then the
  // provider/models/budget. One toast either way.
  const saveAiAnalysis = useMutation({
    mutationFn: async () => {
      if (keyInput.trim().length > 0) {
        await postExecutor({ action: "llm_key", provider: llmProvider, key: keyInput });
      }
      return postExecutor({
        action: "llm_settings",
        llm_provider: llmProvider,
        llm_models: llmModels,
        llm_monthly_budget_usd: budget,
      });
    },
    onSuccess: () => {
      toast.success("AI analysis settings saved");
      setKeyInput("");
      void qc.invalidateQueries({ queryKey: executorQueryOptions.queryKey });
    },
    onError: (e) =>
      toast.error(e instanceof Error ? e.message : "Could not save the AI analysis settings"),
  });

  const removeLlmKey = useMutation({
    mutationFn: () => postExecutor({ action: "llm_key_remove", provider: llmProvider }),
    onSuccess: () => {
      toast.success("Key removed");
      void qc.invalidateQueries({ queryKey: executorQueryOptions.queryKey });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not remove the key"),
  });

  const saveDefaults = useMutation({
    mutationFn: () => postExecutor({ action: "defaults", max_active_rules: maxActiveRules }),
    onSuccess: () => {
      toast.success("Defaults saved");
      void qc.invalidateQueries({ queryKey: executorQueryOptions.queryKey });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not save the defaults"),
  });

  return (
    <div className="max-w-xl space-y-8">
      <h1 className="text-2xl font-semibold">Settings</h1>

      <section className="space-y-4 rounded-md border p-4">
        <h2 className="text-lg font-medium">Sync schedule</h2>

        <div className="flex items-center justify-between">
          <Label htmlFor="sync-enabled">Sync on a schedule</Label>
          <Switch
            id="sync-enabled"
            checked={schedule.enabled}
            onCheckedChange={(v) => setSchedule((s) => ({ ...s, enabled: v }))}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="interval-minutes">Every N minutes (15–1440)</Label>
          <Input
            id="interval-minutes"
            type="number"
            min={15}
            max={1440}
            value={schedule.interval_minutes}
            onChange={(e) =>
              setSchedule((s) => ({ ...s, interval_minutes: Number(e.target.value) }))
            }
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="window-start">Between hour (0–24)</Label>
            <Input
              id="window-start"
              type="number"
              min={0}
              max={24}
              value={schedule.window_start_hour}
              onChange={(e) =>
                setSchedule((s) => ({ ...s, window_start_hour: Number(e.target.value) }))
              }
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="window-end">and hour (0–24)</Label>
            <Input
              id="window-end"
              type="number"
              min={0}
              max={24}
              value={schedule.window_end_hour}
              onChange={(e) =>
                setSchedule((s) => ({ ...s, window_end_hour: Number(e.target.value) }))
              }
            />
          </div>
        </div>

        <p className="text-sm text-muted-foreground">{SCHEDULE_LINE}</p>

        <Button onClick={() => saveSchedule.mutate()} disabled={saveSchedule.isPending}>
          {saveSchedule.isPending ? "Saving…" : "Save schedule"}
        </Button>
      </section>

      <section className="space-y-4 rounded-md border p-4">
        <h2 className="text-lg font-medium">Knowledge limit</h2>

        <div className="space-y-2">
          <Label htmlFor="knowledge-cap">Character cap (1,000–10,000)</Label>
          <Input
            id="knowledge-cap"
            type="number"
            min={1000}
            max={10000}
            value={cap}
            onChange={(e) => setCap(Number(e.target.value))}
          />
        </div>

        <p className="text-sm text-muted-foreground">{CAP_LINE}</p>

        <Button onClick={() => saveCap.mutate()} disabled={saveCap.isPending}>
          {saveCap.isPending ? "Saving…" : "Save limit"}
        </Button>
      </section>

      <section className="space-y-4 rounded-md border p-4">
        <h2 className="text-lg font-medium">AI analysis</h2>

        <div className="space-y-1">
          <Label htmlFor="llm-provider">Key for</Label>
          <Select value={llmProvider} onValueChange={(v) => setLlmProvider(v as LlmProvider)}>
            <SelectTrigger id="llm-provider" className="w-full sm:w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LLM_PROVIDERS.map((p) => (
                <SelectItem key={p.value} value={p.value}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">Which provider the key below belongs to.</p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="llm-key">API key</Label>
          {keyStatus.has_key ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm">Key saved, ends in …{keyStatus.last4}</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => removeLlmKey.mutate()}
                disabled={removeLlmKey.isPending}
              >
                {removeLlmKey.isPending ? "Removing…" : "Remove key"}
              </Button>
            </div>
          ) : (
            <div className="space-y-1">
              <Input
                id="llm-key"
                type="password"
                autoComplete="off"
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Saved when you press Save AI analysis below.
              </p>
            </div>
          )}
        </div>

        <div className="space-y-3">
          <p className="text-sm font-medium">Model per role</p>
          {LLM_ROLES.map(({ key, label: roleLabel, hint }) => (
            <div key={key} className="space-y-2">
              <div>
                <p className="text-sm">{roleLabel}</p>
                <p className="text-xs text-muted-foreground">{hint}</p>
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor={`llm-role-provider-${key}`}>{roleLabel} provider</Label>
                  <Select
                    value={llmModels[key].provider}
                    onValueChange={(v) =>
                      setLlmModels((m) => ({
                        ...m,
                        [key]: { ...m[key], provider: v as LlmProvider },
                      }))
                    }
                  >
                    <SelectTrigger id={`llm-role-provider-${key}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {LLM_PROVIDERS.map((p) => (
                        <SelectItem key={p.value} value={p.value}>
                          {p.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`llm-role-model-${key}`}>{roleLabel} model</Label>
                  <Input
                    id={`llm-role-model-${key}`}
                    value={llmModels[key].model}
                    onChange={(e) =>
                      setLlmModels((m) => ({
                        ...m,
                        [key]: { ...m[key], model: e.target.value },
                      }))
                    }
                  />
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="space-y-2">
          <Label htmlFor="llm-budget">Monthly budget (USD, 1–1000)</Label>
          <Input
            id="llm-budget"
            type="number"
            min={1}
            max={1000}
            value={budget}
            onChange={(e) => setBudget(Number(e.target.value))}
          />
          <p className="text-sm text-muted-foreground">Spent this month: ${spentUsd.toFixed(2)}</p>
        </div>

        <p className="text-sm text-muted-foreground">{AI_ANALYSIS_LINE}</p>

        <Button onClick={() => saveAiAnalysis.mutate()} disabled={saveAiAnalysis.isPending}>
          {saveAiAnalysis.isPending ? "Saving…" : "Save AI analysis"}
        </Button>
      </section>

      <section className="space-y-4 rounded-md border p-4">
        <h2 className="text-lg font-medium">Defaults for projects</h2>

        <div className="space-y-2">
          <Label htmlFor="default-max-active-rules">Max active rules per project (1–50)</Label>
          <Input
            id="default-max-active-rules"
            type="number"
            min={1}
            max={50}
            value={maxActiveRules}
            onChange={(e) => setMaxActiveRules(Number(e.target.value))}
          />
        </div>

        <Button onClick={() => saveDefaults.mutate()} disabled={saveDefaults.isPending}>
          {saveDefaults.isPending ? "Saving…" : "Save defaults"}
        </Button>
      </section>

      <section className="space-y-2 rounded-md border p-4">
        <h2 className="text-lg font-medium">Approval</h2>
        <p className="text-sm text-muted-foreground">{APPROVAL_LINE}</p>
      </section>
    </div>
  );
}
