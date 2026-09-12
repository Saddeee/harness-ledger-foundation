# Round 6: wired writes, undo and cancel, clean cards, and the paired test

Date: 2026-09-12. Status: APPROVED by the owner in chat ("you need to wire everything… things that don't cost credit I was expecting them to work and actually call Lovable… Go!"). Follows round 5 (`2026-09-12-round-5-clarity-automation-history.md`). Local runtime only.

## 0. What happened today, and the facts this round builds on

- **The owner pressed "Add to this project" several times and nothing reached Lovable.** Cause: writes only happen inside the executor loop (`npm run harness:executor`), a second process that had never been started. Second cause, found while fixing it: the staged write (version 10) had been composed on top of the *demo's* fake Knowledge, and a later demo action staged another poisoned recompose (version 24). Neither would have written (the sha check would have marked them stale), but the accept could never land either.
- **Fixed by hand at 19:05:** demo removed, the two poisoned versions cancelled, one real executor pass (sync: 4 messages, 1 real Knowledge snapshot), the suggestion re-accepted and composed on the real 6,655-character document, second pass wrote version 27, read back and verified on Lovable: the managed block with the owner's rule now ends the project Knowledge. First real write ever.
- **Lovable REST, verified with the executor's own grant (free reads):** `GET /v1/projects/{id}` (name, workspace), `GET /v1/projects/{id}/messages?limit=` (each message has `message_id` like `aimsg_…` and `role`), `GET /v1/projects/{id}/edits?limit=` (`commit_sha`, `commit_message`, `status`, `created_at`). Not yet exercised (present in the SDK types and the owner's own builder-context Knowledge): `POST /v1/projects/{id}/remix/init` with `message_id` and `remix_mode`, `/remix/progress`, `chat`, `getMessage` (`status`, `commit_sha`, `edit_id`, `summary`, `cost_credits`), `getDiff`, `deleteProject`. `GET /v1/credits?workspace_id=` answers 402 on the owner's plan.
- Executor status: connected; schedule window 10–22, hourly; now two sync runs in history.

## 1. Principle for this round

**Anything that costs no credits happens when you press the button, against Lovable, and the screen tells you the result.** Anything that costs credits is one press per test, says so before, and shows the real cost after. The demo can never touch a real project's data path.

## 2. Wire it: writes and syncs run from the app, immediately

- **Accept writes now.** The `accept` route action (when not test-first): stage as today, then, in the same request, if Harness is connected: read the target's current Knowledge from Lovable (fresh snapshot; the cached one may be minutes old), recompose on it, write, read back, verify — the existing `executeWrites` beat, called for this one version. The response carries the outcome; the toast and the card say **"Written to Lovable"** (with the time) or the exact reason it was not ("Knowledge changed in Lovable since Harness read it — re-check the preview", "Lovable rejected the write: …", "Harness is not connected — connect on the Projects page"). Same for **retire**, **re-add**, **restore**, **change wording** of a written rule, and workspace-destination writes. `require_approval_before_write` and per-project `auto_write` keep their meaning for *automatic* decisions only; a decision the user just pressed is the approval.
- **Sync now runs inline.** "Sync now" performs the sync in the request (history, Knowledge, Skills, health, retirements) and returns counts; the button shows progress and the result line.
- **The schedule runs inside the app.** When `HARNESS_RUNTIME=local`, the server starts the scheduler (hourly sync in the window; analysis when requested) on boot, guarded by a lock file (`harness/data/executor.lock` with pid + heartbeat) so a separately started `npm run harness:executor` never double-runs; the CLI stays for headless use and prints "the app is already running the schedule (pid N)" when the lock is held. Projects page shows which process holds the schedule.
- **Connection truth on every page.** A one-line status in the sidebar footer: "Connected to Lovable · last sync 19:05" or "Not connected — connect on Projects" (from the executor status the pages already poll). No page may say "will be written at the next sync" any more; copy says "written" or the reason.

## 3. Undo, cancel, remove

