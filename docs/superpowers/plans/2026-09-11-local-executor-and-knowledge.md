# Local Executor and Knowledge Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harness syncs Lovable chats, Knowledge and Skills on a schedule with its own Lovable grant and no LLM, executes approved Knowledge writes, and the app shows current Knowledge, its history and rollback, lets the user allow projects and set the schedule, and asks "add now or test first" before every write.

**Architecture:** `harness/` gains an `executor/` subpackage (OAuth provider + Streamable-HTTP MCP client to `https://mcp.lovable.dev/`, four idempotent beats, a scheduler loop with a `sync_requests` inbox) and a v5 migration (settings, skill_snapshots, sync_runs, sync_requests). The TanStack app gains three server routes (`knowledge`, `executor`, `projects`) bridged through `adapter.ts`, a Knowledge page, local-mode Projects and Settings, and a two-choice Add confirmation. Structural tests in `harness/test/ux.test.ts` pin UI copy; `node:test` covers the executor with a fake MCP client.

**Tech Stack:** Node 22, TypeScript (NodeNext), better-sqlite3, `@modelcontextprotocol/sdk` 1.30 (`client/streamableHttp.js`, `client/auth.js`), zod 3; TanStack Start/Router/Query, shadcn/ui; tests via `tsx --test`.

**Spec:** `docs/superpowers/specs/2026-09-11-local-executor-and-knowledge-design.md`

## Global Constraints

- Node `>=22.12.0`. Run `npm run harness:build` after any change under `harness/src` (the web app imports `harness/dist/adapter.js`).
- The executor never calls `send_message`, `create_project`, `remix_project`, `create_workspace_skill`, `update_workspace_skill`, `delete_workspace_skill` or any other credit-spending or Skill-writing tool. Allowed Lovable MCP tools: `get_me`, `list_projects`, `list_messages`, `get_project_knowledge`, `get_workspace_knowledge`, `set_project_knowledge`, `set_workspace_knowledge`, `list_workspace_skills`.
- Tokens live only in `harness/data/lovable-auth.json` (0600). Never log them, never read `~/.claude`.
- The web app only fetches `/api/public/harness/{improvements,runtime,knowledge,executor,projects}`. Improvement POST actions: `accept` (with optional `test_first: true`), `skip`, `reopen`, `restore`, `change_wording`. Knowledge POST: `restore`. Executor POST: `sync_now`, `connect`, `disconnect`, `schedule`. Projects POST: `allow`, `disallow`.
- No UI text mentions "spec", "SPEC.md", "checkpoint", "Claude Code", or internal vocabulary (`message_id`, `provenance`, `confidence`, `classifier`) outside the Developer view.
- "Lovable credits" at most twice in `src/components/harness/improvement.tsx`; "Harness analysis" exactly once; `src/lib/harness-ux.ts` exactly two "Lovable credits" and no other "credit".
- Every `<details>` collapsed by default. `lovableStatusLine` remains the only source of "added to Lovable" claims.
- Files this plan touches must pass `npx eslint <file>`; the repo-wide Prettier baseline in untouched files is out of scope. `harness/test/ux.test.ts` is exempt from Prettier (pre-existing noise).
- Commit after each task with the trailer:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_016MGZ592H9Z87KgxZERZcVz
  ```
- Branch `local-harness-dev`, work in place.

---

### Task 1: Data layer v5 — settings, skill snapshots, sync runs and requests, cap from settings

**Files:**
- Modify: `harness/src/migrations.ts` (append migration v5)
- Modify: `harness/src/store.ts` (new functions at the end)
- Modify: `harness/src/knowledge.ts` (cap from settings)
- Modify: `harness/src/adapter.ts` (re-exports)
- Test: `harness/test/store.test.ts` (append), `harness/test/knowledge.test.ts` (one case)

**Interfaces:**
- Produces in `store.ts`:
  ```ts
  export type SettingKey = "sync_enabled" | "sync_interval_minutes" | "sync_window_start_hour" | "sync_window_end_hour" | "knowledge_char_cap" | "require_approval_before_write";
  export const SETTING_DEFAULTS: Record<SettingKey, string>; // "true","60","10","22","9000","true"
  export function getSetting(key: SettingKey): string;            // value or default
  export function getSettings(): Record<SettingKey, string>;
  export function setSettings(patch: Partial<Record<SettingKey, string>>): Record<SettingKey, string>; // validates: booleans "true"/"false"; interval int 15..1440; hours int 0..24 with start < end; cap int 1000..10000
  export function recordSkillSnapshot(input: { workspace_id: string; name: string; description: string | null; content: string; updated_at_remote: string | null; fetched_by: string }): { id: number; inserted: boolean }; // inserted=false when sha256 equals latest for (workspace_id,name)
  export function latestSkillSnapshots(workspaceId: string): { name: string; description: string | null; content: string; sha256: string; updated_at_remote: string | null; fetched_at: string }[]; // latest row per name
  export function startSyncRun(kind: "scheduled" | "manual" | "once"): number;
  export function finishSyncRun(id: number, result: { ok: boolean; error?: string | null; counts?: Record<string, number> }): void;
  export function latestSyncRun(): { id: number; kind: string; started_at: string; finished_at: string | null; ok: number | null; error: string | null; counts: Record<string, number> } | null;
  export function runningSyncRun(): { id: number; started_at: string } | null; // finished_at IS NULL and started_at within last 15 minutes
  export function requestSync(): { id: number; created: boolean };            // returns existing open request if any
  export function takeSyncRequest(runId: number): number | null;             // marks oldest 'requested' as 'running' with run_id; returns its id
  export function completeSyncRequest(id: number): void;
  export function countHistoryItemsAwaitingAnalysis(): number;               // history_items kind='message' role='user' whose id is not referenced by task_episode_evidence
  export function listHistoryStats(): { project_id: string; history_count: number; last_synced_at: string | null }[]; // per allowed project, last_synced_at = max(created_at) of history_items
  export function latestHistoryExternalIds(projectId: string, limit: number): Set<string>; // newest `limit` message external_ids
  ```
- `knowledge.ts`: `composeKnowledge`/preview functions read `Number(getSetting("knowledge_char_cap"))` instead of the constant; `KNOWLEDGE_CAP` stays exported as the default 9000. `over_cap` and any truncation use the setting value.
- `adapter.ts` re-exports: `getAllowedProjects`, `getProjectMeta`, `latestKnowledgeSnapshot`, `listKnowledgeVersions`, `activeRulesForTarget`, `listPendingKnowledgeWrites`, `createRestoreVersion`, `getKnowledgeVersion`, `listEvents`, `getSettings`, `setSettings`, `latestSkillSnapshots`, `latestSyncRun`, `runningSyncRun`, `requestSync`, `countHistoryItemsAwaitingAnalysis`, `listHistoryStats`, plus `allowProject(lovable_project_id: string, label: string)` and `disallowProject(lovable_project_id: string)` (new store functions: insert-or-ignore into / delete from `allowed_projects`; disallow keeps history rows). Check `task_episode_evidence`'s column that references `history_items` (open `migrations.ts` v2 to find its name) before writing the awaiting-analysis query.

- [ ] **Step 1: Write failing tests** in `harness/test/store.test.ts` (follow the file's existing temp-DB pattern):

```ts
test("v5 settings: defaults, validation, persistence", () => {
  assert.equal(store.getSetting("sync_interval_minutes"), "60");
  assert.deepEqual(store.getSettings().sync_window_start_hour, "10");
  const next = store.setSettings({ sync_interval_minutes: "30", sync_window_start_hour: "8", sync_window_end_hour: "20" });
  assert.equal(next.sync_interval_minutes, "30");
  assert.throws(() => store.setSettings({ sync_interval_minutes: "5" }), /15/);
  assert.throws(() => store.setSettings({ sync_window_start_hour: "22", sync_window_end_hour: "10" }), /before/);
  assert.throws(() => store.setSettings({ knowledge_char_cap: "20000" }), /10000/);
  assert.throws(() => store.setSettings({ sync_enabled: "yes" }), /true|false/);
});

