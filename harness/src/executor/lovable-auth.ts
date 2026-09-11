/**
 * Lovable MCP connection: an OAuth client provider that persists to a single
 * 0600 file, plus the loopback authorization-code flow.
 *
 * Discovery, dynamic client registration, PKCE and refresh are all performed by
 * the MCP SDK (`auth()`, driven from StreamableHTTPClientTransport). This module
 * only supplies storage, the redirect URL, a loopback listener and `state`
 * validation. Tokens live in the auth file and are never logged.
 */
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve as resolvePath, join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  UnauthorizedError,
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

export const LOVABLE_MCP_URL = "https://mcp.lovable.dev/";
export const REDIRECT_PORT = 8765;
export const REDIRECT_URL = `http://127.0.0.1:${REDIRECT_PORT}/callback`;
export const SCOPE = "offline projects:read projects:write workspaces:read workspaces:write";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export type Workspace = { id: string; name: string };
export type Me = { email: string | null; name: string | null; workspaces: Workspace[] };

export type AuthFile = {
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  /** epoch ms at which `tokens` were stored, so `expires_in` can be turned into a date */
  tokens_saved_at?: number;
  codeVerifier?: string;
  me?: Me;
};

export function authFilePath(): string {
  const explicit = process.env.HARNESS_AUTH_PATH;
  if (explicit) return resolvePath(explicit);
  const dbPath = resolvePath(process.env.HARNESS_DB_PATH ?? "./data/harness.db");
  return join(dirname(dbPath), "lovable-auth.json");
}

function readAuthFile(file: string): AuthFile {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as AuthFile;
  } catch {
    return {};
  }
}

function writeAuthFile(file: string, data: AuthFile): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  // writeFileSync only applies `mode` when creating the file.
  chmodSync(file, 0o600);
}

export class FileOAuthProvider implements OAuthClientProvider {
  private readonly file: string;
  private readonly onRedirect: (url: URL) => void;
  private expectedState: string | undefined;

  constructor(filePath: string, onRedirect: (url: URL) => void) {
    this.file = filePath;
    this.onRedirect = onRedirect;
  }

  get redirectUrl(): string {
    return REDIRECT_URL;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Harness Ledger (local)",
      redirect_uris: [REDIRECT_URL],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: SCOPE,
    };
  }

  /** The `state` this flow expects back on the callback. */
  get currentState(): string | undefined {
    return this.expectedState;
  }

  state(): string {
    this.expectedState = randomBytes(24).toString("base64url");
    return this.expectedState;
  }

  private read(): AuthFile {
    return readAuthFile(this.file);
  }

  private patch(change: (data: AuthFile) => void): void {
    const data = this.read();
    change(data);
    writeAuthFile(this.file, data);
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.read().client;
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    this.patch((d) => {
      d.client = clientInformation;
    });
  }

  tokens(): OAuthTokens | undefined {
    return this.read().tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.patch((d) => {
      d.tokens = tokens;
      d.tokens_saved_at = Date.now();
    });
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.patch((d) => {
      d.codeVerifier = codeVerifier;
    });
  }

  codeVerifier(): string {
    const v = this.read().codeVerifier;
    if (!v) throw new Error("no PKCE code verifier saved");
    return v;
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.onRedirect(authorizationUrl);
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "all") {
      rmSync(this.file, { force: true });
      return;
    }
    this.patch((d) => {
      if (scope === "client") delete d.client;
      if (scope === "tokens") {
        delete d.tokens;
        delete d.tokens_saved_at;
      }
      if (scope === "verifier") delete d.codeVerifier;
    });
  }
}

export function status(): {
  connected: boolean;
  email: string | null;
  workspaces: Workspace[];
  expires_at: string | null;
} {
  const file = authFilePath();
  if (!existsSync(file)) {
    return { connected: false, email: null, workspaces: [], expires_at: null };
  }
  const data = readAuthFile(file);
  const connected = Boolean(data.tokens?.access_token);
  let expires_at: string | null = null;
  const expiresIn = data.tokens?.expires_in;
  if (typeof expiresIn === "number" && typeof data.tokens_saved_at === "number") {
    expires_at = new Date(data.tokens_saved_at + expiresIn * 1000).toISOString();
  }
  return {
    connected,
    email: data.me?.email ?? null,
    workspaces: data.me?.workspaces ?? [],
    expires_at,
  };
}

