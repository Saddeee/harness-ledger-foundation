/**
 * A plain node:http server that scripts Lovable REST responses per test, for
 * lovable-rest.test.ts (this round) and the runner tests Task 6 builds on
 * top of lovable-rest.ts. Nothing here is exercised by real network traffic
 * -- no test may touch Lovable, and createLovableRest's injectable
 * `baseUrl`/`fetchFn` deps exist exactly so this server can stand in.
 *
 * Routing is method+path, not "by our client method name": a couple of
 * LovableRest methods (remixInit) make more than one HTTP call, so the
 * script is keyed by REST endpoint, matching what actually arrives over the
 * wire.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";

export type Endpoint =
  | "postProjects" // POST /v1/projects (remixInit's non-deprecated create/remix call)
  | "getProject" // GET /v1/projects/{id}
  | "deleteProject" // DELETE /v1/projects/{id}
  | "patchProject" // PATCH /v1/projects/{id}
  | "listEdits" // GET /v1/projects/{id}/edits
  | "getDiff" // GET /v1/projects/{id}/git/diff
  | "getKnowledge" // GET /v1/projects/{id}/knowledge
  | "putKnowledge" // PUT /v1/projects/{id}/knowledge
  | "listMessages" // GET /v1/projects/{id}/messages
  | "postMessage" // POST /v1/projects/{id}/messages (chat)
  | "getMessage" // GET /v1/projects/{id}/messages/{message_id}
  | "remixProgress"; // GET /v1/projects/{id}/remix/progress

export type FakeRequest = {
  method: string;
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
  /** Not part of RecordedCall (the brief's own {method,path,query,body}) --
   * handlers get headers too so a test can assert on the Authorization
   * header without the recorded-calls contract carrying every header of
   * every call. */
  headers: Record<string, string | string[] | undefined>;
};

export type FakeResponse = { status: number; body?: unknown };

export type FakeScript = Partial<Record<Endpoint, (req: FakeRequest) => FakeResponse>>;

export type RecordedCall = {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
};

export type FakeLovableServer = {
  baseUrl: string;
  calls: RecordedCall[];
  close(): Promise<void>;
};

const ROUTES: { method: string; pattern: RegExp; endpoint: Endpoint; params: string[] }[] = [
  { method: "POST", pattern: /^\/v1\/projects$/, endpoint: "postProjects", params: [] },
  {
    method: "GET",
    pattern: /^\/v1\/projects\/([^/]+)$/,
    endpoint: "getProject",
    params: ["project_id"],
  },
  {
    method: "DELETE",
    pattern: /^\/v1\/projects\/([^/]+)$/,
    endpoint: "deleteProject",
    params: ["project_id"],
  },
  {
    method: "PATCH",
    pattern: /^\/v1\/projects\/([^/]+)$/,
    endpoint: "patchProject",
    params: ["project_id"],
  },
  {
    method: "GET",
    pattern: /^\/v1\/projects\/([^/]+)\/edits$/,
    endpoint: "listEdits",
    params: ["project_id"],
  },
  {
    method: "GET",
    pattern: /^\/v1\/projects\/([^/]+)\/git\/diff$/,
    endpoint: "getDiff",
    params: ["project_id"],
  },
  {
    method: "GET",
    pattern: /^\/v1\/projects\/([^/]+)\/knowledge$/,
    endpoint: "getKnowledge",
    params: ["project_id"],
  },
  {
    method: "PUT",
    pattern: /^\/v1\/projects\/([^/]+)\/knowledge$/,
    endpoint: "putKnowledge",
    params: ["project_id"],
  },
  {
    method: "GET",
    pattern: /^\/v1\/projects\/([^/]+)\/messages$/,
    endpoint: "listMessages",
    params: ["project_id"],
  },
  {
    method: "POST",
    pattern: /^\/v1\/projects\/([^/]+)\/messages$/,
    endpoint: "postMessage",
    params: ["project_id"],
  },
  {
    method: "GET",
    pattern: /^\/v1\/projects\/([^/]+)\/messages\/([^/]+)$/,
    endpoint: "getMessage",
    params: ["project_id", "message_id"],
  },
  {
    method: "GET",
    pattern: /^\/v1\/projects\/([^/]+)\/remix\/progress$/,
    endpoint: "remixProgress",
    params: ["project_id"],
  },
];

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

/** node:http's `.listen(0)` (OS-assigned port) only resolves the actual
 * port asynchronously (server.address() is null until the next tick), but
 * this factory's contract is synchronous -- callers build a
 * createLovableRest(baseUrl: fake.baseUrl) on the very next line, no await
 * in between. So the port is chosen here instead of asking the OS for one:
 * still effectively random, known synchronously, and any real bind failure
 * (a collision in this range is exceedingly unlikely) surfaces as a loud
 * connection-refused in whichever test's first request. */
function randomPort(): number {
  return 20000 + Math.floor(Math.random() * 40000);
}

export function startFakeLovable(script: FakeScript): FakeLovableServer {
  const calls: RecordedCall[] = [];
  const port = randomPort();

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const query: Record<string, string> = {};
      for (const [k, v] of url.searchParams.entries()) query[k] = v;
      const method = (req.method ?? "GET").toUpperCase();
      let body: unknown;
      try {
        body = await readBody(req);
      } catch {
        res.writeHead(400, { "content-type": "application/problem+json" });
        res.end(
          JSON.stringify({ status: 400, type: "invalid_json", detail: "body is not valid JSON" }),
        );
        return;
      }
      calls.push({ method, path: url.pathname, query, body });

      const route = ROUTES.find((r) => r.method === method && r.pattern.test(url.pathname));
      if (!route) {
        res.writeHead(404, { "content-type": "application/problem+json" });
        res.end(
          JSON.stringify({
            status: 404,
            type: "not_found",
            detail: `no fake route for ${method} ${url.pathname}`,
          }),
        );
        return;
      }
      const match = route.pattern.exec(url.pathname)!;
      const params: Record<string, string> = {};
      route.params.forEach((name, i) => {
        params[name] = decodeURIComponent(match[i + 1]!);
      });

      const handler = script[route.endpoint];
      if (!handler) {
        res.writeHead(501, { "content-type": "application/problem+json" });
        res.end(
          JSON.stringify({
            status: 501,
            type: "unscripted_endpoint",
            detail: `test did not script a response for ${route.endpoint} (${method} ${url.pathname})`,
          }),
        );
        return;
      }

      const result = handler({
        method,
        path: url.pathname,
        params,
        query,
        body,
        headers: req.headers,
      });
      const payload = result.body === undefined ? "" : JSON.stringify(result.body);
      res.writeHead(result.status, payload ? { "content-type": "application/json" } : {});
      res.end(payload);
    })().catch((err) => {
      res.writeHead(500, { "content-type": "application/problem+json" });
      res.end(JSON.stringify({ status: 500, type: "fake_server_error", detail: String(err) }));
    });
  });

  server.listen(port, "127.0.0.1");

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    calls,
    close(): Promise<void> {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
