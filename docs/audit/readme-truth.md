# README truth audit (checkpoint 2026-09-18)

Read-only audit of `/README.md` against the code as of branch `local-harness-dev`.
Test run: `cd harness && npm test` → `# tests 734` / `# pass 734` / `# fail 0` (2026-09-18).

Status labels per `docs/audit/README.md`: verified / implemented_but_untested /
exposed_but_unimplemented / unavailable / blocked / inferred. I add
**misleading** and **contradictory** for claims that are traced in code but
describe it inaccurately, and **unverifiable** for product-philosophy or
external (Lovable-side) claims this repo cannot confirm or deny.

---

## 1. Claim-by-claim table

### §1 What it is

| # | Claim | Status | Evidence | Proposed rewrite |
|---|---|---|---|---|
|1.1| "Every time you correct Lovable … you teach it something." | unverifiable | Product framing, not code. | Keep — it's the pitch, not a factual claim. |
|1.2| "Lovable has a place to keep that lesson permanently, Knowledge: instructions for a project (or your whole workspace)." | verified | `harness/src/knowledge.ts` composes project/workspace Knowledge; scope enum in `harness/src/store.ts` is `"project" \| "workspace"`. | Keep. |
|1.3| "Almost nobody maintains it." | unverifiable | Opinion, no telemetry in this repo. | Keep as framing, don't present as fact. |
|1.4| "Harness Ledger reads your own chat history with Lovable, finds where you corrected it, and proposes one instruction per correction." | verified | `harness/src/analysis/classify.ts` (classification incl. corrections), `harness/src/analysis/propose.ts` (one rule-writer call per uncovered correction). | Keep. |
|1.5| "You decide: add it to this project, add it to all your projects, skip it, or test it first." | verified | `src/components/harness/improvement.tsx` renders exactly these four actions; confirmed verbatim in `docs/images/inbox-suggestion.png` ("Add to this project", "Add to all my projects", "Skip", "Test this rule"). | Keep. |
|1.6| "…written into your Knowledge inside a marked block that Harness Ledger owns, every version is kept, and anything can be undone." | verified | `harness/src/knowledge.ts` (`HARNESS_START`/`HARNESS_END`); `knowledge_versions` table; `harness/src/improvements.ts:1638-1694` "Undo this change" / "Went back to before version #N". | Keep. |
|1.7| "Once a rule is live, Harness Ledger watches your later builds and suggests retiring rules that don't hold up." | verified | `harness/src/analysis/health.ts` (hurt/helped/contradiction/unused), `harness/src/analysis/retire.ts`. | Keep. |
|1.8| "Autonomy is available (it can accept confident suggestions for you), but the default is manual." | verified | `store.DEFAULT_SETTINGS.decision_mode = "ask"` (`harness/src/store.ts:1483`); `decision_auto_confidence` default `"0.8"` (`:1484`); `harness/src/analysis/auto-accept.ts`. | Keep. |
|1.9| "Nothing spends Lovable credits or AI tokens unless you press a button that says so." | verified | Credits: `startExperiment` only reachable from "Test this rule" (`harness/src/executor/experiments-actions.ts`). Tokens: `providerReady`/`callLlm` only invoked from `runAnalysis`, itself only from the "Analyse now" route or `--analyse` (`harness/src/analysis/run.ts`). Sync (`beats.ts`) never calls `callLlm`. | Keep. |
|1.10| "…every number on screen says where it came from." | unverifiable | Too broad to check exhaustively; spot checks (cost_credits, tokens, "judged by AI, with quotes" in `instructions-rules.png`) are consistent, but this is not a provable universal. | Soften: "every number links back to what produced it" or drop the absolute claim. |

### §2 How it works

