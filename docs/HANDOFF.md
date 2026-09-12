# Harness Ledger — handoff (2026-09-12)

For the next agent. Everything here comes from the working session of 2026-09-11 → 2026-09-12 with the owner (Said, `shsaid@kth.se`; Lovable workspace `937baaeb85dfcb22e8b2`, project `28bd5471-78e0-43af-a29b-5018198cb13c`). Read this before touching anything. The owner's rules at the end are binding.

## 1. What the product is, in one paragraph

Harness Ledger makes a Lovable user's builder agent better over time. It reads the user's own chat history with Lovable, finds where they corrected Lovable, proposes one standing instruction per correction, and — once the user approves — writes it into the project's or workspace's Lovable **Knowledge**, keeping every version and letting them roll back. It then watches later real builds to see whether each rule helped, hurt, went unused or was contradicted, and proposes retiring the ones that don't earn their place. Autonomy is the sell point, but *nothing spends Lovable credits and nothing spends LLM tokens unless the user pressed a button*. Every number shown is labelled with what produced it.

## 2. Vocabulary (Round 5)

| Concept | UI word | Code / docs word |
|---|---|---|
| Reading chats, Knowledge and Skills from Lovable on a schedule; no model | **Sync** | sync |
| The model step that reads synced chats and proposes a rule | **Analysis** ("Analyse now", "AI analysis" in Settings) | analysis; roles are **Classifier**, **Rule writer**, **Judge** |
| A rule the analysis proposes and the user has not decided on | **Suggestion** | suggestion / improvement (internal view name stays) |
| A suggestion the user accepted | **Rule** | rule |

Nav label changed from "Improvements" to "Suggestions"; `/ledger` stays the same. `/improvements` and `/suggestions` redirect to `/ledger`. Role label "Miner" renamed to "Rule writer"; "Judge" role added. `proveCostLine()` now returns "Uses Lovable credits like any build; the cost is recorded after the test." without parameters.

## 3. Where the code is

Repo: `/home/ibbzy/harness-ledger-foundation`, branch `local-harness-dev` (82 commits ahead of `main` at head `50ccb52`; the owner never chose merge / PR / keep — ask). Two halves:

- `src/` — the web app (TanStack Start + React 19 + shadcn, Supabase auth). File routes under `src/routes/_authenticated/`: `inbox`, `ledger` (labelled "Improvements"), `instructions`, `skills`, `projects`, `settings`; `knowledge`/`versions`/`overview` are redirects. Server routes under `src/routes/api/public/harness/`: `improvements`, `runtime`, `knowledge`, `skills`, `executor`, `projects` — the UI may fetch **only** these six (a structural test enforces it). They bridge to the local package through `src/lib/server/harness-runtime.ts` (dynamic import of `harness/dist/*` when `HARNESS_RUNTIME=local`; hosted mode gets a polite "runs on your machine" body).
- `harness/` — standalone Node package (SQLite via better-sqlite3, `node:test` via `tsx`). Key modules: `src/store.ts` (all SQL; new work is appended in delimited `// ---- Round N Task ----` blocks), `src/migrations.ts` (v1–v10, one array; **one task owns each new migration**), `src/improvements.ts` (the "improvement" view = correction + rule + versions, all POST actions), `src/knowledge.ts` (managed block compose, sha256, cap), `src/adapter.ts` (the only module the web app may import), `src/mcp-server.ts` (the Harness MCP server Claude Code sessions used before the executor existed), `src/executor/` (Lovable OAuth + MCP client, beats, scheduler, CLI), `src/analysis/` (classify, segment, mine, health, retire, run), `src/llm/` (provider client), `src/llm-keys.ts`, `src/diff.ts`, `src/demo.ts`.
- Docs that are the source of truth (newest wins where they disagree): `docs/superpowers/specs/2026-09-11-*.md` (four rounds), `docs/superpowers/specs/explorations/*.md` (three design studies), `docs/superpowers/plans/2026-09-11-*.md`. The owner's original product spec lives outside the repo at `/home/ibbzy/love/SPEC.md`; treat it as intent only, it produced the earlier mistakes. **Never mention specs, "SPEC.md", "checkpoint" or "Claude Code" (except as the provider name) in UI copy.**

