# Round 5: vocabulary, Inbox vs Suggestions, rules and history per project, automatic mode, honest proof, demo data

Date: 2026-09-12. Status: APPROVED by the owner in chat with amendments (§1 one model choice by default; §3b History as its own page; §4 default stays manual; §4b feedback loop; §5 build all four evidence sources and let the user choose which count; §6 no credit number). Follows the owner's feedback of 2026-09-12 on the round-4 state (see `docs/HANDOFF.md`). Everything here is local-runtime only, like rounds 2–4.

## 0. Verified facts that shape this round (2026-09-12)

- The executor has never run a sync (`sync_runs` is empty). Every chat, Knowledge and Skill row in the owner's database is hand-entered or demo. Real data starts when the owner runs `npm run harness:executor`.
- "Analyse now" was pressed three times and all three runs failed with "No API key saved for openai". Settings still says OpenAI. Claude Code needs no key.
- Lovable REST has a credits endpoint, `GET /v1/credits?workspace_id=…`, but it answers 402 "upgrade your plan" on the owner's Pro workspace. A live credit balance cannot be shown on this plan. `/v1/me` and `/v1/workspaces` work (plan name, project count).
- The sync (executor `syncHistory`, `snapshotKnowledge`, `snapshotSkills`) makes no model call. Only "Analyse now" does.

## 1. Vocabulary (owner's decision)

The owner's words: *fetching is the miner; analysis is something else, which I do want.*

| Concept | UI word | Code / docs word | Never again |
|---|---|---|---|
| Reading chats, Knowledge and Skills from Lovable on a schedule; no model | **Sync** (unchanged; Lovable users understand it) | sync; the owner calls it *mining* and `executor/beats.ts` says so in its header | — |
| The model step that reads synced chats and proposes a rule | **Analysis** ("Analyse now", "AI analysis" in Settings) | analysis; the two model roles are **Classifier** and **Rule writer** | "miner" for anything that calls a model |
| A rule the analysis proposes and the user has not decided on | **Suggestion** | suggestion / improvement (the `improvements.ts` view keeps its name internally) | "improvement" in UI copy, because it implies the AI is right |
| A suggestion the user (or automatic mode) accepted | **Rule** | rule | — |

Concretely:
- Nav label "Improvements" → **"Suggestions"**. Route stays `/ledger`; `/improvements` and `/suggestions` redirect to it. Page copy, group names and toasts keep their meaning but say "suggestion" where they said "improvement" ("One suggestion is waiting for your decision", "Suggestions Harness finds in your Lovable chats will appear here").
- Settings › AI analysis: **one provider and one model by default.** The owner asked why a "miner" needs a model at all: it doesn't; the two roles that do are the Classifier (hundreds of cheap calls, one per message) and the Rule writer (a few calls, one per corrected episode). The default view shows a single provider + model applied to both; a collapsed "Advanced: different models per role" reveals the two rows with the existing hints. Role label "Miner" → **"Rule writer"**. The stored role key `miner` in `llm_models` is renamed `rule_writer` by migration v11 (rewrites the JSON value once); `harness/src/analysis/mine.ts` → `propose.ts`, `mineEpisodes` → `proposeRules`, `MINER_JSON_SCHEMA` → `RULE_WRITER_JSON_SCHEMA`, comments updated. `docs/HANDOFF.md` and the structural tests follow.
- `HOW_IT_WORKS_STEPS` step 2 says "Harness's AI analysis proposes one rule …" so the landing page is consistent with the vocabulary.

## 2. Inbox vs Suggestions

Owner's rule: *Inbox shows only what needs my attention, and I can act right there; clicking goes to the Suggestions section.*

**Inbox** (list only, no detail view of its own):
- One compact card per item needing a decision: project name, the proposed rule in a blockquote, one line of "why" (`whyFor(classification)`), and the buttons Add to this project / Add to all my projects / Skip (Retire / Keep for retirement proposals). No "New" badge logic change. No evidence, no Details.
- Clicking the title or the card body navigates to `/ledger?improvement=<id>` (the Suggestions detail). The Inbox's own `?improvement=` search param and `ImprovementDetail` usage are removed.
- After a decision the card becomes the existing one-line confirmation row with **Undo**; the "View in Improvements" link becomes "Open" and goes to the same detail. Reload clears the row, as today.
- Empty state unchanged.

