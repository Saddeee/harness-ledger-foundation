# Local executor, Knowledge page, and the decision flow

Date: 2026-09-11. Status: approved in chat by the owner (direction); this document fixes the details.
Supersedes Part C of the owner's original `SPEC.md` (kept outside this repo) for everything below. Parts A/B of that spec remain the product intent; where this document disagrees, this document wins. Nothing in the UI may mention a spec.

## 1. Facts this design rests on (verified 2026-09-11)

- Lovable's authorization server (`https://lovable.dev/oauth`) supports **dynamic client registration for loopback redirect URIs**. A `POST /oauth/register` with `redirect_uris: ["http://127.0.0.1:8765/callback"]`, `token_endpoint_auth_method: "none"`, grants `authorization_code` + `refresh_token`, scope `offline projects:read projects:write workspaces:read workspaces:write` returned HTTP 201 and a `client_id`. PKCE S256 is supported. So a local Node process can hold its own Lovable grant without Claude Code and without an LLM.
- Lovable's MCP server (`https://mcp.lovable.dev/`) is a Streamable-HTTP MCP endpoint protected by that authorization server (`/.well-known/oauth-protected-resource`). `@modelcontextprotocol/sdk` 1.30.0 (already in `harness/node_modules`) ships a Streamable-HTTP client and an `OAuthClientProvider` interface that performs discovery, dynamic registration, PKCE and refresh.
- Reads over MCP (`list_messages`, `get_project_knowledge`, `get_workspace_knowledge`, `list_workspace_skills`, `list_projects`, `get_me`) cost **no Lovable credits**. Writes to Knowledge (`set_*_knowledge`) cost none either. Only `send_message`, `create_project`, `remix_project` and friends spend credits; this design never calls them.
- `list_messages` returns newest-first pages of `{ message_id, role: "user"|"assistant", status, created_at, edit_id, content }` with `pagination.next_cursor`. Assistant `content` embeds the builder's activity log (tens of KB per message).
- The owner's workspace `937baaeb85dfcb22e8b2` currently has **no Skills** and **empty workspace Knowledge**; project `28bd5471-…` has Knowledge with no Harness-managed block yet.
- The local SQLite store already has: `history_items`, `task_episodes`, `correction_candidates`, `learnings`, `rules`, `rule_revisions`, `knowledge_snapshots`, `knowledge_versions` (pending → written | stale | failed, with restore lineage), `experiment_plans` (proposed | approved | rejected), `verification_*`, `events`, `allowed_projects`. Store functions `latestKnowledgeSnapshot`, `listKnowledgeVersions`, `activeRulesForTarget`, `listPendingKnowledgeWrites`, `createRestoreVersion`, `recordKnowledgeSnapshot`, `recordKnowledgeReadback`, `markKnowledgeWriteStale/Failed` exist and are tested.
- Nothing runs on a schedule today. One `pending` Knowledge write from 2026-09-11 has never been executed.

## 2. Operating principle

Automate everything that costs neither LLM tokens nor Lovable credits: syncing chat history, snapshotting Knowledge and Skills, executing approved Knowledge writes, reading back. Anything that spends tokens (spotting corrections, drafting instructions) or credits (tests in a temporary copy) stays user-triggered until the owner says otherwise. The UI must always say which of the two a thing is.

## 3. The local executor (`harness/src/executor/`)

A Node process in the `harness/` package. No LLM, no Lovable credits.

### 3.1 Lovable connection (`executor/lovable-auth.ts`)
- Implements `OAuthClientProvider` from `@modelcontextprotocol/sdk/client/auth.js`: client metadata `{ client_name: "Harness Ledger (local)", redirect_uris: ["http://127.0.0.1:8765/callback"], grant_types: ["authorization_code","refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", scope: "offline projects:read projects:write workspaces:read workspaces:write" }`.
- Persists client registration and tokens in `harness/data/lovable-auth.json` (gitignored, mode 0600). Never logs tokens. Never reads Claude Code's credential store.
- `connect()` starts a one-shot HTTP listener on 127.0.0.1:8765, returns the authorization URL, waits for the callback (10 minute timeout), exchanges the code, stores tokens, calls `get_me` and stores `{ email, name, workspaces }` in the same file (no secrets in that part), stops the listener.
- `disconnect()` deletes the file (and best-effort revokes at the revocation endpoint).
- `status()` → `{ connected, email, workspaces, expires_at }` without secrets.

