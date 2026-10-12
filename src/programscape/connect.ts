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
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
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
  ConnectionLockError,
  inspectTokenFile,
  readConnectionState,
  readClientCache,
  transitionConnection,
  TokenStoreOccupiedError,
  type TokenDeletion,
  type TokenLocation,
  tokenPath,
  writeClientCache,
  writeTokenFile,
  withConnectionLock,
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
  try {
    const fetch = programscapeFetch(options.fetch, REQUEST_TIMEOUT_MS);
    const attemptId = randomUUID();
    // Reserve this sign-in while locked, then release the lock for the browser wait. Disconnect can cancel it.
    await withConnectionLock(options.env, async () => {
      await connectPreflight(options.env);
      await transitionConnection(options.env, "begin-connect", false, attemptId);
    });
    return await connectAfterPreflight(options, fetch, attemptId);
  } catch (error) {
    if (error instanceof ConnectionLockError) throw new ProgramscapeError("refused", error.message);
    throw error;
  }
}

async function connectPreflight(env: NodeJS.ProcessEnv): Promise<void> {
  const state = await readConnectionState(env);
  if (state?.phase === "awaiting-consent") throw new ProgramscapeError("refused", "A Programscape sign-in is already in progress. Run `programscape-router disconnect` before starting another connect.");
  if (state?.phase === "sync-off") throw new ProgramscapeError("refused", "The prior Programscape sign-in has expired. Run `programscape-router disconnect` before connecting again.");
  if (state?.phase === "cleanup-needed") throw new ProgramscapeError("refused", "The prior Programscape connection needs cleanup. Run `programscape-router disconnect` before connecting again.");
  if (state?.phase === "connected") throw new ProgramscapeError("refused", "A Programscape connection is already stored. Run `programscape-router disconnect` before connecting again.");
  await ensureNoStoredToken(env);
}

async function ensureNoStoredToken(env: NodeJS.ProcessEnv): Promise<void> {
  const existing = await inspectTokenFile(env);
  if (existing.hasLocalEntry) throw new ProgramscapeError("refused", "A Programscape token is already stored. Run `programscape-router disconnect` before connecting again.");
  if (existing.keychainOpenFailed || (existing.keychainLoaded && !existing.keychainReadable && !existing.keychainBackendUnavailable)) {
    throw new ProgramscapeError("refused", "Could not check the OS keychain for an existing Programscape connection. Unlock or repair it, then run `programscape-router disconnect` before connecting again.");
  }
}

async function connectAfterPreflight(options: ConnectOptions, fetch: GuardedFetch, attemptId: string): Promise<ConnectResult> {
  const { env, print } = options;
  let callback: Callback | undefined;
  let exchangeStarted = false;
  try {
    const metadata = await discover(fetch);
    const cached = await readClientCache(env);
    const pkce = createPkce();
    const state = randomState();
    callback = await loopback(cached?.issuer === metadata.issuer ? cachedPort(cached.redirectUri) : undefined, () => state, options.waitMs ?? DEFAULT_WAIT_MS);
    const activeCallback = callback;
    const clientId = await clientFor(env, fetch, metadata, activeCallback.redirectUri);
    const url = authorizationUrl(metadata, { clientId, redirectUri: activeCallback.redirectUri, challenge: pkce.challenge, state });
    print("Connect programscape-router to your Programscape plan. Open this link to sign in and allow it:");
    print(url);
    const open = options.openBrowser === undefined ? systemBrowser : options.openBrowser;
    if (open) await Promise.resolve(open(url)).catch(() => undefined);
    const code = await activeCallback.code;
    return await withConnectionLock(env, async () => {
      // A disconnect while the browser waited removes this attempt. A later connect has a different ID.
      const current = await readConnectionState(env);
      if (current?.phase !== "awaiting-consent" || current.attemptId !== attemptId) {
        throw new ProgramscapeError("refused", "This sign-in was canceled by a connection change. Run `programscape-router disconnect` before starting another connect.");
      }
      await ensureNoStoredToken(env);
      await transitionConnection(env, "begin-exchange");
      exchangeStarted = true;
      return finishConnect(options, fetch, metadata, { clientId, code, verifier: pkce.verifier, redirectUri: activeCallback.redirectUri });
    });
  } catch (error) {
    if (!exchangeStarted) {
      await withConnectionLock(env, async () => {
        const current = await readConnectionState(env);
        if (current?.phase === "awaiting-consent" && current.attemptId === attemptId) await transitionConnection(env, "cancel-connect");
      }).catch(() => undefined);
    }
    throw error;
  } finally {
    await callback?.close();
  }
}

