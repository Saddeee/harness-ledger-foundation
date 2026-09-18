# MCP security audit — Harness MCP server & Lovable MCP client

Read-only audit, per `docs/audit/README.md`. No `mcp__lovable__*` / `mcp__harness__*` tool was
called. All claims below carry `file:line`; a few are backed by a `grep`/read of `test/*.test.ts`
rather than a live run — labelled accordingly.

Context that matters for everything below: `.mcp.json:8-14` registers `harness` as
`npx tsx harness/src/mcp-server.ts` with `HARNESS_DB_PATH=harness/data/harness.db` — **the real
database**, not a fixture. Any Claude Code session opened in this repo with the default MCP config
has live, unauthenticated (process-boundary-only) write access to the same SQLite file the product
UI reads. `docs/HANDOFF.md:25` documents `mcp-server.ts` as "the Harness MCP server Claude Code
sessions used **before the executor existed**" — i.e. it predates and has been architecturally
superseded by `harness/src/executor/beats.ts`, but it was never removed or gated.

## 1. Harness MCP tool table (`harness/src/mcp-server.ts`, 33 tools)

All tools are thin wrappers (`tool()`, `mcp-server.ts:12-32`) that JSON-encode whatever
`harness/src/store.ts` returns or throws. Store function is the same name in camelCase unless noted.

| Tool (line) | Purpose | Mutates | Allowlist check | Mode/budget check | Ownership check | Approval workflow | Audit event |
|---|---|---|---|---|---|---|---|
| `health` (68) | DB health/path | no | – | – | – | – | no |
| `create_test_record` (70) | insert throwaway row | yes | n/a | n/a | n/a | n/a | no |
| `get_allowed_projects` (77) | list allowlist | no | – | – | – | – | no |
| `upsert_project` (84) | cache project metadata | yes | **no** (any `lovable_project_id`) | – | – | – | no |
| `append_event` (98) | write an audit event | yes | n/a | – | – | – | is the event |
| `list_events` (105) | read audit log | no | – | – | – | – | no |
| `create_project_snapshot` (114) | store point-in-time snapshot | yes | **yes**, `store.ts:126` `assertAllowedProject` | – | – | – | yes |
| `upsert_history_item` (127) | store raw evidence | yes | yes if `project_id` set, `store.ts:151` | – | – | – | yes |
| `create_task_episode` (143) | create episode | yes | no (project optional, no check even when set) | – | – | – | implicit via store |
| `update_task_episode` (158) | edit episode | yes | no | – | – | – | – |
| `create_correction_candidate` (172) | structured correction | yes | no | – | – | – | yes |
| `review_correction_candidate` (197) | human review action | yes | no | **no** — any caller can `confirm`/`exclude`/`change_scope` | – | this *is* the approval step, callable directly | yes |
| `create_learning` (217) | learning from correction | yes | no | – | – | limited to 3 (`LearningLimitError`, `store.ts:18-25`) | yes |
| `create_rule` (235) | proposed rule | yes | **no** | n/a (state fixed at `proposed`) | caller sets `ownership` freely | starts `proposed` (safe) | `rule.created` |
| `update_rule` (252) | edit / change rule state | yes | **no** | **no** — `decision_mode`, budget, evidence-level checks live only in `harness/src/improvements.ts`, not in `store.updateRule` | **no** — `ownership` never consulted | **no** — any state including `active`/`approved`/`rolled_back` may be set directly | `rule.updated`/`rule.scope_changed` |
| `get_rule` (265) | read rule + history | no | – | – | – | – | no |
| `list_project_rules` (272) | list rules | no | – | – | – | – | no |
| `create_verification_definition` (295) | define a check | yes | conditional (`scope`/`project_id` consistency only) | – | caller sets `ownership` freely | n/a | – |
| `update_verification_definition` (313) | edit/enable check | yes | no | – | – | – | – |
| `link_verification_to_rule` (327) | attach check to rule | yes | no | – | – | – | – |
| `create_verification_plan` (334) | plan for a rule | yes | no | – | – | items start `not_run` | – |
| `get_verification_plan` (347) | read plan | no | – | – | – | – | – |
| `create_experiment_plan` (354) | propose an experiment | yes | **yes**, `store.ts:926` | **no** (`estimated_credits`/`max_permitted_credits` are caller-supplied numbers, never compared to `lovable_monthly_credit_budget`) | – | starts `proposed`; **never executes anything** (comment `mcp-server.ts:280-282`) | yes |
| `get_experiment_plan` (386) | read plan + resources | no | – | – | – | – | – |
| `register_experiment_resource` (393) | register a planned resource | yes | **yes**, `store.ts:981` (must be an allowed project) | – | – | `safe_to_delete` forced false (`store.ts:1004-1005`) | yes |
| `update_experiment_resource_status` (407) | change resource lifecycle / `safe_to_delete` | yes | no (operates by resource `id`, not re-checked against allowlist) | – | – | none beyond "must be passed explicitly" | yes |
| `list_cleanup_required_resources` (421) | list dangling resources | no | – | – | – | – | – |
| `record_knowledge_snapshot` (435) | cache Knowledge just read | yes | conditional (`assertTargetId`) | – | – | – | – |
| `list_pending_knowledge_writes` (448) | list writes awaiting execution | no | – | – | – | **exposes the literal `new_content` and `new_sha256` the caller is supposed to prove it wrote** (`store.ts:1343`) | – |
| `mark_knowledge_write_stale` (455) | mark a pending write stale | yes | n/a | – | – | – | yes |
| `record_knowledge_readback` (462) | prove a write landed, flips rule to `active` | yes | n/a | **no** | – | hash check only (`store.ts:1289-1310`), see §2 | yes + `rule.applied` |
| `mark_knowledge_write_failed` (469) | mark a pending write failed | yes | n/a | – | – | – | yes |
| `list_knowledge_versions` (476) | full write history | no | – | – | – | – | – |

