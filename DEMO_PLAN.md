# Demo fixture — Nordic Booking Desk

The demo project exists. Lovable named it **Simple Bookings** (project `01ed3717-3703-4cbd-9c61-0647100fd5c8`,
workspace `937baaeb85dfcb22e8b2`); the app calls the business "Salong Nova". This file records what was actually
done on 2026-09-19, where it deviates from the original plan, and the visible demo built on it. Every Lovable
cost is Lovable's own figure. Nothing in the results was edited by hand.

## Recommended visible demo

Nine steps, one project, no surprises.

1. Open Simple Bookings in Lovable. Show the chat: initial build, then the sentence-case correction
   ("Use sentence case for all labels…"), the cancellation-fee task, the English-only correction, the
   edit-booking task and the one-form correction.
2. In Harness Ledger: Projects › allow the project; Sync now; Analyse now (progress bar; AI tokens only,
   nothing changes in Lovable).
3. Inbox: two New instruction items. Open the sentence-case one: lesson, destination Knowledge with the Rule
   writer's reason and alternative, one action.
4. Add to this project. Open Lovable's Knowledge: the managed block with one bullet.
5. Instructions, filtered to this project: the rule, "Written to Lovable", the verdict buttons.
6. History: the version, its reason, the collapsed Current Knowledge line, the restore path.
7. Tests: the historical replay of the sentence-case rule. Historical result (uppercase labels), Replay with
   rule (sentence case), verdict "not needed", "Evidence strength: historical approximation" and the
   environment record (Project Knowledge: current fallback; Workspace Knowledge, Skills and builder version
   from today).
8. The one-form suggestion: Change destination → Skill. Edit the draft into the checklist, Approve, then
   Publish to Lovable. Skills page: "In Lovable since …, read back". Open Lovable's workspace Skills to show it.
9. Say what is next: paired comparison and behavioural checks.

## Operator checklist (tick every line before the demo)

- [ ] Database backed up (`harness/data/harness.db.bak-<timestamp>`, opens, integrity ok)
- [ ] Migrations applied (schema version matches `harness/src/migrations.ts`; Settings page loads)
- [ ] Provider test passed (Settings › AI analysis › Test provider)
- [ ] Lovable connected (Projects page shows Connected)
- [ ] Budget configured (Settings › Lovable credits; session cap agreed)
- [ ] Ask me first enabled (Settings › Decisions)
- [ ] No demo seed data (`npm run harness:demo -- --status` says none)
- [ ] Local server restarted after the last build (`npm run harness:start`)
- [ ] Full demo rehearsed once end to end, including the replay page
- [ ] The Lovable link opens the landing page with "Start here" first and "Run it on your computer" as the primary button (published from `main`)

## What was done (2026-09-19, UTC)

| Step | Time | Lovable prompt (verbatim) or action | Cost |
|---|---|---|---|
| 1 | 11:08 | `create_project`, initial prompt below | 1.5 |
| 2 | 11:14 | "Use sentence case for all labels, headings, buttons, and messages. Do not render any user-facing text in all capitals (the summary card labels are currently uppercase)." | 0.8 |
| 3 | 11:18 | "Add a cancellation-fee amount to each cancelled booking and include it in the summary card." | 2.1 |
| 4 | 11:24 | "Keep all user-facing text in English. Do not mix Swedish words into the interface, for example \"Bokningar\" in the header, unless I ask for a Swedish UI. Service names can stay as they are." | 1.4 |
| 5 | 11:30 | "Add an edit-booking flow so an existing booking can be opened and changed." | 2.0 |
| 6 | 11:36 | "When adding or editing a booking, use one form pattern. Reuse the existing booking fields, validation, shared components, loading behavior and error states. Do not keep a separate way to change booking data outside that form: remove the inline status dropdown on each row so status changes go through the same edit flow, with the same validation and the same cancellation-fee handling." | 1.3 |
| 7 | 11:22 | Harness Ledger: allow project, Sync now (12 messages), Analyse now (classified 6, episodes 4, proposed 2, judged 4) | AI tokens |
| 8 | 11:25 | Accept the sentence-case suggestion → this project; Knowledge written and read back (version 47) | 0 |
| 9 | 11:25 | One-form suggestion: Change destination → Skill (local draft created) | 0 |
| 10 | 11:29 | Test this rule (sentence case) → historical replay of the initial build, copy `471cd326-bfe7-4c17-9b90-b80dc6f5a8fb` | 1.5 |
| 11 | 13:56 | Verdict: the correction would not be needed; no regression; feedback recorded | 0 |
| 12 | 11:29 | Edit the Skill draft to `modify-booking-forms-consistently` (checklist below) | 0 |
| 13 | 14:39 | Approve the Skill, then Publish to Lovable: created as `modify-booking-forms-consistently`, read back identical | 0 |
| | | **Total: 10.6 credits of the 20 allowed** | |

