// Server-only bridge to the local executor: connection status, the sync
// schedule, the last run, the AI-analysis provider/model/budget settings
// and stored-key status (Settings > AI analysis; see spec section 4 -- keys
// are stored for later, nothing is sent to any provider yet), the default
// max active rules per project, and the actions the Projects/Settings UI
// can take (connect/disconnect Lovable, request a sync now, change the
// schedule, the Knowledge character cap, LLM settings/keys, or the default
// cap). The only Lovable network call the web server itself ever makes is
// the OAuth loopback flow started by "connect"; syncing, knowledge writes
// and everything else happen in the executor process
// (harness/src/executor/beats.ts), not here. A provider API key is never
// read back in full -- only has_key/last4 (harness/src/llm-keys.ts), never
// logged.
import { createFileRoute } from "@tanstack/react-router";
import {
  hostedPreviewBody,
  loadHarnessAdapter,
  loadHarnessExecutor,
} from "@/lib/server/harness-runtime";

async function requireAuth(request: Request): Promise<Response | null> {
  const { requireCronOrUser, UnauthorizedError } = await import("@/lib/server/auth");
  try {
    await requireCronOrUser(request);
    return null;
  } catch (e) {
    if (e instanceof UnauthorizedError) return new Response("Unauthorized", { status: 401 });
    throw e;
  }
}

// Mirrors harness/src/llm-keys.ts's LLM_PROVIDERS -- kept as a small local
// literal (like every other action's ad hoc validation in this file)
// rather than adding a new adapter export just for this list.
const LLM_PROVIDERS = ["openai", "anthropic", "google"] as const;
type LlmProvider = (typeof LLM_PROVIDERS)[number];
function isLlmProvider(value: unknown): value is LlmProvider {
  return typeof value === "string" && (LLM_PROVIDERS as readonly string[]).includes(value);
}

type Executor = NonNullable<Awaited<ReturnType<typeof loadHarnessExecutor>>>;

// A connect flow already in progress (across concurrent requests): the
// authorization URL is known as soon as startConnect() resolves, and the
// `done` promise is kept alive here (not awaited by the request) so the
// callback can complete after the HTTP response has already gone back to
// the browser. Nothing here logs a token.
let connectFlow: { urlPromise: Promise<string> } | null = null;

