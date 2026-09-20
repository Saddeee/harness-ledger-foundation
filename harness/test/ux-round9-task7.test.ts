// Round 9 Task 7 (2026-09-20) / spec §2 vocabulary: the leak detector for
// every retired word Rounds 1-9 have banned from Harness Ledger's UI copy.
// Scans every string/template literal in src/**/*.tsx and src/lib/*.ts
// (skipping comments -- codeOnly strips them, same convention as
// ux-naming.test.ts's "bare Harness" check and ux-round9-task5.test.ts's
// readApp/codeOnly/slice helpers) for:
//
//   - the banned phrases: "Judge replay", "Review rule", "View details",
//     "See on Tests", "See the comparison", "Remove from Knowledge",
//     "Historical replay", "Your verdict is needed", "New instruction"
//   - "Not sure" as a button label (allowed only inside
//     VERDICT_CHOICE_LABELS -- that one constant's slice is skipped)
//   - "Workspace" as a bare chip/label word (allowed inside the explanatory
//     sub-line "...workspace Knowledge..."; the one place src/ compares a
//     literal "Workspace" against a raw contract value -- improvement.tsx's
//     inboxLinkHref, matching harness/src/improvements.ts's own
//     inboxTargetProject -- is allowlisted below by exact literal + file)
//   - "replay" and "paired", case-insensitive, anywhere in a literal
//     (substring, not just whole-word -- catches "replays" too); allowed in
//     identifiers and comments only, per an explicit allowlist of the
//     internal action names/type discriminants that legitimately carry
//     these words as literal values mirroring a backend contract (never
//     rendered as copy)
//   - "rule"/"rules", whole word, case-insensitive (controller addition):
//     the vocabulary sweep's own primary target -- "instruction" is the one
//     word for the object everywhere in UI copy
//
// Two files are out of this sweep's word/phrase-substring bans (documented
// in the Task 7 report, not just here):
//   - src/lib/capabilities-copy.ts is excluded entirely: it is a literal,
//     byte-for-byte mirror of harness/src/capabilities.ts, asserted equal
//     by harness/test/capabilities.test.ts's own deep-equal check, and is
//     not rendered by any route (grep confirms no src/routes/**/*.tsx
//     imports it) -- editing its copy would require an equal edit to
//     harness/src, which this task's global constraints forbid.
//   - src/lib/landing-copy.ts is checked for the specific banned PHRASES
//     only (controller ruling): it is marketing/feature-description prose
//     for an out-of-scope page (spec §6), not the app's own button/state
//     vocabulary, and may still describe the "historical replay"/"paired
//     comparison" evidence levels by their real names.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL("../..", import.meta.url)));

const CAPABILITIES_COPY = join("src", "lib", "capabilities-copy.ts");
const LANDING_COPY = join("src", "lib", "landing-copy.ts");

function tsxFiles(dir: string): string[] {
  const full = join(ROOT, dir);
  return readdirSync(full, { withFileTypes: true }).flatMap((e) => {
    const rel = join(dir, e.name);
    if (e.isDirectory()) return tsxFiles(rel);
    return /\.tsx$/.test(e.name) ? [rel] : [];
  });
}
function libTsFiles(dir: string): string[] {
  const full = join(ROOT, dir);
  return readdirSync(full, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.ts$/.test(e.name))
    .map((e) => join(dir, e.name));
}

// src/**/*.tsx (recursive) + src/lib/*.ts (direct children only -- NOT
// src/lib/server/**, server-side infrastructure with no rendered copy).
const TARGET_FILES: string[] = [...tsxFiles("src"), ...libTsFiles("src/lib")].filter(
  (rel) => rel !== CAPABILITIES_COPY,
);

// Strip block comments ({/* */} and /* */) to blank (preserving newlines,
// so line numbers stay accurate) and blank out // line-comment lines --
// same approach as ux-naming.test.ts, extended to keep line numbers exact.
function codeOnly(source: string): string {
  let s = source.replace(/\{\/\*[\s\S]*?\*\/\}/g, (m) => m.replace(/[^\n]/g, " "));
  s = s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return s
    .split("\n")
    .map((l) => (l.trim().startsWith("//") ? "" : l))
    .join("\n");
}

// Every string/template/single-quote literal on a line, with a template
// literal's ${...} interpolation expressions blanked out first -- those are
// code (identifiers, property access), never copy, and must never be
// matched (e.g. `${ranSuffix(s.paired)}` is not the word "paired" as text).
function literalsOnLine(line: string): string[] {
  const withoutInterpolation = line.replace(/\$\{[^}]*\}/g, "");
  return withoutInterpolation.match(/"[^"\n]*"|`[^`\n]*`|'[^'\n]*'/g) ?? [];
}

const PHRASE_BANS = [
  "Judge replay",
  "Review rule",
  "View details",
  "See on Tests",
  "See the comparison",
  "Remove from Knowledge",
  "Historical replay",
  "Your verdict is needed",
  "New instruction",
];

// landing-copy.ts's own narrower phrase list (controller ruling): only
// phrases that literally name a button/label that no longer exists in the
// app. "Historical replay" is NOT one of these -- it is landing-copy.ts's
// own honest name for a real evidence level/capability, still true today,
// not a retired button.
const LANDING_PHRASE_BANS = [
  "Judge replay",
  "Review rule",
  "View details",
  "Remove from Knowledge",
  "See on Tests",
  "Not sure",
];

