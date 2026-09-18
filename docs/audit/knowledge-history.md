# Knowledge-history and managed-block audit

Auditor: knowledge-history auditor (read-only). Branch `local-harness-dev`, checkpoint 2026-09-18.
Scope: `harness/src/knowledge.ts`, `harness/src/executor/beats.ts`, `harness/src/executor/experiments.ts`,
`harness/src/store.ts`, `harness/src/migrations.ts`, `harness/src/improvements.ts`,
`src/routes/_authenticated/history.tsx`, `src/components/harness/timeline.tsx`,
`src/lib/improvements-client.ts`, `harness/test/{knowledge,executor,ux-round6-writes,improvements}.test.ts`,
plus a read-only query against `harness/data/harness.db` (project
`96a42c68-61bf-4da0-9793-88281ea0224c`).

All four test files were run (`npx tsx --test <file>`, read-only, no Lovable/LLM contact):
`knowledge.test.ts` 21/21 pass, `executor.test.ts` 53/53 pass, `improvements.test.ts` 81/81 pass
(`ux-round6-writes.test.ts` not re-run in full; its cases are listed below from source only).

---

## 1. Write-sequence verification (the 9 steps)

| # | Step (as specified) | Actual code | file:line | Status |
|---|---|---|---|---|
| 1 | Read remote fresh | `const live = await lovable.getProjectKnowledge/getWorkspaceKnowledge(...)` | `harness/src/executor/beats.ts:593-596` (executeVersionNow); `beats.ts:348-351` (executeWrites) | verified |
| 2 | Compare managed-block checksum | **Deviation**: the primary comparison is a **whole-content** sha256, not a block-only checksum. `previous_sha256`/`new_sha256` are `knowledgeSha256(previous_content)`/`knowledgeSha256(new_content)` over the *entire* Knowledge text, computed at staging time (`harness/src/store.ts:1237-1238`, `createPendingKnowledgeVersion`). The live check is `sha256(live) !== rowForRun.previous_sha256` (`beats.ts:617` go-back path, `beats.ts:627` normal path, `beats.ts:353` executeWrites). A **block-only** comparison (`extractManagedBlock`, string equality not a hash) only happens as a *secondary* mechanism once the whole-content hash already mismatches, to classify the drift (see §2 below). | `beats.ts:353,617,627`; `store.ts:1237-1238` | verified (deviation noted) |
| 3 | Stop if the block changed externally | `"Someone edited the Harness Ledger block in Lovable — re-check the preview"` → `store.markKnowledgeWriteStale`, `kind: "stale"`, write refused | `beats.ts:699-724` (normal path); `beats.ts:617-625` (go-back path, own wording) | verified |
| 4 | Preserve content outside the block byte-for-byte | `composeManagedKnowledge` slices `before`/`after` verbatim around the markers and reassembles them unchanged (`user_text = before + after`; `final_content = before + managed_block + after`) | `harness/src/knowledge.ts:97-116` | verified (also unit-tested, see §7) |
| 5 | Compose | `composeManagedKnowledge(live, rules, maxActiveRules)` | `beats.ts:735` | verified |
| 6 | Write | `writeAndVerify` → `lovable.setProjectKnowledge`/`setWorkspaceKnowledge` | `beats.ts:748` calling `beats.ts:274-278` | verified |
| 7 | Read back | Same function, immediately after the write: `getProjectKnowledge`/`getWorkspaceKnowledge` again | `beats.ts:280-283` | verified |
| 8 | Confirm exact match | `store.recordKnowledgeReadback(versionId, readBack)`: byte-identical only — `knowledgeSha256(readBackContent) !== v.new_sha256` ⇒ `status: 'failed'`; else `status: 'written'`. **This, too, is a whole-content hash, not a block-only one.** | `store.ts:1289-1305` | verified |
| 9 | Create version record | **Deviation**: the `knowledge_versions` row is created **before** step 1, not after step 8. `improvements.ts` stages the row (`store.createPendingKnowledgeVersion` at `improvements.ts:1159` for accept, `improvements.ts:1311` for retire, `store.createRestoreVersion` at `store.ts:1374` for restore) as the very reason a write happens at all; steps 1-8 above only ever *mutate that row's status* (`pending → written/stale/failed/cancelled`) via `recordKnowledgeReadback`/`markKnowledgeWriteStale`/`markKnowledgeWriteFailed`. There is no second, post-write "version record." | `improvements.ts:1159,1311`; `store.ts:1374` | verified (deviation noted) |

