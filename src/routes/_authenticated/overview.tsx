import { createFileRoute, redirect } from "@tanstack/react-router";

// Overview was folded into Inbox (spec 2026-09-11). The route stays so old
// links and bookmarks still land somewhere.
export const Route = createFileRoute("/_authenticated/overview")({
  beforeLoad: () => {
    throw redirect({ to: "/inbox", replace: true });
  },
});