// Exact literal values (the full quoted content, unquoted) that are
// internal identifiers/type discriminants or backend-contract values --
// never rendered as copy -- carrying "rule(s)"/"replay"/"paired" as their
// spelling. Each is named for a reason below; every one was verified by
// grep to have no .tsx caller rendering it as text (see the Task 7 report).
const ALLOWED_EXACT_LITERALS = new Set<string>([
  // InboxActionKind / OverviewActionKind discriminants (switch-case keys
  // and function-argument literals; the rendered text they select comes
  // from a separate label map, never from the discriminant itself).
  "retire",
  "rule_attention",
  "review_rule",
  "judge_replay",
  // LlmRole discriminant -- matches harness/src/llm/types.ts's own LlmRole
  // union and harness/src/store.ts's role keys exactly; renaming it here
  // without an equal harness/src change would break the settings contract.
  "rule_writer",
  // The judge.tsx delete_copy action's `which` value -- matches the zod
  // enum in harness/src/executor/experiments-actions.ts exactly.
  "with_rule",
  // ExperimentKindLike / ExperimentKind / AnalysisStage type-union members
  // -- mirror harness/src/executor/replay-environment.ts's ExperimentKind
  // and harness/src/analysis/run.ts's own progress("rules", ...) stage tag.
  "historical_replay",
  "paired_comparison",
  "rules",
  // EvidenceSources.paired's own DOM id (Settings > Evidence) -- matches
  // harness/src/store.ts's EVIDENCE_SOURCE_KEYS field name exactly; the
  // rendered <Label> text next to it was renamed to "Test results".
  "evidence-paired",
]);

// A short list of (file, exact-literal) pairs, for a literal that is only
// safe in one specific place -- unlike the codebase-wide identifiers above.
const ALLOWED_LITERALS_BY_FILE = new Set<string>([
  // improvement.tsx's inboxLinkHref compares item.project_name against the
  // raw contract value harness/src/improvements.ts's inboxTargetProject
  // actually sends for a workspace-scoped item ("Workspace", not "workspace"
  // or null) -- a data comparison, not copy; the rendered header text right
  // below it was changed to show "All my projects" instead.
  `${join("src", "components", "harness", "improvement.tsx")}::Workspace`,
]);

function isAllowedRuleOrReplayLiteral(file: string, literalText: string): boolean {
  if (ALLOWED_EXACT_LITERALS.has(literalText)) return true;
  return ALLOWED_LITERALS_BY_FILE.has(`${file}::${literalText}`);
}

test("vocabulary sweep: no retired-word string literal in src/**/*.tsx or src/lib/*.ts", () => {
  const offenders: string[] = [];

  for (const rel of TARGET_FILES) {
    const raw = readFileSync(join(ROOT, rel), "utf8");
    const code = codeOnly(raw);

    // "Not sure" as a button label is allowed only inside
    // VERDICT_CHOICE_LABELS -- skip that one constant's slice (a single
    // object literal) by blanking its extent before scanning the rest of
    // the file. Every other file has no such constant, so this is a no-op
    // there.
    const vclStart = code.indexOf("export const VERDICT_CHOICE_LABELS");
    let scanCode = code;
    if (vclStart >= 0) {
      const vclEnd = code.indexOf("};", vclStart);
      const blankedSlice = code
        .slice(vclStart, vclEnd + 2)
        .split("\n")
        .map((l) => l.replace(/[^\n]/g, " "))
        .join("\n");
      scanCode = code.slice(0, vclStart) + blankedSlice + code.slice(vclEnd + 2);
    }

    const lines = scanCode.split("\n");
    lines.forEach((line, i) => {
      const literals = literalsOnLine(line);
      for (const lit of literals) {
        const inner = lit.slice(1, -1);

        // landing-copy.ts (controller ruling): only the narrower phrase
        // list applies -- no "Not sure"/"Workspace" contextual checks, no
        // rule/replay/paired word+substring bans. Everything else gets the
        // full set below.
        if (rel === LANDING_COPY) {
          for (const phrase of LANDING_PHRASE_BANS) {
            if (inner.includes(phrase)) {
              offenders.push(`${rel}:${i + 1}: [landing phrase "${phrase}"] ${lit}`);
            }
          }
          continue;
        }

        // Phrase bans: exact substrings, case-sensitive (these are all
        // fixed-case button/label copy).
        for (const phrase of PHRASE_BANS) {
          if (inner.includes(phrase)) {
            offenders.push(`${rel}:${i + 1}: [phrase "${phrase}"] ${lit}`);
          }
        }

        // "Not sure" as a button label (outside VERDICT_CHOICE_LABELS,
        // already blanked above).
        if (inner.includes("Not sure")) {
          offenders.push(`${rel}:${i + 1}: [phrase "Not sure"] ${lit}`);
        }

        // "Workspace" as a bare chip/label word -- allowed inside the
        // explanatory sub-line "...workspace Knowledge..." (lowercase
        // "workspace" there, so a bare-word/exact match on "Workspace"
        // never fires for it), and at the one allowlisted file+literal
        // above.
        if (inner === "Workspace" && !isAllowedRuleOrReplayLiteral(rel, inner)) {
          offenders.push(`${rel}:${i + 1}: [bare "Workspace" chip/label] ${lit}`);
        }

        if (isAllowedRuleOrReplayLiteral(rel, inner)) continue;

        if (/\brules?\b/i.test(inner)) {
          offenders.push(`${rel}:${i + 1}: [rule/rules] ${lit}`);
        }
        if (/replay/i.test(inner)) {
          offenders.push(`${rel}:${i + 1}: [replay] ${lit}`);
        }
        if (/paired/i.test(inner)) {
          offenders.push(`${rel}:${i + 1}: [paired] ${lit}`);
        }
      }
    });
  }

  assert.deepEqual(offenders, [], `retired words in copy:\n${offenders.join("\n")}`);
});