No tool calls Lovable, sends a message/prompt, runs SQL, or executes an experiment — confirmed both
by reading every handler above and by static tests (`test/verification.test.ts:306-320`,
`test/knowledge.test.ts:519-546`, see §7).

## 2. Parity gaps: MCP vs. the UI action path (`improvements.ts`)

The UI's single mutation entrypoint is `improvementAction` (`harness/src/improvements.ts:1357`).
Before it ever calls `store.updateRule`, it enforces:
- monthly Lovable credit budget (`testBudgetRefusal`, `improvements.ts:445-544`)
- `decision_mode` gating for automatic acceptance (`improvements.ts:2212`: `if (store.getSetting("decision_mode") !== "automatic") return null;`)
- evidence level / proof state (`improvements.ts:1433-1435`)
- staged-write sequencing (`stagePendingWrite`, referenced at `improvements.ts:1469-1475`)

None of that lives in `store.updateRule` itself (`store.ts:613-670`) — it is a bare primitive:
validate ids, write `rule_revisions`, write `rules`, emit an event. **Ranked gaps:**

1. **CRITICAL — fabricate a Lovable Knowledge write with no Lovable call.** `list_pending_knowledge_writes` (`mcp-server.ts:448-453`) returns each pending version's exact `new_content`/`new_sha256` (`store.ts:1343`). `record_knowledge_readback` (`mcp-server.ts:462-467`) accepts *any* string and only checks `sha256(readBackContent) === new_sha256` (`store.ts:1289-1310`). An MCP caller can read the expected content and echo it straight back — no Lovable write ever happens, yet the version is marked `written`, `verified_at` is stamped, and `updateRule` is called with `state: "active"` (`store.ts:1312-1327`), firing `rule.applied` (`store.ts:1328-1332`). The UI's Instructions/Ledger pages have no way to distinguish this from a real write. This is not theoretical misuse of a legitimate feature — the hash check's only job is "did you copy the number correctly," not "did you call Lovable," and the number is handed to the caller in the same tool surface.
2. **HIGH — `update_rule` bypasses `decision_mode='ask'` and the budget gate entirely.** Calling `update_rule({id, state: "approved"})` or even `state: "active"` directly (`mcp-server.ts:252-263`) reaches `store.updateRule` with none of `improvements.ts`'s gates. In `ask` mode (the documented default — see memory `harness-ledger-product-shape`), this lets an MCP-connected agent approve/activate a suggestion with **no human decision recorded** anywhere except a `rule.updated` event whose `actor` is caller-supplied free text (`update_rule`'s `actor: z.string()`, `mcp-server.ts:260`) — it can literally say `actor: "you"`.
3. **HIGH — `create_rule` has no allowlist or ownership check.** `store.createRule` (`store.ts:560-593`) never calls `assertAllowedProject`, and takes `ownership: "user" | "harness"` directly from the caller (`mcp-server.ts:245`). Contrast with `create_project_snapshot`/`create_experiment_plan`/`register_experiment_resource`, which all call `assertAllowedProject`. A rule's `scope` is `project`/`workspace` with no `project_id` field at all on the `rules` row — the *only* place a rule is tied to a project is transitively, through whichever `correction_candidate_id`/`learning_id` the caller supplies, and those ids are also never checked against the allowlist at this layer. An MCP caller who knows or guesses a `learning_id`/`correction_candidate_id` from a disallowed project's episode can create a rule from it exactly as if it came from an allowed project.
4. **MEDIUM — `review_correction_candidate` is itself the human-approval step, directly callable.** `mcp-server.ts:197-215` exposes `confirm`/`mark_reusable`/`change_scope`/`exclude` with no distinction between "human clicked Confirm in the Inbox" and "an MCP tool call". `improvements.ts`'s own comment at `improvements.ts:1425-1430` treats "who decided" (`decided_by: 'user' | 'automatic'`) as meaningful provenance for auto-accept eligibility, but the MCP path sets none of that — `store.reviewCorrectionCandidate` doesn't set `decided_by` at all (only `improvements.ts`'s wrapper calls `store.setCandidateDecidedBy` separately, `improvements.ts:1430`).
5. **LOW/inert today, real landmine — `update_experiment_resource_status` can mark the tracked source project "safe to delete" with a single call, and nothing stops it.** `store.ts:1006-1034` has no protection beyond the allowlist check performed once, at *registration* (`store.ts:981`), not at status-update time. `test/verification.test.ts:274-298` demonstrates and endorses exactly this: a resource registered with `source_project_id: PROJECT` (the real, allowed source project) is flipped to `safe_to_delete: 1` by one `update_experiment_resource_status` call, and the test's own assertion message is "an explicit true must actually take effect." **This is currently inert** — see §3: nothing in the live experiment runner (`harness/src/executor/experiments.ts`) reads `experiment_resources.safe_to_delete` at all; real deletion is driven by `experiment_runs.copy_deleted`/`original_copy_deleted`, set only inside `experiments.ts:658-677` from state the executor itself produced. But the table and its flag exist, are written by a live audited MCP tool, and would be trusted by any future code (or human) that assumes `safe_to_delete` means something.
6. **Confirmed NOT exploitable via MCP:** spending credits, starting a real experiment, and changing settings. No MCP tool imports anything Lovable-related or makes a network call (verified by grep + `test/knowledge.test.ts:519-546`, `test/verification.test.ts:322-339`); `get_setting`/`set_settings` (`store.ts:1502,1677`) are not wired into `mcp-server.ts` at all; and the live experiment runner's own tables (`experiment_runs`, schema v12) are not reachable from any MCP tool — see §3.

## 3. Current data model vs. dead "checkpoint" surface

`mcp-server.ts` is entirely checkpoint A–D code (its own section comments: "Checkpoint A" line 66,
"Checkpoint B" line 112, "Checkpoint C" line 279, "Checkpoint D" line 428). Cross-referencing against
what `harness/src/improvements.ts` / `harness/src/executor/beats.ts` / `harness/src/executor/experiments.ts`
actually read and write today:

- **Live and shared** (MCP writes/reads the same rows the UI uses): `rules`, `rule_revisions`,
  `learnings`, `correction_candidates`, `history_items`, `task_episodes`, `project_snapshots`,
  `knowledge_versions`, `events`, `allowed_projects`, `projects`. These are current-model tables —
  the gaps in §2 are real, live gaps against production data, not dead-code false alarms.
- **Dead surface — `experiment_plans` / `experiment_resources` / `verification_definitions` /
  `verification_plans`.** The live paired-test runner uses an entirely separate table,
  `experiment_runs` (schema v12, `store.ts:3929-3985`, keyed directly by `rule_id` /
  `correction_candidate_id` / `task_episode_id` / `source_project_id`, with its own
  `copy_project_id`/`original_copy_project_id`/`copy_deleted` columns). `grep -rln
  "experiment_resources" harness/src/` returns only `migrations.ts`, `store.ts`, and `mcp-server.ts` —
  never `harness/src/executor/*.ts`. `create_experiment_plan`, `get_experiment_plan`,
  `register_experiment_resource`, `update_experiment_resource_status`,
  `list_cleanup_required_resources`, `create_verification_definition`,
  `update_verification_definition`, `link_verification_to_rule`, `create_verification_plan`,
  `get_verification_plan` (10 of the 33 tools) write to tables **the current UI and executor never
  read**. `setExperimentPlanStatus` (`store.ts:2076-2087`, the only way a plan leaves `proposed`) is
  called from `improvements.ts` (e.g. `improvements.ts:1189,1215,1465,1535` via `ensureApprovedExperimentPlan`)
  but is **not exposed as an MCP tool at all** — so even the "approved" half of the checkpoint-C
  lifecycle is UI-only; MCP can create plans/resources but can never legitimately advance or execute them.
- **Live but MCP-exposed as a second, ungated writer** — `knowledge_versions` (§2 finding 1) and
  `rules` (§2 findings 2–3): current-model tables where the MCP surface is not dead, it is a live,
  parallel, less-guarded writer.
- **`agent_actions`** (`store.ts:334-338`) is written by `createCorrectionCandidate` when
  `classification_meta` is supplied, but `agent_actions` is not queried anywhere in
  `harness/src/improvements.ts` (`grep -c agent_actions harness/src/improvements.ts` → 0) — write-only
  bookkeeping, effectively dead on the read side too.

## 4. Lovable MCP client (`harness/src/executor/lovable-mcp.ts`) and REST client (`lovable-rest.ts`)

**MCP tools reachable** (all via `call()`, `lovable-mcp.ts:206-222`, called only from
`harness/src/executor/beats.ts` and `harness/src/executor/experiments.ts`/sync code — never from the
web app directly):

| Lovable MCP tool | Called at | Effect |
|---|---|---|
| `get_me` | `lovable-mcp.ts:226` | read |
| `list_projects` | `lovable-mcp.ts:236` | read |
| `list_messages` | `lovable-mcp.ts:244` | read |
| `get_project_knowledge` | `lovable-mcp.ts:254` | read |
| `get_workspace_knowledge` | `lovable-mcp.ts:258` | read |
| `list_workspace_skills` | `lovable-mcp.ts:263` | read |
| `set_project_knowledge` | `lovable-mcp.ts:268` | **write** — Knowledge |
| `set_workspace_knowledge` | `lovable-mcp.ts:272` | **write** — Knowledge |

That's the entire allowlist: no `send_message`, `remix_project`, `deploy_project`, or
`delete`-shaped tool is ever called through the Lovable MCP client. Confirms memory note
`lovable-rest-api-via-executor-token`: those operations (remix, chat/send, delete, visibility) are
done over REST instead, in `lovable-rest.ts`.

**REST endpoints** (`harness/src/executor/lovable-rest.ts`), used only by
`harness/src/executor/experiments.ts` (the paired-test runner):

| Method | Path | Client fn (line) | Credit-spending? | Guard |
|---|---|---|---|---|
| GET | `/v1/projects/{id}` | `getProject` | no | – |
| GET | `/v1/projects/{id}/messages` | `listMessages` (362) | no | – |
| GET | `/v1/projects/{id}/edits` | `listEdits` (385) | no | – |
| GET | `/v1/projects/{id}/diff` (via edits) | `getDiff` (409) | no | – |
| POST | `/v1/projects` (remix) | `remixInit` (433) | **yes** (creates a project) | none beyond caller passing a real `sourceId`; only ever called from `experiments.ts` against `assertAllowedProject`-checked rules |
| GET | `/v1/projects/{id}/remix/progress` | `remixProgress` (461) | no | – |
| PUT | `/v1/projects/{id}/knowledge` | `setProjectKnowledge` (485) | no (this REST path exists but per §2/§4 the executor's actual Knowledge writes go through the MCP `set_project_knowledge`, not this) | – |
| POST | `/v1/projects/{id}/messages` (chat) | `chat` (502) | **yes — the main credit spend** | **`allowCopy(id)` allowlist** (`lovable-rest.ts:489-491,502-507`): refuses with no HTTP call at all unless `id` was explicitly registered via `allowCopy`, and `experiments.ts` only ever calls `allowCopy` on the freshly-created remix copy, never the source project |
| GET | `/v1/projects/{id}/messages/{messageId}` | `getMessage` (525) | no | – |
| DELETE | `/v1/projects/{id}` | `deleteProject` (566) | no (frees a project) | called only from `experiments.ts:660,677` against `run.copy_project_id`/`run.original_copy_project_id`, values the executor itself set from remix results (`store.ts` `updateExperimentRun`), never user/caller-supplied strings |
| PATCH | `/v1/projects/{id}` (visibility) | `setProjectVisibility` (575) | no | same call-site restriction as `deleteProject` |

Credit-spending calls: `remixInit` (creates a project — Lovable-side cost) and `chat` (the real
per-message credit spend). `chat`'s `allowCopy` guard is the one deliberate defense in this file
(`lovable-rest.ts:493-501` comment explains it's specifically to stop a bug from spending the user's
real-project credits). `deleteProject`/`setProjectVisibility` have no equivalent allowlist function —
their safety is entirely "the only call sites pass executor-derived ids," which held up under
inspection but is enforced by convention, not by a guard function the way `chat` is.

## 5. `harness/src/web/server.ts`

Self-documented as diagnostic-only and deprecated: `web/server.ts:1-9` — "DIAGNOSTIC UI ONLY... Do
not add new product functionality here... Scheduled for removal." It is the target of the root
`package.json` `"ui"` script (`package.json` → `"ui": "npm --prefix harness run ui"` →
`harness/package.json` `"ui": "tsx src/web/server.ts"`).

It exposes **zero authentication** — no header/token/session check anywhere in the file — over a
plain `node:http` server (`web/server.ts:161-214`) that:
- lists all correction candidates and rules (`GET /corrections`, `GET /rules`)
- accepts `POST /corrections/:id/review` → `store.reviewCorrectionCandidate` (`web/server.ts:177-189`)
- accepts `POST /rules/:id/update` → `store.updateRule`, **including arbitrary `state` values**
  (`web/server.ts:190-203`) — the same ungated primitive as MCP's `update_rule` (§2 finding 2), reachable
  over plain HTTP with a hardcoded `actor: "operator (local UI)"`.

`server.listen(PORT, ...)` (`web/server.ts:212-214`) passes no host, so Node binds all interfaces by
default — anyone who can reach the port (default `4500`, `web/server.ts:13`) on the network can
mutate the live rule/correction state with no login. This script is not started by anything
automatically (only a manual `npm run ui`), so the practical exposure depends entirely on where a
person runs it; on a shared or cloud dev box it is a real open door.

## 6. Web app server routes and dev server binding

Every route under `src/routes/api/public/harness/*.ts` calls a local `requireAuth` helper
(present verbatim in each file, e.g. `src/routes/api/public/harness/rules.ts:9-18`) which delegates
to `requireCronOrUser` (`src/lib/server/auth.ts:15-54`). That function accepts either:
- an `x-cron-secret` header matching `process.env.CRON_SECRET` (`auth.ts:16-20`), or
- a `Bearer <jwt>` whose claims are verified against Supabase via `supabase.auth.getClaims`
  (`auth.ts:22-53`).

So **"public" in the path is a URL-naming convention, not a statement about auth** — these are not
open endpoints; every one of `runtime.ts`, `corrections.ts`, `rules.ts`, `skills.ts`, `projects.ts`,
`knowledge.ts`, `executor.ts`, `improvements.ts` checked out with the same `requireAuth()` call at
the top of both `handleGet` and `handlePost` (verified by reading each file's opening block; see
excerpts pulled during this audit). One consequence worth flagging: `rules.ts`'s POST handler
(`rules.ts:33-52`) calls `adapter.updateRuleAction` → `harness/src/adapter.ts:313-316` →
`store.updateRule` directly, with the same `ruleState` enum as MCP's `update_rule` and the *same*
absence of budget/mode gating (`adapter.ts:305-311`). This means §2 findings 2–3 are not unique to
MCP — an authenticated web-app caller hitting this route directly has the identical bypass. MCP is
simply the least-guarded of the three paths to `store.updateRule` (web route: needs a valid Supabase
session or the cron secret; old diagnostic server: needs network access to port 4500; MCP: needs
only to be able to spawn/connect to the `harness` MCP server process, which `.mcp.json` does by
default for any Claude Code session in this repo).

`vite.config.ts:8-16` binds the dev server to `127.0.0.1` by default and only widens to all
interfaces (`0.0.0.0`) when `DEV_HOST_OPEN=1` is explicitly set — the comment at
`vite.config.ts:8-15` explains this was deliberately changed from the shared config's default
because it would otherwise expose "an authenticated Harness API surface holding real project
history" to the LAN. `npm run dev` therefore does **not** expose these routes beyond localhost
unless a developer opts in.

## 7. Test coverage of `mcp-server.ts`

There is no `mcp-server.test.ts` and no test spins up the actual `McpServer`/stdio transport or
calls a tool by name through the MCP protocol. Coverage that exists is (a) store-level tests that
happen to exercise the same functions the tools wrap, and (b) static source-grep assertions on
`mcp-server.ts`'s text:

- `test/verification.test.ts:226-261` — `safe_to_delete` defaults false at registration.
- `test/verification.test.ts:263-272` — `registerExperimentResource` throws for a `source_project_id`
  not in `allowed_projects`.
- `test/verification.test.ts:274-298` — `safe_to_delete` flips to true on an explicit call **even
  when `source_project_id` is the real allowed project** (this is the test that doubles as evidence
  for §2 finding 5).
- `test/verification.test.ts:300-304` — `listCleanupRequiredResources` filters correctly.
- `test/verification.test.ts:306-309` — regex-greps `mcp-server.ts` source for
  `send_message|chat\(|sendPrompt|executeExperiment|run_experiment` and asserts none present.
- `test/verification.test.ts:311-320` — regex-greps `mcp-server.ts` and `adapter.ts` for
  `execute_sql|run_sql|raw_query|generic_mutation`.
- `test/verification.test.ts:322-339` and `test/knowledge.test.ts:519-546` — assert `mcp-server.ts`
  (and `store.ts`, `improvements.ts`, `knowledge.ts`, `adapter.ts`) have no `import.*lovable`, no
  `fetch(`/`http.request`/`https.request`, and no `setProjectKnowledge`/`setWorkspaceKnowledge`/etc.
  string occurrence.

What is **not** tested anywhere: `update_rule`'s ability to set `state: "active"` directly with no
budget/mode check (§2.2); `create_rule`'s missing allowlist/ownership check (§2.3); the
`list_pending_knowledge_writes` → `record_knowledge_readback` echo-back fabrication path (§2.1);
`review_correction_candidate`'s bypass of `decided_by` provenance (§2.4). All four are exercised
here only by reading the code, not by a failing/passing test — they are `implemented_but_untested`
findings, not `verified` bugs with a reproduction run (no live DB was touched, per the read-only
rule).

## Proposed minimal permission layer

One module, e.g. `harness/src/guard.ts`, exporting a small set of checks that both
`src/routes/api/public/harness/*.ts` (via `harness/src/adapter.ts`) and `harness/src/mcp-server.ts`
call before reaching `store.ts`:

```ts
export function assertProjectAllowed(projectId: string): void            // wraps store.isAllowedProject
export function assertModeAllows(action: "approve" | "activate"): void   // reads decision_mode; throws in 'ask' unless actor === trusted executor
export function assertBudgetOk(estimatedCredits: number): void           // reuses testBudgetRefusal's math, currently private to improvements.ts
export function assertOwnershipConsistent(ruleId: number, requestedState: RuleState): void
export function assertNotSourceProject(resourceId: number): void         // refuses safe_to_delete=true when resource.source_project_id has no non-source resource_type recorded for the same project
export function assertTrustedActor(actor: string, capability: "record_readback" | "activate_rule"): void
```

Concretely: move `testBudgetRefusal`/budget math out of `improvements.ts` into this module (it's
already a pure function of two numbers, `improvements.ts:445-446`); give `store.updateRule` an
optional `via: "ui-gated" | "raw"` parameter (or, better, split it into `updateRuleGated` — calls all
the above, used by `improvements.ts` — and keep bare `updateRule` for `beats.ts`'s own trusted
internal calls); have `mcp-server.ts`'s `update_rule`/`create_rule`/`review_correction_candidate`/
`record_knowledge_readback` tools call the gated versions; delete `update_experiment_resource_status`
and its siblings from `mcp-server.ts` entirely (dead surface, §3) rather than gating dead code; and
either delete `harness/src/web/server.ts` or put `requireCronOrUser`-equivalent auth in front of it
(it has no such infra today since it's a bare `node:http` server, not a TanStack route).

**Estimate: 6–8 hours.** Breakdown: extract `guard.ts` + budget/mode/ownership checks (2h), split
`updateRule`/wire gated version into `improvements.ts` and `adapter.ts` (1.5h), wire `mcp-server.ts`'s
four sensitive tools through the guard and delete the 10 dead checkpoint-C tools (2h), add
`assertNotSourceProject` plus a regression test mirroring `verification.test.ts:274-298` but
asserting a refusal instead (1h), remove or lock down `web/server.ts` (0.5–1h), update
`docs/HANDOFF.md` and this file (0.5h).

## Harness MCP — what to tell users in the README today

Verified-safe, implemented, and true today (no Lovable network call is possible from any Harness
MCP tool, confirmed in §2.6/§7):

- Read the Harness Ledger allowlist, cached project metadata, rules, correction candidates,
  learnings, task episodes, and the full audit-event/knowledge-version history.
- Record new evidence (chat messages, diffs, edits, build-log rows, spec excerpts, manual notes) and
  reconstruct task episodes from it, for projects on the allowlist.
- Create correction candidates, learnings, and proposed rules from that evidence.
- Define and link verification checks and record experiment plans — **bookkeeping only; nothing here
  ever runs, executes, or costs anything, and none of it is currently read by the live product UI or
  the real paired-test runner** (§3).

Implemented but **not currently safe to advertise as gated**, and should be called out or fixed
before documenting further: `update_rule` and `review_correction_candidate` can approve, activate, or
reject a suggestion without going through the app's Ask/Automatic decision setting or credit budget;
`record_knowledge_readback` can be used to mark a Knowledge write "done" and a rule "active" without
Harness ever confirming a real Lovable write occurred. Until the guard layer above exists, the README
should say plainly that Harness MCP mutation tools are **trusted-caller only** (intended for
Harness's own executor, not for arbitrary agent use) rather than describing them as safe for a
general "use Harness Ledger through MCP" workflow.

## Summary

Harness MCP (`mcp-server.ts`, 33 tools, registered in `.mcp.json` against the real database) predates
the executor and was never re-gated after `beats.ts` took over real writes. Read tools and
allowlist-checked evidence/episode/experiment-plan tools are fine. Two tools are a real, live-data
problem: `update_rule` can set any rule state (including `active`) with none of `improvements.ts`'s
mode/budget/evidence gates, and `record_knowledge_readback`, combined with `list_pending_knowledge_writes`
disclosing the expected content, lets a caller fabricate proof of a Lovable write with zero Lovable
contact. `create_rule` lacks any allowlist/ownership check. Ten of the 33 tools
(`experiment_plans`/`experiment_resources`/`verification_*`) write to tables the live executor and UI
never read — dead surface, including the "mark safe to delete" capability the audit was asked to
check, which is real at the data layer (a test literally proves it works on the true source project)
but inert because nothing consumes the flag. The Lovable MCP client only ever calls 8 read/Knowledge
tools; credit-spending REST calls (`chat`, `remixInit`) are properly restricted to executor-created
copy projects, `chat` behind an explicit `allowCopy` allowlist. The old diagnostic
`harness/src/web/server.ts` is unauthenticated and mutates rules/corrections over plain HTTP — low
practical risk since it's manual-only, but worth deleting per its own "scheduled for removal" note.
Web-app `/api/public/harness/*` routes are genuinely authenticated (Supabase JWT or cron secret)
despite the "public" path segment, and `npm run dev` binds `127.0.0.1` unless a developer opts into
`DEV_HOST_OPEN=1`. No test exercises the MCP tool surface behaviorally; existing tests are store-level
or static source greps, and none of the four ungated-mutation findings above has a failing test today.
