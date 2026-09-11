/**
 * LLM provider API keys: stored in a single 0600 JSON file next to the
 * SQLite database (never in SQLite itself, never returned or logged
 * verbatim), mirroring the 0600-file pattern executor/lovable-auth.ts uses
 * for the Lovable OAuth tokens. Nothing here calls a provider -- see the
 * spec's "Analysis is not switched on yet" line: these keys are stored for
 * when it is.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve as resolvePath, join } from "node:path";

export const LLM_PROVIDERS = ["openai", "anthropic", "google"] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

type KeysFile = Partial<Record<LlmProvider, string>>;

export function keysFilePath(): string {
  const explicit = process.env.HARNESS_LLM_KEYS_PATH;
  if (explicit) return resolvePath(explicit);
  const dbPath = resolvePath(process.env.HARNESS_DB_PATH ?? "./data/harness.db");
  return join(dirname(dbPath), "llm-keys.json");
}

function isLlmProvider(value: string): value is LlmProvider {
  return (LLM_PROVIDERS as readonly string[]).includes(value);
}

function assertProvider(provider: string): asserts provider is LlmProvider {
  if (!isLlmProvider(provider)) {
    throw new Error(
      `unknown LLM provider: ${provider} (expected one of ${LLM_PROVIDERS.join(", ")})`,
    );
  }
}

function readKeysFile(file: string): KeysFile {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as KeysFile;
  } catch {
    return {};
  }
}

function writeKeysFile(file: string, data: KeysFile): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // `mkdirSync`'s `mode` only applies when it creates the directory -- if the
  // data directory already existed (e.g. db.ts created it first, with no
  // mode of its own), this is the only thing that actually tightens it.
  // Wrapped in try/catch: chmod semantics aren't guaranteed on non-POSIX
  // platforms, and this is defense in depth, not the primary guarantee.
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* best effort */
  }
  writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  // writeFileSync only applies `mode` when it creates the file.
  chmodSync(file, 0o600);
}

/** Stores `key` for `provider`, overwriting any existing key for it. */
export function setKey(provider: string, key: string): void {
  assertProvider(provider);
  if (!key || !key.trim()) throw new Error("key must not be empty");
  const file = keysFilePath();
  const data = readKeysFile(file);
  data[provider] = key;
  writeKeysFile(file, data);
}

/** Removes any stored key for `provider`. A no-op if none was stored. */
export function removeKey(provider: string): void {
  assertProvider(provider);
  const file = keysFilePath();
  if (!existsSync(file)) return;
  const data = readKeysFile(file);
  if (!(provider in data)) return;
  delete data[provider];
  writeKeysFile(file, data);
}

/**
 * Returns the raw key for in-process use only (an outbound HTTP call to the
 * provider) -- never log it, never put it in a response body or a thrown
 * error message. `null` for a provider with no stored key and for any
 * provider this file doesn't manage keys for (e.g. `claude_code`, which
 * authenticates via the locally installed CLI's own subscription login,
 * not an API key) -- both are "no key", not an error, since the caller
 * (harness/src/llm/index.ts) only needs a key for the API providers.
 */
export function getKey(provider: string): string | null {
  if (!isLlmProvider(provider)) return null;
  const file = keysFilePath();
  if (!existsSync(file)) return null;
  const data = readKeysFile(file);
  return data[provider] ?? null;
}

/**
 * Never returns the raw key -- only whether one is stored and its last four
 * characters, which is all any route or UI may show.
 */
export function keyStatus(): Record<LlmProvider, { has_key: boolean; last4: string | null }> {
  const file = keysFilePath();
  const data = existsSync(file) ? readKeysFile(file) : {};
  const out = {} as Record<LlmProvider, { has_key: boolean; last4: string | null }>;
  for (const provider of LLM_PROVIDERS) {
    const key = data[provider];
    out[provider] = key ? { has_key: true, last4: key.slice(-4) } : { has_key: false, last4: null };
  }
  return out;
}
