# Audit files (checkpoint 2026-09-18)

Each file here is written by one auditor (a subagent) and then verified by the orchestrator.
Every claim must carry a `file:line` citation or a command + output. Status labels:

- verified — traced in code AND confirmed by a test run, database row, or executed command
- implemented_but_untested — code path exists, no test or live evidence
- exposed_but_unimplemented — a tool/route/button exists but the path behind it does nothing or is a stub
- unavailable — no code and no external capability
- blocked — external capability exists but something (auth, policy, safety) prevents use
- inferred — the auditor believes it from names/comments only; must be re-checked before it is relied on

Rules for auditors: read-only. Never call any `mcp__lovable__*` or `mcp__harness__*` tool. Never edit files
outside `docs/audit/`. Never run anything that talks to Lovable or an LLM provider. `cd harness && npm test`,
`npm run typecheck`, `node -e` against a read-only copy of the SQLite file, `grep`, and reading source are fine.
