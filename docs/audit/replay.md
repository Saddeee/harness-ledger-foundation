# Replay and experiment integrity audit (orchestrator, 2026-09-18)

Traced by the orchestrator directly in `harness/src/executor/experiments.ts`, `harness/src/knowledge.ts`,
`harness/src/improvements.ts` and the live SQLite file (read-only). Status labels per `docs/audit/README.md`.

## 1. What one "Test this rule" run actually does (verified)

| Step | Code | What happens | Lovable cost |
|---|---|---|---|
| Resolve REST message id | `experiments.ts:204-233` | Pages the source project's messages (free read) | none |
| Copy A ("with the rule") | `experiments.ts:417-424` | `POST remix/init` `remix_mode: "before"`, `include_history: false`, `include_custom_knowledge: false` | no builder credits |
| Knowledge for copy A | `experiments.ts:460-467` | `knowledgeBaseAtOrBefore(snapshots, episode.started_at)` then `composeManagedKnowledge(base, [candidate])` | none |
| Build in copy A | `experiments.ts:475-506` | `rest.chat(copy, original request)`; polls until terminal | **one Lovable build, credits recorded from `cost_credits`** |
| Record | `experiments.ts:509-565` | summary, reply (tool blocks stripped), diff (400-line cap), cost, source commit/summary/diff, edits since | none |
| Copy B ("original build", optional, default on) | `experiments.ts:571-602` | `remix/init` `remix_mode: "including"`, no chat | no builder credits |
| Screenshots | `experiments.ts:604-613` | polls `latest_screenshot_url` for the commit of each copy | none |
| Cleanup | `experiments.ts:648-685` | deletes both copies only when `keep_test_copies` is `"false"`; failed runs force-delete; delete failure → set private + note | none |

**Conclusion (verified): this is a historical replay.** There is exactly one new Lovable build per run.
The "original build" column is a free remix of the historical commit, not a fresh control. Nothing in code
runs a fresh control arm. UI copy calling it a "paired test" and "both builds" is therefore misleading
(`src/lib/harness-ux.ts:644,656,664`, README §3).

## 2. Knowledge reconstruction (verified, with defects)

`knowledgeBaseAtOrBefore` (`experiments.ts:140-157`):

1. picks the newest `knowledge_snapshots` row with `fetched_at <= episode.started_at` (**nearest_earlier**), else
2. silently uses the **newest snapshot at run time** (**current_fallback**), else
3. `""` (**unavailable**).

Defects:

- **D1 — selection is not recorded.** `experiment_runs` has no column for which source was used
  (columns listed from `pragma table_info`: no knowledge/base/source column). The judging screen cannot say
  whether the replay used historical or current Knowledge.
- **D2 — current fallback is silent.** Live run 6 (rule 26, episode 33 started `2026-09-13T18:29:14Z`): the
  first snapshot for the project is id 16 at `18:33:05`, so no snapshot preceded the episode and the newest
  snapshot at run time (id 42, `23:14:34`, sentence-case rule only) was used as the base. The UI said nothing.
- **D3 — other rules live at the time are dropped.** `composeManagedKnowledge(base, [candidate])` rebuilds the
  managed block from *only* the candidate (`knowledge.ts:78-131`). Live run 7 (rule 24 sentence case, episode 35
  started `19:13:21Z`): nearest earlier snapshot is id 28 (`19:06:23`) whose block holds the kronor rule 22, which
  was live when the correction happened. The replay's Knowledge became "rule 24 only"; rule 22 was removed.
  So the replay did not reproduce the historical instruction state plus the candidate; it replaced it.
- **D4 — snapshots carry the `(empty)` placeholder** (ids 16–19); `realKnowledgeText` normalises it at compose time,
  so the composed result is right, but a snapshot-level "is the historical Knowledge empty or unknown" question
  cannot distinguish "empty" from "not fetched" without that normalisation.

## 3. Uncontrolled context (verified)

- **Lovable project memory** is copied as it is today (handoff §4b; `TEST_MEMORY_CONFOUNDER_LINE`,
  `harness-ux.ts:733`). Live run 7's copy came out in euros and lowercase although rule 27 (euros) was never
  written to Knowledge: those preferences reached the copy through Lovable's memory, not through Harness.
- **Workspace Knowledge**: the copy is created with `include_custom_knowledge: false` (project Knowledge only);
  Workspace Knowledge applies to every project in the workspace, so the copy sees *today's* Workspace Knowledge.
  Nothing reconstructs or discloses it. Live: workspace Knowledge was empty at run time (snapshot 40, len 0).
- **Skills**: workspace Skills apply to the copy as they are today. Not reconstructed, not disclosed.
  Live: no skills existed at run time (the e2e test skill had been deleted at 23:02:56).
