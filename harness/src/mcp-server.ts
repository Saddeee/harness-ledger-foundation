import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { db, dbPath } from "./db.js";

const server = new McpServer({ name: "harness-mcp", version: "0.1.0" });

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

server.tool("health", "Report local Harness service health and DB path.", {}, async () =>
  json({ ok: true, time: new Date().toISOString(), db_path: dbPath() }),
);

server.tool(
  "create_test_record",
  "Insert a throwaway test record (proves writes work end to end).",
  { note: z.string().optional() },
  async ({ note }) => {
    const row = db
      .prepare(`INSERT INTO test_records (note) VALUES (?) RETURNING *`)
      .get(note ?? null);
    return json(row);
  },
);

server.tool(
  "get_allowed_projects",
  "List Lovable project IDs this Harness instance permits Claude Code to read or act on. Read-only: this list is curated out-of-band (npm run seed), never by an agent.",
  {},
  async () => json(db.prepare(`SELECT * FROM allowed_projects ORDER BY added_at`).all()),
);

server.tool(
  "upsert_project",
  "Store or update cached, redacted metadata for an approved Lovable project.",
  {
    lovable_project_id: z.string(),
    name: z.string().optional(),
    status: z.string().optional(),
    url: z.string().optional(),
    tech_stack: z.string().optional(),
    raw_json: z.string().optional(),
  },
  async (input) => {
    const row = db
      .prepare(
        `INSERT INTO projects (lovable_project_id, name, status, url, tech_stack, raw_json, updated_at)
         VALUES (@lovable_project_id, @name, @status, @url, @tech_stack, @raw_json, datetime('now'))
         ON CONFLICT(lovable_project_id) DO UPDATE SET
           name = excluded.name, status = excluded.status, url = excluded.url,
           tech_stack = excluded.tech_stack, raw_json = excluded.raw_json, updated_at = excluded.updated_at
         RETURNING *`,
      )
      .get({
        lovable_project_id: input.lovable_project_id,
        name: input.name ?? null,
        status: input.status ?? null,
        url: input.url ?? null,
        tech_stack: input.tech_stack ?? null,
        raw_json: input.raw_json ?? null,
      });
    return json(row);
  },
);

server.tool(
  "append_event",
  "Append an audit-log event recording something Claude Code did through this Harness instance.",
  { kind: z.string(), ref: z.string().optional(), payload: z.string().optional() },
  async ({ kind, ref, payload }) => {
    const row = db
      .prepare(`INSERT INTO events (kind, ref, payload) VALUES (?, ?, ?) RETURNING *`)
      .get(kind, ref ?? null, payload ?? null);
    return json(row);
  },
);

server.tool(
  "list_events",
  "List recent audit-log events, newest first.",
  { limit: z.number().int().positive().max(500).optional() },
  async ({ limit }) =>
    json(db.prepare(`SELECT * FROM events ORDER BY id DESC LIMIT ?`).all(limit ?? 50)),
);

const transport = new StdioServerTransport();
await server.connect(transport);