- **Undo** (one plain button, no dialog) on every decided item that has not been written: reopens it (rule back to proposed, staged write cancelled, decision pending). Shown on the Suggestions card, the Suggestions detail, and the Inbox confirmation row (already there).
- **Cancel** on the Instructions pending-write banner (only reachable now when a write failed or Harness was disconnected at accept time): cancels the staged version and reopens the item.
- **Remove from Knowledge** replaces "Restore previous version" on written rules' cards: it retires the rule and rewrites Knowledge without it, immediately (§2). Its confirm says exactly that and that Re-add exists.
- **Restore** lives on the History page only.
- Written-then-removed keeps working: Re-add rewrites immediately.

## 4. Clean cards (the owner: "clean and smooth UI/UX important")

- **Layout rule for every card:** header row = project name left, status badges right (group badge, "Accepted automatically", "New"); title; body (instruction blockquote or the editor) spanning the **full card width** (the editor was cut short because it shared a row with the badge column); status lines (decision sentence, observed line, verdict line, adherence line) as muted text; **one action bar** at the bottom: primary action left, secondary/outline actions after it, Undo/Skip as ghost at the end; all buttons the same size (`size="sm"` on lists, default on the detail page), same gap, wrapping as a row.
- **Verdict is a compact control in the observed line**, not a row of buttons: "Did this rule help? Yes · No · Not sure" as three small ghost buttons inline; after a choice it reads "You said: helped, 12 Sep · Change". **One verdict per rule**: recording a verdict updates the rule's single verdict row (upsert; `rule_verdicts` keeps history rows only when the value changes, so pressing the same button twice is a no-op). After a choice the line says what it changed: "Counted as one repeat correction in this rule's health" / "Retirement snoozed for 30 days" / "Recorded; no effect on health".
- **Instructions rules table** gets the same verdict control in the Observed cell; row actions collapse into one "…" menu (Remove from Knowledge, Open suggestion) so the table has one visible control per row.
- The Suggestions detail: same card at the top, evidence, then Details; no second copy of the buttons.

## 5. Demo data cannot touch real data paths

- Demo Knowledge snapshots are recorded with `fetched_by = 'demo'`; **composition and previews for a real target ignore demo snapshots** (`latestKnowledgeSnapshot(target, id, { forWrite: true })` skips them) — so a real accept can never be composed on demo text even with the demo loaded.
- `--remove` also sweeps `knowledge_versions` whose `rule_ids_json` references a demo rule and versions whose `previous_content` equals a demo snapshot (the residue found today), and cancels rather than deletes any such row that is `pending`.
- `--add` prints: "Demo data is loaded. Real Knowledge writes ignore demo snapshots, but retire/re-add on demo rules stage nothing." and demo rules' Retire/Re-add/verdict actions are accepted but never stage a write (`created_by = 'demo'` guard in `stagePendingWrite`).

## 6. The paired test (Phase B), finally

The owner: "I want a clean way of proving it worked and I should be able to see it, otherwise we just let the user decide." Design as approved in round 4 §3, made concrete:

