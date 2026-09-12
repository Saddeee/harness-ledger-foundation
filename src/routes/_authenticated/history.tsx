import { createFileRoute } from "@tanstack/react-router";

// Placeholder for Round 5 Task 4. Task 2 adds the History nav link.
// This will be replaced by the full history page implementation.
export const Route = createFileRoute("/_authenticated/history")({
  component: Page,
});

function Page() {
  return <p>History</p>;
}
