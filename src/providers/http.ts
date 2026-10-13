import type { Balance, Capability, Outcome, ProviderId, ScrapeRequest, ScrapeResult, SearchRequest, SearchResult } from "../types.js";

/** A fetch implementation. The router never asks it to follow redirects. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface CallContext {
  key: string;
  fetch: FetchLike;
  timeoutMs: number;
  /**
   * For a provider whose calls also name a zone in the founder's account (Bright Data): the zone each capability's
   * requests go to, from its environment variable or config `providers.<id>.zones`. Zone names are not secrets.
   */
  zones?: Partial<Record<Capability, string>>;
}

export interface BalanceReading {
  balances: Balance[];
  /** Our own words about the reading (what it leaves out, or why there is none), shown with it in `status`. */
  note?: string;
}

export interface ProviderAdapter {
  id: ProviderId;
  name: string;
  envVar: string;
  /** Official documentation each request shape was taken from. */
  docs: string[];
  search?: (req: SearchRequest, ctx: CallContext) => Promise<SearchResult[]>;
  scrape?: (req: ScrapeRequest, ctx: CallContext) => Promise<ScrapeResult>;
  /**
   * Error codes the provider documents (tags, `code` fields), which `check` may show. Anything else a provider says
   * stays out of shareable output, since an error body can echo account details back.
   */
  errorCodes?: ReadonlyArray<string | RegExp>;
  /** Reads the account's own balance with the founder's key, where the provider publishes an endpoint. */
  balance?: (ctx: CallContext) => Promise<BalanceReading>;
  /** How long a balance reading stays fresh, to respect the provider's limits on that endpoint. */
  balanceTtlMs?: number;
  /**
   * Set when each capability also needs a zone in the founder's account (Bright Data): the environment variable that
   * names it, which wins over config `providers.<id>.zones`. Without its zone, a capability isn't set up: the router
   * skips the provider for it and `check` says how to set it up.
   */
  zoneEnvVars?: Partial<Record<Capability, string>>;
  /** What to run to set up a missing zone, in our own words. */
  zoneFix?: string;
}

/** Our own words that go with a failure. Never the provider's text, so they are safe to show and share. */
export interface CallErrorDetails {
  /** What to do. `check` shows it in place of the hint for the failure class. */
  fix?: string;
  /**
   * True when the provider can't serve another call this session because a setting is wrong (a zone that doesn't
   * exist), not the key: the router switches it off for the session, saying `fix`, and tries the next provider.
   */
  switchOff?: boolean;
}

export class ProviderCallError extends Error {
  readonly outcome: Exclude<Outcome, "ok">;
  readonly status: number | undefined;
  /** The provider's machine-readable error code (a tag or `code` field), when it gave one. Not yet allow-listed. */
  readonly code: string | undefined;
  /** Our own words on what to do, when the adapter knows better than the failure class. */
  readonly fix: string | undefined;
  /** True when the router should switch the provider off for the session (see CallErrorDetails). */
  readonly switchOff: boolean;

  constructor(outcome: Exclude<Outcome, "ok">, message: string, status?: number, code?: string, details: CallErrorDetails = {}) {
    super(message);
    this.name = "ProviderCallError";
    this.outcome = outcome;
    this.status = status;
    this.code = code;
    this.fix = details.fix;
    this.switchOff = details.switchOff === true;
  }
}

/** The shared reading of HTTP status codes. Adapters refine it with their documented error shapes. */
export function classifyStatus(status: number): Exclude<Outcome, "ok"> {
  if (status === 402) return "exhausted";
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 400 || status === 422) return "bad_request";
  if (status === 408) return "timeout";
  if (status >= 500) return "server_error";
  return "provider_error";
}