### 3.2 Lovable MCP client (`executor/lovable-mcp.ts`)
- `Client` + `StreamableHTTPClientTransport("https://mcp.lovable.dev/", { authProvider })`. Typed wrappers: `listMessages(project_id, cursor?, limit=50)`, `getProjectKnowledge`, `getWorkspaceKnowledge`, `setProjectKnowledge`, `setWorkspaceKnowledge`, `listWorkspaceSkills(include_markdown=true)`, `listProjects(workspace_id)`, `getMe`.
- A single retry on 401 after refresh; on 429 honour `retry-after` once, then stop the run with an error recorded in `sync_runs`.

### 3.3 Beats (`executor/beats.ts`), each idempotent
1. **sync-history**: for each `allowed_projects` row, page `list_messages` newest-first until a page contains a `message_id` already in `history_items` (kind `message`, `external_id = message_id`) or `has_more` is false. Insert new rows via `store.upsertHistoryItem` with `role`, `content` redacted (patterns: `sk-…`, `lov_…`, `ghp_…`, `AKIA…`, JWT-like, PEM blocks, emails → `[redacted:<type>]`), `occurred_at = created_at`, `provenance = "executor sync"`, `source_ref = edit_id`. Assistant messages are stored verbatim after redaction (the UI already extracts the human-visible part).
2. **snapshot-knowledge**: for each allowed project, `get_project_knowledge` → `store.recordKnowledgeSnapshot("project", …, fetched_by "executor")`; once per run for the workspace → `recordKnowledgeSnapshot("workspace", …)`. Skip the insert when the sha256 equals the latest snapshot's (no churn).
3. **snapshot-skills**: `list_workspace_skills(include_markdown=true)` → upsert `skill_snapshots` (new table, §5). Record a snapshot only when content changed.
4. **execute-writes**: `store.listPendingKnowledgeWrites()`; for each: read live text, compare sha256 to `previous_sha256`; mismatch → `markKnowledgeWriteStale(version_id, reason)`; else `set_*_knowledge(new_content)`, read back, `recordKnowledgeReadback(version_id, read_back)`; any error → `markKnowledgeWriteFailed`. This is the existing two-beat protocol, now run by the executor instead of Claude Code.
5. Every beat appends `events` rows (`executor.sync.started/finished`, `executor.write.written/stale/failed`) and one `sync_runs` row per run with counts.

Not automated (needs an LLM): turning new `history_items` into `task_episodes` / `correction_candidates` / `learnings` / `rules`. The UI shows how many synced messages are waiting for analysis. Analysis remains a Claude Code action for now.

### 3.4 Scheduler (`executor/schedule.ts`, `npm run harness:executor`)
- Long-running loop. Every 30 s it checks: (a) a `sync_requests` row with `status = "requested"` → run all beats now; (b) the schedule: run when `now - last_run >= interval_minutes` and local hour is within `[window_start_hour, window_end_hour)` (defaults 60 min, 10, 22) and `enabled = true`. Settings come from the `settings` table (§5).
- `npm run harness:executor -- --once` runs one full pass and exits (usable from a real crontab). `--connect` runs the connect flow from the terminal and prints the URL.
- Only one run at a time; a run older than 15 minutes still marked running is treated as crashed and superseded.

## 4. Web API (server routes under `src/routes/api/public/harness/`)

All authenticated like the existing routes; available only when `HARNESS_RUNTIME=local`, else `{ available: false, reason }`.