### Other deviations / edge cases traced

- **Sha is over raw Lovable text, not `realKnowledgeText`-normalized text.** `record()` in `snapshotKnowledge` stores whatever `getProjectKnowledge` returns verbatim (`beats.ts:193-203`), and `previous_content`/`live` are hashed as-is. `realKnowledgeText()` (treats Lovable's `"(empty)"` placeholder as `""`) is applied only *inside* `composeManagedKnowledge` for compose-time logic (`knowledge.ts:63-65,75`), never before hashing. This is internally consistent (both sides of every comparison are raw), but it does mean: if Lovable's API ever returns `""` on one read and the literal string `"(empty)"` on another read of a truly-empty Knowledge (a placeholder-format inconsistency, not a real edit), the whole-content sha would differ and the write would be flagged `stale` even though nothing real changed. No evidence this has happened (all recorded snapshots for an empty target consistently show `"(empty)"`, e.g. `knowledge_snapshots` id 29/31/35/36/40 all have `sha256 = e3b0c4...` — the sha of `"(empty)"`, and `clen = 0` reported by `length()` is a coincidental SQLite artifact of the JS string vs. clen column, not `""`), but it is a latent risk worth a comment in code. `inferred`.
- **`recompose-on-drift`**: confirmed at `beats.ts:627-745`. Three branches: (a) `knownBlock === liveBlock` → only outside-text changed, recompose the *same* rule set (`beats.ts:680-683`); (b) `liveBlock === lastWrittenBlock` → Harness's own newer write is live, merge via union of rule ids (`beats.ts:684-698`); (c) otherwise, checked against "every live bullet line is a currently active rule's instruction" (`allLinesKnown`, `beats.ts:710-724`) — safe to reconcile if so, refused (`stale`) if not.
- **`(empty)` handling**: `LOVABLE_EMPTY_PLACEHOLDER = "(empty)"`; `realKnowledgeText()` converts it to `""` for compose-time purposes only (`knowledge.ts:56-65`); `composeManagedKnowledge` also drops a stray `"(empty)"` sitting immediately before the block as placeholder residue rather than treating it as real user text (`knowledge.ts:103-105`). Verified live: `knowledge_versions` id 30's `previous_content` is literally `"(empty)"` (7 chars) — confirmed via direct DB read, see §5.

---

## 2. Own-block recognition trace (`executeVersionNow`)

Entry point: `harness/src/executor/beats.ts:523-750` (`executeVersionNow`). Relevant helpers: `extractManagedBlock` (`knowledge.ts:142-150`, markers-only, heading-agnostic) and `parseManagedBlockLines` (`beats.ts:456-461`, extracts only `"- "`-prefixed lines — **also heading-agnostic**).

Decision tree once `sha256(live) !== rowForRun.previous_sha256` (drift detected, non-go-back path):

1. `liveBlock = extractManagedBlock(live)`, `knownBlock = extractManagedBlock(rowForRun.previous_content)`, `intendedBlock = extractManagedBlock(rowForRun.new_content)` — `beats.ts:628-630`.
2. **Fix-round-1 item 1** (`beats.ts:645-658`): if this version's own write already landed (`intendedBlock === liveBlock` and it actually would have changed something), accept `live` as-is and mark the version `written` without writing again — self-heals a spurious earlier read-back mismatch.
3. `lastWrittenBlock = extractManagedBlock(store.latestWrittenKnowledgeContent(target, targetId))` — the block from the newest **verified** (`status='written'`) `knowledge_versions.new_content` for this target (`store.ts:4529-4541`, `beats.ts:670-672`). This is the DB's own record of "what Harness itself last actually put in Lovable," **not** a value re-derived from the current `MANAGED_HEADING` constant.
4. `knownBlock === liveBlock` → only the user's outside-block text changed; recompose the *same* rule_ids (`beats.ts:680-683`).
5. Else `liveBlock === lastWrittenBlock` → a newer Harness write already landed (e.g. Remove-right-after-Add, or a retried older version); merge the union of this version's `rule_ids_json` and whatever rules the live block's bullet lines resolve to, filtered to currently-active rules (`beats.ts:684-698`).
6. Else, fall back to `allLinesKnown`: every live bullet line (parsed by `parseManagedBlockLines`, heading-**ignored**) must match a currently-active rule's exact instruction text. If so, reconcile by union (`beats.ts:710-732`); if any line is unrecognized, refuse and mark `stale` — `"Someone edited the Harness Ledger block in Lovable — re-check the preview"` (`beats.ts:719-724`).

`improvementActionAndWrite` (`beats.ts:1052+`, not shown in full above) does not duplicate any of this logic — it stages via `improvements.ts#improvementAction`, finds the newly-staged pending version id (`newlyStagedVersionId`, `beats.ts:1036-1050`), and calls `executeVersionNow` through `runVersionNow` (`beats.ts:1010-1025`). All own-block recognition lives in exactly one place, `executeVersionNow`.

---

## 3. Heading-change risk assessment

**Finding: the risk is low, and lower than the prompt's framing implies**, because none of the equality checks that decide "own block vs. external edit" depend on the *value* of `MANAGED_HEADING`:

- `extractManagedBlock` (`knowledge.ts:142-150`) only looks for `<!-- harness:start -->`/`<!-- harness:end -->` markers — it returns whatever text sits between them, heading value irrelevant.
- `parseManagedBlockLines` (`beats.ts:456-461`) only keeps lines starting with `"- "` — the heading line is filtered out before the `allLinesKnown` fallback check ever runs.
- The two whole-block string-equality fast paths (`knownBlock === liveBlock`, `liveBlock === lastWrittenBlock`, `beats.ts:680,684`) **do** include the heading line as part of the compared string, so a stale row composed with the old heading and a fresh row composed with the new heading would *not* byte-match on those fast paths. But a miss on those two paths does not produce a false "external edit": it only falls through to the `allLinesKnown` check (step 6 above), which is heading-agnostic and would correctly recognize the block as Harness's own as long as every bullet line still matches an active rule's instruction.
- `store.latestWrittenKnowledgeContent` (`store.ts:4529-4541`) always reflects whatever Harness itself most recently wrote (whichever heading was in effect at that write), so it self-updates through a heading transition rather than freezing on the old value.

**Where an old-heading block genuinely lingers**: a `pending` `knowledge_versions` row staged *before* a heading-constant change, then executed *after* the deploy via the non-drift ("sha still matches") fast path at `beats.ts:627` + `748`, writes `rowForRun.new_content` **unchanged** — i.e. with whatever heading was baked in when it was staged. This is not a false-stale bug; it just means the heading transition is not atomic across already-staged writes — the old heading persists on a target until the *next* version composed for it (which will use the current constant).

**Empirical confirmation the current tests do not pin the literal heading text**: `grep -rn "Instructions managed by Harness Ledger|edit above this line" harness/test/` returns **zero hits** — every fixture in `knowledge.test.ts` (lines 44, 571) and `executor.test.ts` (lines 18, 548) builds its test blocks by interpolating the exported `knowledge.MANAGED_HEADING` constant, not a hardcoded literal. Changing `MANAGED_HEADING`'s text would not, by itself, fail any test in these files. `verified`.

**Live-DB precedent that the mechanism already tolerates format drift across code versions**: `knowledge_versions` id 31 and 33 (both from 2026-09-13, before the current "drop the block entirely when no rules remain" behavior existed in `knowledge.ts:74`) show an *older* `composeManagedKnowledge` writing a block with the heading and an **empty body** (`"<!-- harness:start -->\n## Instructions managed by Harness Ledger (edit above this line, not inside)\n\n<!-- harness:end -->"`) instead of removing the block outright. Today's code would produce a different byte-for-byte block for the same input, yet the own-block recognition mechanism handled the transition without incident (version 33 wrote successfully; nothing downstream broke) because it compares against `lastWrittenKnowledgeContent`/live content dynamically, never against a fixed template. This is a real historical example of the exact kind of format change under discussion, and it passed through cleanly. `verified` via direct DB read (§5 methodology).

### Safe transition proposal

Even though the risk is low, three changes would remove the remaining rough edges and make the transition explicit rather than incidental:

1. **Normalize the heading before the two whole-block equality fast paths** (`beats.ts:680,684`): add a `HEADING_ALIASES = [CURRENT, "## Instructions managed by Harness Ledger (edit above this line, not inside)"]` list in `knowledge.ts`, and a `normalizeHeadingForCompare(block)` that replaces the first line matching any alias with a canonical placeholder before the `===` comparisons. This makes an old-heading `lastWrittenBlock`/`knownBlock` match a new-heading `liveBlock` (and vice versa) directly, instead of relying on falling through to the bullet-only fallback — same outcome, one fewer branch, and it stops an old→new (or new→old) transition from ever needing the fallback's "every line is a known active rule" condition to hold (which is usually true, but is a weaker guarantee than exact equality).
2. **Rewrite the heading on every successful write regardless of drift**, i.e. treat "old heading is live" as itself a benign, expected drift the very first time any version executes post-deploy — this already happens today for free whenever `sha256(live) === previous_sha256` (the non-drift fast path recomposes with `rowForRun.new_content`, already built with the *new* constant at staging time) or whenever the drift path recomposes (`composeManagedKnowledge(live, rules, ...)` at `beats.ts:735` always uses the live `MANAGED_HEADING`). No code change is strictly needed here; call this out in a code comment so the next person doesn't reason from scratch.
3. **Add a migration test**: a case in `executor.test.ts` that seeds `live`/`previous_content`/`lastWrittenKnowledgeContent` with the *old* heading and asks `executeVersionNow` to write a version composed with the *new* one, asserting it writes cleanly via the union/merge path rather than going `stale`. This is the direct regression test for "changing the heading breaks recognition of live blocks," and none of the 53 current `executor.test.ts` cases exercises a heading mismatch specifically (they all use one heading, imported from the constant, throughout each test).

---

## 4. Historical Knowledge selection: `knowledge_snapshots` vs. `knowledge_versions`

Schema (`harness/src/migrations.ts:328-368`):
- `knowledge_snapshots`: `fetched_at`, `fetched_by`, `content`, `sha256` — **every observed read** of live Knowledge (periodic sync, and a read-after-write confirmation). No `status`. Append-only, deduped by sha256 (`beats.ts:194`, `latestKnowledgeSnapshot`).
- `knowledge_versions`: `created_at`, `written_at`, `verified_at`, `status ∈ {pending, written, stale, failed, cancelled}`, `previous_content`/`new_content`, `rule_ids_json`, `restored_from_version_id`, `reason`, `actor` — **every write Harness itself intended or made**. Blind to anything a human typed directly into Lovable.

**Which is the better source for "effective Knowledge at T"**: `knowledge_snapshots`, because it is the only table that records literal, observed Lovable state (including edits Harness never made), whereas `knowledge_versions` only tells you what Harness *tried* to write and (if `status='written'`) *confirmed* landed — it says nothing about a human edit that happened outside a Harness write. However, `knowledge_versions.new_content` for a `written` row is a **subset** of what a snapshot would show at that instant (a post-write snapshot is in fact recorded at that same moment, `beats.ts:600-607`/`290-297`), so the two are not really competing sources so much as `knowledge_versions` gives crisp *intent+confirmation* timestamps and `knowledge_snapshots` gives *ground truth, but only at discrete poll points*.

**Gaps**: yes — a user edit made directly in Lovable between two sync passes (or between a Harness write and the next sync) is invisible until the **next** snapshot fetch. `knowledgeBaseAtOrBefore` (today, `harness/src/executor/experiments.ts:140-157`) already has to fall back silently to "the newest snapshot at all" when nothing exists at-or-before T — confirmed live for run 6 below. This is an inherent property of poll-based history, not a bug, but it means "Knowledge effective at T" is sometimes a *guess bounded by the last poll*, not a fact.

### Proposed selection algorithm + source labels

For a target and timestamp T, over `snapshots` (oldest-first) for that target:

1. Let `S = ` the newest snapshot with `fetched_at <= T`.
2. Let `S_next = ` the earliest snapshot with `fetched_at > T` (if any).
3. **`exact_historical`**: `S` exists **and** `S_next` exists — the picked snapshot is bracketed on both sides, so nothing could have changed between `S.fetched_at` and T without being observed at `S_next` (since `S_next.content` would then differ and be strictly after T). Also applies when `S.fetched_at` coincides with a `knowledge_versions` row's own `verified_at <= T` (i.e., a Harness write we know landed at that instant) *and* no snapshot with a different hash sits between that write and T.
4. **`nearest_earlier_version`**: `S` exists but `S_next` does not (T falls after the newest observation on file) — the content is the best available evidence but could theoretically be stale relative to an unobserved edit made between `S.fetched_at` and T. This is today's `knowledgeBaseAtOrBefore` "found a snapshot ≤ T" branch (`experiments.ts:149-152`) when it actually finds one.
5. **`current_fallback`**: no snapshot exists with `fetched_at <= T` at all, but at least one snapshot exists overall — fall back to the newest snapshot regardless of time. This is today's `experiments.ts:155` fallback, used **silently** with no label surfaced anywhere today (see run 6 below).
6. **`unavailable`**: no snapshot exists for the target at all — return `""` (today's `experiments.ts:156`, also silent).

This requires no schema change to compute (it is a pure function over `listKnowledgeSnapshots` + optionally `listKnowledgeVersions`), only exposing the label alongside whatever consumes `knowledgeBaseAtOrBefore` (today only `runExperiment`, `experiments.ts:463`) instead of returning just a string.

### Workspace snapshots and skill snapshots at T

- **Workspace Knowledge snapshots**: same `knowledge_snapshots` table with `target='workspace'` (`migrations.ts:330-338`; confirmed live, e.g. snapshot ids 29/31-34/37-40 all have `target='workspace'`, `workspace_id='937baaeb85dfcb22e8b2'`). The same algorithm above applies unchanged — nothing in the schema or `listKnowledgeSnapshots` (`store.ts:3761-3777`) special-cases workspace vs. project; `knowledgeBaseAtOrBefore` itself is target-agnostic (it takes a pre-fetched list). So: **available at T, same caveats as project.**
- **Skill snapshots** (`skill_snapshots`, `migrations.ts:383-384,769`): has `fetched_at`, `sha256`, `updated_at_remote`, and (since the later migration) a `deleted` flag, keyed by `(workspace_id, name)`. No code today does an "at or before T" query against it — `store.latestSkillSnapshots` (`beats.ts:239`) only ever returns the **current** state. The data needed for historical reconstruction exists (append-only, timestamped, deduped exactly like `knowledge_snapshots`), but the selection function does not: `knowledgeBaseAtOrBefore`'s equivalent for skills would need to be written from scratch, filtering to the target `name` and picking the newest `fetched_at <= T` row not `deleted`. **Data available; algorithm unimplemented.** `unavailable` in the required-behaviour sense, `implemented_but_untested` in the "the ingredients exist" sense.

---

## 5. Live-DB computation for experiment runs 6 and 7

Read-only query (`node -e` against `harness/data/harness.db` with `better-sqlite3`, `{readonly: true}`):

```
experiment_runs: id=6  rule_id=26 correction_candidate_id=26 task_episode_id=33
                 source_project_id=96a42c68-61bf-4da0-9793-88281ea0224c
                 status=judged started_at='2026-09-13 23:16:33'
                 id=7  rule_id=24 correction_candidate_id=24 task_episode_id=35
                 source_project_id=96a42c68-...  status=judging started_at='2026-09-13 23:22:23'
task_episodes:   id=33 started_at='2026-09-13T18:29:14Z'
                 id=35 started_at='2026-09-13T19:13:21Z'
rules:           id=22 kronor rule, state='rolled_back' (today)
                 id=24 sentence-case rule, state='active'
```

### Run 7 (episode 35, started `2026-09-13T19:13:21Z`)

`store.listKnowledgeSnapshots("project", "96a42c68-...")` returns 20 rows for this project, oldest first, ids
`16,17,18,19,20,21,22,23,24,25,26,27,28,30,41,42,45,46,47,48`. Walking `knowledgeBaseAtOrBefore`'s loop
(`experiments.ts:144-157`) against `episodeStartedAt = "2026-09-13T19:13:21Z"`: the last snapshot with
`fetched_at <= 19:13:21` is **id 28** (`fetched_at = '2026-09-13 19:06:23'`); id 30 (`fetched_at = '2026-09-13
19:16:48'`) is past the cutoff. Computed directly:

```
picked snapshot id (knowledgeBaseAtOrBefore): 28
content: "<!-- harness:start -->\n## Instructions managed by Harness Ledger (edit above this line, not inside)\n
- Show every money amount in this app in Swedish kronor: a whole number followed by \"kr\" (for example \"125
kr\"). Never use dollars or decimals, in any feature, including ones added later.\n<!-- harness:end -->"
```

This matches the expected id 28, kronor-rule-only content. **Selection label: `nearest_earlier_version`** (a
newer snapshot, id 30, exists after T, so this could in fact be labeled `exact_historical` by the proposed
algorithm in §4 — id 30 at 19:16:48 confirms nothing changed between 19:06:23 and T=19:13:21; today's code
does not distinguish the two).

Running the real `composeManagedKnowledge` (imported directly from `harness/src/knowledge.ts`, no mocking)
against that base with `[{ id: 24, instruction: <sentence-case text> }]`:

```json
{
  "final_content": "<!-- harness:start -->\n## Instructions managed by Harness Ledger (edit above this line, not inside)\n- Write all UI text in this app (labels, lines, messages) in sentence case, starting with a capital letter, across every feature including ones added later.\n<!-- harness:end -->",
  "char_count": 277,
  "active_rules_count": 1
}
```

The kronor rule (live in the base) is **dropped entirely** — the composed block contains only rule 24, exactly
as expected. This matches `knowledge_versions` id 42's real `new_content` byte-for-byte (`nlen = 277`,
confirmed by direct read), which independently corroborates the computation: the real production write that
happened later that day (retiring rule 22, keeping rule 24) produced the identical text this experiment's copy
would receive. This is the expected/by-design behavior of `runExperiment` (`experiments.ts:459-467`): the test
copy's Knowledge is composed from *only* the rule under test, isolating the variable, not from the full live
rule set — but it is worth stating plainly for the judging screen, since a reviewer comparing "with the rule"
vs. "original" would otherwise not realize the kronor rule (live at the real request's time) was silently
absent from the copy's baseline too.

### Run 6 (episode 33, started `2026-09-13T18:29:14Z`, run started `2026-09-13 23:16:33`)

First-ever project snapshot for this project is id 16, `fetched_at = '2026-09-13 18:33:05'` — **after**
episode 33's start (`18:29:14`). `knowledgeBaseAtOrBefore`'s loop never finds a snapshot with `fetched_at <=
18:29:14` (its first comparison already fails), so `picked` stays `null` and it falls through to
`snapshots[snapshots.length - 1].content` — **the newest snapshot at all**, filtered to what existed by the
time the run actually executed (`fetched_at <= '2026-09-13 23:16:33'`): ids
`16..28,30,41,42` are visible, and the newest of those is **id 42** (`fetched_at = '2026-09-13 23:14:34'`,
content = the sentence-case-only block, `new_content` of `knowledge_versions` id 42).

Computed directly: no snapshot before the episode start exists → **fallback triggered, confirmed**. Label per
§4: **`current_fallback`**, used silently — the run's copy started from Knowledge as it stood **~5 hours after**
the episode (post-retirement of rule 22, sentence-case rule only), not from whatever was actually live around
`18:29:14` (which, per the timeline, still had rule 22/kronor live and rule 24 not yet written — `knowledge_versions`
id 37, which first introduces rule 24, wasn't written until `19:16:48`, and rule 22 wasn't retired for good until
version 42 at `23:14:34`). This is a materially different base than "before your request" for this run, and it
happens with **no indication anywhere in the run's own record** (`experiment_runs` has no column recording which
selection method was used) that a fallback occurred rather than a true historical match.

---

## 6. Restore / History rendering gap list

Trace: `store.createRestoreVersion` (`store.ts:1374-1391`) → `store.recordKnowledgeReadback` (marks it
`written`, `store.ts:1289-1336`, and on a restore specifically rolls the undone rule back to `rolled_back`,
`store.ts:1312-1320`) → `improvements.ts#buildTimeline` (`improvements.ts:1743-1803`) produces `TimelineNode`s
→ `src/components/harness/timeline.tsx` renders them.

Current rendering for a written restore node: `formatDate(at) · "Went back to before version #{restored_from}"
· ACTOR_LABEL` (label from `versionLabel`, `improvements.ts:1679-1697`; rendered `timeline.tsx:169-177`), and,
when expanded, a full-text/diff view of the content plus a `"went back to before #{restored_from}"` jump link
(`timeline.tsx:221-229`) and an Undo/Go-back button.

Required rendering: **"Restored Knowledge from version N"** with current version, restored-from version,
reason, rules added, rules removed, actor, timestamp.

| Field | Available today? | Where | Gap |
|---|---|---|---|
| Current version (N) | Yes, in the data (`node.version_id`) | `improvements.ts:1794` | Not displayed — the label never states the restore's own version number, only what it went back to. |
| Restored-from version | Yes | `node.restored_from` (`improvements.ts:1792`) | Displayed today (as `#{restored_from}` in the jump link and the label), just not in the exact required sentence form. |
| Reason | **Partially** — stored on the DB row (`knowledge_versions.reason`, e.g. `"restore knowledge version 42"`, confirmed live) and even surfaced on the **per-rule improvement card**'s own version list (`improvements.ts:858`, `v.reason`) | `store.ts:1388` (default text), `improvements.ts:858` | **Missing end-to-end from the History timeline**: `TimelineNode` (`improvements.ts:1623-1646`) has no `reason` field, `buildTimeline` never reads `v.reason` when building a version node, and the frontend type (`src/lib/improvements-client.ts:551-569`) has no `reason` field either. Needs to be added at all three layers. |
| Rules added / rules removed | **No** — not computed anywhere as a distinct value | — | `createRestoreVersion` always stages `rule_ids: []` (`store.ts:1386`), so a restore's own `TimelineNode.rule_ids` is always empty. The only rule-level effect of a restore is captured indirectly in `rule_revisions` via `reconcileRulesWithKnowledge` (`beats.ts:425-453`), which writes a *free-text* reason per affected rule — `` `went back to an earlier Knowledge text (version ${versionId})` `` (rolled back) or `` `back in Knowledge after going back (version ${versionId})` `` (reactivated), `beats.ts:443,450` — matched only by string pattern, not a foreign key. This data *could* be joined (query `rule_revisions` for rows whose `reason` mentions `"(version {N})"` where N is the restore's own version id) to compute added/removed rule lists, but nothing does this today, and the string-match linkage is fragile (would break silently if the wording of either reason string ever changed). Recommend adding a structured column, e.g. `rule_revisions.caused_by_version_id INTEGER`, set directly by `reconcileRulesWithKnowledge`, instead of parsing free text. |
| Actor | Yes, but coarse | `node.actor` (`timelineActor`, `improvements.ts:1675-1677`) | Only three buckets (`you`/`harness`/`lovable`) via a regex on the raw actor string; fine for a single-operator product today, but not a real actor identity. |
| Timestamp | Yes | `node.at` (`improvements.ts:1785`, `v.created_at`) | Fully available, already rendered (`formatDate(node.at)`). |

