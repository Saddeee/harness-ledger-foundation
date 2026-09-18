// Pure helpers shared by scripts/setup.mjs and scripts/harness-start.mjs.
// No dependencies, no side effects at import time -- kept separate from the
// two CLI scripts so they can be unit-tested directly (see
// harness/test/setup-scripts.test.ts).
import { join, resolve } from "node:path";

/**
 * Parse a package.json-style `engines.node` range (e.g. ">=22.12.0") into the
 * minimum version it requires. Only understands the single `>=x.y.z` form
 * this repo's package.json actually uses; throws on anything else so a
 * future change to that field is caught rather than silently ignored.
 */
export function parseNodeFloor(enginesString) {
  const match = /^>=\s*(\d+)\.(\d+)\.(\d+)$/.exec((enginesString ?? "").trim());
  if (!match) {
    throw new Error(`unrecognized engines.node range: ${JSON.stringify(enginesString)}`);
  }
  const [, major, minor, patch] = match;
  return { major: Number(major), minor: Number(minor), patch: Number(patch) };
}

/** Compare a `major.minor.patch` (or `process.versions.node`-style) version string against a floor. */
export function nodeSatisfies(version, floor) {
  const parts = String(version)
    .split(".")
    .map((n) => Number.parseInt(n, 10));
  const [major = 0, minor = 0, patch = 0] = parts;
  if (major !== floor.major) return major > floor.major;
  if (minor !== floor.minor) return minor > floor.minor;
  return patch >= floor.patch;
}

/**
 * Absolute, repo-local default DB path -- always computed with `path.resolve`
 * against a known repo root, never against `process.cwd()` at some ambiguous
 * point, so a relative HARNESS_DB_PATH like "harness/data/harness.db" can
 * never combine with a cwd already inside harness/ to produce the
 * harness/harness/ trap (see docs/audit/setup-hosted-privacy.md Part A3).
 */
export function defaultDbPath(repoRoot) {
  return resolve(repoRoot, "harness", "data", "harness.db");
}

/**
 * Fill in the env vars `npm run harness:start` needs, without ever
 * overriding a value the caller already set. `existing` is a plain object
 * (normally `process.env`); returns a new object with the same keys plus any
 * missing defaults added.
 */
export function defaultEnv(existing, repoRoot) {
  const env = { ...existing };
  if (!env.HARNESS_RUNTIME) env.HARNESS_RUNTIME = "local";
  if (!env.HARNESS_DB_PATH) env.HARNESS_DB_PATH = defaultDbPath(repoRoot);
  if (!env.HOST) env.HOST = "127.0.0.1";
  return env;
}

export function repoRootFromScriptsDir(scriptsDir) {
  return resolve(scriptsDir, "..");
}

export function llmKeysFileName() {
  // Mirrors harness/src/llm-keys.ts's own default file name (kept as a
  // literal here rather than importing that module, since setup.mjs must
  // run before harness/dist exists).
  return join("llm-keys.json");
}
