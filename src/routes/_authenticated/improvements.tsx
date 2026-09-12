import { createFileRoute, redirect } from "@tanstack/react-router";

// The Improvements page moved to /ledger (spec 2026-09-12 Round 5 §1).
// The route stays so old links and bookmarks still land somewhere.
export const Route = createFileRoute("/_authenticated/improvements")({
  beforeLoad: () => {
    throw redirect({ to: "/ledger", replace: true });
  },
});
