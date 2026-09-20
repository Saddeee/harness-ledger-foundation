// Reusable "decision screen" building blocks for the guided Harness UI:
// simple by default, complete on demand. Composed only from the app's
// existing shadcn primitives -- no new visual system.
import type { ReactNode } from "react";
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
  confirmDisabled,
  variant,
  size,
  children,
  onOpenChange,
}: {
  trigger: string;
  title: string;
  body: string;
  consequences: string[];
  confirmLabel: string;
  onConfirm: () => void;
  disabled?: boolean;
  confirmDisabled?: boolean;
  variant?: "default" | "outline" | "ghost";
  // Round 6 Task 4 / spec §4: every button in one card's action bar is the
  // same size -- "sm" on lists, the default on the detail page. Omitted
  // callers (every other page using this component) keep the old default.
  size?: "default" | "sm" | undefined;
  // Extra content shown between the body and the consequences, e.g. an
  // exact preview of what will be written.
  children?: ReactNode;
  // Called when the dialog opens or closes, e.g. to reset in-dialog choice
  // state so the next open starts fresh.
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <AlertDialog {...(onOpenChange ? { onOpenChange } : {})}>
      <AlertDialogTrigger asChild>
        <Button
          disabled={disabled}
          variant={variant ?? "default"}
          size={size ?? "default"}
          className="w-full sm:w-auto"
        >
          {trigger}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent className="max-h-[85vh] overflow-y-auto">
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm">
              <p>{body}</p>
              {children}
              {consequences.length > 0 ? (
                <ul className="list-disc pl-5">
                  {consequences.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} disabled={confirmDisabled}>
            {confirmLabel}
          </AlertDialogAction>
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
