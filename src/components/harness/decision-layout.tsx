// Reusable "decision screen" building blocks for the guided Harness UI:
// simple by default, complete on demand. Composed only from the app's
// existing shadcn primitives -- no new visual system.
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { STAGE_LABELS, type Stage } from "@/lib/harness-ux";

export function RecommendationCallout({
  title,
  recommendation,
  why,
}: {
  title: string;
  recommendation: string;
  why: string;
}) {
  return (
    <Card>
      <CardContent className="space-y-3 pt-6">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {title}
          </p>
          <p className="mt-1 text-base font-medium">{recommendation}</p>
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Why?</p>
          <p className="mt-1 text-sm">{why}</p>
        </div>
      </CardContent>
    </Card>
  );
}

export function CurrentStatus({ status, hint }: { status: string; hint?: string | undefined }) {
  return (
    <div className="text-sm">
      <span className="font-medium">Current status: </span>
      <span>{status}</span>
      {hint ? <span className="text-muted-foreground"> — {hint}</span> : null}
    </div>
  );
}

export function WhatHappensNext({
  heading = "What happens next",
  lines,
}: {
  heading?: string;
  lines: string[];
}) {
  return (
    <div className="rounded-md border bg-muted/30 p-3 text-sm">
      <p className="font-medium">{heading}</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted-foreground">
        {lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    </div>
  );
}

export function PrimaryAction({
  label,
  onClick,
  disabled,
  disabledReason,
}: {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  disabledReason?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Button
        onClick={onClick}
        disabled={disabled}
        aria-disabled={disabled}
        className="w-full sm:w-auto"
      >
        {label}
      </Button>
      {disabled && disabledReason ? (
        <p className="text-xs text-muted-foreground">{disabledReason}</p>
      ) : null}
    </div>
  );
}

export function SecondaryAction({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <Button variant="outline" onClick={onClick} disabled={disabled} className="w-full sm:w-auto">
      {label}
    </Button>
  );
}

// Confirmation for a semantic approval: always spells out the consequences
// so the user never has to infer them. Uses the existing AlertDialog.
export function ConfirmAction({
  trigger,
  title,
  body,
  consequences,
  confirmLabel,
  onConfirm,
  disabled,
  variant,
}: {
  trigger: string;
  title: string;
  body: string;
  consequences: string[];
  confirmLabel: string;
  onConfirm: () => void;
  disabled?: boolean;
  variant?: "default" | "outline" | "ghost";
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button disabled={disabled} variant={variant ?? "default"} className="w-full sm:w-auto">
          {trigger}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm">
              <p>{body}</p>
              <ul className="list-disc pl-5">
                {consequences.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>{confirmLabel}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// Collapsed by default. Native <details> so expanded/collapsed state is
// announced by assistive tech without extra ARIA wiring.
export function AdvancedDetails({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="rounded-md border">
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {title}
      </summary>
      <div className="space-y-2 border-t px-3 py-3 text-sm">{children}</div>
    </details>
  );
}

export function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="rounded-md border bg-muted/30">
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {title}
      </summary>
      <div className="space-y-2 border-t px-3 py-3 text-xs">{children}</div>
    </details>
  );
}

const STAGE_STATE_SR: Record<Stage["state"], string> = {
  complete: "done",
  current: "current step",
  future: "not yet",
  blocked: "blocked",
};

// The Found -> Your review -> Proof -> In Lovable journey. Each stage shows
// its human note (e.g. "You decided on 9 Sep") so state never relies on
// color alone; the state word itself is available to assistive tech.
export function ProcessProgress({ stages }: { stages: Stage[] }) {
  return (
    <ol aria-label="Progress" className="flex flex-wrap gap-x-4 gap-y-2">
      {stages.map((s, i) => (
        <li
          key={s.key}
          className="flex min-w-0 flex-col gap-1 text-sm"
          aria-current={s.state === "current" ? "step" : undefined}
        >
          <div className="flex items-center gap-2">
            <Badge
              variant={
                s.state === "complete" ? "secondary" : s.state === "current" ? "default" : "outline"
              }
              className={s.state === "blocked" ? "line-through" : undefined}
            >
              {i + 1}. {STAGE_LABELS[s.key] ?? s.key}
              <span className="sr-only"> ({STAGE_STATE_SR[s.state]})</span>
            </Badge>
            {i < stages.length - 1 ? (
              <span aria-hidden="true" className="text-muted-foreground">
                →
              </span>
            ) : null}
          </div>
          {s.note ? <span className="text-xs text-muted-foreground">{s.note}</span> : null}
        </li>
      ))}
    </ol>
  );
}

// A whole-card click target: a real button, so it is keyboard focusable and
// announced as one control, styled like the app's bordered cards.
export function ClickableCard({
  onClick,
  ariaLabel,
  children,
}: {
  onClick: () => void;
  ariaLabel: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      className="w-full rounded-md border bg-card p-4 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
    </button>
  );
}

export function KeyValue({
  items,
}: {
  items: { k: string; v: string | number | null | undefined }[];
}) {
  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-[max-content_1fr]">
      {items.map((it) => (
        <div key={it.k} className="contents">
          <dt className="font-medium">{it.k}</dt>
          <dd className="break-words text-muted-foreground">
            {it.v == null || it.v === "" ? "—" : String(it.v)}
          </dd>
        </div>
      ))}
    </dl>
  );
}
