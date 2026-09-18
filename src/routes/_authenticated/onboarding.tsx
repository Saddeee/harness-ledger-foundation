// Onboarding (Checkpoint 2 WP2-A): five steps to a working setup, each one
// posting the exact same action its full page uses (Projects' connect/allow,
// Settings' decision_mode/llm_key/llm_settings/schedule, the Inbox's
// sync_now/analyse_now) so nothing here is a second implementation of any
// of those actions. "Done" for each step is derived from the same executor/
// projects reads those pages already use -- see ONBOARDING_STEPS in
// src/lib/onboarding-copy.ts for the step order this file renders.
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Fragment, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  executorQueryOptions,
  fetchExecutor,
  fetchProjects,
  postExecutor,
  postProjects,
  syncResultText,
  type LlmProvider,
} from "@/lib/improvements-client";
import {
  ADVANCED_PERMISSIONS_LINK_TEXT,
  ANALYSE_NOW_CONSEQUENCE,
  CHOOSE_ON_PROJECTS_LABEL,
  MODE_ASK_TITLE,
  MODE_AUTOMATIC_TITLE,
  MODE_AUTONOMY_NOTE,
  MODE_EXPLANATION,
  ONBOARDING_DISMISSED_KEY,
  ONBOARDING_INTRO,
  ONBOARDING_STEPS,
  RECOMMENDED_SETTINGS_LABEL,
  RECOMMENDED_SETTINGS_LIST,
  SKIP_ONBOARDING_LABEL,
  SYNC_NOW_CONSEQUENCE,
} from "@/lib/onboarding-copy";

export const Route = createFileRoute("/_authenticated/onboarding")({
  head: () => ({
    meta: [
      { title: "Get started — Harness Ledger" },
      { name: "description", content: ONBOARDING_INTRO },
    ],
  }),
  component: OnboardingPage,
});

const PROJECTS_KEY = ["harness-projects"] as const;
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;
const PROVIDER_OPTIONS: { value: LlmProvider; label: string }[] = [
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "google", label: "Google" },
  { value: "claude_code", label: "Claude Code (your subscription)" },
];

type StepState = "done" | "current" | "todo";

function StepBadge({ state }: { state: StepState }) {
  const text = state === "done" ? "Done" : state === "current" ? "Current" : "Not yet";
  const cls =
    state === "done"
      ? "bg-primary/10 text-primary"
      : state === "current"
        ? "bg-accent text-foreground"
        : "text-muted-foreground";
  return <span className={`rounded-full px-2 py-0.5 text-xs ${cls}`}>{text}</span>;
}

function StepShell({
  index,
  title,
  state,
  children,
}: {
  index: number;
  title: string;
  state: StepState;
  children: React.ReactNode;
}) {
  return (
    <section className={`space-y-3 rounded-md border p-4 ${state === "todo" ? "opacity-60" : ""}`}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-base font-medium">
          {index + 1}. {title}
        </h2>
        <StepBadge state={state} />
      </div>
      {children}
    </section>
  );
}

function ConnectStep({ state }: { state: StepState }) {
  const qc = useQueryClient();
  const executor = useQuery(executorQueryOptions);
  const [connecting, setConnecting] = useState(false);
  const [connectUrl, setConnectUrl] = useState<string | null>(null);

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

  const conn = executor.data?.connection;
  if (conn?.connected) {
    return (
      <p className="text-sm text-muted-foreground">Connected as {conn.email ?? "your account"}.</p>
    );
  }
  if (state !== "current") {
    return <p className="text-sm text-muted-foreground">Not connected yet.</p>;
  }
  return (
    <div className="space-y-2">
      <Button onClick={() => connect.mutate()} disabled={connect.isPending || connecting}>
        {connect.isPending || connecting ? "Waiting for Lovable…" : "Connect Lovable"}
      </Button>
      <p className="text-xs text-muted-foreground">
        Opens Lovable's login. Reading your chats and Knowledge afterward uses no credits.
      </p>
      {connecting && connectUrl ? (
        <p className="text-sm">
          Lovable's login didn't open?{" "}
          <a href={connectUrl} target="_blank" rel="noopener noreferrer" className="underline">
            Open it here
          </a>
          . Approve access there and this page updates by itself.
        </p>
      ) : null}
    </div>
  );
}