test("v5 skill snapshots dedupe by content and return latest per name", () => {
  const a = store.recordSkillSnapshot({ workspace_id: "ws1", name: "deploy", description: "d", content: "v1", updated_at_remote: null, fetched_by: "test" });
  const b = store.recordSkillSnapshot({ workspace_id: "ws1", name: "deploy", description: "d", content: "v1", updated_at_remote: null, fetched_by: "test" });
  const c = store.recordSkillSnapshot({ workspace_id: "ws1", name: "deploy", description: "d", content: "v2", updated_at_remote: null, fetched_by: "test" });
  assert.equal(a.inserted, true); assert.equal(b.inserted, false); assert.equal(c.inserted, true);
  const latest = store.latestSkillSnapshots("ws1");
  assert.equal(latest.length, 1); assert.equal(latest[0]!.content, "v2");
});

test("v5 sync runs and requests", () => {
  assert.equal(store.latestSyncRun(), null);
  const r1 = store.requestSync(); const r2 = store.requestSync();
  assert.equal(r1.created, true); assert.equal(r2.created, false); assert.equal(r1.id, r2.id);
  const run = store.startSyncRun("manual");
  assert.ok(store.runningSyncRun());
  assert.equal(store.takeSyncRequest(run), r1.id);
  assert.equal(store.takeSyncRequest(run), null);
  store.completeSyncRequest(r1.id);
  store.finishSyncRun(run, { ok: true, counts: { messages: 3 } });
  assert.equal(store.runningSyncRun(), null);
  assert.deepEqual(store.latestSyncRun()?.counts, { messages: 3 });
});

