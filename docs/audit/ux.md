# UX copy audit — historical replay relabelling, instruction/history hierarchy, honesty gaps

Auditor: read-only pass over `src/`, `harness/src/`, `harness/test/ux*.test.ts`. No `mcp__lovable__*`/`mcp__harness__*`
calls made. Every claim below carries a `file:line` citation; where I inferred behaviour from names/comments only
without tracing the code path, it is marked `inferred`.

Context confirmed from `docs/HANDOFF.md`: the feature the codebase calls "paired test" / "the paired test (Phase
A)" (built in Round 6–7) is a copy-of-history-plus-one-new-build flow, not a fresh-control/fresh-treatment
comparison. That matches this brief's "historical replay" exactly. A **true** paired comparison (fresh control +
fresh treatment) does not exist anywhere in `src/` or `harness/src/`; the only trace of the phrase is a dead DB
enum value (see §5).

---

## 1. Inventory of user-visible strings that violate the required semantics

Each row: file:line, current string (or paraphrase for JSX with interpolation), exact replacement.

### 1a. "Paired test" / "both builds" / historical-replay mislabelling

| file:line | Current | Replacement |
|---|---|---|
| `src/lib/harness-ux.ts:410-412` (`PROVE_INTRO`) | `"Harness Ledger runs the same request twice in a temporary copy of this project, with and without the instruction, and shows you the difference."` | `"Harness Ledger shows your historical result (the build that actually happened) next to one new Lovable build made from the same starting point with this rule added, and lets you say whether the original correction would still be needed."` — **note:** this constant is exported but not imported/rendered anywhere in `src/routes` or `src/components` today (dead code kept "for later" — see the test at `harness/test/ux.test.ts:242`, titled "proof copy stays defined for later"). Fix it anyway; it is factually wrong even unused, and a later page could resurrect it. |
| `src/lib/harness-ux.ts:655-656` (`TEST_THIS_RULE_BODY`) | `"...You get both builds side by side as real Lovable projects you can open, compare and keep building on..."` | `"...You get the historical result and the new build side by side as real Lovable projects you can open, compare and keep building on..."` |
| `src/lib/harness-ux.ts:658` (`SHOW_ORIGINAL_LABEL`) | `"Also copy my original build so I can open both (free)"` | `"Also copy the historical result so I can open both — creating this copy uses no Lovable builder credits"` (drop the unqualified "(free)"; see §1b) |
| `src/lib/harness-ux.ts:663-664` (`TEST_FIRST_HELP`) | `"Nothing is added yet. Harness Ledger runs your original request again in a copy with this rule, you compare both builds, and you add it afterwards if it worked."` | `"Nothing is added yet. Harness Ledger replays your original request in a new copy with this rule, next to the historical result, and you add it afterwards if it worked."` |
| `src/components/harness/improvement.tsx:245-246` (comment, and the code above it) | `"compare both builds, and add it from the test afterwards"` | `"compare the historical result and the new build, and add it from the test afterwards"` |
| `src/components/harness/improvement.tsx:604` (comment) | `"whether the test also makes a free copy of the original build, so both builds can be opened side by side"` | comment only, but rename to avoid the same habit spreading: `"...so the historical result and the new build can be opened side by side"` |
| `src/routes/_authenticated/judge.tsx:330-331` (`BuildColumn` props) | `title="Without the rule"` / `subtitle="Your original build"` | `title="Historical result"` / `subtitle="What actually happened, shown via a free copy — no new build"` |
| `src/routes/_authenticated/judge.tsx:353-354` | `title="With the rule"` / `subtitle="The same request, built again with this rule"` | `title="Replay with rule"` / `subtitle="One new Lovable build from the same starting point, with this rule added"` |
| `src/routes/_authenticated/tests.tsx:41,46` (route meta description) | `"Every paired test you've run: status, results, and your own notes."` | `"Every replay you've run: status, results, and your own notes."` |
| `src/routes/_authenticated/tests.tsx:56` (`INTRO_LINE`) | `"Each test copies your project at the moment before a real request, adds one rule, sends the same request, and lets you judge both builds."` | `"Each test shows your project's historical result at the moment before a real request, next to one new Lovable build made from that same point with a candidate rule added, and lets you say whether the original correction would still be needed."` |
| `src/routes/_authenticated/tests.tsx:89-93` (`buildLinks`) | `label: "Original build"` / `label: "Build with the rule"` | `label: "Historical result"` / `label: "Replay with rule"` |
| `src/components/harness/local-settings.tsx:604` | `Paired tests{pairedTestsAvailable ? "" : " (judge at least one test first)"}` | `Replay with rule{pairedTestsAvailable ? "" : " (judge at least one test first)"}` |
| `src/components/harness/local-settings.tsx:293` (`LOVABLE_CREDITS_INTRO`) | `"Testing a rule in a temporary copy is a normal Lovable build and uses credits like one. Harness Ledger refuses to start a test that would put this month over the budget below."` | `"Creating project copies currently uses no Lovable builder credits. Running a Lovable build inside a copy consumes normal Lovable builder credits. Harness Ledger refuses to start a test that would put this month over the budget below."` |
| `harness/src/executor/experiments.ts:604` | `stage_note: "Waiting for screenshots of the builds"` | `stage_note: "Waiting for screenshots"` (only one side is a build) |
| `harness/src/improvements.ts:1712-1722` (`testedLabel`, History node) | `"Tested with the rule: X of Y corrections no longer needed"` | acceptable as-is (doesn't say "paired" or "both builds"); leave |

Comment-only (no test pins these, low priority, fix opportunistically since "paired" is now a banned frame):
`harness/src/executor/lock.ts:4`, `harness/src/executor/lovable-rest.ts:3,203`, `harness/src/adapter.ts:98,119,130,319`,
`harness/src/analysis/health.ts:257-270`, `harness/src/store.ts:1433,1648,2800,3930,3982,4203,4221,4349,4360,4378,4414,4485`,
`harness/src/executor/experiments.ts:2,57,194,291,568`, `harness/src/executor/experiments-actions.ts:20,43`,
`harness/src/executor/beats.ts:963,1013`, `harness/src/mcp-server.ts:361` (dead code, see §5),
`harness/src/migrations.ts:271,647,720,745`. None of these reach UI text; renaming them is pure code hygiene, not
required for truthful copy, and touches migration/comment history best left alone unless the team wants to do a
full terminology pass.

### 1b. Cost wording — "free" unqualified

Required: *"Creating project copies currently uses no Lovable builder credits. Running a Lovable build inside a
copy consumes normal Lovable builder credits."* Never "free" unqualified.

| file:line | Current | Fix |
|---|---|---|
| `src/lib/harness-ux.ts:658` | `SHOW_ORIGINAL_LABEL = "Also copy my original build so I can open both (free)"` | drop `(free)`; see §1a replacement above, or shorten to `"...(no Lovable builder credits used)"` |
| `src/components/harness/improvement.tsx:603` (comment) | `"whether the test also makes a free copy"` | comment, low priority, but say "a copy that uses no Lovable builder credits" for consistency |
| `src/lib/harness-ux.ts:678-679` (`TEST_THIS_RULE_CREDITS_LINE`) | `"Uses Lovable credits like any build; the exact cost is recorded after."` | Replace with the mandated two-sentence line verbatim: `"Creating project copies currently uses no Lovable builder credits. Running a Lovable build inside a copy consumes normal Lovable builder credits; the exact cost is recorded after."` |
| `src/lib/harness-ux.ts:413-414` (`proveCostLine`) | `"Uses Lovable credits like any build; the cost is recorded after the test."` | Same fix — this is the string actually live in the Add dialog's "Test it first" help text (`improvement.tsx:296`, confirmed live, not dead). |
| `src/components/harness/local-settings.tsx:293` (`LOVABLE_CREDITS_INTRO`) | see §1a | see §1a |
| `src/lib/harness-ux.ts:441-442` (`LANDING_CREDITS_LINE`) | `"...Syncing chats and writing Knowledge costs nothing. Testing a rule in a temporary copy is a normal Lovable build and uses credits like one..."` | `"...Syncing chats and writing Knowledge costs nothing. Creating a project copy to test a rule currently uses no Lovable builder credits; running the build inside that copy does, like any Lovable build..."` |
| `harness/test/ux-round5-evidence.test.ts:282-285` (structural check) | `"harness-ux.ts: no digit followed by 'credit'"` — enforces no hard-coded numbers next to "credit". Not violated; unrelated to the "free" issue but worth knowing this test exists before editing cost strings (don't accidentally introduce a literal number). | n/a |

### 1c. Rule observation — verdict question and adherence/observed lines

Required: replace `"Did this rule help?"` with `"Is this rule still useful?"` (Keep / Review / Retire / Not sure).
Replace the `"Followed in 0 of 3 builds it applied to"`-style line with two separately-labelled, non-causal lines:
`"Harness found the same issue in all 3 relevant builds."` and `"AI review marked the rule as not followed in 3 of
3 relevant builds."`

| file:line | Current | Note / fix |
|---|---|---|
| `src/components/harness/improvement.tsx:775-780` (`VERDICT_CHOICES`) | `{ value: "helped", label: "Yes" } / { value: "did_not_help", label: "No" } / { value: "not_sure", label: "Not sure" }` | **Not a copy-only change.** The three-way `helped/did_not_help/not_sure` enum is a DB CHECK constraint (`harness/src/store.ts:3415` `RuleVerdict`, `rule_verdicts` table) consumed by `recordRuleVerdict` (`store.ts:3431`), `computeHealth`'s retirement math, and the History `VERDICT_LABEL` (`harness/src/improvements.ts:1725-1729`). Moving to a 4-way Keep/Review/Retire/Not-sure requires a new migration (new CHECK constraint or a mapping layer), a decision on what "Review" *does* to health/retirement that "helped"/"did_not_help" didn't, and touches `verdictEffectLine`/`VERDICT_EFFECT_TEXT` (`harness-ux.ts:590-600`) and every test in the next table. Flagged in §7 as the one item that is not a small edit. |
| `src/components/harness/improvement.tsx:818` | `aria-label="Did this rule help?"` | `aria-label="Is this rule still useful?"` |
| `src/components/harness/improvement.tsx:834` | `<span>Did this rule help?</span>` | `<span>Is this rule still useful?</span>` |
| `src/lib/harness-ux.ts:568-572` (`VERDICT_TEXT`) | `helped: "helped"`, `did_not_help: "didn't help"`, `not_sure: "not sure"` | becomes `keep: "still useful"`, `review: "worth reviewing"`, `retire: "no longer useful"`, `not_sure: "not sure"` (pending the migration in the row above) |
| `src/lib/harness-ux.ts:640` (`evidenceSourceLines`, verdicts sentence) | `"Your verdict: you can say directly whether a rule helped, didn't help, or you're not sure, any time."` | `"Your verdict: you can say directly whether a rule is still useful, worth reviewing, or should be retired, any time."` |
| `src/lib/harness-ux.ts:608-616` (`adherenceLine`) | `` `Followed in ${adherence.followed} of ${total} builds it applied to · judged by AI, with quotes` `` | Split per the brief. Two independent, separately-sourced lines instead of one: (a) an **observed** line already exists and is honest (`healthLine`, `harness-ux.ts:548-558`, "N repeat corrections") — for the specific "found the same issue" phrasing requested, add a variant e.g. `` `Harness found the same issue in ${n} of ${total} relevant build${...}.` `` sourced from the repeat-correction count, not from adherence; (b) rewrite `adherenceLine` itself to attribute the judgment to the AI rather than stating it as fact: `` `AI review marked the rule as followed in ${followed} of ${total} relevant builds.` `` / `` `AI review marked the rule as not followed in ${broke} of ${total} relevant builds.` `` (choose the followed/not-followed sentence by whichever count is non-zero, or show both when both are non-zero) |
| `harness/src/improvements.ts:1725-1729` (`VERDICT_LABEL`, History nodes) | `helped: "You said this rule helped"` etc. | same 4-way remap as above, once the migration exists |

**Tests that pin this exact copy (must be updated with intent, not just to make them pass):**
- `harness/test/ux-round6-cards.test.ts:174,180` — asserts `role="group"`, `aria-label="Did this rule help?"`, and "the spec's exact Yes/No/Not sure buttons".
- `harness/test/ux-round5-evidence.test.ts:101-122` — pins `verdictLine` output (`"You said: helped, 5 Sep"`) and `adherenceLine` output (`"Followed in 5 of 6 builds it applied to · judged by AI, with quotes"`), plus the null-until-`followed+broke>0` gating behaviour (keep the gating, change the string).
- `harness/test/ux-round4-health.test.ts:42-79` and `ux-round5-evidence.test.ts:34-52` — pin that `healthLine` never says "helped"; keep this invariant, it already matches the "no causal claims" requirement.
- `harness/test/ux-round4-retire.test.ts:60-109` — pins `retireReasonSentence`/`retireSinceLine` health-object shape (`{ helped, hurt, applicable_tasks }`); the `helped` field name on `RetireLike.health` (`harness-ux.ts:479-484`) is untouched by the verdict rename (it's a different counter, from `rule_health.helped`, not the verdict enum) — don't conflate the two when editing.
- `harness/test/ux-round5-api.test.ts:88-114` — pins `"Went back to before version #"` (see §1d) and `verdict: z.enum(["helped", "did_not_help", "not_sure"])` on the API route schema (`src/routes/api/public/harness/improvements.ts`, not read in this pass but implied) — a verdict enum change must update this route's Zod schema too.

### 1d. History — restore wording and missing fields

Required: replace `"Went back to before version #44"` with `"Restored Knowledge from version 44"`; show current
version, restored-from, reason, rules added/removed, actor, timestamp.

| file:line | Current | Fix |
|---|---|---|
| `harness/src/improvements.ts:1693-1695` (`versionLabel`) | `` `Went back to before version #${v.restored_from_version_id}` `` | `` `Restored Knowledge from version #${v.restored_from_version_id}` `` |
| `src/components/harness/timeline.tsx:227` | `went back to before #{node.restored_from}` (the jump-to-source-version link text) | `Restored from version #{node.restored_from}` |
| `harness/src/executor/beats.ts:443` | `reason: "went back to an earlier Knowledge text (version ${versionId})"` | `reason: "restored Knowledge from version ${versionId}"` (this string is stored as the `reason` column value — see next row, it is currently captured but never displayed) |
| `harness/src/store.ts:1319` | `reason: "restored knowledge version ${v.restored_from_version_id}"` | already reasonably worded; keep, but see the display gap below |

**Fields required but not shown today**, even though the data already exists:
- **Reason**: `knowledge_versions.reason` is a real column (`harness/src/migrations.ts:444`) populated on every write (`store.ts:1319`, `beats.ts:443`, and the ordinary accept/retire/readd paths), but `TimelineNode` (`harness/src/improvements.ts:1623-1646`) never carries it, and `Timeline` (`src/components/harness/timeline.tsx`) never renders it. **Smallest fix**: add `reason: v.reason` to the pushed node at `harness/src/improvements.ts:1782-1797`, add `reason: string | null` to `TimelineNode`, render it under the diff/content block in `timeline.tsx` (near line 220).
- **Current version**: `latest_version` already exists on the node (`improvements.ts:1796`, `timeline.tsx` uses it only to choose the Undo/Go-back button label) but is never shown to the user as a "Current" badge. **Smallest fix**: render a small "Current" badge next to the node's label in `timeline.tsx` when `node.latest_version` is true.
- **Rules added/removed by name**: `rule_ids` is already on every version node (`improvements.ts:1766-1767,1792`) but only used to build the `Set<number> ruleIds` collected across the whole timeline (for the rules-list section further down, not read in this pass) — the per-node summary only ever shows a line-count diff (`"+N −M lines"`, `improvements.ts:1774`) or, for the very first version, `"N rule(s) added"` (`improvements.ts:1779`). **Smallest fix**: for later version nodes, resolve `versionRuleIds` (already computed at `improvements.ts:1766`) against each rule's current text and append `` `Rules: ${names.join(", ")}` `` to `summary`, or add a dedicated `rule_names: string[]` field to `TimelineNode` and render it as a chip list — cheaper than a line-diff-only summary and doesn't require the diff to be recomputed.
- **Actor / timestamp**: already shown (`timeline.tsx:170-176`, `ACTOR_LABEL`/`formatDate(node.at)`). No change needed.

**Tests to update:** `harness/test/ux-round5-api.test.ts:88` pins the literal string `"Went back to before version #"` — must change to `"Restored Knowledge from version #"` (or whatever exact wording is chosen) with intent, not just search-replace, since it's asserting the API/UI still emits this exact phrase.

### 1e. "SPEC.md" / "checkpoint" / "Claude Code" in UI copy

- **No violation found.** Every `checkpoint` occurrence is a migration name (`checkpoint_a_foundation` etc., `harness/src/migrations.ts:9,49,204,319,373,397,409`) or a code comment (`harness/src/mcp-server.ts:66,112,237,279,428`; `harness/src/store.ts:51,105,759,1046,1072,1400,1401,2974,3158`; `harness/src/improvements.ts:1,5`; `harness/src/adapter.ts:10,20`; `harness/src/web/server.ts:1`) — none reach `src/` UI strings.
- `harness/src/migrations.ts:70` mentions "a SPEC.md excerpt" only in a SQL comment describing the `history_items.kind='spec_excerpt'`/`provenance='spec'` enum values (Checkpoint B, `harness/src/migrations.ts:74-75`). These enum values are legacy from the pre-executor MCP-server pipeline; the current sync path only ever writes `kind='message'`/`provenance='lovable_mcp'` (confirmed by grepping `history_items` writers in `store.ts`). A `spec_excerpt` row is very unlikely to exist in a real database, but if one ever did, its raw JSON would surface only inside the collapsed "Developer view" (`improvement.tsx:1551-1582`) as an internal identifier, not literal "SPEC.md" prose — `inferred`, low risk, not worth a schema change.
- "Claude Code" appears only as the provider name (`local-settings.tsx:101,117,124-134,747,774,781`; `analyse-notice.tsx:232`) — this is explicitly allowed.
- An existing structural test (`harness/test/ux-round5-evidence.test.ts:287-292`) already enforces "no spec/checkpoint leak" but **only for four files**: `harness-ux.ts`, `instructions.tsx`, `improvement.tsx`, `local-settings.tsx`. It does not cover `judge.tsx`, `tests.tsx`, `history.tsx`, `timeline.tsx`, `decision-layout.tsx`, `projects.tsx`, `skills.tsx`, `ledger.tsx`, `inbox.tsx`, `index.tsx`, or `settings.tsx`. I greped all of those directly and found no leaks today, but the coverage gap means a future change could reintroduce one silently. **Recommend** widening the `for (const rel of [...])` list in that test as a cheap hardening step (not required by this brief, but cheap and directly adjacent).

---

## 2. `judge.tsx` — current section order vs required order

Current order (`src/routes/_authenticated/judge.tsx:283-493`):
1. Back links: "← Suggestion", "← Tests" (`:285-299`)
2. Project name + rule text as `<h1>` (`:301-306`)
3. If in-progress/failed: stage/fail line, else:
4. **"You asked Lovable"** section — the original request text (`:320-325`) *(≈ "original correction")*
5. Two-column grid: "Without the rule / Your original build" and "With the rule / same request, built again" (`:327-369`), each column self-contained with screenshot, "Open the app"/"Open in Lovable"/"Delete copy", Lovable's summary, Lovable's reply, and a collapsed diff (`DiffDetails`, `:131-145`) — summary/reply are **not** collapsed, only the diff is
6. Confounder disclaimers: copy-staleness, memory confounder, "one build; evidence, not proof" (`:371-375`)
7. If judged: `testedResultLine` + Add/Remove actions (`:377-401`); else: **"Still needed?"** heading + per-correction Yes/No/Unclear rows (`:402-436`) *(≈ "user verdict")*
8. **"Your feedback about this test"** free-text box (`:441-491`)

Required order: original correction → Historical result → Replay with rule → key difference → user verdict
("Would the original correction still be needed in the replay?" Yes/No/Unclear) → Replay environment summary
(Code state, Project Knowledge, Workspace Knowledge, Skills, Chat history, Candidate rule, Other active rules,
Uncontrolled context) with an environment-quality label → full technical details collapsed (full summary, reply,
diff, remote ids, raw verifier output, cleanup internals).

**Gaps against the required order:**

| Required section | Present today? | Gap |
|---|---|---|
| Original correction | Yes (`:320-325`, "You asked Lovable") | Position matches (comes first); rename not required, framing is already correct |
| Historical result | Yes, as "Without the rule" column | Needs relabel (§1a); position is concurrent-with, not after, Replay with rule — acceptable as a side-by-side pair if the required order is read as "these two are a unit," but the **order within** the pair (historical before replay) is already correct in the JSX (original_copy column comes first, `:328`) |
| Replay with rule | Yes, as "With the rule" column | Relabel only (§1a) |
| **Key difference** | **Missing entirely.** No summary of "what actually changed" exists outside the per-column diff (`DiffDetails`) and the confounder lines, which discuss *test validity*, not *outcome difference* | Needs a new section — smallest version: a one-line computed summary (e.g. diff line counts compared between columns, or a reuse of `testedResultLine`'s "no longer needed" framing) placed after both columns, before the verdict |
| User verdict | Yes, as "Still needed?" / per-correction Yes/No/Unclear (`:402-436`) | Wording differs from the mandated single-sentence framing ("Would the original correction still be needed in the replay?"); current is per-correction and phrased "would you still have had to make it with the rule in place?" (`:406-408`). Reword the intro sentence; keep the per-correction granularity (it's more precise, not a downgrade) |
| Replay environment summary (Code state / Project Knowledge / Workspace Knowledge / Skills / Chat history / Candidate rule / Other active rules / Uncontrolled context) with quality label | **Missing.** Only 3 free-text confounder sentences exist today (`testCopyConfounderLine`, `TEST_MEMORY_CONFOUNDER_LINE`, `TEST_ONE_BUILD_LINE`, `:372-374`) covering "edits since," "memory copied as-is today," and "one build ≠ proof." These are real, honest, and already non-causal — but they're prose, not the structured 8-row environment table the brief wants, and there's no environment-quality label at all | This is the largest net-new UI work in the whole audit. The three existing lines map to 2 of the 8 rows (Chat history / edits-since ≈ `testCopyConfounderLine`; Uncontrolled context ≈ `TEST_MEMORY_CONFOUNDER_LINE`). Code state, Project Knowledge, Workspace Knowledge, Skills, Candidate rule, Other active rules have no current UI surface on this page at all, though most of the underlying data exists elsewhere (Knowledge snapshot at episode time is already used to compose the copy's Knowledge, per `harness/src/store.ts:4203-4221`; "Other active rules" is queryable from the same rules table Instructions renders) |
| Full technical details, collapsed (full summary, reply, diff, remote ids, raw verifier output, cleanup internals) | **Partially present, not collapsed.** Summary (`:594-601`) and reply (`:602-607`) render inline, uncollapsed, in each `BuildColumn`. Diff is already collapsed (`DiffDetails`, `<details>`, `:136`). Remote ids: only shown as link `href`s (`copy.editor_url`/`preview_url`), never as visible text. Raw verifier output: **does not exist** — there is no verifier/judge model output distinct from the owner's own manual Yes/No/Unclear; `rule_adherence` (the AI Judge signal) is a *separate* mechanism scored elsewhere (Instructions page, `adherenceLine`) and is not surfaced on this page at all today. Cleanup internals: `copy_cleanup_note` exists (`src/routes/_authenticated/tests.tsx:321-323`, shown on the *Tests* page's "Test copies to delete by hand" section) but not on the judge page | Wrap summary + reply + diff + a new "remote ids" block (project id, run id) into one `<AdvancedDetails title="Full technical details">` per column, or one shared section under both. "Raw verifier output" has nothing to show today unless the brief means the AI adherence judgment for this same episode — worth asking rather than inventing a new verifier call (see §5) |

**Net:** judge.tsx already has 4 of 8 conceptual pieces in roughly the right relative order (original correction,
historical result, replay-with-rule, user verdict) and gets the "collapse the diff" instinct right once already —
but the environment summary is a wholesale new section, and "key difference" and "collapse everything else"
are smaller but still real additions.

---

## 3. `instructions.tsx` and `history.tsx` — current hierarchy vs required

### instructions.tsx

This page is a **table of active rules per target**, not a single-instruction detail page — the "Instruction
detail" the brief describes (current status → recommendation → primary action → active instruction → relevant
observations → test evidence → version history → full timeline/audit collapsed) is actually the **`ImprovementDetail`**
component (`src/components/harness/improvement.tsx:1365-1586`), reached by clicking a rule's link
(`instructions.tsx:180`, `Link to="/ledger" search={{ improvement: ... }}`) — the same detail view Suggestions uses.
`instructions.tsx` itself only has a per-row summary; I compare both below.

**instructions.tsx row layout today** (`RuleRow`, `:153-240`): Rule (text/link) → Status (`RULE_STATUS_LABEL`) →
Since (date) → Observed (`healthLine` + `VerdictControl` + `adherenceLine`) → "…" menu (Remove from Knowledge /
Open suggestion). Below the table: `RetiredRulesList` (collapsed `<details>`, `:276-310`), then `DetailSection`
"Full Knowledge text as Lovable sees it" (collapsed, `:365-369`), then a pending-write banner if any (`:371-394`).

This is already close to a status→observation→history hierarchy at the row level and doesn't violate the required
order in an obvious way (it's a table, not a linear document) — the one gap: **no "recommendation" or
"primary action" per row** beyond the "…" menu's Remove option; there's no equivalent of "here's what Harness
suggests you do about this rule" at a glance (that only appears for retirement proposals, which are separate cards
on Suggestions, not shown here at all).

### `ImprovementDetail` (the actual "instruction detail" page) — current order

(`src/components/harness/improvement.tsx:1424-1586`)
1. Back button + Previous/Next (`:1426-1452`)
2. `DecisionCard titleAs="h1"` (`:1454-1461`), which internally renders, top to bottom:
   - project name + group badge (`:1185-1200`)
   - **title + instruction blockquote** ("active instruction") — `:1222-1293`
   - `DecidedStatus` (`:1313`, calling into `:856-1033`): decision sentence ("current status"), `healthLine`
     ("relevant observations"), `VerdictControl`, `adherenceLine` (more observations), `TestStatusLine`
     ("test evidence" link), then the **action bar** ("primary action" + secondary actions) at the very end
3. divergence note, if any (`:1463-1467`)
4. `whyFor(classification)` — a "why Harness read it this way" sentence (`:1469-1471`) *(closest existing thing to
   "recommendation," but it explains classification, not "what to do")*
5. "What happened" — the evidence messages (`:1473-1488`)
6. `AdvancedDetails "Details"` (collapsed, `:1490-1583`): "How Harness Ledger read this" → "How Harness Ledger
   judges whether a rule helps" (evidence sources + quotes) → "Wording history" → "Knowledge versions" ("version
   history") → "Developer view" (raw JSON, further collapsed inside the already-collapsed section — "full
   timeline/audit")

**Current vs required, side by side:**

| Required | Current position |
|---|---|
| 1. current status | 3rd (inside `DecidedStatus`, after the instruction text) |
| 2. recommendation | Not really present as a discrete "what Harness recommends" element; closest is `whyFor` at position 4, which explains classification, not a recommendation |
| 3. primary action | Last (bottom of `DecidedStatus`'s action bar) |
| 4. active instruction | **1st** (title + blockquote render before status/actions) |
| 5. relevant observations | 3rd, interleaved with status (health/verdict/adherence all live inside `DecidedStatus`) |
| 6. test evidence | 3rd, interleaved (`TestStatusLine` inside `DecidedStatus`) |
| 7. version history | Inside the collapsed "Details" (`Knowledge versions`) |
| 8. full timeline/audit, collapsed | Innermost collapsed section ("Developer view") |

**Net:** the *instruction text* is shown first today, then status+recommendation-ish+action are all bundled
together in one block (`DecidedStatus`), then observations, then history buried under one "Details" disclosure.
The required order wants instruction to move to 4th place (after status/recommendation/action, not before), and
wants observations/test-evidence/version-history un-bundled into their own sequential sections rather than one
disclosure triangle. This is a real reordering, not just a copy change — but see §7: `decision-layout.tsx` already
ships unused `CurrentStatus`/`RecommendationCallout`/`PrimaryAction` components that match this exact required
shape (see below).

### history.tsx

Layout (`src/routes/_authenticated/history.tsx:126-191`): title → demo banner (if any) → target picker (buttons)
→ `Timeline` (one flat list, newest first). No per-item hierarchy beyond the single timeline; each node
(`Timeline`, `src/components/harness/timeline.tsx:150-269`) shows, when selected: full text or diff toggle →
restored-from link (if any) → "Open suggestion"/"Open comparison" links → the restore/undo button.

Required fields for History: current version, restored-from, reason, rules added/removed, actor, timestamp.
Actor and timestamp are already shown per node (`timeline.tsx:169-177`). Restored-from exists but is mislabelled
(§1d). Reason and rules-added/removed-by-name are **not rendered at all**, though the underlying data
(`knowledge_versions.reason`, `rule_ids_json`) already exists in the store — this is the single cheapest high-value
fix in the whole audit (see §1d and §7).

---

## 4. Nav pages vs redirects

From `src/routes/_authenticated/route.tsx:24-32` (`NAV` constant) and each route file:

**In the sidebar nav (8 pages):** Inbox (`/inbox`), Suggestions (`/ledger`), Instructions (`/instructions`),
History (`/history`), Tests (`/tests`), Skills (`/skills`), Projects (`/projects`), Settings (`/settings`).

**Routable but deliberately not in nav** (per the comment at `route.tsx:22-23`): `/scoreboard` (stub, "Rule
scores from real builds will appear here" — `scoreboard.tsx:22`), `/versions` (redirect, see below — actually
`route.tsx`'s comment lumps it with the stubs but it is in fact a pure redirect), `/demo` (stub, "Demo scenarios
will appear here" — `demo.tsx:20`, **not** the CLI demo-data feature, dead placeholder), `/jobs` (linked only from
Settings › Advanced, not checked in depth this pass). `/judge` is intentionally unreachable via nav (enforced by
`harness/test/ux-round6-test.test.ts:44-46`) — reached only from a card's status line or the Tests table.

**Pure redirects (no content of their own):**
- `/knowledge` → `/instructions` (`src/routes/_authenticated/knowledge.tsx:7-9`)
- `/versions` → `/instructions` (`versions.tsx:7-9`)
- `/overview` → `/inbox` (`overview.tsx:7-9`)
- `/improvements` → `/ledger` (`improvements.tsx:7-9`)
- `/suggestions` → `/ledger` (`suggestions.tsx:7-9`)

**Runtime-conditional pages** (same route, different component by `HARNESS_RUNTIME`): `/projects`
(`LocalProjects` vs `HostedProjects`, `projects.tsx:35`) and `/settings` (`LocalSettings` vs `HostedSettings`,
`settings.tsx:48`) — see §5, the hosted variants are the "claims capability not implemented" finding.

---

## 5. Capability claimed but not implemented

1. **Hosted autonomy (`HostedProjects` + `HostedSettings`).** `src/components/harness/hosted-projects.tsx:36-272`
   renders a fully interactive "Connect Lovable" / "Reconnect Lovable" / "Sync projects" flow, per-workspace
   "Write workspace Knowledge" / "Write Skills" switches, and per-project "Read" / "Write Knowledge" / "Replay"
   switches (`:178-260`) — with no disclaimer anywhere on the page. Per `docs/HANDOFF.md` §6: *"Hosted autonomy:
   Lovable rejected the hosted OAuth client ('Client Not Found'); the hosted Supabase half is a schema of the
   vision with no working pipeline; leave it."* This means, on any deployment where `runtimeQueryOptions` resolves
   to `mode !== "local"` — which includes any failed fetch to the runtime route, since
   `src/lib/improvements-client.ts:462` treats a non-OK response as `{ mode: "hosted" }` — the user sees a
   working-looking Connect/Sync/permissions UI that cannot actually connect to Lovable. Status: **exposed_but_unimplemented**
   (traced in code; the OAuth failure is asserted only in the handoff doc, not re-verified live in this pass —
   `inferred` for the live behaviour, `verified` for the code path existing and having no disclaimer).
   The "Write Skills" switch (`hosted-projects.tsx:190-198`) additionally claims a capability that doesn't exist
   even in local mode (see next item).
2. **Skill writes.** `src/routes/_authenticated/skills.tsx:32` states plainly and correctly: *"Harness Ledger
   reads your workspace Skills; it does not write them yet."* This page is honest. But `DESTINATION_LABELS`
   (`src/lib/harness-ux.ts:245-249`) still carries a `skill: "As a Skill"` entry, and `harness/src/improvements.ts:1039`
   accepts `destination: z.enum(["workspace", "project", "skill"])` at the API layer, throwing an honest runtime
   error if actually chosen (`harness/src/improvements.ts:1412-1415`: *"Adding as a Skill isn't available yet —
   choose this project's Knowledge or Workspace Knowledge."*). No UI control ever offers `"skill"` as a choice
   (`AddConfirm`'s only two buttons are `project`/`workspace`, `improvement.tsx:129-132`), so a user can never
   actually trigger this refusal — it's dead-but-honest plumbing, not a live false claim. Status:
   **implemented_but_untested** for the refusal path, **unavailable** for any UI to reach it. Relevant to item 7
   below: since "Skill" is a real (if refused) destination in the backend contract already, adding it as a visible,
   explained *option* is cheaper than it looks.
3. **True paired comparison (fresh control + fresh treatment).** Does not exist. The only surface trace is the DB
   enum value `paired_control_treatment` (`harness/src/migrations.ts:271`, `harness/src/store.ts:909`) which is
   in fact used for the historical-replay experiment (`harness/src/improvements.ts:1196:
   experiment_type: "paired_control_treatment"`) — i.e., the schema's own naming already conflates the two concepts
   this brief wants separated. This is an internal enum value, never rendered to a user, so it's not a UI-copy
   violation, but it is worth flagging: if a real fresh-control/fresh-treatment experiment is ever built, it cannot
   reuse this enum value without ambiguity. Separately, `harness/src/mcp-server.ts:361` has
   `experiment_type: z.enum(["treatment_only", "paired_control_treatment", "ablation"])` on a tool schema belonging
   to the legacy "Harness MCP server" (per handoff: *"the Harness MCP server Claude Code sessions used before the
   executor existed"*) — this server is not reachable from the web app at all (`inferred` from the handoff's own
   description; not traced to a live process in this pass). Status: **unavailable** (true paired comparison) /
   **inferred, likely dead** (the MCP server surface).
4. **Behavioural checks.** Confirmed **unavailable** per `docs/HANDOFF.md` §6 ("Behavioural checks against test
   copies (see 4b)") and §4b ("Proposed next step... `verification_definitions` tables already exist"). I traced
   `verification_definitions`/`verification_plans` in `harness/src/store.ts` and `harness/src/mcp-server.ts:279`
   ("Checkpoint C: verification and experiment planning") — the tables and a few CRUD helpers exist, but nothing
   in `harness/src/executor/experiments.ts` (the actual replay runner) calls them, and no UI page surfaces a
   "behavioural check" concept anywhere (`grep -i behavioural/behavioral` across `src/` returns nothing). Status:
   **unavailable**, matches the handoff's own "not built" list — no UI currently overclaims this, which is good;
   just confirming for completeness since the brief explicitly asks about it.
5. **Reviewer model / Scoreboard.** `/scoreboard` is an honest stub (`scoreboard.tsx:22`, "will appear here").
   Not a violation.

---

## 6. Structural tests that pin copy touched by this brief

(File → what it pins → why it must change with intent, not be weakened)

- **`harness/test/ux-round6-cards.test.ts:174-201`** — pins `aria-label="Did this rule help?"` and the exact
  Yes/No/Not-sure verdict buttons. Must become `aria-label="Is this rule still useful?"` and (pending the schema
  decision in §1c) four Keep/Review/Retire/Not-sure buttons.
- **`harness/test/ux-round5-evidence.test.ts:99-160`** — pins `verdictLine`'s `"You said: helped, 5 Sep"` output,
  `adherenceLine`'s `"Followed in 5 of 6 builds it applied to · judged by AI, with quotes"` output (and its
  null-until-`followed+broke>0` gating, keep that behaviour), the four `evidenceSourceLines` sentences (`:130-160`,
  the "Paired test: ... hasn't run for this rule yet" sentence at line ~644 of `harness-ux.ts` needs its label
  changed away from "Paired test"), and the Evidence section's four checkbox labels including `"Paired tests"`
  (`:237-274`) which must become the replay-with-rule label.
- **`harness/test/ux-round4-health.test.ts:36-94`** and **`ux-round5-evidence.test.ts:32-57`** — pin that
  `healthLine`/`retireSinceLine`/`retireReasonSentence` never say "helped." This invariant should be **kept**, not
  loosened — it already satisfies "no causal claims."
- **`harness/test/ux-round5-api.test.ts:88`** — pins the literal `"Went back to before version #"` string emitted
  by the API/version label. Must become `"Restored Knowledge from version #"` (exact wording per your final
  choice), and the same file's line 114 pins the verdict Zod enum (`z.enum(["helped","did_not_help","not_sure"])`)
  — a verdict schema change must update this too, plus whatever route file defines it (not opened in this pass;
  likely `src/routes/api/public/harness/improvements.ts`, referenced by the `improvements-client.ts` types).
- **`harness/test/ux-round6-test.test.ts:38-129`** — pins, verbatim: `TEST_THIS_RULE_TITLE`, `TEST_THIS_RULE_BODY`
  (contains "both builds," must change), `TEST_THIS_RULE_CREDITS_LINE` (must change per §1b), `"Still needed?"`
  and its Yes/No/Unclear options (question wording may change per §1a/§2, but the test currently only checks the
  literal substring `"Still needed?"` and the three option labels individually — check whichever new question
  text is chosen still satisfies or is updated alongside this test), and the NAV exclusion check for `/judge`
  (keep).
- **`harness/test/ux-round6-tests-page.test.ts:42`** — pins `INTRO_LINE`'s exact "both builds" sentence
  (`tests.tsx:56`). Must change together with the source string.
- **`harness/test/ux-decision.test.ts:86-94`** — pins `TEST_FIRST_HELP`'s exact string (contains "both builds")
  and asserts `proveCostLine()` is referenced in the Add-confirmation code path. Update the pinned string; keep
  the reference.
- **`harness/test/ux.test.ts:238-263`** — pins `PROVE_INTRO` and `proveCostLine()` verbatim, and separately
  asserts neither string (nor "Run proof") appears on any of the `PAGES` it iterates except the intentional
  `proveCostLine` use on the detail page. Update both pinned strings together; keep the "nowhere else" assertion.
- **`harness/test/ux-round5-evidence.test.ts:287-292`** — the spec/checkpoint leak detector. Not required to
  change for this brief, but see §1e: recommend widening its file list while touching this area anyway, since
  every file this brief touches is exactly the kind of file that check exists to protect.
- **`harness/test/ux-round4-retire.test.ts:60-109`** — uses `health: { applicable_tasks, helped, hurt,
  last_applicable_at }` as a fixture shape. This `helped` field is `rule_health.helped` (a build-outcome counter),
  **not** the verdict enum — confirm this is untouched by any verdict-enum migration before editing, since the
  names collide.

No test currently pins `judge.tsx`'s column titles ("Without the rule"/"With the rule") by exact string — only
`ux-round6-test.test.ts` checks for the presence of `BuildColumn`-adjacent constants like `testCopyConfounderLine`,
`TEST_ONE_BUILD_LINE`, `TEST_MEMORY_CONFOUNDER_LINE`, and the "Still needed?" text — so renaming the column titles
to "Historical result"/"Replay with rule" needs no test change, but adding the new "key difference" and
"environment summary" sections has no test coverage to satisfy or extend today (an opportunity to add one).

---

## 7. Ordered smallest-edit plan (no redesign) with hour estimates

Ordered by dependency and leverage (cheap, foundational fixes first; the one large item last).

1. **(0.5h) Cost wording pass.** Fix `TEST_THIS_RULE_CREDITS_LINE`, `proveCostLine()`, `LOVABLE_CREDITS_INTRO`,
   `LANDING_CREDITS_LINE`, and `SHOW_ORIGINAL_LABEL`'s "(free)" per §1b. Pure string edits in `harness-ux.ts` and
   `local-settings.tsx`. Update `ux-round6-test.test.ts:108`, `ux-decision.test.ts` (indirectly, via the shared
   constant), and any test asserting `proveCostLine()`'s exact return value (`ux.test.ts:246`,
   `ux-round5-copy.test.ts:32-35`).
2. **(0.5h) "Both builds" / "paired" relabel in already-correct positions.** `TEST_THIS_RULE_BODY`,
   `SHOW_ORIGINAL_LABEL`, `TEST_FIRST_HELP`, `judge.tsx`'s two `BuildColumn` title/subtitle pairs, `tests.tsx`'s
   `INTRO_LINE` and route meta, `tests.tsx`'s `buildLinks` labels, `local-settings.tsx`'s "Paired tests" checkbox
   label, `PROVE_INTRO`. Update `ux-round6-test.test.ts:104,108`, `ux-round6-tests-page.test.ts:42`,
   `ux-decision.test.ts:91`, `ux.test.ts:242`.
3. **(0.5h) Verdict question wording only** (keep the existing 3-way `helped/did_not_help/not_sure` values, just
   reword the visible question). Change `aria-label`/visible text at `improvement.tsx:818,834` from "Did this rule
   help?" to "Is this rule still useful?" **without** changing the button set yet (ship this now; do item 9 —
   the Keep/Review/Retire migration — separately once the health-model implications are decided). Update
   `ux-round6-cards.test.ts:180` only for the question string, not the button assertion.
4. **(1h) Adherence/observed line split.** Rewrite `adherenceLine` to attribute the AI ("AI review marked the rule
   as followed/not followed in X of Y relevant builds") and add the parallel "Harness found the same issue in N
   of M relevant builds" sentence sourced from the existing repeat-correction count in `healthLine`'s inputs
   (no new data needed — `HealthLike.hurt`/`applicable_tasks` already carry this). Update
   `ux-round5-evidence.test.ts:117-124`.
5. **(0.5h) History restore wording.** `versionLabel` in `harness/src/improvements.ts:1693-1695` and the jump-link
   text in `timeline.tsx:227`. Update `ux-round5-api.test.ts:88`.
6. **(1h) History: surface `reason`.** Add `reason` to `TimelineNode` and populate it in `buildTimeline`
   (`harness/src/improvements.ts`, node push at `:1782-1797`); render it in `Timeline` (`timeline.tsx`, near
   `:220`, alongside the existing restored-from link). No schema change — the column already exists.
7. **(0.5h) History: "Current" badge.** Render a badge when `node.latest_version` is true (`timeline.tsx`); the
   flag already exists and is already computed (`improvements.ts:1796`).
8. **(1.5h) History: named rules added/removed.** For each version node, resolve `versionRuleIds` against rule
   text (a lookup already available wherever `KnowledgeActiveRule`/rule rows are read) and append it to the node's
   `summary`, replacing or supplementing the line-count-only diff summary. Slightly more involved than the above
   two because it needs a rule-id → text/kind (added vs removed, compare against the previous node's rule set)
   resolution that doesn't exist yet in `buildTimeline`.
9. **(2h) `judge.tsx`: relabel + collapse.** Column titles/subtitles (already covered in item 2); wrap summary +
   reply + diff into one `AdvancedDetails "Full technical details"` per column (or shared); add visible remote-id
   text (project id) inside that same collapsed block; move the confounder lines to read as part of that block's
   intro rather than always-visible clutter, OR keep them visible per the brief's "environment summary" spirit
   (see item 12 — likely supersedes this). Add a one-line "key difference" summary computed from the two diffs'
   added/removed counts (no new backend call).
10. **(1h) `judge.tsx`: reword the verdict section intro.** Change "For each correction you made after the
    original build: would you still have had to make it with the rule in place?" to lead with "Would the original
    correction still be needed in the replay?" while keeping the per-correction Yes/No/Unclear rows underneath
    (they're a legitimate elaboration, not a contradiction). Update `ux-round6-test.test.ts:64` only if the literal
    substring check changes.
11. **(3h) `ImprovementDetail` reorder using the existing dead components.** `decision-layout.tsx` already exports
    `CurrentStatus` (`:44-51`), `RecommendationCallout` (`:18-41`), `PrimaryAction`/`SecondaryAction` (`:75-114`) —
    all unused today (confirmed via grep, zero call sites outside their own file). Rebuild `DecidedStatus`'s
    top-of-card rendering to use `CurrentStatus` for `decisionSentence()`, add a `RecommendationCallout` wrapping
    a short "what Harness suggests" derived from `whyFor()` plus the pending/decided state, move `PrimaryAction`
    to render the single most important button first (Add/Test when pending, Remove/Undo when decided) with the
    rest as `SecondaryAction`s, and move the instruction blockquote to render *after* this block rather than
    before it. This satisfies "current status → recommendation → primary action → active instruction" using
    components that already exist and are already styled consistently with the rest of the app — the real cost is
    re-plumbing `DecisionCard`/`DecidedStatus`'s JSX order and re-testing every assertion in `ux-round6-cards.test.ts`
    and `ux-round4-*.test.ts` that greps this file's structure by regex (there are many; expect to touch ~6 test
    files that pattern-match `DecidedStatus`/`DecisionCard`'s internals).
12. **(4-6h) `judge.tsx`: new "Replay environment summary" section.** The one genuinely new UI surface in this
    audit. Eight rows (Code state, Project Knowledge, Workspace Knowledge, Skills, Chat history, Candidate rule,
    Other active rules, Uncontrolled context) plus an environment-quality label. Roughly half the data already
    exists somewhere (Knowledge-at-episode composition logic in `harness/src/store.ts:4203-4221`; "other active
    rules" is a simple query against the rules table; "candidate rule" is `view.rule_text`, already on screen;
    edits-since/memory-confounder text already covers 2 of 8 rows). Code state, Skills-at-replay-time, and an
    actual "quality" scoring/labelling heuristic do not exist and need design decisions before implementation
    (this is why it's last and has the widest estimate — it's the one item that isn't just "move/rename existing
    data").
13. **(4-8h, separate track, not required for "truthful copy without redesign") Keep/Review/Retire/Not-sure
    verdict migration.** Flagged throughout §1c/§6 as the one item that touches a DB CHECK constraint, a Zod
    schema, health/retirement math, and ~5 test files. Recommend scoping this as its own task after item 3 ships
    (which already makes the *question* honest even with the old 3-way answer set) rather than blocking the rest
    of this plan on a schema decision.
14. **(1h, optional hardening, adjacent to this work) Widen the spec/checkpoint leak-detector test** to cover
    every file touched above (§1e). Cheap, and this pass already re-confirmed by hand that none of those files
    leak today — codifying that guarantee while editing them is low-risk, high-value.

**Total for the "truthful copy, minimal reorder" scope (items 1-10, 14): ≈13 hours.**
**Adding the `ImprovementDetail` reorder (item 11): +3h ≈ 16 hours.**
**Adding the full environment-summary section (item 12): +4-6h ≈ 20-22 hours.**
**The verdict-enum migration (item 13) is intentionally excluded from the above totals** — it's schema work, not
copy work, and shouldn't gate shipping the rest.

---

## Summary (10 lines)

1. The "paired test" built in Round 6-7 is already, mechanically, the historical replay this brief wants — it just needs relabelling, not rebuilding.
2. A true fresh-control/fresh-treatment paired comparison does not exist anywhere; only a misleadingly-named DB enum value hints at the idea, and it's never user-visible.
3. `PROVE_INTRO` ("runs the same request twice... with and without the instruction") is the single most inaccurate string in the codebase, but it is dead code today, kept only for a future page.
4. "Both builds" and unqualified "(free)" appear in ~8 live, user-visible strings across `harness-ux.ts`, `improvement.tsx`, `judge.tsx`, `tests.tsx`, and `local-settings.tsx` — all cheap, independent string edits.
5. `judge.tsx` already has original-correction → historical-result → replay-with-rule → verdict in roughly the right relative order; it is missing a "key difference" summary and the entire 8-row "environment summary" section, and its summary/reply text isn't collapsed even though its diff already is.
6. `ImprovementDetail` shows the active instruction *before* status/recommendation/action, the reverse of the required order — but `decision-layout.tsx` already ships unused `CurrentStatus`/`RecommendationCallout`/`PrimaryAction` components shaped exactly for the required hierarchy.
7. History already stores `reason` and `rule_ids` per version but never renders them, and mislabels a restore as "Went back to before version #N" instead of "Restored Knowledge from version #N" — three of the four required-but-missing History fields are one-line wiring fixes, not new data.
8. The verdict control ("Did this rule help?" → Yes/No/Not sure) needs a wording-only fix now and a separate, larger DB/schema migration later to become the required Keep/Review/Retire/Not sure four-way choice.
9. The hosted runtime's Projects and Settings pages present a fully interactive Connect/Sync/permissions UI (including a "Write Skills" toggle) with zero disclaimer, against a backend the handoff confirms has no working OAuth pipeline — this is the clearest "claims capability not implemented" finding in the audit.
10. No suggestion anywhere shows a recommended destination, a why, or a Knowledge/Skill choice — "Skill" exists as an honestly-refusing dead code path in the API but is never offered as a UI option at all.
