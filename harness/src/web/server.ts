// DIAGNOSTIC UI ONLY -- not the product interface. As of checkpoint B.1, the
// real Corrections and Rules views live in the existing TanStack Start app
// (src/routes/_authenticated/{inbox,ledger}.tsx), styled with its own
// components so hosted and local runtimes share one visual product. This
// page exists only as a raw, dependency-free way to poke at the SQLite data
// directly while that TanStack integration is still gaining feature parity.
// Do not add new product functionality here -- extend the TanStack routes
// and harness/src/adapter.ts instead. Scheduled for removal once the
// TanStack UI covers everything this page can do.
import { createServer } from "node:http";
import * as store from "../store.js";

const PORT = Number(process.env.HARNESS_UI_PORT ?? 4500);

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function layout(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)} - Harness</title>
<style>
body{font-family:system-ui,sans-serif;max-width:920px;margin:2rem auto;padding:0 1rem;color:#1a1a1a;background:#fafafa}
nav a{margin-right:1rem;font-weight:600;text-decoration:none;color:#2d5bd7}
h1{font-size:1.4rem} h2{font-size:1.1rem;margin-top:2rem}
.card{border:1px solid #ddd;border-radius:8px;padding:1rem;margin:1rem 0;background:#fff}
.meta{font-size:.85rem;color:#555}
.badge{display:inline-block;padding:.1rem .5rem;border-radius:4px;background:#eef;font-size:.8rem;margin-right:.3rem}
.evidence{border-left:3px solid #ccc;padding-left:.75rem;margin:.5rem 0;font-size:.85rem}
form.inline{display:inline-block;margin:.2rem .3rem 0 0}
textarea{width:100%;min-height:4rem;font-family:inherit}
select,button,input[type=text]{font-family:inherit;padding:.2rem .4rem}
.diagnostic-banner{background:#fff3cd;border:1px solid #f0d68a;border-radius:8px;padding:.6rem 1rem;margin-bottom:1rem;font-size:.85rem}
</style></head><body>
<div class="diagnostic-banner">Diagnostic view only — not the product UI. The real Corrections and Rules pages are in the app itself (Inbox / Ledger).</div>
<nav><a href="/corrections">Corrections</a><a href="/rules">Rules</a></nav>
<h1>${esc(title)}</h1>
${body}
</body></html>`;
}

function evidenceBlock(items: Record<string, unknown>[]): string {
  return items
    .map(
      (e) => `<div class="evidence">
        <span class="badge">${esc(e.kind)}</span><span class="badge">${esc(e.provenance)}</span>
        ${e.role ? `<span class="badge">${esc(e.role)}</span>` : ""}
        <span class="meta">${esc(e.occurred_at ?? "")} ${e.source_ref ? "&middot; " + esc(e.source_ref) : ""}</span>
        <div>${esc(String(e.content).slice(0, 400))}${String(e.content).length > 400 ? "…" : ""}</div>
      </div>`,
    )
    .join("");
}

async function readBody(req: import("node:http").IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

const CLASSIFICATIONS = [
  "defect_correction", "constraint_restatement", "missing_requirement",
  "preference_revision", "scope_extension", "new_task", "question", "approval", "other",
];
const SCOPES = ["project", "workspace", "one_time"];

function correctionsPage(): string {
  const rows = store.listCorrectionCandidates() as Record<string, unknown>[];
  if (rows.length === 0) return layout("Corrections", "<p>No correction candidates yet.</p>");
  const cards = rows
    .map((r) => {
      const id = r.id as number;
      const options = (values: string[], selected: unknown) =>
        values.map((v) => `<option value="${v}" ${v === selected ? "selected" : ""}>${v}</option>`).join("");
      return `<div class="card">
        <div class="meta">project ${esc(r.project_id)} &middot; episode: ${esc(r.episode_title)}</div>
        <p><span class="badge">${esc(r.classification)}</span>
           <span class="badge">${r.is_correction ? "is_correction" : "not_correction"}</span>
           ${r.reusable === 1 ? '<span class="badge">reusable</span>' : r.reusable === 0 ? '<span class="badge">one-time</span>' : ""}
           ${r.proposed_scope ? `<span class="badge">scope: ${esc(r.proposed_scope)}</span>` : ""}
           ${r.confidence != null ? `<span class="badge">confidence ${esc(r.confidence)}</span>` : ""}
           ${r.reviewed ? '<span class="badge" style="background:#dfd">reviewed</span>' : '<span class="badge" style="background:#fee">unreviewed</span>'}
           ${r.excluded_from_learning ? '<span class="badge" style="background:#fdd">excluded</span>' : ""}
        </p>
        <p><strong>Summary:</strong> ${esc(r.summary)}</p>
        ${r.evidence_reason ? `<p><strong>Evidence reason:</strong> ${esc(r.evidence_reason)}</p>` : ""}
        <details><summary>Evidence (${(r.evidence as unknown[]).length})</summary>${evidenceBlock(r.evidence as Record<string, unknown>[])}</details>
        <div style="margin-top:.5rem">
          <form class="inline" method="post" action="/corrections/${id}/review"><input type="hidden" name="action" value="confirm"><button>Confirm</button></form>
          <form class="inline" method="post" action="/corrections/${id}/review">
            <input type="hidden" name="action" value="reclassify">
            <select name="classification">${options(CLASSIFICATIONS, r.classification)}</select>
            <button>Reclassify</button>
          </form>
          <form class="inline" method="post" action="/corrections/${id}/review"><input type="hidden" name="action" value="mark_one_time"><button>Mark one-time</button></form>
          <form class="inline" method="post" action="/corrections/${id}/review"><input type="hidden" name="action" value="mark_reusable"><button>Mark reusable</button></form>
          <form class="inline" method="post" action="/corrections/${id}/review">
            <input type="hidden" name="action" value="change_scope">
            <select name="proposed_scope">${options(SCOPES, r.proposed_scope)}</select>
            <button>Change scope</button>
          </form>
          <form class="inline" method="post" action="/corrections/${id}/review"><input type="hidden" name="action" value="exclude"><button>Exclude from learning</button></form>
        </div>
      </div>`;
    })
    .join("");
  return layout("Corrections", cards);
}

function rulesPage(): string {
  const rules = store.listProjectRules() as Record<string, unknown>[];
  if (rules.length === 0) return layout("Rules", "<p>No rules yet.</p>");
  const cards = rules
    .map((r) => {
      const full = store.getRule(r.id as number) as unknown as {
        rule: Record<string, unknown>;
        learning: Record<string, unknown> | null;
        correction_candidate: Record<string, unknown> | null;
      };
      const rule = full.rule;
      return `<div class="card">
        <p><span class="badge">${esc(rule.state)}</span><span class="badge">${esc(rule.scope)}</span>
           <span class="badge">owner: ${esc(rule.ownership)}</span>
           <span class="badge">evidence: ${esc(rule.evidence_level)}</span></p>
        <p><strong>Instruction:</strong> ${esc(rule.instruction)}</p>
        <p><strong>Applies when:</strong> ${esc(rule.applies_when)}</p>
        <p><strong>Predicted failure:</strong> ${esc(rule.predicted_failure)}</p>
        ${rule.overlap_notes ? `<p><strong>Overlap:</strong> ${esc(rule.overlap_notes)}</p>` : ""}
        ${full.correction_candidate ? `<p class="meta">source correction #${esc(full.correction_candidate.id)}: ${esc(full.correction_candidate.summary)}</p>` : ""}
        <details><summary>Edit</summary>
          <form method="post" action="/rules/${rule.id}/update">
            <input type="hidden" name="kind" value="edit">
            <textarea name="instruction">${esc(rule.instruction)}</textarea>
            <input type="text" name="reason" placeholder="reason for the edit">
            <button>Save edit (creates a revision)</button>
          </form>
        </details>
        <div style="margin-top:.5rem">
          <form class="inline" method="post" action="/rules/${rule.id}/update"><input type="hidden" name="kind" value="state"><input type="hidden" name="state" value="approved"><button>Approve</button></form>
          <form class="inline" method="post" action="/rules/${rule.id}/update"><input type="hidden" name="kind" value="state"><input type="hidden" name="state" value="rejected"><button>Reject</button></form>
          <form class="inline" method="post" action="/rules/${rule.id}/update"><input type="hidden" name="kind" value="state"><input type="hidden" name="state" value="proposed"><button>Return to proposed</button></form>
        </div>
      </div>`;
    })
    .join("");
  return layout("Rules", cards);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  try {
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(302, { Location: "/corrections" }).end();
      return;
    }
    if (req.method === "GET" && url.pathname === "/corrections") {
      res.writeHead(200, { "Content-Type": "text/html" }).end(correctionsPage());
      return;
    }
    if (req.method === "GET" && url.pathname === "/rules") {
      res.writeHead(200, { "Content-Type": "text/html" }).end(rulesPage());
      return;
    }
    const correctionMatch = url.pathname.match(/^\/corrections\/(\d+)\/review$/);
    if (req.method === "POST" && correctionMatch) {
      const body = await readBody(req);
      store.reviewCorrectionCandidate({
        id: Number(correctionMatch[1]),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        action: body.get("action") as any,
        classification: (body.get("classification") ?? undefined) as never,
        proposed_scope: (body.get("proposed_scope") ?? undefined) as never,
        reviewer: "operator (local UI)",
      });
      res.writeHead(302, { Location: "/corrections" }).end();
      return;
    }
    const ruleMatch = url.pathname.match(/^\/rules\/(\d+)\/update$/);
    if (req.method === "POST" && ruleMatch) {
      const body = await readBody(req);
      const kind = body.get("kind");
      store.updateRule({
        id: Number(ruleMatch[1]),
        instruction: kind === "edit" ? (body.get("instruction") ?? undefined) : undefined,
        state: kind === "state" ? (body.get("state") as never) : undefined,
        reason: body.get("reason") ?? undefined,
        actor: "operator (local UI)",
      });
      res.writeHead(302, { Location: "/rules" }).end();
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain" }).end(err instanceof Error ? err.message : String(err));
  }
});

server.listen(PORT, () => {
  console.log(`Harness local UI on http://localhost:${PORT}`);
});
