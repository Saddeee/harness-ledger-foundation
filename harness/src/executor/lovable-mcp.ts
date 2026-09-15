/**
 * Typed, read-mostly wrappers over the Lovable MCP server.
 *
 * Every call goes through `call()`, which retries once on 401 (the transport's
 * authProvider refreshes the access token in between) and honours `retry-after`
 * once on 429 before giving up. Field mapping is defensive: the server may add
 * or rename keys, and a sync run must not crash on that.
 */
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";

import {
  FileOAuthProvider,
  LOVABLE_MCP_URL,
  authFilePath,
  status,
  type AuthFile,
} from "./lovable-auth.js";

export type LovableMessage = {
  message_id: string;
  role: "user" | "assistant";
  status: string | null;
  created_at: string;
  edit_id: string | null;
  content: string;
};

export interface LovableReader {
  getMe(): Promise<{
    id: string;
    email: string | null;
    name: string | null;
    workspaces: { id: string; name: string }[];
  }>;
  listProjects(workspaceId: string): Promise<{ id: string; name: string }[]>;
  listMessages(
    projectId: string,
    cursor?: string,
    limit?: number,
  ): Promise<{ messages: LovableMessage[]; next_cursor: string | null; has_more: boolean }>;
  getProjectKnowledge(projectId: string): Promise<string>;
  getWorkspaceKnowledge(workspaceId: string): Promise<string>;
  // Round 7: `complete` is false when Lovable's answer had no skills list or
  // said there are more than it returned -- a missing skill then can't be
  // read as "deleted".
  listWorkspaceSkills(workspaceId: string): Promise<{
    skills: {
      name: string;
      description: string | null;
      content: string;
      updated_at: string | null;
    }[];
    complete: boolean;
  }>;
}

export interface LovableWriter {
  setProjectKnowledge(projectId: string, content: string): Promise<void>;
  setWorkspaceKnowledge(workspaceId: string, content: string): Promise<void>;
}

export type LovableClient = LovableReader & LovableWriter & { close(): Promise<void> };

// ---------------------------------------------------------------- helpers