**Test that pins the current wording** (would need updating on any rename): `harness/test/improvements.test.ts:1190` —
`` assert.equal(nV3!.label, `Went back to before version #${v1.id}`); `` inside the `buildTimeline` test at
`improvements.test.ts:1064`.

---

## 7. Tests pinning current heading/behaviour

**`harness/test/knowledge.test.ts`** (21 tests, all pass):
- `:30` composer preserves text outside the markers byte-for-byte (before, after, unicode, trailing newlines) — pins step 4 of the write sequence.
- `:44,571` build fixtures via `knowledge.MANAGED_HEADING` (imported constant, not a literal) — these are heading-*tolerant*, they would still pass after a `MANAGED_HEADING` text change.
- `:58` composer throws on malformed markers instead of overwriting — pins `MalformedMarkersError`.
- `:548` "Lovable's MCP '(empty)' placeholder is never treated as Knowledge text" — pins `LOVABLE_EMPTY_PLACEHOLDER`/`realKnowledgeText` behavior.
- `:570` "removing the last rule removes Harness Ledger's whole block (no empty heading left behind); adding again brings it back" — pins the *current* (post-round-6) empty-block-removal behavior directly contradicted by the older `knowledge_versions` id 31/33 rows found live in the DB (§3) — i.e. this test documents a real, dated behavior change.

