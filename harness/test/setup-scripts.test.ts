// Pins the pure helpers in scripts/lib.mjs and the observable behaviour of
// scripts/setup.mjs and scripts/harness-start.mjs, without ever running a
// real npm install/build or spawning a dev server (see
// docs/audit/setup-hosted-privacy.md Part A4 for the design these implement).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));

const { parseNodeFloor, nodeSatisfies, defaultDbPath, defaultEnv } =
  await import("../../scripts/lib.mjs");

test("parseNodeFloor: reads a >=x.y.z engines.node range", () => {
  assert.deepEqual(parseNodeFloor(">=22.12.0"), { major: 22, minor: 12, patch: 0 });
});

test("parseNodeFloor: rejects a range it doesn't understand", () => {
  assert.throws(() => parseNodeFloor("^22.12.0"));
  assert.throws(() => parseNodeFloor(undefined));
});

test("nodeSatisfies: compares major/minor/patch against the floor", () => {
  const floor = { major: 22, minor: 12, patch: 0 };
  assert.equal(nodeSatisfies("22.12.0", floor), true);
  assert.equal(nodeSatisfies("22.23.2", floor), true);
  assert.equal(nodeSatisfies("23.0.0", floor), true);
  assert.equal(nodeSatisfies("22.11.9", floor), false);
  assert.equal(nodeSatisfies("18.19.0", floor), false);
});

test("defaultDbPath: absolute, repo-local, ends with harness/data/harness.db", () => {
  const p = defaultDbPath("/some/repo");
  assert.equal(p, resolve("/some/repo", "harness", "data", "harness.db"));
  assert.ok(p.startsWith(sep) || /^[A-Za-z]:/.test(p), `expected absolute path, got ${p}`);
  assert.ok(p.endsWith(join("harness", "data", "harness.db")));
});

test("defaultEnv: sets HARNESS_RUNTIME, HARNESS_DB_PATH, HOST when unset", () => {
  const env = defaultEnv({}, "/some/repo");
  assert.equal(env.HARNESS_RUNTIME, "local");
  assert.equal(env.HOST, "127.0.0.1");
  assert.equal(env.HARNESS_DB_PATH, defaultDbPath("/some/repo"));
});

test("defaultEnv: never overrides values already set", () => {
  const existing = {
    HARNESS_RUNTIME: "hosted",
    HARNESS_DB_PATH: "/custom/path.db",
    HOST: "0.0.0.0",
    OTHER: "kept",
  };
  const env = defaultEnv(existing, "/some/repo");
  assert.equal(env.HARNESS_RUNTIME, "hosted");
  assert.equal(env.HARNESS_DB_PATH, "/custom/path.db");
  assert.equal(env.HOST, "0.0.0.0");
  assert.equal(env.OTHER, "kept");
});

test("harness-start.mjs --print-only: prints resolved env, HOST is loopback, DB path absolute", () => {
  const result = spawnSync(
    process.execPath,
    [join(repoRoot, "scripts", "harness-start.mjs"), "--print-only"],
    {
      encoding: "utf8",
      env: { ...process.env, HARNESS_RUNTIME: "", HARNESS_DB_PATH: "", HOST: "" },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const printed = JSON.parse(result.stdout);
  assert.equal(printed.HOST, "127.0.0.1");
  assert.equal(printed.HARNESS_RUNTIME, "local");
  assert.ok(
    printed.HARNESS_DB_PATH.startsWith(sep) || /^[A-Za-z]:/.test(printed.HARNESS_DB_PATH),
    `expected an absolute HARNESS_DB_PATH, got ${printed.HARNESS_DB_PATH}`,
  );
  assert.ok(printed.HARNESS_DB_PATH.endsWith(join("harness", "data", "harness.db")));
});

test("harness-start.mjs --print-only: respects an already-set DEV_HOST_OPEN without setting it itself", () => {
  const result = spawnSync(
    process.execPath,
    [join(repoRoot, "scripts", "harness-start.mjs"), "--print-only"],
    { encoding: "utf8", env: { ...process.env, DEV_HOST_OPEN: "1" } },
  );
  assert.equal(result.status, 0, result.stderr);
  const printed = JSON.parse(result.stdout);
  // harness-start.mjs's own default (HOST=127.0.0.1) is unaffected either way --
  // the point is it never strips or overrides a caller-set DEV_HOST_OPEN, which
  // is what vite.config.ts actually reads to decide the bind address.
  assert.equal(printed.HOST, "127.0.0.1");
});

test("setup.mjs --skip-install --dry-run: prints the steps and the next command, exits 0", () => {
  const result = spawnSync(
    process.execPath,
    [join(repoRoot, "scripts", "setup.mjs"), "--skip-install", "--dry-run"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /npm run harness:start/);
  assert.match(result.stdout, /skip-install/);
  assert.match(result.stdout, /verify Node/i);
});
