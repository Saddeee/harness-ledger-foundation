# Harness (local)

The local half of Harness Ledger: a SQLite-backed store and an MCP server, run on
your own machine. This is intentionally separate from `../src`, which is the
hosted Lovable app (landing page + preserved hosted-runtime preview). Nothing in
here is required by, or should be imported into, the hosted app.

See `../SPEC.md` ("Architecture pivot" section) for why this exists: Lovable's
hosted OAuth client-metadata-document flow is currently rejected by Lovable's
own authorization server ("Client Not Found"), so there is no supported way yet
for a hosted app to authenticate to a user's Lovable account. Claude Code's own
connection to Lovable (the `lovable` MCP server below) already works, because it
authenticates differently. Harness runs locally so it can ride on that working
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

This is deliberately the smallest possible slice -- correction mining
(reading real Lovable history to generate candidates automatically),
Skills, verification, and experiments are later checkpoints (see
`../SPEC.md`).
