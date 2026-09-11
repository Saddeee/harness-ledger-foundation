import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { HOW_IT_WORKS_STEPS } from "@/lib/harness-ux";

export const Route = createFileRoute("/")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Harness Ledger — turn your Lovable corrections into standing instructions" },
      {
        name: "description",
        content:
          "Harness reads your Lovable chats, proposes one instruction per correction, and adds it to your Lovable Knowledge only when you say so.",
      },
      { property: "og:title", content: "Harness Ledger" },
      {
        property: "og:description",
        content: "Turn the corrections you give Lovable into standing instructions.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Landing,
});

// The only place the product explains itself. Public; a signed-in visitor
// sees the same page with the button pointing at Inbox.
function Landing() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  useEffect(() => {
    supabase.auth
      .getSession()
      .then(({ data }) => setSignedIn(Boolean(data.session)))
      .catch(() => setSignedIn(false));
  }, []);

  return (
    <main className="min-h-screen bg-background px-4 py-16">
      <div className="mx-auto max-w-2xl space-y-10">
        <header className="space-y-3">
          <h1 className="text-3xl font-semibold">Harness Ledger</h1>
          <p className="text-lg text-muted-foreground">
            Harness turns the corrections you give Lovable into standing instructions, so Lovable
            stops making the same mistake.
          </p>
        </header>

        <ol className="space-y-6">
          {HOW_IT_WORKS_STEPS.map((step, i) => (
            <li key={step.title} className="flex gap-4">
              <span
                aria-hidden="true"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-sm font-semibold"
              >
                {i + 1}
              </span>
              <div className="space-y-1">
                <h2 className="text-base font-semibold">{step.title}</h2>
                <p className="text-sm text-muted-foreground">{step.text}</p>
              </div>
            </li>
          ))}
        </ol>

        {signedIn !== null && (
          <div>
            <Button asChild size="lg">
              <Link to={signedIn ? "/inbox" : "/login"}>{signedIn ? "Open Inbox" : "Sign in"}</Link>
            </Button>
          </div>
        )}
      </div>
    </main>
  );
}