export interface RequestOptions {
  method?: "GET" | "POST";
  headers: Record<string, string>;
  body?: unknown;
  /** Provider-specific reading of a non-2xx response. Return undefined to use classifyStatus. */
  classify?: (status: number, body: unknown) => Exclude<Outcome, "ok"> | undefined;
  /** Pull the provider's human-readable message out of its error body. */
  errorMessage?: (body: unknown) => string | undefined;
  /** Pull the provider's machine-readable error code out of its error body. */
  errorCode?: (body: unknown) => string | undefined;
  /**
   * Reads every answer, 2xx included, before the shared handling: for a provider that reports failures in response
   * headers or inside a 2xx body (Bright Data). Return an error to throw it, or undefined to carry on as usual.
   */
  inspect?: (answer: Answer) => ProviderCallError | undefined;
}

/** One answer as `inspect` sees it. `text` is the raw body, for a provider whose errors are plain text or HTML. */
export interface Answer {
  status: number;
  headers: Headers;
  /** The body parsed as JSON, or undefined when it is empty or not JSON. */
  body: unknown;
  text: string;
}

/** One JSON request with a timeout, never following redirects. Throws ProviderCallError on every failure. */
export async function requestJson(ctx: CallContext, url: string, options: RequestOptions): Promise<unknown> {
  const init: RequestInit = {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers: {
      accept: "application/json",
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...options.headers,
    },
    signal: AbortSignal.timeout(ctx.timeoutMs),
    // Never follow a redirect: fetch would re-send custom key headers such as x-api-key to whatever
    // host the Location names. A redirect is reported as a provider error instead.
    redirect: "manual",
  };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);

  let response: Response;
  try {
    response = await ctx.fetch(url, init);
  } catch (error) {
    if (isTimeout(error)) throw new ProviderCallError("timeout", `No answer within ${ctx.timeoutMs} ms`);
    throw new ProviderCallError("network_error", "Could not reach the provider");
  }

  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    await response.body?.cancel().catch(() => undefined);
    throw new ProviderCallError(
      "provider_error",
      "The provider answered with a redirect, which is not followed so the key never leaves the provider's own API",
      response.status || undefined,
    );
  }

  let body: unknown;
  let text = "";
  try {
    text = await response.text();
    body = text.length > 0 ? JSON.parse(text) : undefined;
  } catch (error) {
    if (isTimeout(error)) throw new ProviderCallError("timeout", `No answer within ${ctx.timeoutMs} ms`);
    body = undefined;
  }

  const inspected = options.inspect?.({ status: response.status, headers: response.headers, body, text });
  if (inspected) throw inspected;

  if (!response.ok) {
    const outcome = options.classify?.(response.status, body) ?? classifyStatus(response.status);
    const detail = options.errorMessage?.(body) ?? genericErrorMessage(body);
    const code = options.errorCode?.(body);
    throw new ProviderCallError(outcome, detail ?? `HTTP ${response.status}`, response.status, typeof code === "string" ? code : undefined);
  }
  if (body === undefined) {
    throw new ProviderCallError("invalid_response", "The provider answered with an empty or non-JSON body", response.status);
  }
  return body;
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

function genericErrorMessage(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  if (typeof body.error === "string") return body.error;
  if (typeof body.message === "string") return body.message;
  if (isRecord(body.error) && typeof body.error.message === "string") return body.error.message;
  if (isRecord(body.detail) && typeof body.detail.error === "string") return body.detail.error;
  if (typeof body.detail === "string") return body.detail;
  return undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Normalize a provider date to ISO 8601, or leave it out when it cannot be read. */
export function isoDate(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Unix seconds.
    return new Date(value * 1000).toISOString();
  }
  const text = str(value);
  if (!text) return undefined;
  const time = Date.parse(text);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

export function clampResults(requested: number | undefined, max: number): number {
  const wanted = requested === undefined ? 10 : Math.floor(requested);
  return Math.min(Math.max(wanted, 1), max);
}

/** Whether `code` is one of the adapter's documented error codes. */
export function isDocumentedCode(adapter: Pick<ProviderAdapter, "errorCodes">, code: string | undefined): code is string {
  if (!code || code.length > 64) return false;
  return (adapter.errorCodes ?? []).some((allowed) => (typeof allowed === "string" ? allowed === code : allowed.test(code)));
}

export function invalid(message: string): ProviderCallError {
  return new ProviderCallError("invalid_response", message);
}
