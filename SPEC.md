# Harness Ledger — canonical product behaviour (checkpoint 2026-09-18)

This file states what the product does and promises. Where it and the code disagree, the code is wrong and
`VERIFICATION.md` says which claims are verified. Older design notes live under `docs/superpowers/specs/`.
Nothing in this file may be quoted in UI copy under the names "SPEC.md" or "checkpoint".

## 0. Boundaries for this checkpoint

No Lovable credit is spent, no Lovable project is created, remixed, deleted or chatted with, no Knowledge or
Skill is written, no replay runs, nothing is merged to main, nothing is republished. Read-only Lovable
inspection is allowed only when needed and free. Every paid or remote-mutating action needs the owner's
explicit approval.

## 1. What Harness Ledger is

Harness Ledger turns the corrections a user gives Lovable into versioned Knowledge and Skills, then collects
evidence about whether those instructions still deserve to remain.

The loop: Correction → learning → choose Knowledge, Skill, both, or neither → suggestion → edit or approve →
optional historical replay or comparison → apply → version → observe later relevant builds → keep, revise,
move, disable, retire, or restore.

Two Lovable primitives are managed:

- **Knowledge** for concise, stable, broadly relevant, always-available instructions (project or workspace).
- **Skills** for procedures, multi-step work, task-category-specific instructions, checklists, task-specific
  verification, or anything that would add Knowledge weight.
- **Knowledge trigger plus Skill** when a one-line reminder should point to a detailed workflow.

Skills are a core part of the product. Today: reading and versioning workspace Skills, proposing and locally
managing Skill drafts (propose, edit, approve, version, retire, restore a revision). Creating or changing a
Skill in Lovable is not wired yet and the UI, README and landing page say so (DECISIONS.md D4).

## 2. Modes

- **Ask me first** (default): Harness Ledger syncs, analyses, identifies corrections, proposes Knowledge and Skills,
  observes live rules and recommends. It asks before anything consequential: spending credits, writing
  Knowledge, creating or updating Skills, retiring, restoring, workspace-wide instructions.
- **Automatic**: performs only actions explicitly allowed, within project allowlists, ownership, per-action
  permissions, evidence thresholds, credit and token budgets, frequency limits, versioning, audit, rollback and
  a kill switch (the mode setting itself). Retirements and Skill changes are never automatic.

"More capable models may improve automation, but autonomy is earned through observed reliability, not
assumed from the model name."

## 3. Vocabulary

| Word | Meaning |
|---|---|
| Sync | Fetching chats, Knowledge and Skills from Lovable into local SQLite. No model. |
| Analysis | The model step on "Analyse now": Classifier, Rule writer, Judge. Incremental. |
| Reanalyse history | A separate, scoped, estimated, confirmed analysis that may revisit older records and never overwrites a human decision. |
| Suggestion | A proposed instruction the user has not decided on. |
| Rule | An accepted instruction (in Knowledge, or the Knowledge line of a Skill-bound suggestion). |
| Skill proposal | A draft SKILL.md kept and versioned locally. |
| Historical replay | One new Lovable build of the original request from the pre-request state with reconstructed Knowledge plus the candidate, next to the historical result. |
| Paired comparison | Two fresh builds (control without the rule, treatment with it). Not implemented. |

## 4. Evidence levels

- **Historical result**: the build that actually happened. Shown via a free remix copy of that commit. No
  new build.
- **Historical replay** (implemented): Version A = Historical result; Version B = Replay with rule. One new
  build. Question: "Would the original correction still be needed in the replay?" Answers Yes / No /
  Unclear per correction. Conclusions: historical_support, not_supported, possibly_harmful, inconclusive.
  Never called proof or a paired comparison.
- **Paired comparison** (planned): Fresh control without rule, Fresh treatment with rule; the only intended
  difference is the candidate. Two new builds. Stronger because both arms share today's Lovable environment.
- **Repeated paired evidence** (planned): more than one paired comparison supporting the same instruction.

## 5. Replay environment record

