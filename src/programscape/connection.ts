/**
 * A signed-in MCP session with Programscape: Streamable HTTP with `Authorization: Bearer <token>`, refreshing the
 * token when it is about to end (or Programscape answers 401), and storing the rotated refresh token.
 * When Programscape refuses the refresh, sync turns off and the old pair stays available for `disconnect` to revoke.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { VERSION } from "../version.js";
import { PROGRAMSCAPE_MCP_URL, ProgramscapeError } from "./guard.js";
import { type GuardedFetch, discover, refresh, revoke } from "./oauth.js";
import { type TokenFile, ConnectionLockError, readConnectionState, readTokenFile, transitionConnection, withConnectionLock, writeTokenFile } from "./store.js";

/** Refresh this long before the access token's end, so a call never starts with a token about to lapse. */
const REFRESH_MARGIN_MS = 60_000;

export const RECONNECT_MESSAGE =
  "Programscape sync is off: Programscape no longer accepts this router's sign-in (it expired or was revoked). " +
  "Run `programscape-router disconnect`, then `programscape-router connect` to sign in again.";

export const REMOTE_UNCERTAIN_MESSAGE =
  "Programscape may have issued tokens that the router could not save. Run `programscape-router disconnect`; it clears local state and tells you how to check Apps connected to your plan on programscape.com (My plans).";

function sameGrant(a: TokenFile | undefined, b: TokenFile): boolean {
  return a?.clientId === b.clientId && a.accessToken === b.accessToken && a.refreshToken === b.refreshToken;
}

export interface ConnectionOptions {
  env: NodeJS.ProcessEnv;
  fetch: GuardedFetch;
  now: () => Date;
}

export type CallTool = (name: string, args: Record<string, unknown>) => Promise<unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Programscape's own words from a tool error, kept short and on one line. */
function toolErrorWords(result: Record<string, unknown>): string {
  const first = Array.isArray(result.content) ? result.content.find(isRecord) : undefined;
  const words = first && typeof first.text === "string" ? first.text.replace(/\s+/g, " ").trim() : "";
  return words.length > 500 ? `${words.slice(0, 497)}...` : words || "Programscape refused the call.";
}

function toolOutput(name: string, result: unknown): unknown {
  if (!isRecord(result)) throw new ProgramscapeError("invalid", "Programscape answered with an unreadable tool result.");
  // The hosted MCP marks an ambiguous read as a tool error so older routers never read it as an empty plan.
  // Keep its typed choices for the current sync's actionable selection error; every other tool error still refuses.
  if (name === "my_plan" && isRecord(result.structuredContent) && result.structuredContent.selectionRequired === true) return result.structuredContent;
  if (result.isError === true) throw new ProgramscapeError("refused", toolErrorWords(result));
  if (result.structuredContent !== undefined) return result.structuredContent;
  const first = Array.isArray(result.content) ? result.content.find(isRecord) : undefined;
  if (first && typeof first.text === "string") {
    try {
      return JSON.parse(first.text);
    } catch {
      return first.text;
    }
  }
  return undefined;
}

export class Connection {
  private readonly options: ConnectionOptions;
  private tokens: TokenFile | undefined;

  constructor(options: ConnectionOptions) {
    this.options = options;
  }

