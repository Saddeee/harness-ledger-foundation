# Harness Ledger — checkpoint plan (2026-09-18)

> For agentic workers: implement one work package (WP) at a time from the briefs below; each WP has its own
> tests and verification. Steps use checkbox syntax. Read `DECISIONS.md` and `docs/audit/*.md` first.

**Goal:** make every claim Harness Ledger makes (UI, README, landing page) match what the code verifiably
does, without spending a Lovable credit or mutating any Lovable resource; ship the truthful historical
replay, honest Skills status, incremental sync/analysis semantics, MCP permission parity, a one-command
setup, the demo fixture plan, and a release report.

**Architecture:** unchanged two halves — `src/` (TanStack Start web app) and `harness/` (Node + SQLite local
runtime behind `harness/src/adapter.ts`). New behaviour goes into small modules with unit tests
(`harness/test/*.test.ts`, `node:test` via `tsx`); UI copy lives in `src/lib/harness-ux.ts` and is pinned by
the structural tests in `harness/test/ux*.test.ts` (update them with intent, never weaken).

**Spec:** `SPEC.md` (canonical product behaviour for this checkpoint), audits in `docs/audit/`.

## Global constraints (binding)

- No Lovable credit, no Lovable mutation, no project creation, no replay run, no Skill/Knowledge write, no
  merge to main, no republish. Read-only Lovable inspection only if needed. (`SPEC.md` §0)
- Subagents: Sonnet at most, Haiku for mechanical work, never Opus. Implementers never spawn reviewers.
- Never `git stash`, `git reset`, or `git checkout -- <file>` in this checkout while agents work in it.
- One owner per migration: v18 (replay environment, done), v19 (skill proposals, orchestrator), v20
  (analysis context and reanalysis, orchestrator). Implementers append store code in delimited
  `// ---- Checkpoint 2026-09-18 <WP> ----` blocks and re-read before editing.
- UI copy never says "SPEC.md", "checkpoint", or "Claude Code" (except as the provider name).
- Every `<details>` collapsed by default. `lovableStatusLine` is the only source of "added to Lovable" claims.
- Copy words: the existing test is a **historical replay** with labels **Historical result** and **Replay
  with rule**; never "paired", "proof", "both builds", or unqualified "free". Cost sentence verbatim:
  "Creating project copies currently uses no Lovable builder credits. Running a Lovable build inside a copy
  consumes normal Lovable builder credits."
- Commits: small, on `local-harness-dev`, with the Co-Authored-By / Claude-Session trailer. No push except
  the `hosted-foundation-v1` tag (WP9, explicitly requested).

## Work packages