async function startOrJoinConnect(executor: Executor): Promise<{ url: string }> {
  if (!connectFlow) {
    const startPromise = executor.auth.startConnect();
    connectFlow = { urlPromise: startPromise.then((f) => f.url) };
    startPromise
      .then((f) => f.done)
      .then((me) => {
        console.log(`Lovable connect finished: ${me.workspaces.length} workspace(s) available`);
      })
      .catch((err) => {
        console.error(
          `Lovable connect failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .finally(() => {
        connectFlow = null;
      });
  }
  const url = await connectFlow.urlPromise;
  return { url };
}

function parseSyncStartedAt(startedAt: string): Date | null {
  // SQLite's datetime('now') is UTC without a zone marker.
  const parsed = new Date(startedAt.replace(" ", "T") + "Z");
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

async function handleGet({ request }: { request: Request }) {
  const unauthorized = await requireAuth(request);
  if (unauthorized) return unauthorized;

  const adapter = await loadHarnessAdapter();
  if (!adapter) return Response.json(hostedPreviewBody());

  try {
    const executor = await loadHarnessExecutor();
    const settings = adapter.getSettings();
    const schedule = {
      enabled: settings.sync_enabled === "true",
      interval_minutes: Number(settings.sync_interval_minutes),
      window_start_hour: Number(settings.sync_window_start_hour),
      window_end_hour: Number(settings.sync_window_end_hour),
    };

    const lastRun = adapter.latestSyncRun();
    const last_run = lastRun
      ? {
          started_at: lastRun.started_at,
          finished_at: lastRun.finished_at,
          ok: lastRun.ok === null ? null : lastRun.ok === 1,
          error: lastRun.error,
          counts: lastRun.counts,
        }
      : null;

    let next_run_at: string | null = null;
    if (executor) {
      try {
        const lastStarted = lastRun ? parseSyncStartedAt(lastRun.started_at) : null;
        const at = executor.schedule.nextRunAt(
          new Date(),
          lastStarted,
          executor.schedule.scheduleFromSettings(settings),
        );
        next_run_at = at ? at.toISOString() : null;
      } catch {
        next_run_at = null;
      }
    }

    let connection: {
      connected: boolean;
      email: string | null;
      workspaces: { id: string; name: string }[];
    } = {
      connected: false,
      email: null,
      workspaces: [],
    };
    if (executor) {
      try {
        const status = executor.auth.status();
        connection = {
          connected: status.connected,
          email: status.email,
          workspaces: status.workspaces,
        };
      } catch {
        // keep the disconnected default
      }
    }

    const keyStatus = adapter.llmKeyStatus();

    // Round 4 Task A3: "Analyse now" status -- independent of the Lovable
    // connection above (spec §2). provider_ready comes from the same
    // providerReady() the executor loop and `--analyse` gate a run on, so
    // this line and an actual run agree on whether one would work.
    const lastAnalysisRun = adapter.latestAnalysisRun();
    const analysis_last_run = lastAnalysisRun
      ? {
          started_at: lastAnalysisRun.started_at,
          finished_at: lastAnalysisRun.finished_at,
          ok: lastAnalysisRun.ok,
          error: lastAnalysisRun.error,
          counts: lastAnalysisRun.counts,
          tokens: lastAnalysisRun.tokens,
          cost_usd: lastAnalysisRun.cost_usd,
        }
      : null;
    let provider_ready: { ok: boolean; reason?: string } = {
      ok: false,
      reason: "the local executor is not available",
    };
    if (executor) {
      try {
        provider_ready = await executor.analysis.providerReady();
      } catch (e) {
        provider_ready = { ok: false, reason: e instanceof Error ? e.message : String(e) };
      }
    }

    return Response.json({
      available: true,
      connection,
      schedule,
      settings: { knowledge_char_cap: Number(settings.knowledge_char_cap) },
      last_run,
      next_run_at,
      running: adapter.runningSyncRun() != null,
      llm: {
        provider: settings.llm_provider,
        models: JSON.parse(settings.llm_models) as unknown,
        monthly_token_budget: Number(settings.llm_monthly_token_budget),
        tokens_this_month: adapter.sumLlmTokensThisMonth(),
        spent_usd: adapter.sumLlmCostThisMonth(),
        keys: keyStatus,
      },
      analysis: {
        last_run: analysis_last_run,
        running: adapter.runningAnalysisRun() != null,
        awaiting_analysis: adapter.countHistoryItemsAwaitingAnalysis(),
        provider_ready,
      },
      defaults: { max_active_rules: Number(settings.max_active_rules) },
    });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

async function handlePost({ request }: { request: Request }) {
  const unauthorized = await requireAuth(request);
  if (unauthorized) return unauthorized;

  const adapter = await loadHarnessAdapter();
  if (!adapter) return Response.json(hostedPreviewBody(), { status: 200 });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  try {
    const action = body["action"];

    if (action === "sync_now") {
      const result = adapter.requestSync();
      return Response.json({ available: true, id: result.id, created: result.created });
    }

    // Round 4 Task A3: "Analyse now" -- queues an analysis_requests row the
    // executor loop (or `--analyse`) picks up independent of the Lovable
    // connection. Coalesced like sync_now: requestAnalysis() returns the
    // existing open request's id instead of stacking a second one.
    if (action === "analyse_now") {
      const result = adapter.requestAnalysis();
      return Response.json({ available: true, requested: true, id: result.id });
    }

    if (action === "connect") {
      const executor = await loadHarnessExecutor();
      if (!executor) throw new Error("the local executor is not available");
      const { url } = await startOrJoinConnect(executor);
      return Response.json({ available: true, url });
    }

    if (action === "disconnect") {
      const executor = await loadHarnessExecutor();
      if (!executor) throw new Error("the local executor is not available");
      await executor.auth.disconnect();
      return Response.json({ available: true });
    }

    if (action === "schedule") {
      const patch: Partial<Record<string, string>> = {};
      if (body["enabled"] !== undefined) patch["sync_enabled"] = body["enabled"] ? "true" : "false";
      if (body["interval_minutes"] !== undefined)
        patch["sync_interval_minutes"] = String(body["interval_minutes"]);
      if (body["window_start_hour"] !== undefined)
        patch["sync_window_start_hour"] = String(body["window_start_hour"]);
      if (body["window_end_hour"] !== undefined)
        patch["sync_window_end_hour"] = String(body["window_end_hour"]);
      const settings = adapter.setSettings(patch);
      return Response.json({ available: true, settings });
    }

    if (action === "settings") {
      const patch: Partial<Record<string, string>> = {};
      if (body["knowledge_char_cap"] !== undefined)
        patch["knowledge_char_cap"] = String(body["knowledge_char_cap"]);
      const settings = adapter.setSettings(patch);
      return Response.json({ available: true, settings });
    }

    if (action === "llm_settings") {
      const patch: Partial<Record<string, string>> = {};
      if (body["provider"] !== undefined) patch["llm_provider"] = String(body["provider"]);
      if (body["models"] !== undefined) patch["llm_models"] = JSON.stringify(body["models"]);
      if (body["monthly_token_budget"] !== undefined)
        patch["llm_monthly_token_budget"] = String(body["monthly_token_budget"]);
      const settings = adapter.setSettings(patch);
      return Response.json({ available: true, settings });
    }

    if (action === "llm_key") {
      const provider = body["provider"];
      if (!isLlmProvider(provider))
        throw new Error(`provider must be one of: ${LLM_PROVIDERS.join(", ")}`);
      const key = body["key"];
      if (typeof key !== "string" || key.length === 0) throw new Error("key must not be empty");
      if (key.length > 400) throw new Error("key must be at most 400 characters");
      adapter.setLlmKey(provider, key);
      return Response.json({ available: true, keys: adapter.llmKeyStatus() });
    }

    if (action === "llm_key_remove") {
      const provider = body["provider"];
      if (!isLlmProvider(provider))
        throw new Error(`provider must be one of: ${LLM_PROVIDERS.join(", ")}`);
      adapter.removeLlmKey(provider);
      return Response.json({ available: true, keys: adapter.llmKeyStatus() });
    }

    if (action === "defaults") {
      const patch: Partial<Record<string, string>> = {};
      if (body["max_active_rules"] !== undefined)
        patch["max_active_rules"] = String(body["max_active_rules"]);
      const settings = adapter.setSettings(patch);
      return Response.json({ available: true, settings });
    }

    throw new Error(`unknown action: ${String(action)}`);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}

export const Route = createFileRoute("/api/public/harness/executor")({
  server: { handlers: { GET: handleGet, POST: handlePost } },
});
