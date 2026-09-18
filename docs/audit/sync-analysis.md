# Sync and Analysis context audit

Auditor: sync-analysis auditor (read-only). Branch `local-harness-dev`, checkpoint 2026-09-18.
Scope: `harness/src/executor/beats.ts`, `harness/src/store.ts`, `harness/src/executor/schedule.ts`,
`harness/src/analysis/{run,classify,segment,propose,adherence}.ts`, `harness/src/llm/index.ts`,
`harness/src/migrations.ts`, `src/routes/_authenticated/{settings,inbox}.tsx`,
`src/components/harness/local-settings.tsx`, `src/lib/settings-defaults.ts`,
`src/routes/api/public/harness/executor.ts`, plus a read-only query against
`harness/data/harness.db`.

## 1. Intent-by-intent status

| # | Intent | Status | Evidence |
|---|---|---|---|
| 1a | Sync retrieves new user/builder **messages** incrementally, avoiding duplicate storage | verified | `harness/src/executor/beats.ts:79-181` (`syncHistory`): newest-first pass stops at first known `message_id` (`known.has`, line 126-129), backfill pass resumes from a parked cursor. Dedup is `history_items` upsert on `(project_id, kind, external_id)` — `harness/src/store.ts:157-166`. DB check: `history_items` has 54 rows across 5 projects with no gaps/dupes observed. |
| 1b | Sync retrieves **edits, diffs** incrementally | unavailable | `history_items.kind` supports `'diff'`/`'edit'` (`store.ts:146`) but `syncHistory` only ever inserts `kind: "message"` (`beats.ts:131`). No beat calls `get_diff`/`list_edits`; `grep` for `get_diff`/`listEdits` in `executor/*.ts` shows no caller outside the paired-test runner and mcp-server's now-unused manual tool. `source_ref: message.edit_id` (`beats.ts:140`) records a pointer to the edit that produced a message, but the diff/edit content itself is never fetched or stored. |
| 1c | Sync retrieves **Project Knowledge / Workspace Knowledge changes** incrementally, no dup storage | verified | `snapshotKnowledge` (`beats.ts:187-212`) skips writing a new `knowledge_snapshots` row when `sha256(content)` matches the latest stored one (`store.ts:1150-1167`, `latestKnowledgeSnapshot`). No remote version id exists on Lovable's side, so content hash is the de-facto stable identifier — reasonable given the API. |
| 1d | Sync retrieves **Skill changes** incrementally, no dup storage | verified | `snapshotSkills` (`beats.ts:215-245`): `recordSkillSnapshot` dedups by content, and a skill Lovable no longer lists is recorded once as deleted (`recordSkillDeleted`), only when the listing was `complete` (line 236-243) — guards against a partial answer marking everything deleted. |
| 1e | Sync retrieves **project metadata** incrementally | implemented_but_untested / partial | `beats.ts:96-106` only ever backfills `workspace_id` and `name` (from the allowed-project label), and only when those fields are still null. `status`, `url`, `tech_stack` columns exist on `projects` (`store.ts:65-94`, `upsertProject`) but nothing in the sync path ever populates them — the REST `getProject` call exists (`executor/lovable-rest.ts:45`) but its only caller is the paired-test runner (`experiments.ts:696`), never a sync beat. |
| 1f | Sync records **stable remote identifiers / cursors** | verified | `sync_cursors` table (`migrations.ts:397-404`), read/write via `getSyncCursor`/`setSyncCursor`/`clearSyncCursor` (`store.ts:1972-1986`). Cursor is only parked when a project's history exceeds `MAX_PAGES_PER_PROJECT * pageLimit` (40×50=2000 messages) in one pass (`beats.ts:41-47, 150-153`). Live DB: `sync_cursors` has 0 rows — expected, since every allowed project currently has 2–22 messages, far under the budget; the parked-cursor/resume path is therefore **unexercised in this database**, not broken. |
| 2a | Ordinary "Analyse now" processes only new/changed messages | verified | `classifyPending` only pulls rows with no `message_classifications` row yet (`store.ts:2602-2612`, `listUnclassifiedUserMessages`), keyed by `history_item_id` PK on `message_classifications` (`migrations.ts:508-515`) so a message is classified exactly once. |
| 2b | ...unclassified follow-ups | verified | Same as 2a — `listUnclassifiedUserMessages` has no filter on classification value; every unclassified user message (follow-up or not) is included, oldest first. |
| 2c | ...corrections without suggestions | verified | `listMinableEpisodes` (`store.ts:2814-2909`) selects episodes with a `correction`-classified evidence message that has no `correction_candidate_evidence` row AND no `correction_mining` row yet (`UNCOVERED_CORRECTION_CLAUSE`, `store.ts:2807-2812`). Each correction is asked about at most once even when the writer proposes nothing (`recordCorrectionMining(..., "no_proposal"/"duplicate"/"skipped_repeat")`, `propose.ts:415,476,488`). |
| 2d | ...builds not observed against relevant rules | verified | `judgeAdherence` (`adherence.ts:96-174`) walks `listUnjudgedEpisodesForRule` per live rule, and `rule_adherence` has a `UNIQUE(rule_id, task_episode_id)` constraint (`migrations.ts:628-638`), so a re-run never re-judges the same pair. |
| 2e | Analyse now never reclassifies the whole history | verified | Both selection queries above are anti-joins against work already done (message_classifications / correction_mining / rule_adherence), not a full-history scan; there is no code path that re-derives an existing classification. `proposeReclassification` (`store.ts:411-447`) is the only function that would revise a classification and reset review state, but it has **zero callers** anywhere in `src/` or `harness/src/` (confirmed by grep) — it is dead code, not reachable from any run. |
| 3a | Classifier/Rule writer receive: current message | verified | `classify.ts:106` (`classifierUserPrompt`), `propose.ts` focus block (`focusBlock`, `propose.ts:226-236`). |
| 3b | ...the task's initial request | partial (rule writer only) | `ruleWriterUserPrompt` includes `episode.request` (the episode's first user message, `propose.ts:206-208`, sourced by `EPISODE_REQUEST_ORDER` in `store.ts:2802-2803`). The **classifier** gets no such field — only up to 3 immediately-preceding messages regardless of episode boundaries (message classification runs before segmentation even exists). |
| 3c | ...latest Lovable response | partial | Judge gets it (`episodeTextForJudge`, `adherence.ts:134`, human-visible reply text). Rule writer gets `assistant_summaries`: every assistant reply in the episode's time window, human-visible-text-rendered and clamped to 800 chars (`store.ts:2768,2906-2908`) — a *summary of every reply in the episode*, not specifically "the latest" one. Classifier gets it only incidentally if an assistant message falls within its 3-message window. |
| 3d | ...latest diff summary | unavailable | No diff/edit content is ever synced (see 1b), so none of the three prompts can include one. "assistant_summaries" (rule writer) and the judge's "reply" are chat text, not diff summaries. |
| 3e | ...previous 3-5 task messages | partial | Classifier: fixed at exactly 3 (`DEFAULT_CONTEXT_SIZE = 3`, `classify.ts:26`), not configurable to 3-5, and windowed by **project**, not by task episode (`listContextBefore`, `store.ts:2628-2646`, filters on `project_id` only). Rule writer: gets the *entire* episode transcript (request + all corrections), not a capped 3-5 window — potentially more context than spec's minimum, but not the same shape. |
| 3f | ...relevant active Knowledge | unavailable | Grep of `classify.ts`/`propose.ts`/`adherence.ts` for `knowledge_snapshots`/`getProjectKnowledge`/`Knowledge` finds no reference. Only **live rules** (the managed-block instructions already extracted into `rules`, via `rulesInLovable`/`listLiveRuleTexts`) are shown — never the surrounding free-text Knowledge a user wrote directly in Lovable. |
| 3g | ...relevant Skills | unavailable | No reference to `skill_snapshots` anywhere in `harness/src/analysis/*.ts`. Skills are synced (1d) but never surfaced to any LLM role. |
| 3h | ...project summary | partial | Rule writer gets `project_name` only (`propose.ts:191`), not a summary. Classifier and judge get neither. |
| 3i | ...retrieve older local context when the current message references it | unavailable | No code path re-fetches history beyond the fixed windows above based on message content (e.g., no "this references an earlier decision, pull it in" logic). Context size is static, never content-driven. |
| 3j | Context selection recorded: item ids, reasons, token size, truncation, omitted items, context strategy version | unavailable | `insertLlmCall`/`llm_calls` columns are exactly `role, provider, model, tokens_in, tokens_out, cost_usd, created_at, estimated_tokens, run_id` (`migrations.ts:479-489,500-501`, confirmed live via `PRAGMA table_info(llm_calls)`). No column or side table records which item ids were included/omitted, why, or a context-strategy version. `estimated_tokens` is a pre-call size estimate (`llm/budget.ts`'s `estimateTokens`), not a record of what was actually selected. |
| 4a | "Reanalyse history" action exists (projects, date range, candidates, model, tokens, reason, previously-reviewed inclusion, confirmation) | unavailable | Grep for `reanaly` (case-insensitive) across `src/` and `harness/src/` returns zero hits. The only analysis trigger is `analyse_now` (`src/routes/api/public/harness/executor.ts:284-291`), which queues one coalesced `analysis_requests` row with no parameters (no project filter, no date range, no model override, no estimate shown before running) — see `store.ts:3160-3201`. |
| 4b | Reanalysis tracks provider, model, role, prompt_version, content_hash, context_strategy_version, analyzed_at, status per record | unavailable | `message_classifications` columns: `history_item_id, classification, tags_json, summary, run_id, created_at` (`migrations.ts:508-515`) — no provider/model/prompt_version/content_hash/context_strategy_version. Provider/model/role are recorded only in the separate `llm_calls` table, joined solely by `run_id`, not per classified item. |
| 4c | Reanalysis never silently overwrites human decisions; disagreement creates a review item | verified (by non-existence + structural guard) | There is no reanalysis feature to overwrite anything with. As a forward-looking check: the one function that *would* revise a stored classification, `proposeReclassification` (`store.ts:411-447`), already follows the safe pattern — it resets `reviewed = 0` (line 437) rather than silently keeping the record "reviewed", which would surface it again rather than hide the change. It is unused today (see 2e). `autoAcceptProposals` (`analysis/auto-accept.ts`) only ever acts on candidate ids the *same run's* `proposeRules` just created (`run.ts:249`, `propose.ts:342` `createdCandidateIds`) — it structurally cannot touch an existing reviewed candidate. `recordHumanCorrectionDecision` (`store.ts:465-503`) is the only path that sets `reviewed=1`, and nothing in the analysis pipeline calls it or flips it back. |
| 5a | `automatic_sync` and `automatic_analysis_after_sync` are separate settings | unavailable (as literally specified) — but the safety property holds | Only one relevant boolean setting exists: `sync_enabled` (`store.ts:1405,1471`, UI: "Sync on a schedule" toggle, `local-settings.tsx:657-664`). There is **no** `automatic_analysis_after_sync` setting anywhere — `grep` for `automatic_analysis` across the repo returns nothing. Analysis has no "automatic after sync" mode at all; its only automation axis is `decision_mode` (`ask`/`automatic`), which governs *whether a proposal is auto-accepted*, not *whether analysis runs*. |
| 5b | Hourly Sync must never trigger paid analysis | verified | `runAll` (`beats.ts:869-975`, the function every sync run — scheduled, manual, or once — executes) never calls `runAnalysis`, `requestAnalysis`, or inserts into `analysis_requests`; confirmed by full read of the function and by `grep -rn "requestAnalysis" src/` returning exactly one caller, the `analyse_now` POST action (`executor.ts:285`). The scheduler's tick calls `maybeRunAnalysis()` independently of the sync branch (`schedule.ts:193`), and that function is itself gated on `store.hasOpenAnalysisRequest()` (`schedule.ts:117`) — i.e. it only ever runs an analysis that a human already explicitly queued; it does not queue one itself after a sync. Live DB: `sync_runs` shows hourly `scheduled` runs every hour (ids 33-42, `2026-09-14 13:00` through `21:58`) with **no** correlated `analysis_runs` row at those timestamps — all 10 `analysis_runs` rows are `kind: 'manual'`. |

## 2. Exact context per LLM role today

**Classifier** (`harness/src/analysis/classify.ts`)
- System prompt: fixed instructions + the 9 `SCOPE_TAGS` list (`classifierSystemPrompt`, `classify.ts:58-81`).
- User prompt (`classifierUserPrompt`, `classify.ts:90-108`):
  - This project's **live rules** (id + instruction, each truncated to 1500 chars) — only if any exist.
  - Up to **3** prior messages, same project, any role, chronologically immediately before the target message (`listContextBefore`, `store.ts:2628-2646`), each truncated to 1500 chars, assistant replies rendered via `humanVisibleText` (strips tool-call markup).
  - The message itself, truncated to 1500 chars.
- No Knowledge, no Skills, no diff, no task's original request unless it happens to fall in the 3-message window, no project summary.

**Rule writer** (`harness/src/analysis/propose.ts`)
- System prompt: fixed instructions (`ruleWriterSystemPrompt`, `propose.ts:101-123`).
- User prompt (`ruleWriterUserPrompt` + `focusBlock`, `propose.ts:185-236`):
  - `project_name` (or raw id / "(unknown project)").
  - Existing **live rules** for this project/workspace (id + full instruction, unclamped).
  - Feedback context, read once per `proposeRules` call: up to 8 previously-**accepted** rule texts, up to 8 **skipped** suggestions (with skip reason), up to 4 wording **edits** (before→after) — each clamped to 300 chars (`propose.ts:149-183`, `store.ts:3661-3712`).
  - Episode transcript: the original request (≤1500 chars), all assistant replies in the episode's time window rendered human-visible and clamped to 800 chars each (`assistant_summaries`), and every correction message in the episode (≤1500 chars each) with its classifier summary.
  - A per-call focus line naming exactly one correction id to write a rule for, plus what was already proposed from this episode earlier in the same run (dedupe hint).
- No Knowledge, no Skills, no diff.

**Judge** (`harness/src/analysis/adherence.ts`)
- System prompt: fixed instructions (`judgeSystemPrompt`, `adherence.ts:32-47`).
- User prompt (`judgeUserPrompt`, `adherence.ts:49-53`): the rule's instruction text, the episode's request text, and Lovable's human-visible reply text (`episodeTextForJudge`, `store.ts:3864`) — **no explicit char cap found on request/reply in this function** (relies on whatever `episodeTextForJudge` returns).
- No Knowledge, no Skills, no diff, no prior-episode context, no live-rules list beyond the one rule being judged.

**Truncation caps, all roles**
| Field | Cap |
|---|---|
| Classifier context messages | 1500 chars each (`CONTEXT_MESSAGE_CHAR_LIMIT`, `classify.ts:24`) |
| Classifier target message | 1500 chars (`classify.ts:106`) |
| Classifier summary output | 120 chars (`SUMMARY_CHAR_LIMIT`, `classify.ts:25`) |
| Rule writer request/correction text | 1500 chars (`MINABLE_TEXT_CHAR_LIMIT`, `store.ts:2771`) |
| Rule writer assistant summaries | 800 chars each (`MINABLE_ASSISTANT_SUMMARY_CHAR_LIMIT`, `store.ts:2772`) |
| Rule writer feedback blocks (accepted/skipped/wording) | 300 chars each (`INSTRUCTION_CHAR_LIMIT`, `propose.ts:24,141-148`) |
| Rule writer proposed instruction | 300 chars (`propose.ts:441-444`) |
| Judge quote | 200 chars (`QUOTE_CHAR_LIMIT`, `adherence.ts:15`) |

## 3. Are older messages ever included as context?

Only in these fixed, mechanical ways — never driven by the current message's own content:
- Classifier: the 3 messages immediately before it, same project (`listContextBefore`).
- Rule writer: everything already linked as evidence to the episode the correction belongs to (segmentation-time linkage, not a fresh lookup), plus a small, capped slice of the user's own past decisions across *all* projects (accepted/skipped/wording-edit history, 4-8 items).
- Judge: the one episode being judged only.

There is no "the message references something older, go fetch it" retrieval — condition 3i above is unavailable.

## 4. Automatic-analysis settings and what the scheduler triggers

- Settings UI has exactly one relevant toggle: **"Sync on a schedule"** (`sync_enabled`), plus interval/window (`local-settings.tsx:654-714`). No "run analysis automatically" toggle exists anywhere in Settings.
- `decision_mode` (`ask`/`automatic`, `local-settings.tsx:507-552`) governs auto-*accepting a proposal a run already produced*, not whether analysis runs — this is a different axis than "automatic_analysis_after_sync" and is explicitly documented as such: `local-settings.tsx:174-175` — "Analysis runs only when you press Analyse now."
- The scheduler's single loop (`schedule.ts:153-249`) does two independent things per tick: `maybeRunAnalysis()` (only if a request is already queued) and, separately, a sync run if due. Neither branch triggers the other.
- Conclusion: the product currently achieves "hourly Sync never triggers paid analysis" not by having two separate boolean settings as the spec bullet imagines, but by **analysis having no automatic trigger at all** — it is 100% request-driven. The spec's literal ask (two named settings) is unimplemented; the safety property it's protecting is upheld by construction.

## 5. Does a "Reanalyse history" action exist?

No. Confirmed by full-repo grep for `reanaly*` (zero hits) and by reading every action branch of `src/routes/api/public/harness/executor.ts`'s POST handler (`sync_now`, `analyse_now`, `connect`, `disconnect`, `schedule`, `settings`, `llm_settings`, `llm_key`, `llm_key_remove`, `defaults` — no reanalysis/backfill/reprocess action). `analyse_now` itself takes no parameters (no project scope, no date range, no model choice, no cost estimate shown before confirming) — it is a single coalesced "process what's new" trigger, matching the "ordinary Analyse now" half of the spec but not the separate "Reanalyse history" half at all.

## 6. Could reanalysis overwrite human decisions?

Moot today (no reanalysis feature exists), but tracing the guard rails that would matter if one were built:
- `message_classifications` PK is `history_item_id` (`migrations.ts:509`) — a second `INSERT` for the same id would violate the PK, so even accidentally re-running `classifyPending` cannot silently overwrite a classification; `insertMessageClassification` has no `ON CONFLICT` clause (`store.ts:2659-2664`), it would throw.
- `correction_candidates.reviewed`/`decided_by` (`store.ts:363` `reviewCorrectionCandidate`, `store.ts:465-503` `recordHumanCorrectionDecision`, `store.ts:3814-3819` comment tracing the automatic path) is only ever set to reviewed=1 by a human review action or by the accept path (human or automatic), and to `decided_by='automatic'` only via `auto-accept.ts`'s `setCandidateDecidedBy` call, itself gated to same-run-only candidates (see 4c above).
- The one function that *would* revisit an existing classification, `proposeReclassification`, is unreferenced dead code (no MCP tool, no route, no caller) — it cannot currently run, but if wired up it already resets `reviewed=0` rather than leaving the record looking human-approved, which is the correct "create a review item" shape the spec asks for.
- Net: the codebase has no path today where an automated re-run can flip an already-`reviewed=1` correction_candidate or overwrite a `rules.state` set by a human, without going through the same `updateRule`/`reviewCorrectionCandidate` audit trail (`rule_revisions`, `agent_actions`) a human action would.

## 7. Gap list, smallest-safe-change, size estimate

| Gap | Smallest safe change | Est. hours |
|---|---|---|
| No Reanalyse-history action (project/date-range/model/estimate/confirmation UI + tracked run) | New `reanalyse` POST action + a confirmation dialog reusing `analyse_now`'s plumbing, scoped by an explicit project/date filter passed into a new `classifyPending`/`proposeRules` mode that *includes* already-classified items when explicitly asked, writing to a **new** `message_reclassifications`-style audit table rather than mutating `message_classifications` in place | 16-24h (UI + new table + dedicated non-destructive re-run path + tests) |
| `llm_calls`/`message_classifications` don't record which context items were used, omitted, or why, nor a context-strategy version | Add `context_json` (item ids + truncation flags) and `context_strategy_version` columns to `message_classifications`/`llm_calls`; populate from the already-assembled prompt inputs in `classify.ts`/`propose.ts`/`adherence.ts` (the data exists in memory, it's just not persisted) | 4-6h |
| Classifier/Rule writer never see Project/Workspace Knowledge or Skills | Pass `store.latestKnowledgeSnapshot`/`latestSkillSnapshots` (already synced, already in DB) into `classifierUserPrompt`/`ruleWriterUserPrompt`, clamped like every other block | 3-5h (mostly prompt plumbing + token-budget re-check, since this grows every call) |
| No diff/edit sync at all — "latest diff summary" is structurally unavailable | Add a `syncEdits` beat calling `list_edits`/`get_diff` per project (mirrors `snapshotSkills`'s shape), store as `history_items.kind='diff'`, dedup by `external_id` like messages | 6-10h (new Lovable-reader method, new beat, new store dedup path, tests) |
| `automatic_analysis_after_sync` doesn't exist as a named setting (currently safe only because there's no automatic analysis trigger at all) | If automatic analysis is ever wanted, add the setting explicitly rather than relying on "no trigger exists" — e.g. a boolean that, when true, calls `store.requestAnalysis()` at the end of `runAll` (`beats.ts`), still gated by `decision_mode`/budget checks already in `run.ts` | 2-3h once the feature is actually wanted; 0h to leave as-is (current state is safe, just under-named) |
| Classifier context window is fixed at 3 project-wide messages, not episode-aware, not 3-5 configurable | Make `DEFAULT_CONTEXT_SIZE` a setting (3-5) and prefer `listContextBefore` scoped to the open episode when one exists, falling back to project-wide | 3-4h |
| `sync_cursors`/backfill-resume path has zero live exercise (every project today is small) | Add a unit/integration test that forces `MAX_PAGES_PER_PROJECT` down to 1-2 pages against a fake with >100 messages, asserting the cursor is parked and resumed correctly across two `syncHistory` calls | 2-3h (test-only; the code path itself already exists and reads correctly) |
| Project metadata (`status`, `url`, `tech_stack`) never refreshed by sync | Call the existing REST `getProject` (already used by `experiments.ts`) once per project inside `syncHistory` or a new small beat, `upsertProject` the result | 2-3h |
| `proposeReclassification` is unreachable dead code implementing part of the "disagreement creates a review item" pattern | Either wire it to a real caller (once Reanalyse ships) or remove it to stop it reading as implemented | 1h (removal) / rolled into the Reanalyse work otherwise |