- `GET knowledge` → `{ available, targets: [{ target: "project"|"workspace", id, name, current: { content, sha256, fetched_at } | null, managed_block_present, active_rules: [{ id, text }], versions: [{ id, status, created_at, written_at, actor, reason, restored_from_version_id, char_count }], pending_write: { version_id, created_at } | null }], skills: { fetched_at, items: [{ name, description, updated_at, content }] } | null, awaiting_analysis: number }`.
- `POST knowledge { action: "restore", version_id }` → stages a restore version (existing `createRestoreVersion`), returns the new pending version id.
- `GET executor` → `{ available, connection: { connected, email, workspaces }, schedule: { enabled, interval_minutes, window_start_hour, window_end_hour }, last_run: { started_at, finished_at, ok, error, counts } | null, next_run_at, running }`.
- `POST executor { action: "sync_now" }` → inserts a `sync_requests` row (or returns the existing open one). `{ action: "connect" }` → runs `connect()` in the web server process, returns `{ url }`; the page opens it in a new tab. `{ action: "disconnect" }`. `{ action: "schedule", enabled, interval_minutes, window_start_hour, window_end_hour }` validates (interval ≥ 15, hours 0–24, start < end) and saves.
- `GET projects` → allowed projects with `last_synced_at`, `history_count`; plus, when connected, the workspace's project list from Lovable (`list_projects`, cached 10 min) with `allowed: boolean`. `POST projects { action: "allow", lovable_project_id, label }` / `{ action: "disallow" }` — the allow-list stays human-only: this route is only reachable by the signed-in owner from the UI, and no MCP tool gains write access.
- `POST improvements` gains `{ action: "accept", id, destination, test_first: true }`: sets the rule `approved` and the item's experiment plan `approved` (creating one if absent, `status: "approved"`, `created_by: "owner via UI"`) and **does not** stage a write. The improvement's group becomes "Waiting to be tested". A later `{ action: "accept", id, destination }` (from "Change decision → Add without testing") stages the write as today.

`adapter.ts` re-exports what these routes need (`getAllowedProjects`, `latestKnowledgeSnapshot`, `listKnowledgeVersions`, `activeRulesForTarget`, `listPendingKnowledgeWrites`, `createRestoreVersion`, `listEvents`, plus the new settings/sync/skills functions). The web server never imports the executor's Lovable client except for the `connect` action; all other Lovable traffic happens in the executor process.

## 5. Data-layer additions (`harness/src/migrations.ts` v5)

- `settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT)` with seeded keys: `sync_enabled` ("true"), `sync_interval_minutes` ("60"), `sync_window_start_hour` ("10"), `sync_window_end_hour` ("22"), `knowledge_char_cap` ("9000"), `require_approval_before_write` ("true", read-only in UI for now).
- `knowledge.ts` reads the cap from `settings.knowledge_char_cap` (fallback 9000) instead of the constant; `KNOWLEDGE_CAP` stays exported as the default.
- `skill_snapshots(id, workspace_id, name, description, content, sha256, updated_at_remote, fetched_at, fetched_by)`; `store.recordSkillSnapshot`, `store.latestSkillSnapshots(workspace_id)`.
- `sync_runs(id, kind TEXT, started_at, finished_at, ok INTEGER, error TEXT, counts_json TEXT)`; `store.startSyncRun/finishSyncRun/latestSyncRun`.
- `sync_requests(id, requested_at, status requested|done, run_id)`; `store.requestSync/takeSyncRequest/completeSyncRequest`.
- `history_items` unchanged; `store.countHistoryItemsAwaitingAnalysis()` = messages with role `user` not linked to any `task_episode_evidence`.

## 6. UI

Navigation: **Inbox, Improvements, Knowledge, Projects, Settings** (same in both runtimes; hosted mode shows its existing Projects/Settings and a Knowledge page that explains it needs the local runtime).

