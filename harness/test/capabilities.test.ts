// Pins the machine-readable capability manifest: every id is unique, every "working" capability
// is honestly backed by a test file or a live-observation note with a date, every verification
// that names a repo file actually exists on disk, statuses come only from the enum, and the
// web app's mirror (src/lib/capabilities-copy.ts) never drifts from the harness source of truth
// (harness/src/capabilities.ts). See harness/src/capabilities.ts for the shape and rationale.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../");

const harnessModule = await import("../src/capabilities.ts");
const webModule = await import("../../src/lib/capabilities-copy.ts");

const { CAPABILITIES, capabilitiesByStatus, capabilityLabel } = harnessModule;

const STATUSES = ["working", "partial", "planned", "blocked"] as const;
const RUNTIMES = ["local", "hosted", "both"] as const;

// A verification string may reference more than one thing, joined with "; " or embedded in a
// sentence (e.g. "harness/test/executor.test.ts; live write, Round 7 (2026-09-13)"). Pull out
// anything that looks like a repo-relative file path with a known extension -- optionally
// followed by " §<anchor>" (e.g. "DECISIONS.md §D3") -- and check that the file part exists.
const FILE_REFERENCE = /[A-Za-z0-9_./-]+\.(?:ts|tsx|md|mjs|js|json)(?=[\s;,.)]|$)/g;

function fileReferencesIn(verification: string): string[] {
  return verification.match(FILE_REFERENCE) ?? [];
}

test("every capability id is unique", () => {
  const ids = CAPABILITIES.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate id among: ${ids.join(", ")}`);
});

test("statuses and runtimes only use the documented enum values", () => {
  for (const c of CAPABILITIES) {
    assert.ok(
      (STATUSES as readonly string[]).includes(c.status),
      `${c.id}: unknown status "${c.status}"`,
    );
    assert.ok(
      (RUNTIMES as readonly string[]).includes(c.runtime),
      `${c.id}: unknown runtime "${c.runtime}"`,
    );
  }
});

test("every working capability has a non-null verification and verified_at", () => {
  for (const c of CAPABILITIES) {
    if (c.status !== "working") continue;
    assert.notEqual(c.verification, null, `${c.id}: working but verification is null`);
    assert.notEqual(c.verified_at, null, `${c.id}: working but verified_at is null`);
  }
});

test("verified_at, when present, is an ISO date", () => {
  for (const c of CAPABILITIES) {
    if (c.verified_at === null) continue;
    assert.match(
      c.verified_at,
      /^\d{4}-\d{2}-\d{2}$/,
      `${c.id}: verified_at "${c.verified_at}" is not an ISO date`,
    );
  }
});

test("every file named in a verification string exists on disk", () => {
  // Collect every missing reference before failing, so one red assertion lists everything wrong
  // rather than stopping at the first capability -- useful when another in-flight work package
  // hasn't yet added the file a capability here already points to.
  const missing: string[] = [];
  for (const c of CAPABILITIES) {
    if (c.verification === null) continue;
    for (const ref of fileReferencesIn(c.verification)) {
      // Allow "VERIFICATION.md §..." / "DECISIONS.md §..." style anchors: only the path before
      // " §" (already excluded by the regex's lookahead) needs to resolve.
      const path = resolve(repoRoot, ref);
      if (!existsSync(path)) {
        missing.push(`${c.id}: verification references "${ref}", which does not exist at ${path}`);
      }
    }
  }
  assert.deepEqual(missing, [], missing.join("\n"));
});

test("no label or limitation uses banned wording", () => {
  // "Harness " on its own (not "Harness Ledger") is a naming-rule violation; the other three are
  // banned copy words for this checkpoint (never "paired test", "proof", "helped").
  const bannedBareHarness = /Harness (?!Ledger)/;
  const bannedPhrases = [/paired test/i, /proof/i, /\bhelped\b/i];
  for (const c of CAPABILITIES) {
    for (const field of ["label", "limitation"] as const) {
      const text = c[field];
      assert.ok(
        !bannedBareHarness.test(text),
        `${c.id}.${field}: "Harness " must be followed by "Ledger": "${text}"`,
      );
      for (const phrase of bannedPhrases) {
        assert.ok(!phrase.test(text), `${c.id}.${field}: banned wording in "${text}"`);
      }
    }
  }
});

test("capabilitiesByStatus filters correctly", () => {
  for (const status of STATUSES) {
    const filtered = capabilitiesByStatus(status);
    assert.ok(filtered.every((c) => c.status === status));
    assert.equal(filtered.length, CAPABILITIES.filter((c) => c.status === status).length);
  }
});

test("capabilityLabel looks up a known id and returns undefined for an unknown one", () => {
  const first = CAPABILITIES[0]!;
  assert.equal(capabilityLabel(first.id), first.label);
  assert.equal(capabilityLabel("does_not_exist"), undefined);
});

test("the web app's capabilities mirror deep-equals the harness source of truth", () => {
  assert.deepEqual(
    webModule.CAPABILITIES,
    CAPABILITIES,
    "src/lib/capabilities-copy.ts has drifted from harness/src/capabilities.ts -- copy the array literally",
  );
});
