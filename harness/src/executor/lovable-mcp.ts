/**
 * Typed, read-mostly wrappers over the Lovable MCP server.
 *
 * Every call goes through `call()`, which retries once on 401 (the transport's
 * authProvider refreshes the access token in between) and honours `retry-after`
 * once on 429 before giving up. Field mapping is defensive: the server may add
 * or rename keys, and a sync run must not crash on that.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";

import { FileOAuthProvider, LOVABLE_MCP_URL, authFilePath, status } from "./lovable-auth.js";

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
  listWorkspaceSkills(
    workspaceId: string,
  ): Promise<
    { name: string; description: string | null; content: string; updated_at: string | null }[]
  >;
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

function toIdName(raw: unknown): { id: string; name: string } {
  const o = asRecord(raw);
  return { id: String(o.id ?? ""), name: String(o.name ?? "") };
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

function knowledgeContent(parsed: unknown): string {
  if (typeof parsed === "string") return parsed;
  const o = asRecord(parsed);
  return str(o.content) ?? str(o.knowledge) ?? "";
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
      const o = asRecord(
        await call("list_workspace_skills", { workspace_id: workspaceId, include_markdown: true }),
      );
      const list = Array.isArray(o.skills) ? o.skills : [];
      return list.map(toSkill);
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
