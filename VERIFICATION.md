# Verification (checkpoint 2026-09-18)

Status labels: verified (run or traced with output), implemented_but_untested, planned, unavailable,
blocked, inferred. Command outputs are the tails as run; full logs are not kept in the repo.

## A. Claims about the existing replay

| Claim | Status | Evidence |
|---|---|---|
| Each run makes exactly one new Lovable build | verified | `experiments.ts` single `rest.chat`; fake-server tests count calls; live runs 3–7 have one `cost_credits` each |
| The "original build" column is a free remix of the historical commit, not a fresh control | verified | `remix_mode: "including"`, `skip_initial_remix_message: true`, no chat; live `original_copy_project_id` rows |
| Runs 1–7 are historical replays | verified | backfill on a DB copy (`build-log.md`); `kind='historical_replay'` after migration v18 |
| Run 7 used Knowledge snapshot 28 (kronor rule) as base and the old composer dropped that rule | verified | backfill output: `nearest_earlier_version`, snapshot 28, `historical_rules_dropped_by_run: true` |
| Runs 3, 5, 6 silently used current Knowledge | verified | backfill output: `current_fallback` |
| Lovable project memory reached the run-7 copy (euros, lowercase) | verified (live observation, handoff §4b) | rule 27 (euros) was never written; adherence rows for episodes 41–43 quote lowercase/euros |
| New runs keep the historical rules and add only the candidate | verified | `replay-environment.test.ts` (composeReplayKnowledge), `experiments.test.ts` happy path |

## B. Test matrix (filled at the end of the checkpoint)

| Check | Command | Result |
|---|---|---|
| harness tests | `cd harness && npm test` | pending |
| root typecheck | `npm run typecheck` | pending |
| harness typecheck | `cd harness && npm run typecheck` | pending |
| lint | `npm run lint` | pending |
| production build (hosted preview) | `npm run build` | pending |
| hosted build imports no better-sqlite3 | `grep -r better-sqlite3 .output` | pending |
| local runtime smoke | second dev server on a spare port against a DB copy; GET runtime/skills/improvements routes | pending |
| hosted-preview smoke | `npm run preview` without HARNESS_RUNTIME; runtime route says local-only | pending |
| MCP protocol smoke | `harness/test/mcp-server.test.ts` (in-memory transport) | pending |
| README links and truth | `harness/test/readme-truth.test.ts` | pending |
| setup scripts | `harness/test/setup-scripts.test.ts`; fresh clone `npm run setup` | pending |
| fresh clone | `git clone` into scratch, `npm run setup` | pending |

## C. Required test list from the checkpoint brief → where it lives

| Requirement | Test |
|---|---|
| historical replay is never labelled paired comparison | `ux-round6-*.test.ts` banned words; `replay-environment.test.ts` kind |
| paired comparison requires two fresh runs | `environmentQuality` test (paired needs `kind: "paired_comparison"`); no runner path exists (documented) |
| treatment and control use equivalent baseline Knowledge; candidate only in treatment | `composeReplayKnowledge` tests (candidate appended once; historical bullets kept) |
| historical Knowledge version selected by effective timestamp | `selectProjectKnowledgeAt` tests |
| current Knowledge fallback disclosed | `selectProjectKnowledgeAt` → `current_fallback`; judge page environment rows |
| Workspace Knowledge limitation disclosed | `buildReplayEnvironment` → `workspace_knowledge.source = current_uncontrolled` |
| enabled Skills context disclosed | `skills.source = current_uncontrolled` |
| chat-history inclusion disclosed | `chat_history.included = false` |
| environment-quality label computed correctly | `environmentQuality` tests |
| uncontrollable context never hidden | `UNCONTROLLED_CONTEXT` test; judge page renders `uncontrolled` |
| source project cannot be deleted | `experiments.test.ts` deleteTestCopy refuses source |
| arbitrary resources cannot be marked safe to delete | Harness MCP no longer exposes `register_experiment_resource` / `update_experiment_resource_status` (WP6) |
| copy wording says zero builder credits rather than free | `ux-round6-*.test.ts` cost sentence |
| replay retention status truthful | judge page copy states kept/deleted per copy; `cleanupCopy` tests |
| ordinary Sync is incremental | `executor.test.ts` syncHistory stop-at-known, cursor park/resume |
| ordinary Analyse skips unchanged records | `analysis-run.test.ts` |
| older relevant context selected without reclassification; reasons recorded | `analysis-context.test.ts` (WP5) |
| automatic Sync does not imply automatic paid analysis | `executor.test.ts` setting off → no analysis request (WP5) |
| reanalysis does not overwrite human decisions | `analysis-reanalyse.test.ts` (WP5) |
| inactivity creates relevance review rather than retirement | `rule-health.test.ts` (WP3) |
| one-task exception does not invalidate a rule | `retire.test.ts` (WP3) |
| usefulness language does not claim causality | `ux-round5-evidence.test.ts`, `ux-rule-usefulness.test.ts` |
| managed-block manual change causes a conflict | `executor.test.ts` "human edited inside the markers → stale" |
| content outside managed block preserved | `knowledge.test.ts`, `executor.test.ts` legacy-heading transition |
| write read-back is exact | `executor.test.ts` write sequence test |
| Skill ownership enforced | `skill-proposals.test.ts` (WP4) |
| MCP uses the same permissions as UI; cannot bypass budgets or mode | `mcp-server.test.ts` (WP6) |
| setup scripts validate Node; local start binds 127.0.0.1 | `setup-scripts.test.ts` |
| hosted build does not import better-sqlite3 | build output grep (B) |
| README links valid; README status matches verified functionality | `readme-truth.test.ts` |
