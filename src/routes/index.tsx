import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Harness Ledger — Builder agent improvement ledger" },
      {
        name: "description",
        content:
          "Harness Ledger mines your Lovable project history, proposes evidence-backed rules and skills, and proves them with replays.",
      },
      { property: "og:title", content: "Harness Ledger" },
      {
        property: "og:description",
        content: "Evidence-backed knowledge and skills management for your Lovable workspace.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Index,
});

function Index() {
  const navigate = useNavigate();

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      navigate({ to: data.session ? "/inbox" : "/login", replace: true });
    });
  }, [navigate]);

  return (
    <main className="flex min-h-screen items-center justify-center">
      <h1 className="text-2xl font-semibold">Harness Ledger</h1>
    </main>
  );
}