### 6.1 Knowledge page (`/knowledge`)
For each target (each allowed project, then the workspace):
- Heading with the name; a status line: "Read from Lovable at HH:MM, D Mon" or "Not read yet — press Sync now".
- The current Knowledge text (monospace, collapsed after ~12 lines with "Show all"), with the Harness-managed block visually marked when present.
- "Rules Harness added" — the active rules for that target, each linking to its improvement.
- "History" — the version timeline (newest first): date, what happened (written / staged / stale / failed / restored from #n), the improvement(s) involved, and a "Restore this version" button on any written version other than the latest. Restore opens the existing confirmation ("Harness will write the earlier text back, as a new version.") and stages a restore write.
- If a pending write exists: a banner "One change is staged. It will be written at the next sync (HH:MM)." with a "Sync now" button.
Skills section: "Skills in your workspace" listing each with name, description, last changed, expandable content; empty state: "Your workspace has no Skills yet. Harness will show them here as soon as it reads one; it does not write Skills yet."
Top of page: "N synced messages are waiting for analysis" when `awaiting_analysis > 0`, with one sentence: "Analysis uses Harness's own AI and runs when you ask for it."

### 6.2 Projects page (local runtime)
- Connection card: "Connected to Lovable as <email>" with Disconnect, or "Connect Lovable" (opens the URL returned by the API in a new tab; the page polls `GET executor` until connected). One line: "Harness reads your chats and Knowledge through Lovable's MCP. Reading and writing Knowledge uses no credits."
- Sync card: last sync (time, ok/error, counts), next scheduled sync, "Sync now" button (disabled while a run is in progress, with "Syncing…").
- Projects table: every project in the workspace (from Lovable when connected; otherwise only the allowed ones) with an "Allowed" switch, last synced, messages synced. Toggling on adds to the allow-list; toggling off removes it (history is kept).
Hosted runtime keeps the existing Supabase Projects page.

### 6.3 Settings page (local runtime)
- "Sync schedule": enabled switch, every N minutes (15–1440), between hour and hour (0–24), one line "Syncing reads your Lovable chats and Knowledge. It uses no Lovable credits and no AI."
- "Knowledge limit": the character cap (1000–10000) with "Lovable allows 10,000 characters; Harness keeps a margin."
- "Approval": read-only statement "Nothing is written to Lovable until you approve it here." (the setting exists but cannot be turned off yet).
- Hosted runtime keeps its existing form (only the keys that have consumers remain visible there: `kill_switch`, `monthly_credit_budget`; the rest are removed from the hosted form).

### 6.4 Decision flow
- Card and detail unchanged in shape. The Add confirmation gains a choice above the exact-text preview, nothing pre-selected:
  - **Add it now** — "Harness writes this exact text at the next sync. Uses no credits."
  - **Test it first** — "Harness runs the same request with and without this instruction in a temporary copy of the project and shows you the difference before anything is written. Uses up to N Lovable credits. Testing is not switched on yet; your choice is saved and runs when it is."
  The confirm button reads "Add" or "Save for testing" accordingly.
- After deciding in the Inbox list, the card stays in place showing its new state (chip + status sentence + "Change decision") until the page is left; a "Hide decided" link appears when there is at least one such card. Toast text becomes "Added — will be written at the next sync" / "Saved for testing" / "Skipped".
- "Change the wording" → **"Edit instruction"**; "Cancel wording change" → "Cancel".
- Copy for waiting states: "Waiting for Harness to add it" → "Will be written at the next sync"; when the executor is not connected: "Connect Lovable on the Projects page to let Harness write this."
- Improvements groups: Waiting to be written, Waiting to be tested, In Lovable, Needs attention, Skipped ("Proof in progress"/"Proof done" are removed until tests can run).

### 6.5 Landing page and login
- Landing intro becomes: "Harness Ledger keeps your Lovable agent improving. It syncs your project chats on a schedule, finds where you had to correct Lovable, and turns each correction into a standing instruction. You approve; Harness writes it into your Lovable Knowledge, keeps every version, and can roll any of them back."
- Steps: 1 **Synced** — "Harness reads your Lovable chats and Knowledge every hour. No credits, no AI." 2 **Proposed** — "Where you corrected Lovable, Harness proposes one instruction, with the exact messages as evidence." 3 **Approved by you** — "Add it now, test it first in a temporary copy, or skip. Nothing changes until you say so." 4 **Written and versioned** — "Harness writes the exact text you saw, reads it back to verify, and keeps every version so you can always go back."
- Login card subtitle "Internal tool — sign in to continue." → "Sign in to continue."

## 7. Out of scope (explicitly, until the owner starts the credits work)
- Running tests/experiments in temporary copies; writing Skills; automated analysis (LLM); hosted autonomy; multi-user.

## 8. Testing
- `harness/test/executor.test.ts`: redaction; sync-history stops at the first known message id (fake MCP client); snapshot dedupe by sha; execute-writes stale/failed/written transitions against a fake Lovable (the existing knowledge tests' fixtures); scheduler window/interval logic (pure function `shouldRunAt(now, lastRun, settings)`), sync_requests take/complete.
- `harness/test/store.test.ts` additions: settings seed, skill snapshots, sync runs.
- `harness/test/improvements.test.ts`: `accept` with `test_first` approves the experiment plan and stages no write; group mapping.
- `harness/test/ux.test.ts`: nav has Knowledge; Add dialog has both choices and neither pre-selected; "Edit instruction"; no "Waiting for Harness"; landing steps; login copy.
- Manual: `npm run harness:executor -- --connect` → browser consent → `--once` → Knowledge page shows the real project text, workspace text (empty) and Skills (none); Sync now from Projects triggers a run within 30 s.
