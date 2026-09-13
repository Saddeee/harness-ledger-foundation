// Settings page for the local runtime: Decisions (Round 5 Task 6, spec §4/
// §4b: manual vs automatic mode, the confidence threshold, and the
// feedback-loop line), the sync schedule, the Knowledge character cap, AI
// analysis (provider/key, one model applied to every analysis role by
// default with a collapsed per-role Advanced view, or Claude Code/monthly
// token budget -- Round 4 Task A4, spec §2: analysis itself only runs when
// the user presses "Analyse now", from the Inbox or Instructions page), the
// defaults new projects get, and a read-only note about approval. Only
// talks to the executor route (fetchExecutor/postExecutor) -- nothing on
// this page ever writes to Lovable itself; it only changes what the
// executor does on its own schedule, and what an analysis run (once
// triggered elsewhere) uses.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Checkbox } from "@/components/ui/checkbox";
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
  type EvidenceSources,
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

// ---- Decisions (Round 5 Task 6 / spec §4, §4b). decision_mode defaults to
// "ask" -- automatic is opt-in, and switching to it never changes anything
// already decided. Copy below is verbatim from the spec. ----
const ASK_LABEL = "Ask me about every suggestion";
const AUTOMATIC_LABEL =
  "Automatic: accept suggestions Harness is confident about; ask me about the rest.";
const AUTOMATIC_HELP =
  "Confident means the analysis gave the rule a confidence of at least 0.8, found no similar or conflicting rule, and the project is under its rule limit and Knowledge limit. Accepted rules are written to your Lovable Knowledge the next time Harness syncs, if that project allows automatic writes (Projects page). Everything Harness does automatically is listed in the Instructions page history, and you can retire or restore any of it.";
const DEFAULT_DECISION_MODE: "ask" | "automatic" = "ask";
const DEFAULT_AUTO_CONFIDENCE = 0.8;

function feedbackLine(feedback: { accepted: number; skipped: number; verdicts: number }): string {
  return `From your decisions so far: ${feedback.accepted} accepted, ${feedback.skipped} skipped, ${feedback.verdicts} verdicts. Harness shows the Rule writer what you accepted and skipped, and won't re-propose what you skipped.`;
}

// ---- Evidence (Round 5 Task 7 / spec §5 "which count"). Which of the four
// evidence sources feed a rule's health and can trigger a retirement
// suggestion -- every source is always shown regardless of this choice
// (turning one off here hides nothing, it only stops it from counting).
// Paired tests aren't built yet (Phase B), so that row stays disabled and
// unchecked no matter what this page does. ----
const EVIDENCE_INTRO =
  "Signals that count towards a rule's health and retirement. Every signal is always shown; this only changes what can trigger a retirement suggestion.";
const DEFAULT_EVIDENCE_SOURCES: EvidenceSources = {
  observed: true,
  adherence: true,
  verdicts: true,
  paired: false,
};

// ---- Lovable credits (Round 6 Task 6b / spec §6). The store's own default
// (harness/src/store.ts SETTING_DEFAULTS.lovable_monthly_credit_budget),
// used only until GET executor answers with the budget actually in force. ----
const DEFAULT_CREDIT_BUDGET = 12;
const LOVABLE_CREDITS_INTRO =
  "Testing a rule in a temporary copy is a normal Lovable build and uses credits like one. Harness refuses to start a test that would put this month over the budget below.";

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
// provider_ready checks whichever provider the classifier/rule_writer roles
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
    key: "rule_writer",
    label: "Rule writer",
    hint: "Turns your corrections into proposed rules.",
  },
  {
    key: "judge",
    label: "Judge",
    hint: "Checks whether Lovable followed a rule in a real build.",
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
  rule_writer: { provider: "openai", model: "" },
  judge: { provider: "openai", model: "" },
  reviewer: { provider: "openai", model: "" },
  proposer: { provider: "openai", model: "" },
};
// harness/src/store.ts SETTING_DEFAULTS' llm_monthly_token_budget default,
// used only until GET executor answers with the budget actually in force.
const DEFAULT_TOKEN_BUDGET = 2_000_000;
const AI_ANALYSIS_LINE =
  "Analysis runs only when you press Analyse now. Chat text is sent to the provider you chose.";
