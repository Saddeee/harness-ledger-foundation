# Simple decision UX for Harness Ledger

Date: 2026-09-11. Status: approved by the product owner in chat.

## Goal

Harness Ledger asks a Lovable user one question, repeatedly: *"Lovable got this
wrong and you corrected it. Should that correction become a standing
instruction, and where?"* Every screen serves that question. Fewer things on
screen is better. A public landing page teaches the three words the app then
uses everywhere: **found, add, skip**.

## Problems in the current UI

1. No landing page. `/` redirects to login or Overview. The product only
   explains itself in a dismissable card on Overview.
2. Pages appear "removed". `LOCAL_NAV` in `_authenticated/route.tsx` hides
   Projects, Scoreboard, Versions, Demo and Jobs in local mode.
3. The user cannot decide in the Inbox. A decision takes: open card -> pick
   destination (3 buttons, 1 permanently disabled) -> Add -> confirm.
4. The detail page shows ~10 blocks, including a disabled "Run proof" and a
   nested developer accordion, where a third would do.
5. Nav differs between runtimes (9 items hosted, 4 local); 3 items are empty.

## Design

### 1. Landing page (`/`, public)

- Anonymous visitors see one calm page in the app's existing shadcn style,
  no marketing fluff:
  - Heading: "Harness Ledger". One sentence: Harness turns the corrections
    you give Lovable into standing instructions, so Lovable stops making the
    same mistake.
  - Three steps, reusing `HOW_IT_WORKS_STEPS` wording where it fits:
    1. **Found** - Harness reads your Lovable chats and spots where you
       corrected Lovable.
    2. **Add or skip** - It proposes one instruction per correction. You add
       it to this project's Knowledge, to all your projects, or skip it.
    3. **Nothing changes until you say so** - Reviewing never uses Lovable
       credits. You see the exact text before it is written and can restore
       the previous version.
  - One primary button "Sign in" (-> `/login`). Nothing else.
- A signed-in visitor hitting `/` is redirected to `/inbox`.
- The sidebar link "How Harness works" links to `/` (works in both runtimes).
- The "How Harness works" card and its dismissed-state localStorage logic are
  removed from the app. `HOW_IT_WORKS_STEPS` stays in `harness-ux.ts` and is
  rendered by the landing page.

### 2. Navigation

- Sidebar, identical in local and hosted runtime:
  Inbox, Improvements, Projects, Settings.
- `LOCAL_NAV` filtering is deleted.
- `/overview` route is removed; `/login` and `/` redirect signed-in users to
  `/inbox`. Any `to: "/overview"` becomes `to: "/inbox"`.
- The Overview "Next up" logic becomes an optional one-line header on Inbox
  (see 3). The hosted-only credit/queue cards move to Settings under an
  "Advanced" section together with a link to `/jobs`.
- Scoreboard, Versions, Demo stay routable but leave the nav (empty pages).
  Jobs stays routable, reachable from Settings > Advanced.

### 3. Decision card (shared by Inbox and Improvements)

One component, `DecisionCard`, in `components/harness/improvement.tsx`,
replacing `ImprovementCard`:

```
[Project name]                                  [status chip, decided items only]
Title (one sentence, what you corrected)
"Proposed instruction" (blockquote, full text)
[Add to this project] [Add to all my projects] [Skip]       Details ->
```

- Pending items show the three buttons. "Add..." opens the existing
  `AddConfirm` dialog (exact-text preview, over-cap guard, no-snapshot
  variant). "Skip" opens the existing `SkipConfirm`.
- The Skill option and "Decide later" are removed from the UI. The deferred
  localStorage helpers and the "Decide later" group are removed.
- Decided items (Improvements page) show the chip from `improvementGroup`
  and the one-line `lovableStatusLine`. Where a change is still possible
  they show the same buttons under a collapsed "Change decision":
  accepted-not-written -> the other destination + Skip;
  accepted-written -> "Restore previous version";
  skipped -> "Reopen".
- "Details" opens the detail view (`?improvement=<id>` on the same page).
- After a successful Add from the Inbox list the card leaves the Inbox and a
  toast says "Added - see Improvements" (SAVED_LINE wording kept).

### 4. Inbox page

- Heading "Inbox". If there are pending items, one line below it:
  "N improvements are waiting for your decision." (the old Next-up text).
- The list of `DecisionCard`s for pending items.
- Empty states unchanged.

### 5. Improvements page

- Heading "Improvements". Groups from `IMPROVEMENT_GROUPS` minus
  "Decide later": Waiting to be added, Proof in progress, Proof done,
  In Lovable, Needs attention, Skipped. Non-empty groups only. Filter
  control unchanged (shown when > 5 items).
- Each item is a `DecisionCard` in decided mode (see 3). The separate
  "Restore previous version" button under In Lovable items moves into the
  card's "Change decision".

### 6. Detail view (both pages, `?improvement=<id>`)

Three blocks, in order:

1. Back link, then the `DecisionCard` for this item (same buttons, same
   behaviour). Under the card: "Change the wording" (existing editor) and the
   `whyFor` line.
2. "What happened" - the chat evidence (`MessageBlock`s), unchanged.
3. One collapsed `<details>` "Details" containing: the stage bar
   (`ProcessProgress`), "How Harness read this", wording history, Knowledge
   versions, and the Developer view (unchanged markup inside).

Removed from the detail view: the "Prove it first" section with the disabled
"Run proof" button, and the "How Harness would prove this" section. They
return when proof can run. `PROVE_INTRO` / `proveCostLine` stay exported in
`harness-ux.ts` (tested, harmless).

The divergence notice and the "Waiting for Harness to read your current
Knowledge" hint stay, shown directly under the card.

### 7. Copy rules (unchanged)

- No internal vocabulary outside the Developer view.
- "Lovable credits" appears at most twice on the detail page; "Harness
  analysis" exactly once.
- Never claim something was added to Lovable without a verified write.

## Out of scope

- Proof execution, Skills, Scoreboard/Versions/Demo content.
- Any change to `harness/` data layer or the API routes. The UI keeps
  posting the same actions (`accept`, `skip`, `reopen`, `restore`,
  `change_wording`).
- Visual redesign beyond shadcn defaults.

## Testing

- `harness/test/ux.test.ts` is updated to pin the new contract: nav items,
  landing page steps, decision card buttons, detail order, removed sections,
  no `LOCAL_NAV`, no "Decide later", no disabled "Run proof".
- Existing pure-function tests (`improvementGroup`, `lovableStatusLine`,
  etc.) keep passing; "Decide later" is removed from `IMPROVEMENT_GROUPS`
  and its test expectation.
- `npm run typecheck` and `npm run lint` pass. `npm run build` passes.
- Manual check with `HARNESS_RUNTIME=local`: add and skip from the Inbox
  list without opening a card; the item moves to Improvements.
