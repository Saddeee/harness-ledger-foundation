import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Round 6 Task 1: the plain-fetch Lovable REST client every later Round 6
// task uses (the paired-test runner never touches the Lovable MCP client).
// No test here makes a real network call -- every request goes to
// startFakeLovable's scratch node:http server via the injectable
// baseUrl/fetchFn deps.
import { createLovableRest, LovableRestError } from "../src/executor/lovable-rest.ts";
import { startFakeLovable, type FakeLovableServer } from "./fake-lovable.ts";

const TOKEN = "test-access-token";

function client(fake: FakeLovableServer) {
  return createLovableRest({ baseUrl: fake.baseUrl, fetchFn: fetch, token: TOKEN });
}

test("getProject: GET /v1/projects/{id}, maps id/name/workspace_id", async () => {
  const fake = startFakeLovable({
    getProject: (req) => {
      assert.equal(req.method, "GET");
      assert.equal(req.params.project_id, "prj_1");
      assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
      return {
        status: 200,
        body: {
          id: "prj_1",
          name: "acme-landing",
          display_name: "Acme Landing",
          workspace_id: "ws_1",
        },
      };
    },
  });
  try {
    const rest = client(fake);
    const project = await rest.getProject("prj_1");
    assert.deepEqual(project, { id: "prj_1", name: "acme-landing", workspace_id: "ws_1" });
    assert.equal(fake.calls.length, 1);
    assert.deepEqual(fake.calls[0], {
      method: "GET",
      path: "/v1/projects/prj_1",
      query: {},
      body: undefined,
    });
  } finally {
    await fake.close();
  }
});

test("getProject: falls back to display_name when the SDK's optional `name` (slug) is absent", async () => {
  const fake = startFakeLovable({
    getProject: () => ({
      status: 200,
      body: { id: "prj_2", display_name: "No Slug Yet", workspace_id: "ws_1" },
    }),
  });
  try {
    const project = await client(fake).getProject("prj_2");
    assert.equal(project.name, "No Slug Yet");
  } finally {
    await fake.close();
  }
});

test("listMessages: GET .../messages with limit/before, next_cursor derived from has_more + oldest message id (newest-first page)", async () => {
  const fake = startFakeLovable({
    listMessages: (req) => {
      assert.deepEqual(req.query, { limit: "2", before: "msg_5" });
      return {
        status: 200,
        body: {
          has_more: true,
          messages: [
            {
              message_id: "msg_4",
              role: "assistant",
              content: "did the thing",
              created_at: "2026-09-01T00:00:02.000Z",
            },
            {
              message_id: "msg_3",
              role: "user",
              content: "please do the thing",
              created_at: "2026-09-01T00:00:01.000Z",
            },
          ],
        },
      };
    },
  });
  try {
    const page = await client(fake).listMessages("prj_1", { limit: 2, cursor: "msg_5" });
    assert.equal(page.messages.length, 2);
    assert.deepEqual(page.messages[0], {
      message_id: "msg_4",
      role: "assistant",
      content: "did the thing",
      created_at: "2026-09-01T00:00:02.000Z",
    });
    assert.equal(
      page.next_cursor,
      "msg_3",
      "the oldest (last) message id in this newest-first page",
    );
  } finally {
    await fake.close();
  }
});

test("listMessages: has_more=false yields next_cursor null/undefined (no further page)", async () => {
  const fake = startFakeLovable({
    listMessages: () => ({
      status: 200,
      body: {
        has_more: false,
        messages: [
          {
            message_id: "msg_1",
            role: "user",
            content: "hi",
            created_at: "2026-09-01T00:00:00.000Z",
          },
        ],
      },
    }),
  });
  try {
    const page = await client(fake).listMessages("prj_1");
    assert.ok(!page.next_cursor);
  } finally {
    await fake.close();
  }
});

test("listEdits: GET .../edits with limit, maps id/commit_sha/commit_message/created_at/has_more", async () => {
  const fake = startFakeLovable({
    listEdits: (req) => {
      assert.deepEqual(req.query, { limit: "10" });
      return {
        status: 200,
        body: {
          has_more: false,
          edits: [
            {
              id: "edit_1",
              commit_sha: "abc123",
              commit_message: "add hero section",
              created_at: "2026-09-01T00:00:00.000Z",
            },
          ],
        },
      };
    },
  });
  try {
    const result = await client(fake).listEdits("prj_1", { limit: 10 });
    assert.deepEqual(result, {
      has_more: false,
      edits: [
        {
          id: "edit_1",
          commit_sha: "abc123",
          commit_message: "add hero section",
          created_at: "2026-09-01T00:00:00.000Z",
        },
      ],
    });
  } finally {
    await fake.close();
  }
});