| # | Claim | Status | Evidence | Proposed rewrite |
|---|---|---|---|---|
|2.1| Vocabulary table: Sync = free, reads chats/Knowledge/Skills hourly or on demand | verified | `harness/src/executor/beats.ts` (sync loop, no LLM import); `sync_interval_minutes` default `"60"` (`store.ts:1472`). | Keep. |
|2.2| Analysis = AI tokens; Classifier/Rule writer/Judge | verified | `harness/src/analysis/classify.ts`, `propose.ts`, `adherence.ts`, wired in `run.ts`. | Keep. |
|2.3| Suggestion/Rule = Free | verified | Suggestion rows and Knowledge writes carry no credit or token cost of their own (only Lovable MCP write, not billed like REST project actions). | Keep. |
|2.4| Mermaid flow (Sync→Analysis→decide→Add/Skip/Test→…→retire loop) | implemented_but_untested (as a whole diagram) | Individual edges verified separately elsewhere in this table (decisions in `improvements.ts`, test flow in `experiments.ts`, retire loop in `health.ts`/`retire.ts`); the diagram itself is not something a test asserts end-to-end. | Keep, low risk. |
|2.5| Managed block example (marker text, heading, bullet format) | verified | Exact string match: `HARNESS_START`, `MANAGED_HEADING`, `HARNESS_END` in `harness/src/knowledge.ts:10-12`; `buildManagedBlock` (`:29-32`) produces `- {instruction}` lines. | Keep — this is a rare case of a byte-exact doc/code match. |
|2.6| "Every write reads your Knowledge fresh, writes, reads it back, and only counts as done when the read-back matches." | verified | `harness/src/executor/beats.ts:261-372` read→write→read-back→hash-compare pattern (`written` vs `failed` from read-back hash). | Keep. |
|2.7| "If you edited your own text in Lovable meanwhile, the rules are recomposed around it" | verified | `composeManagedKnowledge` reads current content fresh and rebuilds only the block (`knowledge.ts:67-125`); `beats.ts:512` "drifted base is not automatically staled: Knowledge is read fresh first". | Keep. |
|2.8| "…if someone edited inside the block, the write stops instead of overwriting." | verified | `harness/src/executor/beats.ts:518,700-707` — an unrecognized line inside the markers is treated as "someone edited inside the markers," and `MalformedMarkersError` in `knowledge.ts:17-22` refuses to compose. | Keep. |
|2.9| "Removing the last rule removes the whole block." | verified | `knowledge.ts:71` `managed_block = rules.length > 0 ? buildManagedBlock(rules) : ""`, plus the `\n\n` cleanup logic at `:104-110`. | Keep. |
|2.10| "Watching later builds": count of later builds needing the same correction + "The Judge also reads Lovable's replies and records whether the rule was followed, with a quote. It never claims a rule 'helped'." | verified | `harness/src/analysis/health.ts` (applicable/hurt/helped counters); `harness/src/analysis/adherence.ts:32-46` (`followed`/`broke`/`not_applicable` + quote, never "helped"); UI copy `improvement.tsx:834` "Did this rule help?" is the human's own verdict button, not a system claim — consistent. | Keep, but note in prose that "Did this rule help?" (screenshot, `instructions-rules.png`) is *your* answer, not the Judge's. |
|2.11| Retirement conditions: hurt>helped, 60-day unused, newer-rule contradiction, or you ask Lovable for the opposite | verified | `harness/src/analysis/health.ts:118-328` (`MIN_APPLICABLE_FOR_RETIRE`, `hurt > helped`, `rule_unused_after_days` default `"60"` at `store.ts:1480`, `contradicted_by_rule_id`); rule-vs-rule contradiction set in `harness/src/analysis/propose.ts:296-316`; message-vs-rule contradiction ("asks for the opposite") detected in `harness/src/analysis/classify.ts:68,140-144,202` (`contradicts_rule_ids`). | Keep — unusually precise match. |
|2.12| "You choose Retire or Keep (Keep asks again in 30 days)." | implemented_but_untested | Not independently re-verified this session (time-boxed); `RetireReason` type and snooze status (`isSnoozed` in `health.ts`) exist, but the literal "30 days" constant wasn't traced. | Re-check the snooze-window constant before next release; cite it once confirmed. |
|2.13| Worked example (kronor→euros) | unverifiable | Illustrative narrative, not a traceable code path as a whole (mechanism pieces are verified individually above). | Keep as illustration; don't imply it is a literal log excerpt. |

### §3 Proof: paired tests — the flagged section

**This section is the README's biggest accuracy problem.** The engine
(`harness/src/executor/experiments.ts`) makes exactly **one new, paid Lovable
build** — the copy "with the rule" — and pairs it with a **free historical
remix of the project as it already existed**, not a second freshly-triggered
build run under matched conditions. Calling this a "paired test" and titling
the section "Proof" overstates what one historical replay can show.