Initial prompt (step 1), verbatim:

```
Build a small appointment-booking dashboard for a Swedish service business.

Include:

- a booking list,
- a create-booking form,
- customer name,
- phone number,
- service,
- price,
- appointment date and time,
- booking status,
- a summary card,
- and a simple /login page.

Use a clean and neutral design.
```

Skill content after editing (step 12):

```
# Modify booking forms consistently

Use this when adding, editing or changing the status of a booking, or building any UI that changes booking data.

1. Inspect the existing add/edit booking form before writing new UI.
2. Reuse its fields, field components and layout; do not create a second form pattern.
3. Reuse the current validation schema, including the cancellation-fee rule for cancelled bookings.
4. Keep phone, price, date and status formatting as the form already does it.
5. Keep the same loading and error states.
6. Route status changes through the form; do not add inline controls (for example row status dropdowns) that change booking data outside it, unless the user explicitly asks for a separate quick-edit path.
7. Verify both the add and the edit flow still work.
```

## Deviations from the original plan, and why

- **No currency correction.** The plan expected the first build to show prices in `$`. Lovable's first build
  already formatted prices in kronor (`Intl.NumberFormat("sv-SE", { currency: "SEK" })`). Correcting a
  currency that was already right would have been a fake correction, so it was dropped. The three corrections
  actually given were all real: uppercase summary labels, a Swedish word in the header, and an inline status
  dropdown that bypassed the edit form.
- **The Rule writer proposed Knowledge for both corrections**, including the one-form correction the plan
  hoped would become a Skill. Its reasons are shown on the suggestion ("one rule, not a workflow"). The Skill
  was obtained the way the plan's fallback describes: Change destination → Skill, then edit the generated
  draft. The Rule writer's judgement is kept on record; the user's choice is recorded as chosen by the user.
- **The replay used today's Knowledge, not a historical version.** The initial build happened before any
  Knowledge snapshot existed, so the environment record says Project Knowledge: current fallback. The only
  managed instruction in the copy was the rule under test. The page discloses this.
- **The replay came out in Swedish.** The historical build was mostly English with one Swedish header word;
  the replay wrote the whole interface in Swedish. This is not caused by the sentence-case rule, and the
  English-only correction (step 4) was not part of the test. Recorded in the run's feedback, not hidden.
- **The duplicate-booking task and the behavioural candidate** from the original plan were not run: they
  added credits without adding evidence the product can show today.

## Evidence for the replay verdict

- Historical build: commit `cfc2cd2` (the fix after the sentence-case correction) removes
  `uppercase tracking-wide` from the summary-card label, which shows the initial build had it.
- Replay with rule: the copy's `src/routes/index.tsx` has plain `text-sm text-muted-foreground` labels and no
  `uppercase` class anywhere.
- Conclusion shown on the Tests page: historical support (the correction would not have been needed).

## Credit guidance for a repeat

| Step | Builds | Measured |
|---|---|---|
| Initial build | 1 | 1.5 |
| Small corrections | 3 | 0.8–1.4 each |
| Feature tasks | 2 | 2.0–2.1 each |
| Replay of the initial build | 1 | 1.5 |
| Total | 7 | 10.6 |

Set the in-app monthly budget above the planned spend; Harness Ledger refuses a replay that would exceed it.

## Fixture integrity checklist

- [x] Exact prompts recorded (this file)
- [x] Every Lovable cost recorded from Lovable's figure
- [x] Every deviation disclosed
- [x] Failed or inconclusive results preserved, never edited
- [x] No Lovable output edited by hand
