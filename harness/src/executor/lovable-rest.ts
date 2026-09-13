/**
 * A plain-fetch client for Lovable's public REST API (api.lovable.dev),
 * used only by the paired-test runner (Round 6): copying a project, chatting
 * with the copy, and reading back its build result are not operations the
 * Lovable MCP server (lovable-mcp.ts) exposes. Everything else in this app
 * keeps using the MCP client.
 *
 * Paths/shapes below are taken from the installed SDK's OpenAPI types
 * (node_modules/@lovable.dev/sdk/dist/index.d.ts, root package) -- see this
 * file's own comments for the exact operation each method calls. The one
 * deliberate deviation from a literal 1:1 SDK mapping is remixInit: the
 * SDK marks POST /v1/projects/{project_id}/remix/init deprecated in favour
 * of POST /v1/projects with a source_project_id, so that is what this calls
 * (see remixInit's own comment for the extra GET this costs).
 *
 * The access token is read once per call from the same file lovable-auth.ts
 * writes (FileOAuthProvider(authFilePath()).tokens()), or from an injected
 * deps.token in tests -- it is attached to the Authorization header and
 * never logged, never included in a thrown error, and never written to
 * SQLite.
 */
import { FileOAuthProvider, authFilePath } from "./lovable-auth.js";
import { ensureFreshLovableToken } from "./lovable-mcp.js";

const DEFAULT_BASE_URL = "https://api.lovable.dev";

export type RestMessage = {
  message_id: string;
  role: "user" | "assistant";
  content: string;
  created_at?: string;
};

// Round 6 Task 6a fix round 1: widened to `| (string & {})` so an
// unrecognized-but-real status Lovable reports (its own "timeout", or
// anything not in this client's known vocabulary) passes through toRestBuildStatus
// verbatim instead of being silently folded into "running" -- see that
// function's own doc comment. The `& {}` keeps the six named literals'
// autocomplete/narrowing intact; only a value equal to one of them still
// narrows, everything else is just `string`.
export type RestBuildStatus =
  "completed" | "stopped" | "awaiting_input" | "timeout" | "error" | "running" | (string & {});

export interface LovableRest {
  getProject(id: string): Promise<{ id: string; name: string; workspace_id: string }>;
  listMessages(
    id: string,
    opts?: { limit?: number; cursor?: string },
  ): Promise<{ messages: RestMessage[]; next_cursor?: string | null }>;
  listEdits(
    id: string,
    opts?: { limit?: number },
  ): Promise<{
    edits: { id: string; commit_sha: string; commit_message: string; created_at: string }[];
    has_more: boolean;
  }>;
  getDiff(id: string, by: { message_id: string } | { sha: string }): Promise<string>;
  remixInit(
    sourceId: string,
    opts: {
      message_id: string;
      remix_mode: "before" | "including";
      include_history: false;
      include_custom_knowledge: false;
      skip_initial_remix_message: true;
      project_name: string;
    },
  ): Promise<{ job_id: string }>;
  remixProgress(
    sourceId: string,
    jobId: string,
  ): Promise<{
    status: "pending" | "running" | "completed" | "failed";
    project_id?: string;
    error?: string;
  }>;
  setProjectKnowledge(id: string, content: string): Promise<void>;
  chat(copyProjectId: string, message: string): Promise<{ message_id: string; thread_id: string }>;
  getMessage(
    id: string,
    messageId: string,
    opts?: { thread_id?: string },
  ): Promise<{
    status: RestBuildStatus;
    commit_sha?: string;
    edit_id?: string;
    summary?: string;
    cost_credits?: number;
    content?: string;
  }>;
  deleteProject(id: string): Promise<void>;
  setProjectVisibility(id: string, visibility: "private" | "public"): Promise<void>;
  allowCopy(id: string): void;
}

/** Thrown for any non-2xx response. `type`/`request_id` come straight off
 * the API's application/problem+json body (ErrorModel in the SDK's types);
 * `reason: "reconnect"` on a 401 is this client's own signal that the
 * stored token needs a fresh OAuth flow, not something the API itself
 * returns. The response body is never attached verbatim (only the three
 * fields above plus a human-readable message) so a token that somehow ended
 * up echoed in an error body can never ride along. */
export class LovableRestError extends Error {
  readonly status: number;
  readonly type: string;
  readonly request_id?: string;
  readonly reason?: "reconnect";

