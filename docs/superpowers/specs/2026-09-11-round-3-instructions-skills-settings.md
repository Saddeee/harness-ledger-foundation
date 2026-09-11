# Round 3: Instructions and Skills pages, change view, settings, decision polish

Date: 2026-09-11. Status: owner direction given in chat; details fixed here. Extends the two earlier specs.

## 1. Navigation and pages
- Nav: **Inbox, Improvements, Instructions, Skills, Projects, Settings**.
- `/instructions` is the former Knowledge page without the Skills section. Body headings keep Lovable's own term: "This project's Knowledge", "Workspace Knowledge". `/knowledge` and `/versions` redirect to `/instructions`.
- `/skills` lists workspace Skills from the latest snapshots: name, description, last changed, expandable content; a per-skill history when more than one snapshot exists. Empty state unchanged ("Your workspace has no Skills yet…"). One line: "Harness reads Skills; it does not write them yet."

## 2. A clean view of what changed
- Every history entry on `/instructions` shows a one-line summary "+N lines, −M lines" and a "What changed" toggle (collapsed) that renders a line diff between that version's `previous_content` and `new_content`: removed lines prefixed "−" in red, added lines prefixed "+" in green, unchanged context lines (2 around each change) in muted text. Capped at 40 lines with "Show full change".
- The diff is computed server-side in the knowledge route (`changes: { added: number; removed: number; lines: { kind: "+"|"-"|" "; text: string }[] }`) with a small LCS-based line diff in `harness/src/diff.ts` (pure, tested). No new dependency.
- Demo data (§6) creates three real versions so the view can be judged.

## 3. Decision polish
- Decided cards show their decision buttons inline (other destination, Skip / Restore / Reopen / Add it now instead). The collapsed "Change decision" wrapper goes away. Buttons use the `outline`/`ghost` variants so they read as secondary.
- Detail view: the instruction blockquote gets a small "Edit" button in its top-right corner; clicking swaps the blockquote for the editor in place (textarea, optional reason, Save / Cancel). The separate "Edit instruction" link below the card is removed.
- Detail view header: "3 of 7" plus "← Previous" and "Next →" buttons, ordered as the list the user came from (Inbox: pending order; Improvements: grouped order). ArrowLeft/ArrowRight navigate when focus is not in a text field. Buttons disable at the ends.

## 4. Settings (local runtime)
Sections, in order: Sync schedule (exists), Knowledge limit (exists), **AI analysis**, **Defaults for projects**, Approval (exists).
- **AI analysis**: provider select (OpenAI, Anthropic, Google); API key field (write-only; after saving the page shows "Key saved, ends in …abcd" and a Remove button); per-role model: four rows (Classifier, Miner, Reviewer, Proposer) each with a provider select and a model text field, defaulting to the section provider; **Monthly budget** in USD (default 10, 1–1000) with "Spent this month: $0.00" from `llm_calls`. One honest line: "Analysis is not switched on yet. Your key and choices are stored for when it is; nothing is sent to any provider today."
- Keys are stored in `harness/data/llm-keys.json` (0600), never in SQLite, never returned by any route (only `has_key` and the last four characters).
- **Defaults for projects**: Max active rules per project (default 12, 1–50).

## 5. Projects: per-project settings
Each project row expands (chevron) to: Max active rules (blank = use default), "Write approved changes automatically" (default on; off = the executor stages but does not execute writes for this project and the card says "Waiting for you to turn on automatic writes for this project").
- `knowledge.ts` compose respects the effective max: when adding a rule would exceed it, the preview carries `over_rules: true` and the Add dialog says "This project already has N active rules. Retire one on the Instructions page first." and disables Add.

## 6. Demo data (removable)
`npm run harness:demo -- --add` inserts, for the first allowed project: two extra improvements (one pending, one written), three knowledge versions with realistic changed text (written), one skill snapshot "deploy-checklist", all tagged with `demo` in `actor` / `fetched_by` / `provenance` / `reason` / `title` so `--remove` deletes exactly them and nothing else. The Instructions page shows a small "Demo data is loaded" notice with the remove command when any demo row exists. Real rows are never modified.

## 7. Data layer (migration v8)
- `settings` keys added: `llm_provider` ("openai"), `llm_models` (JSON: `{ classifier: {provider, model}, … }`), `llm_monthly_budget_usd` ("10"), `max_active_rules` ("12").
- `project_settings(project_id TEXT PRIMARY KEY, max_active_rules INTEGER NULL, auto_write INTEGER NOT NULL DEFAULT 1, updated_at)`.
- `llm_calls(id, role, provider, model, tokens_in, tokens_out, cost_usd, created_at)` — empty until analysis ships; the budget line reads from it.
- Executor `executeWrites` skips projects with `auto_write = 0` (workspace writes unaffected).

## 8. Out of scope (still)
Running the LLM analysis; running tests in temporary copies; writing Skills.