/** Minimal text-content parse; the full typed wrappers live in lovable-mcp.ts. */
function parseToolJson(result: unknown): unknown {
  const content = (result as { content?: { type?: string; text?: string }[] } | undefined)?.content;
  const text = content?.find((c) => c?.type === "text")?.text;
  if (typeof text !== "string") throw new Error("unexpected tool result shape");
  return JSON.parse(text);
}

function toMe(raw: unknown): Me {
  const o = (raw ?? {}) as {
    email?: unknown;
    name?: unknown;
    workspaces?: { id?: unknown; name?: unknown }[];
  };
  return {
    email: typeof o.email === "string" ? o.email : null,
    name: typeof o.name === "string" ? o.name : null,
    workspaces: Array.isArray(o.workspaces)
      ? o.workspaces.map((w) => ({ id: String(w?.id ?? ""), name: String(w?.name ?? "") }))
      : [],
  };
}

/** Query-string text only ever reaches the terminal, and only as one safe line. */
function escapeForLog(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 200);
}

type Flow = { url: Promise<string>; done: Promise<Me> };

/**
 * Runs the full loopback flow. The returned `url` promise settles as soon as the
 * SDK hands us the authorization URL; `done` settles when the callback has been
 * exchanged, `get_me` has answered and the listener is closed.
 */
function beginFlow(opts: { timeoutMs?: number } = {}): Flow {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const file = authFilePath();

  let resolveUrl!: (u: string) => void;
  let rejectUrl!: (e: unknown) => void;
  const url = new Promise<string>((res, rej) => {
    resolveUrl = res;
    rejectUrl = rej;
  });
  url.catch(() => {});

  const provider = new FileOAuthProvider(file, (authorizationUrl) => {
    resolveUrl(authorizationUrl.toString());
  });

  const done = (async (): Promise<Me> => {
    let server: Server | undefined;
    let timer: NodeJS.Timeout | undefined;
    let settleCode!: (code: string) => void;
    let failCode!: (e: unknown) => void;
    const codePromise = new Promise<string>((res, rej) => {
      settleCode = res;
      failCode = rej;
    });
    codePromise.catch(() => {});

    const close = () => {
      if (timer) clearTimeout(timer);
      server?.close();
      server?.closeAllConnections?.();
      server = undefined;
    };

    try {
      server = createServer((req, res) => {
        const reqUrl = new URL(req.url ?? "/", `http://127.0.0.1:${REDIRECT_PORT}`);
        if (reqUrl.pathname !== "/callback") {
          res.writeHead(404).end();
          return;
        }
        const code = reqUrl.searchParams.get("code");
        const state = reqUrl.searchParams.get("state");
        const error = reqUrl.searchParams.get("error");
        // Nothing from the query string reaches the response body: the page is
        // a fixed string, and the real reason travels through failCode().
        const respond = (httpStatus: number, body: string) => {
          res.writeHead(httpStatus, { "content-type": "text/html; charset=utf-8" });
          res.end(`<!doctype html><meta charset=utf-8><p>${body}</p>`);
        };
        const fail = (message: string) => {
          respond(400, "Authorization failed. Return to the terminal for details.");
          failCode(new Error(message));
        };
        // State first: an unauthenticated caller must not be able to end an
        // in-flight flow by hitting the loopback with ?error=.
        if (!provider.currentState || state !== provider.currentState) {
          // A stray or forged callback must not kill a flow the user may still
          // be completing in the browser: answer 400 and keep listening until
          // the matching state arrives or the timeout fires.
          respond(400, "Unexpected callback. Ignoring it.");
          return;
        }
        if (error) return fail(`Authorization failed: ${escapeForLog(error)}`);
        if (!code) return fail("Authorization failed: no code returned.");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(
          "<!doctype html><meta charset=utf-8><title>Connected</title>" +
            "<p>You can close this tab. Harness Ledger is connected.</p>",
        );
        settleCode(code);
      });

      await new Promise<void>((res, rej) => {
        server!.once("error", rej);
        server!.listen(REDIRECT_PORT, "127.0.0.1", res);
      });

      timer = setTimeout(() => {
        const e = new Error(`Timed out waiting for the Lovable authorization callback`);
        failCode(e);
        rejectUrl(e);
      }, timeoutMs);
      timer.unref?.();

      const client = new Client({ name: "harness-ledger-local", version: "0.1.0" });
      const makeTransport = () =>
        new StreamableHTTPClientTransport(new URL(LOVABLE_MCP_URL), { authProvider: provider });

      let transport = makeTransport();
      try {
        await client.connect(transport);
      } catch (err) {
        if (!(err instanceof UnauthorizedError)) throw err;
        // The SDK has already run discovery, dynamic registration and PKCE and
        // called redirectToAuthorization(); wait for the loopback callback.
        const code = await codePromise;
        await transport.finishAuth(code);
        await transport.close().catch(() => {});
        transport = makeTransport();
        await client.connect(transport);
      }

      const me = toMe(parseToolJson(await client.callTool({ name: "get_me", arguments: {} })));
      const data = readAuthFile(file);
      data.me = me;
      writeAuthFile(file, data);
      await client.close().catch(() => {});
      return me;
    } finally {
      close();
    }
  })();

  // If existing tokens were still valid the SDK never calls
  // redirectToAuthorization; resolve the URL with "" so startConnect() cannot
  // hang, and reject it if the flow fails before a URL was produced.
  done.then(
    () => resolveUrl(""),
    (e) => rejectUrl(e),
  );
  return { url, done };
}

