# Build log (chronological)

Times are UTC on 2026-09-18 unless stated. Branch: `local-harness-dev`. No Lovable operation was performed
and no credit was spent in this checkpoint.

- Read `docs/HANDOFF.md`, memory notes, README, package manifests, git state (main = `3fff0d9`, branch 138
  commits ahead, no divergence). Baseline `cd harness && npm test`: 734 pass.
- Live SQLite read-only inspection: schema v17; 7 experiment runs (1–2 failed, 3–6 judged, 7 judging);
  credit ledger 0.6 + 0.3 + 2.3 + 0.5 + 0.8 = 4.5; `experiment_resources` empty; workspace Knowledge empty;
  no Skills (test skill deleted); settings `keep_test_copies=true`, budget 12, decision mode ask.
- Traced `experiments.ts`: one new build per run + free remix of the historical commit → historical replay.
  Knowledge base selection silently falls back to the newest snapshot; block rebuilt with the candidate only.
  Written up in `docs/audit/replay.md`.
- Dispatched eight read-only auditors (Sonnet): skills, sync/analysis, MCP security, UX, README truth,
  setup/hosted/privacy, rule health, knowledge history. Findings in `docs/audit/*.md`; each load-bearing
  claim re-verified by the orchestrator (SDK deprecation of Skill REST writes; `record_knowledge_readback`
  fabrication path; run 6/7 Knowledge selection).
- Commit `588a96b`: replay environment record (migration v18, `replay-environment.ts`, backfill). Backfill on a
  copy of the live DB: runs 4 and 7 = nearest earlier version with the kronor rule dropped by the old
  composer; runs 3, 5, 6 = current fallback; runs 1–2 not comparable.
- Commit `d4ae5bb`: migrations v19 (skill proposals + destination), v20 (analysis context, reanalysis,
  disagreements), v21 (verdicts keep/review/retire/not_sure, health review status, contradiction kind);
  verdict vocabulary renamed across code and tests; PLAN.md, DECISIONS.md, audits.
- Commit (next): removed `harness/src/web/server.ts` and the `ui` scripts.
- Tag `hosted-foundation-v1` created at `3fff0d9` and pushed; verified with `git ls-remote --tags`.
- Commit `f81df04`: managed block heading and note; bullet-based block comparison; write-sequence and
  legacy-heading tests. Suite 762 pass.
- Dispatched five implementers in parallel (Sonnet) on disjoint files: WP1b replay UX, WP4 Skills, WP5
  sync/analysis, WP6 Harness MCP, WP7 setup scripts.
- Wrote `SPEC.md`, `DEMO_PLAN.md`.
- Commit `58d6302`: setup scripts (WP7), verified in a scratch clone.
- Commit `56cdb3d`: landing page and verification ledger.
- Commits `d47fd7c`, `d8e145b`, `30cc9b7`, `b822386`: Skills lifecycle (WP4), replay page (WP1b), analysis
  context and reanalysis (WP5), Harness MCP (WP6). Five pinned tests reconciled; setting key folded into
  store.ts; automatic-analysis toggle added to Settings.
- Commit `64637ac` (README truth pass): README rewritten with a link/wording test; History screenshot
  removed (obsolete labels).
- Production build: exit 0, no better-sqlite3 in `.output`. Hosted-mode smoke and local-runtime smoke on
  spare ports (see VERIFICATION.md).
- WP3 subagent terminated by the session rate limit; orchestrator finished it: commits `bb1c063`
  (backend) and `d7ab4a0` (copy, History, attention blocks), plus the Archive note.
- Final: 852 tests pass; both typechecks clean; lint 0 errors; fresh clone `npm run setup` 21 s and 852 pass.
- No Lovable operation performed; 0 credits spent. Only remote action: tag `hosted-foundation-v1` pushed.
