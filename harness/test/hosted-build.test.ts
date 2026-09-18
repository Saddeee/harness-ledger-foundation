// Checkpoint 2 2-F: a structural proof that the hosted (Cloudflare/Nitro)
// build of src/ never pulls in better-sqlite3 or harness/src directly --
// SPEC.md §12's own "on the hosted deployment better-sqlite3 cannot run at
// all" claim, and src/lib/server/harness-runtime.ts's own header comment
// (this file's own doc comment above loadHarnessAdapter). Every path this
// file inspects lives under the root app (src/, and .output/ if it has been
// built locally); nothing here touches harness/data/ or opens a database --
// it only reads source text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SRC_DIR = join(REPO_ROOT, "src");
const OUTPUT_DIR = join(REPO_ROOT, ".output");

/** Every `.ts`/`.tsx` file under `dir`, recursively -- plain `readdirSync`
 * with Node 22's own `recursive` option (this repo requires Node >= 22.12,
 * package.json's own engines field), no third-party glob dependency needed
 * for a read-only structural test. */
function listSourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && /\.tsx?$/.test(e.name))
    .map((e) => join(e.parentPath ?? dir, e.name));
}

const SRC_FILES = listSourceFiles(SRC_DIR);

test("hosted build: at least one TS/TSX file exists under src/ (this test is not silently vacuous)", () => {
  assert.ok(
    SRC_FILES.length > 10,
    `expected many source files under ${SRC_DIR}, found ${SRC_FILES.length}`,
  );
});

test("hosted build: no file under src/ statically imports better-sqlite3", () => {
  const offenders = SRC_FILES.filter((f) =>
    /from\s+["']better-sqlite3["']/.test(readFileSync(f, "utf8")),
  );
  assert.deepEqual(
    offenders,
    [],
    `these files statically import better-sqlite3: ${offenders.join(", ")}`,
  );
});

test("hosted build: no file under src/ statically imports harness/src directly", () => {
  const pattern = /from\s+["'](?:\.\.\/)+harness\/src\//;
  const offenders = SRC_FILES.filter((f) => pattern.test(readFileSync(f, "utf8")));
  assert.deepEqual(
    offenders,
    [],
    `these files statically import harness/src directly: ${offenders.join(", ")}`,
  );
});

test("hosted build: harness-runtime.ts loads harness/dist only through a dynamic import guarded by HARNESS_RUNTIME", () => {
  const path = join(SRC_DIR, "lib", "server", "harness-runtime.ts");
  const source = readFileSync(path, "utf8");

  // No static import of harness/dist anywhere in this file -- every access
  // must go through the dynamic import() calls guarded below.
  assert.ok(
    !/^import[^;]*from\s+["'][^"']*harness\/dist/m.test(source),
    "harness-runtime.ts must not statically import harness/dist",
  );

  const dynamicImports = [
    ...source.matchAll(/import\(\s*(?:\/\*[^*]*\*\/\s*)?["']([^"']*harness\/dist[^"']*)["']/g),
  ];
  assert.ok(
    dynamicImports.length > 0,
    "harness-runtime.ts should dynamically import harness/dist somewhere",
  );

  // Guarded: every such dynamic import is reached only after a check of
  // process.env["HARNESS_RUNTIME"] (or process.env.HARNESS_RUNTIME) earlier
  // in the same function -- checked loosely (the guard and the import need
  // not be on the same line, see loadHarnessAdapter/loadHarnessExecutor's
  // own early-return shape), rather than by re-deriving each function's
  // control flow here.
  assert.ok(
    /process\.env(?:\.HARNESS_RUNTIME|\["HARNESS_RUNTIME"\])\s*!==\s*["']local["']/.test(source),
    "harness-runtime.ts should gate its dynamic imports on HARNESS_RUNTIME === 'local'",
  );
});

test("hosted build: no file under src/ hardcodes the local DB path -- it must come from env", () => {
  const offenders = SRC_FILES.filter((f) =>
    readFileSync(f, "utf8").includes("harness/data/harness.db"),
  );
  assert.deepEqual(
    offenders,
    [],
    `these files hardcode harness/data/harness.db: ${offenders.join(", ")}`,
  );
});

// ---- .output/ (a locally-built hosted bundle, if one exists on disk) ----
//
// Not built by this test (a real hosted build costs a Nitro/Vite pass this
// suite must not trigger) -- if the directory is absent, these two checks
// are skipped with a note rather than failing or silently passing.

function listAllFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath ?? dir, e.name));
}

test("hosted build: .output/ (if present) never bundles better-sqlite3 or the local DB path", (t) => {
  if (!existsSync(OUTPUT_DIR)) {
    t.skip(`${OUTPUT_DIR} does not exist -- run a hosted build first to exercise this check`);
    return;
  }
  const files = listAllFiles(OUTPUT_DIR);
  const sqliteOffenders: string[] = [];
  const dbPathOffenders: string[] = [];
  for (const f of files) {
    let text: string;
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue; // binary/unreadable file -- not a text bundle to grep.
    }
    if (text.includes("better-sqlite3")) sqliteOffenders.push(f);
    if (text.includes("harness/data/harness.db")) dbPathOffenders.push(f);
  }
  assert.deepEqual(
    sqliteOffenders,
    [],
    `.output/ files mentioning better-sqlite3: ${sqliteOffenders.join(", ")}`,
  );
  assert.deepEqual(
    dbPathOffenders,
    [],
    `.output/ files mentioning harness/data/harness.db: ${dbPathOffenders.join(", ")}`,
  );
});