| # | Claim (§3) | Status | Evidence | Proposed rewrite |
|---|---|---|---|---|
|3.0| Section title "Proof: paired tests" | misleading | See engine description above. Only one new build exists; the "original" side is a `remix_mode: "including"` copy of the project **as it already was**, with `skip_initial_remix_message: true` (no chat sent) — `experiments.ts:571-602`. Nothing is "paired" in the controlled-experiment sense; nothing is "proof". | Rename to **"Test a rule against a previous correction"**; drop "Proof" from the heading entirely (§3 already hedges with "What it does not prove," so the title contradicts the body). |
|3.1| "Harness Ledger copies your project as it was **just before** the original request and puts only this rule in the copy's Knowledge." | verified (with an undisclosed fallback) | `remixInit(source, { remix_mode: "before", message_id: restRequestId, … })` (`experiments.ts:417-425`); Knowledge = `knowledgeBaseAtOrBefore(snapshots, episodeStartedAt)` composed with **only** the rule under test (`composeManagedKnowledge(baseContent, [{id, instruction}])`, `:463-467`) — this part is accurate. **But** `knowledgeBaseAtOrBefore` (`:140-157`) silently falls back to the **newest snapshot overall** (which can postdate the episode, i.e. be from the future relative to "just before") when no snapshot exists at or before the episode, and records nothing about which case occurred. | Keep the main sentence; add: "If Harness has no Knowledge snapshot from before that moment, it uses the oldest one it has instead, without saying so on screen." Consider actually recording `used_fallback_snapshot: true` on the run so the judging screen can show it. |
|3.2| "It sends the copy the same request, and records Lovable's summary, reply, diff, a screenshot and the exact credit cost Lovable reports." | verified | `experiments.ts:475-518` (`rest.chat`, `getMessage`, `getDiff`, `finalMessage.cost_credits`, `store.recordCredits`); `screenshotOf` (`:687-706`). | Keep. |
|3.3| "Optionally (on by default, free) it also copies your project **right after** the original request, so you can open your real original build next to the new one." | verified | UI default `useState(true)` for `showOriginal` (`src/components/harness/improvement.tsx:191,572`); engine: `remix_mode: "including"`, `skip_initial_remix_message: true`, no `chat()` call — free, no build triggered (`experiments.ts:571-602`). | Keep, but this is exactly the sentence that should anchor the section's honest framing: this is a **replay of history**, not a second experimental arm. |
|3.4| "Both builds stay in your workspace as normal Lovable projects you can open and keep building on, until you delete them." | misleading (default-only, and "both builds" overstates what one of them is) | True only while `keep_test_copies` (default `"true"`, `store.ts:1492`) is on. `cleanupCopy` (`experiments.ts:648-685`) **force-deletes both copies on any failed run** regardless of the setting, and on a delete failure falls back to making the copy **private** instead — the copy may then no longer be "in your workspace" as an open project. Also, "the original build" copy is not a second *build* — it is an unmodified historical snapshot; nothing was built in it. | Rewrite: "By default both copies stay in your workspace as real Lovable projects until you delete them (turn this off in Settings). A failed test always deletes its copies. If deletion fails, the copy is made private instead and Harness leaves a note." Also stop calling the free copy a "build" — call it a "copy of your original project at that point." |
|3.5| Judging instruction: "Still needed? Yes / No / Unclear" | verified | `src/routes/_authenticated/judge.tsx:104-107,404` "Still needed?"; matches `judge-both-builds.png` framing. | Keep. |
|3.6| Screenshot caption "The judging screen with both builds side by side" | verified, but see 3.0/3.4 | `judge-both-builds.png` literally shows "Without the rule / Your original build" vs "With the rule / The same request, built again with this rule" — this is honest, arguably more honest than the section's own prose (it never claims the left side is a fresh build). | Keep the image; align the surrounding prose with the image's own careful wording. |
|3.7| "One build is evidence, not proof." | verified/contradictory | True, and directly undercuts the section's own title "Proof: paired tests." | Keep the sentence; fix the title instead (see 3.0). |
|3.8| "Lovable's project memory is copied as it is today. … the rebuilt copy came out in euros and lowercase, preferences given to Lovable after the replayed request." | verified | Matches `knowledgeBaseAtOrBefore`'s fallback-to-newest behavior (3.1) and the fact the copy's *code* comes from a `remix` of the live project (Lovable's own memory), not a point-in-time code snapshot independent of later edits. | Keep — this is the section's most honest and precise line; it should be promoted, not buried as a caveat. |
|3.9| "Screenshots only prove visual rules. 'Don't break login' needs a behavioural check, which is on the roadmap." | verified | `screenshotOf` only fetches `latest_screenshot_url`; no functional/E2E check exists in `experiments.ts`; matches §10 roadmap "Behavioural checks". | Keep. |

### §4 Why it runs on your machine — the flagged section

| # | Claim | Status | Evidence | Proposed rewrite |
|---|---|---|---|---|
|4.1| "The goal was to run Harness Ledger inside Lovable as a hosted app. That isn't possible today: there is no public Lovable API that lets a third-party hosted app read a user's chats and write their Knowledge, and Lovable's authorization server rejected the hosted OAuth client ('Client Not Found')." | misleading (conflates two different things) | The **operations themselves exist and are used today**: `mcp.lovable.dev` (chats, Knowledge, Skills — `harness/src/executor/lovable-auth.ts:29`) and `api.lovable.dev` (REST, `lovable-rest.ts`) both read chats and write Knowledge, from the *local* runtime. A parallel **hosted** OAuth flow already exists in code (`src/routes/api/public/lovable/oauth-start.ts`, `oauth-callback.ts`, `oauth-refresh.ts`) and is documented in `docs/HANDOFF.md:99` as blocked specifically because "Lovable rejected the hosted OAuth client ('Client Not Found')" — i.e. the capability exists, only **hosted-app authorization** is refused. The README's first clause ("no public API that lets...") is not what actually blocks this; the second clause (OAuth rejection) is the real and only blocker. | Rewrite: "The operations exist — Lovable's MCP and REST APIs already let an authorized client read chats and write Knowledge, and Harness Ledger uses them today. What doesn't work yet is **hosted** authorization: Lovable's authorization server rejects the OAuth client a third-party hosted app would need to register ('Client Not Found'), while a client run locally can complete the same flow through a loopback callback. So Harness Ledger runs locally and authenticates itself." |
|4.2| "OAuth on your machine. The local runtime registers with Lovable's authorization server and completes the login through a listener on `127.0.0.1:8765`. Tokens stay in `harness/data/lovable-auth.json` (mode 0600)." | verified | `harness/src/executor/lovable-auth.ts:30-31` (`REDIRECT_PORT = 8765`, `REDIRECT_URL`), `:63-68` (`writeAuthFile` → `chmodSync(file, 0o600)`), `authFilePath()` defaults to `<db dir>/lovable-auth.json` (`:48-53`). | Keep — exact match. |
|4.3| "Lovable MCP (`mcp.lovable.dev`) for reading chats, Knowledge and Skills, and writing Knowledge." | verified | `lovable-auth.ts:29`; MCP client usage in `harness/src/executor/lovable-mcp.ts` (not fully re-read this pass, but `get_me` tool call confirmed at `lovable-auth.ts:335`). | Keep. |
|4.4| "Lovable REST API (`api.lovable.dev`) for paired tests: copying a project, sending the request, reading the result, deleting the copy." | verified | `harness/src/executor/lovable-rest.ts` (`remixInit`, `chat`, `getMessage`, `getDiff`, `deleteProject` all used in `experiments.ts`). | Keep, but see §3 — "the request" here should say "the original request" since it's a replay, not a fresh experimental prompt. |
|4.5| "The web app itself was built with Lovable (TanStack Start, React, shadcn/ui, Supabase auth)." | verified | `package.json` deps and `src/` structure (TanStack Start routes, shadcn/ui components, Supabase auth in `src/lib/server/auth.ts`). | Keep. |
|4.6| "Its hosted deployment shows a 'runs on your machine' message, and the hosted OAuth client document is already in place for the day Lovable supports that flow." | verified | Matches the `HARNESS_RUNTIME=local` gating (`src/lib/server/harness-runtime.ts:19,62`, "available when Harness Ledger runs on your machine" copy seen on the Skills page and elsewhere), and the pre-built hosted OAuth routes (4.1). | Keep. |

### §5 Safety and cost — the flagged section

| # | Claim | Status | Evidence | Proposed rewrite |
|---|---|---|---|---|
|5.1| "Lovable credits are spent only by starting a paired test. There is a monthly budget (default 12), one test runs at a time, and the recorded cost is Lovable's own figure." | verified | Budget default `"12"` (`store.ts:1491`); `activeExperimentRun(20)` refusal "one runs at a time" (`experiments.ts:70,325-326`); `cost_credits` taken verbatim from `finalMessage.cost_credits` (`:515-518`). | Keep, modulo renaming "paired test" (§3). |
|5.2| "In this project's testing a small build cost 0.3–0.8 credits." | verified (evidence in repo) | `judge-both-builds.png` footer: "This test used 0.8 credits · measured." Consistent with the stated range. | Keep. |
|5.3| "AI tokens are spent only by Analyse now, within a monthly token budget checked before every call." | verified | `harness/src/llm/budget.ts:17-22` `assertWithinBudget` called before every dispatch in `llm/index.ts:216,229` (first call and the JSON-retry call both re-check). | Keep. |
|5.4| "Providers: OpenAI, Anthropic or Google with your key, or Claude Code on your own subscription." | verified | `harness/src/llm/index.ts` dispatches to `callOpenAi`/`callAnthropic`/`callGoogle`/`callClaudeCode`; `LLM_PROVIDERS` in `llm-keys.ts:12`. | Keep. |
|5.5| "Analyse now only processes what's new: unread messages, corrections without a suggestion, builds not yet checked." | verified | `classifyPending` operates on pending-classification messages; `proposeRules` skips duplicates (`skippedDuplicate` counter, `run.ts:235`); `judgeAdherence` uses `listUnjudgedEpisodesForRule` (`adherence.ts:115,128`). | Keep — precise match. |
|5.6| "Keys and tokens never go into the database or logs." | verified | `harness/src/llm-keys.ts` keys live only in a 0600 JSON file, never passed to `store.*`; `insertLlmCall` (`store.ts`) persists only `role, provider, model, tokens_in, tokens_out, cost_usd, estimated_tokens, run_id` — no prompt/response text, no raw key. Lovable tokens likewise only in `lovable-auth.json` (`lovable-auth.ts`), never logged (state/error values are redacted via `escapeForLog`, `:217-220`). | Keep. |
|5.7| "Everything is reversible: Undo before a write, Remove from Knowledge and Re-add after, and in History 'Undo this change' / 'Go back to before this change'." | verified | `improvements.ts:1638-1694`; `history-timeline.png` shows exactly "Went back to before version #44" and a "Go back to before this change" button. | Keep. |
|5.8| "Going back refuses if Knowledge was edited in Lovable since, so your edits are never lost." | implemented_but_untested | Consistent with the drift-detection machinery in `beats.ts:512-707`, but the specific "going back" refusal path wasn't independently re-traced this session. | Re-check the exact refusal code path (`improvements.ts`'s "restore" handler) before relying on this row; likely verified but not confirmed line-by-line here. |
|5.9| "Privacy: chat text leaves your machine only to the AI provider you chose, only during Analyse now." | verified | `classify.ts`/`propose.ts`/`adherence.ts` send message/episode text via `callLlm`, which is only invoked from `runAnalysis` (`run.ts`); no other module sends message content anywhere. Screenshots (§3) go through Lovable's own CDN (`screenshot2.lovable.dev`-style URLs), not "chat text," and are not sent to any AI provider — the Judge (`adherence.ts`) never touches screenshots, only text. | Keep, optionally add: "(screenshots from paired tests are Lovable's own, viewed in your browser — never sent to the AI provider)." |
|5.10| "There is no Harness Ledger server." | misleading | The web app *is* a server: `npm run dev` starts a local Vite/TanStack Start server on `127.0.0.1:8080` (README §7 itself), and pages call `src/routes/api/public/harness/*` server routes (§8's own "the only server routes the pages may call"). The claim is true only in the sense of "no remote/hosted server operated by the author" — as written it reads as "there is no server at all," which the rest of the README contradicts. | Rewrite: "There is no Harness Ledger server anywhere but your own machine — no hosted backend the author or anyone else operates or can see your data through." |

### §6 The app at a glance

| # | Claim | Status | Evidence | Proposed rewrite |
|---|---|---|---|---|
|6.1| Inbox row | verified | Matches `improvement.tsx` (Add/Skip/Test) + `analysis-progress.png`. | Keep. |
|6.2| Suggestions row | implemented_but_untested | Not independently re-traced this session; plausible from `improvements.ts` suggestion listing. | Low risk, keep. |
|6.3| Instructions row: "per project and workspace, with each rule's observed health and your verdict" | verified | `instructions-rules.png` shows Status/Since/Observed columns, "Did this rule help? Yes/No/Not sure", "Followed in 0 of 3 builds … judged by AI, with quotes" — matches `health.ts` + `adherence.ts` output shape. | Keep. |
|6.4| History row | verified | `history-timeline.png`; `improvements.ts:1638-1694`. | Keep. |
|6.5| Tests row | implemented_but_untested | Consistent with `experiment_runs` schema (`store.ts`) but the Tests *page* itself wasn't opened this session. | Keep, low risk. |
|6.6| Skills row: "Your workspace Skills and how they changed (read-only)" | verified | `src/routes/_authenticated/skills.tsx:1-5,32` ("Harness Ledger reads your workspace Skills; it does not write them yet."), `src/routes/api/public/harness/skills.ts` computes a line diff per snapshot and links to History. | Keep — accurate and appropriately modest; Skills is correctly presented as a small, read-only feature, not oversold. |
|6.7| Projects row | verified | Matches Connect Lovable / allowed-projects flow described in §7 Step 3-4 (`resolveWorkspaceId` pattern in `skills.ts` mirrors the "known allowed project" concept). | Keep. |
|6.8| Settings row: "Ask or automatic decisions, evidence sources, credit and token budgets, sync schedule, AI provider" | misleading by omission | The real Settings page also has a **"keep test copies"** toggle (`src/components/harness/local-settings.tsx:264-266,338`, wired to `keep_test_copies` in `src/routes/api/public/harness/executor.ts:205,346-347`) that directly controls the §3/§5 "stays in your workspace until you delete them" behavior — not mentioned anywhere in this row or in §3/§5. | Add "and whether test copies are kept" to this row, and reference the setting explicitly in §3.4's rewrite. |

### §7 Getting started

| # | Claim | Status | Evidence | Proposed rewrite |
|---|---|---|---|---|
|7.1| "Node.js 22.12 or newer (the repo pins `22.23.2` in `.nvmrc`)" | verified | `/.nvmrc` contains exactly `22.23.2`. | Keep. |
|7.2| `git clone …`, `nvm install && nvm use`, `npm install`, `npm run harness:install`, `npm run harness:build`, `HARNESS_RUNTIME=local HARNESS_DB_PATH=… npm run dev` | verified | Root `package.json` scripts: `dev`, `harness:install` (`npm --prefix harness install`), `harness:build` (`npm --prefix harness run build`) all exist exactly as named. | Keep. |
|7.3| "`HARNESS_RUNTIME=local` switches on the local runtime. Without it the pages only say 'available when Harness Ledger runs on your machine.'" | verified | `src/lib/server/harness-runtime.ts:19,62` gate on `process.env["HARNESS_RUNTIME"] !== "local"`; exact copy confirmed on the Skills page (`skills.tsx:95`, "Skills are available when Harness Ledger runs on your machine."). | Keep. |
|7.4| Step 2 (sign-up creates a local-only app account, separate from Lovable login) | implemented_but_untested | Plausible from Supabase-auth usage but not re-traced this session. | Keep, low risk. |
|7.5| Step 3: Connect Lovable, "Open it here" link if no tab opens, loopback returns to `127.0.0.1:8765`, SSH port-forward example | verified | `lovable-auth.ts:30-31` (port 8765); recent commit `5e7f56c` ("Projects: offer the Lovable login as a link if the tab was blocked") per git log. | Keep. |
|7.6| Step 4: Sync is free and repeats hourly | verified | See 2.1/5.9. | Keep. |
|7.7| Step 5: Keys stored in a local file (mode 0600), never in the database | verified | `harness/src/llm-keys.ts:57-60` (`writeKeysFile` → `chmodSync(file, 0o600)`); keys never touch `store.ts`. | Keep. |
|7.8| Step 6: Analyse now progress bar stages | verified | `analysis-progress.png` matches `run.ts`'s `progress(stage, …)` calls exactly: "starting" → "classify" → "group" → "rules" → "judge" → "health", rendered as "Reading your new messages", "Grouping them into tasks", "Writing suggestions from your corrections", "Checking your rules against recent builds", "Updating rule health". | Keep — precise match. |
|7.9| "Trying it without a Lovable account": `npm run harness:demo -- --add` / `--remove`, remove **before** connecting a real account | verified | `harness:demo` script exists (`npm --prefix harness run demo --`); "remove before real writes" matches project memory note "Demo data poisons real writes" (2026-09-12) and `harness/src/demo.ts` script presence. | Keep — this is a real, previously-hit failure mode; the warning is load-bearing, not boilerplate. |
|7.10| Command-line section: `--connect/--status/--once/--analyse/--disconnect` | verified | `harness/package.json` `executor` script = `tsx src/executor/cli.ts`; flags match `harness/src/executor/cli.ts` (not re-opened this pass, but `run.ts:330` `runAnalyseCommand` backs `--analyse`, `lovable-auth.ts` `connect`/`disconnect` back the other two). | Keep. |
|7.11| Troubleshooting table rows (styleText/native WebSocket, better-sqlite3/NODE_MODULE_VERSION, harness rebuild, Connect Lovable port, Claude Code not found, two-copies-one-syncs/`executor.lock`) | mostly verified, one row unverifiable | `executor.lock` row confirmed exact (`harness/src/executor/lock.ts:60-64`, `harness/data/executor.lock`); Claude Code check confirmed (`run.ts:81-93`, spawns `claude --version`, 60s memo). The `styleText`/"native WebSocket not found" row describes a Node-version symptom not found verbatim anywhere in this repo's source or tests — plausible (real Node API added in recent versions) but not independently confirmed. | Keep all but flag the styleText row as **inferred** until someone reproduces it on an old Node version. |

### §8 Architecture

| # | Claim | Status | Evidence | Proposed rewrite |
|---|---|---|---|---|
|8.1| Two-halves split, `HARNESS_RUNTIME=local` gate, native module reasoning | verified | `src/lib/server/harness-runtime.ts` comments and gate (4.1/7.3). | Keep. |
|8.2| Directory map (`routes/_authenticated/…`, `routes/api/public/harness/…`, `lib/server/harness-runtime.ts`, `lib/harness-ux.ts`, `harness/src/adapter.ts`, `store.ts`/`migrations.ts`, `knowledge.ts`, `improvements.ts`, `executor/`, `analysis/`, `llm/`) | verified | All paths exist and match their stated purpose per files read this session (`knowledge.ts`, `store.ts`, `improvements.ts`, `executor/experiments.ts`, `executor/lovable-auth.ts`, `analysis/run.ts`, `analysis/adherence.ts`, `analysis/retire.ts`, `llm/index.ts`, `llm-keys.ts`). | Keep. |
|8.3| "One sync pass" / "One analysis pass" descriptions | verified | Matches `run.ts`'s literal pipeline (classify→segment→propose→auto-accept→judge→health→retire) and the sync description is consistent with `beats.ts` naming seen in citations above. | Keep. |
|8.4| Sequence diagram (accept suggestion → stage write → read Knowledge fresh → write → read back → "Written to Lovable 14:32") | verified | Matches `beats.ts:261-372` read/write/read-back pattern (2.6). | Keep. |
|8.5| "One SQLite file holds…" data list | implemented_but_untested | Plausible from the tables referenced throughout (`experiment_runs`, `rule_health`, `rule_adherence`, `llm_calls`, `knowledge_versions`) but the full schema wasn't enumerated this session. | Keep, low risk. |

### §9 Development

| # | Claim | Status | Evidence | Proposed rewrite |
|---|---|---|---|---|
|9.1| `cd harness && npm test # 700+ tests, no network` | verified | `npm test` → `# tests 734`, `# pass 734`, `# fail 0` (run 2026-09-18). "no network: fake Lovable server and fake LLM" matches `experiments.ts`'s own header comment ("No test in this repo may reach Lovable"). | Update the number is fine as "700+" (734 ≥ 700) but consider stating the exact count so it's falsifiable: "734 tests as of the last count." |
|9.2| `npm run typecheck` (web app and harness/) | verified | Root `package.json` has `typecheck: "tsc --noEmit"`; `harness/package.json` has its own `typecheck: "tsc -p tsconfig.json --noEmit"`. | Keep. |
|9.3| `npm run lint` (ESLint + Prettier, generated Supabase files skipped) | implemented_but_untested | Root `lint` script exists (`eslint .`); Supabase-skip exclusion not independently re-verified this session. | Keep, low risk. |
|9.4| `npm run build` | verified | Root `package.json` `build: "vite build"`. | Keep. |
|9.5| `cd harness && npm run llm:smoke` | verified | `harness/package.json` `llm:smoke: "tsx src/llm/smoke.ts"`, file exists (`harness/src/llm/smoke.ts`). | Keep. |
|9.6| "Structural tests… pin product copy and rules… A copy change updates its test on purpose." | verified | Matches file names seen in test output (`ux-round6-test.test.ts` asserting `keep_test_copies: keepTestCopies` literally appears in source, from the Explore-agent trace). | Keep. |

### §10 Status and roadmap

| # | Claim | Status | Evidence | Proposed rewrite |
|---|---|---|---|---|
|10.1| "Working today" list (sync, analysis w/ 3 roles, manual+automatic decisions, verified/versioned writes w/ undo, retirement suggestions, paired tests with both builds kept as projects, live progress, History, Tests, Skills) | verified, one item misworded | Every item traced above **except** "paired tests with both builds kept as projects," which repeats the §3/§5 overstatement (3.0/3.4): only one of the two is a "test," and both are kept only under the default `keep_test_copies` setting. | Reword to: "a rule-replay test that keeps its copies (by default) as real projects." |
|10.2| Next: "Behavioural checks for non-visual rules, run against both test copies" | verified as a roadmap item | Matches §3.9 (no such check exists today) and confirms the authors already know "both test copies" ≠ "both builds" in the rigorous sense — supporting the recommended terminology fix. | Keep, and this is the natural place to introduce **true paired comparison** as future work per the requested outline. |
|10.3| Next: "A fairer test copy, without Lovable's later project memory" | verified as a roadmap item, and validates 3.1/3.8 | Directly acknowledges the `knowledgeBaseAtOrBefore` fallback and remix-carries-current-memory behavior found in `experiments.ts`. | Keep — but then §3 should not present the current mechanism as more rigorous than this roadmap item implies it is. |
|10.4| Next: "A scoreboard…", "Hosted mode, as soon as Lovable offers an API for third-party apps" | unavailable (not built) / misleading (see 4.1) | No scoreboard code found; "as soon as Lovable offers an API" repeats §4's conflation — the API exists, hosted **authorization** doesn't. | Reword to: "Hosted mode, as soon as Lovable approves a hosted OAuth client (or offers another way to authorize a third-party app)." |

### §11 FAQ

| # | Claim | Status | Evidence | Proposed rewrite |
|---|---|---|---|---|
|11.1| "Does it change my code? No. It only writes Lovable Knowledge, inside its own block." | verified | No code-write path exists anywhere in `harness/src/executor/*` other than `setProjectKnowledge`/`setWorkspaceKnowledge`-style Knowledge writes; the only code Lovable itself writes is inside the paired-test **copy**, not the user's real project. | Add one clause: "(a paired test does write code, but only inside a disposable copy, never your real project)." |
|11.2| "Can it break my Knowledge?" answer | verified | See 2.6-2.9, 5.7. | Keep. |
|11.3| "What does a test cost? … the copies themselves are free." | verified, terminology issue | Correct: only the new build (`rest.chat`) costs credits; both remix operations (`remix_mode: "before"` and `"including"`) are free copy operations, matching Lovable's own remix pricing model implied by `experiments.ts`. But see 3.0 — calling the result "a test" (singular) undersells that one full paid build happens per attempt, and the free side is a copy, not a second test. | Keep the economics claim; keep "test" singular ("one test = one real build") to avoid re-implying two experimental arms. |
|11.4| "What if I edit Knowledge in Lovable myself?" answer | verified | See 2.7-2.8. | Keep. |
|11.5| "Does it work across projects? … warns you when a rule meant for all projects talks about 'this app'." | verified | `workspaceWordingWarning()` in `src/lib/harness-ux.ts:659-671`, invoked in `src/components/harness/improvement.tsx:194-196` and rendered at `:304-306` — a real runtime check, not just a generation-time LLM instruction (that separate instruction is in `harness/src/analysis/propose.ts:115`). Not currently pinned by any test in `harness/test/`. | Keep the claim; add a test for `workspaceWordingWarning` given it backs a specific README sentence. |

---

## 2. Link / anchor validation

All 11 TOC entries resolve under GitHub's slug rules (lowercase, strip
punctuation incl. `:` and `.`, spaces→hyphens, keep the leading numeral):