test("getDiff: GET .../git/diff?message_id=, serializes structured diffs into unified-diff-shaped text", async () => {
  const fake = startFakeLovable({
    getDiff: (req) => {
      assert.deepEqual(req.query, { message_id: "msg_9" });
      return {
        status: 200,
        body: {
          diffs: [
            {
              action: "modified",
              file_path: "src/App.tsx",
              is_image: false,
              hunks: [
                {
                  oldStart: 1,
                  oldCount: 2,
                  newStart: 1,
                  newCount: 3,
                  lines: [
                    { type: "context", content: "import React from 'react';" },
                    { type: "remove", content: "const x = 1;" },
                    { type: "add", content: "const x = 2;" },
                    { type: "add", content: "const y = 3;" },
                  ],
                },
              ],
            },
          ],
        },
      };
    },
  });
  try {
    const diff = await client(fake).getDiff("prj_1", { message_id: "msg_9" });
    assert.match(diff, /diff --git a\/src\/App\.tsx b\/src\/App\.tsx/);
    assert.match(diff, /@@ -1,2 \+1,3 @@/);
    assert.match(diff, /^ import React from 'react';$/m);
    assert.match(diff, /^-const x = 1;$/m);
    assert.match(diff, /^\+const x = 2;$/m);
    assert.match(diff, /^\+const y = 3;$/m);
  } finally {
    await fake.close();
  }
});

test('getDiff: GET .../git/diff?sha=, empty diffs list yields ""', async () => {
  const fake = startFakeLovable({
    getDiff: (req) => {
      assert.deepEqual(req.query, { sha: "deadbeef" });
      return { status: 200, body: { diffs: [] } };
    },
  });
  try {
    const diff = await client(fake).getDiff("prj_1", { sha: "deadbeef" });
    assert.equal(diff, "");
  } finally {
    await fake.close();
  }
});

test('getDiff: a null diffs list (the SDK\'s own nullable field) also yields ""', async () => {
  const fake = startFakeLovable({
    getDiff: () => ({ status: 200, body: { diffs: null } }),
  });
  try {
    assert.equal(await client(fake).getDiff("prj_1", { sha: "x" }), "");
  } finally {
    await fake.close();
  }
});

test("remixInit: fetches the source project's workspace_id, then POSTs /v1/projects with the remix shape, mapping project_name -> display_name", async () => {
  const fake = startFakeLovable({
    getProject: (req) => {
      assert.equal(req.params.project_id, "prj_source");
      return { status: 200, body: { id: "prj_source", name: "source", workspace_id: "ws_42" } };
    },
    postProjects: (req) => {
      assert.deepEqual(req.body, {
        source_project_id: "prj_source",
        workspace_id: "ws_42",
        message_id: "msg_7",
        remix_mode: "including",
        include_history: false,
        include_custom_knowledge: false,
        skip_initial_remix_message: true,
        display_name: "Paired test copy",
      });
      return { status: 201, body: { id: "prj_copy", job_id: "job_123" } };
    },
  });
  try {
    const result = await client(fake).remixInit("prj_source", {
      message_id: "msg_7",
      remix_mode: "including",
      include_history: false,
      include_custom_knowledge: false,
      skip_initial_remix_message: true,
      project_name: "Paired test copy",
    });
    assert.deepEqual(result, { job_id: "job_123" });
    assert.equal(fake.calls.length, 2, "getProject then postProjects");
    assert.equal(fake.calls[0]!.path, "/v1/projects/prj_source");
    assert.equal(fake.calls[1]!.path, "/v1/projects");
  } finally {
    await fake.close();
  }
});

test("remixProgress: GET .../remix/progress?job_id=, maps preparing/running/completed/error to pending/running/completed/failed", async () => {
  const fake = startFakeLovable({
    remixProgress: (req) => {
      assert.equal(req.params.project_id, "prj_source");
      const status =
        req.query.job_id === "job_preparing"
          ? "preparing"
          : req.query.job_id === "job_running"
            ? "running"
            : req.query.job_id === "job_done"
              ? "completed"
              : "error";
      if (status === "completed") {
        return { status: 200, body: { status, result: { project_id: "prj_copy_9" } } };
      }
      if (status === "error") {
        return { status: 200, body: { status, error_message: "FILE_TOO_LARGE_FOR_COMMIT" } };
      }
      return { status: 200, body: { status } };
    },
  });
  try {
    const rest = client(fake);
    assert.deepEqual(await rest.remixProgress("prj_source", "job_preparing"), {
      status: "pending",
    });
    assert.deepEqual(await rest.remixProgress("prj_source", "job_running"), { status: "running" });
    assert.deepEqual(await rest.remixProgress("prj_source", "job_done"), {
      status: "completed",
      project_id: "prj_copy_9",
    });
    const failed = await rest.remixProgress("prj_source", "job_fail");
    assert.equal(failed.status, "failed");
    assert.equal(failed.error, "FILE_TOO_LARGE_FOR_COMMIT");
  } finally {
    await fake.close();
  }
});

