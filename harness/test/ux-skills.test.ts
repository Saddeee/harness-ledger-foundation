// Checkpoint 2026-09-18 WP4 (D4): structural pins for Skills as a
// first-class destination -- the DestinationChoice component exists on the
// suggestion detail, the WP4 labels are real exported constants with the
// required values, SKILL_NOT_IN_LOVABLE_LINE is actually rendered on both
// the Skills page and the suggestion detail, and nowhere claims a Skill was
// created or updated in Lovable. Kept in its own file (per the brief) rather
// than appended to ux-round3-pages.test.ts, which other work is editing
// concurrently -- same lightweight, dependency-free source-text-pin pattern
// as that file and ux.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ux = await import("../../src/lib/harness-ux.ts");

function readApp(rel: string): string {
  return readFileSync(new URL(`../../src/${rel}`, import.meta.url), "utf8");
}
function codeOnly(source: string): string {
  return source
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return (
        !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*") && !t.startsWith("{/*")
      );
    })
    .join("\n");
}

const SKILLS_PAGE = "routes/_authenticated/skills.tsx";
const DETAIL = "components/harness/improvement.tsx";

// ---- 1. Labels exist with the required values ----

test("harness-ux.ts: WP4 destination labels exist with the exact required strings", () => {
  assert.equal(ux.DESTINATION_RECOMMENDED, "Recommended destination");
  assert.equal(ux.DESTINATION_WHY, "Why");
  assert.equal(ux.DESTINATION_ALTERNATIVE, "Alternative");
  assert.equal(ux.DESTINATION_CHANGE, "Change destination");
  assert.deepEqual(ux.CONTENT_DESTINATION_LABELS, {
    knowledge: "Knowledge",
    skill: "Skill",
    both: "Knowledge + Skill",
  });
  // Checkpoint 3 S1: updated with intent -- publishing a Skill is wired now
  // (create only), so the line no longer says "not wired".
  assert.equal(
    ux.SKILL_NOT_IN_LOVABLE_LINE,
    "Not in Lovable yet: Harness Ledger keeps this Skill locally with its versions until you publish it. Publishing only ever creates a new Skill in Lovable — it is never updated or deleted, including by Harness Ledger itself.",
  );
  assert.equal(
    ux.SKILL_OWNED_BY_USER_LINE,
    "This Skill is yours; Harness Ledger does not change user-owned Skills.",
  );
});

test("harness-ux.ts: the generic destination reasons match the brief, one per destination value", () => {
  assert.deepEqual(ux.CONTENT_DESTINATION_REASON_DEFAULT, {
    knowledge: "A short standing preference that should be available on every relevant request.",
    skill: "A multi-step procedure that applies only to one kind of task.",
    both: "A short reminder in Knowledge that points to the detailed procedure in a Skill.",
  });
  assert.equal(
    ux.contentDestinationReason("skill", null),
    ux.CONTENT_DESTINATION_REASON_DEFAULT.skill,
  );
  assert.equal(ux.contentDestinationReason("skill", "a real reason"), "a real reason");
});

// ---- 2. SkillProposalPanel exists and is rendered on the suggestion detail ----
// Round 8 Task 4 (review item 6): rewritten with intent -- DestinationChoice
// (the "Why Knowledge or Skill" card: a recommended-destination heading, the
// Why/Alternative sentences, and its own Change-destination radiogroup) is
// gone. Its Why/Alternative sentences moved into the collapsed "Why Harness
// Ledger recommends this" details; the Change-destination control moved to
// the decision card's "Saves to" line (reusing the existing
// ChangeDestinationControl); the Skill draft itself (name, content,
// Edit/Approve/Retire/Publish) is what's left, renamed SkillProposalPanel,
// still rendered directly under that "Saves to" line.

test("improvement.tsx: SkillProposalPanel exists and is rendered on the suggestion detail", () => {
  const code = codeOnly(readApp(DETAIL));
  assert.match(code, /function SkillProposalPanel\(/);
  assert.match(code, /<SkillProposalPanel item={item} busy={busy} run={run} \/>/);
  // The three destination options live on the shared ChangeDestinationControl now.
  assert.match(code, /\(\["knowledge", "skill", "both"\] as const\)\.map\(/);
  assert.match(code, /action: "set_content_destination"/);
  assert.match(code, /action: "edit_skill_proposal"/);
  assert.match(code, /action: "approve_skill_proposal"/);
  assert.match(code, /action: "retire_skill_proposal"/);
});

// ---- 3. SKILL_NOT_IN_LOVABLE_LINE is actually rendered, not just imported
// ----
// Checkpoint 2 2-C: rewritten with intent -- the Skills page's proposal
// cards now show the shorter SKILL_NOT_PUBLISHED_LINE ("Not published to
// Lovable yet.") instead; SKILL_NOT_IN_LOVABLE_LINE stays exactly where it
// was on the suggestion detail's DestinationChoice (improvement.tsx, 2-B's
// file, untouched by this checkpoint).

test("SKILL_NOT_IN_LOVABLE_LINE is imported and rendered on improvement.tsx", () => {
  const raw = readApp(DETAIL);
  assert.match(raw, /SKILL_NOT_IN_LOVABLE_LINE/, `${DETAIL} imports SKILL_NOT_IN_LOVABLE_LINE`);
  assert.match(
    raw,
    /\{SKILL_NOT_IN_LOVABLE_LINE\}/,
    `${DETAIL} renders {SKILL_NOT_IN_LOVABLE_LINE} in JSX`,
  );
});

test("skills.tsx: every proposal card renders the exact 'Not published to Lovable yet.' line", () => {
  const raw = readApp(SKILLS_PAGE);
  assert.match(raw, /SKILL_NOT_PUBLISHED_LINE/, `${SKILLS_PAGE} imports SKILL_NOT_PUBLISHED_LINE`);
  assert.match(
    raw,
    /\{SKILL_NOT_PUBLISHED_LINE\}/,
    `${SKILLS_PAGE} renders {SKILL_NOT_PUBLISHED_LINE} in JSX`,
  );
  assert.equal(ux.SKILL_NOT_PUBLISHED_LINE, "Not published to Lovable yet.");
});

// ---- 4. Honesty: nowhere claims a Skill was created or updated in Lovable ----

test("no page claims a Skill was created, updated, or enabled in Lovable", () => {
  for (const page of [SKILLS_PAGE, DETAIL]) {
    // codeOnly, not raw: a comment explaining the INTENT ("never claims X")
    // is not itself a user-facing claim -- only code (JSX/strings) counts.
    const code = codeOnly(readApp(page));
    assert.ok(!/created in Lovable/i.test(code), `${page} must not say "created in Lovable"`);
    assert.ok(!/updated in Lovable/i.test(code), `${page} must not say "updated in Lovable"`);
    assert.ok(!/enabled in Lovable/i.test(code), `${page} must not say "enabled in Lovable"`);
  }
});

// ---- 5. skills.tsx: "In Lovable" (unchanged data) before "Proposed by
// Harness Ledger" (local proposals) ----
// Checkpoint 2 2-C: rewritten with intent -- the order flips from WP4's
// "proposals first" to "what's real in Lovable first, drafts second", and
// the old "In your workspace" heading is renamed "In Lovable".

test("skills.tsx: 'In Lovable' section, above 'Proposed by Harness Ledger'", () => {
  const raw = readApp(SKILLS_PAGE);
  const code = codeOnly(raw);
  assert.ok(raw.includes("In Lovable"));
  assert.ok(raw.includes("Proposed by Harness Ledger"));
  assert.ok(!code.includes("In your workspace"), "renamed to 'In Lovable'");
  const workspaceAt = raw.indexOf("In Lovable");
  const proposedAt = raw.indexOf("Proposed by Harness Ledger");
  assert.ok(workspaceAt >= 0 && proposedAt >= 0 && workspaceAt < proposedAt);
  // Checkpoint 3 S1: updated with intent -- Harness Ledger can now publish
  // an approved proposal, so the line says so (still never an update/delete).
  assert.ok(
    raw.includes(
      "Harness Ledger reads your workspace Skills, and can publish an approved proposal as a new one; it never updates or deletes a Skill.",
    ),
  );
  assert.match(code, /proposal\.correction_candidate_id/);
  assert.match(code, /to="\/ledger"/);
});

// ---- 6. skills.tsx: each proposal card's own fields ----

test("skills.tsx: each proposal card shows purpose, when it applies, a procedure preview, the source correction, and 'Review Skill'", () => {
  const code = codeOnly(readApp(SKILLS_PAGE));
  assert.match(code, /skillProposalPurpose\(/);
  assert.match(code, /skillProposalAppliesWhen\(/);
  assert.match(code, /skillProposalProcedurePreview\(/);
  assert.match(code, /proposal\.correction_summary/);
  assert.match(code, />\s*\{REVIEW_SKILL_LABEL\}\s*</, "Review Skill is rendered as JSX text");
});
