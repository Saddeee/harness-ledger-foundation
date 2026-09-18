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

/** no ÷ (yes + no) from a judged run's verdicts; null when nothing was
 * decided. Runs recorded without verdicts fall back to their score. */
function decidedNoShare(verdictsJson: string | null, score: number): number | null {
  if (!verdictsJson) return score;
  let verdicts: unknown;
  try {
    verdicts = JSON.parse(verdictsJson);
  } catch {
    return score;
  }
  if (!Array.isArray(verdicts)) return score;
  const no = verdicts.filter((v) => v === "no").length;
  const yes = verdicts.filter((v) => v === "yes").length;
  return yes + no === 0 ? null : no / (yes + no);
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
 * otherwise -- unless Settings › Evidence has the "observed" source turned
 * off, in which case a correction never counts as hurt. With the "AI
 * adherence check" source on (Round 5 Task 7 / spec §5 item 3), a `broke`
 * rule_adherence row inside the same window adds one more hurt (at most
 * once per episode, whatever the source -- an episode already scored hurt
 * by the tag-based scan is left alone), and a `followed` row adds one more
 * applicable/helped when its episode wasn't already counted by the
 * tag-based scan. With the "user verdicts" source on (Round 5 fix wave item
 * 1 / spec §5.2), the rule's own latest whole-rule verdict
 * (store.latestRuleVerdict) adds one more hurt when it is "review"
 * and was recorded after this same window started -- a "helped" verdict
 * contributes nothing here (its snooze is a carried-forward stored field,
 * not a count); this is what makes a verdict's hurt bump durable across a
 * recompute, instead of a caller writing it straight into the stored row
 * only for the next recompute to overwrite it. contradicted_by_rule_id
 * (written elsewhere, by the miner) and snoozed_until (a human "Keep"
 * decision, Task C2) are carried forward from whatever rule_health already
 * has for the rule rather than recomputed here -- this function only ever
 * produces the four count/date fields and the status they imply.
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

  // Round 5 Task 7 / spec §5 "which count": read once for the whole
  // recompute, not per rule -- the user's own choice of which evidence
  // sources feed retirement doesn't change mid-run. Only gates what counts
  // towards applicable_tasks/hurt/helped (and therefore `status`) below;
  // the raw rows themselves (rule_adherence, rule_verdicts) are always kept
  // and always shown elsewhere, so turning a source off here hides nothing,
  // it only stops it from being able to trigger a retirement suggestion.
  const sources = store.getEvidenceSources();

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
    const episodeById = new Map(episodes.map((e) => [e.id, e]));

    let applicableTasks = 0;
    let helped = 0;
    let hurt = 0;
    let lastApplicableAt: string | null = null;
    // Episodes already reflected in applicableTasks via the tag-based scan
    // above -- an adherence "followed" row for one of these must not add a
    // second "build without a repeat" for the same episode below.
    const countedApplicable = new Set<number>();
    // Fix round 1 item 1: episodes already counted as hurt, from ANY source
    // -- a `broke` adherence row for an episode the tag-scan already scored
    // hurt (a matching correction) must not add a second hurt for the same
    // episode.
    const countedHurt = new Set<number>();

    for (const episode of episodes) {
      if (!isApplicable(episode.tags, rule.scope_tags)) continue;
      applicableTasks += 1;
      countedApplicable.add(episode.id);
      if (!lastApplicableAt || episode.started_at > lastApplicableAt) {
        lastApplicableAt = episode.started_at;
      }
      // spec §5 "which count": with the observed source off, a repeat
      // correction is still visible in the raw rule_adherence/history data,
      // but it no longer counts as hurt here.
      const wasHurt =
        sources.observed &&
        episode.corrections.some((c) =>
          matchesFailure(c.summary, rule.failure_signature, rule.prediction),
        );
      if (wasHurt) {
        hurt += 1;
        countedHurt.add(episode.id);
      } else {
        helped += 1;
      }
    }

    // spec §5 item 3: with the AI adherence check enabled, a `broke` row
    // inside this same window counts as one more hurt signal for
    // retirement -- but at most once per episode, whatever the source (Fix
    // round 1 item 1): an episode already scored hurt by the tag-based scan
    // above is left alone. A `broke` row for an episode the tag-based scan
    // didn't already count as applicable (mirrors the `followed` case
    // below) adds one applicable_tasks too. A `followed` row counts as one
    // more "build without a repeat" only for an episode the tag-based scan
    // above didn't already count (the judge, unlike isApplicable, can find
    // a build applicable that the scope-tag heuristic missed).
    if (sources.adherence) {
      const adherenceRows = store
        .listRuleAdherence(rule.id)
        .filter((a) => episodeById.has(a.task_episode_id));
      for (const row of adherenceRows) {
        if (row.verdict === "broke") {
          if (!countedApplicable.has(row.task_episode_id)) {
            const episode = episodeById.get(row.task_episode_id)!;
            applicableTasks += 1;
            countedApplicable.add(row.task_episode_id);
            if (!lastApplicableAt || episode.started_at > lastApplicableAt) {
              lastApplicableAt = episode.started_at;
            }
          }
          if (!countedHurt.has(row.task_episode_id)) {
            hurt += 1;
            countedHurt.add(row.task_episode_id);
          }
        } else if (row.verdict === "followed" && !countedApplicable.has(row.task_episode_id)) {
          const episode = episodeById.get(row.task_episode_id)!;
          applicableTasks += 1;
          helped += 1;
          countedApplicable.add(row.task_episode_id);
          if (!lastApplicableAt || episode.started_at > lastApplicableAt) {
            lastApplicableAt = episode.started_at;
          }
        }
      }
    }

    // Round 5 fix wave item 1 / spec §5.2: a whole-rule verdict from the
    // Instructions page's verdict buttons is a derived input too -- only
    // the latest one for this rule counts, only "review" adds
    // anything (a "helped" verdict's effect is the carried-forward
    // snoozed_until below, not a count), only when Settings › Evidence has
    // the "user verdicts" source on, and only when it was recorded after
    // this rule's own episode window started (the same `start` the episode
    // scan above uses) -- a verdict left over from before a "Re-add" must
    // not carry into the rule's new life, same reasoning as windowStart
    // above. There's no episode behind a verdict, so unlike a `broke`
    // adherence row this can't unconditionally add one to
    // applicable_tasks; it adds one only if that's what it takes to keep
    // hurt <= applicable_tasks.
    if (sources.verdicts) {
      const verdict = store.latestRuleVerdict(rule.id);
      if (
        verdict &&
        verdict.verdict === "review" &&
        new Date(verdict.created_at).getTime() > new Date(start).getTime()
      ) {
        hurt += 1;
        if (hurt > applicableTasks) {
          applicableTasks += 1;
        }
      }
    }

    // Round 6 Task 6b / spec §6: with the "paired test" source on, every
    // judged run for this rule inside the same window (by its own judged_at,
    // not an episode's started_at -- a paired test replays the rule's own
    // ORIGINAL, historical request, which predates the rule's write; it is
    // not one of the `episodes` the tag-based scan above walks, so there is
    // no episode to de-duplicate against here) counts once: score >= 0.5 is
    // one build without a repeat (helped), score === 0 is one hurt. A score
    // strictly between 0 and 0.5 -- some but not most corrections still
    // needed -- counts towards neither: a middling result is not confident
    // evidence either way (the same "evidence, not proof" spirit as the
    // rest of this module). Re-testing the same rule twice is two distinct
    // data points, so there is no cap of one per rule the way an episode-
    // keyed source caps at one per episode.
    if (sources.paired) {
      const startMs = new Date(start).getTime();
      for (const run of store.listExperimentRuns({ rule_id: rule.id, status: ["judged"] })) {
        if (run.score == null || !run.judged_at) continue;
        if (new Date(run.judged_at).getTime() <= startMs) continue;
        // Share of DECIDED corrections that are no longer needed: "Unclear"
        // is no evidence either way, so a run judged all-unclear counts for
        // nothing (score alone divides by every correction and read as 0).
        const share = decidedNoShare(run.verdicts_json, run.score);
        if (share == null) continue;
        if (share >= 0.5) {
          applicableTasks += 1;
          helped += 1;
          if (!lastApplicableAt || run.judged_at > lastApplicableAt)
            lastApplicableAt = run.judged_at;
        } else if (share === 0) {
          applicableTasks += 1;
          hurt += 1;
          if (!lastApplicableAt || run.judged_at > lastApplicableAt)
            lastApplicableAt = run.judged_at;
        }
      }
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
