import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

export const Route = createFileRoute("/oauth/callback")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Connecting Lovable — Harness Ledger" },
      { name: "description", content: "Completing the Lovable account connection." },
      { property: "og:title", content: "Connecting Lovable — Harness Ledger" },
      { property: "og:description", content: "Completing the Lovable account connection." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: OAuthCallback,
});

function OAuthCallback() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const state = params.get("state");
    const remoteError = params.get("error_description") ?? params.get("error");
    if (remoteError) {
      setError(remoteError);
      return;
    }
    if (!code || !state) {
      setError("Missing code or state in the callback URL.");
      return;
    }
    fetch("/api/public/lovable/oauth-callback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, state }),
    })
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
        if (!res.ok || !body.ok) throw new Error(body.error ?? `Callback failed (${res.status})`);
        navigate({ to: "/projects", search: { connected: 1 }, replace: true });
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [navigate]);

  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <div className="max-w-md space-y-2 text-sm">
        <h1 className="text-xl font-semibold">Connecting Lovable…</h1>
        {error ? (
          <p className="text-destructive">Error: {error}</p>
        ) : (
          <p className="text-muted-foreground">Finishing the connection.</p>
        )}
      </div>
    </main>
  );
}