| WP | Name | Cost | Depends on | Parallel with | Owner |
|---|---|---|---|---|---|
| 0 | Audit and truth documents | none | — | — | orchestrator (done: `docs/audit/*`, `DECISIONS.md`, `VERIFICATION.md`, `build-log.md`, `SPEC.md`) |
| 1a | Replay environment record (migration v18, selection source, rules of the time kept, quality label, backfill) | none | — | — | orchestrator — **done, commit 588a96b** |
| 1b | Replay UX + copy: judge page order, Historical result / Replay with rule, environment summary, verdict question, collapsed details, Tests page kind/quality, cost wording everywhere, structural tests | none | 1a | 4, 5, 6, 7 | subagent (UI) — files: `src/routes/_authenticated/judge.tsx`, `tests.tsx`, `src/lib/harness-ux.ts` (test section only), `src/lib/improvements-client.ts`, `src/components/harness/improvement.tsx` (test dialog copy), `src/components/harness/local-settings.tsx` (evidence copy), `harness/test/ux-round6-*.test.ts`, `ux-round5-evidence.test.ts`, `ux.test.ts` |
| 2 | Managed block heading + write sequence verification + own-block transition | none | audit `knowledge-history.md` | 4, 5, 6, 7 | subagent — files: `harness/src/knowledge.ts`, `harness/src/executor/beats.ts` (own-block recognition only), `harness/test/knowledge.test.ts`, `executor.test.ts`, `ux-round6-writes.test.ts` |
| 3 | Rule health / retirement semantics + Instructions & History UX ("Is this rule still useful?", observed vs AI review lines, Needs attention, inactivity review, contradiction classification, "Restored Knowledge from version N", instruction detail order) | none | audit `rule-health.md`; after 1b and 4 land (shared files) | — | subagent — files: `harness/src/analysis/health.ts`, `classify.ts`, `retire.ts`, `harness/src/improvements.ts` (health/timeline blocks), `src/lib/harness-ux.ts` (health/history sections), `src/routes/_authenticated/instructions.tsx`, `history.tsx`, `src/components/harness/*`, tests |
| 4 | Skills as first-class: destination selection (Knowledge / Skill / both) with reason and alternative, local Skill proposals (propose, edit, approve, version, retire), honest "not in Lovable yet" state, Skills page shows proposals + workspace Skills; no Lovable Skill write | none | migration v19 (orchestrator) | 1b, 2, 5, 6, 7 | subagent — files: `harness/src/analysis/propose.ts`, `harness/src/store.ts` (append block), `harness/src/improvements.ts` (destination + skill proposal actions), `harness/src/adapter.ts`, `src/routes/api/public/harness/skills.ts`, `src/routes/_authenticated/skills.tsx`, `src/components/harness/improvement.tsx` (destination control), `src/lib/improvements-client.ts`, tests |
| 5 | Sync/analysis semantics: `automatic_analysis_after_sync` setting (default off, scheduler honours it), context packet (task request, latest reply, previous 3–5 task messages, active rules, Skill names, relevant older messages by term match) with recorded selection, Reanalyse history action (scope, estimate, confirmation, mode) that never overwrites human decisions (disagreement review item) | none (analysis itself is user-triggered) | migration v20 (orchestrator) | 1b, 2, 4, 6, 7 | subagent — files: `harness/src/analysis/*.ts`, `harness/src/executor/schedule.ts`, `harness/src/executor/beats.ts` (analysis trigger only), `src/components/harness/local-settings.tsx` (analysis settings only), `src/routes/_authenticated/inbox.tsx` (Reanalyse control), `src/routes/api/public/harness/executor.ts`, tests |
| 6 | Harness MCP over the same paths as the UI (adapter/improvements/beats), remove raw-store and dead checkpoint tools, remove `harness/src/web/server.ts`, MCP protocol smoke test, permission parity tests | none | — | 1b, 2, 4, 5, 7 | subagent — files: `harness/src/mcp-server.ts`, `harness/test/mcp-server.test.ts` (new), `harness/test/verification.test.ts` (mcp structural test), `.mcp.json`, delete `harness/src/web/` |
| 7 | Setup: `npm run setup`, `npm run harness:start` (HARNESS_RUNTIME=local, repo-local DB, 127.0.0.1), Node check, tests | none | — | 1b, 2, 4, 5, 6 | subagent — files: `scripts/setup.mjs`, `scripts/harness-start.mjs`, `package.json` (scripts only), `harness/test/setup-scripts.test.ts` (new), README "Getting started" commands |
| 8 | README truth pass, privacy paragraph, hosted authorization wording, "Use Harness Ledger through MCP", status sections, link validation test; landing page (progressive disclosure) | none | 1b–7 | — | orchestrator + one subagent for the landing page |
| 9 | Git: tag `hosted-foundation-v1` at `3fff0d9` (main), push tag, verify; release report | none | — | any | orchestrator |
| 10 | Demo fixture plan `DEMO_PLAN.md` (Nordic Booking Desk) | none (plan only) | 1b, 4 | any | orchestrator |
| 11 | Verification: tests, typechecks, lint, local build, hosted build (no better-sqlite3), local smoke, hosted smoke, MCP smoke, README links, fresh clone; `VERIFICATION.md` | none | all | — | orchestrator |
| — | Paired comparison | would cost credits to verify | — | — | **deferred** (DECISIONS.md D3) |

## Stop conditions

- Any step that would send a Lovable builder prompt, create/remix/delete a project, write Knowledge or a
  Skill, or spend credits: stop and ask.
- Any step that would push a branch (not the tag), merge to main, or republish: stop and ask.
- A subagent reports a claim it cannot back with file:line or a run: do not accept; re-verify.
- `cd harness && npm test` red at the end of a WP: the WP is not done.

## Verification per WP (summary; details in `VERIFICATION.md`)

- 1a/1b: `harness/test/replay-environment.test.ts`, `experiments.test.ts`, `ux-round6-*.test.ts`; judge page
  renders environment summary for run 7 from the live DB copy (read-only).
