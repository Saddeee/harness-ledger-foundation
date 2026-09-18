import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Checkpoint 2: the product is always "Harness Ledger" in anything a person
// reads. This scans string and template literals in the web app's copy and
// pages and in the harness modules that produce user-facing text, and fails
// on a bare "Harness" (the legacy managed-block heading constant is the one
// allowed exception, kept so old blocks are still recognised).
const ROOT = join(fileURLToPath(new URL("../..", import.meta.url)));
const TARGETS = [
  "src/lib",
  "src/routes",
  "src/components/harness",
  "harness/src/improvements.ts",
  "harness/src/mcp-server.ts",
  "harness/src/executor/experiments.ts",
  "harness/src/executor/beats.ts",
  "harness/src/analysis",
];

function files(path: string): string[] {
  const full = join(ROOT, path);
  if (statSync(full).isFile()) return [full];
  return readdirSync(full, { withFileTypes: true }).flatMap((e) => {
    const p = join(path, e.name);
    if (e.isDirectory()) return files(p);
    return /\.(ts|tsx)$/.test(e.name) ? [join(ROOT, p)] : [];
  });
}

test("user-facing strings never say a bare 'Harness'", () => {
  const offenders: string[] = [];
  for (const file of TARGETS.flatMap(files)) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
      if (line.includes("LEGACY_HEADINGS") || line.includes("managed by Harness (edit")) return;
      const literals = line.match(/"[^"\n]*"|`[^`\n]*`|'[^'\n]*'/g) ?? [];
      for (const lit of literals) {
        if (/\bHarness(?! Ledger)(?![-_:])\b/.test(lit)) {
          offenders.push(`${file.replace(ROOT, "")}:${i + 1}: ${lit}`);
        }
      }
    });
  }
  assert.deepEqual(offenders, [], `bare "Harness" in copy:\n${offenders.join("\n")}`);
});