async function finishConnect(
  options: ConnectOptions,
  fetch: GuardedFetch,
  metadata: ServerMetadata,
  authorization: { clientId: string; code: string; verifier: string; redirectUri: string },
): Promise<ConnectResult> {
    const { env, now } = options;
    let tokens;
    try {
      tokens = await exchangeCode(fetch, metadata, authorization);
    } catch (error) {
      if (error instanceof ProgramscapeError && error.kind === "rejected") {
        await transitionConnection(env, "connect-rejected");
        // A cached client Programscape no longer knows: forget it, so the next connect registers afresh.
        await deleteClientCache(env).catch(() => undefined);
        throw error;
      }
      throw new ProgramscapeError("unreachable", "Could not confirm whether Programscape issued a sign-in token. Run `programscape-router disconnect`; it will clear local state and tell you how to check remote access.");
    }
    const at = now();
    let stored: TokenLocation | undefined;
    try {
      stored = await writeTokenFile(env, {
        version: 1,
        issuer: metadata.issuer,
        clientId: authorization.clientId,
        accessToken: tokens.accessToken,
        ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
        ...(tokens.expiresIn !== undefined ? { expiresAt: new Date(at.getTime() + tokens.expiresIn * 1000).toISOString() } : {}),
        connectedAt: at.toISOString(),
      }, { requireEmpty: true });
      await transitionConnection(env, "connect-succeeded");
    } catch (error) {
      const occupied = error instanceof TokenStoreOccupiedError;
      const rollback = await Promise.allSettled([
        ...(tokens.refreshToken ? [revoke(fetch, metadata, { clientId: authorization.clientId, token: tokens.refreshToken, hint: "refresh_token" })] : []),
        revoke(fetch, metadata, { clientId: authorization.clientId, token: tokens.accessToken, hint: "access_token" }),
      ]);
      const revoked = rollback.every((result) => result.status === "fulfilled" && result.value);
      // A later local-state failure can happen after the token was saved. A revoked token must be removed too.
      const local = stored ? await deleteTokenFile(env).catch(() => undefined) : undefined;
      if (revoked && ((occupied && !stored) || local?.gone || (!stored && !occupied && !(await inspectTokenFile(env)).hasLocalEntry))) {
        await transitionConnection(env, "connect-rejected").catch(() => undefined);
      }
      throw new ProgramscapeError(
        "refused",
        occupied
          ? revoked
            ? "Another Programscape connection was stored during sign-in. Run `programscape-router disconnect` before connecting again."
            : "Another Programscape connection was stored during sign-in, and the new grant could not be confirmed revoked. Run `programscape-router disconnect` and check Apps connected to your plan on programscape.com (My plans)."
          : revoked
            ? "Could not finish the Programscape sign-in. The new grant was revoked; run `programscape-router disconnect` before trying again if a local entry remains."
            : "Could not save the Programscape sign-in tokens, and the new grant could not be confirmed revoked. Run `programscape-router disconnect` and check Apps connected to your plan on programscape.com (My plans).",
      );
    }
    return { stored };
}

export interface DisconnectResult {
  outcome: "nothing-to-do" | "disconnected" | "remote-unverified" | "local-incomplete";
  /** Number of readable token pairs presented for remote revocation. */
  knownGrants: number;
  /** Store-by-store cleanup detail. */
  local: TokenDeletion;
}

export async function disconnect(options: { env: NodeJS.ProcessEnv; fetch: FetchLike }): Promise<DisconnectResult> {
  try {
    return await withConnectionLock(options.env, () => disconnectUnlocked(options));
  } catch (error) {
    if (error instanceof ConnectionLockError) throw new ProgramscapeError("refused", error.message);
    throw error;
  }
}

async function disconnectUnlocked(options: { env: NodeJS.ProcessEnv; fetch: FetchLike }): Promise<DisconnectResult> {
  const { env } = options;
  const previous = await readConnectionState(env);
  const inspected = await inspectTokenFile(env);
  // This write gates auto-sync before the first revocation or local deletion. A crash leaves cleanup-needed,
  // and a later disconnect can finish it without manual file edits.
  await transitionConnection(env, "begin-disconnect", previous?.keychainMayHoldGrant ?? inspected.keychainLoaded);
  let revokedKnown = inspected.copies.length === 0 && (!previous || previous.phase === "awaiting-consent");
  if (inspected.copies.length > 0) {
    try {
      const fetch = programscapeFetch(options.fetch, REQUEST_TIMEOUT_MS);
      const metadata = await discover(fetch);
      // A failed fallback cleanup can leave two different grants in the two stores. Revoke both.
      const results = await Promise.all(inspected.copies.flatMap((tokens) => [
        ...(tokens.refreshToken ? [revoke(fetch, metadata, { clientId: tokens.clientId, token: tokens.refreshToken, hint: "refresh_token" })] : []),
        revoke(fetch, metadata, { clientId: tokens.clientId, token: tokens.accessToken, hint: "access_token" }),
      ]));
      revokedKnown = results.every(Boolean);
    } catch {
      revokedKnown = false;
    }
  }
  const deleted = await deleteTokenFile(env);
  // A connection made without a working keychain never placed a token there. The marker records this before any
  // later rotation can try the keychain, so a file-only disconnect still works on machines with no keychain.
  const fileVerified = !inspected.hasLocalEntry || Boolean(inspected.tokens);
  const fileOnlyVerified = previous?.keychainMayHoldGrant === false && !inspected.keychainReadable && fileVerified && deleted.file !== "failed" && !existsSync(tokenPath(env));
  const local: TokenDeletion = fileOnlyVerified && !deleted.gone
    ? { keychain: "absent", file: deleted.file, gone: true }
    : deleted;
  const keychainCheckFailed = inspected.keychainOpenFailed || (inspected.keychainLoaded && !inspected.keychainReadable && !inspected.keychainBackendUnavailable);
  const neverConnectedHere = !previous && !inspected.hasLocalEntry && !keychainCheckFailed && deleted.file !== "failed";
  // A failed initial read means an unknown grant might need remote removal, but a successful read-back after
  // deletion still proves the machine is clear. Keep those two claims separate so one transient read failure
  // does not strand the founder in cleanup-needed.
  const localVerified = local.gone || fileOnlyVerified || neverConnectedHere;
  if (!localVerified) return { outcome: "local-incomplete", knownGrants: inspected.copies.length, local };
  await transitionConnection(env, "local-cleared");
  await deleteSyncState(env).catch(() => undefined);
  const remoteVerified = previous?.phase !== "cleanup-needed" && revokedKnown && (inspected.readVerified || fileOnlyVerified);
  const outcome = neverConnectedHere ? "nothing-to-do" : remoteVerified ? "disconnected" : "remote-unverified";
  return { outcome, knownGrants: inspected.copies.length, local };
}
