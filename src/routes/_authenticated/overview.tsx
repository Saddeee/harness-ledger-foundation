import { createFileRoute, redirect } from "@tanstack/react-router";

// Overview was folded into Inbox (spec 2026-09-11). The route stays so old
// links and bookmarks still land somewhere.
export const Route = createFileRoute("/_authenticated/overview")({
  beforeLoad: () => {
    // @ts-expect-error inbox's search validator always returns an "improvement"
    // key (value may be undefined), so TanStack Router treats search as
    // required here even though there is nothing meaningful to pass.
    throw redirect({ to: "/inbox", replace: true });
  },
});