function ProjectsStep({ state }: { state: StepState }) {
  const qc = useQueryClient();
  const projects = useQuery({ queryKey: PROJECTS_KEY, queryFn: fetchProjects });
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const setAllowed = useMutation({
    mutationFn: (v: { id: string; name: string; allow: boolean }) =>
      v.allow
        ? postProjects({ action: "allow", lovable_project_id: v.id, label: v.name })
        : postProjects({ action: "disallow", lovable_project_id: v.id }),
    onMutate: (v) => setTogglingId(v.id),
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not update the project"),
    onSettled: () => {
      setTogglingId(null);
      void qc.invalidateQueries({ queryKey: PROJECTS_KEY });
    },
  });

  const allowedCount = projects.data?.allowed?.length ?? 0;
  if (state !== "current") {
    return (
      <p className="text-sm text-muted-foreground">
        {allowedCount > 0
          ? `${allowedCount} project${allowedCount === 1 ? "" : "s"} allowed.`
          : "No projects allowed yet."}
      </p>
    );
  }

  const rows = (projects.data?.all ?? []).slice(0, 10);
  return (
    <div className="space-y-2">
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No Lovable projects found yet.</p>
      ) : (
        <ul className="divide-y rounded-md border text-sm">
          {rows.map((p) => (
            <li key={p.id} className="flex items-center justify-between px-3 py-2">
              <span>{p.name}</span>
              <Switch
                checked={p.allowed}
                disabled={togglingId === p.id}
                onCheckedChange={(v) => setAllowed.mutate({ id: p.id, name: p.name, allow: v })}
              />
            </li>
          ))}
        </ul>
      )}
      <Link
        to="/projects"
        search={{ connected: undefined }}
        className="text-sm underline underline-offset-2"
      >
        {CHOOSE_ON_PROJECTS_LABEL}
      </Link>
      <p className="text-xs text-muted-foreground">
        Choosing a project changes nothing in Lovable; it only tells Harness Ledger what it may
        read.
      </p>
    </div>
  );
}

