// The app's public origin, used as the OAuth client_id host and redirect_uri.
// Set the secret APP_ORIGIN (e.g. https://harness-ledger.lovable.app) after
// publishing; until then it falls back to the origin of the current request.
export function getAppOrigin(request?: Request): string {
  const configured = process.env["APP_ORIGIN"]?.trim().replace(/\/+$/, "");
  if (configured) return configured;
  if (request) return new URL(request.url).origin;
  throw new Error("APP_ORIGIN is not set");
}

export function getClientId(request?: Request): string {
  return `${getAppOrigin(request)}/lovable-client.json`;
}

export function getRedirectUri(request?: Request): string {
  return `${getAppOrigin(request)}/oauth/callback`;
}

export function clientMetadata(request?: Request) {
  const origin = getAppOrigin(request);
  return {
    client_id: `${origin}/lovable-client.json`,
    client_name: "Harness Ledger",
    client_uri: origin,
    redirect_uris: [`${origin}/oauth/callback`],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}