  /** The tokens on disk, refreshed when they end within a minute (or when `force`). */
  private async accessToken(force: boolean): Promise<string> {
    const { env, now } = this.options;
    const stored = await readTokenFile(env);
    const state = await readConnectionState(env);
    if (state?.phase === "cleanup-needed") throw new ProgramscapeError("refused", REMOTE_UNCERTAIN_MESSAGE);
    if (state?.phase === "sync-off") throw new ProgramscapeError("rejected", RECONNECT_MESSAGE);
    if (!stored) throw new ProgramscapeError("rejected", "Programscape sync is not connected. Run `programscape-router connect`.");
    if (state?.phase !== "connected") throw new ProgramscapeError("refused", "Programscape connection state needs repair. Run `programscape-router disconnect`.");
    // Another process may have rotated the tokens: reread the authoritative file, or the keychain if there is no file.
    this.tokens = stored;
    const endsAt = stored.expiresAt ? Date.parse(stored.expiresAt) : Number.NaN;
    const fresh = Number.isNaN(endsAt) || endsAt - now().getTime() > REFRESH_MARGIN_MS;
    if (fresh && !force) return stored.accessToken;
    try {
      return await withConnectionLock(env, async () => {
        const current = await readTokenFile(env);
        const state = await readConnectionState(env);
        if (state?.phase === "cleanup-needed") throw new ProgramscapeError("refused", REMOTE_UNCERTAIN_MESSAGE);
        if (!current || state?.phase !== "connected") throw new ProgramscapeError("rejected", RECONNECT_MESSAGE);
        const currentEndsAt = current.expiresAt ? Date.parse(current.expiresAt) : Number.NaN;
        if (!sameGrant(current, stored) && (Number.isNaN(currentEndsAt) || currentEndsAt - now().getTime() > REFRESH_MARGIN_MS)) {
          this.tokens = current;
          return current.accessToken;
        }
        if (!current.refreshToken) return this.rejectUnlocked(current);
        const metadata = await discover(this.options.fetch);
        await transitionConnection(env, "begin-refresh");
        let next;
        try {
          next = await refresh(this.options.fetch, metadata, { clientId: current.clientId, refreshToken: current.refreshToken });
        } catch (error) {
          if (error instanceof ProgramscapeError && error.kind === "rejected") {
            await transitionConnection(env, "refresh-refused");
            return this.rejectUnlocked(current);
          }
          throw new ProgramscapeError("unreachable", "Could not confirm whether Programscape issued rotated tokens. Run `programscape-router disconnect`; it will clear local state and tell you how to check remote access.");
        }
        const updated: TokenFile = {
          ...current,
          accessToken: next.accessToken,
          ...(next.refreshToken ? { refreshToken: next.refreshToken } : {}),
          ...(next.expiresIn !== undefined ? { expiresAt: new Date(now().getTime() + next.expiresIn * 1000).toISOString() } : {}),
        };
        if (next.expiresIn === undefined) delete updated.expiresAt;
        try {
          await writeTokenFile(env, updated);
          await transitionConnection(env, "refresh-succeeded");
        } catch {
          const rollback = await Promise.allSettled([
            ...(next.refreshToken ? [revoke(this.options.fetch, metadata, { clientId: current.clientId, token: next.refreshToken, hint: "refresh_token" })] : []),
            revoke(this.options.fetch, metadata, { clientId: current.clientId, token: next.accessToken, hint: "access_token" }),
          ]);
          const revoked = rollback.every((result) => result.status === "fulfilled" && result.value);
          if (revoked) await transitionConnection(env, "refresh-refused").catch(() => undefined);
          throw new ProgramscapeError("refused", `Could not save Programscape's rotated tokens. ${revoked ? "The new tokens were revoked." : "The new tokens could not be confirmed revoked."} Run \`programscape-router disconnect\`${revoked ? "." : " and check Apps connected to your plan on programscape.com (My plans)."}`);
        }
        this.tokens = updated;
        return updated.accessToken;
      });
    } catch (error) {
      if (error instanceof ConnectionLockError) throw new ProgramscapeError("refused", error.message);
      throw error;
    }
  }

  private async rejectUnlocked(expected: TokenFile): Promise<never> {
    const current = await readTokenFile(this.options.env);
    const state = await readConnectionState(this.options.env);
    if (sameGrant(current, expected) && state?.phase === "connected") {
      await transitionConnection(this.options.env, "begin-refresh");
      await transitionConnection(this.options.env, "refresh-refused");
    }
    this.tokens = undefined;
    throw new ProgramscapeError("rejected", RECONNECT_MESSAGE);
  }

  private async reject(expected: TokenFile | undefined = this.tokens): Promise<never> {
    try {
      await withConnectionLock(this.options.env, async () => {
        if (expected) await this.rejectUnlocked(expected);
      });
    } catch (error) {
      if (!(error instanceof ConnectionLockError)) throw error;
    }
    this.tokens = undefined;
    throw new ProgramscapeError("rejected", RECONNECT_MESSAGE);
  }

  /** The tokens this connection currently holds, for redacting them from anything that might be printed. */
  secrets(): string[] {
    return [this.tokens?.accessToken, this.tokens?.refreshToken].filter((value): value is string => Boolean(value));
  }

  private async open(token: string): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(new URL(PROGRAMSCAPE_MCP_URL), {
      fetch: this.options.fetch,
      requestInit: { headers: { authorization: `Bearer ${token}` }, redirect: "manual" },
    });
    const client = new Client({ name: "programscape-router", version: VERSION });
    await client.connect(transport);
    return client;
  }

  /**
   * Opens one MCP session and hands `use` a tool caller. A 401 refreshes the token and retries that call once.
   */
  async session<T>(use: (call: CallTool) => Promise<T>): Promise<T> {
    let client: Client | undefined;
    const ensure = async (force: boolean): Promise<Client> => {
      if (client && !force) return client;
      await client?.close().catch(() => undefined);
      client = undefined;
      const token = await this.accessToken(force);
      try {
        client = await this.open(token);
      } catch (error) {
        if (!force && isUnauthorized(error)) return ensure(true);
        throw wrap(error);
      }
      return client;
    };
    const call: CallTool = async (name, args) => {
      let active = await ensure(false);
      try {
        return toolOutput(name, await active.callTool({ name, arguments: args }));
      } catch (error) {
        if (!isUnauthorized(error)) throw wrap(error);
        active = await ensure(true);
        try {
          return toolOutput(name, await active.callTool({ name, arguments: args }));
        } catch (retryError) {
          if (isUnauthorized(retryError)) return this.reject();
          throw wrap(retryError);
        }
      }
    };
    try {
      return await use(call);
    } finally {
      await client?.close().catch(() => undefined);
    }
  }
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof StreamableHTTPError && error.code === 401;
}

/** Anything that isn't already one of ours becomes a fixed message: SDK errors may quote a response body. */
function wrap(error: unknown): ProgramscapeError {
  if (error instanceof ProgramscapeError) return error;
  if (error instanceof StreamableHTTPError) {
    return new ProgramscapeError("unreachable", `Programscape's MCP endpoint answered HTTP ${error.code ?? "error"}.`, error.code);
  }
  return new ProgramscapeError("unreachable", "The call to Programscape's MCP endpoint failed.");
}
