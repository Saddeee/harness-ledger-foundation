// A small, pure, deterministic string-similarity helper -- no dependency, no
// network. Bigram (2-gram) Dice coefficient: the standard measure for "are
// these two short strings roughly the same wording" used by the miner
// (Round 4 Task A2, dedupe against live rule text) and by rule health
// (Task C1, a correction's summary vs. a rule's predicted failure).
//
// Dice's coefficient = 2 * |bigrams(a) ∩ bigrams(b)| / (|bigrams(a)| + |bigrams(b)|)
// using multiset (not set) intersection, so repeated bigrams inside one
// string ("aaaa" -> "aa","aa","aa") each still need a distinct match on the
// other side -- the classic definition, not a set-based approximation.

function normalize(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, " ");
}

function bigrams(s: string): string[] {
  const norm = normalize(s);
  if (norm.length < 2) return [];
  const grams: string[] = [];
  for (let i = 0; i < norm.length - 1; i += 1) grams.push(norm.slice(i, i + 2));
  return grams;
}

/**
 * Bigram Dice similarity of two strings, in [0, 1]. Identical (after
 * lowercasing/whitespace-normalising) strings score 1; strings sharing no
 * bigrams score 0. Two strings that both normalise to fewer than two
 * characters (so neither has any bigrams) are compared by exact equality
 * instead, so `dice("", "")` is 1 and `dice("a", "b")` is 0 rather than
 * both being the vacuous "0/0" case.
 */
export function dice(a: string, b: string): number {
  const bigramsA = bigrams(a);
  const bigramsB = bigrams(b);

  if (bigramsA.length === 0 && bigramsB.length === 0) {
    return normalize(a) === normalize(b) ? 1 : 0;
  }
  if (bigramsA.length === 0 || bigramsB.length === 0) return 0;

  const remaining = new Map<string, number>();
  for (const g of bigramsA) remaining.set(g, (remaining.get(g) ?? 0) + 1);

  let matches = 0;
  for (const g of bigramsB) {
    const count = remaining.get(g) ?? 0;
    if (count > 0) {
      matches += 1;
      remaining.set(g, count - 1);
    }
  }

  return (2 * matches) / (bigramsA.length + bigramsB.length);
}