**Suggestions** (`/ledger`): unchanged structure (groups, filter, detail with evidence, Details, Developer view). Adds:
- Group label per item: "Accepted automatically" marker on items automatic mode accepted (§4), next to the group badge.
- Previous/Next in the detail keep working after a decision: the order is computed from the full grouped list (already true here).

Structural tests: `ux-inbox-logic.test.ts` and `ux.test.ts` pins on the Inbox detail are rewritten with intent; a new pin asserts `inbox.tsx` no longer imports `ImprovementDetail`.

## 3. Instructions page: current rules per project, and one history timeline

### 3a. Rules table (per project, and one for the workspace)

Replaces the "Rules Harness added" list of underlined links. One table per target, columns:

| Rule | Status | Since | Observed |
|---|---|---|---|
| plain text of the instruction (not link-styled; row is clickable → Suggestions detail) | In Lovable / Staged / Needs attention / Testing | first written date, from `rule_health.first_written_at`, else the earliest written version, else "—" | the health line (§5 wording) or "no builds yet" |

- A row's trailing action is **Retire** (existing confirm). Retired rules stay collapsed under "Retired rules (N)" with **Re-add**.
- The target's raw Knowledge text moves below the table into a collapsed section "Full Knowledge text as Lovable sees it (N characters)", still with the "Added by Harness" block marked. It is no longer the first thing on the page.
- "Read from Lovable at …" status line and Sync now button stay.

API: `KnowledgeActiveRule` gains `status: "written" | "pending" | "stale" | "failed" | "testing"` and `since: string | null`.

### 3b. History page: one timeline per target

The owner's "git graph", and the owner allowed more pages: history gets its own nav page, **History**, between Instructions and Skills. Instructions then shows only what is current (rules table + Knowledge text); History shows everything that happened. The page has a target selector (each allowed project, and the workspace) and one vertical timeline, newest first. The history is linear per target, so it is a timeline, not a branch graph. Node kinds:

| Kind | Source | Label |
|---|---|---|
| `version` | `knowledge_versions` (every status) | "Written to Lovable" / "Staged" / "Restored to version #N" / "Needs attention" / "Failed" / "Cancelled", plus which rules it contained |
| `external_change` | a `knowledge_snapshots` row whose content differs from the previous snapshot and from every version's `new_content` | "Changed in Lovable (outside Harness)" |
| `decision` | `agent_actions` decision rows for this target's rules | "You accepted", "Accepted automatically (confidence 0.86)", "You skipped", "You retired", "Re-added", "Harness suggested retiring", "You kept it" |
| `skill` (workspace timeline only) | `skill_snapshots` | "Skill <name> changed" / "Skill <name> first read" |
| `verdict` | rule verdicts (§5) | "You said this rule helped / didn't help" |

Rendering: a left rail with dots and a connecting line; each node shows date, label, actor, and a one-line change summary ("+3 −1 lines", "1 rule added"). **Selecting a node shows its full text inline below it** (the whole Knowledge document for `version` / `external_change`, the whole skill for `skill`, the rule text for `decision` / `verdict`) — the owner's requirement that content is visible, not only a diff behind a toggle. For `version` and `skill` nodes a "Show as diff" toggle switches that panel to the existing red/green line diff against the previous node of the same kind. A restore node also shows "restored #N" as a small back-reference link that selects that node. "Restore this version" stays on `version` nodes that are written and not the newest written.

API: the knowledge route answers `GET ?timeline=<target>:<id>` with `TimelineNode[]` with `{ id, kind, at, label, actor, summary, content: string | null, diff: KnowledgeChanges | null, rule_ids: number[], restored_from: number | null, improvement_id: number | null }`. Contents are sent in full (≤ 10 k chars each; a project with 40 versions is ~400 kB, acceptable for a local app; the route caps the timeline at the newest 200 nodes). The Skills page keeps its per-skill sections; its "History" list links to the History page with the workspace selected. The Instructions page's old per-version list is removed (it lives on History now).

