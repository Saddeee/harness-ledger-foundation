import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "harness-llm-keys-test-"));
process.env.HARNESS_DB_PATH = join(tmp, "harness.db");

const llmKeys = await import("../src/llm-keys.js");

test("keysFilePath: derives from HARNESS_DB_PATH's directory by default", () => {
  const path = llmKeys.keysFilePath();
  assert.equal(path, join(tmp, "llm-keys.json"));
});

test("keysFilePath: honours HARNESS_LLM_KEYS_PATH when set", () => {
  const explicit = join(tmp, "elsewhere", "keys.json");
  process.env.HARNESS_LLM_KEYS_PATH = explicit;
  try {
    assert.equal(llmKeys.keysFilePath(), explicit);
  } finally {
    delete process.env.HARNESS_LLM_KEYS_PATH;
  }
});

test("keyStatus before any key exists: has_key false, last4 null, no file required", () => {
  assert.equal(existsSync(llmKeys.keysFilePath()), false);
  const status = llmKeys.keyStatus();
  assert.deepEqual(status, {
    openai: { has_key: false, last4: null },
    anthropic: { has_key: false, last4: null },
    google: { has_key: false, last4: null },
  });
});

test("setKey/keyStatus/removeKey round-trip, last4 correct, file mode 0600, dir 0700, never logs the raw key", () => {
  llmKeys.setKey("openai", "sk-abcdefghij1234567890");

  const file = llmKeys.keysFilePath();
  assert.ok(existsSync(file));
  const mode = statSync(file).mode & 0o777;
  assert.equal(mode, 0o600, `expected file mode 0600, got ${mode.toString(8)}`);
  const dirMode = statSync(join(file, "..")).mode & 0o777;
  assert.equal(dirMode, 0o700, `expected dir mode 0700, got ${dirMode.toString(8)}`);

  const status = llmKeys.keyStatus();
  assert.deepEqual(status.openai, { has_key: true, last4: "7890" });
  assert.deepEqual(status.anthropic, { has_key: false, last4: null });

  // The raw key is never present verbatim outside the file's own content --
  // reading the file directly is the only way to see it.
  const raw = readFileSync(file, "utf8");
  assert.ok(raw.includes("sk-abcdefghij1234567890"));

  llmKeys.setKey("anthropic", "ant-key-99998888");
  const status2 = llmKeys.keyStatus();
  assert.deepEqual(status2.openai, { has_key: true, last4: "7890" });
  assert.deepEqual(status2.anthropic, { has_key: true, last4: "8888" });
  assert.deepEqual(status2.google, { has_key: false, last4: null });

  llmKeys.removeKey("openai");
  const status3 = llmKeys.keyStatus();
  assert.deepEqual(status3.openai, { has_key: false, last4: null });
  assert.deepEqual(status3.anthropic, { has_key: true, last4: "8888" });

  llmKeys.removeKey("anthropic");
  assert.deepEqual(llmKeys.keyStatus(), {
    openai: { has_key: false, last4: null },
    anthropic: { has_key: false, last4: null },
    google: { has_key: false, last4: null },
  });
});

test("setKey rejects an unknown provider and an empty key", () => {
  assert.throws(() => llmKeys.setKey("cohere", "x"));
  assert.throws(() => llmKeys.setKey("openai", ""));
  assert.throws(() => llmKeys.setKey("openai", "   "));
});

test("removeKey on a provider with no key is a harmless no-op", () => {
  llmKeys.removeKey("google");
  assert.deepEqual(llmKeys.keyStatus().google, { has_key: false, last4: null });
});

test("setKey tightens a pre-existing, more permissive data directory to 0700 (e.g. one db.ts created without a mode)", () => {
  const preexisting = join(tmp, "preexisting-dir");
  // Simulates db.ts's `mkdirSync(dir, { recursive: true })` with no mode:
  // mkdirSync's own `mode` option is a no-op on a directory that already
  // exists, so this is the case the fix actually has to handle.
  mkdirSync(preexisting, { recursive: true, mode: 0o755 });
  assert.equal(statSync(preexisting).mode & 0o777, 0o755, "precondition: dir starts loose");

  const keysPath = join(preexisting, "llm-keys.json");
  process.env.HARNESS_LLM_KEYS_PATH = keysPath;
  try {
    llmKeys.setKey("openai", "sk-tighten-dir-test-1234");
    const dirMode = statSync(preexisting).mode & 0o777;
    assert.equal(dirMode, 0o700, `expected the pre-existing dir to be tightened to 0700, got ${dirMode.toString(8)}`);
  } finally {
    delete process.env.HARNESS_LLM_KEYS_PATH;
  }
});
