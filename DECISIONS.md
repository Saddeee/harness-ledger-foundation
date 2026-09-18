# Decisions (architecture and product)

Chronological. Each entry: what was decided, the evidence, alternatives considered, and the tradeoff.
Later entries win. Audit evidence lives in `docs/audit/`.

## D1 — Every existing test run is a historical replay (2026-09-18)

**Decision:** all seven `experiment_runs` (1–7) are classified `historical_replay`; the product name for the
feature is "Test a rule against a previous correction"; arm labels are **Historical result** (the build that
really happened, shown through a free remix copy of that commit) and **Replay with rule** (one new Lovable
build). The words "paired", "proof" and "both builds" are removed from copy.

**Evidence:** `harness/src/executor/experiments.ts` makes exactly one `rest.chat` call per run (line 475) and
one optional `remix_mode: "including"` copy with no chat (line 574); `experiment_resources` is empty; no code
path creates a second fresh build (`docs/audit/replay.md` §1, §4).

**Alternative:** keep the "paired test" name because the two columns look alike. Rejected: the historical
column ran under a different Lovable environment on a different day; calling it a control would be false.

## D2 — Replay Knowledge: choose by effective time, record the choice, keep the rules of the time

**Decision:** migration v18 adds `experiment_runs.kind` and `environment_json`. The runner records the
Project Knowledge source (`exact_historical` / `nearest_earlier_version` / `current_fallback` / `unavailable`),
keeps every rule that was in the historical managed block and appends only the candidate
(`composeReplayKnowledge`), and lists uncontrolled context (Lovable project memory, workspace Knowledge,
Skills, builder version) with a quality label. Older runs are backfilled from what was on file when they ran.

**Evidence:** before this, `knowledgeBaseAtOrBefore` fell back to the newest snapshot silently (runs 3, 5, 6)
and `composeManagedKnowledge` replaced the block with the candidate alone (runs 4 and 7 lost the kronor rule
that was live at the time). Backfill on a copy of the live DB reproduces this exactly (`build-log.md`).