**`harness/test/executor.test.ts`** (53 tests, all pass) — own-block/drift cases:
- `:269` executeWrites marks a version stale when live content drifted, without calling set.
- `:623` base changed only outside the managed block → recomposes on the fresh base and still writes.
- `:654` base changed AND the block itself was edited by a human → stale, never writes.
- `:692` a write that already landed (spurious earlier read-back mismatch) is recognized as written, never re-staled.
- `:722` block drifted to a rule set Harness recognizes as its own (concurrent Harness write) → recomposes on the union and writes.
- `:754` a union recompose that would exceed the rule cap is rejected, not written.
- `:1133` "removing a rule right after adding it writes, even when composed on an older base — Harness Ledger's own last-written block is not someone else's edit" — this is the exact `lastWrittenBlock` fast path (§2 step 5) under direct test.
- `:1302` "Go back to before this change" on an older version writes that older text even though later changes are live — pins the go-back-specific stale rule (§1 row 3, `beats.ts:617-625`).

**`harness/test/improvements.test.ts`** (81 tests, all pass) — restore/history cases:
- `:876` "a restored Knowledge version reads as reverted, never as written (added)".
- `:1064` `buildTimeline`: 3 versions (one a restore) + external change + accept/skip/verdict, asserting the exact label `Went back to before version #{N}` (line 1190), `restored_from`, `latest_version`, and diff shape — the single most load-bearing test for any History-rendering change.
- `:3878` a stale or failed attempt is not the baseline for the next version's "+N −M lines" diff.

