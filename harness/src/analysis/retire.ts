// Round 4 Task C2 / spec §4b: turns a `rule_health` row in status
// 'retire_suggested' into a human-reviewed retirement proposal (an Inbox
// item, via improvements.ts's listImprovements). Pure data-layer glue --
// no LLM call, no Lovable access. Called at the end of every executor run,
// right after health.ts's recomputeRuleHealth (see executor/beats.ts
// runAll), so proposals stay current without their own schedule.
import * as store from "../store.js";
import { hurtCorrectionHistoryItemIds } from "./health.js";

const HURT_EVIDENCE_LIMIT = 5;

/**
 * One proposal per rule currently in status 'retire_suggested' that doesn't
 * already have an open proposal -- idempotent: a second call with no change
 * in rule_health creates none. Reason is 'hurt' when the rule hurt more
 * than it helped, else 'contradiction' when a live rule contradicts it,
 * else 'unused'. Evidence is the hurt episodes' correction history_item ids
 * (up to 5) for 'hurt', the contradicting rule's id for 'contradiction', or
 * empty for 'unused'.
 */
export function proposeRetirements(): { created: number } {
  let created = 0;

  for (const health of store.listRuleHealth()) {
    if (health.status !== "retire_suggested") continue;
    if (store.openRetireProposalForRule(health.rule_id)) continue;

    const reason: store.RetireReason =
      health.hurt > health.helped
        ? "hurt"
        : health.contradicted_by_rule_id != null
          ? "contradiction"
          : "unused";

    const evidence =
      reason === "hurt"
        ? hurtCorrectionHistoryItemIds(health.rule_id, HURT_EVIDENCE_LIMIT)
        : reason === "contradiction" && health.contradicted_by_rule_id != null
          ? [health.contradicted_by_rule_id]
          : [];

    store.createRetireProposal({ rule_id: health.rule_id, reason, evidence });
    created += 1;
  }

  return { created };
}
