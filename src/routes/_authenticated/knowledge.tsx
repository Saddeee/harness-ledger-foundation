import { createFileRoute, redirect } from "@tanstack/react-router";

// The Knowledge page moved to /instructions (spec 2026-09-11 Round 3 §1),
// alongside its "What changed" history view. The route stays so old links
// and bookmarks still land somewhere.
export const Route = createFileRoute("/_authenticated/knowledge")({
  beforeLoad: () => {
    throw redirect({ to: "/instructions", replace: true });
  },
});