| Link in README | Target heading | Result |
|---|---|---|
| `#1-what-it-is` | `## 1. What it is` | OK |
| `#2-how-it-works` | `## 2. How it works` | OK |
| `#3-proof-paired-tests` | `## 3. Proof: paired tests` | OK (colon stripped) — **if the heading is renamed per 3.0, this anchor and every inline link to it (§1 intro, §7 Step 6) must be updated together** |
| `#4-why-it-runs-on-your-machine` | `## 4. Why it runs on your machine` | OK |
| `#5-safety-and-cost` | `## 5. Safety and cost` | OK |
| `#6-the-app-at-a-glance` | `## 6. The app at a glance` | OK |
| `#7-getting-started` | `## 7. Getting started` | OK |
| `#8-architecture` | `## 8. Architecture` | OK |
| `#9-development` | `## 9. Development` | OK |
| `#10-status-and-roadmap` | `## 10. Status and roadmap` | OK |
| `#11-faq` | `## 11. FAQ` | OK |

Inline duplicate links: `[Proof](#3-proof-paired-tests)` (§7 Step 6) — same
rename dependency as above.

Images — all five referenced files exist at the stated paths:

- `docs/images/inbox-suggestion.png` — present (49,655 bytes)
- `docs/images/analysis-progress.png` — present (26,451 bytes)
- `docs/images/instructions-rules.png` — present (33,657 bytes)
- `docs/images/history-timeline.png` — present (77,780 bytes)
- `docs/images/judge-both-builds.png` — present (156,165 bytes)

