import { createFileRoute, redirect } from "@tanstack/react-router";

// Round 8 Task 3 (review item 5): Overview merged into the Inbox -- its
// primary next action and its "Status and budgets" fold both moved there
// (src/routes/_authenticated/inbox.tsx), so this page has nothing left of
// its own to show. The route stays so old links and bookmarks still land
// somewhere, same shape as suggestions.tsx.
export const Route = createFileRoute("/_authenticated/overview")({
  beforeLoad: () => {
    throw redirect({ to: "/inbox", replace: true });
  },
});