test("v5 allow/disallow project and history stats", () => {
  store.allowProject("p-new", "New");
  assert.ok(store.getAllowedProjects().some((p) => p.lovable_project_id === "p-new"));
  store.upsertHistoryItem({ project_id: "p-new", kind: "message", external_id: "m1", role: "user", content: "hi", occurred_at: "2026-09-11T10:00:00Z", provenance: "test", source_ref: null } as never);
  assert.equal(store.countHistoryItemsAwaitingAnalysis() >= 1, true);
  assert.ok(store.latestHistoryExternalIds("p-new", 10).has("m1"));
  assert.equal(store.listHistoryStats().find((s) => s.project_id === "p-new")?.history_count, 1);
  store.disallowProject("p-new");
  assert.ok(!store.getAllowedProjects().some((p) => p.lovable_project_id === "p-new"));
});
```
Adjust the `upsertHistoryItem` call to the real signature at `store.ts:127` (read it) — the `as never` is only there so the plan compiles in your head; write the correct fields.

And in `harness/test/knowledge.test.ts` one case: after `store.setSettings({ knowledge_char_cap: "1200" })`, a preview whose final content is 1500 chars reports `over_cap: true`; reset the setting afterwards.

- [ ] **Step 2: Run** `cd harness && npm test 2>&1 | grep -E "^(not ok|# fail)"` — expect the new tests failing.
- [ ] **Step 3: Migration v5** appended to `MIGRATIONS` (name `checkpoint_e_executor_settings`):
```sql
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS skill_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT, content TEXT NOT NULL, sha256 TEXT NOT NULL, updated_at_remote TEXT, fetched_at TEXT NOT NULL DEFAULT (datetime('now')), fetched_by TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_skill_snapshots_ws_name ON skill_snapshots(workspace_id, name, id);
CREATE TABLE IF NOT EXISTS sync_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL CHECK (kind IN ('scheduled','manual','once')), started_at TEXT NOT NULL DEFAULT (datetime('now')), finished_at TEXT, ok INTEGER, error TEXT, counts_json TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS sync_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, requested_at TEXT NOT NULL DEFAULT (datetime('now')), status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','running','done')), run_id INTEGER REFERENCES sync_runs(id));
```
- [ ] **Step 4: Store functions** per the Interfaces block; `setSettings` validation messages must contain the substrings the tests assert (`15`, `before`, `10000`, `true or false`).
- [ ] **Step 5: knowledge.ts** reads the cap from settings (import `getSetting` from `./store.js`; keep the module otherwise unchanged).
- [ ] **Step 6: adapter.ts** re-exports listed above.
- [ ] **Step 7: Verify** `cd harness && npm run typecheck && npm test && npm run build` → all green; `npm run typecheck` at the repo root still clean.
- [ ] **Step 8: Commit** `harness/src/*`, `harness/test/*`: "Harness: settings, skill snapshots, sync runs and requests (v5)".

---

### Task 2: Executor — Lovable OAuth provider and MCP client

**Files:**
- Create: `harness/src/executor/lovable-auth.ts`, `harness/src/executor/lovable-mcp.ts`, `harness/src/executor/redact.ts`
- Modify: `harness/package.json` (script `executor`), `harness/.env.example` (comment), `.gitignore` (`harness/data/lovable-auth.json` already covered by `harness/data/`; confirm)
- Test: `harness/test/executor-auth.test.ts`

**Interfaces:**
- `redact.ts`: `export function redact(text: string): { text: string; count: number }` replacing `sk-[A-Za-z0-9]{10,}`, `lov_[A-Za-z0-9_-]{10,}`, `ghp_[A-Za-z0-9]{20,}`, `AKIA[0-9A-Z]{16}`, JWT-like `eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+`, PEM blocks (`-----BEGIN … KEY-----` … `-----END … KEY-----`), and emails with `[redacted:<type>]` where type ∈ `key|token|jwt|pem|email`.
- `lovable-auth.ts`:
  ```ts
  export const LOVABLE_MCP_URL = "https://mcp.lovable.dev/";
  export const REDIRECT_PORT = 8765;
  export type AuthFile = { client?: OAuthClientInformationMixed; tokens?: OAuthTokens; codeVerifier?: string; me?: { email: string | null; name: string | null; workspaces: { id: string; name: string }[] } };
  export class FileOAuthProvider implements OAuthClientProvider { constructor(filePath: string, onRedirect: (url: URL) => void); /* clientMetadata per spec §3.1; redirectUrl http://127.0.0.1:8765/callback; persists client/tokens/verifier to the file with mode 0o600; invalidateCredentials clears the relevant part */ }
  export function authFilePath(): string; // process.env.HARNESS_AUTH_PATH ?? path.join(dirname(HARNESS_DB_PATH), "lovable-auth.json")
  export async function connect(opts?: { open?: (url: string) => void; timeoutMs?: number }): Promise<{ email: string | null; workspaces: { id: string; name: string }[] }>; // starts loopback listener, creates transport with provider, calls client.connect(); on UnauthorizedError waits for the callback code, transport.finishAuth(code), reconnects; calls get_me; saves `me`; closes listener
  export function startConnect(): Promise<{ url: string; done: Promise<AuthFile["me"]> }>; // same as connect but resolves the URL as soon as it is known (used by the web route) — the `done` promise resolves when the callback completes
  export async function disconnect(): Promise<void>; // best-effort POST to revocation_endpoint with the refresh token, then delete the file
  export function status(): { connected: boolean; email: string | null; workspaces: { id: string; name: string }[]; expires_at: string | null };
  ```
  Implementation notes: `client.connect(transport)` throws `UnauthorizedError` when the provider has no tokens; the SDK will have called `redirectToAuthorization(url)` first — capture the URL there. A `state` value must be generated and checked on callback. The listener responds with a tiny HTML page "You can close this tab. Harness Ledger is connected." and rejects mismatched state.
- `lovable-mcp.ts`:
  ```ts
  export type LovableMessage = { message_id: string; role: "user" | "assistant"; status: string | null; created_at: string; edit_id: string | null; content: string };
  export interface LovableReader { getMe(): Promise<{ id: string; email: string | null; name: string | null; workspaces: { id: string; name: string }[] }>; listProjects(workspaceId: string): Promise<{ id: string; name: string }[]>; listMessages(projectId: string, cursor?: string, limit?: number): Promise<{ messages: LovableMessage[]; next_cursor: string | null; has_more: boolean }>; getProjectKnowledge(projectId: string): Promise<string>; getWorkspaceKnowledge(workspaceId: string): Promise<string>; listWorkspaceSkills(workspaceId: string): Promise<{ name: string; description: string | null; content: string; updated_at: string | null }[]>; }
  export interface LovableWriter { setProjectKnowledge(projectId: string, content: string): Promise<void>; setWorkspaceKnowledge(workspaceId: string, content: string): Promise<void>; }
  export type LovableClient = LovableReader & LovableWriter & { close(): Promise<void> };
  export async function openLovableClient(): Promise<LovableClient>; // throws Error("not connected") when status().connected is false
  ```
  Tool results arrive as `{ content: [{ type: "text", text: "<json>" }] }`; parse `text` as JSON. `list_messages` returns `{ messages: [...], pagination: { next_cursor, has_more } }`. `list_workspace_skills` with `include_markdown: true` — map fields defensively (`name`, `description`, `markdown`/`content`, `updated_at`). Retry once on 401 (the transport refreshes); on 429 sleep `retry-after` seconds once, then throw.

- [ ] **Step 1: Tests** in `harness/test/executor-auth.test.ts`: (a) `redact` replaces each pattern type and counts; (b) `FileOAuthProvider` round-trips `saveClientInformation`/`clientInformation`, `saveTokens`/`tokens`, `saveCodeVerifier`/`codeVerifier` through a temp file and the file mode is 0o600; (c) `status()` reports `connected:false` when the file is absent and `connected:true` with `email` after writing a tokens+me fixture; (d) `clientMetadata.redirect_uris` equals `["http://127.0.0.1:8765/callback"]` and `token_endpoint_auth_method` is `"none"`.
- [ ] **Step 2: Run** to see them fail.
- [ ] **Step 3: Implement** the three modules. Import paths: `@modelcontextprotocol/sdk/client/index.js`, `@modelcontextprotocol/sdk/client/streamableHttp.js`, `@modelcontextprotocol/sdk/client/auth.js` (types `OAuthClientInformationMixed`, `OAuthTokens` from `@modelcontextprotocol/sdk/shared/auth.js`).
- [ ] **Step 4: Manual smoke (no user consent needed)**: `cd harness && npx tsx -e 'import("./src/executor/lovable-auth.ts").then(m=>console.log(m.status()))'` prints `connected:false`.
- [ ] **Step 5: Verify** `cd harness && npm run typecheck && npm test && npm run build`.
- [ ] **Step 6: Commit** "Executor: Lovable OAuth provider (loopback, dynamic registration) and MCP client".

---

### Task 3: Executor — beats, scheduler, CLI

**Files:**
- Create: `harness/src/executor/beats.ts`, `harness/src/executor/schedule.ts`, `harness/src/executor/main.ts`
- Modify: `harness/package.json` (`"executor": "tsx src/executor/main.ts"`), root `package.json` (`"harness:executor": "npm --prefix harness run executor --"`), `harness/README.md` (a short "Executor" section replacing the manual two-beat instructions: connect, run, schedule)
- Test: `harness/test/executor.test.ts`

**Interfaces:**
- `beats.ts` (all take a `LovableClient`-shaped dependency so tests inject a fake):
  ```ts
  export async function syncHistory(lovable: LovableReader, opts?: { pageLimit?: number }): Promise<{ messages: number; projects: number }>; // per allowed project: page newest-first; stop when a page contains an external_id already stored (use store.latestHistoryExternalIds(projectId, 200)) or has_more is false; upsertHistoryItem for each new message with kind "message", external_id message_id, role, content redacted, occurred_at created_at, provenance "executor sync", source_ref edit_id. Also upsertProject with workspace_id from get_me's first workspace when the project row lacks one.
  export async function snapshotKnowledge(lovable: LovableReader, workspaceId: string): Promise<{ snapshots: number }>; // per allowed project + workspace; recordKnowledgeSnapshot only when sha differs from latestKnowledgeSnapshot
  export async function snapshotSkills(lovable: LovableReader, workspaceId: string): Promise<{ skills: number; changed: number }>;
  export async function executeWrites(lovable: LovableReader & LovableWriter): Promise<{ written: number; stale: number; failed: number }>; // exactly the README two-beat: for each listPendingKnowledgeWrites row: live = get; if sha256(live) !== previous_sha256 → markKnowledgeWriteStale(id, "Knowledge changed in Lovable since this was prepared"); else set, read back, recordKnowledgeReadback(id, readBack); catch → markKnowledgeWriteFailed(id, message)
  export async function runAll(lovable: LovableClient, kind: "scheduled"|"manual"|"once"): Promise<{ runId: number; ok: boolean; counts: Record<string, number>; error?: string }>; // startSyncRun, takeSyncRequest loop (complete them all), beats in order sync → snapshotKnowledge → snapshotSkills → executeWrites, insertEvent per beat, finishSyncRun
  ```
- `schedule.ts`:
  ```ts
  export type ScheduleSettings = { enabled: boolean; intervalMinutes: number; windowStartHour: number; windowEndHour: number };
  export function scheduleFromSettings(s: Record<string, string>): ScheduleSettings;
  export function shouldRunAt(now: Date, lastRunStartedAt: Date | null, s: ScheduleSettings): boolean; // enabled && hour in [start,end) && (lastRun null || now - lastRun >= interval)
  export function nextRunAt(now: Date, lastRunStartedAt: Date | null, s: ScheduleSettings): Date | null; // null when disabled; otherwise the earliest instant >= now that satisfies shouldRunAt (walk forward in minutes, cap 48h)
  export async function loop(opts: { tickMs?: number; once?: boolean }): Promise<void>; // every tick: if runningSyncRun() → skip; else if an open sync_request exists → runAll("manual"); else if shouldRunAt → runAll("scheduled"). Opens the Lovable client lazily; if status().connected is false, log once per 10 minutes "Not connected — run `npm run harness:executor -- --connect`" and skip.
  ```
- `main.ts`: parses `--connect`, `--once`, `--status`, `--disconnect`; default runs `loop()`. `--connect` prints the URL, tries `xdg-open`/`open` best-effort, waits, prints "Connected as <email>".

- [ ] **Step 1: Tests** in `harness/test/executor.test.ts` with an in-memory fake implementing `LovableClient` (arrays of pages per project, knowledge strings, skills, and a log of `set*` calls):
  - sync stops at the first known id: seed `m3` in history, fake returns pages [m5,m4,m3],[m2,m1] → inserts exactly m5,m4; second run inserts nothing.
  - assistant content is redacted (an `sk-…` token becomes `[redacted:key]`).
  - snapshotKnowledge inserts on first run and not on second (same content), inserts again when content changes.
  - executeWrites: pending version whose `previous_sha256` matches live → fake `set` called with `new_content`, readback equal → status `written`; mismatch → `stale`, no `set` call; fake `set` throws → `failed`.
  - `shouldRunAt`: disabled → false; 09:59 → false; 10:00 with no last run → true; 10:30 with last run 10:00 and interval 60 → false; 11:00 → true; 22:00 → false. `nextRunAt` from 23:00 with defaults → next day 10:00.
  - `runAll` completes an open sync_request and records counts.
- [ ] **Step 2: Run** to see them fail.
- [ ] **Step 3: Implement** beats, schedule, main.
- [ ] **Step 4: Verify** `cd harness && npm run typecheck && npm test && npm run build`; `npm run harness:executor -- --status` from the repo root prints the not-connected status.
- [ ] **Step 5: Commit** "Executor: sync, snapshot, write beats and hourly scheduler with Sync now".

---

### Task 4: Improvements — "test first", groups and status copy

**Files:**
- Modify: `harness/src/improvements.ts` (accept with `test_first`; `proof.outcome` mapping; expose `experiment_status`)
- Modify: `src/lib/harness-ux.ts` (`IMPROVEMENT_GROUPS`, `improvementGroup`, `lovableStatusLine`, `decisionSentence`)
- Modify: `src/lib/improvements-client.ts` (`Improvement.decision.test_first: boolean`, `groupOf`)
- Test: `harness/test/improvements.test.ts` (append), `harness/test/ux.test.ts` (group + status tests)

**Interfaces:**
- `improvements.ts`: `actionInput` accept variant gains `test_first: z.boolean().optional()`. When `test_first` is true: record the human decision and set the rule `approved` as today, **do not** call `stagePendingWrite`, and ensure an experiment plan exists for the rule with `status: "approved"` (use `store.listExperimentPlansForRule`; if none, `store.createExperimentPlan` with the minimal required fields — read its input type at `store.ts:850` — `created_by: "owner via UI"`, `exact_prompt` = the correction's first user message text or "", `experiment_type: "paired_control_treatment"`; if one exists in `proposed`, update it to `approved` via whatever store function exists, adding one if missing: `store.setExperimentPlanStatus(id, "approved", actor)`). Add `decision.test_first: boolean` to the `Improvement` type = an approved experiment plan exists and no `written` version exists.
- `harness-ux.ts`:
  ```ts
  export const IMPROVEMENT_GROUPS = ["Waiting to be written", "Waiting to be tested", "In Lovable", "Needs attention", "Skipped"] as const;
  export function improvementGroup(input: { status: "pending"|"accepted"|"skipped"; writeStatus: LovableWriteStatus | null | undefined; testFirst: boolean }): ImprovementGroup | null; // skipped→Skipped; pending→null; stale|failed→Needs attention; written→In Lovable; testFirst→Waiting to be tested; else Waiting to be written
  export function lovableStatusLine(input: LovableStatusLike | null | undefined, ctx?: { nextSyncAt?: string | null; connected?: boolean; testFirst?: boolean }): string;
  // written → "Added to Lovable, 10 Sep"; stale → "Needs attention: …" (unchanged); failed → "Needs attention: adding failed — see Details";
  // testFirst → "Saved for testing — nothing is written until the test runs";
  // connected === false → "Connect Lovable on the Projects page to let Harness write this";
  // nextSyncAt → `Will be written at the next sync, ${formatDate(nextSyncAt)}`; otherwise "Will be written at the next sync"
  ```
  `decisionSentence` passes `ctx` through. `SAVED_LINE` in `improvement.tsx` becomes "Added — will be written at the next sync." (Task 8 does the component; this task only changes `harness-ux.ts` and the client types.)
- `improvements-client.ts`: `groupOf(item)` passes `testFirst: item.decision.test_first`.

- [ ] **Step 1: Tests**: in `improvements.test.ts` — accept with `test_first: true` leaves `listPendingKnowledgeWrites()` empty, sets `decision.test_first === true`, and the rule's experiment plan is `approved`; a later plain accept stages a write and `test_first` becomes false only after a written version exists (assert it stays true until then — document this in a comment). In `ux.test.ts` update the `IMPROVEMENT_GROUPS` deepEqual and the `g()` helper (`{ status, writeStatus, proofOutcome }` → `{ status, writeStatus, testFirst }`), add `lovableStatusLine` cases for the four new strings, and add `assert.ok(!/Waiting for Harness/.test(readApp("lib/harness-ux.ts")))`.
- [ ] **Step 2: Run** to see failures. **Step 3: Implement.** **Step 4: Verify** `cd harness && npm run typecheck && npm test && npm run build && cd .. && npm run typecheck` (the component still compiles because `groupOf`'s signature is unchanged; the `proofOutcome`-based tests are replaced).
- [ ] **Step 5: Commit** "Improvements: test-first decision, new groups, sync-aware status copy".

---

### Task 5: Server routes — knowledge, executor, projects; no spec mention

**Files:**
- Create: `src/routes/api/public/harness/knowledge.ts`, `src/routes/api/public/harness/executor.ts`, `src/routes/api/public/harness/projects.ts`
- Modify: `src/lib/server/harness-runtime.ts` (`hostedPreviewBody` text; add `loadHarnessExecutor()` that dynamically imports `harness/dist/executor/lovable-auth.js` only when local)
- Modify: `harness/src/adapter.ts` (any missing re-export discovered here)
- Modify: `src/lib/improvements-client.ts` (fetch helpers + types for the three routes)
- Test: `harness/test/ux.test.ts` ("pages only fetch local harness routes" list gains the three routes; a new test asserts `hostedPreviewBody` contains no "SPEC" and that each new route file uses `requireAuth` and `loadHarnessAdapter`)

**Interfaces:** exactly the request/response shapes in spec §4. `hostedPreviewBody` default reason becomes: "This is the hosted preview. Harness runs on your own machine for now; start it locally to see your data." `knowledge` GET composes: targets from `getAllowedProjects()` (+ `getProjectMeta` for name/workspace_id) then one workspace target (id from the first project's `workspace_id`, or from executor `status().workspaces[0]`), `current` from `latestKnowledgeSnapshot`, `managed_block_present` = content includes `<!-- harness:start -->`, `active_rules` from `activeRulesForTarget` mapped to `{ id, text: instruction, improvement_id }` (improvement id = the correction candidate id for the rule; find via existing store helpers or add `store.getCorrectionIdForRule(ruleId)`), `versions` from `listKnowledgeVersions()` filtered to the target (add an optional target filter to the store function if needed), `pending_write` from `listPendingKnowledgeWrites`, `skills` from `latestSkillSnapshots(workspaceId)` with `fetched_at` = max, `awaiting_analysis`. `executor` GET adds `next_run_at` via `nextRunAt` from `harness/dist/executor/schedule.js` (dynamic import like the adapter). Client helpers: `fetchKnowledge()`, `postKnowledge(body)`, `fetchExecutor()`, `postExecutor(body)`, `fetchProjects()`, `postProjects(body)` with `authHeaders()` like the existing ones; query keys `["harness-knowledge"]`, `["harness-executor"]`, `["harness-projects"]`.

- [ ] **Step 1: Tests** (structural, in `ux.test.ts`) then **Step 2** see fail, **Step 3** implement, **Step 4** verify (`npm run typecheck`, eslint on new files, `cd harness && npm test`), and a curl smoke against the dev server with `HARNESS_RUNTIME=local`: unauthenticated `GET /api/public/harness/knowledge` → 401; note that in the report.
- [ ] **Step 5: Commit** "API: knowledge, executor and projects routes for the local runtime".

---

### Task 6: Knowledge page and navigation

**Files:**
- Create: `src/routes/_authenticated/knowledge.tsx`
- Modify: `src/routes/_authenticated/route.tsx` (NAV: Inbox, Improvements, Knowledge, Projects, Settings), `src/routes/_authenticated/versions.tsx` (redirect to `/knowledge`, same shape as overview.tsx)
- Test: `harness/test/ux.test.ts` (nav test: five items in this order; knowledge page structural test)

**Interfaces (page contract):** exactly spec §6.1. Component structure: `KnowledgePage` → for each target `TargetSection` (heading, status line, `KnowledgeText` collapsed >12 lines with "Show all", "Rules Harness added" list linking to `/ledger?improvement=<id>`, "History" list with `RestoreButton` using `ConfirmAction` from `decision-layout` with title "Restore this version?" body "Harness will write the earlier text back, as a new version." confirmLabel "Restore"; pending banner "One change is staged. It will be written at the next sync, <time>." + `Sync now` button posting `sync_now` to the executor route). `SkillsSection` with the exact empty-state copy from the spec. Top notice: "<N> synced messages are waiting for analysis. Analysis uses Harness's own AI and runs when you ask for it." Hosted runtime (`available: false`): heading + one line "Knowledge is available when Harness runs on your machine." Loading/error blocks copy the Inbox pattern.

Structural test assertions: file contains `Rules Harness added`, `Show all`, `Restore this version?`, `Your workspace has no Skills yet`, `does not write Skills yet`, `waiting for analysis`, `<ConfirmAction`, no `open` on any `<details`, fetches only `fetchKnowledge`/`postKnowledge`/`postExecutor`; nav order regex.

- [ ] Steps: tests → fail → implement → `npm run typecheck && npx eslint src/routes/_authenticated/knowledge.tsx src/routes/_authenticated/route.tsx src/routes/_authenticated/versions.tsx && (cd harness && npm test)` → commit "UX: Knowledge page with current text, rules, history and restore".

---

### Task 7: Projects and Settings for the local runtime

**Files:**
- Modify: `src/routes/_authenticated/projects.tsx` (split: `LocalProjects` when runtime mode is `local`, existing hosted component otherwise; hosted component moved into `src/components/harness/hosted-projects.tsx` unchanged)
- Modify: `src/routes/_authenticated/settings.tsx` (`LocalSettings` when local; hosted form keeps only `kill_switch` and `monthly_credit_budget` plus the Advanced section)
- Create: `src/components/harness/hosted-projects.tsx`, `src/components/harness/local-projects.tsx`, `src/components/harness/local-settings.tsx`
- Test: `harness/test/ux.test.ts`

**Interfaces:** spec §6.2 and §6.3. Local Projects: connection card ("Connected to Lovable as <email>" / "Connect Lovable" → `postExecutor({ action: "connect" })` → `window.open(url, "_blank")` → poll `fetchExecutor` every 3 s until `connected`, max 10 min), sync card (last sync line: "Last sync <time>: <n> messages, <m> Knowledge snapshots" or "Last sync failed: <error>"; "Next sync <time>"; "Sync now" disabled while `running`), projects table (`Allowed` switch → `postProjects({ action: "allow"|"disallow", lovable_project_id, label })`). Local Settings: the three sections with the exact sentences from spec §6.3; Save posts `schedule` and, for the cap, `setSettings` through the executor route (`{ action: "schedule", … }` and `{ action: "settings", knowledge_char_cap }` — add the `settings` action to the executor route in this task, validated by `setSettings`). Copy rule: the sentence "It uses no Lovable credits and no AI." appears in Settings; nowhere else on these pages mention credits.

Structural tests: projects.tsx contains `mode === "local" ? <LocalProjects` ; local-projects.tsx contains `Connect Lovable`, `Sync now`, `Allowed`, `uses no credits`; local-settings.tsx contains `Sync schedule`, `Knowledge limit`, `Nothing is written to Lovable until you approve it here.`; hosted settings no longer lists `drift_check_every_n|max_active_rules|one_change_per_day|require_replay_approval|keep_forks|llm_provider|llm_models`.

- [ ] Steps: tests → fail → implement → typecheck + eslint on touched files + harness tests → commit "UX: Projects and Settings for the local runtime (connect, allow, schedule, cap)".

---

### Task 8: Decision flow, landing and login copy

**Files:**
- Modify: `src/components/harness/improvement.tsx` (AddConfirm two-choice; `SAVED_LINE`; "Edit instruction"; `lovableStatusLine` ctx from executor status), `src/routes/_authenticated/inbox.tsx` (decided cards stay; "Hide decided"), `src/lib/harness-ux.ts` (`HOW_IT_WORKS_STEPS` four steps + `LANDING_INTRO`), `src/routes/index.tsx` (intro + four steps), `src/routes/login.tsx` ("Sign in to continue.")
- Test: `harness/test/ux.test.ts`

**Interfaces:**
- `AddConfirm` renders, above the preview, a `role="radiogroup"` aria-label "How to add it" with two `role="radio"` buttons (nothing pre-selected, confirm disabled until one is chosen): labels **Add it now** (help: "Harness writes this exact text at the next sync. Uses no credits.") and **Test it first** (help: `Harness runs the same request with and without this instruction in a temporary copy of the project and shows you the difference before anything is written. ${proveCostLine(item.proof?.lovable_credits_max)} Testing is not switched on yet; your choice is saved and runs when it is.`). Confirm label "Add" / "Save for testing". Posts `{ action: "accept", id, destination }` or `{ …, test_first: true }`. Toasts: "Added — will be written at the next sync." / "Saved for testing." (Keep "Lovable credits" count ≤ 2 in the component: `PREVIEW_CONSEQUENCES` drops "Uses no Lovable credits." since the choice text now says it; `proveCostLine` contributes one.)
- Inbox: keep a `decidedIds` `useState<Set<number>>`; list = pending ∪ decided-this-session (in original order); when `decidedIds.size > 0` show a "Hide decided" link that clears the set. Count line counts pending only.
- Detail: "Edit instruction" / "Cancel".
- Status ctx: `ImprovementDetail` and `DecisionCard` read `useQuery(executorQueryOptions)` (from improvements-client; `staleTime: 30_000`) and pass `{ nextSyncAt: data?.next_run_at ?? null, connected: data?.connection.connected }` to `decisionSentence`.
- Landing: `LANDING_INTRO` and four `HOW_IT_WORKS_STEPS` exactly as spec §6.5 (title/text). Login: "Sign in to continue."

Structural tests: `aria-label="How to add it"`, `Add it now`, `Test it first`, `Save for testing`, `Edit instruction`, no `Change the wording`, no `Uses no Lovable credits`, count "Lovable credits" ≤ 2 and "Harness analysis" == 1 in the component; inbox has `Hide decided`; `HOW_IT_WORKS_STEPS` titles deepEqual `["Synced","Proposed","Approved by you","Written and versioned"]`; login has no "Internal tool"; harness-ux.ts "Lovable credits" count == 2 (proveCostLine + step 1's "No credits" does NOT count — write step 1 as "No credits, no AI." which contains "credits" but not "Lovable credits"; adjust the existing `count(uxSource, "credit") === 2` assertion to `=== 3` and say so in the test comment).

- [ ] Steps: tests → fail → implement → `npm run typecheck && npx eslint <touched src files> && (cd harness && npm test)` → commit "UX: add now or test first, decided cards stay put, Edit instruction, landing pitch".

---

### Task 9: Whole-system verification (read-only unless broken)

- [ ] `npm run harness:build && npm run typecheck && npm run build && (cd harness && npm test)`; scoped eslint on every file this plan touched.
- [ ] Executor smoke without consent: `npm run harness:executor -- --status` → not connected; `--once` → exits with "Not connected" and no sync_runs row.
- [ ] Dev server smoke with `HARNESS_RUNTIME=local HARNESS_DB_PATH=harness/data/harness.db npm run dev`: `/`, `/login`, `/inbox`, `/ledger`, `/knowledge`, `/projects`, `/settings`, `/versions` → 200; `GET /api/public/harness/knowledge` without auth → 401.
- [ ] Report the command outputs verbatim. The consent step (`--connect` in a browser) is done by the controller with the owner, not by this task.
