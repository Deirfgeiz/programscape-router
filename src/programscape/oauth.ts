/**
 * OAuth 2.1 with Programscape, as a public client: metadata discovery (RFC 8414), dynamic client registration
 * (RFC 7591), authorization code with PKCE S256 over a loopback redirect (RFC 8252), refresh with rotation, and
 * revocation (RFC 7009). Every request goes through the programscape.com-only fetch in guard.ts.
 *
 * Error messages are built here from fixed words, an HTTP status and an OAuth error code. A response body is never
 * echoed, so a token can't reach a log through an error.
 */
import { createHash, randomBytes } from "node:crypto";
import { PROGRAMSCAPE_MCP_URL, PROGRAMSCAPE_ORIGIN, PROGRAMSCAPE_SCOPE, ProgramscapeError, isProgramscapeUrl } from "./guard.js";

export type GuardedFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ServerMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  revocationEndpoint?: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** Seconds, as the server said. */
  expiresIn?: number;
  /** Who the tokens belong to, only when the token response names it. */
  account?: string;
}

const base64url = (bytes: Buffer): string => bytes.toString("base64url");

export function createPkce(): { verifier: string; challenge: string; method: "S256" } {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: pkceChallenge(verifier), method: "S256" };
}

export function pkceChallenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

export function randomState(): string {
  return base64url(randomBytes(24));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const text = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

/** The OAuth error code from an error body, if it is a plain identifier. Descriptions are never repeated. */
function oauthErrorCode(body: unknown): string | undefined {
  const code = isRecord(body) ? text(body.error) : undefined;
  return code && /^[a-z_]{1,64}$/.test(code) ? code : undefined;
}

function endpoint(value: unknown, name: string, required: true): string;
function endpoint(value: unknown, name: string, required: false): string | undefined;
function endpoint(value: unknown, name: string, required: boolean): string | undefined {
  const url = text(value);
  if (!url) {
    if (required) throw new ProgramscapeError("invalid", `Programscape's sign-in metadata has no ${name}.`);
    return undefined;
  }
  if (!isProgramscapeUrl(url)) {
    throw new ProgramscapeError("refused", `Programscape's sign-in metadata names a ${name} outside programscape.com; refused.`);
  }
  return url;
}

/** Reads https://programscape.com/.well-known/oauth-authorization-server. Endpoints come from it, never from code. */
export async function discover(fetch: GuardedFetch): Promise<ServerMetadata> {
  const response = await fetch(`${PROGRAMSCAPE_ORIGIN}/.well-known/oauth-authorization-server`, {
    headers: { accept: "application/json" },
  });
  const body = await readJson(response);
  if (!response.ok || !isRecord(body)) {
    throw new ProgramscapeError("invalid", `Programscape's sign-in metadata could not be read (HTTP ${response.status}).`, response.status);
  }
  const issuer = text(body.issuer);
  if (!issuer || issuer.replace(/\/$/, "") !== PROGRAMSCAPE_ORIGIN) {
    throw new ProgramscapeError("invalid", "Programscape's sign-in metadata names a different issuer; refused.");
  }
  const methods = Array.isArray(body.code_challenge_methods_supported) ? body.code_challenge_methods_supported : undefined;
  if (methods && !methods.includes("S256")) {
    throw new ProgramscapeError("invalid", "Programscape's sign-in metadata does not offer PKCE S256.");
  }
  const registrationEndpoint = endpoint(body.registration_endpoint, "registration endpoint", false);
  const revocationEndpoint = endpoint(body.revocation_endpoint, "revocation endpoint", false);
  return {
    issuer: PROGRAMSCAPE_ORIGIN,
    authorizationEndpoint: endpoint(body.authorization_endpoint, "authorization endpoint", true),
    tokenEndpoint: endpoint(body.token_endpoint, "token endpoint", true),
    ...(registrationEndpoint ? { registrationEndpoint } : {}),
    ...(revocationEndpoint ? { revocationEndpoint } : {}),
  };
}

/** Registers a public client (no secret) for exactly this loopback redirect URI. */
export async function registerClient(fetch: GuardedFetch, metadata: ServerMetadata, redirectUri: string, version: string): Promise<string> {
  if (!metadata.registrationEndpoint) {
    throw new ProgramscapeError("invalid", "Programscape's sign-in metadata has no registration endpoint.");
  }
  const response = await fetch(metadata.registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: "programscape-router",
      client_uri: "https://github.com/Deirfgeiz/programscape-router",
      software_id: "programscape-router",
      software_version: version,
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: PROGRAMSCAPE_SCOPE,
    }),
  });
  const body = await readJson(response);
  const clientId = isRecord(body) ? text(body.client_id) : undefined;
  if (!response.ok || !clientId) {
    const code = oauthErrorCode(body);
    throw new ProgramscapeError("invalid", `Programscape did not register this router (HTTP ${response.status}${code ? `, ${code}` : ""}).`, response.status);
  }
  return clientId;
}

