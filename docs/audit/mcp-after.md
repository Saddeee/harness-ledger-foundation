# Harness MCP after WP6 (2026-09-18)

`harness/src/mcp-server.ts` was rewritten per DECISIONS.md D5. Every tool below calls only
functions exported from `harness/src/adapter.ts` -- the same module
`src/routes/api/public/harness/*.ts` imports -- so an MCP-connected agent has exactly the
permissions the web app's own buttons have: the same `decision_mode` gating, the same monthly
Lovable credit budget, the same project allowlist, the same fresh-read/sha-check/read-back
sequence on a Knowledge write. There is no other way to mutate Harness Ledger state through this
server. `harness/test/mcp-server.test.ts` drives it through the real MCP protocol
(`InMemoryTransport` + `Client`) rather than importing its handlers directly.

Removed entirely (33 tools -> 13): every raw `store.ts` primitive that bypassed
`harness/src/improvements.ts`'s checks (`update_rule`, `create_rule`,
`review_correction_candidate`, `record_knowledge_readback`) and the ten
experiment-plan/verification-plan/resource tools that wrote tables nothing in the live product
reads (`docs/audit/mcp-security.md` §3). No tool name contains "readback", and the source has no
call to `recordKnowledgeReadback`.

## The 13 tools

| Tool | What it does | UI path it mirrors |
|---|---|---|
| `health` | Reports local Harness Ledger service health and the SQLite database path. | No page reads this directly; it is `store.health()`, the same signal `npm run harness:start` checks on boot. |
| `list_suggestions` | Lists Harness's suggestions -- id, rule text, the underlying correction, destination, and a plain status line -- filtered to open, decided, or all. | The Inbox and Improvements pages' own list (`GET /api/public/harness/improvements` -> `adapter.listImprovements`). |
| `explain_suggestion` | Returns one suggestion's full detail plus a preview of the Knowledge block Harness would write for its destination. | An Inbox/Improvements card expanded to "More detail" (`adapter.getImprovement`), plus its Knowledge preview. |
| `decide_suggestion` | Decides one suggestion: accept to the project, accept to the workspace, skip (with an optional reason), queue a historical replay before deciding ("test it first"), or change its wording. Writes to Lovable Knowledge immediately when connected, exactly like pressing the button, and states a refusal in the app's own words when it can't. | The Inbox/Improvements POST route's decision buttons (`adapter.improvementActionAndWrite`, `src/routes/api/public/harness/improvements.ts`). |
| `list_rules` | Lists active and retired rules for one project (or every allowed project plus the workspace). | The Instructions page's per-target rules table (`adapter.activeRulesForTarget`/`retiredRulesForTarget`, `src/routes/api/public/harness/knowledge.ts`). |
| `list_skills` | Lists the connected workspace's current Skill snapshots. | The Skills page's top-level list (`adapter.latestSkillSnapshots`, `src/routes/api/public/harness/skills.ts`). |
| `start_replay` | Starts a historical replay for one suggestion, queued on the executor's background runner; refuses (in the app's exact words) when not connected, a replay is already running, or it would exceed the monthly Lovable credit budget. | The "Test this rule" button (`adapter.improvementActionAndWrite`'s `test` action -> `startExperiment` + `kickExperimentRunner`, same as `src/routes/api/public/harness/improvements.ts`'s POST route). |
| `get_replay` | Returns one historical replay run's full detail. | The judging screen (`adapter.buildExperimentRunView`, `GET /api/public/harness/improvements?run=<id>`). |
| `list_replays` | Lists every historical replay run, summarized. | The Tests page's list (`adapter.listTestRunSummaries`, `GET /api/public/harness/improvements?runs=1`). |
| `list_knowledge_versions` | Lists the full Knowledge write history for one target (project or workspace). | The History and Instructions pages' version lists (`adapter.listKnowledgeVersions`, filtered client-side the same way `knowledge.ts` filters by target). |
| `restore_knowledge_version` | Restores a previously written Knowledge version: stages the old content as a new pending write, then runs it through the same write path every other write uses (fresh read, sha check, read-back). | The History page's "Restore" button (`adapter.createRestoreVersion` + `adapter.retryKnowledgeWrite`, `src/routes/api/public/harness/knowledge.ts`'s POST `restore` action). |
| `rule_observations` | Returns one rule's health, adherence, and latest human verdict. | The Instructions page's per-rule health line (`adapter.getRuleHealth`/`listRuleAdherence`/`adherenceCounts`/`latestRuleVerdict`). |
| `timeline` | Returns the ordered history of decisions, writes, and restores for one target. | The History page's timeline (`adapter.buildTimeline`, `GET /api/public/harness/knowledge?timeline=...`). |

## What changed under the hood

- `harness/src/adapter.ts` gained two re-exports, appended in a `// ---- Checkpoint 2026-09-18 WP6
  ----` block: `health` (from `store.ts`) and `lovableAuthStatus` (the plain, store-free
  `status()` read from `executor/lovable-auth.ts`) -- the "is Harness connected to Lovable" signal
  the web app's routes read via a web-only loader (`src/lib/server/harness-runtime.ts`) that
  `harness/src/*` cannot import.
- `mcp-server.ts` now exports `createHarnessMcpServer(): McpServer` and only connects stdio when
  run as the main module (`import.meta.url` checked against `process.argv[1]`), so tests can drive
  it over `InMemoryTransport` without spawning a process.
- The server declares an `instructions` string: "Harness MCP lets your agent operate Harness
  Ledger with the same permissions as the web app. Lovable MCP (a different server) lets Harness
  operate Lovable."
- `.mcp.json`'s `harness` entry is unchanged (still `HARNESS_DB_PATH=harness/data/harness.db`, the
  user's real local database -- fine for the user's own agent, same as before).

## Verification

- `cd harness && npm run typecheck` -- clean.
- `cd harness && npx tsx --test test/mcp-server.test.ts` -- 14/14 passing: exact tool-name list;
  every description names the same-permissions guarantee; the instructions string; the structural
  "no `./store.js` import" check; no `readback`-named tool and no `recordKnowledgeReadback` call;
  the removed raw tools (`update_rule`, `create_rule`, `review_correction_candidate`,
  `record_knowledge_readback`, and the ten dead experiment-plan/verification tools) are gone; a
  parity test comparing `decide_suggestion(accept_project)` against calling
  `adapter.improvementActionAndWrite` directly (same `write.kind`/`write.reason`, both refusing
  with "Harness Ledger is not connected — connect on the Projects page." with no Lovable
  connection); `start_replay`'s identical refusal sentence when not connected; spot checks of
  `health`, `list_suggestions`, `explain_suggestion`, `timeline`, and `list_rules` against the
  adapter functions they wrap.
- `cd harness && npm test` -- the full suite passes except for pre-existing failures in
  `ux-decision.test.ts`, `ux-round3-pages.test.ts`, `ux-round5-copy.test.ts`,
  `ux-round6-tests-page.test.ts`, `ux.test.ts`, and related judge/tests-page/landing-page tests --
  all in files owned by concurrently in-progress work packages (1b, 3, 5, 8) editing
  `src/components/harness/judge.tsx`, `tests.tsx`, `src/lib/harness-ux.ts`,
  `local-settings.tsx`, and the landing page; none reference `mcp-server.ts` or `adapter.ts`.
- `npx eslint harness/src/mcp-server.ts harness/test/mcp-server.test.ts` -- clean.