- 2: `knowledge.test.ts` write-sequence cases; own-block transition test for old and new heading.
- 3: `rule-health.test.ts`, `retire.test.ts`, `analysis-classify.test.ts` (contradiction enum), ux tests.
- 4: `analysis-propose.test.ts` (destination schema strict-compatible), `improvements.test.ts` (skill proposal
  lifecycle), skills route test.
- 5: `analysis-run.test.ts` (incremental, reanalyse scope, human decisions preserved), `executor.test.ts`
  (scheduler never analyses unless the setting is on and a request exists).
- 6: `mcp-server.test.ts` (in-memory MCP client: tool list, parity refusals).
- 7: `setup-scripts.test.ts` (node floor, bind address, DB path defaults).
- 8: README link test; landing page structural test.
- 11: full matrix in `VERIFICATION.md`.

---

# Checkpoint 2 (2026-09-18, evening): demo readiness and product-surface simplification

Accepted premise: backend capability is sufficient; the risk is that a new user cannot tell what to do,
what Harness Ledger recommends, what happens next, and whether Lovable or credits are affected.
Product promise: "Harness Ledger learns from the corrections you give Lovable, turns reusable lessons into
Knowledge or Skills, and helps you decide whether those instructions should remain."
Naming rule (owner feedback): the product is always "Harness Ledger" in anything a person reads; never
"Harness" alone. The MCP server is "Harness Ledger MCP" in copy.

| WP | Name | Depends | Owner / files |
|---|---|---|---|
| 2-0 | Backup + migration verification (done: `harness.db.bak-checkpoint2-202609181948`, schema 21, 7 runs, decisions intact); migration v22 deletion status | — | orchestrator |
| 2-A | Onboarding path + Overview next-action page + nav; landing → app link | — | subagent: `src/routes/_authenticated/overview.tsx`, `onboarding.tsx` (new), `route.tsx` (nav + first-use redirect), `src/lib/onboarding-copy.ts` (new), `src/routes/index.tsx` (CTA only), tests `harness/test/ux-onboarding.test.ts` |
| 2-B | Inbox card + Suggestions detail three-level hierarchy; action consequence lines | — | subagent: `src/components/harness/improvement.tsx`, `inbox.tsx`, `ledger.tsx`, `src/lib/harness-ux.ts` (section `2-B`), tests |
| 2-C | Instructions (Knowledge / Skills split, attention first, status lines), Skills page cards, History (current state vs timeline, diffs collapsed) | — | subagent: `instructions.tsx`, `skills.tsx`, `history.tsx`, `timeline.tsx`, `harness-ux.ts` (section `2-C`), tests |
| 2-D | Replay page order + "Why this is an approximation" + derived conclusion (historical_support / not_supported / possibly_harmful / inconclusive) | — | subagent: `harness/src/executor/replay-environment.ts` (conclusion fn), `harness/src/improvements.ts` (judge + view), `judge.tsx`, `tests.tsx`, `harness-ux.ts` (section `2-D`), tests |
| 2-E | OpenAI compatibility strategy + Test provider action | — | subagent: `harness/src/llm/openai.ts`, `llm/index.ts`, `llm/capabilities.ts` (new), `src/routes/api/public/harness/executor.ts` (test_provider action), `local-settings.tsx` (Test provider button), tests |
| 2-F | Safety gaps: deletion read-back, MCP Skill-proposal tools, MCP budget parity test, hosted-build test, safe-to-delete test | — | subagent: `harness/src/executor/experiments.ts`, `lovable-rest.ts`, `mcp-server.ts`, `adapter.ts` (append), `harness/test/*` |
| 2-G | Capability manifest + consistency tests | — | subagent: `harness/src/capabilities.ts` (new), `harness/test/capabilities.test.ts`, README/landing validation hooks |
| 2-H | Naming sweep, automatic-mode and sync copy, README two-depth rewrite, landing reorder, DEMO_PLAN simplification, operator checklist, git prep, PR summary, HANDOFF | 2-A…2-G | orchestrator |

Shared-file rule: `harness-ux.ts` and `adapter.ts` receive appended delimited sections only; re-read before
every edit; no git commands by subagents. Strict scope: no Lovable operation, no credits, no merge, no publish.