/**
 * Starts the flow and resolves as soon as the authorization URL is known, so a
 * web route can redirect the browser while the listener keeps waiting.
 * `url` is "" when the stored tokens were still good and no consent was needed.
 */
export function startConnect(opts?: { timeoutMs?: number }): Promise<{
  url: string;
  done: Promise<Me>;
}> {
  const flow = beginFlow(opts);
  return flow.url.then((url) => ({ url, done: flow.done }));
}

/** Terminal variant: opens the browser best-effort and waits for completion. */
export async function connect(opts?: {
  open?: (url: string) => void;
  timeoutMs?: number;
}): Promise<{ email: string | null; workspaces: Workspace[] }> {
  const flow = beginFlow(opts);
  flow.url
    .then((url) => {
      if (opts?.open) {
        opts.open(url);
        return;
      }
      console.log(`Open this URL to connect Lovable:\n${url}`);
      openInBrowser(url);
    })
    .catch(() => {});
  const me = await flow.done;
  return { email: me.email, workspaces: me.workspaces };
}

function openInBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  void import("node:child_process")
    .then(({ spawn }) => {
      const child = spawn(cmd, [url], { stdio: "ignore", detached: true });
      child.on("error", () => {});
      child.unref();
    })
    .catch(() => {
      /* best effort only */
    });
}

/** Best-effort revocation at the authorization server, then delete the file. */
export async function disconnect(): Promise<void> {
  const file = authFilePath();
  const data = readAuthFile(file);
  const refreshToken = data.tokens?.refresh_token;
  const clientId = (data.client as { client_id?: string } | undefined)?.client_id;
  if (refreshToken && clientId) {
    try {
      const prm = await discoverOAuthProtectedResourceMetadata(LOVABLE_MCP_URL);
      const authServer = prm?.authorization_servers?.[0];
      if (authServer) {
        const meta = (await discoverAuthorizationServerMetadata(authServer)) as
          | { revocation_endpoint?: string }
          | undefined;
        if (meta?.revocation_endpoint) {
          await fetch(meta.revocation_endpoint, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              token: refreshToken,
              token_type_hint: "refresh_token",
              client_id: clientId,
            }),
          });
        }
      }
    } catch {
      /* revocation is best effort; the local credentials still go away */
    }
  }
  rmSync(file, { force: true });
}