## 4. Automatic mode

Owner's rule: *the user selects automatic to always accept the AI's choice; when the AI is unsure it flags it for the user; what was accepted or done must be visible in history.*

- New global setting `decision_mode`: `"ask"` (default) or `"automatic"`. Settings › a new small section **Decisions**, above AI analysis:
  - "Ask me about every suggestion" (default).
  - "Automatic: accept suggestions Harness is confident about; ask me about the rest." Help text says exactly what happens: *Confident means the analysis gave the rule a confidence of at least 0.8, found no similar or conflicting rule, and the project is under its rule limit and Knowledge limit. Accepted rules are written to your Lovable Knowledge at the next sync if that project allows automatic writes (Projects page). Everything Harness does automatically is listed in the Instructions page history, and you can retire or restore any of it.* Threshold `decision_auto_confidence` (0.5–1.0, default 0.8) is shown as a number field under the option.
- Where it runs: in `runAnalysis`, right after a proposal is written, if `decision_mode = automatic` and the proposal has `confidence ≥ threshold`, `duplicate_of_rule_id = null`, `contradicts_rule_id = null`, and the accept preconditions pass (same checks as the "accept" action: cap, rule limit) → the store's accept path is called with `reviewer: "harness (automatic)"` and `destination = proposed scope`; the item never appears in the Inbox. Otherwise the item goes to the Inbox with an extra line: "Harness wasn't sure: <reason>" (low confidence / similar to an existing rule / may conflict with "<rule>" / project at its rule limit).
- Writes still follow the per-project `auto_write` flag and `require_approval_before_write`; automatic mode does not bypass them. When a write cannot happen automatically, the item shows in Suggestions under "Waiting to be written" with the existing copy.
- Retirement proposals are never auto-applied (round-4 decision stands).
- Visibility: `decision` timeline nodes (§3b) and the "Accepted automatically" marker in Suggestions. The Inbox empty state in automatic mode reads: "Nothing needs your decision. Harness accepted N suggestions automatically since your last visit; see Suggestions."
- **Default is manual.** `decision_mode` defaults to `ask`; the owner decides every suggestion unless they switch. Nothing in this round changes that default.
- Principle check: automatic mode spends no Lovable credits and no tokens beyond the analysis the user already requested by pressing Analyse now. It can change the user's Knowledge without a per-item button press; that is the point of the mode, it is opt-in, and every change is versioned and restorable.

## 4b. Feedback loop: Harness as a recommender

Owner's rule: *this should be like a recommender system; we take in user feedback to improve.* What the user does with suggestions is feedback, and the analysis must use it. Honest scope: no model is trained; feedback changes what the Rule writer sees and how suggestions are ranked.