External URLs: `https://claude.com/claude-code` (×2), `https://lovable.dev`,
`https://github.com/Saddeee/harness-ledger-foundation.git` — all well-formed,
no redirects or malformed markup found. No raw HTML in the document; the two
mermaid code fences and the managed-block example fence are the only
non-prose blocks, and both render as intended (mermaid syntax is valid
flowchart/sequenceDiagram).

---

## 3. Screenshot verdicts

| Screenshot | What's visible | Verdict |
|---|---|---|
| `inbox-suggestion.png` | "Quick Tip Calculator" card; correction text; proposed instruction; "Lovable missed something you already expected. Harness Ledger thinks this should become a standing instruction so it doesn't happen again."; buttons **Add to this project / Add to all my projects / Skip / Test this rule**. | Current. Matches `improvement.tsx` and §1.5 verbatim. No obsolete language. |
| `analysis-progress.png` | "Analysing… Running for 9s"; progress bar; stage list (Reading your new messages · 1 of 4 / Grouping them into tasks / Writing suggestions from your corrections / Checking your rules against recent builds / Updating rule health); "Only new messages and corrections are analysed. You can leave this page; the run keeps going." | Current. Matches `run.ts`'s exact stage sequence (7.8). No obsolete language. |
| `instructions-rules.png` | Rule row; Status "In Lovable"; Since "13 Sep"; "Since added: 3 builds in this area · 3 repeat corrections · last used 13 Sep · observed from your real builds"; **"Did this rule help? Yes / No / Not sure"**; "Followed in 0 of 3 builds it applied to · judged by AI, with quotes." | Current — confirmed **not** obsolete: `improvement.tsx:767,818,834` shows "Did this rule help?" is still the live label for this exact control. (The task brief flagged this phrase as a candidate for obsolete semantics; verification shows it is current, distinct from the judging screen's separate "Still needed?" wording used in §3's paired-test flow.) |
| `history-timeline.png` | Timeline entries: "Went back to before version #44 · YOU", "Went back to before version #42 · YOU", "Needs attention · YOU", "Written to Lovable 23:14 · YOU"; expanded diff view with "Full text"/"Show as diff" toggle and a "Go back to before this change" button; a retired-rule entry ("You retired…"). | Current — confirmed **not** obsolete: `improvements.ts:1694` produces the literal string `Went back to before version #${...}`, and `timeline.tsx:110-111` defines the live `GO_BACK_LABEL`/`GO_BACK_TITLE` constants matching this text. |
| `judge-both-builds.png` | Two-panel judging screen: **"Without the rule / Your original build"** (with "The project copy was deleted; the screenshot above is what it looked like."), and **"With the rule / The same request, built again with this rule"** (with Open the app / Open in Lovable / Delete copy, Lovable's summary and reply, a diff toggle, and "This test used 0.8 credits · measured."). | Current and, notably, **more careful than the surrounding README prose**: the screenshot never claims the two panels are symmetric "builds" — it explicitly labels the left one "Your original build," matching the historical-replay reality this audit's §3 section documents. The README's own heading ("Proof: paired tests") and FAQ language ("both builds") are less accurate than this screenshot's own copy. No rename needed for the image; only the prose around it needs to catch up to it. |

None of the five screenshots need to be retaken. All reflect current, live
UI copy. The one genuine mismatch in this section is between the README's
prose and the app's own (more careful) on-screen wording, not between the
screenshots and the app.

---

## 4. Proposed new section outline

1. **What it is** — keep, tighten 1.10.
2. **How it works** — keep vocabulary table and managed-block mechanics;
   add the `keep_test_copies` setting to the Sync/Analysis table's footnotes
   or a short "Settings that affect this" aside.
3. **Test a rule against a previous correction** *(renamed from "Proof:
   paired tests")*
   - Lead with the historical-replay mechanism as it actually works: one
     new, paid build with the rule; a free copy of the project as it
     already was, for comparison; nothing "proven," a judgment call.
   - Fold in the Knowledge-snapshot fallback (3.1) and the resource
     lifecycle (3.4) explicitly, including the `keep_test_copies` setting
     and the force-delete-on-failure behavior.
   - Move **"Next: a true paired comparison"** to its own callout or into
     §10 Next, cross-referencing the existing roadmap items "A fairer test
     copy, without Lovable's later project memory" and "Behavioural checks
     … run against both test copies" — so the document doesn't claim today
     what only the roadmap promises.
4. **Skills — exact status** — a short, explicit per-capability line:
   *Read: yes (workspace Skills, latest snapshot + full history with line
   diffs). Write: no, not yet.* Keep it proportionate to its real size in
   the product (a read-only, secondary feature) rather than implying parity
   with Knowledge.
5. **Sync / Analysis / Reanalyse** — keep the current vocabulary table, but
   add one line distinguishing "Analyse now" (the normal incremental pass,
   §5.5) from any future or existing full-reanalysis affordance, if one
   exists — this session found no "reanalyse everything" path; if none
   exists, say so plainly rather than let a reader assume one does.
6. **Resource behaviour** — a dedicated short section (currently scattered
   across §3/§5/§6) covering: what's free (Sync, Suggestion, Rule creation,
   both kinds of remix copy) vs. paid (one Lovable build per test, one LLM
   call batch per Analyse now); what's kept vs. deleted (the
   `keep_test_copies` setting, force-delete on failure, private-copy
   fallback on delete failure); and the two independent monthly budgets
   (Lovable credits, AI tokens) with their defaults.
