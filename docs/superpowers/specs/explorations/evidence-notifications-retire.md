# Design Exploration: Evidence Links, Notifications, Retiring Rules

## Overview
Three smaller product gaps addressing user workflows:
(a) **Evidence links** — jump from feedback evidence back to Lovable chat context
(b) **Notifications** — alert when new proposals or test results arrive
(c) **Retiring rules** — remove active rules from Knowledge with staged rollback

---

## (a) Evidence Links Back to Lovable Chat

### Problem
When reviewing evidence (the Lovable messages shown in an improvement card), users cannot navigate back to the original Lovable conversation context to see the broader chat thread or re-read surrounding context.

### Data Available
- `history_items.external_id` = Lovable `message_id` (the unique message in the Lovable conversation)
- `history_items.source_ref` = `edit_id` (which edit within that message, if any)
- Project ID is available in the correction's project context
- Lovable URL pattern from README: `https://lovable.dev/projects/<project_id>`
- Message timestamps already shown (e.g., "Lovable replied · Sep 8")

### Design Options

#### Option A: Deep-link with message/thread ID (Requires Verification)
**Assumption:** Lovable's editor supports URL-based deep-linking to specific messages or threads.
- **URL pattern to verify:** `https://lovable.dev/projects/<id>/chat?message_id=<message_id>` or `?thread_id=<thread_id>`
- **Implementation:** Add "Open in Lovable" button on each MessageBlock (in `improvement.tsx` line 537)
- **UX:** Button appears next to "Lovable replied" header; click opens Lovable editor at that message
- **Fallback:** If deep-linking fails, button links to project chat root; users find message manually by timestamp

#### Option B: Timestamp-Based Navigation (No Verification Needed)
**Approach:** Link to project chat + auto-copy message timestamp to clipboard
- **Implementation:** "Open in Lovable" button → opens `https://lovable.dev/projects/<id>/chat`, then JS copies timestamp (e.g., "2026-09-08 14:32 UTC") to clipboard with toast
- **UX:** User navigates to chat, timestamp already copied, can Cmd+F to find it
- **Advantage:** Works regardless of Lovable's deep-linking capabilities
- **Downside:** Requires manual search; less seamless than direct deep-link

#### Recommended: Hybrid Approach
1. **First:** Try deep-linking pattern from Option A
2. **Fallback:** If Lovable doesn't support it, implement Option B
3. **UI location:** `MessageBlock` component, next to the "Lovable replied" / "You asked Lovable" header
4. **Button text:** "Open in Lovable" (outline button, small size)

### Verification Steps
- Check Lovable API/editor documentation for message-level URL anchors
- Test if `https://lovable.dev/projects/<id>/chat#message_<message_id>` or similar patterns work
- If not, confirm that `https://lovable.dev/projects/<id>` is the stable project chat root

### Related Files
- `/src/components/harness/improvement.tsx` — `MessageBlock` component (line 537)
- `/harness/src/store.ts` — history_item schema with `external_id`, `source_ref` (line 139–195)
- `/README.md` — Lovable editor URL pattern

**Effort: S** (small button + conditional link; verification loop if needed)

---

## (b) Notifications: New Proposals & Test Results

### Problem
Users don't know when new proposals arrive in the Inbox or when experiment results complete without explicitly checking the app.

### Constraints
- **Server unavailable:** No persistent notification backend; local executor + hosted UI separation makes server-push impractical
- **Client-only options:** Browser Notifications API (open tab only), sidebar badge count, unread marker on list items, email via user-provided SMTP/Resend key

### Data Already Present
- Executor polling loop in `schedule.ts` runs every 30 seconds (configurable)
- App already polls executor status via `executorQueryOptions` with 30s stale time
- Events are inserted on every sync run: `executor.sync.history`, `executor.sync.knowledge`, `executor.sync.writes`
- Improvements have `decision.status` (pending/accepted/skipped) and `stage` tracking

### Recommended Minimal Set

