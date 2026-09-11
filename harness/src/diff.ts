/**
 * A small, pure, deterministic line diff -- no dependency, no network. Used
 * by the knowledge route's "What changed" view (spec section 2) to render a
 * before/after between a knowledge_version's previous_content and
 * new_content: `+`/`-` for changed lines, a couple of unchanged lines of
 * context around each change, the rest of an unchanged document collapsed
 * away entirely (no hunk headers -- the UI doesn't need them).
 */

export type DiffLineKind = "+" | "-" | " ";
export type DiffLine = { kind: DiffLineKind; text: string };
export type LineDiff = { added: number; removed: number; lines: DiffLine[] };

// A string with no content has no lines at all (rather than one empty
// line), so two identical inputs -- "" included -- diff to zero lines.
function splitLines(text: string): string[] {
  return text === "" ? [] : text.split("\n");
}

// Standard LCS-over-lines edit script: O(n*m) DP table, then a deterministic
// backtrack (ties prefer "remove" over "add", so a same-position replace
// reads as "-old" immediately followed by "+new").
function computeOps(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const ops: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: " ", text: a[i]! });
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ kind: "-", text: a[i]! });
      i += 1;
    } else {
      ops.push({ kind: "+", text: b[j]! });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ kind: "-", text: a[i]! });
    i += 1;
  }
  while (j < m) {
    ops.push({ kind: "+", text: b[j]! });
    j += 1;
  }
  return ops;
}

// Keeps only lines within `context` of a change, collapsing (dropping
// entirely, not eliding with a marker) any run of unchanged lines outside
// every window -- callers that want a hunk boundary can detect one from a
// gap between consecutive kept lines' original indices if they ever need to.
function collapseContext(ops: DiffLine[], context: number): DiffLine[] {
  if (context < 0) context = 0;
  const keep = new Array<boolean>(ops.length).fill(false);
  for (let idx = 0; idx < ops.length; idx += 1) {
    if (ops[idx]!.kind !== " ") {
      const lo = Math.max(0, idx - context);
      const hi = Math.min(ops.length - 1, idx + context);
      for (let k = lo; k <= hi; k += 1) keep[k] = true;
    }
  }
  return ops.filter((_, idx) => keep[idx]);
}

export function lineDiff(before: string, after: string, context = 2): LineDiff {
  const ops = computeOps(splitLines(before), splitLines(after));
  const added = ops.reduce((n, op) => n + (op.kind === "+" ? 1 : 0), 0);
  const removed = ops.reduce((n, op) => n + (op.kind === "-" ? 1 : 0), 0);
  return { added, removed, lines: collapseContext(ops, context) };
}