export function parseToolResult(result: unknown): unknown {
  const content = (result as { content?: { type?: string; text?: string }[] } | undefined)?.content;
  const text = content?.find((c) => c?.type === "text")?.text;
  // An error result carries its message as ordinary text ("Lovable API
  // error: 401 unauthorized: Unauthorized"). Returned as data, that text was
  // saved as the project's Knowledge -- and a write composed on it would have
  // put it into Lovable. It is an error: throw it.
  if ((result as { isError?: unknown } | undefined)?.isError === true) {
    throw new Error(typeof text === "string" && text ? text : "Lovable returned an error");
  }
  if (typeof text !== "string") throw new Error("unexpected Lovable tool result shape");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function retryAfterSeconds(err: unknown): number | null {
  const e = asRecord(err);
  const code = typeof e.code === "number" ? e.code : undefined;
  const message = typeof e.message === "string" ? e.message : "";
  const is429 = code === 429 || /\b429\b|too many requests|rate limit/i.test(message);
  if (!is429) return null;
  const header = asRecord(e.headers)["retry-after"];
  const fromHeader = Number(header);
  if (Number.isFinite(fromHeader) && fromHeader > 0) return Math.min(fromHeader, 120);
  const m = message.match(/retry[- ]after[^0-9]{0,5}(\d+)/i);
  return m ? Math.min(Number(m[1]), 120) : 5;
}

function isUnauthorized(err: unknown): boolean {
  if (err instanceof UnauthorizedError) return true;
  const e = asRecord(err);
  const message = typeof e.message === "string" ? e.message : "";
  return e.code === 401 || /\b401\b|unauthorized/i.test(message);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- mapping

function toMessage(raw: unknown): LovableMessage {
  const m = asRecord(raw);
  const role = m.role === "assistant" ? "assistant" : "user";
  return {
    message_id: String(m.message_id ?? m.id ?? ""),
    role,
    status: str(m.status),
    created_at: str(m.created_at) ?? new Date(0).toISOString(),
    edit_id: str(m.edit_id),
    content: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""),
  };
}

/** list_projects gives every project a display_name (what Lovable shows),
 * but only some carry the older `name` slug -- the Projects page showed blank
 * rows for those. Exported for its unit test. */
export function toIdName(raw: unknown): { id: string; name: string } {
  const o = asRecord(raw);
  const name = o.display_name ?? o.name ?? o.id ?? "";
  return { id: String(o.id ?? ""), name: String(name) };
}

function toSkill(raw: unknown): {
  name: string;
  description: string | null;
  content: string;
  updated_at: string | null;
} {
  const s = asRecord(raw);
  return {
    name: String(s.name ?? s.slug ?? ""),
    description: str(s.description),
    content: str(s.markdown) ?? str(s.content) ?? str(s.skill_md) ?? "",
    updated_at: str(s.updated_at) ?? str(s.modified_at),
  };
}

/** Lovable's MCP answers "(empty)" for empty Knowledge (REST answers "").
 * Same rule as knowledge.ts#realKnowledgeText, kept local so this client
 * stays free of the store/database import. Exported for its unit test. */
export function knowledgeContent(parsed: unknown): string {
  const raw =
    typeof parsed === "string"
      ? parsed
      : (str(asRecord(parsed).content) ?? str(asRecord(parsed).knowledge) ?? "");
  return raw.trim() === "(empty)" ? "" : raw;
}

/** list_workspace_skills' answer as skills plus whether it is the whole
 * list: false for a malformed answer (no skills array) or has_more. Exported
 * for its unit test. */
export function skillListFromResponse(parsed: unknown): {
  skills: {
    name: string;
    description: string | null;
    content: string;
    updated_at: string | null;
  }[];
  complete: boolean;
} {
  const o = asRecord(parsed);
  const wellFormed = Array.isArray(o.skills);
  const list = wellFormed ? (o.skills as unknown[]) : [];
  return { skills: list.map(toSkill), complete: wellFormed && o.has_more !== true };
}

// ---------------------------------------------------------------- client

export async function openLovableClient(): Promise<LovableClient> {
  if (!status().connected) throw new Error("not connected");

  const provider = new FileOAuthProvider(authFilePath(), () => {
    // No interactive consent from a sync run: a missing/expired grant surfaces
    // as UnauthorizedError, which the caller turns into a "reconnect" prompt.
  });
  const client = new Client({ name: "harness-ledger-local", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(LOVABLE_MCP_URL), {
    authProvider: provider,
  });
  try {
    await client.connect(transport);
  } catch (err) {
    // Leave no half-open socket behind when the connection never came up.
    await transport.close().catch(() => {});
    throw err;
  }

  async function call(name: string, args: Record<string, unknown>): Promise<unknown> {
    try {
      return parseToolResult(await client.callTool({ name, arguments: args }));
    } catch (err) {
      if (isUnauthorized(err)) {
        // Only reached when the SDK's own refresh has already failed; one more
        // attempt lets a freshly stored token (e.g. from a parallel connect) win.
        return parseToolResult(await client.callTool({ name, arguments: args }));
      }
      const after = retryAfterSeconds(err);
      if (after !== null) {
        await sleep(after * 1000);
        return parseToolResult(await client.callTool({ name, arguments: args }));
      }
      throw err;
    }
  }

  return {
    async getMe() {
      const o = asRecord(await call("get_me", {}));
      return {
        id: String(o.id ?? ""),
        email: str(o.email),
        name: str(o.name),
        workspaces: Array.isArray(o.workspaces) ? o.workspaces.map(toIdName) : [],
      };
    },

    async listProjects(workspaceId: string) {
      const o = asRecord(await call("list_projects", { workspace_id: workspaceId }));
      const list = Array.isArray(o.projects) ? o.projects : Array.isArray(o.items) ? o.items : [];
      return list.map(toIdName);
    },

    async listMessages(projectId: string, cursor?: string, limit = 50) {
      const args: Record<string, unknown> = { project_id: projectId, limit };
      if (cursor) args.cursor = cursor;
      const o = asRecord(await call("list_messages", args));
      const pagination = asRecord(o.pagination);
      return {
        messages: Array.isArray(o.messages) ? o.messages.map(toMessage) : [],
        next_cursor: str(pagination.next_cursor),
        has_more: pagination.has_more === true,
      };
    },

    async getProjectKnowledge(projectId: string) {
      return knowledgeContent(await call("get_project_knowledge", { project_id: projectId }));
    },

    async getWorkspaceKnowledge(workspaceId: string) {
      return knowledgeContent(await call("get_workspace_knowledge", { workspace_id: workspaceId }));
    },

    async listWorkspaceSkills(workspaceId: string) {
      return skillListFromResponse(
        await call("list_workspace_skills", { workspace_id: workspaceId, include_markdown: true }),
      );
    },

    async setProjectKnowledge(projectId: string, content: string) {
      await call("set_project_knowledge", { project_id: projectId, content });
    },

    async setWorkspaceKnowledge(workspaceId: string, content: string) {
      await call("set_workspace_knowledge", { workspace_id: workspaceId, content });
    },

    async close() {
      await client.close();
    },
  };
}

// ---- Round 6 fix wave item B ----
// lovable-rest.ts reads the raw, possibly-stale access token straight off
// the auth file (FileOAuthProvider(...).tokens()) -- only this module's own
// MCP client transport actually knows how to refresh it (the SDK's own
// refresh-token flow, driven from StreamableHTTPClientTransport with
// authProvider: a FileOAuthProvider). Opening (and immediately closing) a
// client here is the cheapest way to make that refresh happen and get it
// persisted through FileOAuthProvider#saveTokens, without duplicating the
// SDK's own refresh logic.

/** How long before the stored token's own expiry this treats it as "about
 * to expire" and refreshes proactively, rather than waiting for it to
 * actually fail a real REST call first. */
const REFRESH_MARGIN_MS = 5 * 60_000;

/** Refreshes and persists the Lovable access token when it's within
 * REFRESH_MARGIN_MS of expiring, or already expired -- a no-op otherwise,
 * and a no-op (never throws) when the auth file is missing/unparseable or
 * carries no expiry info at all, so a caller's own next real Lovable call
 * still surfaces any genuine auth problem rather than this best-effort
 * check masking it. `openClient` only needs to open and close (never any of
 * LovableReader/LovableWriter's own read/write methods) -- narrowed to that
 * shape, rather than the full LovableClient the real default returns, so a
 * test can inject a bare `{ close }` stub without building one. Called at
 * the start of runExperiment (experiments.ts) and, on a 401, once by
 * lovable-rest.ts's own request() before its one allowed retry. */
export async function ensureFreshLovableToken(
  openClient: () => Promise<{ close(): Promise<void> }> = openLovableClient,
): Promise<void> {
  let data: AuthFile;
  try {
    data = JSON.parse(readFileSync(authFilePath(), "utf8")) as AuthFile;
  } catch {
    return;
  }
  const expiresIn = data.tokens?.expires_in;
  const savedAt = data.tokens_saved_at;
  if (typeof expiresIn !== "number" || typeof savedAt !== "number") return;
  const expiresAtMs = savedAt + expiresIn * 1000;
  if (expiresAtMs - REFRESH_MARGIN_MS >= Date.now()) return;

  try {
    const client = await openClient();
    await client.close().catch(() => {});
  } catch {
    // Best effort only -- the caller's own next real Lovable call still
    // surfaces any genuine, unrecoverable auth problem.
  }
}
// ---- end Round 6 fix wave item B ----
