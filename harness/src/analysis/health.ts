// Round 4 Task C1 / spec §4b: outcome tracking for live rules, computed
// entirely from real task episodes and their classified corrections -- no
// LLM call here (the classifier that produced message_classifications ran
// separately, in the analysis pipeline). This module is a thin, pure-ish
// aggregation layer over store.ts reads; its only side effect is
// store.upsertRuleHealth, once per live rule with a written Knowledge
// version. Called at the end of every executor run (executor/beats.ts
// runAll) and, later, every analysis run.
import * as store from "../store.js";
import { dice } from "./similarity.js";

const DICE_HURT_THRESHOLD = 0.7;
const MIN_APPLICABLE_FOR_RETIRE = 3;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// A rule's failure_signature is written kebab-case by the miner (Task A2);
// a correction's summary is free text from the classifier. Normalising both
// the same way before comparing means "Design System Bypassed" and
// "design-system-bypassed" read as the same signature.
function toKebabCase(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isApplicable(episodeTags: string[], scopeTags: string[]): boolean {
  if (scopeTags.includes("general")) return true;
  return episodeTags.some((t) => scopeTags.includes(t));
}

// Round 4 fix wave item 4: the episode window start is the later of
// first_written_at (when the rule first landed in Knowledge) and
// baseline_at (when it was last "Re-add"ed, store.rebaselineRuleHealth) --
// a rule that hurt before being retired and re-added must not have those
// old episodes counted against it again once it's live again.
function windowStart(firstWrittenAt: string, baselineAt: string | null): string {
  if (!baselineAt) return firstWrittenAt;
  return new Date(baselineAt).getTime() > new Date(firstWrittenAt).getTime()
    ? baselineAt
    : firstWrittenAt;
}

// Spec §4b signal 1: a correction "matches" a rule's failure when its
// summary is the same failure signature (kebab-case compare), or its slug is
// similar enough -- by bigram Dice -- to the failure signature, or the raw
// summary is similar enough to the rule's predicted failure text.
//
// A real classifier summary is prose ("You used inline colors instead of
// the design tokens again."), never literally equal to a kebab-case slug
// like "inline-colors-instead-of-design-tokens" -- the exact-equality
// shortcut below is a cheap fast path (also covers a human-edited summary
// that happens to already be the slug), but the slug-vs-signature Dice
// comparison is what actually matches real prose against a rule's failure
// signature.
function matchesFailure(
  correctionSummary: string,
  failureSignature: string,
  prediction: string,
): boolean {
  if (!correctionSummary) return false;
  if (failureSignature) {
    const summarySlug = toKebabCase(correctionSummary);
    const signatureSlug = toKebabCase(failureSignature);
    if (summarySlug === signatureSlug) return true;
    if (dice(summarySlug, signatureSlug) >= DICE_HURT_THRESHOLD) return true;
  }
  if (!prediction) return false;
  return dice(correctionSummary, prediction) >= DICE_HURT_THRESHOLD;
}

/**
 * Recomputes rule_health for every live rule that has a written Knowledge
 * version (store.listLiveRulesWithTargets already excludes rules with none
 * -- they have no "since added" baseline). For each rule: episodes started
 * after its first written_at, in its own project for a project-scoped rule
 * or across every project for a workspace-scoped one; an episode is
 * "applicable" when its classified tags overlap the rule's scope tags, or
 * the rule is tagged "general"; each applicable episode counts as "hurt" if
 * it has a matching correction (matchesFailure above) or "helped"
 * otherwise. contradicted_by_rule_id (written elsewhere, by the miner) and
 * snoozed_until (a human "Keep" decision, Task C2) are carried forward from
 * whatever rule_health already has for the rule rather than recomputed
 * here -- this function only ever produces the four count/date fields and
 * the status they imply.
 *
 * Status: `retire_suggested` when applicable_tasks >= 3 and hurt > helped,
 * or the rule is contradicted, or it is unused (its last applicable episode
 * -- or, with none, its first write -- is older than the
 * rule_unused_after_days setting); `snoozed` instead of retire_suggested
 * while a prior snooze is still in effect; `watch` when at least one
 * episode hurt it but retirement isn't (yet) suggested; `healthy` otherwise.
 */
export function recomputeRuleHealth(now: Date = new Date()): { rules: number; suggested: number } {
  const unusedAfterDays = Number(store.getSetting("rule_unused_after_days"));
  const rules = store.listLiveRulesWithTargets();
  let suggested = 0;

  for (const rule of rules) {
    if (!rule.first_written_at) continue; // defensive; listLiveRulesWithTargets already filters these out

    // Fetched before the episode window so a baseline set by a "Re-add"
    // (store.rebaselineRuleHealth) can move where that window starts --
    // see windowStart above.
    const existing = store.getRuleHealth(rule.id);
    const start = windowStart(rule.first_written_at, existing?.baseline_at ?? null);
    const episodes = store.listEpisodesAfter(
      rule.scope === "project" ? rule.project_id : null,
      start,
    );

    let applicableTasks = 0;
    let helped = 0;
    let hurt = 0;
    let lastApplicableAt: string | null = null;

    for (const episode of episodes) {
      if (!isApplicable(episode.tags, rule.scope_tags)) continue;
      applicableTasks += 1;
      if (!lastApplicableAt || episode.started_at > lastApplicableAt) {
        lastApplicableAt = episode.started_at;
      }
      const wasHurt = episode.corrections.some((c) =>
        matchesFailure(c.summary, rule.failure_signature, rule.prediction),
      );
      if (wasHurt) hurt += 1;
      else helped += 1;
    }

    const contradictedByRuleId = existing?.contradicted_by_rule_id ?? null;
    const snoozedUntil = existing?.snoozed_until ?? null;

    // Falls back to `start` (not the rule's original first_written_at) so a
    // just-re-added rule with no applicable episodes yet is measured against
    // its new baseline, not flagged "unused" off a stale pre-retirement date.
    const referenceDate = lastApplicableAt ?? start;
    const daysSinceReference = (now.getTime() - new Date(referenceDate).getTime()) / MS_PER_DAY;
    const unused = daysSinceReference > unusedAfterDays;
    const unusedSince = unused ? referenceDate : null;

    const isSnoozed = snoozedUntil != null && new Date(snoozedUntil).getTime() > now.getTime();
    const shouldRetire =
      (applicableTasks >= MIN_APPLICABLE_FOR_RETIRE && hurt > helped) ||
      contradictedByRuleId != null ||
      unused;

    let status: store.RuleHealthStatus;
    if (shouldRetire) {
      status = isSnoozed ? "snoozed" : "retire_suggested";
    } else if (hurt >= 1) {
      status = "watch";
    } else {
      status = "healthy";
    }
    if (status === "retire_suggested") suggested += 1;

    store.upsertRuleHealth({
      rule_id: rule.id,
      applicable_tasks: applicableTasks,
      helped,
      hurt,
      last_applicable_at: lastApplicableAt,
      contradicted_by_rule_id: contradictedByRuleId,
      unused_since: unusedSince,
      status,
      snoozed_until: snoozedUntil,
    });
  }

  return { rules: rules.length, suggested };
}

/**
 * Task C2: the correction history_item ids that counted as "hurt" for one
 * rule, under this module's own applicability/match rules -- oldest first,
 * capped at `limit`. Used as evidence on a retirement proposal with reason
 * 'hurt' (harness/src/analysis/retire.ts). Returns [] for a rule that isn't
 * live with a written Knowledge version (listLiveRulesWithTargets excludes
 * it) or that has no hurt corrections.
 */
export function hurtCorrectionHistoryItemIds(ruleId: number, limit = 5): number[] {
  const rule = store.listLiveRulesWithTargets().find((r) => r.id === ruleId);
  if (!rule || !rule.first_written_at) return [];

  // Same windowStart as recomputeRuleHealth (item 4): a re-added rule's
  // evidence for a NEW retirement proposal must not resurface corrections
  // from before it was last re-added.
  const baselineAt = store.getRuleHealth(ruleId)?.baseline_at ?? null;
  const episodes = store.listEpisodesAfter(
    rule.scope === "project" ? rule.project_id : null,
    windowStart(rule.first_written_at, baselineAt),
  );

  const ids: number[] = [];
  for (const episode of episodes) {
    if (!isApplicable(episode.tags, rule.scope_tags)) continue;
    for (const correction of episode.corrections) {
      if (matchesFailure(correction.summary, rule.failure_signature, rule.prediction)) {
        ids.push(correction.history_item_id);
        if (ids.length >= limit) return ids;
      }
    }
  }
  return ids;
}
