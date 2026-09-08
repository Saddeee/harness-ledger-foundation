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

## Tools exposed by `harness`

| Tool | Does |
|---|---|
| `health` | Liveness check; returns the resolved DB path. |
| `create_test_record` | Inserts a throwaway row. Proves writes work. |
| `get_allowed_projects` | Lists the Lovable project IDs Claude Code may act on. Read-only. |
| `upsert_project` | Stores/updates cached, redacted metadata for an approved project. |
| `append_event` | Appends an audit-log row. |
| `list_events` | Lists recent audit-log rows, newest first. |

This is deliberately the smallest possible slice -- Checkpoint A proves the
plumbing, not the product. Correction mining, learnings, rules, Skills,
verification, experiments and the local web UI are later checkpoints (see
`../SPEC.md`).