- **Chat history**: `include_history: false` → the copy has no chat history. Disclosed only implicitly
  ("started from the project as it was before that request").
- **Code state**: `remix_mode: "before"` at the resolved request message → exact historical commit (verified by the
  Lovable REST contract in `lovable-rest.ts`; live runs 3–7 succeeded with it).
- **Lovable model/builder version**: not exposed by the API; not recorded.

## 4. Existing runs — classification

| Run | Rule | Status | Cost | Copies | Classification |
|---|---|---|---|---|---|
| 1, 2 | 1 (foundation) | failed at copy step | none | none | failed historical replay; **never retry** (request resolves to the 8.8k-char foundation brief) |
| 3 | 22 kronor | judged (score 0.5) | 0.6 | with-rule copy deleted | historical replay, no original copy; episode 33 (18:29) predates snapshot 16 (18:33) → **current_fallback** (newest snapshot at 18:56 was id 22, an empty block) → composed = rule 22 only |
| 4 | 24 sentence case | judged (score 0) | 0.3 | deleted | historical replay; base = snapshot 28 (19:06, rule 22) → composed = rule 24 only (rule 22 dropped) |
| 5 | 25 agent UI (Lumble) | judged (score 0) | 2.3 | deleted | historical replay; episode 36 (2026-09-02) predates every snapshot → current_fallback |
| 6 | 26 fonts | judged (score 0) | 0.5 | both deleted | historical replay; current_fallback (see D2); screenshots kept |
| 7 | 24 sentence case | judging (no verdict) | 0.8 | with-rule copy **kept** (`ee2b99af…`), original copy deleted | historical replay; base = snapshot 28 → rule 22 dropped; copy affected by later euro/lowercase memory |

Total recorded credits: 0.6 + 0.3 + 2.3 + 0.5 + 0.8 = 4.5 in `credit_ledger` (the handoff's 12.8 includes project
creation and chats outside Harness).

**No run had two fresh arms.** All are historical replays. Reclassify all as `historical_replay`.

## 5. Paired comparison feasibility (inferred from code + REST contract; not executed)

- Two independent copies from equivalent historical code: `remixInit(..., remix_mode: "before")` can be called
  twice for the same message id (`lovable-rest.ts`); nothing prevents it. **feasible**
- Independent Knowledge per copy: `setProjectKnowledge(copyId, ...)` per copy. **feasible**
- Same prompt to both: `rest.chat(copyId, requestFullText)` per copy; `allowCopy` guards each. **feasible**
- Source safety: `allowCopy` allow-list on `chat`; `deleteTestCopy` refuses the source id. **present**
- Cleanup: the same `cleanupCopy` path per copy; `experiment_resources` table exists (checkpoint C) but the current
  runner does not use it (table is empty live). **manageable**
- Disclosure: needs the environment record from §2/§3 for both arms. **must be built first**
- Stability: adding a second arm touches the single-run state machine (`status`, `copy_*` columns are singular).
  A clean design adds an `experiment_arms` table rather than more `copy2_*` columns. Estimated 1.5–2 days incl.
  fake-server tests; it cannot be verified live in this checkpoint (no credits may be spent).

**Recommendation:** do not implement paired comparison in this checkpoint. Build the environment record and
the historical-replay truth first (they are prerequisites for any comparison). Record the exact design and
blocker in DECISIONS.md and README "Next".

## 6. Resource lifecycle truth (verified)

- Projects created per run: 1 (with the rule) + 1 optional (original build copy, default on). Both via remix.
- Screenshots: captured after the build, for the latest commit of each copy; URLs on `screenshot2.lovable.dev`
  stored in `experiment_runs`; they survive copy deletion (the UI shows them with a note).
- Retention: `keep_test_copies` defaults to `"true"` (`settings` live row) → copies stay until the user presses
  "Delete copy". With the setting off, cleanup runs at the end of the run. Failed runs always delete.
- Deletion confirmation: `deleteProject` success sets `copy_deleted = 1`; there is no read-back that the project is
  gone (REST delete returning 2xx is trusted). Failure → set private + note; the note is one column shared by both
  copies (`copy_cleanup_note`), so a second failure overwrites the first note.
- `experiment_resources` / `safe_to_delete`: exists only in the Harness MCP + checkpoint-C model; the runner never
  registers resources there. The MCP audit covers whether arbitrary ids can be marked safe to delete.
- Source project: never chatted (`allowCopy`), never deleted (`deleteTestCopy` guard), Knowledge never written by
  the runner (`setProjectKnowledge` is only called with `copyProjectId`). **verified in code; live runs 3–7 confirm**.