export function authorizationUrl(
  metadata: ServerMetadata,
  params: { clientId: string; redirectUri: string; challenge: string; state: string },
): string {
  const url = new URL(metadata.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("code_challenge", params.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("scope", PROGRAMSCAPE_SCOPE);
  url.searchParams.set("state", params.state);
  url.searchParams.set("resource", PROGRAMSCAPE_MCP_URL);
  return url.toString();
}

async function tokenRequest(fetch: GuardedFetch, metadata: ServerMetadata, form: Record<string, string>): Promise<TokenSet> {
  const response = await fetch(metadata.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ ...form, resource: PROGRAMSCAPE_MCP_URL }).toString(),
  });
  const body = await readJson(response);
  if (!response.ok) {
    const code = oauthErrorCode(body);
    // A 4xx from the token endpoint is Programscape refusing the grant (expired, rotated or revoked).
    const kind = response.status >= 400 && response.status < 500 ? "rejected" : "unreachable";
    throw new ProgramscapeError(kind, `Programscape refused the token request (HTTP ${response.status}${code ? `, ${code}` : ""}).`, response.status);
  }
  const accessToken = isRecord(body) ? text(body.access_token) : undefined;
  const tokenType = isRecord(body) ? text(body.token_type) : undefined;
  if (!isRecord(body) || !accessToken || (tokenType && tokenType.toLowerCase() !== "bearer")) {
    throw new ProgramscapeError("invalid", "Programscape's token response could not be read.");
  }
  const refreshToken = text(body.refresh_token);
  const expiresIn = typeof body.expires_in === "number" && Number.isFinite(body.expires_in) ? body.expires_in : undefined;
  const account = accountName(body);
  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(expiresIn !== undefined ? { expiresIn } : {}),
    ...(account ? { account } : {}),
  };
}

/** Who the tokens belong to, only when the server says so. Nothing is inferred. */
function accountName(body: Record<string, unknown>): string | undefined {
  const name = text(body.email) ?? (isRecord(body.account) ? text(body.account.email) : text(body.account));
  return name && name.length <= 320 ? name : undefined;
}

export function exchangeCode(
  fetch: GuardedFetch,
  metadata: ServerMetadata,
  params: { clientId: string; code: string; verifier: string; redirectUri: string },
): Promise<TokenSet> {
  return tokenRequest(fetch, metadata, {
    grant_type: "authorization_code",
    code: params.code,
    code_verifier: params.verifier,
    redirect_uri: params.redirectUri,
    client_id: params.clientId,
  });
}

export function refresh(fetch: GuardedFetch, metadata: ServerMetadata, params: { clientId: string; refreshToken: string }): Promise<TokenSet> {
  return tokenRequest(fetch, metadata, {
    grant_type: "refresh_token",
    refresh_token: params.refreshToken,
    client_id: params.clientId,
  });
}

/** RFC 7009. Resolves true when Programscape confirmed the revocation. */
export async function revoke(
  fetch: GuardedFetch,
  metadata: ServerMetadata,
  params: { clientId: string; token: string; hint: "refresh_token" | "access_token" },
): Promise<boolean> {
  if (!metadata.revocationEndpoint) return false;
  const response = await fetch(metadata.revocationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: params.token, token_type_hint: params.hint, client_id: params.clientId }).toString(),
  });
  await response.body?.cancel().catch(() => undefined);
  return response.ok;
}
