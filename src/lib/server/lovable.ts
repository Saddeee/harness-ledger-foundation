// Lovable control API access for a given owner. Server-only.
import { LovableClient } from "@lovable.dev/sdk";
import { db } from "./db";
import { logEvent } from "./events";
import { getClientId, getRedirectUri } from "./app-origin";

export const LOVABLE_AUTHORIZE_URL = "https://lovable.dev/oauth/authorize";
export const LOVABLE_TOKEN_URL = "https://lovable.dev/oauth/token";
export const LOVABLE_API_BASE = "https://api.lovable.dev";
export const LOVABLE_SCOPE =
  "offline projects:read projects:write workspaces:read workspaces:write";
const REFRESH_WINDOW_MS = 60 * 60 * 1000;

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
};

// --- PKCE helpers ---------------------------------------------------------

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

// --- Token endpoint --------------------------------------------------------

async function postToken(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(LOVABLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Token endpoint ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as TokenResponse;
}

export async function exchangeCode(
  code: string,
  codeVerifier: string,
  request?: Request,
): Promise<TokenResponse> {
  return postToken({
    grant_type: "authorization_code",
    code,
    redirect_uri: getRedirectUri(request),
    client_id: getClientId(request),
    code_verifier: codeVerifier,
  });
}

export function expiresAtFrom(expiresIn: number | undefined): string {
  return new Date(Date.now() + (expiresIn ?? 3600) * 1000).toISOString();
}

// --- Connection management --------------------------------------------------

export async function getConnection(ownerUserId: string) {
  const { data, error } = await db
    .from("lovable_connections")
    .select("*")
    .eq("owner_user_id", ownerUserId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export function needsRefresh(expiresAt: string | null): boolean {
  if (!expiresAt) return true;
  return new Date(expiresAt).getTime() - Date.now() < REFRESH_WINDOW_MS;
}

/** Refresh the owner's tokens. On failure marks the connection needs_reauth. */
export async function refreshConnection(ownerUserId: string, request?: Request) {
  const conn = await getConnection(ownerUserId);
  if (!conn) throw new Error("No Lovable connection");
  if (!conn.refresh_token) throw new Error("Connection has no refresh token");

  try {
    const tok = await postToken({
      grant_type: "refresh_token",
      refresh_token: conn.refresh_token,
      client_id: getClientId(request),
    });
    const update = {
      access_token: tok.access_token,
      refresh_token: tok.refresh_token ?? conn.refresh_token,
      expires_at: expiresAtFrom(tok.expires_in),
      scope: tok.scope ?? conn.scope,
      status: "active",
    };
    const { error } = await db.from("lovable_connections").update(update).eq("id", conn.id);
    if (error) throw error;
    await logEvent(ownerUserId, "connection.refreshed", "lovable_connections", conn.id, {
      expires_at: update.expires_at,
    });
    return { ...conn, ...update };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await db.from("lovable_connections").update({ status: "needs_reauth" }).eq("id", conn.id);
    await logEvent(ownerUserId, "connection.refresh_failed", "lovable_connections", conn.id, {
      error: message,
    });
    throw new Error(`Token refresh failed; reconnect Lovable. (${message})`);
  }
}

/** Refresh only if the token expires within 60 minutes. */
export async function ensureFreshConnection(ownerUserId: string, request?: Request) {
  const conn = await getConnection(ownerUserId);
  if (!conn) return null;
  if (needsRefresh(conn.expires_at)) return refreshConnection(ownerUserId, request);
  return conn;
}

async function isOperator(ownerUserId: string): Promise<boolean> {
  const { data } = await db
    .from("profiles")
    .select("role")
    .eq("user_id", ownerUserId)
    .maybeSingle();
  return data?.role === "operator";
}

// --- Client ----------------------------------------------------------------

/**
 * Returns an authenticated Lovable client for the owner.
 * Uses LOVABLE_CONTROL_API_KEY when present and the owner is the operator;
 * otherwise the owner's OAuth connection (refreshed inline when near expiry).
 */
export async function getLovableClient(ownerUserId: string, request?: Request) {
  const apiKey = process.env["LOVABLE_CONTROL_API_KEY"];
  if (apiKey && (await isOperator(ownerUserId))) {
    return new LovableClient({ apiKey, baseUrl: LOVABLE_API_BASE });
  }

  const conn = await ensureFreshConnection(ownerUserId, request);
  if (!conn || !conn.access_token) throw new Error("Lovable is not connected");
  if (conn.status === "needs_reauth") throw new Error("Lovable connection needs re-authorisation");
  // The SDK's built-in retryFetch backs off on 429 (honours Retry-After).
  return new LovableClient({ bearerToken: conn.access_token, baseUrl: LOVABLE_API_BASE });
}