**Source of truth:** `knowledge_snapshots` (fetched states, includes edits made in Lovable) rather than
`knowledge_versions` (Harness's own writes only). A user edit between two syncs is invisible until the next
snapshot; that is disclosed as "nearest earlier version", never as exact.

**Quality rule:** a historical replay is at best `historical_approximation` (one arm is a historical
artifact). A paired comparison with historical Knowledge would be `partially_controlled` (memory, workspace
Knowledge and Skills still come from the present). `controlled` is unreachable until Lovable's project memory
can be reset. `not_comparable` when the historical code state could not be established.

## D3 — Paired comparison is deferred, with a recorded design

**Decision:** not implemented in this checkpoint. Kept as the next evidence level in README "Next" and on the
landing page, described precisely (fresh control without rule, fresh treatment with rule, two new builds).

**Evidence for feasibility:** two `remixInit(..., "before")` calls for the same message id, independent
`setProjectKnowledge` per copy, the same `rest.chat`, `allowCopy` guard, `deleteProject` per copy — all exist
(`docs/audit/replay.md` §5).

**Why deferred:** (1) the run state machine is single-arm (`copy_*` columns); a clean design needs an
`experiment_arms` table, a second cost ledger row, and two screenshots — about two days with fake-server
tests; (2) it could not be verified live here (no credits may be spent), so it would ship untested against
the real API that has already broken mocked assumptions eight times (handoff §8); (3) the prerequisite —
an accurate environment record — did not exist until D2. Building the comparison before the disclosure would
have repeated the "paired test" naming mistake.

**Blocker to record:** none technical. The blocker is verification cost (two builds, roughly 1–3 credits per
comparison on the demo fixture) and the owner's approval.

## D4 — Skills: first-class model, local lifecycle, no Lovable write yet

**Decision:** suggestions carry a destination (Knowledge / Skill / both) with a reason and an alternative;
the Rule writer proposes the destination and, for Skill or both, a Skill draft; users can change the
destination, edit and approve a Skill proposal, and every edit is a versioned revision. Skill proposals are
stored locally (migration v19) and shown on the Skills page next to the workspace Skills. Creating, updating,
enabling, disabling or restoring a Skill *in Lovable* is not wired and the UI says so.

**Evidence:** Harness reaches eight Lovable MCP tools, none of them Skill writes (`lovable-mcp.ts`); the REST
Skill create/update/delete endpoints are marked `@deprecated` with "No replacement in the public API"
(`node_modules/@lovable.dev/sdk/dist/index.d.ts:1980-1996`); workspace Skills apply to every project in the
workspace, so "enable for selected projects" has no Lovable primitive for workspace Skills (project Skills live
in the project repo and would need a build to create). A real Skill write requires owner approval and cannot
be verified in this checkpoint.

**Alternative:** wire `create_workspace_skill` through the Lovable MCP now. Rejected for this checkpoint: it
would ship an unverified write path to a shared workspace resource with no ownership signal for user-authored
Skills. Recorded as the first paid step after the demo (needs one approved Skill write to verify).

## D5 — Harness MCP becomes a thin layer over the UI's own paths

**Decision:** `harness/src/mcp-server.ts` is rewritten to call only `adapter.ts` functions (the same
`improvementActionAndWrite`, `startExperiment` via the queue, `buildTimeline`, views). Raw store tools
(`update_rule`, `create_rule`, `record_knowledge_readback`, `review_correction_candidate`, experiment plan /
resource / verification tools) are removed. `harness/src/web/server.ts` (unauthenticated diagnostic server,
marked for removal) is deleted.

**Evidence:** `record_knowledge_readback` marks a version written and a rule active from any content that
hashes to the pending write's expected hash, which `list_pending_knowledge_writes` discloses — an agent could
fabricate a Lovable write without contacting Lovable (`store.ts:1289-1327`, `mcp-server.ts:449-467`).
`update_rule` bypasses the mode/budget/ownership checks in `improvements.ts` (`docs/audit/mcp-security.md`).

**Alternative:** add a guard module and keep the 33 tools. Rejected: ten tools write tables nothing reads;
keeping them documented as "safe" would be false.

## D6 — Managed block heading: keep recognising the old heading

**Decision (done, commit f81df04):** the block now carries the required heading and the conflict note.
Blocks are compared by their bullet lines (`normalizeBlockForCompare`), so a live block written under the
earlier heading is still Harness Ledger's own; the next write replaces the heading. Own-block recognition
never depended on the heading text (`docs/audit/knowledge-history.md` §2), which made the change low-risk.

## D7 — Sync and analysis remain separate; automatic analysis is an explicit, default-off setting

**Decision:** add `automatic_analysis_after_sync` (default `false`). The scheduler only enqueues an analysis
request when it is on. Analysis context selection is recorded per call (migration v20). Reanalyse history is
a separate, scoped, estimated, confirmed action that never overwrites a human decision: a disagreement creates
a review item.

**Evidence:** today no automatic analysis trigger exists (hourly sync never analyses; 10 live runs are all
manual), the LLM roles never see Knowledge or Skills, and nothing records which context was sent
(`docs/audit/sync-analysis.md`).

## D8 — Rule usefulness, not causality

**Decision (done, commits d4ae5bb, bb1c063, d7ab4a0):** the user question is "Is this rule still useful?" (Keep / Review /
Retire / Not sure); observed repeat corrections and AI review are shown as separate lines; inactivity opens a
relevance review, never a retirement; an opposite request is classified before it questions a rule.

## D11 — "Archive" is not a separate state

The relevance review offers Keep / Move to Skill / Retest / Retire. A retired rule keeps its record and can be
re-added, which is what an archive would do; adding a fifth state (`disabled`) with its own copy and tests was
not worth the confusion before the demo. Recorded as a disagreement with §10.1 of the request.

## D12 — WP3 finished by the orchestrator

The WP3 subagent hit the session rate limit mid-edit. Its backend half (health signals, contradiction kinds,
review status) was reviewed, its duplicated verdict bump removed, and the copy, History and detail-page half
was implemented by the orchestrator.

## D9 — Documents

Root-level `PLAN.md`, `DECISIONS.md`, `VERIFICATION.md`, `build-log.md`, `SPEC.md`, `DEMO_PLAN.md` are the
durable record for this checkpoint; `docs/HANDOFF.md` stays the state-of-project summary and is updated at the
end (owner's standing rule). Audits are under `docs/audit/`.

## D10 — Git

`hosted-foundation-v1` tags `3fff0d9` (main's head, the last Lovable-built commit; `local-harness-dev` is 138
commits ahead with no divergence). The tag is pushed because the instructions ask for it; the branch is not
pushed and main is not merged without approval.

## Disagreements with the requested design (recorded per instructions)

1. **Verdict options on the replay page.** The request asks "Would the original correction still be needed in
   the replay?" with Yes / No / Unclear. Kept as asked. But the per-rule "Did this rule help?" verdict is
   changed to "Is this rule still useful?" with Keep / Review / Retire / Not sure, which requires a migration
   of `rule_verdicts.verdict` values (`helped` → `keep`, `did_not_help` → `review`, `not_sure` → `not_sure`).
   Done in WP3 rather than left as copy-only, because copy-only would leave the stored vocabulary causal.
2. **Managed heading change** (§13 of the request) is a live-data risk (every existing block on Lovable carries
   the old heading). Implemented with backward recognition rather than a blind swap (D6).
3. **Paired comparison** (§4.4): deferred, per the evidence in D3, not partially implemented.
4. **Skills lifecycle** (§8.2): local proposal lifecycle only, no Lovable Skill write (D4).
5. **`npm run setup` running migrations**: migrations run on first import of `harness/dist/db.js`; the setup
   script opens the DB once after building so the schema is created and verified, rather than adding a
   separate migration runner.
