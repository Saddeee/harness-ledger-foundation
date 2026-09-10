import { createFileRoute, Link, Outlet, redirect, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { SETTINGS_DEFAULTS } from "@/lib/settings-defaults";
import { Button } from "@/components/ui/button";
import {
  HOW_IT_WORKS_EVENT,
  runtimeQueryOptions,
  setHowItWorksDismissed,
} from "@/lib/improvements-client";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/login" });
    return { user: data.user };
  },
  component: AuthedLayout,
});

const NAV = [
  { to: "/overview", label: "Overview" },
  { to: "/inbox", label: "Inbox" },
  { to: "/ledger", label: "Improvements" },
  { to: "/projects", label: "Projects" },
  { to: "/scoreboard", label: "Scoreboard" },
  { to: "/versions", label: "Versions" },
  { to: "/settings", label: "Settings" },
  { to: "/demo", label: "Demo" },
  { to: "/jobs", label: "Jobs" },
] as const;

// The local runtime is a single-user tool for deciding on improvements; the
// hosted-era screens (projects, scoreboard, versions, demo, jobs) stay
// reachable only in the hosted preview.
const LOCAL_NAV = new Set<string>(["/overview", "/inbox", "/ledger", "/settings"]);

async function seedSettings(userId: string) {
  const rows = Object.entries(SETTINGS_DEFAULTS).map(([key, value]) => ({
    owner_user_id: userId,
    key,
    value: value as never,
  }));
  await supabase.from("settings").upsert(rows, {
    onConflict: "owner_user_id,key",
    ignoreDuplicates: true,
  });
}

function AuthedLayout() {
  const { user } = Route.useRouteContext();
  const navigate = useNavigate();
  const runtime = useQuery(runtimeQueryOptions);
  // Undefined while loading -> treated as hosted, so nothing flashes away.
  const mode = runtime.data?.mode;
  const items = mode === "local" ? NAV.filter((n) => LOCAL_NAV.has(n.to)) : NAV;

  useEffect(() => {
    if (user?.id) void seedSettings(user.id);
  }, [user?.id]);

  return (
    <div className="flex min-h-screen bg-background">
      <aside className="w-56 shrink-0 border-r bg-muted/30 p-4">
        <div className="mb-6 text-sm font-semibold">Harness Ledger</div>
        <nav className="flex flex-col gap-1">
          {items.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className="rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
              activeProps={{ className: "bg-accent text-foreground font-medium" }}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="mt-6 border-t pt-4">
          {mode === "local" ? (
            <button
              type="button"
              className="mb-3 text-xs text-primary underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => {
                setHowItWorksDismissed(false);
                window.dispatchEvent(new Event(HOW_IT_WORKS_EVENT));
                navigate({ to: "/overview" });
              }}
            >
              How Harness works
            </button>
          ) : null}
          <p className="mb-2 truncate text-xs text-muted-foreground">{user?.email}</p>
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={async () => {
              await supabase.auth.signOut();
              navigate({ to: "/login", replace: true });
            }}
          >
            Sign out
          </Button>
        </div>
      </aside>
      <main className="flex-1 p-8">
        <Outlet />
      </main>
    </div>
  );
}
