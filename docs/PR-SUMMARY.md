# PR summary: `local-harness-dev` → `main` (prepared 2026-09-19, not merged)

## Product changes

- **Truth checkpoint.** The test feature is a historical replay ("Historical result" / "Replay with rule"), never a
  paired test or proof. Every run records which Project Knowledge the copy started from and how it was chosen,
  keeps the rules that were live at the time, lists uncontrolled context (Lovable project memory, workspace
  Knowledge, Skills, builder version), shows "Evidence strength: Historical approximation", "Why this is an
  approximation", and a derived conclusion (Historical support / Not supported by this replay / Possible
  regression / Inconclusive). Existing runs 1–7 were backfilled.
- **Skills first-class locally.** Suggestions carry a destination (Project Knowledge / Workspace Knowledge /
  Skill / Knowledge and Skill) with a reason; Skill proposals are drafted, edited, approved, versioned, restored
  and retired locally. "Not published to Lovable yet." everywhere; remote Skill writes are not wired.
- **Product surface.** Onboarding (five steps, one primary action, "Use recommended settings"); Overview with
  one next action; Inbox cards with lesson, instruction, destination, reason and one recommended action, each
  action stating whether Lovable, credits or AI tokens are affected; Suggestions detail as a story
  (Requested / Built / Your correction / Changed afterward); Instructions with "Needs your attention" first;
  Skills page (In Lovable / Proposed by Harness Ledger); History with current Knowledge separate from the
  timeline and "Restored Knowledge from version N". Technical details are collapsed, never deleted.
- **Rule usefulness.** "Is this rule still useful?" with Keep / Review / Retire / Not sure; observed repeat
  corrections and AI review reported separately; inactivity opens a relevance review; opposite requests are
  classified before a rule is questioned.
- **Sync and analysis.** Recorded context packets; Reanalyse history (scoped, estimated, never overwrites a
  human decision); `automatic_analysis_after_sync` setting, default off.
- **Providers.** OpenAI parameter compatibility (max_tokens vs max_completion_tokens, temperature omitted where
  unsupported, one corrected retry, redaction) and a "Test provider" action in Settings.
- **Setup.** `npm run setup`, `npm run harness:start` (local runtime, repo-local SQLite, 127.0.0.1).
- **One product name** everywhere a person reads it: Harness Ledger (and Harness Ledger MCP).

- **Inbox is the single decision queue (2026-09-19).** Suggestions left the navigation; the list route
  redirects to Inbox and the detail stays reachable from Inbox and History. Inbox items: New instruction, New
  Skill, Test result, Rule needs attention, Conflict, Action failed — one aggregation (`listInboxItems`) that
  Overview counts too. History gained filters (All / Suggestions / Knowledge / Skills / Tests / Restores) and
  the Inbox links "View past decisions". Cards show one primary action with its consequence line.
- **Rule writer** now follows a minimal-sufficiency principle, returns applicability, exceptions and a scope
  confidence, and downgrades a low-confidence workspace scope to project at proposal time. Existing rules are
  untouched.

## Architecture decision

Local runtime and hosted preview are adapters around shared product logic (`harness/src/adapter.ts`). The
hosted build never imports better-sqlite3 or the local DB path (tested). Harness Ledger MCP calls only the
adapter, so an agent has exactly the app's permissions (budget-parity and ownership tests). Deletion of a test
copy reads back before it is called confirmed. 

## Verified capabilities

See `harness/src/capabilities.ts` (a test fails when a "working" capability has no verification reference).
Working: Lovable local connection, Sync, Analysis, Reanalyse history, Knowledge proposal/write/versioning/
restore, historical replay, rule observation, local Skill proposals, Harness Ledger MCP, setup scripts.
Partial: onboarding (needs visual review), OpenAI compatibility (fake-tested). Planned: paired comparison,
behavioural verification. Blocked: remote Skill write, hosted Lovable execution.

## Limitations

Remote Skill publishing unverified; paired comparison and behavioural checks planned; historical context
reconstructed from Harness Ledger's snapshots only; hosted authorization blocked ("Client Not Found");
diffs/edits not synced; live model output for the new Rule-writer and classifier fields not yet exercised.

## Migration notes

Migrations v18–v22 apply on first start (additive, except rule_verdicts / rule_health rebuilt with every row
kept; verdict values map helped → keep, did_not_help → review; copy_deleted rows become deletion status
"requested"). Back up `harness/data/harness.db` first (the owner's DB was backed up as
`harness.db.bak-checkpoint2-202609181948` and migrated to v21 by the 19:36 UTC restart; v22 applies on the next
start). Restart the dev server after `npm run harness:build`.

## Rollback

`git checkout hosted-foundation-v1` (tag at `3fff0d9`) restores the Lovable-built state; for data, restore
the timestamped `.bak-` copy of the SQLite file (migrations are forward-only). No Lovable resource was
changed by this branch's checkpoints, so nothing remote needs rolling back.

## Demo plan

`DEMO_PLAN.md`: nine visible steps on Nordic Booking Desk (not yet created; about 8–16 credits for the fixture)
with an operator checklist.

## Verification

1014/1013 harness tests (main checkout / fresh clone), both typechecks, lint (0 errors), production build
(no better-sqlite3 in `.output`), hosted-mode and local-mode smoke on spare ports (every page 200), MCP
protocol tests, README link and manifest tests, OpenAI fake tests, migration on a copy of the live DB.