test("setProjectKnowledge: PUT /v1/projects/{id}/knowledge with {content}", async () => {
  const fake = startFakeLovable({
    putKnowledge: (req) => {
      assert.deepEqual(req.body, { content: "# Knowledge\nBe nice." });
      return { status: 200, body: { content: "# Knowledge\nBe nice." } };
    },
  });
  try {
    await client(fake).setProjectKnowledge("prj_1", "# Knowledge\nBe nice.");
    assert.equal(fake.calls[0]!.method, "PUT");
    assert.equal(fake.calls[0]!.path, "/v1/projects/prj_1/knowledge");
  } finally {
    await fake.close();
  }
});

test("chat: refuses a copy project id that was never allowCopy()'d -- no HTTP call is made", async () => {
  const fake = startFakeLovable({
    postMessage: () => ({
      status: 200,
      body: { message_id: "should-not-be-reached", thread_id: "t", status: "accepted" },
    }),
  });
  try {
    const rest = client(fake);
    await assert.rejects(() => rest.chat("prj_not_allowed", "hello"));
    assert.equal(
      fake.calls.length,
      0,
      "chat must not hit the network for a non-allowed project id",
    );
  } finally {
    await fake.close();
  }
});

test("chat: allowCopy()'d project id -- POST .../messages with {message}, returns message_id/thread_id", async () => {
  const fake = startFakeLovable({
    postMessage: (req) => {
      assert.equal(req.params.project_id, "prj_copy_1");
      assert.deepEqual(req.body, { message: "please add a footer" });
      return {
        status: 200,
        body: { message_id: "msg_new", thread_id: "thread_1", status: "accepted" },
      };
    },
  });
  try {
    const rest = client(fake);
    rest.allowCopy("prj_copy_1");
    const result = await rest.chat("prj_copy_1", "please add a footer");
    assert.deepEqual(result, { message_id: "msg_new", thread_id: "thread_1" });
  } finally {
    await fake.close();
  }
});

test("chat: never called with the source project id even after allowCopy()ing a different (copy) project id", async () => {
  const fake = startFakeLovable({
    postMessage: () => ({
      status: 200,
      body: { message_id: "m", thread_id: "t", status: "accepted" },
    }),
  });
  try {
    const rest = client(fake);
    rest.allowCopy("prj_copy_1");
    await assert.rejects(() => rest.chat("prj_source", "hello"));
    assert.equal(
      fake.calls.filter((c) => c.path === "/v1/projects/prj_source/messages").length,
      0,
      "chat was never called against the source project id",
    );
  } finally {
    await fake.close();
  }
});

test("getMessage: reads the nested AI `response` when present, mapping its status (awaiting_input/completed/stopped/error passthrough)", async () => {
  const fake = startFakeLovable({
    getMessage: (req) => {
      assert.equal(req.params.message_id, "msg_1");
      assert.deepEqual(req.query, { thread_id: "thread_1" });
      return {
        status: 200,
        body: {
          message_id: "msg_1",
          role: "user",
          content: "please add a footer",
          status: "completed",
          created_at: "2026-09-01T00:00:00.000Z",
          response: {
            message_id: "msg_2",
            status: "completed",
            content: "Added a footer.",
            commit_sha: "abc123",
            edit_id: "edit_1",
            summary: "Added a footer component",
            cost_credits: 1.5,
          },
        },
      };
    },
  });
  try {
    const result = await client(fake).getMessage("prj_1", "msg_1", { thread_id: "thread_1" });
    assert.deepEqual(result, {
      status: "completed",
      commit_sha: "abc123",
      edit_id: "edit_1",
      summary: "Added a footer component",
      cost_credits: 1.5,
      content: "Added a footer.",
    });
  } finally {
    await fake.close();
  }
});

test("getMessage: top-level status queued/accepted/running collapse to 'running' (no nested response object yet)", async () => {
  const statuses = ["queued", "accepted", "running"];
  for (const raw of statuses) {
    const fake = startFakeLovable({
      getMessage: () => ({
        status: 200,
        body: {
          message_id: "msg_1",
          role: "user",
          content: "x",
          status: raw,
          created_at: "2026-09-01T00:00:00.000Z",
        },
      }),
    });
    try {
      const result = await client(fake).getMessage("prj_1", "msg_1");
      assert.equal(result.status, "running", `raw status "${raw}" should map to "running"`);
    } finally {
      await fake.close();
    }
  }
});

