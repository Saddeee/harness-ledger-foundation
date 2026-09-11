/**
 * Best-effort secret redaction for anything derived from external text before it
 * is stored or displayed. Never a security boundary — a defence in depth.
 */

type Rule = { type: "key" | "token" | "jwt" | "pem" | "email"; re: RegExp };

// Order matters: PEM blocks and JWTs first so their inner characters are not
// nibbled by the narrower key patterns.
const RULES: Rule[] = [
  {
    type: "pem",
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  },
  { type: "jwt", re: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g },
  { type: "key", re: /sk-[A-Za-z0-9]{10,}/g },
  { type: "key", re: /lov_[A-Za-z0-9_-]{10,}/g },
  { type: "key", re: /ghp_[A-Za-z0-9]{20,}/g },
  { type: "key", re: /AKIA[0-9A-Z]{16}/g },
  { type: "email", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
];

export function redact(text: string): { text: string; count: number } {
  let out = text;
  let count = 0;
  for (const rule of RULES) {
    out = out.replace(rule.re, () => {
      count += 1;
      return `[redacted:${rule.type}]`;
    });
  }
  return { text: out, count };
}
