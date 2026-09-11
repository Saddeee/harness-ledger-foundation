import { createFileRoute, Link, Outlet, redirect, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { SETTINGS_DEFAULTS } from "@/lib/settings-defaults";
import { Button } from "@/components/ui/button";
import { fetchImprovements, pendingCount, isNotifyEnabled } from "@/lib/improvements-client";

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
  const previousPendingIds = useRef<Set<number>>(new Set());

  const improvementsQuery = useQuery({
    queryKey: ["harness-improvements"],
    queryFn: fetchImprovements,
    refetchInterval: 60_000,
  });

  useEffect(() => {
    if (user?.id) void seedSettings(user.id);
  }, [user?.id]);

  useEffect(() => {
    if (!improvementsQuery.data?.improvements) return;

    const currentPendingIds = new Set(
      improvementsQuery.data.improvements
        .filter((item) => item.decision.status === "pending")
        .map((item) => item.id),
    );

    // Don't notify on the first load
    if (previousPendingIds.current.size === 0) {
      previousPendingIds.current = currentPendingIds;
      return;
    }

    // Check if there are new pending items
    const newIds = Array.from(currentPendingIds).filter(
      (id) => !previousPendingIds.current.has(id),
    );

    if (
      newIds.length > 0 &&
      isNotifyEnabled() &&
      typeof Notification !== "undefined" &&
      Notification.permission === "granted"
    ) {
      new Notification("Harness Ledger", {
        body: "A new improvement is waiting for your decision.",
      });
    }

    previousPendingIds.current = currentPendingIds;
  }, [improvementsQuery.data?.improvements]);

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
              <div className="flex items-center justify-between">
                <span>{item.label}</span>
                {item.to === "/inbox" &&
                  improvementsQuery.data?.improvements &&
                  pendingCount(improvementsQuery.data.improvements) > 0 && (
                    <span className="ml-2 rounded-full bg-primary px-1.5 text-xs text-primary-foreground">
                      {pendingCount(improvementsQuery.data.improvements)}
                    </span>
                  )}
              </div>
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
