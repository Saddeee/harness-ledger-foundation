import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { isLocalHost } from "@/lib/landing-copy";

export const Route = createFileRoute("/login")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Sign in — Harness Ledger" },
      { name: "description", content: "Sign in or create an account for Harness Ledger." },
      { property: "og:title", content: "Sign in — Harness Ledger" },
      { property: "og:description", content: "Sign in or create an account for Harness Ledger." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: LoginPage,
});

function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isLocal, setIsLocal] = useState<boolean | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) navigate({ to: "/inbox", replace: true });
    });
  }, [navigate]);

  useEffect(() => {
    setIsLocal(isLocalHost(window.location.hostname));
  }, []);

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) setError(error.message);
    else navigate({ to: "/inbox", replace: true });
  }

  async function signUp(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: `${window.location.origin}/inbox` },
    });
    setBusy(false);
    if (error) setError(error.message);
    else if (data.session) navigate({ to: "/inbox", replace: true });
    else setNotice("Check your email to confirm your account, then sign in.");
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 px-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Harness Ledger</CardTitle>
          <CardDescription>
            {isLocal === false ? (
              <>
                This is the hosted preview. Signing in only unlocks empty preview pages; the product
                runs on your computer.{" "}
                <Link to="/" hash="start-here" className="underline underline-offset-2">
                  How to run it
                </Link>
              </>
            ) : (
              <>
                Sign in to continue. First time? Use Sign up with any email and password; this
                account only unlocks the pages, your data stays in the local file.
              </>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="signin">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="signin">Sign in</TabsTrigger>
              <TabsTrigger value="signup">Sign up</TabsTrigger>
            </TabsList>
            <TabsContent value="signin">
              <form onSubmit={signIn} className="space-y-4 pt-4">
                <Fields
                  email={email}
                  password={password}
                  setEmail={setEmail}
                  setPassword={setPassword}
                />
                <Button type="submit" className="w-full" disabled={busy}>
                  Sign in
                </Button>
              </form>
            </TabsContent>
            <TabsContent value="signup">
              <form onSubmit={signUp} className="space-y-4 pt-4">
                <Fields
                  email={email}
                  password={password}
                  setEmail={setEmail}
                  setPassword={setPassword}
                />
                <Button type="submit" className="w-full" disabled={busy}>
                  Create account
                </Button>
              </form>
            </TabsContent>
          </Tabs>
          {error ? <p className="pt-4 text-sm text-destructive">{error}</p> : null}
          {notice ? <p className="pt-4 text-sm text-muted-foreground">{notice}</p> : null}
        </CardContent>
      </Card>
    </main>
  );
}

function Fields({
  email,
  password,
  setEmail,
  setPassword,
}: {
  email: string;
  password: string;
  setEmail: (v: string) => void;
  setPassword: (v: string) => void;
}) {
  return (
    <>
      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          type="password"
          required
          minLength={6}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
    </>
  );
}
