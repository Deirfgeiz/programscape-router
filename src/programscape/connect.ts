/**
 * `programscape-router connect` and `disconnect`.
 *
 * connect: read Programscape's sign-in metadata, listen on 127.0.0.1 on a free port, register (or reuse) a public
 * client for exactly that redirect URI, open the browser at the authorization URL (and print it, for headless use),
 * take the code from the loopback redirect, exchange it with the PKCE verifier, and store the tokens with mode 600.
 *
 * disconnect: revoke the tokens at the revocation endpoint from the metadata and delete the token file.
 */
import { spawn } from "node:child_process";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { FetchLike } from "../providers/index.js";
import { VERSION } from "../version.js";
import { ProgramscapeError, programscapeFetch } from "./guard.js";
import {
  type GuardedFetch,
  type ServerMetadata,
  authorizationUrl,
  createPkce,
  discover,
  exchangeCode,
  randomState,
  registerClient,
  revoke,
} from "./oauth.js";
import {
  deleteClientCache,
  deleteSyncState,
  deleteTokenFile,
  readClientCache,
  readSyncState,
  readTokenFile,
  tokenPath,
  writeClientCache,
  writeSyncState,
  writeTokenFile,
} from "./store.js";

const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_WAIT_MS = 5 * 60_000;

export interface ConnectOptions {
  env: NodeJS.ProcessEnv;
  fetch: FetchLike;
  now: () => Date;
  /** Lines for the founder (stdout). Never given a token. */
  print: (line: string) => void;
  /** Opens the authorization URL. Defaults to the system browser; false to only print it. */
  openBrowser?: ((url: string) => void | Promise<void>) | false;
  /** How long to wait for the browser to come back. */
  waitMs?: number;
}

export interface ConnectResult {
  tokenPath: string;
}

/** The system browser, best effort. The URL is printed as well, so a failure here changes nothing. */
export function systemBrowser(url: string): void {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command as string, args as string[], { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // The printed URL still works.
  }
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve((server.address() as AddressInfo).port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: "127.0.0.1", port, exclusive: true });
  });
}

const PAGE = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font:16px system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">` +
  `<h1 style="font-size:1.25rem">${title}</h1><p>${body}</p></body>`;

interface Callback {
  redirectUri: string;
  code: Promise<string>;
  close: () => Promise<void>;
}

