# Design Exploration: Proving a Rule Helps, and Tracking Outcomes Afterwards

Read-only exploration. No code in this repo was changed to produce this document.

## Platform-fact correction (read this before anything else below)

SPEC.md A7 states remix "can snapshot at the state just before a specific
message" via a `messageId` parameter. **That parameter does not exist on the
`mcp__lovable__remix_project` tool actually exposed in this environment.**
Its full input schema is:

```
project_id (required), workspace_id (required), project_name,
include_history (default false), include_custom_knowledge (default false),
timeout_seconds (default 600, max 600)
```

No `message_id`, `ref`, `sha`, or `remixMode`. Cross-checked against every
other tool in this MCP surface: `list_files` and `read_file` accept a `ref`
(commit SHA/branch/tag) so *historical file contents are readable*, but there
is no tool that creates a live, chattable project from anything but the
source project's **current** state. `create_project` / `initiate_project`
cannot seed a code tree from files either (their `files` param attaches
upload references to the initial chat message, not a working tree). So:

**A remix in this environment is always a fork of the project as it is right
now, never as it was at some past message.** This is a real capability gap
versus what A7 promised, not a wording nuance — it changes what "controlled"
can mean for a replay (see Verdict, confounder 1).

Two more environment facts worth fixing before designing on top of A7/A8:

- **No delete tool exists anywhere in this MCP surface.** The full tool list
  (35 tools) has `set_project_visibility`, `move_projects_to_folder`,
  `set_folder_visibility` — no `delete_project`, no `archive_project`.
  Cleanup is therefore permanently manual (see §2).
- **No tool creates or lists folders.** `move_projects_to_folder` requires a
  `folder_id` it never discovers; `list_projects` can filter *by*
  `folder_id` but nothing returns one. A "Harness tests" folder must be
  created once by a human in the Lovable web UI, its id copied into a new
  Harness setting.
- `send_message` defaults to `wait: true` and blocks up to
  `timeout_seconds` (max 600s) returning the terminal result directly. Given
  A7's measured small-build latency (83–126s), most replay sends will not
  need a separate poll loop at all — `get_message` is the fallback only for
  the rare slow build or a `wait:false` call.

Everything below is designed against the tools that actually exist, not
against A7's text.

---

## 1. Verdict on the owner's idea

**Agree, with one correction to how "controlled" the treatment fork can be
made, which the existing schema already anticipates.** The core structure —
free historical control, one paid new build — is exactly what `experiment_plans`
in `harness/src/migrations.ts` (checkpoint C, v3) was built for:
`experiment_type = 'paired_control_treatment'` with a `control_configuration`
that can legitimately be "the user's own original run" and a
`starting_state_quality` enum (`controlled_equivalent | approximate |
historical_only | blocked`) that was clearly written by someone who already
expected the fork not to be a perfect historical snapshot. Given the platform
fact above, `controlled_equivalent` is **not currently achievable** through
this MCP surface for any project with commits after the episode; realistic
runs land at `approximate` (fork exists, but starts from current HEAD) or
`historical_only` (skip the fork, judge on paper against the historical
record alone, zero credits).

Cost-wise the owner is right: remix is free (A7, confirmed no cost field or
warning on the tool description either), the only credit-spending step is the
one `send_message` into the fork, at the same ~1.2–1.5 credits any small
build costs (A7). No second paid arm is needed because the "without" arm is
data Harness already has — the episode's original `corrections_count` and
the corrections themselves, already stored as `correction_candidates` linked
to a `task_episode`.

### Confounders and how each is handled

