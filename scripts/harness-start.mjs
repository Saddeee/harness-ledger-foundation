#!/usr/bin/env node
// Thin wrapper around `npm run dev` that fills in the env vars a local run
// needs, without ever overriding a value the caller already set:
//   HARNESS_RUNTIME=local     -- switches the web app to the local runtime
//   HARNESS_DB_PATH=<repo>/harness/data/harness.db  -- absolute, repo-local
//   HOST=127.0.0.1            -- loopback default
// It never sets DEV_HOST_OPEN itself: vite.config.ts already binds the dev
// server to 127.0.0.1 unless the caller has DEV_HOST_OPEN=1 in their own
// environment, and this script deliberately leaves that alone so the
// documented LAN opt-in (`DEV_HOST_OPEN=1 npm run harness:start`) still
// works. See docs/audit/setup-hosted-privacy.md Part A2 and A4.
//
// Usage:
//   node scripts/harness-start.mjs               # start the dev server
//   node scripts/harness-start.mjs --print-only   # print resolved env as JSON, exit 0
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { defaultEnv, repoRootFromScriptsDir } from "./lib.mjs";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = repoRootFromScriptsDir(scriptsDir);

const args = process.argv.slice(2);
const printOnly = args.includes("--print-only");

const resolvedEnv = defaultEnv(process.env, repoRoot);

if (printOnly) {
  console.log(
    JSON.stringify(
      {
        HARNESS_RUNTIME: resolvedEnv.HARNESS_RUNTIME,
        HARNESS_DB_PATH: resolvedEnv.HARNESS_DB_PATH,
        HOST: resolvedEnv.HOST,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const dbModulePath = join(repoRoot, "harness", "dist", "db.js");
if (!existsSync(dbModulePath)) {
  console.error("✗ harness/dist/db.js not found — run npm run setup first");
  process.exit(1);
}

console.log("Starting Harness Ledger with:");
console.log(`  HARNESS_RUNTIME=${resolvedEnv.HARNESS_RUNTIME}`);
console.log(`  HARNESS_DB_PATH=${resolvedEnv.HARNESS_DB_PATH}`);
console.log(`  HOST=${resolvedEnv.HOST}`);
if (resolvedEnv.DEV_HOST_OPEN) {
  console.log(
    `  DEV_HOST_OPEN=${resolvedEnv.DEV_HOST_OPEN} (explicitly set — dev server will bind wide)`,
  );
}

const result = spawnSync("npm", ["run", "dev"], {
  stdio: "inherit",
  cwd: repoRoot,
  env: resolvedEnv,
});
process.exit(result.status ?? 1);
