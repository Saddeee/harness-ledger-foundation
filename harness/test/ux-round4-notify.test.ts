// Tests for browser notification feature (Task D2). Verifies that the required
// strings and patterns appear in the relevant source files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function readApp(rel: string): string {
  return readFileSync(new URL(`../../src/${rel}`, import.meta.url), "utf8");
}
function codeOnly(source: string): string {
  return source
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*") && !t.startsWith("{/*");
    })
    .join("\n");
}
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const SETTINGS = "components/harness/local-settings.tsx";
const ROUTE = "routes/_authenticated/route.tsx";
const CLIENT = "lib/improvements-client.ts";

test("local-settings.tsx: Notifications section present with required strings", () => {
  const src = readApp(SETTINGS);
  assert(src.includes("Notify me in this browser"), "Missing notification label");
  assert(src.includes("requestPermission"), "Missing requestPermission call");
});

test("route.tsx: Uses improvements query with 60s refetch interval", () => {
  const src = readApp(ROUTE);
  const code = codeOnly(src);
  assert(code.includes("refetchInterval: 60_000"), "Missing refetchInterval: 60_000");
  assert(code.includes('new Notification('), "Missing Notification constructor");
  assert(code.includes('queryKey: ["harness-improvements"]'), "Missing harness-improvements query key");
});

test("improvements-client.ts: Exports NOTIFY_KEY and helper functions", () => {
  const src = readApp(CLIENT);
  assert(src.includes('NOTIFY_KEY = "harness.notifyInBrowser"'), "Missing NOTIFY_KEY definition");
  assert(src.includes("isNotifyEnabled"), "Missing isNotifyEnabled function");
  assert(src.includes("setNotifyEnabled"), "Missing setNotifyEnabled function");
  assert(src.includes("pendingCount"), "Missing pendingCount function");
});

test("pages only fetch from local harness routes", () => {
  const inbox = readApp("routes/_authenticated/inbox.tsx");
  const ledger = readApp("routes/_authenticated/ledger.tsx");
  const code = [inbox, ledger].map(codeOnly).join("\n");
  // Ensure fetch calls only use the expected harness endpoints
  const allFetches = code.match(/fetch\([^)]+\)/g) || [];
  for (const f of allFetches) {
    assert(
      f.includes("/api/public/harness/") || f.includes("queryFn:") || f.includes("runtimeQueryOptions"),
      `Unexpected fetch in pages: ${f}`
    );
  }
});

test("no <details> elements are open", () => {
  const files = [
    readApp("components/harness/local-settings.tsx"),
    readApp("routes/_authenticated/route.tsx"),
  ];
  for (const src of files) {
    assert(!src.includes("<details open"), "Found <details open in source file");
  }
});

test("route.tsx uses initialised ref for first-load flag", () => {
  const src = readApp(ROUTE);
  assert(src.includes("initialised.current"), "Missing initialised.current usage");
  assert(!src.includes("previousPendingIds.current.size === 0"), "Found old first-load check");
});
