import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import {
  ARCHITECTURE_CHAIN,
  ARCHITECTURE_TEXT,
  ARCHITECTURE_TITLE,
  EVIDENCE_COST_LINE,
  EVIDENCE_LEVELS,
  EVIDENCE_TEXT,
  EVIDENCE_TITLE,
  HERO_ACTIONS,
  HERO_STATUS,
  HERO_TEXT,
  HERO_TITLE,
  HOSTED_TEXT,
  isLocalHost,
  LIMITATIONS,
  LIMITATIONS_TITLE,
  LOOP_STEPS,
  LOOP_TITLE,
  MCP_DOC_URL,
  MCP_LINE,
  MCP_TEXT,
  MCP_TITLE,
  MODES_NOTE,
  MODES_TEXT,
  MODES_TITLE,
  PRIMITIVES,
  PRIMITIVES_STATUS,
  PRIMITIVES_TITLE,
  README_URL,
  RUN_LOCALLY_COMMANDS,
  SOURCE_TEXT,
  SOURCE_TITLE,
  SOURCE_URL,
  START_NEEDS,
  START_STEPS,
  START_TEXT,
  START_TITLE,
  VERSIONING_POINTS,
  VERSIONING_TITLE,
  WHY_LOCAL_NOTE,
  WHY_LOCAL_TEXT,
  WHY_LOCAL_TITLE,
} from "@/lib/landing-copy";

export const Route = createFileRoute("/")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Harness Ledger — teach Lovable once, keep the lesson" },
      { name: "description", content: HERO_TEXT },
      { property: "og:title", content: "Harness Ledger" },
      { property: "og:description", content: HERO_TITLE },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Landing,
});

const LINK_CLASS = "text-sm font-medium underline underline-offset-4 opacity-90 hover:opacity-100";

