# Harness Ledger MCP after WP6 (2026-09-18), updated Checkpoint 2 2-F (2026-09-18)

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

## The 18 tools

| Tool | What it does | UI path it mirrors |
|---|---|---|
| `health` | Reports local Harness Ledger service health and the SQLite database path. | No page reads this directly; it is `store.health()`, the same signal `npm run harness:start` checks on boot. |
| `list_suggestions` | Lists Harness Ledger's suggestions -- id, rule text, the underlying correction, destination, and a plain status line -- filtered to open, decided, or all. | The Inbox and Improvements pages' own list (`GET /api/public/harness/improvements` -> `adapter.listImprovements`). |
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
| `list_skill_proposals` | Lists Harness Ledger's own local Skill proposals -- id, name, status, ownership (`harness`/`user`), `lovable_state` (always `not_created`), version count, and the suggestion each belongs to. | The Skills page's "Proposed by Harness Ledger" section (`adapter.listSkillProposalsForSkillsView`, `src/routes/api/public/harness/skills.ts`). |
| `get_skill_proposal` | One suggestion's Skill proposal (addressed by `suggestion_id`, not a proposal id) -- full content, status, ownership, and every revision. | `adapter.getImprovement(...).skill_proposal`, the same field an Inbox/Improvements card reads. |
| `edit_skill_proposal` | Edits a Skill proposal's name/content as a new versioned revision. Refuses, worded exactly like the app, on a proposal the user owns. | The Skills page's own proposal editor (`adapter.improvementActionAndWrite('edit_skill_proposal')`). |
| `approve_skill_proposal` | Approves a Skill proposal (a new revision recording the status change). Refuses the same way on a user-owned proposal. | The Skills page's Approve button (`adapter.improvementActionAndWrite('approve_skill_proposal')`). |
| `restore_skill_proposal_revision` | Restores a Skill proposal's name/content from one of its own earlier revisions (status is left as it is now). Refuses the same way on a user-owned proposal. | The Skills page's version history (`adapter.improvementActionAndWrite('restore_skill_proposal_revision')`). |

Every one of the five Skill-proposal tools' descriptions says explicitly that the Skill is not
published to Lovable, and that ownership, versioning and the audit trail all live in Harness
Ledger. `retire_skill_proposal` and `set_content_destination` are WP4 actions the UI itself uses
(both reachable through `adapter.improvementActionAndWrite` from other tools/pages), but neither is
exposed as its own MCP tool in this checkpoint -- there was no request for either from an MCP
caller, and the five above already cover propose -> read -> edit -> approve -> restore.

## What changed under the hood

- `harness/src/adapter.ts` gained two re-exports, appended in a `// ---- Checkpoint 2026-09-18 WP6
  ----` block: `health` (from `store.ts`) and `lovableAuthStatus` (the plain, store-free
  `status()` read from `executor/lovable-auth.ts`) -- the "is Harness connected to Lovable" signal
  the web app's routes read via a web-only loader (`src/lib/server/harness-runtime.ts`) that
  `harness/src/*` cannot import.
- `mcp-server.ts` now exports `createHarnessMcpServer(): McpServer` and only connects stdio when
  run as the main module (`import.meta.url` checked against `process.argv[1]`), so tests can drive
  it over `InMemoryTransport` without spawning a process.
- The server declares an `instructions` string: "Harness Ledger MCP lets your agent operate Harness Ledger
  Ledger with the same permissions as the web app. Lovable MCP (a different server) lets Harness
  operate Lovable."
- `.mcp.json`'s `harness` entry is unchanged (still `HARNESS_DB_PATH=harness/data/harness.db`, the
  user's real local database -- fine for the user's own agent, same as before).

## Checkpoint 2 2-F: 5 Skill-proposal tools, budget-refusal parity, and a safety audit

