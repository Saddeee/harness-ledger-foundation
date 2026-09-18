#!/usr/bin/env node
// One-command setup for a fresh clone: installs both npm packages (root and
// harness/), builds the local runtime, opens the SQLite DB once so pending
// migrations run, and reports whether Lovable / an AI provider are already
// configured. See docs/audit/setup-hosted-privacy.md Part A4 for the design
// this implements, and Part A3 for the harness/harness/ relative-path trap
// this deliberately avoids by only ever using an absolute HARNESS_DB_PATH.
//
// Usage:
//   node scripts/setup.mjs                 # full setup
//   node scripts/setup.mjs --skip-install   # skip `npm install` steps (CI, repeat runs)
//   node scripts/setup.mjs --dry-run        # print the steps and exit, run nothing
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseNodeFloor, nodeSatisfies, defaultDbPath, repoRootFromScriptsDir } from "./lib.mjs";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = repoRootFromScriptsDir(scriptsDir);

const args = process.argv.slice(2);
const skipInstall = args.includes("--skip-install");
const dryRun = args.includes("--dry-run");

const STEP_DESCRIPTIONS = [
  "1. verify Node.js version",
  "2. npm install (root)",
  "3. npm install (harness/)",
  "4. build harness (npm --prefix harness run build)",
  "5. open the database once so pending migrations run",
  "6. check local configuration (Lovable connection, AI provider)",
  "7. verify required build output exists",
  "8. print the next command",
];

function ok(msg) {
  console.log(`✓ ${msg}`);
}

function fail(msg) {
  console.error(`✗ ${msg}`);
}

function run(command, cmdArgs, options = {}) {
  const result = spawnSync(command, cmdArgs, { stdio: "inherit", ...options });
  return result.status === 0;
}

if (dryRun) {
  console.log("Dry run -- no commands will actually be executed.");
  for (const step of STEP_DESCRIPTIONS) {
    console.log(`would run: ${step}`);
  }
  if (skipInstall) {
    console.log("(--skip-install: steps 2 and 3 would be skipped)");
  }
  console.log("Next command: npm run harness:start");
  process.exit(0);
}

// ---- Step 1: Node version -------------------------------------------------
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const floor = parseNodeFloor(pkg.engines?.node);
const floorString = `${floor.major}.${floor.minor}.${floor.patch}`;
const foundVersion = process.versions.node;

if (!nodeSatisfies(foundVersion, floor)) {
  fail(`Node ${foundVersion} found, but ${floorString} or newer is required.`);
  console.error(
    `  Fix: install Node ${floorString}+ (e.g. \`nvm install && nvm use\`) and re-run npm run setup.`,
  );
  process.exit(1);
}
ok(`Node ${foundVersion} (>= ${floorString} required)`);

// ---- Steps 2-3: npm install -------------------------------------------------
if (skipInstall) {
  ok("Skipped npm install (--skip-install)");
} else {
  if (!run("npm", ["install"], { cwd: repoRoot })) {
    fail("npm install (root) failed -- see output above.");
    process.exit(1);
  }
  ok("npm install (root)");

  if (!run("npm", ["install"], { cwd: join(repoRoot, "harness") })) {
    fail("npm install (harness/) failed -- see output above.");
    process.exit(1);
  }
  ok("npm install (harness/)");
}

// ---- Step 4: build harness --------------------------------------------------
if (!run("npm", ["--prefix", "harness", "run", "build"], { cwd: repoRoot })) {
  fail("npm --prefix harness run build failed -- see output above.");
  process.exit(1);
}
ok("harness built (harness/dist)");

// ---- Step 5: open the DB once so pending migrations run --------------------
const dbPath = defaultDbPath(repoRoot);
const dataDir = dirname(dbPath);
if (!existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
}

const migrate = spawnSync(
  process.execPath,
  ["-e", "import('./harness/dist/db.js').then(m => console.log('schema', m.schemaVersion()))"],
  { cwd: repoRoot, env: { ...process.env, HARNESS_DB_PATH: dbPath }, encoding: "utf8" },
);
if (migrate.status !== 0) {
  fail(`could not open the database at ${dbPath}`);
  console.error(migrate.stderr || migrate.stdout);
  process.exit(1);
}
const schemaMatch = /schema (\d+)/.exec(migrate.stdout ?? "");
ok(`database ready at ${dbPath}${schemaMatch ? ` (schema version ${schemaMatch[1]})` : ""}`);

// ---- Step 6: validate local configuration -----------------------------------
// Mirrors the file-location logic in harness/src/executor/lovable-auth.ts
// (authFilePath) and harness/src/llm-keys.ts (keysFilePath): both default to
// a file named next to HARNESS_DB_PATH's directory.
const lovableAuthPath = join(dataDir, "lovable-auth.json");
if (existsSync(lovableAuthPath)) {
  const mode = statSync(lovableAuthPath).mode & 0o777;
  if (mode !== 0o600) {
    chmodSync(lovableAuthPath, 0o600);
    ok(`fixed permissions on ${lovableAuthPath} (was ${mode.toString(8)}, now 0600)`);
  } else {
    ok("Lovable connection file permissions ok (0600)");
  }
} else {
  ok("Lovable: not connected yet — Connect Lovable on the Projects page");
}

const llmKeysPath = join(dataDir, "llm-keys.json");
if (existsSync(llmKeysPath)) {
  const mode = statSync(llmKeysPath).mode & 0o777;
  if (mode !== 0o600) {
    chmodSync(llmKeysPath, 0o600);
    ok(`fixed permissions on ${llmKeysPath} (was ${mode.toString(8)}, now 0600)`);
  } else {
    ok("AI provider key file permissions ok (0600)");
  }
} else {
  ok("AI provider: not configured yet — pick one in Settings › AI analysis");
}

// ---- Step 7: verify required build output -----------------------------------
const requiredFiles = [
  join(repoRoot, "harness", "dist", "adapter.js"),
  join(repoRoot, "harness", "dist", "db.js"),
];
let missing = false;
for (const file of requiredFiles) {
  if (!existsSync(file)) {
    fail(`missing ${file} -- run npm --prefix harness run build`);
    missing = true;
  }
}
if (missing) process.exit(1);
ok("required harness/dist files present");

// ---- Step 8: next command ----------------------------------------------------
console.log("");
console.log("Setup complete. Next: npm run harness:start");