/** Listens on 127.0.0.1 for exactly one redirect carrying `state`. */
async function loopback(preferredPort: number | undefined, state: () => string, waitMs: number): Promise<Callback> {
  let settle: { resolve: (code: string) => void; reject: (error: Error) => void } | undefined;
  const code = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject };
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET" || url.pathname !== "/callback") {
      response.writeHead(404, { "content-type": "text/plain" }).end("Not found");
      return;
    }
    // A redirect without this attempt's state is not ours: it is ignored, and the wait goes on.
    if (url.searchParams.get("state") !== state()) {
      response.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end(PAGE("Not this sign-in", "This link doesn't match the sign-in the router started. Go back to the terminal."));
      return;
    }
    const error = url.searchParams.get("error");
    const value = url.searchParams.get("code");
    if (error || !value) {
      response.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end(PAGE("Not connected", "Programscape didn't authorize the router. You can close this tab."));
      const reason = error && /^[a-z_]{1,64}$/.test(error) ? ` (${error})` : "";
      settle?.reject(new ProgramscapeError("refused", `Programscape didn't authorize the router${reason}.`));
      return;
    }
    response
      .writeHead(200, { "content-type": "text/html; charset=utf-8" })
      .end(PAGE("Connected", "programscape-router can now sync balance numbers to your plan. You can close this tab."));
    settle?.resolve(value);
  });

  let port: number;
  try {
    port = await listen(server, preferredPort ?? 0);
  } catch (error) {
    if (preferredPort === undefined) throw error;
    port = await listen(server, 0);
  }

  const timer = setTimeout(
    () => settle?.reject(new ProgramscapeError("unreachable", `No answer from the browser within ${Math.round(waitMs / 1000)} seconds; run connect again.`)),
    waitMs,
  );
  timer.unref();
  return {
    redirectUri: `http://127.0.0.1:${port}/callback`,
    code,
    close: () =>
      new Promise((resolve) => {
        clearTimeout(timer);
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

function cachedPort(redirectUri: string | undefined): number | undefined {
  if (!redirectUri) return undefined;
  try {
    const url = new URL(redirectUri);
    const port = Number(url.port);
    return url.hostname === "127.0.0.1" && Number.isInteger(port) && port > 0 ? port : undefined;
  } catch {
    return undefined;
  }
}

async function clientFor(env: NodeJS.ProcessEnv, fetch: GuardedFetch, metadata: ServerMetadata, redirectUri: string): Promise<string> {
  const cached = await readClientCache(env);
  // Redirect URIs match exactly, so a cached client is reused only for the very same URI.
  if (cached && cached.issuer === metadata.issuer && cached.redirectUri === redirectUri) return cached.clientId;
  const clientId = await registerClient(fetch, metadata, redirectUri, VERSION);
  await writeClientCache(env, { version: 1, issuer: metadata.issuer, clientId, redirectUri });
  return clientId;
}

export async function connect(options: ConnectOptions): Promise<ConnectResult> {
  const { env, now, print } = options;
  const fetch = programscapeFetch(options.fetch, REQUEST_TIMEOUT_MS);
  const metadata = await discover(fetch);
  const cached = await readClientCache(env);
  const pkce = createPkce();
  const state = randomState();
  const callback = await loopback(cached?.issuer === metadata.issuer ? cachedPort(cached.redirectUri) : undefined, () => state, options.waitMs ?? DEFAULT_WAIT_MS);
  try {
    const clientId = await clientFor(env, fetch, metadata, callback.redirectUri);
    const url = authorizationUrl(metadata, { clientId, redirectUri: callback.redirectUri, challenge: pkce.challenge, state });
    print("Connect programscape-router to your Programscape plan. Open this link to sign in and allow it:");
    print(url);
    const open = options.openBrowser === undefined ? systemBrowser : options.openBrowser;
    if (open) await Promise.resolve(open(url)).catch(() => undefined);
    const code = await callback.code;
    let tokens;
    try {
      tokens = await exchangeCode(fetch, metadata, { clientId, code, verifier: pkce.verifier, redirectUri: callback.redirectUri });
    } catch (error) {
      // A cached client Programscape no longer knows: forget it, so the next connect registers afresh.
      if (error instanceof ProgramscapeError && error.kind === "rejected") await deleteClientCache(env).catch(() => undefined);
      throw error;
    }
    const at = now();
    await writeTokenFile(env, {
      version: 1,
      issuer: metadata.issuer,
      clientId,
      accessToken: tokens.accessToken,
      ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
      ...(tokens.expiresIn !== undefined ? { expiresAt: new Date(at.getTime() + tokens.expiresIn * 1000).toISOString() } : {}),
      connectedAt: at.toISOString(),
    });
    const syncState = await readSyncState(env);
    if (syncState.off) {
      delete syncState.off;
      await writeSyncState(env, syncState);
    }
    return { tokenPath: tokenPath(env) };
  } finally {
    await callback.close();
  }
}

export interface DisconnectResult {
  wasConnected: boolean;
  /** True when Programscape confirmed the revocation; false when it could not be reached or has no endpoint. */
  revoked: boolean;
}

export async function disconnect(options: { env: NodeJS.ProcessEnv; fetch: FetchLike }): Promise<DisconnectResult> {
  const { env } = options;
  const tokens = await readTokenFile(env);
  let revoked = false;
  if (tokens) {
    try {
      const fetch = programscapeFetch(options.fetch, REQUEST_TIMEOUT_MS);
      const metadata = await discover(fetch);
      // Revoking the refresh token ends the grant; the access token is revoked too, so neither outlives this.
      const results = await Promise.all([
        tokens.refreshToken ? revoke(fetch, metadata, { clientId: tokens.clientId, token: tokens.refreshToken, hint: "refresh_token" }) : Promise.resolve(true),
        revoke(fetch, metadata, { clientId: tokens.clientId, token: tokens.accessToken, hint: "access_token" }),
      ]);
      revoked = results.every(Boolean);
    } catch {
      revoked = false;
    }
  }
  await deleteTokenFile(env);
  await deleteSyncState(env);
  return { wasConnected: Boolean(tokens), revoked };
}