- **Skip asks why (one click, optional):** "Not useful" / "Wrong wording" / "One-time thing" / "Already covered". Stored on the correction candidate (`skip_reason`, migration v11). "Wrong wording" keeps the item reopenable with the wording editor focused.
- **The Rule writer prompt carries the user's history:** up to 8 most recent accepted rules (as examples of what this user wants), up to 8 skipped suggestions with their reasons (what not to propose again), and up to 4 wording edits as before/after pairs (the user's preferred style). All are data, never instructions, in the same guarded framing the classifier prompt uses.
- **Re-proposal guard:** a new proposal with Dice ≥ 0.8 against a *skipped* suggestion is dropped and counted as `skipped_duplicate` in the run counts, so a skipped idea does not come back.
- **Ranking in the Inbox:** pending items are ordered by confidence adjusted by the acceptance rate of their tag (`accepted / (accepted + skipped)` per scope tag, from the user's own decisions; neutral 0.5 with fewer than 3 decisions). Shown as-is, no score on the card.
- **Verdicts feed retirement** (§5.2) and the health line.
- **Settings › Decisions shows the loop:** "From your decisions so far: 7 accepted, 5 skipped, 3 verdicts. Harness shows the Rule writer what you accepted and skipped, and won't re-propose what you skipped." One line, so the user knows the feedback is used and how.

## 5. Proving a rule helped: what we can honestly say

Owner's ask: *think about the way we prove things; how can we prove a rule helped or not.*

There are four sources of evidence, from cheapest to strongest. Every number shown must say which one produced it.

1. **Observed from real builds (free, automatic, already built).** `rule_health` counts, after the rule was written, the task episodes in its area (applicable) and how many of them contained a correction matching the rule's failure signature (a repeat). Today the UI calls the rest "helped", which is too strong: an applicable build without a repeat correction may simply not have exercised the rule. **This round changes the wording**: "Since added: 6 builds in this area, 1 repeat correction, last used 3 Sep · observed from your real builds". "helped" disappears from copy; the `rule_health.helped` column is renamed in copy only ("builds without a repeat").
2. **Your verdict (free, one click, this round).** On each live rule (Instructions table and Suggestions detail): "Did this rule help? Yes / No / Not sure". Stored in a new table `rule_verdicts (rule_id, verdict, note, created_at)`; the latest verdict shows next to the observed line ("You said: helped, 5 Sep") and becomes a `verdict` timeline node. Retirement proposals take a "No" verdict as one more `hurt` signal and a "Yes" as a snooze of 30 days, so the user's judgment steers retirement without a new flow.
3. **Adherence check (tokens, this round, runs inside "Analyse now").** For each live rule and each applicable episode after its write that has not been judged yet, a third role, the **Judge**, reads the episode's request, Lovable's human-visible reply and the rule, and answers `followed / broke / not_applicable` with a quoted line of at most 200 characters as the reason. Stored in `rule_adherence (rule_id, task_episode_id, verdict, quote, llm_call_id, created_at)`. Gives "Followed in 5 of 6 builds it applied to · judged by AI, with quotes" and distinguishes "rule not exercised" from "rule followed". Capped at 50 calls per run (inside the existing 200 cap) and the token budget. A `broke` verdict counts as one more `hurt` signal for retirement when the user has enabled it (below).
4. **Paired test (credits, per item, Phase B, unchanged).** The only counterfactual: the same request with and without the rule in a temporary copy. Remains the owner's decision per item; not built this round.

**Which would an engineer trust?** In principle the paired test, because it is the only counterfactual; in practice a single run is noisy and the copy's starting state is approximate, so engineers discount it. The adherence check is trusted more day to day because every verdict comes with the quoted line that earned it and it is cheap enough to run on every build. Observation is the weakest (absence of a repeat correction is not evidence the rule did anything). The user's own verdict is subjective but is the ground truth for this user. **Decision: build all four, show each labelled with its source, and let the user choose which ones count.** New Settings › Evidence section: four checkboxes, "Signals that count towards a rule's health and retirement": observed repeat corrections (on), AI adherence check (on), your verdicts (on), paired tests (off until Phase B ships, shown disabled with "not available yet"). `rule_health` recomputation reads these flags; the health line always shows all available sources regardless, so turning one off hides nothing.

The Suggestions detail's "Details" section gets one paragraph, "How Harness judges whether a rule helps", listing these four in plain words and which ones have run for this rule.

## 6. Landing page: sell the spare credits

- New paragraph under the intro: **"Credits left this month? Spend them on making Lovable better at your project. Syncing chats and writing Knowledge costs nothing. Testing a rule in a temporary copy is a normal Lovable build and uses credits like one; Harness records what each test cost."** No number: the owner is right that we do not know what a test costs until one has run. `proveCostLine` drops its "up to N credits" claim for the same reason and says "Uses Lovable credits like any build; the cost is recorded after the test." No live balance (402 on Pro; see §0). If the credits endpoint ever answers 200 for the executor's grant, the in-app Inbox notice can show "You have N credits left this month" — designed, not built; the executor gains a `getCredits()` that returns `null` on 402 so this is one UI line later.
- Step titles stay; step 2 text follows the §1 vocabulary.
- The `Synced` step keeps "No credits, no AI" because it is true.

## 7. Demo data

`npm run harness:demo -- --add` seeds, for the owner's one allowed project and its workspace, enough to see every screen; `--remove` deletes exactly those rows. Rows are identified by the existing fixed "Demo:" titles/names, actor/`fetched_by`/`reviewer` = `demo`, and `source_ref = 'demo-seed'`.

- Suggestions (9): 3 pending (one flagged "Harness wasn't sure"), 1 retirement proposal, 2 in Lovable with `rule_health` rows, one verdict each and a few `rule_adherence` rows with quotes, 1 accepted automatically, 1 reverted, 1 skipped with a reason, 1 needing attention (stale write).
- Knowledge versions: ~10 across the project target (including a restore and a stale write) and 3 on the workspace target, backdated over 14 days.
- One `external_change` snapshot (Knowledge edited in Lovable outside Harness).
- Skills: 2 workspace skills, 3 snapshots each, backdated.
- Task episodes with tags so `rule_health` has real numbers; `rule_health` rows written through `recomputeRuleHealth`, not inserted by hand.
- Tests: `demo.test.ts` asserts add → remove returns every affected table to its prior row count, and that add is idempotent. Removal is by the gathered id sets, extended for `rule_verdicts`, `rule_adherence`, `rule_health`, `retire_proposals`, `message_classifications`, `analysis_*` rows it created.
- No second fake project: the executor would try to sync it from Lovable every hour and fail.

## 8. Out of scope this round

Phase B (paired test), a hosted runtime, a Scoreboard page, e-mail notifications, a no-model correction detector (the owner did not ask for it after §1 clarified that analysis should use a model), any model training or fine-tuning (feedback is used as prompt context and ranking only).

## 9. Order, size and process

Tasks, each with unit + structural tests, Sonnet 5 for anything touching store/API/analysis, Haiku 4.5 for copy-only renames and test-pin updates:

1. **Schema + vocabulary in code** (Sonnet; owns migration v11): `llm_models` key rename `miner → rule_writer` and a third role `judge`; new tables `rule_verdicts`, `rule_adherence`; new columns `correction_candidates.skip_reason`; new settings `decision_mode`, `decision_auto_confidence`, `evidence_sources`; file rename `mine.ts → propose.ts`. Store functions for all of it in a delimited block.
2. **Copy vocabulary** (Haiku): "Improvements → Suggestions" (nav, titles, toasts, empty states, redirects), "Miner → Rule writer", landing copy (§6), `proveCostLine`, test pins, HANDOFF glossary.
3. **Knowledge API: rules table fields + History timeline** (Sonnet): `KnowledgeActiveRule.status/since`, `?timeline=` builder in `improvements.ts` (delimited block), verdict action.
4. **Instructions page + History page UI** (Sonnet): rules table, collapsed full text, new `/history` route with target selector and timeline (select-to-show-full-text, diff toggle), nav entry, Skills page link.
5. **Inbox compact card + navigation** (Sonnet): §2.
6. **Automatic mode + feedback loop** (Sonnet): §4 and §4b: Settings › Decisions section (mode, threshold, feedback line), one-model-by-default AI analysis section with Advanced per-role rows, `runAnalysis` auto-accept hook, skip reasons UI, Rule writer prompt context, re-proposal guard, Inbox ranking, "wasn't sure" line, "Accepted automatically" marker.
7. **Evidence: wording, verdicts, adherence judge, Settings › Evidence** (Sonnet): §5: health copy, verdict buttons, `judge` role + `rule_adherence` runner inside `runAnalysis`, `rule_health` reads `evidence_sources`, Details paragraph.
8. **Demo data** (Sonnet): §7, last.

Then: per-task review, whole-branch review, one fix wave, `cd harness && npm test`, `npm run typecheck` both packages, `npm run build`. Ledger under `.superpowers/sdd/2026-09-12-round-5/progress.md` while it runs.

## 10. Owner decisions (recorded 2026-09-12)

1. "Suggestions" as the page name. History gets its own page.
2. Default decision mode is manual ("ask"); automatic is opt-in with threshold 0.8, global, still gated by per-project auto-write.
3. "helped" leaves the UI. All four evidence sources are built or planned, each labelled; the user chooses which count in Settings › Evidence.
4. No credit numbers anywhere until a real test has recorded a cost.
5. One model choice by default in AI analysis; per-role under Advanced.
6. Feedback is used as recommender input (prompt context, re-proposal guard, ranking), stated plainly in Settings.
