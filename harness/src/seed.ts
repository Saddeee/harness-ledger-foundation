// One-off local setup script: adds a project to the allow-list.
// Run manually (npm run seed -- <lovable_project_id> <label>). Not exposed as an
// MCP tool on purpose -- see the comment on allowed_projects in db.ts.
import { db } from "./db.js";

const [, , projectId, ...labelParts] = process.argv;

if (!projectId) {
  console.error("Usage: npm run seed -- <lovable_project_id> [label]");
  process.exit(1);
}

const label = labelParts.join(" ") || null;

db.prepare(
  `INSERT INTO allowed_projects (lovable_project_id, label) VALUES (?, ?)
   ON CONFLICT(lovable_project_id) DO UPDATE SET label = excluded.label`,
).run(projectId, label);

console.log(`Allowed project: ${projectId}${label ? ` (${label})` : ""}`);
