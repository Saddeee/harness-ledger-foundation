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

// ---- Checkpoint 2026-09-18 WP5 (D7): "Reanalyse history" ----
// A small local shape/validator, same convention as isLlmProvider above --
// the real validation (dates, project ids) happens in
// harness/src/analysis/reanalyse.ts; this just gets a well-typed object out
// of an untrusted JSON body.
type ReanalyseScopeBody = {
  project_ids: string[];
  from: string;
  to: string;
  include_reviewed: boolean;
};

function parseReanalyseScopeBody(body: Record<string, unknown>): ReanalyseScopeBody {
  const projectIds = Array.isArray(body["project_ids"])
    ? body["project_ids"].filter((x): x is string => typeof x === "string")
    : [];
  const from = typeof body["from"] === "string" ? body["from"] : "";
  const to = typeof body["to"] === "string" ? body["to"] : "";
  if (!from || !to) throw new Error("from and to dates are required");
  const includeReviewed = body["include_reviewed"] === true;
  return { project_ids: projectIds, from, to, include_reviewed: includeReviewed };
}
// ---- end Checkpoint 2026-09-18 WP5 ----

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

    // Round 6 Task 2: which process currently drives the schedule, for the
    // sidebar/Projects-page line ("Schedule: running in the app" / "in the
    // executor process" / "not running") -- null means neither an in-app
    // scheduler nor a `npm run harness:executor` loop currently holds it.
    let schedule_holder: { owner: "app" | "cli"; pid: number } | null = null;
    if (executor) {
      try {
        const holder = executor.lock.currentLockHolder();
        schedule_holder = holder ? { owner: holder.owner, pid: holder.pid } : null;
      } catch {
        schedule_holder = null;
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
      settings: {
        knowledge_char_cap: Number(settings.knowledge_char_cap),
        // Round 5 Task 6 / spec §4/§4b: Settings > Decisions -- the current
        // mode/threshold, the parsed evidence-source flags, and the
        // feedback-loop line's own counts (accepted/skipped/verdicts/
        // automatic), all read straight off the settings row and
        // feedbackStats() so the client never has to parse either itself.
        decision_mode: settings.decision_mode as "ask" | "automatic",
        // Round 8 Task 6 (review item 10), fix round 1: settings.decision_mode
        // above is always a real value ("ask" by default -- see
        // SETTING_DEFAULTS in harness/src/store.ts), so it can never tell a
        // caller whether the user has actually chosen a mode yet.
        // decision_mode_chosen reads the settings table directly (no
        // default merged in) so onboarding's step 3 can tell "never set"
        // from "set to ask".
        decision_mode_chosen: adapter.hasSettingRow("decision_mode"),
        decision_auto_confidence: Number(settings.decision_auto_confidence),
        evidence_sources: JSON.parse(settings.evidence_sources) as Record<string, boolean>,
        feedback: adapter.feedbackStats(),
        // Round 6 Task 6b / spec §6: the Lovable-credits section's own
        // switch -- read here alongside every other setting this route
        // already exposes.
        keep_test_copies: settings.keep_test_copies === "true",
        // Checkpoint 2026-09-18 WP5 (D7): default-off, read via its own
        // module rather than the `settings` row above -- see
        // harness/src/analysis/context.ts's header for why.
        automatic_analysis_after_sync: adapter.getAutomaticAnalysisSetting(),
      },
      last_run,
      next_run_at,
      schedule_holder,
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
        // Round 7: the step and counts of the run in flight, and whether a
        // requested run has not started yet -- the Inbox's progress display.
        progress: adapter.runningAnalysisProgress(),
        queued: adapter.hasOpenAnalysisRequest(),
        awaiting_analysis: adapter.countHistoryItemsAwaitingAnalysis(),
        provider_ready,
        // Checkpoint 2026-09-18 WP5 (D7): open review items where a newer
        // analysis disagreed with a decision a person already made -- the
        // Inbox renders one card per row, Accept/Dismiss post back to the
        // actions below.
        disagreements: adapter.listAnalysisDisagreements("open"),
      },
      defaults: { max_active_rules: Number(settings.max_active_rules) },
      // Round 6 Task 6b / spec §6: the Lovable-credits Settings section and
      // the Projects page's "Test copies to delete by hand" reminder.
      credits: {
        used_this_month: adapter.creditsThisMonth(),
        budget: Number(settings.lovable_monthly_credit_budget),
        last_test_cost: adapter.lastKnownTestCost(),
        judged_runs: adapter.listExperimentRuns({ status: ["judged"] }).length,
      },
      undeleted_copies: adapter.listUndeletedCopies(),
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
      // Round 6 Task 2 / spec §2: runs the sync in THIS request, not a
      // separate executor process -- the button shows progress and the
      // result line, not just "requested". syncNow() (harness/src/
      // executor/beats.ts) refuses cleanly (without opening a client) when
      // Harness is disconnected or a sync is already running; either way
      // the response always carries real counts or the reason.
      const executor = await loadHarnessExecutor();
      if (!executor) throw new Error("the local executor is not available");
      const result = await executor.beats.syncNow();
      return Response.json({
        available: true,
        ok: result.ok,
        counts: result.counts,
        ...(result.error ? { error: result.error } : {}),
      });
    }

    // Round 4 Task A3: "Analyse now" -- queues an analysis_requests row the
    // executor loop (or `--analyse`) picks up independent of the Lovable
    // connection. Coalesced like sync_now: requestAnalysis() returns the
    // existing open request's id instead of stacking a second one.
    if (action === "analyse_now") {
      const result = adapter.requestAnalysis();
      // Start now in this process when it runs the schedule; otherwise the
      // schedule's own tick picks the request up.
      const executor = await loadHarnessExecutor();
      executor?.schedule.kickAnalysisNow();
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
      // Checkpoint 2026-09-18 (D7): saved with the schedule, default off.
      if (body["automatic_analysis_after_sync"] !== undefined)
        patch["automatic_analysis_after_sync"] =
          body["automatic_analysis_after_sync"] === true ? "true" : "false";
      const settings = adapter.setSettings(patch);
      return Response.json({ available: true, settings });
    }

    if (action === "settings") {
      const patch: Partial<Record<string, string>> = {};
      if (body["knowledge_char_cap"] !== undefined)
        patch["knowledge_char_cap"] = String(body["knowledge_char_cap"]);
      // Round 5 Task 6 / spec §4: Settings > Decisions writes these three
      // through the same "settings" action -- adapter.setSettings (via
      // store.ts's own assertDecisionMode/assertDecisionAutoConfidence/
      // assertEvidenceSources) is where the real validation happens, so
      // nothing here re-checks the mode enum or the confidence range.
      // evidence_sources always lands here as a string: pass a caller's own
      // JSON string through unchanged, else stringify the object body gave.
      if (body["decision_mode"] !== undefined)
        patch["decision_mode"] = String(body["decision_mode"]);
      if (body["decision_auto_confidence"] !== undefined)
        patch["decision_auto_confidence"] = String(body["decision_auto_confidence"]);
      if (body["evidence_sources"] !== undefined)
        patch["evidence_sources"] =
          typeof body["evidence_sources"] === "string"
            ? body["evidence_sources"]
            : JSON.stringify(body["evidence_sources"]);
      // Round 6 Task 6b / spec §6: the Lovable-credits Settings section --
      // store.ts's own setSettings validation (assertIntInRange 0-1000 for
      // the budget, the boolean-setting check for keep_test_copies) is the
      // real gate, same as every other setting on this route.
      if (body["lovable_monthly_credit_budget"] !== undefined)
        patch["lovable_monthly_credit_budget"] = String(body["lovable_monthly_credit_budget"]);
      if (body["keep_test_copies"] !== undefined)
        patch["keep_test_copies"] = String(body["keep_test_copies"]);
      // Checkpoint 2026-09-18 WP5 (D7): a separate write from the patch
      // above -- store.setSettings validates its patch against a fixed
      // SettingKey union this key isn't part of this checkpoint (see
      // harness/src/analysis/context.ts's header).
      if (body["automatic_analysis_after_sync"] !== undefined)
        patch["automatic_analysis_after_sync"] =
          body["automatic_analysis_after_sync"] === true ? "true" : "false";
      const settings = adapter.setSettings(patch);
      return Response.json({
        available: true,
        settings: {
          ...settings,
          automatic_analysis_after_sync: adapter.getAutomaticAnalysisSetting(),
        },
      });
    }

    // Checkpoint 2026-09-18 WP5 (D7): "Reanalyse history" -- an estimate
    // (candidate counts, token cost, provider/model per role, budget
    // remaining) shown before confirming, then the scoped, non-coalesced
    // request itself.
    if (action === "reanalyse_estimate") {
      const scope = parseReanalyseScopeBody(body);
      const estimate = adapter.estimateReanalysis(scope);
      return Response.json({ available: true, estimate });
    }

    if (action === "reanalyse") {
      const scope = parseReanalyseScopeBody(body);
      const reason = typeof body["reason"] === "string" ? body["reason"] : "";
      const result = adapter.requestReanalysis(scope, reason);
      // Start now in this process when it runs the schedule; otherwise the
      // schedule's own tick picks the request up -- same pattern as
      // analyse_now above.
      const executor = await loadHarnessExecutor();
      executor?.schedule.kickAnalysisNow();
      return Response.json({ available: true, requested: true, id: result.id });
    }

    if (action === "accept_disagreement" || action === "dismiss_disagreement") {
      const id = Number(body["id"]);
      if (!Number.isInteger(id)) throw new Error("id must be an integer");
      if (action === "accept_disagreement") adapter.acceptDisagreement(id);
      else adapter.dismissDisagreement(id);
      return Response.json({
        available: true,
        disagreements: adapter.listAnalysisDisagreements("open"),
      });
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

    // Checkpoint 2 2-E: "Test provider" (Settings > AI analysis). One tiny
    // structured-output call through the same code path a real analysis
    // call uses (harness/src/llm/index.ts's testProvider), so an OpenAI
    // parameter-compatibility problem is caught here rather than the first
    // time a real analysis runs. Never throws for a call that failed at the
    // provider -- `ok: false` with the specific reason is a normal result of
    // this action, not a route error; the route's own catch below is only
    // for something unexpected (e.g. no model configured at all).
    if (action === "test_provider") {
      const result = await adapter.testProvider();
      return Response.json({ available: true, result });
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