For every replay (and every arm of a future comparison) Harness Ledger records and shows: Code state, Project
Knowledge (source: exact_historical / nearest_earlier_version / current_fallback / unavailable, chosen from
the snapshot history by effective time, never silently from today), Workspace Knowledge (today's,
uncontrolled), Skills (today's, uncontrolled), Chat history (not copied), Candidate rule, Other active rules
(kept from the historical block; the candidate is the only addition), Uncontrolled context (Lovable project
memory, workspace Knowledge, Skills, builder version).

Quality labels: controlled (unreachable today), partially_controlled (paired comparison with historical
Knowledge), historical_approximation (any historical replay, or present-day Knowledge), not_comparable
(historical code state unavailable). Uncontrolled context is never hidden.

## 6. Test resources and cost

Each historical replay creates one copy that receives a build and, by default, one free copy of the
historical result. Screenshots are captured after the build and kept after a copy is deleted. Copies stay
until the user deletes them (setting "Keep test builds as projects", default on); failed runs always delete
their copies; a failed delete sets the copy private and leaves a note. Only copies registered on the run can
be deleted; the source project is never chattable, deletable or written by the runner.

Cost sentence: "Creating project copies currently uses no Lovable builder credits. Running a Lovable build
in a copy consumes normal builder credits." Costs are recorded from Lovable's own figure.

## 7. Managed Knowledge block

```
<!-- harness:start -->
## Instructions managed by Harness Ledger
<!-- Manage this section in Harness Ledger. Manual edits cause a conflict and are never overwritten automatically. -->
- ...
<!-- harness:end -->
```

Write sequence: read remote fresh → compare (whole-content hash, then the block by its bullet lines) → stop
if the block changed externally → preserve everything outside the block byte-for-byte → compose → write →
read back → confirm exact match → the version record moves from pending to written (or stale / failed).
Blocks written under earlier headings are recognised as Harness Ledger's own. Removing the last rule removes the
whole block.

## 8. Sync and analysis

Sync is incremental (stop at first known message, parked cursors, content-hash dedupe of Knowledge and Skill
snapshots). Analysis processes only new or changed messages, unclassified follow-ups, corrections without
suggestions, builds not yet observed against relevant rules. Each model call receives a recorded context
packet (current message, task's initial request, latest Lovable reply, previous task messages, live rules,
Skill names, older relevant messages by term match) with reasons, size, truncation and omitted items.
`automatic_analysis_after_sync` is a separate setting, default off; hourly Sync never triggers paid analysis
unless it is on. Reanalyse history is scoped and estimated, and a disagreement with a human decision opens a
review item instead of overwriting.

## 9. Rule usefulness

Signals are tracked separately: applicability, instruction availability, explicit reference, behavioural
compliance (Judge), predicted issue observed, repeated correction, human acceptance, usefulness decision,
historical replay evidence, paired-comparison evidence. The user question is "Is this rule still useful?"
with Keep / Review / Retire / Not sure. Copy says what was observed ("Harness Ledger found the same issue in all 3
relevant builds.") and what the AI judged ("AI review marked the rule as not followed in 3 of 3 relevant
builds.") without causal claims. No applicable task for 60 days opens "Review for relevance" (Keep /
Archive / Move to Skill / Retest / Retire), never automatic retirement. An opposite request is classified
(one_task_exception, temporary_override, project_specific_override, permanent_preference_change,
genuine_contradiction, unclear); only the last two question a standing rule.

## 10. Interfaces

- Web UI: Inbox, Suggestions, Instructions, History, Tests, Skills, Projects, Settings, judging page.
- Harness Ledger MCP: the same actions with the same permissions as the UI (DECISIONS.md D5). "Lovable MCP lets
  Harness operate Lovable. Harness Ledger MCP lets your agent operate Harness Ledger."
- CLI: connect, status, once, analyse, disconnect.

## 11. Privacy

Synced project data is stored locally. During analysis, selected chat, build, Knowledge and Skill context is
sent only to the AI provider the user configured. During a replay, the historical prompt and configured
instruction context are sent to Lovable inside temporary project copies. Harness Ledger does not operate its
own remote analysis service. Lovable tokens and provider keys live in restricted local files, never in
SQLite or logs.

## 12. Hosted status

The Lovable operations Harness needs are available through Lovable's MCP and API surfaces. The current
limitation is hosted authorization: the hosted prototype could not complete an approved
application-to-Lovable sign-in flow, while the local runtime can authenticate through a localhost callback.
Harness therefore runs its operational workflow locally today. The Lovable-hosted application remains the
hosted product preview and preserves the hosted adapter for a future approved authorization path.
