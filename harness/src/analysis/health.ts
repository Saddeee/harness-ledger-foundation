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

// Spec §4b signal 1: a correction "matches" a rule's failure when its
// summary is the same failure signature (kebab-case compare) or is similar
// enough, by bigram Dice, to the rule's predicted failure text.
function matchesFailure(
  correctionSummary: string,
  failureSignature: string,
  prediction: string,
): boolean {
  if (!correctionSummary) return false;
  if (failureSignature && toKebabCase(correctionSummary) === toKebabCase(failureSignature))
    return true;
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

    const episodes = store.listEpisodesAfter(
      rule.scope === "project" ? rule.project_id : null,
      rule.first_written_at,
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

    const existing = store.getRuleHealth(rule.id);
    const contradictedByRuleId = existing?.contradicted_by_rule_id ?? null;
    const snoozedUntil = existing?.snoozed_until ?? null;

    const referenceDate = lastApplicableAt ?? rule.first_written_at;
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