const MODEL_FOR_ANALYSIS_LINE =
  "Used for every analysis role (classifier, rule writer, judge, reviewer, proposer) unless you set one per role below.";
// Fix round 1 item 2: shown under the primary fields (not inside Advanced)
// only when nothing has been edited per-role yet this visit -- see
// perRoleEdited below. Once a per-role row has actually been touched, a
// save preserves those edits instead of normalising to the primary fields,
// so this exact warning would no longer be true.
const ROLES_DIFFER_PRIMARY_LINE =
  "Roles currently use different models; saving these fields applies them to every role.";

// spec §1: "one provider and one model by default" -- the Rule writer's own
// entry is the single source of truth the primary Select/Input above the
// Advanced details read and write; saveAiAnalysis below copies it onto
// every other role at save time unless a per-role row was itself edited
// this visit (see perRoleEdited/saveAiAnalysis).
function rolesDiffer(models: LlmModels): boolean {
  const base = models.rule_writer;
  return (Object.keys(models) as LlmRole[]).some(
    (role) => models[role].provider !== base.provider || models[role].model !== base.model,
  );
}

// The store's own default (harness/src/store.ts SETTING_DEFAULTS), used only
// until GET executor answers with the default actually in force.
const DEFAULT_MAX_ACTIVE_RULES = 12;

