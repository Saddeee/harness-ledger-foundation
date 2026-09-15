// The README's "Trying it without a Lovable account": on a fresh install no
// project is allowed yet, so --add brings its own demo project and --remove
// takes it away again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HARNESS_DB_PATH = join(
  mkdtempSync(join(tmpdir(), "harness-demo-fresh-test-")),
  "harness.db",
);

const store = await import("../src/store.js");
const demo = await import("../src/demo.js");
const improvements = await import("../src/improvements.js");

type AllowedProject = { lovable_project_id: string; label: string | null };

test("fresh install: --add allows a demo project and loads suggestions into it", () => {
  assert.deepEqual(store.getAllowedProjects(), []);

  const result = demo.addDemoData();
  assert.equal(result.added, true);
  assert.equal(result.project_id, demo.DEMO_PROJECT_ID);

  const projects = store.getAllowedProjects() as AllowedProject[];
  assert.deepEqual(
    projects.map((p) => [p.lovable_project_id, p.label]),
    [[demo.DEMO_PROJECT_ID, "Demo project"]],
  );
  assert.ok(improvements.listImprovements().length > 0);
});

test("fresh install: --remove deletes the demo data and the demo project", () => {
  const result = demo.removeDemoData();
  assert.equal(result.removed, true);
  assert.equal(result.counts.allowed_projects, 1);
  assert.deepEqual(store.getAllowedProjects(), []);
  assert.equal(demo.demoStatus().loaded, false);

  assert.deepEqual(demo.removeDemoData(), { removed: false, counts: {} });
});
