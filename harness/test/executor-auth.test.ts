import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { redact } from "../src/executor/redact.ts";

const tmp = mkdtempSync(join(tmpdir(), "harness-auth-"));
process.env.HARNESS_AUTH_PATH = join(tmp, "lovable-auth.json");

const { FileOAuthProvider, authFilePath, status, LOVABLE_MCP_URL, REDIRECT_PORT } = await import(
  "../src/executor/lovable-auth.ts"
);

test("redact: replaces each pattern type and counts", () => {
  const cases: [string, string][] = [
    ["sk-abcdefghij1234567890", "key"],
    ["lov_abcdefghij-1234_5678", "key"],
    ["ghp_abcdefghij1234567890ABCD", "key"],
    ["AKIAABCDEFGHIJKLMNOP", "key"],
    ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk", "jwt"],
    ["-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----", "pem"],
    ["someone@example.com", "email"],
  ];
  for (const [secret, type] of cases) {
    const out = redact(`before ${secret} after`);
    assert.equal(out.count, 1, `expected one redaction for ${type}`);
    assert.equal(out.text, `before [redacted:${type}] after`);
  }
});

test("redact: counts multiple occurrences and leaves clean text alone", () => {
  const out = redact("a@b.com and c@d.org");
  assert.equal(out.count, 2);
  assert.equal(out.text, "[redacted:email] and [redacted:email]");
  const clean = redact("nothing secret here");
  assert.equal(clean.count, 0);
  assert.equal(clean.text, "nothing secret here");
});

test("constants and client metadata", () => {
  assert.equal(LOVABLE_MCP_URL, "https://mcp.lovable.dev/");
  assert.equal(REDIRECT_PORT, 8765);
  const p = new FileOAuthProvider(join(tmp, "meta.json"), () => {});
  assert.deepEqual(p.clientMetadata.redirect_uris, ["http://127.0.0.1:8765/callback"]);
  assert.equal(p.clientMetadata.token_endpoint_auth_method, "none");
  assert.equal(p.redirectUrl, "http://127.0.0.1:8765/callback");
  assert.deepEqual(p.clientMetadata.grant_types, ["authorization_code", "refresh_token"]);
});

test("FileOAuthProvider round-trips client, tokens and verifier with mode 0600", async () => {
  const file = join(tmp, "roundtrip.json");
  const p = new FileOAuthProvider(file, () => {});
  assert.equal(await p.clientInformation(), undefined);
  assert.equal(await p.tokens(), undefined);

  await p.saveClientInformation({ client_id: "cid-1", client_secret: undefined } as never);
  await p.saveTokens({ access_token: "at-1", token_type: "Bearer", refresh_token: "rt-1", expires_in: 3600 });
  await p.saveCodeVerifier("verifier-123");

  assert.equal((await p.clientInformation())?.client_id, "cid-1");
  assert.equal((await p.tokens())?.access_token, "at-1");
  assert.equal(await p.codeVerifier(), "verifier-123");

  assert.equal(statSync(file).mode & 0o777, 0o600);

  // a fresh provider reads the same persisted state
  const p2 = new FileOAuthProvider(file, () => {});
  assert.equal((await p2.tokens())?.refresh_token, "rt-1");

  await p2.invalidateCredentials("tokens");
  assert.equal(await p2.tokens(), undefined);
  assert.equal((await p2.clientInformation())?.client_id, "cid-1");

  await p2.invalidateCredentials("all");
  assert.equal(await p2.clientInformation(), undefined);
});

test("status(): not connected when the file is absent", () => {
  rmSync(authFilePath(), { force: true });
  const s = status();
  assert.equal(s.connected, false);
  assert.equal(s.email, null);
  assert.deepEqual(s.workspaces, []);
  assert.equal(s.expires_at, null);
});

test("status(): connected with email after a tokens+me fixture", () => {
  const expires = Date.now() + 3600_000;
  writeFileSync(
    authFilePath(),
    JSON.stringify({
      tokens: { access_token: "at", token_type: "Bearer", expires_in: 3600 },
      tokens_saved_at: expires - 3600_000,
      me: { email: "u@example.com", name: "U", workspaces: [{ id: "w1", name: "Work" }] },
    }),
    { mode: 0o600 },
  );
  const s = status();
  assert.equal(s.connected, true);
  assert.equal(s.email, "u@example.com");
  assert.deepEqual(s.workspaces, [{ id: "w1", name: "Work" }]);
  assert.ok(s.expires_at && !Number.isNaN(Date.parse(s.expires_at)));
  rmSync(authFilePath(), { force: true });
});

test("authFilePath honours HARNESS_AUTH_PATH", () => {
  assert.equal(authFilePath(), join(tmp, "lovable-auth.json"));
});