export function LocalSettings() {
  const qc = useQueryClient();
  const executor = useQuery(executorQueryOptions);

  const [decisionMode, setDecisionMode] = useState<"ask" | "automatic">(DEFAULT_DECISION_MODE);
  const [autoConfidence, setAutoConfidence] = useState(DEFAULT_AUTO_CONFIDENCE);
  const [evidenceSources, setEvidenceSources] = useState<EvidenceSources>(DEFAULT_EVIDENCE_SOURCES);

  const [schedule, setSchedule] = useState<ExecutorSchedule>(DEFAULT_SCHEDULE);
  const [cap, setCap] = useState(DEFAULT_CAP);

  // Round 6 Task 6b / spec §6: Lovable credits (budget, keep-test-copies).
  const [creditBudget, setCreditBudget] = useState(DEFAULT_CREDIT_BUDGET);
  const [keepTestCopies, setKeepTestCopies] = useState(false);

  const [llmProvider, setLlmProvider] = useState<LlmProvider>(DEFAULT_LLM_PROVIDER);
  const [llmModels, setLlmModels] = useState<LlmModels>(DEFAULT_LLM_MODELS);
  // Fix round 1 item 2: whether a per-role row (inside "Advanced: different
  // models per role") has itself been edited this visit -- not just
  // whether Advanced was opened to look. Set by any per-role Select/Input
  // onChange below; reset once a save actually applies those per-role
  // values (see saveAiAnalysis's onSuccess). Gates what saveAiAnalysis
  // writes: false -> normalise every role to the primary fields (the only
  // honest reading of the simple view, which has no per-role fields to
  // show); true -> write the per-role values exactly as edited.
  const [perRoleEdited, setPerRoleEdited] = useState(false);
  const [budget, setBudget] = useState(DEFAULT_TOKEN_BUDGET);
  const [keyInput, setKeyInput] = useState("");
  const [maxActiveRules, setMaxActiveRules] = useState(DEFAULT_MAX_ACTIVE_RULES);
  const [notifyEnabled, setNotifyEnabled] = useState(isNotifyEnabled());
  const [notifyBlocked, setNotifyBlocked] = useState(false);

  useEffect(() => {
    const mode = executor.data?.settings?.decision_mode;
    if (mode != null) setDecisionMode(mode);
  }, [executor.data?.settings?.decision_mode]);

  useEffect(() => {
    const threshold = executor.data?.settings?.decision_auto_confidence;
    if (threshold != null) setAutoConfidence(threshold);
  }, [executor.data?.settings?.decision_auto_confidence]);

  useEffect(() => {
    const sources = executor.data?.settings?.evidence_sources;
    if (sources != null) setEvidenceSources(sources);
  }, [executor.data?.settings?.evidence_sources]);

  useEffect(() => {
    if (executor.data?.schedule) setSchedule(executor.data.schedule);
  }, [executor.data?.schedule]);

  useEffect(() => {
    const saved = executor.data?.settings?.knowledge_char_cap;
    if (saved != null) setCap(saved);
  }, [executor.data?.settings?.knowledge_char_cap]);

  useEffect(() => {
    const saved = executor.data?.credits?.budget;
    if (saved != null) setCreditBudget(saved);
  }, [executor.data?.credits?.budget]);

  useEffect(() => {
    const saved = executor.data?.settings?.keep_test_copies;
    if (saved != null) setKeepTestCopies(saved);
  }, [executor.data?.settings?.keep_test_copies]);

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
  const feedback = executor.data?.settings?.feedback ?? {
    accepted: 0,
    skipped: 0,
    verdicts: 0,
    automatic: 0,
  };

  // Round 6 Task 6b / spec §6: the Evidence checkbox is enabled only once a
  // judged run exists (there's nothing to count towards a rule's health
  // before then); the credits line reads "No tests yet" when nothing has
  // ever been recorded (lastKnownTestCost is null only when credit_ledger
  // has never had a row -- distinct from "0 spent this month" after a
  // month rolled over).
  const credits = executor.data?.credits;
  const pairedTestsAvailable = (credits?.judged_runs ?? 0) > 0;
  const usedThisMonthLine =
    credits && credits.used_this_month === 0 && credits.last_test_cost == null
      ? "No tests yet"
      : `Used this month: ${credits?.used_this_month ?? 0} credit${credits?.used_this_month === 1 ? "" : "s"} · measured`;

  const saveDecisions = useMutation({
    mutationFn: () =>
      postExecutor({
        action: "settings",
        decision_mode: decisionMode,
        decision_auto_confidence: autoConfidence,
      }),
    onSuccess: () => {
      toast.success("Decisions setting saved");
      void qc.invalidateQueries({ queryKey: executorQueryOptions.queryKey });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not save"),
  });

  const saveEvidence = useMutation({
    mutationFn: () => postExecutor({ action: "settings", evidence_sources: evidenceSources }),
    onSuccess: () => {
      toast.success("Evidence setting saved");
      void qc.invalidateQueries({ queryKey: executorQueryOptions.queryKey });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not save"),
  });

  const saveCredits = useMutation({
    mutationFn: () =>
      postExecutor({
        action: "settings",
        lovable_monthly_credit_budget: creditBudget,
        keep_test_copies: keepTestCopies,
      }),
    onSuccess: () => {
      toast.success("Lovable credits setting saved");
      void qc.invalidateQueries({ queryKey: executorQueryOptions.queryKey });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not save"),
  });

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
        // Fix round 1 item 2 / spec §1: "one provider and one model by
        // default". Gated on perRoleEdited, not on whether Advanced is/was
        // open -- merely opening it to look must not leave the four
        // non-rule_writer roles stale the next time the primary fields are
        // saved. perRoleEdited is false -> the primary Select/Input are the
        // only fields the owner has touched, so that one choice is written
        // to every role (the simple view has no per-role fields to show,
        // so that is the only honest reading of "this is the model Harness
        // uses"). perRoleEdited is true -> a per-role row was itself
        // edited this visit, so save respects whatever is in each row
        // exactly as edited.
        const modelsToSave: LlmModels = perRoleEdited
          ? llmModels
          : {
              classifier: { ...llmModels.rule_writer },
              rule_writer: { ...llmModels.rule_writer },
              judge: { ...llmModels.rule_writer },
              reviewer: { ...llmModels.rule_writer },
              proposer: { ...llmModels.rule_writer },
            };
        await postExecutor({
          action: "llm_settings",
          llm_provider: llmProvider,
          llm_models: modelsToSave,
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
        // Fix round 1 item 2: only once the models actually saved -- a
        // failed save (settingsError above) leaves any per-role edits
        // un-persisted, so perRoleEdited must keep gating the next attempt
        // toward writing them, not toward normalising them away.
        setPerRoleEdited(false);
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
        <h2 className="text-lg font-medium">Decisions</h2>

        <RadioGroup
          value={decisionMode}
          onValueChange={(v) => setDecisionMode(v as "ask" | "automatic")}
          className="space-y-3"
        >
          <div className="flex items-start gap-2">
            <RadioGroupItem value="ask" id="decision-mode-ask" className="mt-0.5" />
            <Label htmlFor="decision-mode-ask" className="font-normal">
              {ASK_LABEL}
            </Label>
          </div>
          <div className="space-y-2">
            <div className="flex items-start gap-2">
              <RadioGroupItem value="automatic" id="decision-mode-automatic" className="mt-0.5" />
              <Label htmlFor="decision-mode-automatic" className="font-normal">
                {AUTOMATIC_LABEL}
              </Label>
            </div>
            <p className="pl-6 text-xs text-muted-foreground">{AUTOMATIC_HELP}</p>
            {decisionMode === "automatic" ? (
              <div className="space-y-1 pl-6">
                <Label htmlFor="decision-auto-confidence">Confidence needed</Label>
                <Input
                  id="decision-auto-confidence"
                  type="number"
                  min={0.5}
                  max={1}
                  step={0.05}
                  value={autoConfidence}
                  onChange={(e) => setAutoConfidence(Number(e.target.value))}
                  className="w-28"
                />
              </div>
            ) : null}
          </div>
        </RadioGroup>

        <p className="text-sm text-muted-foreground">{feedbackLine(feedback)}</p>

        <Button onClick={() => saveDecisions.mutate()} disabled={saveDecisions.isPending}>
          {saveDecisions.isPending ? "Saving…" : "Save decisions"}
        </Button>
      </section>

      <section className="space-y-4 rounded-md border p-4">
        <h2 className="text-lg font-medium">Evidence</h2>
        <p className="text-sm text-muted-foreground">{EVIDENCE_INTRO}</p>

        <div className="space-y-3">
          <div className="flex items-start gap-2">
            <Checkbox
              id="evidence-observed"
              checked={evidenceSources.observed}
              onCheckedChange={(v) => setEvidenceSources((s) => ({ ...s, observed: v === true }))}
              className="mt-0.5"
            />
            <Label htmlFor="evidence-observed" className="font-normal">
              Repeat corrections observed in your real builds
            </Label>
          </div>
          <div className="flex items-start gap-2">
            <Checkbox
              id="evidence-adherence"
              checked={evidenceSources.adherence}
              onCheckedChange={(v) => setEvidenceSources((s) => ({ ...s, adherence: v === true }))}
              className="mt-0.5"
            />
            <Label htmlFor="evidence-adherence" className="font-normal">
              AI adherence check (with quotes)
            </Label>
          </div>
          <div className="flex items-start gap-2">
            <Checkbox
              id="evidence-verdicts"
              checked={evidenceSources.verdicts}
              onCheckedChange={(v) => setEvidenceSources((s) => ({ ...s, verdicts: v === true }))}
              className="mt-0.5"
            />
            <Label htmlFor="evidence-verdicts" className="font-normal">
              Your verdicts
            </Label>
          </div>
          <div className="flex items-start gap-2">
            <Checkbox
              id="evidence-paired"
              checked={evidenceSources.paired}
              disabled={!pairedTestsAvailable}
              onCheckedChange={(v) => setEvidenceSources((s) => ({ ...s, paired: v === true }))}
              className="mt-0.5"
            />
            <Label
              htmlFor="evidence-paired"
              className={pairedTestsAvailable ? "font-normal" : "font-normal text-muted-foreground"}
            >
              Paired tests{pairedTestsAvailable ? "" : " (judge at least one test first)"}
            </Label>
          </div>
        </div>

        <Button onClick={() => saveEvidence.mutate()} disabled={saveEvidence.isPending}>
          {saveEvidence.isPending ? "Saving…" : "Save evidence"}
        </Button>
      </section>

      <section className="space-y-4 rounded-md border p-4">
        <h2 className="text-lg font-medium">Lovable credits</h2>
        <p className="text-sm text-muted-foreground">{LOVABLE_CREDITS_INTRO}</p>

        <div className="space-y-2">
          <Label htmlFor="credit-budget">Monthly budget (0–1000)</Label>
          <Input
            id="credit-budget"
            type="number"
            min={0}
            max={1000}
            value={creditBudget}
            onChange={(e) => setCreditBudget(Number(e.target.value))}
            className="w-32"
          />
        </div>

        <p className="text-sm text-muted-foreground">{usedThisMonthLine}</p>

        <div className="flex items-center justify-between gap-2">
          <div className="space-y-1">
            <Label htmlFor="keep-test-copies">Keep test copies (delete them by hand)</Label>
            <p className="text-xs text-muted-foreground">
              Off by default -- Harness deletes each test's temporary copy once it's judged.
            </p>
          </div>
          <Switch
            id="keep-test-copies"
            checked={keepTestCopies}
            onCheckedChange={setKeepTestCopies}
          />
        </div>

        <Button onClick={() => saveCredits.mutate()} disabled={saveCredits.isPending}>
          {saveCredits.isPending ? "Saving…" : "Save credits"}
        </Button>
      </section>

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

        <div className="space-y-2">
          <p className="text-sm font-medium">Model for analysis</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="llm-model-provider">Provider</Label>
              <Select
                value={llmModels.rule_writer.provider}
                onValueChange={(v) =>
                  setLlmModels((m) => ({
                    ...m,
                    rule_writer: { ...m.rule_writer, provider: v as LlmProvider },
                  }))
                }
              >
                <SelectTrigger id="llm-model-provider">
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
              <Label htmlFor="llm-model-model">Model</Label>
              <Input
                id="llm-model-model"
                placeholder={
                  llmModels.rule_writer.provider === "claude_code" ? "sonnet" : undefined
                }
                value={llmModels.rule_writer.model}
                onChange={(e) =>
                  setLlmModels((m) => ({
                    ...m,
                    rule_writer: { ...m.rule_writer, model: e.target.value },
                  }))
                }
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">{MODEL_FOR_ANALYSIS_LINE}</p>
          {rolesDiffer(llmModels) && !perRoleEdited ? (
            <p className="text-xs text-muted-foreground">{ROLES_DIFFER_PRIMARY_LINE}</p>
          ) : null}
        </div>

        <details className="rounded-md border">
          <summary className="cursor-pointer px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            Advanced: different models per role
          </summary>
          <div className="space-y-3 border-t p-3">
            {rolesDiffer(llmModels) ? (
              <p className="text-xs text-muted-foreground">Roles use different models.</p>
            ) : null}
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
                      onValueChange={(v) => {
                        setLlmModels((m) => ({
                          ...m,
                          [key]: { ...m[key], provider: v as LlmProvider },
                        }));
                        setPerRoleEdited(true);
                      }}
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
                      onChange={(e) => {
                        setLlmModels((m) => ({
                          ...m,
                          [key]: { ...m[key], model: e.target.value },
                        }));
                        setPerRoleEdited(true);
                      }}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </details>

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