#### 1. Sidebar Badge Count
**Data:** `<Inbox count>` badge (e.g., "Inbox 3") on sidebar navigation
- Query: count improvements with `decision.status === 'pending'`
- Update: on each executor poll (stale time 30s)
- **Implementation:** Already fetching improvements; add count display in sidebar `<Link to="/inbox">` badge
- **Files:** `src/layout.tsx` or nav component; uses existing `fetchImprovements()`

#### 2. Unread Marker on Cards
**Data:** Track `last_seen_at` in user settings or localStorage
- New improvements = created after `last_seen_at`
- On Inbox load: update `last_seen_at` to now
- On Improvements page load: update `last_seen_at`
- Display small dot/badge on cards with `created_at > last_seen_at`
- **Implementation:** Add `last_seen_at` setting to harness executor settings table (type `SettingKey` in store.ts line 1390)
- **Files:** `harness/src/store.ts` (add setting), `src/lib/improvements-client.ts` (fetch/update), improvement card component

#### 3. Browser Notification Opt-In (Optional, Phase 2)
**Data:** When new pending improvements exist and app is open
- Request permission once (browser standard flow)
- On Inbox load or new sync: if `last_seen_at < newest.created_at`, fire notification
- **Implementation:** React hook in Inbox page; use Web Notifications API
- **Files:** New hook or inline in Inbox component

### Data & Storage

**New setting (harness/src/store.ts):**
```ts
export type SettingKey = 
  | "last_seen_at"  // ISO datetime when user last viewed Inbox/list
  | ... existing keys
```

**Flow:**
1. User views Inbox → POST `/api/public/harness/settings` with `last_seen_at = now`
2. App fetches improvements → filters for `created_at > user.last_seen_at` → marks as "new"
3. Sidebar badge = count of `decision.status === 'pending'`
4. Browser notification (optional): fires if any new + user has granted permission

### Related Files
- `/harness/src/store.ts` — Settings (line 1390)
- `/src/lib/improvements-client.ts` — `fetchImprovements()`, `postExecutor()`
- `/src/routes/_authenticated/inbox.tsx` — Inbox page (uses `fetchImprovements()`)
- `/src/components/harness/improvement.tsx` — DecisionCard component (would show "new" badge)

**Effort: M** (add setting, track last_seen_at, update card styling, browser notification is optional Phase 2)

---

## (c) Retiring a Rule from Instructions Page

### Problem
Active rules accumulate. Users need to remove one from Knowledge without losing the improvement record, especially when `max_active_rules` is reached. Currently no UI for retiring.

### Data Available
- `rules.state` includes "retired" (unused, never set)
- `activeRulesForTarget()` returns rules where `state IN ('approved','supported','active')`
- Knowledge composition recomposes managed block from active rules
- `max_active_rules` setting caps active rules per project
- Pending writes stage via `createPendingKnowledgeVersion()` with `actor`, `reason`, `rule_id`

### Design

#### UI: Instructions Page Active Rules List
**Current:** Line 275–277 in `instructions.tsx` shows "Rules Harness added" list
**Add:** "Retire" button on each live rule (state approved/supported/active)

```tsx
<button onClick={() => confirmRetire(rule.id)}>Retire</button>
```

#### Confirmation Dialog
**Title:** "Retire this rule?"
**Body:** "Harness will remove this rule from Knowledge and write a new version. The improvement stays in your ledger so you can re-add it later."
**Consequences:** 
- "One active rule slot becomes available" (if at max_active_rules)
- "Knowledge version staged; takes effect at the next sync"
**Confirm label:** "Retire"

#### On Confirm: Data Changes
1. **Rule state:** `updateRule({ id, state: "retired", reason: "retired by user from Instructions page", actor: "operator (local UI)" })`
   - Creates row in `rule_revisions` (previous_state=active, new_state=retired)
   - Inserts event: `rule.updated`

2. **Recompose managed block:**
   - Call `activeRulesForTarget()` → excludes just-retired rule
   - Compose new managed block without it
   - Get latest Knowledge snapshot

