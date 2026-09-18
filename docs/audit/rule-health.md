# Rule health / retirement — observation and retirement audit

Checkpoint 2026-09-18. Read-only audit; no `mcp__lovable__*` / `mcp__harness__*` calls made, no LLM calls made,
no files touched outside `docs/audit/`. DB inspected via `node -e` against
`harness/data/harness.db` with `better-sqlite3` `{readonly: true}`.

Status labels used below follow `docs/audit/README.md`.

---

## 1. Exact current derivation of every health number and status

Source: `harness/src/analysis/health.ts`, function `recomputeRuleHealth` (health.ts:125-335). Status: **verified** (traced in code, confirmed against live DB rows below).

For each live rule (`store.listLiveRulesWithTargets()`, state `'active'` with at least one written Knowledge
version — `harness/src/store.ts:2448-2499`):

1. **Window start** (health.ts:54-59, `windowStart`): `max(rule.first_written_at, rule_health.baseline_at)`.
   `first_written_at` is the earliest `'written'` `knowledge_versions` row for the rule
   (store.ts:2443-2459). `baseline_at` is set only by `store.rebaselineRuleHealth` on a "Re-add"
   (`harness/src/improvements.ts:1545`).

2. **Tag-based scan** (health.ts:167-188): every episode in the window (project-scoped: same project;
   workspace-scoped: every project — `store.listEpisodesAfter`, store.ts:2517-2579) whose classified
   tags overlap the rule's `scope_tags` (or the rule is tagged `general`) is `applicable_tasks += 1`.
   Its "hurt" status is decided by `matchesFailure` (health.ts:73-87): does it have a `message_classifications`
   row of `classification = 'correction'` (store.ts:2541-2547 — **note: `new_task`-classified messages are
   never corrections here, regardless of content**) whose kebab-cased summary matches the rule's
   `verification_plans.failure_signature` (Dice ≥ 0.7) or whose raw summary matches the rule's
   `predicted_failure` text (Dice ≥ 0.7, health.ts:12,73-87)? If yes: `hurt += 1`. If no (including "no
   correction-classified message exists at all for this episode"): `helped += 1`.
   `applicable_tasks`, `helped` and `hurt` from this step are **mutually exclusive per episode** — but only
   within this one step.

3. **Adherence (Judge) contribution**, gated by `evidence_sources.adherence` (health.ts:200-228): for every
   `rule_adherence` row for this rule inside the window, a `broke` verdict adds `hurt += 1` **unless the same
   episode already has `countedHurt`** (health.ts:214, dedup against step 2's hurt only) — it does **not**
   check whether the episode was already counted `helped` in step 2. A `followed` verdict adds
   `applicable_tasks += 1, helped += 1` only if the episode wasn't already counted applicable in step 2.
   **This is the source of the double-count**: an episode step 2 scored `helped` (no matching correction)
   can independently receive `hurt += 1` here from a `broke` Judge verdict, with no corresponding decrement
   to `helped`. `harness/test/rule-health.test.ts:461-493` pins this as *intentional*: its own comment reads
   "no correction matched, so the tag-based scan still counts it as a build without a repeat" (helped=1) then
   "the broke adherence row adds one more hurt on top of that" (hurt=1) for the *same* episode.

4. **Verdict contribution**, gated by `evidence_sources.verdicts` (health.ts:243-255): the rule's latest
   `rule_verdicts` row, if `did_not_help` and recorded after the window start, adds `hurt += 1` and,
   only if that pushes `hurt > applicable_tasks`, `applicable_tasks += 1` too. A `helped` verdict adds
   nothing here (its only effect is the `snoozed_until` bump in `improvements.ts:2103-2117`, a UI/inbox
   effect, not a health-math one).

5. **Paired-test contribution**, gated by `evidence_sources.paired` (health.ts:270-292): every `judged`
   `experiment_runs` row for the rule with `judged_at` after the window start counts once by its own
   "decided share of no verdicts" (health.ts:35-47, `decidedNoShare`): share ≥ 0.5 → `applicable_tasks += 1,
   helped += 1`; share === 0 → `applicable_tasks += 1, hurt += 1`; 0 < share < 0.5 or all-"unclear" → neither.

6. **Status** (health.ts:294-319):
   - `unused_since` = the later of `last_applicable_at` or window start, if now is more than
     `rule_unused_after_days` (setting default `"60"`, store.ts:1480) days after it; else null.
   - `shouldRetire` = `(applicable_tasks >= 3 AND hurt > helped)` OR `contradicted_by_rule_id != null`
     OR `unused`.
   - `status` = `retire_suggested` (or `snoozed` if a live snooze exists) when `shouldRetire`; else `watch`
     when `hurt >= 1`; else `healthy`.
   - `contradicted_by_rule_id` and `snoozed_until` are never computed here — carried forward from the
     existing row (health.ts:294-295) — written elsewhere: `contradicted_by_rule_id` by
     `harness/src/analysis/propose.ts:283-321` (`recordContradiction`, a **rule-vs-rule** contradiction found
     by the rule-writer/miner when proposing a new rule); `snoozed_until` by `store.snoozeRuleHealth`
     (Keep, `improvements.ts:1340`) or by `recordVerdict`'s "helped while retire_suggested" branch
     (`improvements.ts:2103-2117`).

### What the Judge actually sees (adherence.ts) — no screenshots, no diffs

`judgeSystemPrompt` (`harness/src/analysis/adherence.ts:33`) tells the model it is given "the rule, the
user's original request for this build, and Lovable's reply to the user (**the human-visible reply only,
not its internal tool calls or file diffs**)." The Judge never sees a screenshot or a code diff — it
answers `followed`/`broke`/`not_applicable` from chat text alone, with a verbatim quote from that same
reply as its only cited evidence (`validateQuote`, adherence.ts:63-72, rejects any quote that isn't a
literal substring of the reply). This is a **different** mechanism from the paired-test experiment runs
(`experiment_runs.copy_screenshot_url`/`original_screenshot_url`/`copy_diff_json`/`original_diff_json`,
`harness/src/migrations.ts:669-671,756-757`) — those screenshots/diffs exist, but they are shown to the
**human owner** on the `/judge` screen for a manual yes/no/unclear call per correction (`improvements.ts`'s
`judgeRun`), not to any LLM. So: the per-build Judge that feeds `rule_health.hurt` (§1 step 3, gated by
`evidence_sources.adherence`) is text-only by design; the one evidence source with screenshots/diffs
(paired tests, §1 step 5) is judged by a person, is off by default (`evidence_sources.paired = false`),
and is unrelated to the Judge role.

### What `helped`/`hurt` mean today

`rule_health.helped` and `rule_health.hurt` are **not** a partition of `applicable_tasks` into two
mutually-exclusive buckets, and are **not** "how many builds did/didn't need a repeat correction" in any
single, consistent sense. They are four independently-gated counters (free tag/correction scan, AI Judge,
human verdict, paired test) added into two running totals with only *some* pairwise dedup (an episode's
`hurt` can only be double-counted once across sources — `countedHurt` — and `applicable_tasks` likewise via
`countedApplicable` — but there is **no `countedHelped` set**, so the same episode can land in both
`helped` and `hurt`). `shouldRetire` reads `hurt > helped` as if they were opposites; per the DB evidence
below they frequently are not.

### Live DB confirmation: rule 24 (`applicable_tasks=3, helped=3, hurt=3`)

Rule 24 (`rules.id=24`, `harness/data/harness.db`): "Write all UI text in this app … in sentence case …",
project scope, `state='active'`, `scope_tags_json=["copy","styling","components"]`,
first written 2026-09-13 19:16:48 (`knowledge_versions.id=37`, `verified_at`). `rule_health` row:
`baseline_at=null` so window start = `2026-09-13 19:16:48`.

Three episodes in-window, in-project, tag-overlapping:

| episode | started_at | classification of its user message | tags | matches rule 24 in tag-scan? |
|---|---|---|---|---|
| 41 | 23:03:19 | `new_task` ("add a currency line") | copy, general | not a correction row at all → **helped** |
| 42 | 23:03:44 | `correction` ("reverses locale Sweden→Germany, kronor→euros") | i18n, copy | is a correction, but its summary Dice-matches rule 24's own `failure_signature` ("lowercase-ui-text", `verification_plans.id=5`) or `predicted_failure` at far below 0.7 → **helped** |
| 43 | 23:04:35 | `new_task` ("I want all UI text lowercase … replacing sentence case") | copy, styling | not a correction row at all (classifier called it `new_task`, even though it is the literal opposite of rule 24) → **helped** |

Tag-scan alone: `applicable_tasks=3, helped=3, hurt=0`.

`rule_adherence` rows for rule 24 (all from `run_id=11`, the AI Judge pass), all three `broke`, quoting
Lovable's own reply verbatim each time: *"All the text is lowercase now, and I'll keep it that way …"*
(episodes 41, 42) and *"All the text is lowercase now, and I'll keep it that way"* (episode 43) — the Judge
correctly found the rule broken in **all 3** builds by reading Lovable's actual reply. Since all three
episodes were already `countedApplicable` (from the tag scan) but **not** `countedHurt` (the tag scan put
them in `helped`), step 3 adds `hurt += 1` for each, three times, with no `applicable_tasks` change (already
counted) and no reduction to `helped`.

Final: `applicable_tasks=3` (from step 2 only), `helped=3` (from step 2 only — never revisited), `hurt=3`
(entirely from step 3, the AI Judge — **zero of the 3 hurt-counts came from the free "observed" corrections
signal** in this case, because the classifier tagged episodes 41 and 43 `new_task` rather than `correction`,
and episode 42's real correction was about currency/locale, not case). This matches the live row exactly
(`rule_health.rule_id=24: applicable_tasks=3, helped=3, hurt=3, status='watch'`). `status` is `watch`, not
`retire_suggested`, purely because `hurt (3)` is not *strictly greater than* `helped (3)` — a tie reads as
"healthy enough," even though the AI Judge says the rule was broken in 100% of the builds it judged.

`rule_health.snoozed_until = 2026-10-13T23:14:28.264Z` on this same row comes from a `retire_proposals`
row (`id=2, rule_id=24, reason='changed_mind', evidence_json='[99]', status='kept', decided_at
2026-09-13 23:14:28`) — history_item 99 is episode 43's own message ("I've decided I want all UI text in
this app in lowercase … replacing sentence case going forward"), a **textbook explicit, permanent,
in-writing reversal of the rule's own subject** — and the user's decision on that proposal was **Keep**.
(Contrast: rule 22's own `changed_mind` proposal, evidence history_item 101, "this app is for Germany now,
not Sweden … euros from now on," was **Retired**.) Both are handled by the exact same generic
`changed_mind` mechanism (§4 below) with no distinction in how "obviously permanent" the contradiction is.

### Other live rows (for the doc's own worked examples)

- Rule 1 ("no recurring background work by default"): `applicable_tasks=0, helped=0, hurt=0, status='healthy'`,
  `baseline_at` set, no episodes in-window yet — a genuinely quiet rule, not evidence of anything either way.
- Rule 22 (the Swedish-kronor rule, now `rules.state='rolled_back'`): `applicable_tasks=5, helped=5, hurt=1,
  status='watch'`. Its one `rule_adherence` "broke" (episode 41, "Every amount now shows in euros… euros will
  be used from now on") is the same episode that later became its `changed_mind` retirement (episode 42's
  message, evidence [101]) — this rule *was* actually retired.
- Rule 23 ("Reset restores every field"), workspace scope, `state='retired'`: `rule_health` row shows all
  zeros, `status='healthy'` — it was retired manually (Instructions page "Retire" button) with **no**
  observed/adherence/verdict evidence behind it at all; `rule_health` never reflects *why* a rule that looks
  "healthy" was retired, because manual retire bypasses `rule_health`/`retire_proposals` reasoning entirely
  (`improvements.ts`'s `retireRule`, called directly from the Instructions page's per-rule button,
  `src/routes/_authenticated/instructions.tsx:226`).

---

## 2. Mapping from current fields to the required separate signals

Required (per the task brief): applicability · instruction availability (was the rule live at build time) ·
explicit reference · behavioural compliance · predicted issue observed · repeated correction · human
acceptance · usefulness decision · historical replay evidence (paired test against history) ·
paired-comparison evidence (side-by-side test).

| Required signal | Exists today? | Where | Conflated with |
|---|---|---|---|
| Applicability (was this build in the rule's scope at all) | Partial | `isApplicable` tag-overlap (health.ts:28-31) *or* an adherence row for an episode outside the tag scan (health.ts:206-213); a rule can also be "applicable" purely because a **verdict** or **paired-test run** existed (health.ts:251-254, 281,286) with no episode behind it at all | Folded straight into `applicable_tasks`, indistinguishable by source once written |
| Instruction availability (was the rule live/written in Lovable's Knowledge at the time of that build) | Yes, but only as the window boundary | `first_written_at`/`baseline_at` (health.ts:54-59) gate which episodes are even considered | Not tracked per-episode as its own fact; it's a filter, not a stored field, so it can't be displayed ("this rule wasn't live yet for build X") |
| Explicit reference (did the user or Lovable literally name the rule) | **No** | — | Not represented anywhere; `rule_adherence.quote` is closest but it's the Judge's chosen supporting quote, not evidence of a reference |
| Behavioural compliance (did the build actually follow the rule) | Yes, but only via the AI Judge | `rule_adherence.verdict` (`followed`/`broke`/`not_applicable`), `adherence.ts` | Rolled into `hurt`/`helped` as one more count (health.ts:200-228), same bucket as the unrelated "no correction seen" signal |
| Predicted issue observed (did the specific `predicted_failure` actually recur) | Yes, narrowly | `matchesFailure` (health.ts:73-87) inside the tag scan only | Indistinguishable, once counted, from an adherence "broke" or a verdict "did_not_help" — all become the same `hurt` integer |
| Repeated correction (the user corrected the *same* thing more than once) | Partial | `matchesFailure`'s Dice match against `predicted_failure`/`failure_signature` counts each matching episode once; there's no separate "count of repeats" surfaced — `hurt` conflates "1 repeat" and "N repeats" into episode-count | Same `hurt` bucket as everything else |
| Human acceptance (user pressed Accept on the rule) | Yes, cleanly | `correction_candidates.reviewed`, `rules.state` (`improvements.ts` decision block, improvements.ts:661-679) | Kept separate from health — good; not conflated |
| Usefulness decision ("is this rule still useful", Keep/Retire) | Only two-valued | `retire_proposals.status IN ('open','retired','kept')` (schema, `retire_proposals` CREATE TABLE) | Framed everywhere as "did this rule help" (verdict `helped`/`did_not_help`/`not_sure`, `rule_verdicts` CHECK) or "should this rule be retired" (Retire/Keep) — never "is this rule still useful" as its own question; see §3 |
| Historical replay evidence (paired test against a real past request) | Yes | `experiment_runs` (`status='judged'`), health.ts:270-292 | Its `score`/`decidedNoShare` bucketed straight into the same `helped`/`hurt` integers as everything else, no separate "N historical replays run, M sided with the rule" figure |
| Paired-comparison evidence (side-by-side original vs. with-rule) | Yes, and it's the richest data source (`experiment_runs` carries `copy_diff_json`, `original_diff_json`, `copy_screenshot_url`, `original_screenshot_url`, `copy_summary`, `original_summary`) | `experiment_runs` table (schema above); shown in the Tests/judging UI (`improvements.ts`'s `judgeRun`/`buildExperimentRunView`, not audited line-by-line here) | Only the resulting `score` feeds `rule_health`; the diffs/screenshots never reach `rule_health` or the Instructions page's health line at all |

**What exists, cleanly separated already:** the four *evidence sources* themselves are separately toggle-able
in Settings (`evidence_sources.{observed,adherence,verdicts,paired}`, store.ts:3584-3616,
`src/components/harness/local-settings.tsx:555-606`) and separately *visible* per-rule via
`ImprovementHealth.sources`/`adherence`/`verdict` (`improvements.ts:76-105, 386-434`) — i.e. the raw signals
are not literally destroyed. **What is conflated:** the moment any of them contributes to the *retirement
decision*, it collapses into exactly two integers (`helped`, `hurt`) with no per-source subtotal, no
per-episode "which signals fired" record, and no distinction between "this build never touched the rule's
subject" (`not_applicable`) and "no evidence was collected." The AI Judge's `not_applicable` verdicts (e.g.
rule 22, episodes 34 and 43) are silently dropped from every count — never applicable, never helped, never
hurt, never shown as "N builds this rule didn't apply to" anywhere in `rule_health`.

---

## 3. Exact copy strings today vs. required replacements

All confirmed by direct `grep`/read of `src/lib/harness-ux.ts` and `src/components/harness/improvement.tsx`;
pinned by the tests named in each row (also see §5).

| Location | Current copy (verbatim) | Required copy/behaviour | Status |
|---|---|---|---|
| `src/components/harness/improvement.tsx:733` | `"Harness Ledger suggests retiring this rule"` (RetireCard title, every reason) | Should ask **"Is this rule still useful?"**, not assert a recommendation up front | verified (causal framing, not a question) |
| `src/components/harness/improvement.tsx:750-759` | Buttons: **Retire** (`RetireConfirm`) / **Keep** — two choices | Should offer **Keep / Review / Retire / Not sure** — four choices | verified |
| `src/components/harness/improvement.tsx:818,834` | `aria-label="Did this rule help?"` and visible text `"Did this rule help?"`, choices Yes/No/Not sure (`VERDICT_CHOICES`, lines 778-782) | The task brief is explicit this is the wrong question: *"User question is 'Is this rule still useful?' … not 'Did this rule help?'"* | verified |
| `src/lib/harness-ux.ts:507` (`retireReasonSentence`, "hurt" branch) | `"Harness Ledger suggests retiring this rule because more of its builds had a repeat correction than didn't."` | Should read like the brief's example: **"Harness found the same issue in all 3 relevant builds."** (a plain repeat-count statement, no "more than" ratio framing, no verb "suggests" doing the concluding) | verified; pinned by `harness/test/ux-round5-evidence.test.ts:60-97` |
| `src/lib/harness-ux.ts:612-617` (`adherenceLine`) | `"Followed in ${followed} of ${total} builds it applied to · judged by AI, with quotes"` | Brief's required copy for the *not-followed* case: **"AI review marked the rule as not followed in 3 of 3 relevant builds."** — today's line always frames the count as "followed," even when `followed=0`, which for rule 24 renders as the slightly indirect "Followed in 0 of 3 builds it applied to …" rather than a direct "not followed in 3 of 3" statement | verified; pinned by `harness/test/ux-round5-evidence.test.ts:117-122` |
| `src/lib/harness-ux.ts:548-561` (`healthLine`) | `"Since added: ${N} builds in this area · ${M} repeat corrections${last} · observed from your real builds"` — this fixed suffix is used **regardless of which evidence sources actually produced `hurt`** | Should not claim "observed from your real builds" when some/all of `hurt` came from the AI Judge, a human verdict, or a paired test (see rule 24: `hurt=3`, **0** of which came from an observed repeat correction — all 3 came from the AI Judge) — this is exactly the "no causal inference from an absent/present failure" and "track separately" requirement, violated at the copy layer, not just the schema layer | verified (see §1's worked example and §6) |
| `src/lib/harness-ux.ts:491-508`/`517-528` (unused/contradiction reasons) | Unused: `"Harness Ledger suggests retiring this rule because it has not applied in 60 days."` Rendered through the exact same RetireCard (Retire/Keep) as a hurt-based suggestion | Brief: 60-day inactivity should produce **"Review for relevance"** with **Keep / Archive / Move to Skill / Retest / Retire** — a materially different, less final framing than "suggests retiring" | verified — no such branch exists anywhere in `improvement.tsx` or `harness-ux.ts`; `RetireCard` has one shape for all four `RetireReason` values |
| `src/lib/harness-ux.ts:594-596` (`VERDICT_EFFECT_TEXT`) | `counted_hurt: "Counted as one repeat correction in this rule's health"` | Consistent with §1's point 3/4 — a `did_not_help` *verdict* (a human, not an observed build) is worded as if it were an *observed* "repeat correction"; same source-blur as `healthLine`'s fixed suffix | verified |

No block anywhere reading **"Needs attention"** → **"Recommendation: rewrite this rule or turn it into a
Skill"** → **"Primary action: Review rule"** exists in the codebase (`grep -rn "Recommendation\|rewrite this
rule\|turn it into a Skill\|Primary action" src/` returns nothing). Today's closest equivalent is the
`watch` status (health.ts:314-318, `hurt >= 1` and not yet `retire_suggested`) — it has **no dedicated UI
copy at all**; `status` is read by `instructions.tsx`/`improvement.tsx` only to decide whether to show
`healthLine`/`adherenceLine`/the verdict control, never rendered as a labelled state ("Watch") or turned
into a specific recommendation.

**Naming collision to be aware of before implementing:** the literal string **"Needs attention" already
exists** as real, shipped UI copy today, for a completely different meaning. `IMPROVEMENT_GROUPS`
(`src/lib/harness-ux.ts:378-385`) includes a group literally named `"Needs attention"`, and
`improvementGroup` (harness-ux.ts:389-406, specifically :401) assigns an item to it purely from
`writeStatus === "stale" || writeStatus === "failed"` — i.e. "the Lovable Knowledge write failed or went
stale," never "the same issue recurred N times." The per-card status line reuses the same words:
`lovableStatusLine`'s `stale`/`failed` branches (harness-ux.ts:329-332) literally render `"Needs attention:
Knowledge changed in Lovable — review the text again"` and `"Needs attention: adding failed — see
Details"`. A new repeat-issue "Needs attention" block would either need different wording to avoid
colliding with this existing, unrelated meaning, or would need to fold write-failure and repeat-issue into
one shared group/label on purpose — a design decision, not just an implementation detail.

---

## 4. `changed_mind` today, and what contradiction-classification needs

**Today** (`harness/src/analysis/classify.ts:58-81, 200-210`): the classifier prompt (system prompt,
classify.ts:68) asks the model to list `contradicts_rule_ids` — "the message asks Lovable for the opposite of
one of them (the user changed their mind …)". The schema (`CLASSIFIER_JSON_SCHEMA`, classify.ts:41-52) is a
flat `{ classification, tags, summary, contradicts_rule_ids: number[] | null }` — a single boolean-ish signal
per rule id, no severity/kind field. `classifyPending` (classify.ts:200-210) turns **every** id in that array
into an **immediate** `retire_proposals` row with `reason: 'changed_mind'` (guarded only by "not already an
open proposal for this rule," `store.openRetireProposalForRule`) — there is no threshold, no distinction
between a one-off exception and a standing reversal, and no human-in-the-loop step before the proposal is
raised (only after, via Retire/Keep). This is a **second, entirely separate path** into `retire_proposals`
from `harness/src/analysis/retire.ts`'s own `proposeRetirements` (retire.ts:21-47), which only ever reasons
from `rule_health.status`. `classify.ts` writes `changed_mind` proposals directly, bypassing `rule_health`
and `recomputeRuleHealth` entirely — a `changed_mind` proposal can exist even for a rule whose `rule_health`
says `healthy`.

Confirmed live: rule 24's `changed_mind` proposal (evidence `[99]`, episode 43's message) is exactly the
brief's own example of a **genuine, explicit, permanent** reversal ("I've decided … replacing sentence case
going forward") and it was **kept**. Rule 22's (evidence `[101]`, "this app is for Germany now, not Sweden
… from now on") is the same shape and was **retired**. Nothing in the pipeline distinguishes these — both
are `changed_mind`, both get the identical RetireCard copy ("Harness Ledger suggests retiring this rule
because you asked Lovable for the opposite," `harness-ux.ts:498`), and the *classification* of the opposite
request (`one_task_exception` / `temporary_override` / `project_specific_override` /
`permanent_preference_change` / `genuine_contradiction` / `unclear`) does not exist as a concept anywhere in
the repo — confirmed by `grep -rn "one_task_exception\|temporary_override\|project_specific_override\|
permanent_preference_change\|genuine_contradiction" harness/src` returning nothing.

**What a real contradiction-classification would need:**

1. **Schema enum**: extend `CLASSIFIER_JSON_SCHEMA.properties.contradicts_rule_ids` from a bare
   `number[] | null` to an array of `{ rule_id: number, kind: "one_task_exception" | "temporary_override" |
   "project_specific_override" | "permanent_preference_change" | "genuine_contradiction" | "unclear" }`
   (classify.ts:50), and the matching `ValidatedClassifierOutput`/`validateClassifierOutput` type
   (classify.ts:117-144) to validate/clamp `kind` the same way `classification` is clamped today (unknown
   value → `"unclear"`, mirroring the existing "other" fallback pattern at classify.ts:132-134). Needs a
   migration adding a `kind` column (or a JSON column) to wherever this is persisted — today nothing persists
   it; it would need to ride along on the `retire_proposals` row (`evidence_json` already stores an
   arbitrary-shaped array, e.g. `[99]`, so it could become `[{history_item_id, kind}]` without a schema
   migration — a JSON-shape change only) or a new `retire_proposals.contradiction_kind` column (needs a
   migration, `harness/src/db.ts`/`migrations/` — not located precisely in this audit's time budget; grep
   `migrations` directory before implementing).
2. **Prompt change**: classify.ts's `classifierSystemPrompt` (classify.ts:58-81) needs the six-way
   distinction spelled out with examples for each `kind` (the current prompt's one example, "a rule says
   'use kronor' and the message says 'use euros from now on'," is itself a `permanent_preference_change`/
   `genuine_contradiction` example only — it never shows the model a one-off-exception example, which is
   presumably why the model has no way to signal one today).
3. **Gating**: `classifyPending`'s loop (classify.ts:200-210) must only call
   `store.createRetireProposal({ reason: "changed_mind", ... })` when `kind` is
   `"permanent_preference_change"` or `"genuine_contradiction"` — per the brief, "Only
   `permanent_preference_change` or `genuine_contradiction` should question a standing rule." Every other
   `kind` should record the flagged message somewhere (for audit/debugging) but must **not** open a
   `retire_proposals` row. This is the single behavioural change that would have prevented rule 24's
   proposal-that-got-kept from ever having been a *retirement* proposal in the first place if it had been
   classified `one_task_exception` — but note rule 24's own case is squarely a `permanent_preference_change`
   ("from now on"), so under the required gating it would *still* have opened a proposal; the gating change
   protects against a different failure mode (a one-off "just this once, use lowercase for this one page"
   message wrongly opening a standing-rule reversal proposal), not against this specific rule 24 example.

---

## 5. Smallest safe change set

Ordered smallest/lowest-risk first. Hour estimates are rough engineering-only estimates (no design/PM time),
assuming familiarity with this codebase's existing conventions (Zod schemas, `store.ts` prepared statements,
the copy-string convention in `harness-ux.ts`).

| # | Change | Files | Tests that currently pin the copy/behaviour being changed (must be updated in the same PR) | Est. |
|---|---|---|---|---|
| 1 | Rename the "Did this rule help?" verdict question and its aria-label to a usefulness framing (e.g. "Is this rule still useful?" with `helped→keep`-style relabeled choices) — copy-only, no schema change | `src/components/harness/improvement.tsx:778-782,818,834`; `src/lib/harness-ux.ts:568-572` (`VERDICT_TEXT`) | `harness/test/ux-round5-evidence.test.ts:162-176` (asserts the literal `aria-label="Did this rule help\?"` and Yes/No/Not sure labels) | 2-3h |
| 2 | Rewrite `healthLine`'s fixed suffix so it doesn't claim "observed from your real builds" when `hurt` includes non-observed contributions — requires `ImprovementHealth`/`HealthLike` to carry a per-source breakdown of `hurt` (e.g. `hurt_by_source: {observed, adherence, verdicts, paired}`), computed in `health.ts` alongside the existing totals (the four `hurt += 1` sites already know which source they're in — health.ts:183, 214, 250, 287 — so this is additive bookkeeping, not new logic) | `harness/src/analysis/health.ts` (recomputeRuleHealth), `harness/src/store.ts` (rule_health columns — **additive**: 4 new nullable INTEGER columns, or one JSON column, no migration of existing data needed since old rows can default to `hurt_observed = hurt` for backward compat), `harness/src/improvements.ts:386-434` (`computeHealth`), `src/lib/harness-ux.ts:548-561` (`healthLine`) | `harness/test/ux-round4-health.test.ts:42-82`, `harness/test/ux-round5-evidence.test.ts:34-55`, `harness/test/rule-health.test.ts` (many — any test asserting `hurt`/`helped` totals must still pass; this change is additive so should not break them) | 6-8h |
| 3 | Replace the two required exact status lines — "Harness found the same issue in all N relevant builds." (observed) and "AI review marked the rule as not followed in N of N relevant builds." (Judge) — as two new, separately-labelled functions in `harness-ux.ts`, used instead of / alongside `retireReasonSentence`'s "hurt" branch and `adherenceLine` | `src/lib/harness-ux.ts:507, 612-617`; call sites `src/components/harness/improvement.tsx` | `harness/test/ux-round5-evidence.test.ts:60-97` (retireReasonSentence/retireSinceLine "never say helped"), `:117-122` (adherenceLine exact string) — both need updating to the new exact strings, not just relaxing | 3-4h |
| 4 | Four-way Keep/Review/Retire/Not sure on `RetireCard`, replacing Retire/Keep — needs a new `retire_proposals.status` value (schema migration: `CHECK (status IN ('open','retired','kept'))` → add `'reviewing'`/`'unsure'`, `retire_proposals` CREATE TABLE) or, cheaper, keep `status` two-valued and add the extra choices as separate side-effects on top of `kept` (Review = keep + flag for follow-up; Not sure = keep + no snooze) — the cheaper option avoids a migration but loses the distinctness the brief asks for | `harness/src/store.ts` (schema/migration if going the real-enum route), `harness/src/improvements.ts` (`keepProposal`/`retireRule`, `improvements.ts:1336-1346`), `src/components/harness/improvement.tsx:701-763` (`RetireCard`), `src/lib/harness-ux.ts:496-529` | `harness/test/retire.test.ts` (status transitions), any inbox/instructions test asserting `retire`/`keep` action strings | 8-12h (schema route) / 3-4h (side-effect route, weaker fit to the requirement) |
| 5 | Separate "Review for relevance" framing + Keep/Archive/Move to Skill/Retest/Retire for the `unused` reason specifically (distinct from `hurt`/`contradiction`/`changed_mind`, which can keep the stronger "suggests retiring" framing) — a new `RetireCard` branch keyed on `retire.reason === 'unused'` | `src/components/harness/improvement.tsx:701-763`, `src/lib/harness-ux.ts:504-506,524-526`; "Archive"/"Move to Skill"/"Retest" are **new actions**, not renames — Move to Skill and Retest have no backing code today (Skills aren't wired into rule scope at all per `improvements.ts:1413-1416`'s explicit refusal; "Retest" would need to call the existing paired-test path, `experiments.ts`) | none yet (new feature) | Review-for-relevance copy + Keep/Archive: 4-6h. Move to Skill/Retest as real actions: substantially more (Skills-as-rule-destination doesn't exist; out of scope for a "smallest change set") |
| 6 | Contradiction-kind classification (§4) | `harness/src/analysis/classify.ts` (schema, prompt, `classifyPending` gating), `harness/src/store.ts` (new column/JSON shape on `retire_proposals` evidence or a new column) | `harness/test/analysis-adherence.test.ts` unaffected; check for a `classify.test.ts`/`classifier` test file (not in this audit's required-read list — **must be located and updated before shipping**, not verified here) | 6-10h (schema+prompt+gating), excludes prompt-quality iteration |
| 7 | Separate "helped"/"hurt" into the full required signal taxonomy (§2 table) as first-class, independently-displayed counts, rather than item 2's narrower "which source contributed to hurt" patch | `harness/src/analysis/health.ts`, `harness/src/store.ts` (real schema growth — new table or several new columns), `harness/src/improvements.ts`, `src/lib/harness-ux.ts`, every route in the required-read list | Every test in `harness/test/rule-health.test.ts`, `retire.test.ts`, `ux-round4-health.test.ts`, `ux-round5-evidence.test.ts` | 20h+ — this is the "do it properly" version of item 2; not "smallest," included for completeness since the brief's core ask is this separation |

**Recommended smallest safe slice for a first PR**: items 1 + 3 (pure copy, ~5-7h, tests are simple string
updates) and item 2 (the accuracy fix — `healthLine` currently makes a false provenance claim on real
production data, rule 24 being the proof) at ~6-8h. Items 4-7 are schema/behaviour changes that need their
own design pass and are not "smallest."

---

## 6. Anything claiming causality

- `src/lib/harness-ux.ts:107` (`WHY_TEXT.retire`, the Suggestions detail's "why this was proposed"
  paragraph for a retirement item) — *"Harness Ledger found a signal that this rule may be doing more harm
  than good. You can retire it, or keep it and be asked again later."* The hedge "may be" and "a signal"
  keep this short of an outright causal claim, but "doing more harm than good" is the most causally-loaded
  phrase found anywhere in the copy layer — worth rewording alongside the other retirement-reason copy in
  §3/§5, since (per §1) the "signal" behind it can be a tie (`hurt == helped`, no sentence fires) or a
  same-episode double-count (§1's `helped`/`hurt` overlap), not a clean "more harm than good" finding.
- `src/lib/harness-ux.ts:560` — `healthLine`'s `"… · observed from your real builds"` suffix asserts the
  `hurt` count was *observed*, i.e. seen happening in real builds, when (confirmed on rule 24, §1) the
  entirety of a rule's `hurt` count can instead come from an AI Judge's textual assessment of a reply, a
  human's one-off verdict click, or a paired-test replay against historical requests — none of which is "a
  real build in the wild going wrong," they're all after-the-fact or synthetic assessments of it. This isn't
  a subtle inference — it's a flat mislabel of the source, present on a live, real rule in the DB right now.
- `src/lib/harness-ux.ts:507` — `retireReasonSentence`'s "hurt" branch, `"…because more of its builds had a
  repeat correction than didn't"` — this is a factual claim about *counts* which is fine on its own, but
  because `helped`/`hurt` are not mutually exclusive (§1), "more … than didn't" is not actually a
  well-formed comparison: for rule 24 it would currently read as false (`hurt=3` is not `>` `helped=3`, so
  the sentence never fires for rule 24 — the rule sits at `watch`, not `retire_suggested` — but the
  *sentence itself*, if it did fire for some other rule at e.g. `helped=2, hurt=3`, would imply "2 of 5
  builds were fine and 3 weren't," when in fact some of those "5" could be the same 2 episodes counted once
  each way).
- `harness/src/analysis/health.ts:118-124` (doc comment) is careful and explicitly avoids causal language
  ("healthy otherwise," not "the rule is working") — the module's own internal reasoning is more careful than
  the UI copy layered on top of it.
- No code path infers "the rule worked" from *the absence* of a correction/adherence-broke/verdict; §1's
  step 2 treats "no matching correction found" as `helped`, which is a *lack-of-evidence-counted-as-positive-
  evidence* pattern — not the literal "absent failure implies causal fix" the brief warns against, but
  adjacent to it: `helped` is better read as "no repeat was seen" (and `harness-ux.ts:537-539`'s own comment
  says exactly this — "an applicable build without a repeat correction is not proof of help", and by
  design `healthLine` never prints the word "helped" for this reason, per fix-round-1 item 2). This
  distinction (no-repeat-seen vs. proven-helped) is honoured in the *live-rule* health line but **not** in
  the retirement math (`shouldRetire = hurt > helped`, health.ts:307), which still treats `helped` as if it
  were positive evidence when deciding whether to suggest retirement.

---

## Summary (10 lines)

1. `rule_health.helped`/`hurt` are two totals fed by four independently-gated sources (free tag/correction
   scan, AI Judge, human verdict, paired test) with dedup only against double-*hurt* and double-*applicable*,
   never double-*helped* — so the same episode can be both helped and hurt.
2. Confirmed live on rule 24: `applicable_tasks=3, helped=3, hurt=3` is 3 real episodes, each counted
   `helped` by the free correction-scan (because the classifier tagged 2 of them `new_task` and the 3rd's
   correction was about something else) and independently counted `hurt` by the AI Judge, which correctly
   read Lovable's reply and found the rule broken in all 3 — 0 of the 3 hurts are "observed."
3. `healthLine`'s "observed from your real builds" suffix is therefore a factual mislabel on this real row,
   not a hypothetical edge case; this is the audit's sharpest concrete finding.
4. The required six separate signals (applicability, instruction availability, explicit reference,
   behavioural compliance, predicted-issue-observed, repeated-correction) plus human acceptance/usefulness-
   decision/historical-replay/paired-comparison are partially present as raw data but collapse into `helped`/
   `hurt` the moment they touch retirement math; "explicit reference" doesn't exist at all.
5. The user-facing question is "Did this rule help?" (Yes/No/Not sure) everywhere, never "Is this rule still
   useful?"; retirement proposals offer only Retire/Keep, never the required Keep/Review/Retire/Not sure.
6. Neither of the two exact required status sentences ("Harness found the same issue in all 3 relevant
   builds." / "AI review marked the rule as not followed in 3 of 3 relevant builds.") exists; today's closest
   equivalents ("more … had a repeat correction than didn't", "Followed in 0 of 3…") are weaker and, in the
   hurt/helped case, not even a valid comparison once episodes double-count.
7. No "Needs attention" → "Recommendation: rewrite/Skill" → "Primary action: Review rule" block exists
   anywhere; the closest state (`status='watch'`) has no dedicated copy at all — and "Needs attention" is
   already live UI copy for an unrelated meaning (a stale/failed Lovable write), a naming collision to avoid.
8. 60-day inactivity is funneled into the identical "suggests retiring" RetireCard as a hurt-based
   suggestion — there is no separate "Review for relevance" framing or Keep/Archive/Move to Skill/Retest
   options; "Move to Skill" and "Retest" have no backing implementation to attach to yet.
9. `classify.ts` opens a `changed_mind` retirement proposal off a single boolean `contradicts_rule_ids`
   signal with no severity classification; confirmed live, two real `changed_mind` proposals (rules 22 and
   24) exist with equally strong "permanent" wording and were decided oppositely (retired vs. kept) with
   identical system copy either way.
10. Smallest safe first change: fix `healthLine`'s false "observed" claim (additive per-source breakdown,
    no migration) plus the two exact-copy sentences (~10-14h total); the four-way Keep/Review/Retire/Not-sure
    control and the contradiction-kind classifier are real schema/behaviour changes (~15-25h combined) that
    need their own design pass before implementation.
