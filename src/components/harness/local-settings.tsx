// Settings page for the local runtime: the sync schedule, the Knowledge
// character cap, AI analysis (provider/key or Claude Code/per-role
// models/monthly token budget -- Round 4 Task A4, spec §2: analysis itself
// only runs when the user presses "Analyse now", from the Inbox or
// Instructions page), the defaults new projects get, and a read-only note
// about approval. Only talks to the executor route (fetchExecutor/
// postExecutor) -- nothing on this page ever writes to Lovable itself; it
// only changes what the executor does on its own schedule, and what an
// analysis run (once triggered elsewhere) uses.
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
  type ApiLlmProvider,
  type ExecutorProviderReady,
  type ExecutorSchedule,
  type LlmModels,
  type LlmProvider,
  type LlmRole,
} from "@/lib/improvements-client";
import { isNotifyEnabled, setNotifyEnabled } from "@/lib/browser-prefs";

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

// ---- AI analysis (Round 3 §4, Round 4 Task A4 / spec §2). Analysis only
// ever runs when the user presses "Analyse now" (see analyse-notice.tsx); it
// never runs on a schedule. ----
const LLM_PROVIDERS: { value: LlmProvider; label: string }[] = [
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "google", label: "Google" },
  { value: "claude_code", label: "Claude Code (your subscription)" },
];
function isApiProvider(p: LlmProvider): p is ApiLlmProvider {
  return p !== "claude_code";
}
// provider_ready checks whichever provider the classifier/miner roles
// actually use, not specifically the "Key for" dropdown above -- so it only
// tells us about Claude Code when it's ready, or when it's the provider the
// reason itself names (e.g. "Claude Code was not found on this machine.").
// Any other not-ready reason (a missing API key for a different role's
// provider, say) is shown verbatim rather than mislabelled as a Claude Code
// problem.
function claudeCodeStatusLine(providerReady: ExecutorProviderReady | undefined): string {
  if (providerReady?.ok) return "Claude Code found";
  if (providerReady?.reason && /claude code/i.test(providerReady.reason)) {
    return "Claude Code not found on this machine";
  }
  return providerReady?.reason ?? "Claude Code not found on this machine";
}
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
// harness/src/store.ts SETTING_DEFAULTS' llm_monthly_token_budget default,
// used only until GET executor answers with the budget actually in force.
const DEFAULT_TOKEN_BUDGET = 2_000_000;
const AI_ANALYSIS_LINE =
  "Analysis runs only when you press Analyse now. Chat text is sent to the provider you chose.";

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
  const [budget, setBudget] = useState(DEFAULT_TOKEN_BUDGET);
  const [keyInput, setKeyInput] = useState("");
  const [maxActiveRules, setMaxActiveRules] = useState(DEFAULT_MAX_ACTIVE_RULES);
  const [notifyEnabled, setNotifyEnabled] = useState(isNotifyEnabled());
  const [notifyBlocked, setNotifyBlocked] = useState(false);

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
    setBudget(llm.monthly_token_budget);
  }, [executor.data?.llm]);

  useEffect(() => {
    const saved = executor.data?.defaults?.max_active_rules;
    if (saved != null) setMaxActiveRules(saved);
  }, [executor.data?.defaults?.max_active_rules]);

  const keyStatus = (isApiProvider(llmProvider)
    ? executor.data?.llm?.keys?.[llmProvider]
    : undefined) ?? {
    has_key: false,
    last4: null,
  };
  const spentUsd = executor.data?.llm?.spent_usd ?? 0;
  const tokensThisMonth = executor.data?.llm?.tokens_this_month ?? 0;
  const providerReady = executor.data?.analysis?.provider_ready;

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
  // independently (so a settings save failure never silently drops it), then the
  // provider/models/budget. Each part reports its own error if it fails.
  const saveAiAnalysis = useMutation({
    mutationFn: async () => {
      let keyError: string | null = null;
      let keySaved = false;

      if (keyInput.trim()) {
        try {
          await postExecutor({ action: "llm_key", provider: llmProvider, key: keyInput });
          keySaved = true;
        } catch (e) {
          keyError = e instanceof Error ? e.message : "unknown error";
        }
      }

      let settingsError: string | null = null;
      try {
        await postExecutor({
          action: "llm_settings",
          llm_provider: llmProvider,
          llm_models: llmModels,
          monthly_token_budget: budget,
        });
      } catch (e) {
        settingsError = e instanceof Error ? e.message : "unknown error";
      }

      return { keyError, settingsError, keySaved };
    },
    onSuccess: ({ keyError, settingsError, keySaved }) => {
      if (settingsError) {
        toast.error(`Could not save the model choices: ${settingsError}`);
        if (keyError) {
          toast.error(`Could not save the key: ${keyError}`);
        }
      } else {
        if (keyError) {
          toast.error(`Model choices saved, but the key was not: ${keyError}`);
        } else {
          toast.success("AI analysis settings saved");
        }
      }
      if (keySaved) setKeyInput("");
      void qc.invalidateQueries({ queryKey: executorQueryOptions.queryKey });
    },
    onError: () => {
      void qc.invalidateQueries({ queryKey: executorQueryOptions.queryKey });
    },
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

  async function handleNotifyToggle(enabled: boolean) {
    if (!enabled) {
      setNotifyEnabled(false);
      setNotifyBlocked(false);
      return;
    }

    if (typeof Notification === "undefined") {
      setNotifyBlocked(true);
      setNotifyEnabled(false);
      return;
    }

    try {
      const permission = await Notification.requestPermission();
      if (permission === "granted") {
        setNotifyEnabled(true);
        setNotifyBlocked(false);
      } else {
        setNotifyEnabled(false);
        setNotifyBlocked(true);
      }
    } catch {
      setNotifyEnabled(false);
      setNotifyBlocked(true);
    }
  }

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
          <p className="text-xs text-muted-foreground">
            {llmProvider === "claude_code"
              ? "Claude Code uses the subscription already signed in on this machine -- no key needed."
              : "Which provider the key below belongs to."}
          </p>
        </div>

        {llmProvider === "claude_code" ? (
          <div className="space-y-1">
            <p className="text-sm font-medium">Claude Code</p>
            <p className="text-sm">{claudeCodeStatusLine(providerReady)}</p>
          </div>
        ) : (
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
        )}

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
                    placeholder={llmModels[key].provider === "claude_code" ? "sonnet" : undefined}
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
          <Label htmlFor="llm-budget">Monthly token budget</Label>
          <Input
            id="llm-budget"
            type="number"
            min={100000}
            max={50000000}
            value={budget}
            onChange={(e) => setBudget(Number(e.target.value))}
          />
          <p className="text-sm text-muted-foreground">
            Used this month: {tokensThisMonth.toLocaleString()} tokens
          </p>
          {spentUsd > 0 ? (
            <p className="text-sm text-muted-foreground">
              ≈ ${spentUsd.toFixed(2)} this month (API providers)
            </p>
          ) : null}
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

      <section className="space-y-4 rounded-md border p-4">
        <h2 className="text-lg font-medium">Notifications</h2>

        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <Label htmlFor="notify-enabled">
              Notify me in this browser when a new proposal arrives
            </Label>
            <p className="text-xs text-muted-foreground">
              Only while Harness is open in a tab. Uses your browser's notification permission.
            </p>
          </div>
          <Switch
            id="notify-enabled"
            checked={notifyEnabled && !notifyBlocked}
            disabled={notifyBlocked}
            onCheckedChange={(checked) => void handleNotifyToggle(checked)}
          />
        </div>

        {notifyBlocked && (
          <p className="text-xs text-muted-foreground">Your browser blocked notifications.</p>
        )}
      </section>

      <section className="space-y-2 rounded-md border p-4">
        <h2 className="text-lg font-medium">Approval</h2>
        <p className="text-sm text-muted-foreground">{APPROVAL_LINE}</p>
      </section>
    </div>
  );
}