## 8. README/UI copy check

No overstatement found. Specifically checked against the gaps above:
- `README.md:120` — "Analyse now only processes what's new: unread messages, corrections without a suggestion, builds not yet checked." — accurate, matches §2a-2e above.
- `README.md:41-42` — describes Sync as reading "chats, Knowledge and Skills" (never claims diffs/edits) and Analysis as "Classifier finds corrections, the Rule writer proposes one instruction per correction, the Judge checks later builds against live rules" — accurate to what each role actually does; does not claim Knowledge/Skills/diff context is fed to the LLM roles, so it does not contradict the gap in §3f/3g/1b.
- `src/components/harness/local-settings.tsx:175` — "Analysis runs only when you press Analyse now." — verified true (§4/§5).
- `docs/HANDOFF.md:80` — "What Analyse now processes: only unclassified messages, only corrections no suggestion covers and not already asked about, only builds not yet judged per rule; rule health is recomputed for all rules." — accurate, matches code exactly.
- No README/UI text claims a "Reanalyse history" feature, a context-strategy version, or Knowledge/Skills-aware prompts exist — the gaps found are honest omissions, not misrepresentations.

## Summary (10 lines)

1. Sync reliably fetches and dedupes messages (cursor-based, stop-at-known), verified live; it never fetches diffs/edits despite the schema supporting them, and refreshes only `name`/`workspace_id` on projects, not `status`/`url`/`tech_stack`.
2. Knowledge and Skill snapshots are correctly deduped by content hash; the cursor-resume path for oversized histories exists but is untested against real data (every current project is small).
3. Ordinary "Analyse now" genuinely processes only new/changed work — unclassified messages, uncovered corrections, unjudged builds — via anti-join queries and unique constraints, never a full re-scan.
4. The Classifier sees only the target message, up to 3 prior project messages, and live rules; it never sees the episode's original request, a diff, Knowledge, Skills, or a project summary.
5. The Rule writer sees the fullest context of the three roles (whole episode transcript, live rules, feedback history) but still never sees Knowledge, Skills, or an actual diff — "assistant_summaries" is chat text, not a diff.
6. The Judge sees only one rule and one episode's request/reply text.
7. No context-selection metadata (item ids, reasons, token size, truncation, omitted items, context-strategy version) is ever recorded — `llm_calls` logs only provider/model/tokens/cost per call.
8. There is no "Reanalyse history" action anywhere in the code; `analyse_now` is the only trigger and takes no scoping parameters.
9. `automatic_sync` exists (`sync_enabled`); `automatic_analysis_after_sync` does not exist as a setting, but the safety property it would enforce already holds structurally — analysis has no automatic trigger at all, confirmed live (10/10 analysis runs are `manual`, hourly sync runs never correlate with an analysis run).
10. Nothing in the codebase can currently overwrite a human's reviewed decision automatically; the one function shaped for that (`proposeReclassification`) is unreachable dead code that already follows the "reset to unreviewed" pattern the spec wants, should it ever be wired up.