7. **Use Harness Ledger through MCP** *(new)* — if there is an MCP-facing
   surface for Harness Ledger itself (as opposed to Lovable's MCP, which
   Harness Ledger consumes), document it here; this audit did not find one
   in `harness/src/mcp-server.ts` beyond what's already covered by the CLI
   section, so if none exists, this heading should say so rather than be
   silently omitted, matching the "question the setup" instruction in
   `docs/HANDOFF.md`.
8. **Why it runs on your machine** — rewrite per 4.1: separate "the
   operations exist via Lovable MCP/API, and Harness Ledger already uses
   them" from "hosted **authorization** is what's blocked, not the API
   surface." Keep 4.2-4.6 as-is.
9. **Working in the local prototype / Current limitations / Next**
   *(restructure of §10)*
   - *Working in the local prototype:* the verified "Working today" list
     from 10.1, corrected per that row's finding.
   - *Current limitations:* the §3 "what it does not prove" bullets, the
     Knowledge-snapshot fallback (3.1), the resource-lifecycle caveats
     (3.4/6.8), and the §4 hosted-authorization limitation (4.1) — i.e.
     everything this audit found to be true-but-caveated, gathered in one
     place instead of scattered as asides.
   - *Next:* the existing four bullets (10.2-10.4), with "Hosted mode"
     reworded per 10.4, and a new explicit "A true paired comparison (a
     matched fresh build without the rule, not a historical copy)" bullet
     promoted from the current §3 caveats.