3. **Stage pending write:**
   - Call `createPendingKnowledgeVersion({`
     - `rule_id: null` (not tied to a specific rule being added; it's a recomposition)
     - `target: "project"` or `"workspace"` (same as this rule's scope)
     - `previous_content: snapshot.content`
     - `new_content: composed.final_content`
     - `rule_ids: [remaining active rule ids]`
     - `actor: "operator (local UI)"`
     - `reason: "retired rule {rule_id} from Instructions page"`
   - Or: set `rule_id: rule.id` if we want the version tied to the rule's retirement

4. **Improvement group:** Improvement's `groupOf()` logic must handle `rule.state === "retired"`
   - Update `improvementGroup()` in `/src/lib/harness-ux.ts` to return `"Retired"` group
   - Or reuse `"Skipped"` if semantically equivalent (skipped = user's decision to ignore; retired = user removed active rule)
   - **Recommend:** New group "Retired" to distinguish from skipped

#### Follow-Up: Re-adding a Retired Rule
**In Improvements list:** Retired rules show with "Re-add" button
- Click → sets rule state back to "approved" → same flow as "Accept" button
- Stages write to add it back to Knowledge
- Improvement moves back to "Improvements" group

#### Interplay with max_active_rules
- Retiring a rule immediately frees a slot
- Next "Add" becomes possible if previously blocked by limit
- Error message on add (line 501 in improvement.tsx): "already has N active rules — retire one" becomes actionable

### Related Files
- `/src/routes/_authenticated/instructions.tsx` — ActiveRulesList component (line 209); TargetSection (line 239)
- `/harness/src/store.ts` — `updateRule()` (line 608), `activeRulesForTarget()` (line 1158)
- `/harness/src/knowledge.ts` — `composeManagedKnowledge()` (line 56)
- `/src/lib/harness-ux.ts` — `improvementGroup()` function
- `/harness/src/improvements.ts` — `stagePendingWrite()` (line 487), `stageApprovedWrites()` (line 579)

### Task Split (≤4 tasks)
1. **Add retire button & confirmation UI** — Instructions page, dialog copy
2. **Data layer** — updateRule(state: retired), recompose, create pending version
3. **Improvement grouping** — Add "Retired" group in harness-ux, surface in improvement.tsx
4. **Re-add action** — "Re-add" button in improvement card, reverses retirement

**Effort: M** (UI + confirmation, data flow is similar to existing accept/skip patterns)

---

## Summary of Efforts

| Feature | Recommendation | Effort | Task Count |
|---------|---|---|---|
| **(a) Evidence Links** | Deep-link to Lovable message (verify URL pattern); fallback to timestamp-based link | **S** | 1 |
| **(b) Notifications** | Sidebar badge + unread marker + optional browser notifications | **M** | 2 (core) + 1 (optional) |
| **(c) Retiring Rules** | "Retire" button on Instructions page; recompose knowledge; stage pending write; "Retired" improvement group | **M** | 4 |

---

## Implementation Order
1. **(a) Evidence links** — Unblocks no other work; quickest win; verify Lovable deep-linking capability first
2. **(c) Retiring rules** — Enables workflow; no external dependencies; increases UI completeness
3. **(b) Notifications** — Improves UX but not blocking; Phase 2 expansion to browser notifications if time permits

---

## Open Questions for Verification

### (a) Evidence Links
- **Does Lovable support message-level deep-linking?** Check if URLs like `?message_id=<id>` or `#message_<id>` work in the editor.

### (b) Notifications
- **Placement of sidebar count:** Where exactly in the nav? On the Inbox link itself, or in a separate badge area?
- **Browser notifications scope:** Only for pending improvements, or also for state changes (test results, write failures)?

### (c) Retiring Rules
- **New group name:** "Retired" vs. "Inactive" vs. reuse "Skipped"? (Recommend "Retired" for clarity.)
- **Rule history:** Should `rule_revisions` capture retirement separately, or is the state change enough?