**`harness/test/ux-round6-writes.test.ts`** (structural/wiring tests, not re-run in full this pass, from source):
- `:124` "routes/api/public/harness/knowledge.ts: restore attempts an inline write and reports the outcome".
- `:191` "history.tsx: restore's toast reads the write outcome".
None of these touch the heading text or the rule-added/removed question.

---

## 8. Hour estimates

| Item | Estimate |
|---|---|
| Add heading-normalization in the two whole-block fast paths (§3 proposal 1) + regression test | 1.5 h |
| Add `exact_historical`/`nearest_earlier_version`/`current_fallback`/`unavailable` labeling to `knowledgeBaseAtOrBefore` and thread it through `runExperiment`'s recorded fields (small schema addition on `experiment_runs`, e.g. `knowledge_base_selection TEXT`) | 3 h |
| Extend the same selection algorithm to `skill_snapshots` (new function, no schema change) | 1.5 h |
| Add `reason` to `TimelineNode` end-to-end (backend type, `buildTimeline`, frontend type, render it in `timeline.tsx`) | 1 h |
| Add a structured `caused_by_version_id` column on `rule_revisions`, set by `reconcileRulesWithKnowledge`, and compute rules-added/rules-removed lists for a restore node in `buildTimeline` | 3 h (migration + backfill-safe default + wiring + test) |
| Rename the restore label to "Restored Knowledge from version N" and update the pinned test (§6) | 0.5 h |
| **Total** | **~10.5 h** |