  constructor(status: number, type: string, request_id?: string, detail?: string) {
    super(
      detail ? `Lovable REST ${status} (${type}): ${detail}` : `Lovable REST ${status} (${type})`,
    );
    this.name = "LovableRestError";
    this.status = status;
    this.type = type;
    this.request_id = request_id;
    if (status === 401) this.reason = "reconnect";
  }
}

type ProblemBody = {
  status?: number;
  type?: string;
  title?: string;
  detail?: string;
  request_id?: string;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

// ---------------------------------------------------------------- diffs
//
// GET .../git/diff returns V1DiffResponse: { diffs: V1DiffEntry[] | null },
// a structured per-file/per-hunk/per-line diff -- not the unified-diff text
// this client's own getDiff() promises callers. This section synthesizes
// unified-diff-shaped text from that structure so the runner (and a human
// reading a logged diff) sees something familiar; it is not literally what
// the API returns.

type RestDiffLine = { content?: string; type?: string };
type RestDiffHunk = {
  lines?: RestDiffLine[] | null;
  newCount?: number;
  newStart?: number;
  oldCount?: number;
  oldStart?: number;
};
type RestDiffEntry = {
  action?: string;
  file_path?: string;
  original_file_path?: string;
  hunks?: RestDiffHunk[] | null;
  is_image?: boolean;
};

function diffLinePrefix(type: string | undefined): string {
  const t = (type ?? "").toLowerCase();
  if (t.includes("add") || t.includes("insert")) return "+";
  if (t.includes("del") || t.includes("rem")) return "-";
  return " ";
}

function serializeDiff(entries: RestDiffEntry[]): string {
  if (!entries.length) return "";
  const parts: string[] = [];
  for (const entry of entries) {
    const to = entry.file_path ?? "";
    const from = entry.original_file_path ?? to;
    parts.push(`diff --git a/${from} b/${to}`);
    if (entry.is_image) {
      parts.push("Binary files differ");
      continue;
    }
    for (const hunk of entry.hunks ?? []) {
      parts.push(
        `@@ -${hunk.oldStart ?? 0},${hunk.oldCount ?? 0} +${hunk.newStart ?? 0},${hunk.newCount ?? 0} @@`,
      );
      for (const line of hunk.lines ?? []) {
        parts.push(`${diffLinePrefix(line.type)}${line.content ?? ""}`);
      }
    }
  }
  return parts.join("\n");
}

// ------------------------------------------------------------ status maps

/** V1MessageResponse.status / V1AIResponseSummary.status enumerate several
 * spellings that all mean "not done yet" (queued, accepted, running,
 * in_progress, pending) -- collapsed here to RestBuildStatus's own
 * "running" so a caller polling for completion never stops early on a
 * known non-terminal spelling. Round 6 Task 6a fix round 1: anything else
 * -- a real terminal status this client doesn't separately enumerate, e.g.
 * Lovable's own "timeout" -- is passed through verbatim rather than folded
 * into "running", so a caller (the paired-test runner) can tell "still
 * building" apart from "Lovable itself says this ended, just not with a
 * status I have a case for" and fail loudly instead of hanging forever
 * treating an unrecognized terminal status as perpetually in progress. */
function toRestBuildStatus(raw: string): RestBuildStatus {
  switch (raw) {
    case "completed":
    case "stopped":
    case "awaiting_input":
    case "error":
      return raw;
    case "running":
    case "in_progress":
    case "queued":
    case "accepted":
    case "pending":
      return "running";
    default:
      return raw;
  }
}

/** V1RemixProgressOutputBody.status is "preparing, running, completed, or
 * error" (the SDK's own words); this client's own names are
 * pending/running/completed/failed. Unrecognized values map to "running"
 * (keep polling) rather than "failed", for the same reason as
 * toRestBuildStatus above. */
function toRemixStatus(raw: string): "pending" | "running" | "completed" | "failed" {
  switch (raw) {
    case "preparing":
      return "pending";
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "error":
      return "failed";
    default:
      return "running";
  }
}

export function createLovableRest(deps?: {
  fetchFn?: typeof fetch;
  baseUrl?: string;
  token?: string;
  // Round 6 fix wave item B: refreshes the stored token on a 401, before
  // the one retry below -- defaults to the real ensureFreshLovableToken
  // (lovable-mcp.ts); tests inject a stub so a 401-retry test never opens a
  // real MCP client.
  ensureFreshToken?: () => Promise<void>;
}): LovableRest {
  const fetchFn = deps?.fetchFn ?? fetch;
  const baseUrl = deps?.baseUrl ?? DEFAULT_BASE_URL;
  const ensureFreshToken = deps?.ensureFreshToken ?? ensureFreshLovableToken;
  const allowedCopyIds = new Set<string>();

  function resolveToken(): string | undefined {
    if (deps?.token !== undefined) return deps.token;
    // A no-op onRedirect: this provider is only ever asked for tokens()
    // here, never driven through the OAuth flow itself (lovable-auth.ts's
    // connect()/startConnect() own that).
    return new FileOAuthProvider(authFilePath(), () => {}).tokens()?.access_token;
  }

  async function request(
    method: string,
    path: string,
    opts?: { query?: Record<string, string | undefined>; body?: unknown },
    // Round 6 fix wave item B: internal-only, never passed by a caller --
    // set to true on the one retry this function makes of itself after a
    // 401 (see below), so a second 401 doesn't refresh-and-retry forever.
    isRetry = false,
  ): Promise<unknown> {
    const url = new URL(baseUrl + path);
    if (opts?.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined) url.searchParams.set(k, v);
      }
    }
    const headers: Record<string, string> = { accept: "application/json" };
    const token = resolveToken();
    if (token) headers.authorization = `Bearer ${token}`;
    let body: string | undefined;
    if (opts?.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.body);
    }

    const res = await fetchFn(url.toString(), { method, headers, body });
    const text = await res.text();
    const parsed: unknown = text ? JSON.parse(text) : undefined;

    if (!res.ok) {
      // Round 6 fix wave item B: on a 401, refresh the stored token once
      // (ensureFreshLovableToken persists it through FileOAuthProvider, so
      // the retry's own resolveToken() call picks it straight back up) and
      // retry this exact request exactly once before giving up.
      if (res.status === 401 && !isRetry) {
        await ensureFreshToken();
        return request(method, path, opts, true);
      }
      const problem: ProblemBody = isRecord(parsed) ? (parsed as ProblemBody) : {};
      throw new LovableRestError(
        res.status,
        problem.type ?? "unknown_error",
        problem.request_id,
        problem.detail ?? problem.title,
      );
    }
    return parsed;
  }

  const enc = encodeURIComponent;

  // GET /v1/projects/{project_id} -- operation "get-v1-projects-project_id",
  // node_modules/@lovable.dev/sdk/dist/index.d.ts:7138 (path def line 587).
  // Response: components["schemas"]["V1ProjectResponse"] (line 4413) --
  // `id` and `workspace_id` are required, `name` (the slug) is optional so
  // falls back to display_name, then "".
  async function getProject(
    id: string,
  ): Promise<{ id: string; name: string; workspace_id: string }> {
    const raw = (await request("GET", `/v1/projects/${enc(id)}`)) as {
      id: string;
      name?: string;
      display_name?: string;
      workspace_id: string;
    };
    return { id: raw.id, name: raw.name ?? raw.display_name ?? "", workspace_id: raw.workspace_id };
  }

  return {
    getProject,

    // GET /v1/projects/{project_id}/messages?limit=&before= -- operation
    // "get-v1-projects-project_id-messages", index.d.ts:7743. Response:
    // V1ListMessagesOutputBody (line 4080): { has_more, messages }, newest
    // first, no next_cursor field of its own -- `before` is a message id
    // cursor for "older than", so next_cursor here is the oldest (last)
    // message id in the page when has_more is true, else null.
    async listMessages(id, opts) {
      const raw = (await request("GET", `/v1/projects/${enc(id)}/messages`, {
        query: { limit: opts?.limit?.toString(), before: opts?.cursor },
      })) as {
        has_more?: boolean;
        messages?:
          { message_id: string; role: string; content: string; created_at: string }[] | null;
      };
      const messages: RestMessage[] = (raw.messages ?? []).map((m) => ({
        message_id: m.message_id,
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
        created_at: m.created_at,
      }));
      const next_cursor =
        raw.has_more && messages.length ? messages[messages.length - 1]!.message_id : null;
      return { messages, next_cursor };
    },

    // GET /v1/projects/{project_id}/edits?limit= -- operation
    // "get-v1-projects-project_id-edits", index.d.ts:7450. Response:
    // V1GetEditsOutputBody (line 3999) of V1EditSummary (line 3957);
    // commit_sha/commit_message are optional there and default to "".
    async listEdits(id, opts) {
      const raw = (await request("GET", `/v1/projects/${enc(id)}/edits`, {
        query: { limit: opts?.limit?.toString() },
      })) as {
        has_more?: boolean;
        edits?:
          { id: string; commit_sha?: string; commit_message?: string; created_at: string }[] | null;
      };
      return {
        has_more: raw.has_more ?? false,
        edits: (raw.edits ?? []).map((e) => ({
          id: e.id,
          commit_sha: e.commit_sha ?? "",
          commit_message: e.commit_message ?? "",
          created_at: e.created_at,
        })),
      };
    },

    // GET /v1/projects/{project_id}/git/diff?sha=|message_id= -- operation
    // "get-v1-projects-project_id-git-diff", index.d.ts:7559. Response:
    // V1DiffResponse (line 3954) = { diffs: V1DiffEntry[] | null } --
    // structured, not text; serializeDiff above turns it into unified-diff
    // shaped text (see that section's own comment).
    async getDiff(id, by) {
      const query = "message_id" in by ? { message_id: by.message_id } : { sha: by.sha };
      const raw = (await request("GET", `/v1/projects/${enc(id)}/git/diff`, { query })) as {
        diffs?: RestDiffEntry[] | null;
      };
      return serializeDiff(raw.diffs ?? []);
    },

    // remixInit deliberately does NOT call the deprecated
    // POST /v1/projects/{project_id}/remix/init (index.d.ts:1015/8007 --
    // "Deprecated compatibility endpoint. Prefer POST /v1/projects with a
    // non-empty source_project_id"). It calls the replacement:
    //   1. GET /v1/projects/{sourceId} (getProject above) to read
    //      workspace_id -- PublicV1ProjectRemixInputBody (index.d.ts:2853)
    //      requires workspace_id, which this method's own signature (the
    //      brief's, unchanged) does not take as a parameter.
    //   2. POST /v1/projects -- operation "post-v1-projects",
    //      index.d.ts:7086 (path def line 580). Body:
    //      PublicV1ProjectRemixInputBody; this method's own `project_name`
    //      maps to that body's `display_name` field (the schema has no
    //      `project_name` key -- that name only exists on the deprecated
    //      endpoint's V1RemixInitInputBody, index.d.ts:4540). Response:
    //      PublicV1CreateProjectResponse (line 2563), whose `job_id` is
    //      "present when source_project_id is provided".
    async remixInit(sourceId, opts) {
      const source = await getProject(sourceId);
      const raw = (await request("POST", "/v1/projects", {
        body: {
          source_project_id: sourceId,
          workspace_id: source.workspace_id,
          message_id: opts.message_id,
          remix_mode: opts.remix_mode,
          include_history: opts.include_history,
          include_custom_knowledge: opts.include_custom_knowledge,
          skip_initial_remix_message: opts.skip_initial_remix_message,
          display_name: opts.project_name,
        },
      })) as { job_id?: string };
      if (!raw.job_id) {
        throw new Error(`POST /v1/projects (remix of ${sourceId}) did not return a job_id`);
      }
      return { job_id: raw.job_id };
    },

    // GET /v1/projects/{project_id}/remix/progress?job_id= -- project_id
    // here is the *source* project id (the one remix/init was called
    // against), per the SDK's own path-param description. Operation
    // "get-v1-projects-project_id-remix-progress", index.d.ts:8043 (path
    // def line 1034) -- "Deprecated ... No replacement in the public API",
    // so this is used as-is; there is nothing to migrate to. Response:
    // V1RemixProgressOutputBody (line 4569); toRemixStatus above maps its
    // status vocabulary to this client's own.
    async remixProgress(sourceId, jobId) {
      const raw = (await request("GET", `/v1/projects/${enc(sourceId)}/remix/progress`, {
        query: { job_id: jobId },
      })) as { status: string; result?: { project_id?: string }; error_message?: string };
      // Optional fields are omitted entirely when absent (rather than set
      // to `undefined`) so a plain object-equality check on the result --
      // e.g. { status: "pending" } -- sees no extra keys.
      const out: {
        status: "pending" | "running" | "completed" | "failed";
        project_id?: string;
        error?: string;
      } = {
        status: toRemixStatus(raw.status),
      };
      if (raw.result?.project_id !== undefined) out.project_id = raw.result.project_id;
      if (raw.error_message !== undefined) out.error = raw.error_message;
      return out;
    },

    // PUT /v1/projects/{project_id}/knowledge -- operation
    // "put-v1-projects-project_id-knowledge", index.d.ts:7707. Body:
    // V1SetProjectKnowledgeInputBody { content } (line 4805). Response
    // (V1KnowledgeResponse, the same shape back) is ignored -- this method
    // returns void per the brief.
    async setProjectKnowledge(id, content) {
      await request("PUT", `/v1/projects/${enc(id)}/knowledge`, { body: { content } });
    },

    allowCopy(id: string) {
      allowedCopyIds.add(id);
    },

    // POST /v1/projects/{project_id}/messages -- operation
    // "post-v1-projects-project_id-messages", index.d.ts:7780. Body:
    // V1SendMessageInputBody { message } (line 4764). Response:
    // V1SendMessageOutputBody { message_id, status, thread_id } (line
    // 4784). Refuses (no HTTP call at all) for any id not registered via
    // allowCopy() -- the runner calls allowCopy only on the freshly-remixed
    // copy project, never the source, so a bug that passed the wrong id
    // fails loudly instead of spending credits against the user's real
    // project.
    async chat(copyProjectId, message) {
      if (!allowedCopyIds.has(copyProjectId)) {
        throw new Error(
          `chat refused: "${copyProjectId}" was never allowCopy()'d -- only a project the runner has explicitly registered as this run's copy may be chatted at`,
        );
      }
      const raw = (await request("POST", `/v1/projects/${enc(copyProjectId)}/messages`, {
        body: { message },
      })) as { message_id: string; thread_id: string };
      return { message_id: raw.message_id, thread_id: raw.thread_id };
    },

    // GET /v1/projects/{project_id}/messages/{message_id}?thread_id= --
    // operation "get-v1-projects-project_id-messages-message_id",
    // index.d.ts:7816. Response: V1MessageResponse (line 4203), which
    // describes *this* message's own status (queued, accepted, running,
    // awaiting_input, completed, stopped, error) at the top level and, once
    // Lovable's agent has responded, the AI's own result nested under
    // `response` (V1AIResponseSummary, line 3381: commit_sha, content,
    // cost_credits, edit_id, status, summary). The nested object is
    // preferred when present (it is the actual build outcome the runner
    // cares about); the top-level fields are the fallback while there is no
    // response yet.
    async getMessage(id, messageId, opts) {
      const raw = (await request("GET", `/v1/projects/${enc(id)}/messages/${enc(messageId)}`, {
        query: { thread_id: opts?.thread_id },
      })) as {
        status: string;
        commit_sha?: string;
        edit_id?: string;
        summary?: string;
        cost_credits?: number;
        content?: string;
        response?: {
          status: string;
          commit_sha?: string;
          edit_id?: string;
          summary?: string;
          cost_credits?: number;
          content?: string;
        };
      };
      const source = raw.response ?? raw;
      // Same "omit rather than set undefined" shape as remixProgress above.
      const out: {
        status: RestBuildStatus;
        commit_sha?: string;
        edit_id?: string;
        summary?: string;
        cost_credits?: number;
        content?: string;
      } = { status: toRestBuildStatus(source.status) };
      if (source.commit_sha !== undefined) out.commit_sha = source.commit_sha;
      if (source.edit_id !== undefined) out.edit_id = source.edit_id;
      if (source.summary !== undefined) out.summary = source.summary;
      if (source.cost_credits !== undefined) out.cost_credits = source.cost_credits;
      if (source.content !== undefined) out.content = source.content;
      return out;
    },

    // DELETE /v1/projects/{project_id} -- operation
    // "delete-v1-projects-project_id", index.d.ts:7170. 204 No Content on
    // success; "Repeated deletes are treated as successful" per the SDK's
    // own description, so this is safe to call on an already-deleted copy.
    async deleteProject(id) {
      await request("DELETE", `/v1/projects/${enc(id)}`);
    },

    // PATCH /v1/projects/{project_id} -- operation
    // "patch-v1-projects-project_id", index.d.ts:7200. Body:
    // PublicV1PatchProjectBody { visibility } (line 2657; the schema also
    // allows "draft"/"workspace_view", this client's own narrower type only
    // offers the two the runner actually sets).
    async setProjectVisibility(id, visibility) {
      await request("PATCH", `/v1/projects/${enc(id)}`, { body: { visibility } });
    },
  };
}