Run it: Node 22 (`nvm use`), `npm i`, `npm run harness:install && npm run harness:build`, then `HARNESS_RUNTIME=local HARNESS_DB_PATH=harness/data/harness.db npm run dev` and, in another terminal, `npm run harness:executor` (the loop). Tests: `cd harness && npm test` (354 pass at head), `npm run typecheck` in both packages, `npm run build`. Repo-wide `npm run lint` has ~1,400 pre-existing Prettier errors in files this work never touched; the rule was "every touched file is eslint-clean", and it is.

## 4. What was built, round by round (all on this branch)

1. **Simplification pass** — public landing page at `/`, one nav for both runtimes, one `DecisionCard` used by Inbox / Improvements / detail, add-or-skip straight from the list, detail trimmed, Overview folded into Inbox.
2. **Local executor + Knowledge page** — the executor holds its **own** Lovable OAuth grant (dynamic client registration with a loopback redirect on port 8765, tokens in `harness/data/lovable-auth.json`, mode 0600) and talks to `https://mcp.lovable.dev/` with `@modelcontextprotocol/sdk`. Beats: sync chat history (redacted, resumable cursor), snapshot Knowledge and Skills, stage writes for approved items, execute pending writes (sha check → written / stale / failed / cancelled), recompute rule health, propose retirements. Scheduler: hourly within a window (defaults 10–22, Settings), plus "Sync now". Only eight Lovable tools are reachable by construction (get_me, list_projects, list_messages, get/set project knowledge, get/set workspace knowledge, list_workspace_skills). `--connect`, `--once`, `--status`, `--analyse`, `--disconnect`. The owner **has connected** (`--status` says connected) but had run no sync pass by the end of the session.
3. **Instructions & Skills pages, change view, settings** — "Instructions" (current Knowledge text per project + workspace, rules live in it, version history with a real line diff "What changed", restore, pending-write banner) and "Skills" (read-only). Settings: sync schedule, Knowledge limit, AI analysis (provider incl. **Claude Code**, key, per-role model with hints, monthly **token** budget), defaults, notifications; per-project max active rules and auto-write. Demo data: `npm run harness:demo -- --add|--remove|--status` (currently **loaded**; removal is exact and tested).
4. **Analysis + outcomes + deprecation** — `harness/src/llm/` (OpenAI/Anthropic/Google via plain fetch with strict-mode-compatible JSON schemas, or the local `claude -p` CLI on the user's subscription; every attempt logged to `llm_calls`; token budget checked before every call incl. retries; a guard `assertStrictCompatible` refuses bad schemas). `harness/src/analysis/`: classify (fake-injectable `CallLlm`), segment into task episodes, mine proposals with evidence validation, per-target dedupe (bigram Dice) and a verification plan per rule; `runAnalysis` with a 200-call cap and `analysis_requests`/`analysis_runs` bookkeeping; the loop runs it only when a request exists. `rule_health` from real builds; retirement proposals as `kind: "retire"` Inbox items (negative ids) with Retire / Keep (snooze 30 d) / Re-add (resets the health window). Small gaps: Open-in-Lovable links, sidebar count, "New" marker, browser notification opt-in.

## 5. Current state of the owner's data (read-only facts at handoff)

Schema version 10. One real improvement (id 1, pending in the Inbox, its earlier staged write cancelled by reopen), two demo improvements (ids 8, 9), demo versions, one demo skill snapshot. LLM provider setting is `openai` with **no key saved for any provider**; the owner has the `claude` CLI (2.1.269) installed, so "Claude Code (your subscription)" is the zero-setup option. `countHistoryItemsAwaitingAnalysis()` is 0 (history was hand-processed in earlier Claude Code sessions). Test copies / experiments: none exist.

## 6. What is NOT built (and the owner knows)

- **Phase B — the paired test ("Test it first").** Designed in `docs/superpowers/specs/2026-09-11-round-4-analysis-proof-outcomes.md` §3 and `explorations/proof-and-outcomes.md`. Today "Test it first" only records an approved experiment plan and stages no write. Key verified facts for building it: the executor's OAuth token is accepted by Lovable's **REST** control API (`GET https://api.lovable.dev/v1/me` → 200), and the REST API supports `POST /v1/projects/{id}/remix/init` with `message_id` + `remix_mode: "before"` + `skip_initial_remix_message`, plus `deleteProject`, `createVariant`, `getMessage` (with `cost_credits`). The MCP tools lack all of that. Design: control arm = the user's own historical run (free); treatment = one new build in a remix at the state before the episode's request, Knowledge as of that time plus the rule (~1.5 credits); the owner judges first ("still needed?" per correction), reviewer model later; auto-delete the copy; monthly Lovable credit budget **12**; one test at a time. **The owner will start the first live test from the UI; never run one on your own.**
- Reviewer/proposer model roles (only classifier and miner are exercised).
- A Scoreboard page (needs weeks of data).
- Hosted autonomy: Lovable rejected the hosted OAuth client ("Client Not Found"); the hosted Supabase half is a schema of the vision with no working pipeline; leave it.

## 7. How the owner wants work done (binding)

- Sonnet 5 is the ceiling for subagents; Haiku for mechanical work; never Opus (a rate limit cut a review short). Use subagents freely; implementers never spawn their own reviewers.
- Question the setup instead of silently working around it; say plainly what does not make sense.
- Fewer things on screen. Do not hide capability behind stubs; show it with honest copy. Don't over-promise: say what is automatic and what needs a human.
- Anything that spends **Lovable credits** (send_message, create/remix project, skill writes) needs the owner's explicit go-ahead, every time. Reading via Lovable MCP is free and fine. LLM calls only on "Analyse now" / `--analyse`.
- Keys never in SQLite, responses or logs; tokens only in `harness/data/lovable-auth.json`; never read `~/.claude`.
- Every `<details>` collapsed; `lovableStatusLine` is the only source of "added to Lovable" claims; the structural tests in `harness/test/ux*.test.ts` read source files as text and pin copy — update them with intent, don't weaken them.
- Commits end with the `Co-Authored-By` / `Claude-Session` trailer used throughout the branch. Work in place on `local-harness-dev`; the owner runs the dev server from this checkout.
- Process that worked: spec → plan → subagent per task with a brief → per-task review → scoped re-review of fixes → whole-branch review → one fix wave. Keep a ledger under `.superpowers/sdd/<plan>/progress.md` while a plan runs and delete it when done. Parallel implementers are fine on disjoint files, but make **one task own each migration** and tell agents to append store code in delimited blocks and re-read before editing; the shared git index caused several near-misses (agents used hunk-level staging to recover).

## 8. Lessons from this session (so you don't repeat them)

- The single most valuable review was the whole-branch one that found the strict-schema bug: mocked `fetch` tests cannot catch provider-contract violations. `npm run llm:smoke` (Claude Code, temp DB, one tiny call) is the live check — run it after touching `harness/src/llm/`.
- "Simplifying" by hiding empty pages read to the owner as removing features. Show state honestly instead.
- Reviewers will flag things the plan itself mandated (a wrong derivation of `test_first`, a copy line promising a feature). Rule on them; don't dismiss them because the plan said so.
- Two data models (hosted Supabase vs local SQLite) still exist; every new feature went local-only on purpose.
- Lovable's `list_messages` returns the builder's whole activity log inside assistant `content` (tens of KB); always reduce to the human-visible part (`humanVisibleText`) before sending to any model.

## 9. Immediate next steps, in order

1. Ask the owner to pick a provider in Settings › AI analysis (Claude Code needs no key) and press **Analyse now** once; watch `analysis_runs`/`llm_calls`; fix whatever a real run reveals.
2. Have the owner run `npm run harness:executor` so real syncs and rule health start accumulating; remove demo data when they are done (`npm run harness:demo -- --remove`).
3. Resolve the branch: merge to `main`, PR, or keep (owner's call).
4. Then plan Phase B from the round-4 spec §3 with its own SDD plan; build the REST client (remix-at-message, poll, delete) in the executor, the judging screen, cost controls; the owner runs the first test.
5. Follow-ups parked: Google adapter untested with nullable-union schemas; "60 days" hardcoded in retire copy; unpriced model logs cost 0 not null; a few structural tests still pin whole JSX lines.