- `mcp-server.ts` gained the five tools listed above, in a `// ---- Checkpoint 2 2-F ----` block --
  13 tools -> 18. Every one of them is a thin wrapper over `adapter.getImprovement`,
  `adapter.listSkillProposalsForSkillsView`, or `adapter.improvementActionAndWrite` with the exact
  WP4 action body the Skills page's own buttons already send (`edit_skill_proposal`,
  `approve_skill_proposal`, `restore_skill_proposal_revision`) -- no new adapter export was needed.
  A user-owned proposal refuses through MCP with the exact same sentence the UI gets
  (`SkillProposalOwnershipError`, `store.ts`: "This Skill is yours; Harness Ledger does not change
  user-owned Skills.").
- `harness/src/executor/experiments.ts` (`cleanupCopy`/`deleteTestCopy`) now confirms a Lovable
  project delete with exactly one `getProject` read-back after every successful `deleteProject`
  call: a 404 sets `copy_deletion_status`/`original_copy_deletion_status` to `confirmed`; a 200
  ("Lovable still lists the copy") or any other read-back error leaves it `requested`, with the
  uncertainty recorded in `copy_cleanup_note` rather than hidden; a failed delete still falls back
  to `failed` + private, as before. `copy_deleted` is kept at `1` in every case for older readers
  of that column. `harness/src/improvements.ts`'s `buildCopy`/`TestBuildCopy` now exposes
  `deletion_status`, mirrored in `src/lib/improvements-client.ts`'s own `TestBuildCopy`; the wording
  for each status (`copyDeletionLine`) lives in `src/lib/harness-ux.ts`'s own `// ---- Checkpoint 2
  2-F ----` section.
- `harness/test/safe-to-delete.test.ts` (new) proves the deletion safety properties hold at every
  entry point: `deleteTestCopy` refuses the source project id and an id never recorded on the run
  (and its own arity -- 3 parameters, no caller-supplied project id -- is pinned); `cleanupCopy`
  only ever calls `deleteProject` with the run's own two recorded copy ids; the MCP surface has no
  tool with "resource" or "safe" in its name and no delete-capable tool at all (a structural check
  also confirms `mcp-server.ts`'s source never calls `deleteProject`/`deleteTestCopy`/`cleanupCopy`).
- `harness/test/hosted-build.test.ts` (new) is unrelated to the MCP surface itself but lives
  alongside it in this same WP: a structural proof that `src/` never statically imports
  `better-sqlite3` or `harness/src` directly, that `src/lib/server/harness-runtime.ts` only ever
  reaches `harness/dist` through a dynamic `import()` guarded by `HARNESS_RUNTIME === "local"`, and
  that no file under `src/` hardcodes `harness/data/harness.db`; it also greps `.output/` for the
  same two strings when a local hosted build exists on disk (skipped with a note otherwise).

## Verification

- `cd harness && npm run typecheck` -- clean.
- `cd harness && npx tsx --test test/mcp-server.test.ts` -- 21/21 passing: everything the WP6
  paragraph above already covered, plus (Checkpoint 2 2-F) the 18-tool list; a budget-parity test
  that sets `lovable_monthly_credit_budget` to a fractional `0.5` (written directly to the
  `settings` table -- `store.setSettings` only accepts a whole number) with `1.0` already recorded
  in `credit_ledger`, and asserts `start_replay`'s refusal through the in-memory MCP client is
  byte-for-byte `adapter.improvementActionAndWrite`'s own thrown message ("This would exceed your
  monthly Lovable credit budget (1 of 0.5 used)."), unchanged across `decision_mode` "ask" and
  "automatic"; `list_skill_proposals`/`get_skill_proposal` (including an unknown suggestion id);
  `approve_skill_proposal` creating a new revision; `restore_skill_proposal_revision` restoring
  content; `edit_skill_proposal` refusing a user-owned proposal with the UI's own sentence.
- `cd harness && npx tsx --test test/safe-to-delete.test.ts` -- 6/6 passing (see above).
- `cd harness && npx tsx --test test/hosted-build.test.ts` -- 6/6 passing, including the `.output/`
  check (a local hosted build existed on disk at verification time).
- `cd harness && npx tsx --test test/experiments.test.ts` -- 39/39 passing, including the new
  deletion-confirmation cases (2xx+404 -> confirmed, 2xx+200 -> requested+note, 2xx+other-error ->
  requested+note, delete failure -> failed, never more than one read-back call) for both
  `cleanupCopy` and `deleteTestCopy`.
- `cd harness && npm test` -- the full suite passes except for pre-existing failures in
  `ux-round3-decision.test.ts`, and tests exercising `src/components/harness/improvement.tsx`,
  `instructions.tsx`, `skills.tsx`, and `judge.tsx` (via `ux.test.ts`'s "detail page" cost-wording
  count) -- all in files under active edit by other concurrently in-flight Checkpoint 2 work
  packages (2-B, 2-C, 2-D), all showing as modified in `git status` at verification time; none
  reference `mcp-server.ts`, `adapter.ts`, `experiments.ts`, or the deletion/Skill-proposal fields
  this WP added.
- `npx eslint --fix harness/src/mcp-server.ts harness/src/adapter.ts harness/src/improvements.ts
  harness/src/executor/experiments.ts harness/test/mcp-server.test.ts harness/test/experiments.test.ts
  harness/test/hosted-build.test.ts harness/test/safe-to-delete.test.ts` -- clean.
