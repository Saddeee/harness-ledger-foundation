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
| harness tests | `cd harness && npm test` | verified: 852 pass, 0 fail (final, commit after WP3) |
| root typecheck | `npm run typecheck` | verified: clean |
| harness typecheck | `cd harness && npm run typecheck` | verified: clean |
| lint | `npm run lint` | verified: 0 errors, 7 pre-existing warnings (react-refresh only-export-components) |
| production build (hosted preview) | `npm run build` | verified twice (05:05 and after WP3): exit 0, preset cloudflare-module |
| hosted build imports no better-sqlite3 | `grep -rl better-sqlite3 .output \| wc -l` | verified: 0 files; `harness/dist/*` appears only as dynamic-import strings behind `HARNESS_RUNTIME` |
| local runtime smoke | dev server on 127.0.0.1:18713 with `HARNESS_RUNTIME=local` against a copy of the live DB, cron-secret auth | verified: runtime `local`; skills route available; `improvements?run=7` → kind historical_replay, quality historical_approximation, Project Knowledge nearest_earlier_version, other active rule = kronor; `runs=1` lists 1–7 (1–2 not_comparable); executor route returns `automatic_analysis_after_sync: false` |
| hosted-mode smoke | dev server on 127.0.0.1:18712 without `HARNESS_RUNTIME` | verified: runtime `{"mode":"hosted"}`; skills route → "This is the hosted preview…"; unauthenticated → 401; landing 200. The Cloudflare build itself needs `wrangler dev`, not run here |
| MCP protocol smoke | `harness/test/mcp-server.test.ts` (in-memory transport) | verified: 14 pass; 13 tools; parity refusals identical to the UI path |
| README links and truth | `harness/test/readme-truth.test.ts` | verified: 5 pass (anchors, relative links, banned wording, hosted wording, setup promise, block example) |
| setup scripts | `harness/test/setup-scripts.test.ts`; fresh clone `npm run setup` | verified: 9 pass; WP7 ran `npm run setup` in a scratch clone (Node 22.23.2, installs, build, schema 21, 0700 data dir) |
| fresh clone | `git clone --branch local-harness-dev` into scratch, `npm run setup`, `npm test`, `harness-start --print-only` | verified: setup 21 s, schema 21, 852 tests pass in the clone, HOST 127.0.0.1 and absolute DB path |

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
| arbitrary resources cannot be marked safe to delete | Harness Ledger MCP no longer exposes `register_experiment_resource` / `update_experiment_resource_status` (WP6) |
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

## D. Skills capability matrix (final)

| Capability | Status |
|---|---|
| list workspace Skills, read Skill content | verified (sync + Skills page; `executor.test.ts`) |
| propose a Skill from a correction | verified (Rule writer schema + `analysis-propose.test.ts`; live model output not exercised) |
| edit / approve / retire a proposed Skill; version; restore a revision | verified (`skill-proposals.test.ts`, local only) |
| link a Skill proposal to correction evidence | verified (proposal row references the candidate; UI links to the suggestion) |
| connect to project rules (Knowledge line pointing to the Skill) | verified for destination "both" (Knowledge line + Skill draft) |
| create / update a Harness-managed Skill in Lovable | unavailable in this version (not wired; Lovable MCP tools exist; REST path deprecated) |
| enable / disable for selected projects | unavailable (workspace Skills apply to all projects; project Skills live in the project repo) |
| user-owned Skill protection | verified (`SkillProposalOwnershipError`; tests) |
| test a Skill in a replay; observe whether followed | unavailable |

## E. Claims still unverified or inferred

- The Rule writer's real model output for `destination`/`skill_draft` has not been exercised against a live provider (no Analyse now was run). Schema strict-compatibility is unit-tested.
- The classifier's contradiction `kind` has not been exercised live.
- The replay environment record is verified on backfilled runs and fake-server tests; no new live replay was run.
- Reanalyse history is verified with fake LLM calls only.
- Harness Ledger MCP over stdio with a real client was not exercised (in-memory transport only).
- The Cloudflare build was not served with `wrangler dev`; hosted mode was exercised through the dev server's hosted code path.
