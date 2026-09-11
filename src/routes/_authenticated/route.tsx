import { createFileRoute, Link, Outlet, redirect, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { SETTINGS_DEFAULTS } from "@/lib/settings-defaults";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/login" });
    return { user: data.user };
  },
  component: AuthedLayout,
});

// The same six pages in every runtime. Scoreboard, Versions, Demo and Jobs
// stay routable (Jobs is linked from Settings › Advanced) but are not in the
// sidebar until they have content.
const NAV = [
  { to: "/inbox", label: "Inbox" },
  { to: "/ledger", label: "Improvements" },
  { to: "/instructions", label: "Instructions" },
  { to: "/skills", label: "Skills" },
  { to: "/projects", label: "Projects" },
  { to: "/settings", label: "Settings" },
] as const;

// Kept as a constant so the <Link to="/"> tag stays on one line: it is a
// pure landing-page link, not a runtime-dependent nav item.
const HOW_IT_WORKS_LINK_CLASS =
  "mb-3 block text-xs text-primary underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

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

  useEffect(() => {
    if (user?.id) void seedSettings(user.id);
  }, [user?.id]);

  return (
    <div className="flex min-h-screen bg-background">
      <aside className="w-56 shrink-0 border-r bg-muted/30 p-4">
        <div className="mb-6 text-sm font-semibold">Harness Ledger</div>
        <nav className="flex flex-col gap-1">
          {NAV.map((item) => (
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
          <Link to="/" className={HOW_IT_WORKS_LINK_CLASS}>
            How Harness works
          </Link>
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