// The public landing page: the only place the product explains itself.
// Progressive disclosure -- the hero and the story are always open; the
// hosted status and the limitations sit in collapsed <details>. A signed-in
// visitor sees the same page with the last button pointing at Inbox. No
// fetches, no redirects, no metrics.
//
// This page is served from two places: the Lovable-hosted front door, and a
// visitor's own machine once they've followed Start here. isLocalHost()
// tells the two apart so the primary action is never "sign in" on the
// hosted page, where signing in only reaches empty preview pages.
function Landing() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [isLocal, setIsLocal] = useState<boolean | null>(null);

  useEffect(() => {
    supabase.auth
      .getSession()
      .then(({ data }) => setSignedIn(Boolean(data.session)))
      .catch(() => setSignedIn(false));
  }, []);

  useEffect(() => {
    setIsLocal(isLocalHost(window.location.hostname));
  }, []);

  const openAppTarget = signedIn ? "/inbox" : "/login";

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="bg-primary text-primary-foreground">
        <div className="mx-auto max-w-4xl px-6 py-20 sm:py-28">
          <p className="text-sm font-medium opacity-80">Harness Ledger</p>
          <h1
            className="mt-4 text-4xl font-semibold leading-tight sm:text-5xl"
            style={{ textWrap: "balance" }}
          >
            {HERO_TITLE}
          </h1>
          <p className="mt-6 text-lg leading-relaxed opacity-90">{HERO_TEXT}</p>
          <p className="mt-3 text-sm opacity-80">{HERO_STATUS}</p>
          <nav aria-label="Primary" className="mt-10 flex flex-wrap items-center gap-3">
            {isLocal === null ? null : isLocal ? (
              <Button asChild size="lg" variant="secondary">
                <Link to={openAppTarget}>{HERO_ACTIONS.open}</Link>
              </Button>
            ) : (
              <Button asChild size="lg" variant="secondary">
                <a href="#start-here">{HERO_ACTIONS.run}</a>
              </Button>
            )}
            <a href="#how-it-works" className={LINK_CLASS}>
              {HERO_ACTIONS.how}
            </a>
            {isLocal ? (
              <a href="#start-here" className={LINK_CLASS}>
                Start here
              </a>
            ) : null}
            <a href={SOURCE_URL} target="_blank" rel="noreferrer" className={LINK_CLASS}>
              {HERO_ACTIONS.source}
            </a>
            <a href="#mcp" className={LINK_CLASS}>
              {HERO_ACTIONS.mcp}
            </a>
          </nav>
          {isLocal === false ? (
            <p className="mt-4 text-xs opacity-70">
              {HERO_ACTIONS.already}{" "}
              <Link to={openAppTarget} className="underline underline-offset-2">
                {HERO_ACTIONS.openApp}
              </Link>
              .
            </p>
          ) : null}
        </div>
      </header>

      <div className="mx-auto max-w-4xl space-y-20 px-6 py-16 sm:py-20">
        <section id="start-here" aria-labelledby="start-title" className="scroll-mt-8">
          <span id="run-locally" aria-hidden="true" />
          <h2 id="start-title" className="text-2xl font-semibold">
            {START_TITLE}
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-muted-foreground">{START_TEXT}</p>
          <ol className="mt-8 space-y-7">
            {START_STEPS.map((step, i) => (
              <li key={step.title} className="flex gap-5">
                <span
                  aria-hidden="true"
                  className="mt-0.5 w-7 shrink-0 text-right text-base font-semibold tabular-nums text-muted-foreground"
                >
                  {i + 1}
                </span>
                <div className="space-y-1">
                  <h3 className="text-base font-semibold">{step.title}</h3>
                  <p className="text-sm leading-relaxed text-muted-foreground">{step.text}</p>
                  {i === 0 ? (
                    <pre className="mt-4 overflow-x-auto rounded-md border bg-muted/40 p-4 font-mono text-sm leading-relaxed">
                      {RUN_LOCALLY_COMMANDS.join("\n")}
                    </pre>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
          <p className="mt-6 text-sm leading-relaxed text-muted-foreground">{START_NEEDS}</p>
          <p className="mt-3 text-sm">
            <a
              href={README_URL}
              target="_blank"
              rel="noreferrer"
              className="text-primary underline underline-offset-2"
            >
              Full setup guide in the README
            </a>
          </p>
          <aside className="mt-8 rounded-md border bg-muted/30 p-4">
            <h3 className="text-base font-semibold">{WHY_LOCAL_TITLE}</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{WHY_LOCAL_TEXT}</p>
            <p className="mt-2 text-sm font-medium">{WHY_LOCAL_NOTE}</p>
          </aside>
        </section>

        <section id="how-it-works" aria-labelledby="loop-title" className="scroll-mt-8">
          <h2 id="loop-title" className="text-2xl font-semibold">
            {LOOP_TITLE}
          </h2>
          <ol className="mt-8 space-y-7">
            {LOOP_STEPS.map((step, i) => (
              <li key={step.title} className="flex gap-5">
                <span
                  aria-hidden="true"
                  className="mt-0.5 w-7 shrink-0 text-right text-base font-semibold tabular-nums text-muted-foreground"
                >
                  {i + 1}
                </span>
                <div className="space-y-1">
                  <h3 className="text-base font-semibold">{step.title}</h3>
                  <p className="text-sm leading-relaxed text-muted-foreground">{step.text}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section aria-labelledby="primitives-title">
          <h2 id="primitives-title" className="text-2xl font-semibold">
            {PRIMITIVES_TITLE}
          </h2>
          <dl className="mt-6 divide-y border-y">
            {PRIMITIVES.map((p) => (
              <div key={p.name} className="grid gap-1 py-4 sm:grid-cols-[11rem_1fr] sm:gap-6">
                <dt className="font-semibold">{p.name}</dt>
                <dd className="text-sm leading-relaxed text-muted-foreground">{p.text}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-4 text-sm leading-relaxed">{PRIMITIVES_STATUS}</p>
        </section>

        <section aria-labelledby="evidence-title">
          <h2 id="evidence-title" className="text-2xl font-semibold">
            {EVIDENCE_TITLE}
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-muted-foreground">{EVIDENCE_TEXT}</p>
          <dl className="mt-4 flex flex-wrap gap-x-8 gap-y-2 text-sm">
            {EVIDENCE_LEVELS.map((level) => (
              <div key={level.name} className="flex gap-2">
                <dt className="font-semibold">{level.name}</dt>
                <dd className="text-muted-foreground">{level.status}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-4 text-sm leading-relaxed text-muted-foreground">{EVIDENCE_COST_LINE}</p>
        </section>

        <section aria-labelledby="versioning-title">
          <h2 id="versioning-title" className="text-2xl font-semibold">
            {VERSIONING_TITLE}
          </h2>
          <ul className="mt-6 list-disc space-y-2 pl-5 text-sm leading-relaxed text-muted-foreground">
            {VERSIONING_POINTS.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="modes-title">
          <h2 id="modes-title" className="text-2xl font-semibold">
            {MODES_TITLE}
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-muted-foreground">{MODES_TEXT}</p>
          <p className="mt-2 text-sm leading-relaxed">{MODES_NOTE}</p>
        </section>

        <section id="how-it-runs" aria-labelledby="architecture-title" className="scroll-mt-8">
          <h2 id="architecture-title" className="text-2xl font-semibold">
            {ARCHITECTURE_TITLE}
          </h2>
          <p className="mt-6 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-sm">
            {ARCHITECTURE_CHAIN.map((node, i) => (
              <span key={node} className="flex items-center gap-3">
                {i > 0 ? (
                  <span aria-hidden="true" className="text-muted-foreground">
                    →
                  </span>
                ) : null}
                <span>{node}</span>
              </span>
            ))}
          </p>
          <p className="mt-4 text-sm leading-relaxed text-muted-foreground">{ARCHITECTURE_TEXT}</p>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{HOSTED_TEXT}</p>
        </section>

        <section id="mcp" aria-labelledby="mcp-title" className="scroll-mt-8">
          <h2 id="mcp-title" className="text-2xl font-semibold">
            {MCP_TITLE}
          </h2>
          <p className="mt-4 font-medium">{MCP_LINE}</p>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {MCP_TEXT}{" "}
            <a
              href={MCP_DOC_URL}
              target="_blank"
              rel="noreferrer"
              className="text-primary underline underline-offset-2"
            >
              Read the MCP section of the README.
            </a>
          </p>
        </section>

        <details className="group rounded-md border">
          <summary className="cursor-pointer px-4 py-3 text-base font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {LIMITATIONS_TITLE}
          </summary>
          <ul className="list-disc space-y-2 border-t px-4 py-4 pl-9 text-sm leading-relaxed text-muted-foreground">
            {LIMITATIONS.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </details>

        <section aria-labelledby="source-title">
          <h2 id="source-title" className="text-2xl font-semibold">
            {SOURCE_TITLE}
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
            {SOURCE_TEXT}{" "}
            <a
              href={SOURCE_URL}
              target="_blank"
              rel="noreferrer"
              className="text-primary underline underline-offset-2"
            >
              github.com/Saddeee/harness-ledger-foundation
            </a>
          </p>
        </section>
      </div>
    </main>
  );
}