| # | Confounder | Handling |
|---|---|---|
| 1 | **Fork's starting state** (the big one). Remix always forks current HEAD, which already contains every commit made since the episode — possibly including the very fix the correction produced, unrelated refactors, or new features that change what "the same request" now touches. | Never claim `controlled_equivalent`. Default every fork-based run to `starting_state_quality = 'approximate'`. Reduce the gap by preferring the **most recent** episode tied to the rule in that project (fewest commits between "episode start" and "now"). Show the gap size to the judge as "N commits landed in this project since this episode" (from `list_edits`, counting edits after the episode's `ended_at`). If that count is large, the UI should suggest `historical_only` (no fork, paper judgment only) instead of spending credits on a comparison that current HEAD has already made moot. |
| 2 | **Builder drift** (Lovable's underlying model changes between the original run and today, independent of the rule). | SPEC's answer is a `without` replay in a second fresh fork of the same episode (the "drift check"). Kept, but opt-in and rare (§5) — it doubles the credit cost of that one test and does not change what the historical-control arm already tells you; it only tells you whether the builder *itself* got better. Default off. |
| 3 | **Non-determinism** (one send with one seed, one sample). | One replay is a signal, not proof. The score from a single run is stored as `historical_support` evidence at best (see §3) — it is explicitly weaker than `repeated_controlled_support`/`field_supported`, both of which require multiple observations. §4's ongoing tracking is what accumulates the repeats; a single "Test it first" click is not asked to carry more weight than one sample can. |
| 4 | **Knowledge differing between then and now** (Knowledge has grown/changed since the episode; if the fork just gets today's full Knowledge, a passing result could be any of the other rules added since, not the one under test). | `knowledge_snapshots` (checkpoint D, v4) is already an append-only, timestamped table per project/workspace. Add one read helper (`knowledgeSnapshotAsOf(target, targetId, asOf)`: latest snapshot with `fetched_at <= asOf`, falling back to the current managed content — and recording that fallback happened — when none predates the episode, which will be true for most rules today since snapshotting only started at checkpoint D). Compose the fork's Knowledge as *Knowledge-as-of-episode-time + only the rule under test*, using the existing `composeManagedKnowledge()` in `harness/src/knowledge.ts` (already handles marker-block insertion/character cap) rather than writing new composition logic. This isolates rule R's marginal effect from every other Knowledge change made since. |
| 5 | **Redacted text stands in for the original request.** `history_items.content` is redacted before storage (`executor/redact.ts`) — the exact original characters are never kept. | Accepted as-is: redaction only touches emails/keys/JWTs/PEM blocks, essentially never the substance of a UI request, and re-sending a genuinely un-redacted secret into a test project would be the wrong call anyway. Worth one line in the replay's evidence panel ("sent the redacted copy of the original request") so nobody is surprised by a `[redacted:email]` token in the transcript. |

---

## 2. Exact replay procedure

Using only the tools verified above. Everything runs as one foreground,
user-triggered action (a "Test it first" click), never a background cron —
consistent with A11's rule that nothing spending credits runs on a schedule,
and with how this codebase already works (`executor/beats.ts` explicitly
notes "nothing here spends credits").

**0. Preconditions.** Rule has `state='approved'` and an approved
`experiment_plan` (already how `ensureApprovedExperimentPlan` in
`harness/src/improvements.ts` works today). No other run is `forking` or
`building` anywhere (max concurrent = 1, §5). Estimated cost fits the
monthly Lovable-credit budget (§5, new setting).

**1. Choose the episode.** The `task_episode` the rule's `correction_candidate`
belongs to (`store.getCorrectionIdForRule` → its episode), unless the caller
picks a different one from the same project with `corrections_count ≥ 1`.
Take its earliest `role='user'` evidence item as the *original request text*
(redacted copy) and its `started_at`/that item's `occurred_at` as the
*episode timestamp*. Count edits since (`mcp__lovable__list_edits` on the
live project, edits after episode end) to size confounder 1.

**2. Resolve Knowledge-as-of.** `knowledgeSnapshotAsOf('project', project_id,
episode_timestamp)` (new helper, §7) → historical content, or current
content with a flag if none exists. Compose:
`composeManagedKnowledge(historicalContent, [...rulesActiveAtThatTime, ruleUnderTest])`.
(`rulesActiveAtThatTime` — rules whose earliest `written` `knowledge_version`
predates the episode — is the closest available proxy for "what Knowledge
actually said then"; note the approximation in the run record.)

**3. Fork.**
```
mcp__lovable__remix_project({
  project_id: source_project_id,
  workspace_id,
  project_name: "harness-test-<rule_id>-<yyyymmddThhmmss>",
  include_history: false,
  include_custom_knowledge: false,
  timeout_seconds: 600,
})
```
Immediately `register_experiment_resource({experiment_plan_id, resource_type:
'remix_project', experiment_arm: 'treatment', source_project_id,
safe_to_modify: true, lovable_resource_id: fork_project_id})`, then
`update_experiment_resource_status({id, creation_status: 'created'})`.
`starting_state_quality` on the plan is set to `'approximate'` here (never
`'controlled_equivalent'`, per §1).

**4. Set the fork's Knowledge.**
`get_project_knowledge(fork_id)` (defensive read — remix with
`include_custom_knowledge:false` should already leave it empty/default, but
`set_project_knowledge`'s own description warns it replaces content
entirely, so read first) then `set_project_knowledge(fork_id, composed.final_content)`.

**5. Send the original request.**
```
mcp__lovable__send_message({
  project_id: fork_id,
  message: original_request_text,   // the redacted copy
  wait: true,
  timeout_seconds: 600,
})
```
Store `message_id`, `thread_id` if returned. If the result comes back
`in_progress` (rare — only past the 600s ceiling), fall back to polling
`get_message(fork_id, message_id, thread_id)` every 20s for up to 15 minutes
total (mirrors A8/Phase 6's own timeout), foreground, inside the same
"Test it first" action — there is no cron in this architecture to hand it to.
`awaiting_input` is treated as terminal with an `awaiting_input` verdict, not
retried automatically (the tool description is explicit that it will not
resume on its own).

**6. Capture the result.**
`get_diff({project_id: fork_id, message_id})` → diff. From the completed
message: `commit_sha`, `cost_credits`, and the summary/activity-log text (A7
names these `commit_sha`, `edit_id`, `summary`, `cost_credits`, `content`;
`get_message`'s tool description confirms a `response` object appears once
the agent is done but doesn't enumerate its keys — **verify exact field
names against a live response on the first real run**, same spirit as
SPEC's own "not yet exercised" list). Write one row to a new `experiment_runs`
table (§7) with the fork id, message/thread ids, `commit_sha`, `cost_credits`,
diff, summary, and `starting_state_quality`.

**7. Cleanup — what's actually possible without a delete tool.**
```
set_project_visibility(fork_id, 'private')
move_projects_to_folder(workspace_id, settings.lovable_test_folder_id, [fork_id])
update_experiment_resource_status({id, cleanup_status: 'pending', safe_to_delete: true})
```
`safe_to_delete: true` is passed explicitly here (store.ts's own comment: it
"only ever changes when explicitly passed... never inferred") — it means
"a human may now delete this by hand," not that Harness deleted anything.
`cleanup_status` cannot reach `'cleaned'` automatically because nothing can
delete the project; add one small UI action, "I deleted these," that a human
clicks after actually removing the projects in the Lovable web UI, which
calls `update_experiment_resource_status({id, cleanup_status: 'cleaned',
cleaned_at: now})` for the selected rows. The `settings.lovable_test_folder_id`
setting must be filled in once by a human (create the folder in the Lovable
UI — no tool does this — then paste its id into Harness Settings); until it
is set, skip the folder move and rely on "private" alone.

The UI's cleanup list is `list_cleanup_required_resources()` — **already
implemented** (`harness/src/store.ts`, returns rows with
`creation_status='created' AND cleanup_status IN ('pending','not_required')`)
— filtered/labelled as "N test copies to delete by hand," each row showing
the fork's `lovable_resource_id` (linkable to its Lovable editor URL) and
which rule/episode it came from.

---

## 3. Judging

### v1 — the owner judges (free)

Screen (slots into the existing Improvement "proof" stage in
`harness/src/improvements.ts`, which today hard-codes `proof.runnable: false`
— this is exactly what flips that to `true`):

- **Left:** the original build's diff + summary (`get_diff` on the live
  project between the episode's `first_build_commit` and `final_commit`, or
  the stored `history_items` for that build) and the list of the user's
  original correction messages (already linked via
  `task_episode_evidence`/`correction_candidates` for that episode).
- **Right:** the new fork's diff + summary from the `experiment_runs` row.
- **Below:** one row per original correction with a three-way control —
  **Still needed? Yes / No / Unclear** — pre-populated with nothing (the
  human decides; no model guess to anchor on for v1).

`score = count(No) / count(total corrections)`.

**Records written:**
- `experiment_runs`: `score`, `per_correction` (JSON:
  `[{correction_candidate_id, still_needed, note?}]`), `judged_by: 'human'`,
  `judged_at`.
- **New** `record_verification_result` call (a genuinely missing piece —
  `verification_plan_items` today has no writer anywhere in `store.ts` or
  the MCP surface; every item is created `not_run` by `createVerificationPlan`
  and nothing ever updates it): sets the rule's verification item(s) to
  `passed` (score ≥ 0.5 and the plan's `failure_signature` was not observed
  in the fork's diff/summary), `failed` (signature observed, or score < 0.5),
  or `unclear`; `evidence` = the run summary + score; `evidence_type =
  'human_note'`.
- `setRuleEvidenceLevel(rule_id, 'historical_support', actor)` — this
  already exists (`store.ts`). Given §1's finding, `'controlled_support'`
  and `'repeated_controlled_support'` are not honestly reachable from a
  single fork-based replay in this environment (the fork is never a true
  control); `'historical_support'` is the right ceiling for one v1 test.
  `'field_supported'` is reserved for §4's accumulated real-world evidence.

### v2 — reviewer model, same rubric, human agreement tracked

Same screen, same rubric, but the per-correction yes/no/unclear plus
`observed_failures[]` comes from an LLM call (role `reviewer`) fed: the
original request, the original correction messages, the fork's diff, and the
original build's diff. This needs the LLM provider abstraction that
`llm_calls` (checkpoint round 3, v8) was scaffolded for but that does not
exist yet anywhere in `harness/src` (no client module, no provider secrets
wiring, no calls logged) — a real prerequisite, not a small add.

Once it exists: store the model's verdict the same way as v1
(`experiment_runs.per_correction`, `judged_by: 'model'`, plus `model`/`provider`),
show it to the human as a **pre-filled, editable** version of the v1 form
rather than skipping the human step, and record
`human_verdict` + `agrees_with_reviewer = (human_verdict == model_verdict)`
per run. `human_agreement = agreeing / judged` over time, surfaced next to
the rule (this repo dropped the old SPEC's autonomy-level gates in the local
pivot — no `autonomy` concept exists in this codebase today — so agreement
here is bookkeeping/evidence-quality only, not a gate on anything
automatic, unless a future checkpoint reintroduces autonomy tiers).

---

## 4. Ongoing outcome tracking (free)

The idea (every later synced episode in the rule's scope is a free real-world
observation) is sound and cheap — but it needs infrastructure this repo does
not have yet, more than §2/§3 do. Checked directly: there is no `rule_evaluations`
table, no `scope_tags` column anywhere (`rules` has only a free-text
`applies_when`), no `tags[]` on `task_episodes`, and no watcher/reviewer
pipeline (`watch-project`/`review-build`/`score-rules` from SPEC Phase 5 were
designed for the old hosted edge-function architecture and were never
rebuilt locally — grep for `watch_cursor`/`rule_evaluations`/`scope_tags` in
`harness/src` returns nothing outside `migrations.ts`'s glossary comment).

Two tiers, so the free, cheap part can ship without waiting on the expensive part:

**v1-lite (needs nothing new besides counting what's already mined).**
For each rule with a `written` Knowledge version, count `task_episodes` in
that project with `started_at` after the write. This is "N tasks since
added" with no claim about *what happened* in them — cheap, honest, and
buildable today from existing tables. Shown as "Since added: 4 tasks."

**v1-full ("0 repeat corrections") — needs the classifier.**
Requires, for every new `correction_candidate` created in that project after
the rule went live, a judgment of "does this match the rule's
`failure_signature`/`predicted_failure`?" That judgment is the
"classifier from the analysis pipeline" the prompt refers to, and it does
not exist as an automated pipeline in this codebase — mining/classification
today is done by Claude Code itself, in the loop, when a human runs a review
session (`mcp__harness__create_correction_candidate` is called by the
orchestrating agent, not a scheduled function). Given this architecture's
established norm (A11: nothing that spends tokens on its own judgment runs
unattended), the honest v1-full design keeps that judgment inside the same
manual, human-triggered review pass rather than inventing a new autonomous
job: when the user runs a "review new history" pass and a new correction
lands in a project with active rules, Claude Code is asked (as it already is
for classification) whether the correction's `predicted_failure`/summary
matches any active rule's `failure_signature` for that project, and — if so —
records it. New minimal storage: a `rule_field_observations` table (`rule_id`,
`task_episode_id`, `correction_candidate_id`, `signature_matched` boolean,
`created_at`) written once per (rule, episode) pair.

Metric shown on the improvement card: **"Since added: 4 tasks, 0 repeat
corrections"** = (v1-lite task count) and (count of `rule_field_observations`
with `signature_matched = true`). Same pair of numbers rolls up per rule and
per project on a future Scoreboard page (`sum(tasks since added)`,
`sum(repeats)` across a rule's applicable projects) — no new aggregation
logic needed beyond `GROUP BY rule_id`.

**What's needed from the analysis pipeline, concretely:** (1) a
`predicted_failure`/`failure_signature` comparison step reachable from the
existing manual review flow (no new autonomous job), and (2) ideally
`scope_tags` on `rules` and `tags[]` on `task_episodes` so "overlapping
scope" is a real filter instead of "every episode in the same project" —
today scope is effectively project-wide, which will over-count for
multi-purpose projects. Both are schema additions, not present in v3/v4/v8.

---

## 5. Cost model and controls

**Credits per test:** ~1.2–1.5 (A7's measured small-build range) for the one
`send_message` into the fork. **Worst case:** a build that isn't "small"
(new integration, larger feature) could run several times that — no hard
ceiling exists in A7's data, so the plan's `max_permitted_credits` (already
a required field on `experiment_plans`) is the real backstop: if the
completed run's `cost_credits` is read back over that cap, flag the run
`unclear`/needs-review rather than silently trusting it, and refuse the next
test for that rule until acknowledged. **With an opt-in drift check:**
double it (a second fork + send), so ~2.4–3.0 credits.

**Per-test approval:** already in the UI — "Test it first" on an Improvement
is exactly this approval; `ensureApprovedExperimentPlan` already gates on
the rule + plan being `approved` before anything runs. No new consent UI
needed, only wiring it to something that actually executes (today it does
not — `proof.runnable` is hard-coded `false`).

**Monthly Lovable credit budget — new setting.** Nothing like this exists
today (`llm_monthly_budget_usd` in `store.ts` v8 budgets *token* spend only).
Add `lovable_monthly_credit_budget` (SettingKey, default e.g. `"20"`,
validated like the existing `assertIntInRange` pattern) plus a small ledger:
either a new `lovable_credit_ledger` table (mirrors `llm_calls`: one row per
`experiment_runs` completion with `cost_credits`, `created_at`) or simply
`SUM(cost_credits) FROM experiment_runs WHERE created_at >= start_of_month`
directly off the new table — the latter is less code and is preferred (no
separate ledger table needed; `experiment_runs` already has everything).
Refuse to start a run (`replay-start` equivalent) if
`sum_this_month + estimated_credits > budget`, mirroring Phase 6's own rule.

**Drift check policy:** rare, opt-in. A checkbox next to "Test it first"
("also run a no-rule check on this same episode, +~1.2–1.5 credits"),
default unchecked. No `drift_check_every_n` automatic cadence (SPEC's
`settings.drift_check_every_n`) — that's an autonomous decision this local
architecture's own norm (A11) argues against; leave it fully opt-in per
click rather than resurrecting an "every Nth test" auto-trigger.

**Max concurrent tests = 1.** Enforce with the same shape as the existing
`runningSyncRun()` guard in `store.ts`: a query for any `experiment_run` in
`('forking','building')` anywhere; if one exists, the "Test it first" action
is disabled with a tooltip naming which rule is currently testing. Simpler
than a queue, and matches this app's "one thing at a time, always visible"
style elsewhere (one Knowledge write per project per 24h, one sync request
coalesced at a time).

---

## 6. What a user sees

On an Improvement card that's already past "review" (accepted, or "test
first" chosen — the `decision.test_first` flag already exists in
`improvements.ts`), the **proof** stage becomes live instead of stuck at
"Not proven yet":

1. Click **"Test it first"** (already present as a decision option; today it
   only creates a placeholder plan with `estimated_credits: 0` and
   `"Not yet defined"` text everywhere — this design is what fills that in
   with a real, costed plan and an actual runner).
2. Stage shows **"Testing… (building in a copy)"** while the run is
   `forking`/`building` — the fork's Lovable editor link is shown as soon as
   it exists (from `experiment_resources.lovable_resource_id`), so the
   curious can watch it live.
3. On completion: **"Test result: 2 of 3 corrections no longer needed"**,
   with the v1 side-by-side judging screen (§3) to actually produce that
   number, and two actions: **Add** (proceeds exactly like "Add it now" —
   stages the real Knowledge write) or **Skip** (rejects the rule, same as
   today's Reject path). A failed/timed-out/`awaiting_input` run shows that
   status plainly instead of a score, with a retry affordance (a fresh test,
   not a resumed one — the fork from a stuck run still needs cleanup, §2
   step 7, regardless of outcome).
4. Elsewhere (Settings or a small persistent widget), the **cleanup list**:
   "3 test copies to delete by hand," each linking to its Lovable editor,
   with "I deleted these" to check them off (§2).

---

## 7. Effort, task split, prerequisites

| Part | Effort | Why |
|---|---|---|
| §2 replay procedure (runner) | **L** | 6 new Lovable tools to wrap (remix, send_message, get_message, get_diff, set_project_visibility, move_projects_to_folder) on top of the 8 that exist today in `lovable-mcp.ts`; a new `experiment_runs` table; the Knowledge-as-of helper; the foreground poll fallback; real error/timeout handling for a live external agent run (nothing in this codebase talks to a *paid, long-running* Lovable call yet — everything today is free reads/writes). |
| §3 v1 judging (human) | **M** | Mostly UI (side-by-side diff/summary + per-correction radio form) plus one genuinely missing store/MCP function (`record_verification_result` — `verification_plan_items` has no writer at all today) and wiring `setRuleEvidenceLevel` (already exists) into the flow. |
| §3 v2 reviewer judging | **L** | Needs the LLM provider-abstraction module from scratch (secrets, provider dispatch, `llm_calls` logging) — scaffolded as a table only; zero client code exists. Do last; v1 alone already answers "does the rule help." |
| §4 ongoing tracking (v1-lite) | **S** | Pure count over existing tables (`task_episodes.started_at` vs. the rule's write date). Ship early — it's nearly free and needs nothing new. |
| §4 ongoing tracking (v1-full) | **L** | Needs a new `rule_field_observations` table, a classifier hook inside the existing manual review flow, and ideally `scope_tags`/`tags[]` schema additions for real scope matching (currently project-wide only). The largest open design question in this whole doc — flag as its own follow-up exploration before committing to a schema. |
| §5 cost model/controls | **S** | One new setting + a `SUM(cost_credits)` query + a concurrency guard shaped exactly like `runningSyncRun()`. No new tables. |
| §6 UI | **M** | Slots into the existing Improvement page's stage machinery (`stages`, `proof` object) rather than a new page; the main work is the judging screen from §3. |

**Task split (≤ 6 tasks), in dependency order:**

1. **Foundation** — extend `lovable-mcp.ts`'s `LovableReader`/`LovableWriter`
   with the 6 new tools; migration v9 adding `experiment_runs`,
   `rule_field_observations`, and the `record_verification_result` function;
   new settings (`lovable_monthly_credit_budget`, `lovable_test_folder_id`);
   `knowledgeSnapshotAsOf` helper. *(Blocks everything else.)*
2. **Replay runner** — implements §2 end to end, writes `experiment_runs`,
   registers/updates `experiment_resources`, does the visibility+folder
   cleanup steps. *(Depends on 1.)*
3. **v1 judging UI + cleanup list UI** — the side-by-side screen, per-correction
   form, Add/Skip wiring, and the "N test copies to delete" list with
   "I deleted these" (§2's list already exists as `list_cleanup_required_resources`;
   this task is mostly new UI). *(Depends on 2 for real data, though the shell
   can be built against fixtures in parallel.)*
4. **Cost controls** — budget setting, concurrency guard, per-run cap
   enforcement against `max_permitted_credits`. *(Depends on 1; can run
   parallel to 2/3.)*
5. **Ongoing tracking, v1-lite only** — the free task-count metric on the
   improvement card. *(Depends on 1 only; can ship independently and early.)*
6. **v2 reviewer + v1-full field classifier** — deliberately bundled last and
   lowest priority: both need net-new subsystems (an LLM client that doesn't
   exist; a classifier hook and scope-tag schema that don't exist) and
   neither blocks the "prove it helps" story, which v1 human judging plus
   the historical-control comparison already delivers end to end.

**What must exist first, restated directly:** the analysis pipeline
(classifier) is required only for §4's *repeat-correction* number, not for
§2/§3 — a rule can be proven via replay and judged by the owner with none of
it. Knowledge history (`knowledge_snapshots`) already exists and is the one
piece of "must exist first" infrastructure that's already done. The LLM
client does not exist and is required only for §3's v2 — v1 needs no LLM
client at all, since the owner is the judge.