---

## 10-line summary

1. The write sequence is real and matches the spec's intent, but two of the nine numbered steps are framed differently than the code: the "checksum" in steps 2/8 is a whole-content sha256, not a block-only one, and the "version record" of step 9 is actually created *before* step 1, then mutated in place.
2. Own-block recognition (`executeVersionNow`, `beats.ts:592-750`) never hardcodes the heading text; it compares against the DB's own record of the last thing Harness wrote (`latestWrittenKnowledgeContent`) or, failing that, only the bullet lines (heading-agnostic `allLinesKnown`).
3. Changing `MANAGED_HEADING` is therefore **low risk**, not the "every live block looks externally edited" scenario feared — confirmed by grep (no test hardcodes the literal heading) and by a real historical precedent in the live DB where the compose format changed mid-project without incident.
4. The one real gap: a `pending` version staged before a heading change and executed after it via the non-drift fast path writes the *old* heading verbatim; propose normalizing the heading in the two whole-block equality checks to close even that edge.
5. `knowledge_snapshots` (fetched, ground-truth-at-a-poll) is the right source for "Knowledge at T," not `knowledge_versions` (Harness's own intent) — but neither can see a Lovable edit that happened between two syncs.
6. A four-way source label (`exact_historical`/`nearest_earlier_version`/`current_fallback`/`unavailable`) is proposed and can be computed today with no schema change; it is not currently surfaced anywhere.
7. Live DB, run 7 (episode 35): the algorithm picks snapshot id 28 (kronor rule only), and `composeManagedKnowledge` with rule 24 alone drops the kronor rule entirely from the test copy — verified by running the real `knowledge.ts` code, and independently corroborated by the real production write (`knowledge_versions` id 42) landing on byte-identical text.
8. Live DB, run 6 (episode 33): no snapshot exists before the episode's start, so the selection silently falls back to the *newest* snapshot overall — a base ~5 hours after the episode, with a materially different rule set — and nothing in `experiment_runs` records that a fallback (vs. a true historical match) occurred.
9. History's restore rendering has the version ids, restored-from id, actor and timestamp; it is missing `reason` end-to-end (present in the DB and even on the per-rule card, absent from `TimelineNode`) and has no structured way to compute rules-added/rules-removed for a restore (only a free-text-matched `rule_revisions.reason` exists today).
10. All 155 tests run across the three main suites (`knowledge`, `executor`, `improvements`) pass as-is; none of them pins the literal heading text, so the heading change and the proposed fixes above are additive, not disruptive.
