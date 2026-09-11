// Bridges this app's server routes to the local-only Harness SQLite adapter
// (harness/src/adapter.ts, compiled to harness/dist/adapter.js). Only used
// when HARNESS_RUNTIME=local. On the hosted deployment better-sqlite3 cannot
// run at all (this app's Nitro target is Cloudflare, which has no native
// Node addon support), so every caller must treat a null return as a normal
// "hosted preview" state, never crash.
//
// The import path points at compiled output, not harness/src/*.ts directly,
// so that loading it never depends on this app's own Vite/TS toolchain
// being able to transform a sibling package's TypeScript at runtime. Run
// `npm run harness:build` once (or after editing harness/) before using
// HARNESS_RUNTIME=local locally.
type HarnessAdapter = typeof import("../../../harness/dist/adapter.js");

let cached: HarnessAdapter | null | undefined;

export async function loadHarnessAdapter(): Promise<HarnessAdapter | null> {
  if (cached !== undefined) return cached;
  if (process.env["HARNESS_RUNTIME"] !== "local") {
    cached = null;
    return cached;
  }
  try {
    cached = await import(/* @vite-ignore */ "../../../harness/dist/adapter.js");
  } catch {
    cached = null;
  }
  return cached;
}

// Same guard and caching shape as loadHarnessAdapter, but for the three
// executor modules the knowledge/executor/projects routes need: connecting
// to Lovable, computing the next scheduled run, and (only for the cached
// project list) reading Lovable's project list. Everything else Lovable
// touches stays in the executor process (harness/src/executor/beats.ts),
// never here.
type HarnessExecutor = {
  auth: typeof import("../../../harness/dist/executor/lovable-auth.js");
  schedule: typeof import("../../../harness/dist/executor/schedule.js");
  mcp: typeof import("../../../harness/dist/executor/lovable-mcp.js");
};

let cachedExecutor: HarnessExecutor | null | undefined;

export async function loadHarnessExecutor(): Promise<HarnessExecutor | null> {
  if (cachedExecutor !== undefined) return cachedExecutor;
  if (process.env["HARNESS_RUNTIME"] !== "local") {
    cachedExecutor = null;
    return cachedExecutor;
  }
  try {
    const [auth, schedule, mcp] = await Promise.all([
      import(/* @vite-ignore */ "../../../harness/dist/executor/lovable-auth.js"),
      import(/* @vite-ignore */ "../../../harness/dist/executor/schedule.js"),
      import(/* @vite-ignore */ "../../../harness/dist/executor/lovable-mcp.js"),
    ]);
    cachedExecutor = { auth, schedule, mcp };
  } catch {
    cachedExecutor = null;
  }
  return cachedExecutor;
}

export function hostedPreviewBody(detail?: string) {
  return {
    available: false as const,
    reason:
      detail ??
      "This is the hosted preview. Harness runs on your own machine for now; start it locally to see your data.",
  };
}