**Trigger.** On any suggestion or rule that came from a real episode (has the original request message id), a button **"Test this rule"** (on the card's action bar; "Test it first" in the Add dialog becomes this same path). The confirm dialog says: what will happen in one paragraph; "Uses Lovable credits like any build; the exact cost is recorded after."; "This month: N credits used of your budget of B"; "One test runs at a time." Confirm = **Start test**. The owner starts the first one.

**Run (executor beat `runExperiment`, in the app process, background job with progress):**
1. `remixInit(project, { message_id: episode.request.external_id, remix_mode: "before", include_history: false, include_custom_knowledge: false, skip_initial_remix_message: true, project_name: "Harness test: <rule title, 40 chars>" })` → poll `remixProgress` until the copy exists (max 5 min). Status "Copying the project at the moment before your request".
2. Set the copy's project Knowledge = the Knowledge snapshot at or before the episode's start (else the current one) **plus** the rule in the managed block; workspace Knowledge is inherited by the copy as-is (documented).
3. `chat(copy, episode.request.text)` → poll `getMessage` every 20 s until `completed | stopped | awaiting_input | timeout | error` (max 15 min). Status "Building in the copy (2 min)".
4. Record `experiment_runs`: copy id, message/thread ids, `commit_sha`, `summary`, `content` (human-visible), `cost_credits`, diff (`getDiff` by message_id, capped 400 lines), started/finished, status.
5. `deleteProject(copy)` unless setting `keep_test_copies` (default off); on failure, set the copy private and list it under "Test copies to delete by hand" on the Projects page.
6. Credits: `credit_ledger(run_id, cost_credits, created_at)`; `lovable_monthly_credit_budget` (default **12**); refuse to start when `month_total + last_known_cost (default 2)` > budget; one run at a time (`experiment_runs.status = running` lock, 20-minute crash window).

**Judge (the owner).** The card shows "Your verdict is needed" → the judging screen: left = *your original build* (the episode's request, Lovable's human-visible reply, the diff of the original commit via `getDiff(message_id)`, and each correction you made), right = *the build with the rule* (summary, human-visible reply, diff, cost). Under each original correction: **Still needed? Yes / No / Unclear**. Save → score = no ÷ corrections; the card reads **"Tested: 2 of 3 corrections no longer needed · judged by you"**; History gets a `test` node with both diffs; Settings › Evidence enables "Paired tests" once one exists and `rule_health` counts a passed test as evidence for keeping (a failed one, score 0, as one hurt). "Add it now" / "Remove from Knowledge" available from the result.

**Confounders, stated on the judging screen:** "This copy started from the project as it was before that request; N edits have landed since" (from `/edits` after the episode); "One build; evidence, not proof."

**Tests:** the REST client and the runner are tested against a fake REST server (a local `http` server returning scripted JSON for each endpoint) covering: happy path, remix timeout, build `error`, budget refusal, delete failure → private + listed, one-at-a-time lock. **No test touches Lovable.** The first real run is the owner's press.

## 7. "Ready to share" checklist (what a Lovable reviewer must be able to do on the owner's project)

1. Connect, Sync now → real messages and Knowledge shown (done today).
2. Analyse now with Claude Code → at least one real suggestion with evidence (needs the provider switched; next).
3. Add to project → "Written to Lovable" within seconds, visible in Lovable (done today by hand; §2 makes it the button).
4. Undo / Remove / Re-add → each reflected in Lovable and in History.
5. Test this rule → a copy builds, the judging screen shows both builds, a verdict lands on the card.
6. Nothing on screen says "next sync", "improvement", "miner", or a credit number that was not measured.

## 8. Tasks (Sonnet unless noted; no migration outside Task 1)

1. **Schema v12 + lock + REST client** — `experiment_runs`, `credit_ledger`, settings `lovable_monthly_credit_budget` ("12"), `keep_test_copies` ("false"); `rule_verdicts` upsert semantics (`recordRuleVerdict` updates the rule's current verdict; history only on change); `harness/src/executor/lovable-rest.ts` (getProject, listMessages, getMessage, listEdits, getDiff, remixInit, remixProgress, chat, setProjectKnowledge, deleteProject, setProjectVisibility) with the fake-server test harness; `harness/data/executor.lock` helper.
2. **Inline writes and inline sync** — `executeVersionNow(versionId)` and `syncNow()` in `harness/src/executor/beats.ts` callable from the routes; `improvementAction` accept/retire/readd/restore/change_wording call it when connected and return `{ written: true, at } | { written: false, reason }`; knowledge route `sync_now` runs inline; copy changes ("Written to Lovable", reasons); scheduler-in-app with the lock; sidebar connection line. Structural test: no page contains "next sync".
3. **Undo / Cancel / Remove** — actions and UI per §3; Restore removed from cards.
4. **Card layout + verdict control** — §4 for `DecisionCard`, `CompactDecisionCard`, detail, Instructions table menu.
5. **Demo isolation** — §5.
6. **Paired test runner + judging screen + credit ledger** — §6 (largest; may split into 6a runner/beat and 6b UI).
7. **Verification** — the owner's project: Sync now, Add/Undo/Remove round-trip on rule 1 (writes are free; the owner has authorised them), then the owner presses Test this rule once.

## 9. Owner decisions recorded

- Free actions call Lovable immediately from the app; the separate executor process is optional.
- Credits: budget 12 per month, one test at a time, delete copies after judging (setting to keep). The owner presses the first test.
- Restore only on History; Remove from Knowledge on cards; Undo before anything is written.
- Demo data was removed today and must never again feed a real write.
