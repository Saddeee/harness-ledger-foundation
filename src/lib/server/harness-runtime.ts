// Bridges this app's server routes to the local-only Harness SQLite adapter
// (harness/src/adapter.ts, compiled to harness/dist/adapter.js). Only used
// when HARNESS_RUNTIME=local. On the hosted deployment better-sqlite3 cannot
// run at all (this app's Nitro target is Cloudflare, which has no native
// Node addon support), so every caller must treat a null return as a normal
// "hosted preview" state, never crash. See SPEC.md Part C.
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

export function hostedPreviewBody(detail?: string) {
  return {
    available: false as const,
    reason:
      detail ??
      "This is the hosted-runtime preview. The operational prototype runs locally through Claude Code and Lovable MCP (HARNESS_RUNTIME=local); direct hosted execution isn't available yet. See SPEC.md Part C.",
  };
}
