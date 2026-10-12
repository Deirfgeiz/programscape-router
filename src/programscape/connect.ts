/**
 * `programscape-router connect` and `disconnect`.
 *
 * connect: read Programscape's sign-in metadata, listen on 127.0.0.1 on a free port, register (or reuse) a public
 * client for exactly that redirect URI, open the browser at the authorization URL (and print it, for headless use),
 * take the code from the loopback redirect, exchange it with the PKCE verifier, and store the tokens with mode 600.
 *
 * disconnect: stop sync, revoke every readable local token pair and remove both keychain and file copies.
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
  inspectTokenFile,
  readClientCache,
  readSyncState,
  type TokenDeletion,
  type TokenLocation,
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
  /** Where the tokens were stored. */
  stored: TokenLocation;
}

/**
 * The command that opens `url` in the system browser. The URL is passed as one argument, with no shell, so `&` and
 * other characters in its query string reach the browser intact (on Windows, cmd's `start` would split at `&`).
 */
export function browserCommand(url: string, platform: NodeJS.Platform = process.platform): [string, string[]] {
  if (platform === "darwin") return ["open", [url]];
  if (platform === "win32") return ["rundll32", ["url.dll,FileProtocolHandler", url]];
  return ["xdg-open", [url]];
}

/** The system browser, best effort. The URL is printed as well, so a failure here changes nothing. */
export function systemBrowser(url: string): void {
  const [command, args] = browserCommand(url);
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true, windowsHide: true, shell: false });
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
    const stored = await writeTokenFile(env, {
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
    return { stored };
  } finally {
    await callback.close();
  }
}

export interface DisconnectResult {
  wasConnected: boolean;
  /** Whether the token store was readable before deletion, so an unseen grant can be ruled out. */
  tokenReadVerified: boolean;
  /** Whether a later router process is prevented from syncing balances with a token left behind. */
  automaticSyncDisabled: boolean;
  /** True when Programscape confirmed the revocation; false when it could not be reached or has no endpoint. */
  revoked: boolean;
  /** What happened to the local copies, read back afterwards. */
  local: TokenDeletion;
}

export async function disconnect(options: { env: NodeJS.ProcessEnv; fetch: FetchLike }): Promise<DisconnectResult> {
  const { env } = options;
  // Stop future automatic sync before attempting revocation or deletion. A failed disconnect keeps this marker;
  // only a new, successful connect clears it.
  const syncState = await readSyncState(env);
  syncState.off = { since: new Date().toISOString(), reason: "Programscape sync is off because disconnect was requested. Run `programscape-router connect` to turn it on again." };
  const offSaved = await writeSyncState(env, syncState).then(() => true, () => false);
  const inspected = await inspectTokenFile(env);
  let revoked = false;
  if (inspected.copies.length > 0) {
    try {
      const fetch = programscapeFetch(options.fetch, REQUEST_TIMEOUT_MS);
      const metadata = await discover(fetch);
      // A failed fallback cleanup can leave two different grants in the two stores. Revoke both.
      const results = await Promise.all(inspected.copies.flatMap((tokens) => [
        ...(tokens.refreshToken ? [revoke(fetch, metadata, { clientId: tokens.clientId, token: tokens.refreshToken, hint: "refresh_token" })] : []),
        revoke(fetch, metadata, { clientId: tokens.clientId, token: tokens.accessToken, hint: "access_token" }),
      ]));
      revoked = results.every(Boolean);
    } catch {
      revoked = false;
    }
  }
  const local = await deleteTokenFile(env);
  const complete = inspected.readVerified && local.gone && (revoked || inspected.copies.length === 0);
  if (complete) await deleteSyncState(env).catch(() => undefined);
  return {
    wasConnected: inspected.copies.length > 0,
    tokenReadVerified: inspected.readVerified,
    automaticSyncDisabled: offSaved || local.gone,
    revoked,
    local,
  };
}
