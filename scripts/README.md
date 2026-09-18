# scripts/

Two small, dependency-free Node ESM scripts invoked via `npm run setup` / `npm run harness:start` (root
`package.json`).

- `lib.mjs` — pure helpers (Node version check, default DB path, default env), unit-tested directly in
  `harness/test/setup-scripts.test.ts`.
- `setup.mjs` — checks the Node version, installs and builds both npm packages, opens the SQLite database
  once so pending migrations run, and reports whether Lovable / an AI provider are already configured.
  Flags: `--skip-install` (skip the two `npm install` steps), `--dry-run` (print the steps, run nothing).
- `harness-start.mjs` — starts `npm run dev` with `HARNESS_RUNTIME=local`, a repo-local absolute
  `HARNESS_DB_PATH`, and `HOST=127.0.0.1`, without overriding any of those the caller already set. Flag:
  `--print-only` (print the resolved env as JSON, exit without starting anything).
