/**
 * A signed-in MCP session with Programscape: Streamable HTTP with `Authorization: Bearer <token>`, refreshing the
 * token when it is about to end (or Programscape answers 401), and storing the rotated refresh token.
 * When Programscape refuses the refresh, the token file is deleted and sync is off until `connect` runs again.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { VERSION } from "../version.js";
import { PROGRAMSCAPE_MCP_URL, ProgramscapeError } from "./guard.js";
import { type GuardedFetch, discover, refresh } from "./oauth.js";
import { type TokenFile, deleteTokenFile, readTokenFile, writeTokenFile } from "./store.js";

/** Refresh this long before the access token's end, so a call never starts with a token about to lapse. */
const REFRESH_MARGIN_MS = 60_000;

export const RECONNECT_MESSAGE =
  "Programscape sync is off: Programscape no longer accepts this router's sign-in (it expired or was revoked). " +
  "Run `programscape-router connect` to turn it back on.";

export interface ConnectionOptions {
  env: NodeJS.ProcessEnv;
  fetch: GuardedFetch;
  now: () => Date;
  /** Called once when Programscape refuses the refresh, after the token file is deleted. */
  onRejected: () => Promise<void>;
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

function toolOutput(result: unknown): unknown {
  if (!isRecord(result)) throw new ProgramscapeError("invalid", "Programscape answered with an unreadable tool result.");
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
    if (!stored) throw new ProgramscapeError("rejected", "Programscape sync is not connected. Run `programscape-router connect`.");
    // Another process may have rotated the tokens since this one read them: the file is the truth.
    this.tokens = stored;
    const endsAt = stored.expiresAt ? Date.parse(stored.expiresAt) : Number.NaN;
    const fresh = Number.isNaN(endsAt) || endsAt - now().getTime() > REFRESH_MARGIN_MS;
    if (fresh && !force) return stored.accessToken;
    if (!stored.refreshToken) return this.reject();

    const metadata = await discover(this.options.fetch);
    let next;
    try {
      next = await refresh(this.options.fetch, metadata, { clientId: stored.clientId, refreshToken: stored.refreshToken });
    } catch (error) {
      if (error instanceof ProgramscapeError && error.kind === "rejected") return this.reject();
      throw error;
    }
    const updated: TokenFile = {
      ...stored,
      accessToken: next.accessToken,
      // Refresh tokens rotate; keep the old one only if Programscape didn't send a new one.
      ...(next.refreshToken ? { refreshToken: next.refreshToken } : {}),
      ...(next.expiresIn !== undefined ? { expiresAt: new Date(now().getTime() + next.expiresIn * 1000).toISOString() } : {}),
    };
    if (next.expiresIn === undefined) delete updated.expiresAt;
    await writeTokenFile(env, updated);
    this.tokens = updated;
    return updated.accessToken;
  }

  private async reject(): Promise<never> {
    await deleteTokenFile(this.options.env);
    this.tokens = undefined;
    await this.options.onRejected();
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
        return toolOutput(await active.callTool({ name, arguments: args }));
      } catch (error) {
        if (!isUnauthorized(error)) throw wrap(error);
        active = await ensure(true);
        try {
          return toolOutput(await active.callTool({ name, arguments: args }));
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