test("deleteProject: DELETE /v1/projects/{id}, 204 no content", async () => {
  const fake = startFakeLovable({
    deleteProject: (req) => {
      assert.equal(req.params.project_id, "prj_1");
      return { status: 204 };
    },
  });
  try {
    await client(fake).deleteProject("prj_1");
    assert.equal(fake.calls[0]!.method, "DELETE");
  } finally {
    await fake.close();
  }
});

test("setProjectVisibility: PATCH /v1/projects/{id} with {visibility}", async () => {
  const fake = startFakeLovable({
    patchProject: (req) => {
      assert.deepEqual(req.body, { visibility: "private" });
      return { status: 200, body: { id: "prj_1", visibility: "private", workspace_id: "ws_1" } };
    },
  });
  try {
    await client(fake).setProjectVisibility("prj_1", "private");
    assert.equal(fake.calls[0]!.method, "PATCH");
    assert.equal(fake.calls[0]!.path, "/v1/projects/prj_1");
  } finally {
    await fake.close();
  }
});

test("error mapping: a non-2xx response throws LovableRestError with status/type/request_id from the problem+json body", async () => {
  const fake = startFakeLovable({
    getProject: () => ({
      status: 404,
      body: {
        status: 404,
        type: "not_found",
        title: "Not Found",
        detail: "no such project",
        request_id: "req_abc",
      },
    }),
  });
  try {
    await assert.rejects(
      () => client(fake).getProject("prj_missing"),
      (err: unknown) => {
        assert.ok(err instanceof LovableRestError);
        assert.equal(err.status, 404);
        assert.equal(err.type, "not_found");
        assert.equal(err.request_id, "req_abc");
        return true;
      },
    );
  } finally {
    await fake.close();
  }
});

test("error mapping: 402 (out of credits) and 500 both surface as LovableRestError with the right status", async () => {
  for (const [status, type] of [
    [402, "insufficient_credits"],
    [500, "internal_error"],
  ] as const) {
    const fake = startFakeLovable({
      getProject: () => ({ status, body: { status, type, detail: "boom" } }),
    });
    try {
      await assert.rejects(
        () => client(fake).getProject("prj_1"),
        (err: unknown) => {
          assert.ok(err instanceof LovableRestError);
          assert.equal(err.status, status);
          assert.equal(err.type, type);
          return true;
        },
      );
    } finally {
      await fake.close();
    }
  }
});

test("error mapping: 401 carries reason 'reconnect'", async () => {
  const fake = startFakeLovable({
    getProject: () => ({
      status: 401,
      body: { status: 401, type: "unauthorized", detail: "token expired" },
    }),
  });
  try {
    await assert.rejects(
      () => client(fake).getProject("prj_1"),
      (err: unknown) => {
        assert.ok(err instanceof LovableRestError);
        assert.equal(err.status, 401);
        assert.equal(err.reason, "reconnect");
        return true;
      },
    );
  } finally {
    await fake.close();
  }
});

test("token: an explicit deps.token is sent as a Bearer header and is never present in a thrown error", async () => {
  const fake = startFakeLovable({
    getProject: (req) => {
      assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
      return { status: 403, body: { status: 403, type: "forbidden", detail: "nope" } };
    },
  });
  try {
    await assert.rejects(
      () => client(fake).getProject("prj_1"),
      (err: unknown) => {
        assert.ok(err instanceof LovableRestError);
        assert.ok(
          !JSON.stringify(err).includes(TOKEN),
          "the token never leaks into a thrown error",
        );
        assert.ok(!(err as Error).message.includes(TOKEN));
        return true;
      },
    );
  } finally {
    await fake.close();
  }
});

test("token: with no explicit deps.token, the client reads access_token from the auth file at authFilePath()", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "harness-lovable-rest-test-"));
  const authPath = join(tmp, "lovable-auth.json");
  writeFileSync(
    authPath,
    JSON.stringify({ tokens: { access_token: "from-auth-file", token_type: "Bearer" } }),
  );
  const prevAuthPath = process.env.HARNESS_AUTH_PATH;
  process.env.HARNESS_AUTH_PATH = authPath;

  const fake = startFakeLovable({
    getProject: (req) => {
      assert.equal(req.headers.authorization, "Bearer from-auth-file");
      return { status: 200, body: { id: "prj_1", name: "x", workspace_id: "ws_1" } };
    },
  });
  try {
    const rest = createLovableRest({ baseUrl: fake.baseUrl, fetchFn: fetch });
    await rest.getProject("prj_1");
  } finally {
    await fake.close();
    if (prevAuthPath === undefined) delete process.env.HARNESS_AUTH_PATH;
    else process.env.HARNESS_AUTH_PATH = prevAuthPath;
  }
});
