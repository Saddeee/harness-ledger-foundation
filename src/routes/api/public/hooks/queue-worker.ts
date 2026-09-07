import { createFileRoute } from "@tanstack/react-router";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

type Job = {
  id: string;
  kind: string;
  payload: unknown;
  status: string;
  attempts: number;
  owner_user_id: string | null;
};

const handlers: Record<string, (job: Job, db: SupabaseClient) => Promise<unknown>> = {
  noop: async (job) => ({ ok: true, job_id: job.id }),
};

function serviceClient(): SupabaseClient {
  return createClient(process.env["SUPABASE_URL"]!, process.env["SUPABASE_SERVICE_ROLE_KEY"]!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function logEvent(
  db: SupabaseClient,
  ownerUserId: string | null,
  kind: string,
  refTable: string,
  refId: string | null,
  payload: unknown,
) {
  await db.from("events").insert({
    owner_user_id: ownerUserId,
    kind,
    ref_table: refTable,
    ref_id: refId,
    payload: payload as never,
  });
}

async function killSwitchOwners(db: SupabaseClient): Promise<Set<string>> {
  const { data } = await db.from("settings").select("owner_user_id, value").eq("key", "kill_switch");
  const set = new Set<string>();
  for (const row of data ?? []) {
    if (row.value === true && row.owner_user_id) set.add(row.owner_user_id as string);
  }
  return set;
}

async function runWorker(): Promise<Response> {
  const db = serviceClient();
  const { data: jobs, error } = await db.rpc("claim_jobs", { p_limit: 5 });
  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  const blocked = await killSwitchOwners(db);
  const results: unknown[] = [];

  for (const job of (jobs ?? []) as Job[]) {
    if (job.owner_user_id && blocked.has(job.owner_user_id)) {
      await db
        .from("job_queue")
        .update({ status: "queued", locked_at: null, attempts: Math.max(0, job.attempts - 1) })
        .eq("id", job.id);
      results.push({ id: job.id, skipped: "kill_switch" });
      continue;
    }

    const handler = handlers[job.kind];
    try {
      if (!handler) throw new Error(`No handler for job kind "${job.kind}"`);
      const out = await handler(job, db);
      await db.from("job_queue").update({ status: "done", error: null }).eq("id", job.id);
      await logEvent(db, job.owner_user_id, "job.done", "job_queue", job.id, {
        kind: job.kind,
        result: out,
      });
      results.push({ id: job.id, status: "done" });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (job.attempts < 3) {
        await db
          .from("job_queue")
          .update({
            status: "queued",
            locked_at: null,
            error: message,
            run_after: new Date(Date.now() + 120000).toISOString(),
          })
          .eq("id", job.id);
        await logEvent(db, job.owner_user_id, "job.retry", "job_queue", job.id, {
          kind: job.kind,
          error: message,
        });
        results.push({ id: job.id, status: "retry" });
      } else {
        await db.from("job_queue").update({ status: "failed", error: message }).eq("id", job.id);
        await logEvent(db, job.owner_user_id, "job.failed", "job_queue", job.id, {
          kind: job.kind,
          error: message,
        });
        results.push({ id: job.id, status: "failed" });
      }
    }
  }

  return Response.json({ claimed: (jobs ?? []).length, results });
}

async function handle({ request }: { request: Request }) {
  const secret = process.env["CRON_SECRET"];
  if (!secret || request.headers.get("x-cron-secret") !== secret) {
    return new Response("Unauthorized", { status: 401 });
  }
  return runWorker();
}

export const Route = createFileRoute("/api/public/hooks/queue-worker")({
  server: { handlers: { POST: handle, GET: handle } },
});
