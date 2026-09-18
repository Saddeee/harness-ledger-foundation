# Demo fixture plan — Nordic Booking Desk

A written plan for a new real Lovable project used to demonstrate Harness Ledger end to end. **Nothing in
this plan has been executed.** Every step below that touches Lovable costs credits or mutates a Lovable
resource and needs the owner's explicit go-ahead at that step. Record every prompt, every cost and every rerun
in `build-log.md` as it happens.

## 0. Preconditions (no credits)

1. The owner's dev server runs the current `local-harness-dev` build (restart after `npm run harness:build`).
2. Demo data is not loaded (`npm run harness:demo -- --status` says none).
3. Lovable is connected (Projects page shows "Connected").
4. AI provider configured (Settings › AI analysis; Claude Code / sonnet is what the owner used).
5. Settings: Decision mode **Ask me first**; Keep test builds as projects **on**; Lovable credit budget set to
   the session cap the owner chooses (suggested 15); token budget default.
6. Before the project exists, sync once and note in the log:
   - **Workspace Knowledge** as it is (Instructions page › All your projects). It must be empty or unrelated to
     currency, casing, forms or login. If it mentions any of those, ask the owner to move that text out first.
   - **Workspace Skills** as they are (Skills page). Note their names. None may be about booking forms.
7. Do not change currency, casing, form or login preferences anywhere in Lovable during the demo other than
   through the corrections below.

## 1. Create the project (credits: initial build, expected 3–6)

Lovable project name: **Nordic Booking Desk** (workspace `937baaeb85dfcb22e8b2`).

Initial prompt, verbatim:

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

Expected: a dashboard with prices most likely in `$` or plain numbers, mixed-case labels, a create form, a
/login route. Record the cost Lovable reports for the first message.

Then: Projects page → allow **Nordic Booking Desk** → Sync now. Confirm the initial request appears in History
as one task episode. Do not analyse yet.

## 2. Knowledge correction: currency (credits: one small build, expected 0.5–1.5)

Prompt to Lovable, verbatim:

```
Use Swedish kronor for every customer-facing price. Format amounts as whole numbers followed by 'kr', for example '1 250 kr'.
```

Wait for the build. Sync now. **Analyse now.**

Expected suggestion (Rule writer wording will differ slightly; accept if the meaning matches):

> Display customer-facing prices in Swedish kronor using the format '1 250 kr' unless another currency is
> explicitly requested.

Expected destination: **Knowledge** with a reason like "a short standing preference that should be available
on every relevant request"; alternative: Skill.