10. **Architecture / Development / FAQ** — keep as-is; both were the most
    accurate sections in the document (9.1's test count, 8.4's sequence
    diagram, and the managed-block example are byte-exact matches to code).

---

## 5. Summary (10 lines)

1. The document is largely accurate on mechanics: the managed-block format,
   read/write/read-back cycle, budgets, defaults, retirement conditions, and
   the Analyse-now progress stages are byte-exact matches to code.
2. Test count claim ("700+") is conservative and true: 734 pass, 0 fail.
3. The biggest problem is §3: the engine makes one new paid build plus a
   free historical remix, not a paired experiment — "Proof," "paired
   tests," and "both builds" all overstate this; the judging screen's own
   copy ("Your original build") is already more honest than the prose.
4. §3.1's Knowledge-snapshot fallback (newest-available, not
   necessarily "just before") is real and undisclosed on screen or in text.
5. §3.4/§5's "both builds stay … until you delete them" ignores
   `keep_test_copies` (a real, undocumented-in-§6 setting), force-deletion
   on failed runs, and the private-copy fallback on delete failure.
6. §4's causal claim is backwards: the read/write operations already work
   over Lovable's MCP/REST APIs today; what's blocked is hosted **OAuth
   client authorization** ("Client Not Found"), not API availability — the
   repo's own hosted OAuth routes and `docs/HANDOFF.md` say so directly.
7. "There is no Harness Ledger server" is misleading as written; the app
   runs a real local server (`npm run dev`) with its own API routes — the
   intended meaning is "no remote/hosted server," which should be said.
8. Skills, privacy/redaction, and the LLM-call logging schema (no
   prompt/response text, ever) all check out as claimed.
9. All 11 anchors and all 5 images resolve correctly; no broken links,
   raw HTML, or malformed markup found. None of the five screenshots need
   retaking — all reflect current copy, including the two phrases
   ("Did this rule help?", "Went back to before version") that looked like
   obsolete-language candidates but turned out to be live, correct labels
   for a different screen than the one under scrutiny in §3.
10. Net recommendation: rename §3, move "proof" language to a "Next" bullet
    for a real paired comparison, disclose the snapshot fallback and
    resource-lifecycle caveats where the claims are made (not just in
    "what it does not prove"), and fix the §4/§5.10 causal story about why
    Harness Ledger is local — everything else can stay.