function ModeStep({ state, onSaved }: { state: StepState; onSaved: () => void }) {
  const qc = useQueryClient();
  const executor = useQuery(executorQueryOptions);
  const [mode, setMode] = useState<"ask" | "automatic">("ask");

  useEffect(() => {
    const saved = executor.data?.settings?.decision_mode;
    if (saved) setMode(saved);
  }, [executor.data?.settings?.decision_mode]);

  const save = useMutation({
    mutationFn: () => postExecutor({ action: "settings", decision_mode: mode }),
    onSuccess: () => {
      toast.success("Decision mode saved");
      void qc.invalidateQueries({ queryKey: executorQueryOptions.queryKey });
      onSaved();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not save"),
  });

  if (state !== "current") {
    return (
      <p className="text-sm text-muted-foreground">
        {mode === "automatic" ? MODE_AUTOMATIC_TITLE : MODE_ASK_TITLE}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <RadioGroup value={mode} onValueChange={(v) => setMode(v as "ask" | "automatic")}>
        <div className="flex items-start gap-2">
          <RadioGroupItem value="ask" id="onboarding-mode-ask" className="mt-0.5" />
          <Label htmlFor="onboarding-mode-ask" className="font-normal">
            {MODE_ASK_TITLE}
          </Label>
        </div>
        <div className="flex items-start gap-2">
          <RadioGroupItem value="automatic" id="onboarding-mode-automatic" className="mt-0.5" />
          <Label htmlFor="onboarding-mode-automatic" className="font-normal">
            {MODE_AUTOMATIC_TITLE}
          </Label>
        </div>
      </RadioGroup>
      <p className="text-sm text-muted-foreground">{MODE_EXPLANATION}</p>
      <p className="text-xs text-muted-foreground">{MODE_AUTONOMY_NOTE}</p>
      <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
        {save.isPending ? "Saving…" : "Save"}
      </Button>
    </div>
  );
}

function ProviderStep({ state }: { state: StepState }) {
  const qc = useQueryClient();
  const executor = useQuery(executorQueryOptions);
  const [provider, setProvider] = useState<LlmProvider>("openai");
  const [key, setKey] = useState("");

  useEffect(() => {
    const saved = executor.data?.llm?.provider;
    if (saved) setProvider(saved);
  }, [executor.data?.llm?.provider]);

  const save = useMutation({
    mutationFn: async () => {
      if (provider !== "claude_code" && key.trim()) {
        await postExecutor({ action: "llm_key", provider, key });
      }
      await postExecutor({
        action: "llm_settings",
        provider,
        models: {
          classifier: { provider, model: provider === "claude_code" ? "sonnet" : "" },
          rule_writer: { provider, model: provider === "claude_code" ? "sonnet" : "" },
          judge: { provider, model: provider === "claude_code" ? "sonnet" : "" },
          reviewer: { provider, model: provider === "claude_code" ? "sonnet" : "" },
          proposer: { provider, model: provider === "claude_code" ? "sonnet" : "" },
        },
      });
    },
    onSuccess: () => {
      toast.success("AI provider saved");
      setKey("");
      void qc.invalidateQueries({ queryKey: executorQueryOptions.queryKey });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not save"),
  });

  const providerReady = executor.data?.analysis?.provider_ready;
  if (state !== "current") {
    return (
      <p className="text-sm text-muted-foreground">
        {providerReady?.ok ? `Ready (${provider})` : "Not configured yet."}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label htmlFor="onboarding-provider">Provider</Label>
        <Select value={provider} onValueChange={(v) => setProvider(v as LlmProvider)}>
          <SelectTrigger id="onboarding-provider" className="w-full sm:w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PROVIDER_OPTIONS.map((p) => (
              <SelectItem key={p.value} value={p.value}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {provider !== "claude_code" ? (
        <div className="space-y-1">
          <Label htmlFor="onboarding-key">API key</Label>
          <Input
            id="onboarding-key"
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="Paste your API key"
            className="max-w-sm"
          />
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          Claude Code uses the subscription already signed in on this machine — no key needed.
        </p>
      )}
      {providerReady && !providerReady.ok ? (
        <p className="text-xs text-muted-foreground">{providerReady.reason}</p>
      ) : null}
      <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
        {save.isPending ? "Saving…" : "Save"}
      </Button>
    </div>
  );
}

function SyncStep({ state }: { state: StepState }) {
  const qc = useQueryClient();
  const executor = useQuery(executorQueryOptions);

  const syncNow = useMutation({
    mutationFn: () => postExecutor({ action: "sync_now" }),
    onSuccess: (data) => {
      toast.success(syncResultText(data));
      void qc.invalidateQueries({ queryKey: executorQueryOptions.queryKey });
      void qc.invalidateQueries({ queryKey: ["harness-improvements"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Sync failed"),
  });

  const analyseNow = useMutation({
    mutationFn: () => postExecutor({ action: "analyse_now" }),
    onSuccess: () => {
      toast.success("Analysis started");
      void qc.invalidateQueries({ queryKey: executorQueryOptions.queryKey });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not request analysis"),
  });

  const lastAnalysis = executor.data?.analysis?.last_run ?? null;
  if (state !== "current") {
    return (
      <p className="text-sm text-muted-foreground">
        {lastAnalysis ? "Analysis has run." : "Not run yet."}
      </p>
    );
  }

  const providerReady = Boolean(executor.data?.analysis?.provider_ready?.ok);
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Button onClick={() => syncNow.mutate()} disabled={syncNow.isPending}>
          {syncNow.isPending ? "Syncing…" : "Sync now"}
        </Button>
        <p className="text-xs text-muted-foreground">{SYNC_NOW_CONSEQUENCE}</p>
      </div>
      <div className="space-y-1">
        <Button
          onClick={() => analyseNow.mutate()}
          disabled={analyseNow.isPending || !providerReady}
        >
          {analyseNow.isPending ? "Starting…" : "Analyse now"}
        </Button>
        <p className="text-xs text-muted-foreground">{ANALYSE_NOW_CONSEQUENCE}</p>
      </div>
    </div>
  );
}

function OnboardingPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const executor = useQuery(executorQueryOptions);
  const projects = useQuery({ queryKey: PROJECTS_KEY, queryFn: fetchProjects });
  const [modeSaved, setModeSaved] = useState(false);

  const connected = Boolean(executor.data?.connection?.connected);
  const hasProject = (projects.data?.allowed?.length ?? 0) > 0;
  const providerReady = Boolean(executor.data?.analysis?.provider_ready?.ok);
  const hasAnalysisRun = executor.data?.analysis?.last_run != null;

  const doneFlags = [connected, hasProject, modeSaved, providerReady, hasAnalysisRun];
  const currentIndex = doneFlags.findIndex((done) => !done);

  const stepState = (i: number): StepState => {
    if (doneFlags[i]) return "done";
    if (i === (currentIndex === -1 ? doneFlags.length - 1 : currentIndex)) return "current";
    return "todo";
  };

  const applyRecommended = useMutation({
    mutationFn: async () => {
      await postExecutor({ action: "settings", decision_mode: "ask" });
      await postExecutor({
        action: "schedule",
        enabled: true,
        interval_minutes: 60,
        automatic_analysis_after_sync: false,
      });
    },
    onSuccess: () => {
      toast.success("Recommended settings applied");
      setModeSaved(true);
      void qc.invalidateQueries({ queryKey: executorQueryOptions.queryKey });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not apply settings"),
  });

  const skip = () => {
    try {
      window.localStorage.setItem(ONBOARDING_DISMISSED_KEY, "1");
    } catch {
      // localStorage may be unavailable (private browsing); skip still works.
    }
    navigate({ to: "/overview" });
  };

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Get started</h1>
        <p className="mt-2 text-sm text-muted-foreground">{ONBOARDING_INTRO}</p>
      </div>

      <div className="space-y-3 rounded-md border bg-muted/30 p-4">
        <Button
          variant="outline"
          size="sm"
          onClick={() => applyRecommended.mutate()}
          disabled={applyRecommended.isPending}
        >
          {applyRecommended.isPending ? "Applying…" : RECOMMENDED_SETTINGS_LABEL}
        </Button>
        <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
          {RECOMMENDED_SETTINGS_LIST.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <Link to="/settings" className="block text-xs underline underline-offset-2">
          {ADVANCED_PERMISSIONS_LINK_TEXT}
        </Link>
      </div>

      <div className="space-y-4">
        {ONBOARDING_STEPS.map((step, i) => (
          <Fragment key={step.id}>
            <StepShell index={i} title={step.title} state={stepState(i)}>
              {step.id === "connect" ? <ConnectStep state={stepState(i)} /> : null}
              {step.id === "projects" ? <ProjectsStep state={stepState(i)} /> : null}
              {step.id === "mode" ? (
                <ModeStep state={stepState(i)} onSaved={() => setModeSaved(true)} />
              ) : null}
              {step.id === "provider" ? <ProviderStep state={stepState(i)} /> : null}
              {step.id === "sync" ? <SyncStep state={stepState(i)} /> : null}
            </StepShell>
          </Fragment>
        ))}
      </div>

      <button
        type="button"
        onClick={skip}
        className="text-sm text-muted-foreground underline underline-offset-2"
      >
        {SKIP_ONBOARDING_LABEL}
      </button>
    </div>
  );
}
