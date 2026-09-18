# Harness Ledger (local)

The local half of Harness Ledger: a SQLite-backed store and an MCP server, run on
your own machine. This is intentionally separate from `../src`, which is the
hosted Lovable app (landing page + preserved hosted-runtime preview). Nothing in
here is required by, or should be imported into, the hosted app.

Why this exists: Lovable's
hosted OAuth client-metadata-document flow is currently rejected by Lovable's
own authorization server ("Client Not Found"), so there is no supported way yet
for a hosted app to authenticate to a user's Lovable account. Claude Code's own
connection to Lovable (the `lovable` MCP server below) already works, because it
authenticates differently. Harness Ledger runs locally so it can ride on that working
connection via Claude Code, instead of waiting on a hosted auth path.

## Node version

This package (`harness/`, standalone MCP server + SQLite store + diagnostic
UI) works fine on Node 18.19+. **The root app it plugs into (`../`) does
not** -- it requires Node `>=22.12.0` (see `../.nvmrc` / `../README.md`).
Node 20 gets partway there (it satisfies the bundler's floor) but crashes
on any Supabase-authenticated route with a native-`WebSocket`-not-found
error; only 22+ works fully. If you're running the whole repo, use the
root's Node version for everything, including here, for simplicity.

**Native module gotcha:** `better-sqlite3` is a compiled native addon, tied
to the exact Node ABI it was installed under. If you switch Node major
versions (e.g. moving from Node 18 to the 22 the root app requires),
`npm install` again in `harness/` (not just the root) before running
anything here -- otherwise every query segfaults (`SIGSEGV`) instead of
raising a normal JS error. `npm run harness:build` alone does not fix this;
it only recompiles TypeScript, not the native binding.

## Setup

```sh
cd harness
npm install
npm run seed -- <lovable_project_id> "label"   # add a project to the allow-list
npm run typecheck
```

The allow-list (`allowed_projects`) has no MCP tool that can write to it —
only `npm run seed`, run by a human, can approve a new project. An agent can
read the list (`get_allowed_projects`) but can never grant itself access to a
project that isn't already there.

Data lives in `harness/data/harness.db` (gitignored, created on first run).

## Running the MCP server standalone

```sh
npm run dev
```

Speaks MCP over stdio. Not meant to be run directly by a person — Claude Code
launches it (see below).

## Connecting Claude Code to both MCP servers

The repo root has `.mcp.json` declaring both servers:

```json
{
  "mcpServers": {
    "lovable": { "type": "http", "url": "https://mcp.lovable.dev/?src=docs" },
    "harness": { "command": "npx", "args": ["tsx", "harness/src/mcp-server.ts"], "env": { "HARNESS_DB_PATH": "harness/data/harness.db" } }
  }
}
```

Open (or restart) a Claude Code session with this repo (`harness-ledger-foundation/`)
as the working directory and both `lovable` and `harness` tools become
available; `lovable` will prompt an OAuth login in your browser the first time,
same as any other Claude Code project using it.

## Tools exposed by `harness` (MCP server)

| Tool | Does |
|---|---|
| `health` | Liveness check; returns the resolved DB path. |
| `create_test_record` | Inserts a throwaway row. Proves writes work. |
| `get_allowed_projects` | Lists the Lovable project IDs Claude Code may act on. Read-only. |
| `upsert_project` | Stores/updates cached, redacted metadata for an approved project. |
| `append_event` | Appends an audit-log row. |
| `list_events` | Lists recent audit-log rows, newest first. |
| `create_project_snapshot`, `upsert_history_item`, `create_task_episode`, `update_task_episode`, `create_correction_candidate`, `review_correction_candidate`, `create_learning`, `create_rule`, `update_rule`, `get_rule`, `list_project_rules` | The correction-to-rule pipeline (checkpoint B). See `src/store.ts` for the full contract. |

## The product UI vs. the diagnostic UI

As of checkpoint B.1, the **product UI is the existing TanStack Start app**
(`../src/routes/_authenticated/inbox.tsx` = Corrections, `.../ledger.tsx` =
Rules), not a separate page. It talks to this package through a thin
server-only bridge:

```
TanStack route component (client)
  --fetch--> src/routes/api/public/harness/{corrections,rules}.ts (server route)
    --dynamic import, only if HARNESS_RUNTIME=local--> harness/dist/adapter.js
      --> harness/src/store.ts --> SQLite
```

`harness/src/adapter.ts` is the one file that bridge is allowed to import --
validated inputs, no arbitrary SQL, no generic mutation endpoint. Run
`npm run build` here (or `npm run harness:build` from the repo root) after
any change to `src/`, since the bridge imports compiled `dist/`, not `src/`
directly, so that loading it never depends on the TanStack app's own
Vite/TS toolchain being able to transform a sibling package at runtime.

`harness/src/web/server.ts` (`npm run ui`) is a **diagnostic view only** --
a raw, dependency-free way to poke at the SQLite data directly. It predates
the TanStack integration and is not the product interface; don't add new
functionality to it. It's scheduled for removal once the TanStack UI has
full parity with it.

## Adding a rule to Lovable (two-beat)

The app never writes to Lovable. Adding an instruction to Knowledge is a
two-beat handshake between the UI and the local executor
(`npm run harness:executor`, see below), which holds the Lovable connection.
Beats 0 and 2 are the executor's; beat 1 is the user's click.

**Beat 0 — snapshot (before the user can even see a preview).** The executor
reads the live Knowledge and records it verbatim, on every sync:

1. `get_project_knowledge(project_id)` (or `get_workspace_knowledge(workspace_id)`) over Lovable MCP.
2. `record_knowledge_snapshot(target, project_id | workspace_id, content, fetched_by)` over Harness MCP.

Until a snapshot exists for a target, the Inbox shows "Harness Ledger hasn't read
your current Knowledge yet" and an accepted choice stays `write_status:
"none"`.

**Beat 1 — the user approves in the UI.** "Add it to Lovable now" composes
the exact final text from the latest snapshot (everything outside
`<!-- harness:start -->`…`<!-- harness:end -->` preserved byte-for-byte, the
managed block regenerated, capped at the Knowledge limit setting -- default
9,000 characters, configurable in Settings) and stores a `knowledge_versions`
row with `status: "pending"`, both hashes, and the rule ids. Nothing has
touched Lovable yet.

**Beat 2 — the executor executes, exactly this, per pending write, at the
next sync (`--once` or the loop):**

1. `list_pending_knowledge_writes()` → each row carries `target`, the id,
   `previous_sha256` (what the write was composed against) and `new_content`.
2. Read the LIVE content: `get_project_knowledge` / `get_workspace_knowledge`.
3. If `sha256(live) != previous_sha256` → `mark_knowledge_write_stale(version_id, reason)` and stop for this row. Never write over content you did not preview.
4. Else `set_project_knowledge(project_id, new_content)` / `set_workspace_knowledge(workspace_id, new_content)`.
5. Read back with `get_*_knowledge` again.
6. `record_knowledge_readback(version_id, read_back_content)` — Harness Ledger marks the
   version `written` (and the rule `active`, stage "In Lovable") only if the
   read-back is byte-identical; otherwise `failed`.
7. Any other error → `mark_knowledge_write_failed(version_id, error)`.

## Executor

The executor is the only process that talks to Lovable. It holds the OAuth
connection, reads chats and Knowledge, and performs beat 2 above. It spends no
credits; runs an AI analysis only when you press Analyse now (or `--analyse`),
and may call only eight Lovable tools (`get_me`, `list_projects`,
`list_messages`, get/set project knowledge, get/set workspace knowledge,
`list_workspace_skills`).

```
npm run harness:executor -- --connect      # once: browser consent, tokens to data/lovable-auth.json (0600)
npm run harness:executor -- --status       # connection, schedule, last run, next run
npm run harness:executor -- --once         # one full pass, then exit (crontab-friendly)
npm run harness:executor                   # the scheduler loop; Ctrl-C to stop
npm run harness:executor -- --disconnect   # revoke and delete the local credentials
npm run harness:executor -- --analyse      # one AI analysis pass, then exit -- see "AI analysis" below
```

One pass runs four beats, each idempotent: sync history (newest-first per
allowed project, stopping at the first page containing a message already
stored, content redacted), snapshot Knowledge (project + workspace, skipped
when the sha256 is unchanged), snapshot workspace Skills, then execute pending
Knowledge writes. Every pass writes one `sync_runs` row with counts.

The loop ticks every 30 s. It runs immediately when the UI's "Sync now" left a
`sync_requests` row, otherwise on the schedule in `settings`
(`sync_enabled`, `sync_interval_minutes`, `sync_window_start_hour`,
`sync_window_end_hour` — by default hourly between 10:00 and 22:00 local). Only
one run at a time; a run still marked running after 15 minutes is treated as
crashed. While not connected it logs the connect hint at most once per ten
minutes and does nothing else.

A restore ("Restore previous version" in the UI) is just another pending
row whose `new_content` is the earlier version's `previous_content`; it goes
through the same beat 2. History is append-only.

## AI analysis

Analysis (classifying messages, mining corrected task episodes into rule
proposals) never runs on its own -- only when you press "Analyse now" in the
UI or run `--analyse` above. It's independent of the executor's sync loop and
never touches Lovable itself.

**Providers.** Configured per role (classifier/miner/reviewer/proposer) in
Settings, one of:
- **OpenAI, Anthropic, or Google** -- paste an API key in Settings; it's
  saved to `data/llm-keys.json` (mode 0600, gitignored, next to the database
  -- path overridable via `HARNESS_LLM_KEYS_PATH`, see `.env.example`), never
  into SQLite, never logged.
- **Claude Code** -- runs the `claude` CLI already on your machine, on your
  existing Claude Code subscription. No key to store; requires `claude` on
  `PATH`.

**Budget.** A monthly token cap (`llm_monthly_token_budget` in Settings, a
token count since a Claude Code subscription call has no per-call USD price)
is checked *before* every call; a call that would exceed it is refused
(`LlmBudgetExceeded`) rather than dispatched.

**Where runs are recorded.** Every analysis pass writes one `analysis_runs`
row (ok/error, counts, tokens, cost) and every individual model call writes
one `llm_calls` row (provider, model, tokens in/out, cost) -- both in the
same SQLite database as everything else, and both surfaced in the product UI
(provider status, token budget, last run) alongside the Inbox/Instructions
pages.

This is deliberately the smallest possible slice -- Skills, verification, and
experiments came in later rounds.
