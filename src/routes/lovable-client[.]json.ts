import { createFileRoute } from "@tanstack/react-router";

// OAuth client metadata document; its URL is the client_id.
export const Route = createFileRoute("/lovable-client.json")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { clientMetadata } = await import("@/lib/server/app-origin");
        return new Response(JSON.stringify(clientMetadata(request)), {
          headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" },
        });
      },
    },
  },
});
