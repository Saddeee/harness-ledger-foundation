import { createFileRoute, redirect } from "@tanstack/react-router";

// Version history now lives inline with each target on the Knowledge page
// (spec 2026-09-11 §6.1). The route stays so old links and bookmarks still
// land somewhere.
export const Route = createFileRoute("/_authenticated/versions")({
  beforeLoad: () => {
    throw redirect({ to: "/knowledge", replace: true });
  },
});