Decision: **Add to this project.** Confirm on Instructions that it is written (status line "Written to
Lovable …") and that the Knowledge in Lovable holds the managed block with the new heading and note.

Stop condition: if Analyse now proposes nothing, check the classification of the correction message on the
Suggestions page; if it was classified as a new task, note it, and ask the owner before re-running analysis.

## 3. Later test task (credits: one build, expected 0.5–1.5)

Prompt to Lovable, verbatim:

```
Add a cancellation-fee amount to each cancelled booking and include it in the summary card.
```

Expected: fee shown in kronor because the rule is live. Sync now → Analyse now → the Judge should record
"followed" for the currency rule on this episode. Check the Instructions page for the rule's observed line:
"AI review marked the rule as followed in 1 of 1 relevant builds." with a quote.

This episode is the **replay fixture**. Do not run the replay here; see §7.

## 4. Sentence-case correction (credits: one small build, expected 0.5–1)

Prompt, verbatim:

```
Use sentence case for all labels, headings, buttons, and messages. Do not write user-facing copy in all lowercase.
```

Sync → Analyse. Expected suggestion: a Knowledge rule about sentence case. Add to this project. Confirm the
block now holds two bullets in id order.

## 5. Skill correction (credits: two builds, expected 1.5–3)

Prompt 1 (task), verbatim:

```
Add an edit-booking flow so an existing booking can be opened and changed.
```

Wait. Then prompt 2 (correction), verbatim:

```
When adding or editing a booking, reuse the existing booking fields, validation, shared components, loading behavior, and error states. Do not create a separate form pattern.
```

Sync → Analyse. Expected suggestion with destination **Skill** (or **Knowledge + Skill** with a one-line
Knowledge reminder "For booking form changes, follow the modify-booking-forms-consistently Skill.") and a
Skill draft close to:

```
# Modify booking forms consistently

1. Inspect the existing create-booking form.
2. Reuse existing field components and layout.
3. Reuse the current validation schema.
4. Preserve phone, price, date, and status formatting.
5. Keep loading and error states consistent.
6. Verify both create and edit flows.
```

Decision: review the draft on the suggestion, edit if needed, **Approve**. The Skills page then lists it under
"Proposed by Harness Ledger" with the line that it is not in Lovable yet. This is the honest state of the
product: the Skill exists locally with versions; creating it in Lovable is the next paid step (§9).

If the Rule writer recommends Knowledge instead: use "Change destination" → Skill, which creates the draft
from the rule; say on the demo that the user is in control of the primitive.

## 6. Later Skill test task (credits: one build, expected 0.5–1.5)

Prompt, verbatim:

```
Add a duplicate-booking action that opens the booking form with the customer and service fields copied.
```

Expected: because the Skill is not in Lovable, Lovable may or may not reuse the form. Sync → Analyse. Either
outcome is recorded honestly: if a new form pattern appears, correct it in the chat and let Harness observe
the repeat correction ("Harness found the same issue in 1 relevant build."). This is the argument for wiring
Skill creation next.

## 7. Historical replay of the currency rule (credits: one build, expected 0.5–1.5)

On the currency suggestion, press **Test this rule** with "Also copy the historical result" on. The replay
copies the project as it was before the §3 request (cancellation fee), puts the historical Knowledge of that
moment plus the candidate in the copy (Project Knowledge source should read **nearest earlier version** or
**exact version**, never "today's Knowledge"), and sends the §3 prompt.

Expected observations on the judging page:
- Historical result: fee in kronor (the rule was live when §3 ran).
- Replay with rule: fee in kronor.
- Environment: Project Knowledge = nearest earlier version; Workspace Knowledge, Skills, memory = today;
  quality = historical approximation.
- Verdict: "Would the original correction still be needed in the replay?" → No, for the currency correction.

Note for the demo: this replay shows the rule being followed again, which is weak evidence (both the
historical and the replay build had the rule). A stronger replay picks the §1 → §2 pair: test the currency
rule against the **§2 correction's own episode** (the initial build request). That replay rebuilds the whole
dashboard (cost 3–6) with the rule in place: expect kronor without the correction. Choose one, record the
choice.

## 8. Behavioural candidate (no credits; explanation only)

Candidate: "Keep the existing /login route and unauthenticated redirect behavior unless I explicitly ask to
change them." Add it as a Knowledge rule if the owner wants it live. On the demo, explain why the screenshot
of a replay cannot show whether /login and the redirect still work: only a behavioural check (open /login,
sign in, expect redirect) can, and that is on the roadmap. Do not claim the rule was observed.

## 9. First paid Skill write (needs a separate go-ahead; not part of the demo run)

`create_workspace_skill` via Lovable MCP with the approved draft, named `modify-booking-forms-consistently`.
Verify with `list_workspace_skills` that the content matches; then rerun §6's task in a copy to see the
difference. Blast radius: workspace-wide. Record before/after Skills list.

## 10. What to do when results disagree with expectations

- **Both historical and replay show the corrected behaviour** (as in §7): the replay does not show the rule
  was necessary. Say so. Prefer the §1→§2 pair.
- **Both show the uncorrected behaviour**: the rule did not change Lovable's output in this replay. Record
  "not supported" and keep the rule for observation; do not rewrite the result.
- **Replay fails** (copy step, build timeout): record the error, do not press "Try again" more than once
  without the owner; failed copies are deleted automatically.
- **Analyse proposes a different destination or wording**: keep what it proposed in the log; use the UI
  controls (edit wording, change destination) on camera rather than re-running analysis.
- **Lovable's message list lags** (about 20 s after a chat): sync again before analysing.

## 11. Credit range

| Step | Builds | Expected credits |
|---|---|---|
| 1 initial | 1 | 3–6 |
| 2 currency | 1 | 0.5–1.5 |
| 3 cancellation fee | 1 | 0.5–1.5 |
| 4 sentence case | 1 | 0.5–1 |
| 5 edit flow + correction | 2 | 1.5–3 |
| 6 duplicate action | 1 | 0.5–1.5 |
| 7 replay | 1 | 0.5–1.5 (or 3–6 for the §1→§2 replay) |
| Total | 8 | about 7.5–16 (up to about 20 with the larger replay) |

Basis: measured costs on Quick Tip Calculator (0.3–0.8 per small build) and Lumble (2.3 for a larger build).
Set the session cap accordingly; Harness refuses replays over the monthly budget.

## 12. Fixture integrity checklist

- [ ] Initial Workspace Knowledge captured and unrelated
- [ ] Enabled Skills captured
- [ ] One correction per step, in order; no currency change before §7
- [ ] Exact prompts recorded (copy from this file)
- [ ] Every Lovable cost recorded from Lovable's figure
- [ ] Every rerun disclosed
- [ ] Failed or inconclusive results preserved, never edited
- [ ] No Lovable output edited by hand

## 13. Alternative fixture (proposed, baseline kept)

A simpler variant keeps everything above but drops the /login page from §1 and uses §8's behavioural
candidate only as an explanation. Reason: the login page adds build cost and a Supabase auth setup that can
fail mid-demo without adding evidence Harness can show. Nordic Booking Desk remains the baseline because the
owner asked for it and because the login route is the clearest way to explain the screenshot limitation.
