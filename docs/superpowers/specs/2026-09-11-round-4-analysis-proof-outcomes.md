# Round 4: analysis, paired tests, outcome tracking, and the small gaps

Date: 2026-09-11. Status: PROPOSED — waiting for the owner's approval. Integrates the three exploration documents under `explorations/` and corrects them where the controller verified different platform facts.

## 0. Verified platform facts that shape this design (2026-09-11)
- The executor's own Lovable grant (dynamic registration, loopback) is accepted by Lovable's REST control API (`GET https://api.lovable.dev/v1/me` and `/v1/workspaces` → 200).
- The REST API (SDK 1.7.5 types) supports `POST /v1/projects/{id}/remix/init` with `message_id` and `remix_mode: "before" | "including"`, `skip_initial_remix_message: true` (documented for test harnesses), `deleteProject`, `createVariant`, and `getMessage` returning `status`, `commit_sha`, `content`, `cost_credits`. The MCP `remix_project` tool has none of this and always forks the current state; the MCP surface has no delete.
- Remix is free. Sending a message into a project costs about 1.2–1.5 credits for a small build. Reads cost nothing.
- Consequence: a test copy CAN start from the project state just before the episode's request, and CAN be deleted automatically. The proof exploration's "approximate starting state" and "manual cleanup only" caveats are superseded; its judging, scoring and cost-control design stands.

## 1. Principle
Nothing spends Lovable credits unless the user presses "Test it first" on a specific item, and each press is one build. Nothing spends LLM tokens unless the user presses "Analyse now" (a schedule is a later opt-in). Every number shown is labelled with what produced it (your verdict, the reviewer model, real builds).

## 2. Phase A — Analysis pipeline (LLM tokens on the user's key, no credits)
As designed in `explorations/analysis-pipeline.md`, with these fixed decisions:
- `harness/src/llm/`: plain `fetch` adapters for OpenAI (JSON schema mode), Anthropic (tool forcing), Google (`responseSchema`); temperature 0; every call logged to `llm_calls` with tokens and estimated USD from an editable price table; a budget guard refuses a call when `spent + estimate > llm_monthly_budget_usd`; a per-run cap of 200 calls.
- Steps per run: classify new user messages (with 3 prior messages of human-visible context) → segment into task episodes → for episodes with ≥1 correction and no candidate, the miner proposes ≤1 instruction with evidence ids, scope, prediction, failure signature → dedupe (Dice similarity ≥ 0.8 skips; 0.6–0.8 asks the model) → write through `createCorrectionCandidate → createLearning → createRule` so the Inbox is unchanged.
- Trigger: "Analyse now" (Inbox notice and Instructions notice) → `analysis_requests`; the executor loop runs it like a sync (`analysis_runs` with counts and cost). Runs without a Lovable connection. Errors shown plainly: no key for the chosen provider, over budget.
- Settings: spent/budget progress and last analysis run appear in the AI analysis section. Role hints already exist.
- Prompt injection: chat content is data; the model only returns JSON that becomes a *proposal* a human must approve; instructions ≤ 300 chars, imperative, must cite evidence ids that exist.
- Estimated cost on the owner's current history: about $0.02; a 250-message project ≈ $0.50–1.10 per full pass.

## 3. Phase B — Paired test ("Test it first"), credits only per test
- **Control arm = history (free).** The episode the rule came from: original request, the original first build (its diff via `get_diff` on the recorded commit), and the corrections the user made.
- **Treatment arm = one new build.** Executor, via REST with its own grant: remix the project at `message_id = the episode's first request`, `remix_mode: "before"`, `include_history: false`, `include_custom_knowledge: false`, `skip_initial_remix_message: true`; set the copy's project Knowledge to the Knowledge as it was at the episode time (latest snapshot at or before `started_at`, else current) plus the rule (workspace Knowledge likewise); send the original request text; poll `getMessage` every 20 s until terminal (max 15 min); record `commit_sha`, `cost_credits`, summary and diff into a new `experiment_runs` table; then `deleteProject` the copy unless the setting "keep test copies" is on. If deletion fails, the copy is set private and listed under "Test copies to delete by hand".
- **Judging v1 = the owner (free).** A judging screen shows, side by side: the original first build (summary + diff) and the test build (summary + diff), and lists each original correction with "Still needed? yes / no / unclear". Score = corrections no longer needed ÷ corrections. Stored on the experiment plan and its verification plan items; the rule's evidence level becomes `human_grounded`+`controlled_support` (labelled in the UI as "Tested by you: 2 of 3 corrections no longer needed").
- **Judging v2 = reviewer model** (later, after Phase A): same rubric, the owner's key, agreement with the owner tracked; never shown as the only verdict until agreement ≥ 0.8 over 10 items.
- **Confounders, stated in the UI:** builder drift ("this compares against a build from N days ago"), single-run noise ("one run; evidence, not proof"); an opt-in "also rerun without the rule" costs a second build and is off by default.
- **Cost controls:** new setting `lovable_monthly_credit_budget` (default 20) with spend from `experiment_runs`; refuse a test when it would exceed it; one test at a time; per-run cap = the plan's `max_permitted_credits`; the "Test it first" dialog shows the estimate and the month's remaining budget.
- **What the user sees:** "Test it first" → item shows "Testing… (building in a temporary copy)" → "Your verdict is needed" with the judging screen → after the verdict: "Tested: 2 of 3 corrections no longer needed" with Add now / Skip.

## 4. Phase C — Outcome tracking (free)
- v1-lite, no LLM: on each live rule and its improvement: "Since added: N tasks in this project" (task episodes started after the write) and, once Phase A's classifier runs, "M repeat corrections of this kind" (episodes after the write with a correction matching the rule's failure signature). Shown as one line on the card and on the Instructions page under the rule.
- A Scoreboard page comes later, once there are enough weeks of data to chart; not in this round.

## 5. Phase D — Small gaps
- **Evidence links:** "Open in Lovable" on each quoted message → the project editor URL; deep links to a message are tried with the thread/message id and verified once by hand; fall back to the project chat.
- **Notifications:** sidebar count on Inbox, "new since your last visit" marker (setting `inbox_last_seen_at`), optional browser notification opt-in from the Settings page while the app is open. No email in this round.
- **Retire:** each live rule on the Instructions page gets "Retire" → confirmation → rule `retired`, managed block recomposed, a pending version staged with reason; the improvement moves to a new group "Retired" with "Re-add"; counts against `max_active_rules` stop.

## 6. Order and effort
A (analysis) first — M/L, ~6 tasks; C v1-lite in parallel — S; D — S/M/M, 3–4 tasks; B (paired test) — L, 5 tasks, last, because it is the only part that spends credits and it benefits from A's classifier for the repeat-correction metric. Every task follows the existing SDD plan style with structural and unit tests; nothing in B is exercised against Lovable until the owner explicitly runs one test on one item.

## 7. Decisions needed from the owner
1. Approve the order A → C → D → B, or ask for B earlier.
2. Confirm the first live paired test will be run by you on one item (about 1.5 credits) when B lands; the build will not run one on its own.
3. Default budgets: LLM $10/month, Lovable 20 credits/month for tests — change if you want.
