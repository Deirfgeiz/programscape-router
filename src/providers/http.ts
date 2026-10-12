import type { Balance, Outcome, ProviderId, ScrapeRequest, ScrapeResult, SearchRequest, SearchResult } from "../types.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface CallContext {
  key: string;
  fetch: FetchLike;
  timeoutMs: number;
}

export interface BalanceReading {
  balances: Balance[];
}

export interface ProviderAdapter {
  id: ProviderId;
  name: string;
  envVar: string;
  /** Official documentation each request shape was taken from. */
  docs: string[];
  search?: (req: SearchRequest, ctx: CallContext) => Promise<SearchResult[]>;
  scrape?: (req: ScrapeRequest, ctx: CallContext) => Promise<ScrapeResult>;
  /** Reads the account's own balance with the founder's key, where the provider publishes an endpoint. */
  balance?: (ctx: CallContext) => Promise<BalanceReading>;
  /** How long a balance reading stays fresh, to respect the provider's limits on that endpoint. */
  balanceTtlMs?: number;
}

export class ProviderCallError extends Error {
  readonly outcome: Exclude<Outcome, "ok">;
  readonly status: number | undefined;

  constructor(outcome: Exclude<Outcome, "ok">, message: string, status?: number) {
    super(message);
    this.name = "ProviderCallError";
    this.outcome = outcome;
    this.status = status;
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
}

/** One JSON request with a timeout. Throws ProviderCallError on every failure. */
export async function requestJson(ctx: CallContext, url: string, options: RequestOptions): Promise<unknown> {
  const init: RequestInit = {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers: {
      accept: "application/json",
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...options.headers,
    },
    signal: AbortSignal.timeout(ctx.timeoutMs),
  };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);

  let response: Response;
  try {
    response = await ctx.fetch(url, init);
  } catch (error) {
    if (isTimeout(error)) throw new ProviderCallError("timeout", `No answer within ${ctx.timeoutMs} ms`);
    throw new ProviderCallError("network_error", "Could not reach the provider");
  }

  let body: unknown;
  try {
    const text = await response.text();
    body = text.length > 0 ? JSON.parse(text) : undefined;
  } catch (error) {
    if (isTimeout(error)) throw new ProviderCallError("timeout", `No answer within ${ctx.timeoutMs} ms`);
    body = undefined;
  }

  if (!response.ok) {
    const outcome = options.classify?.(response.status, body) ?? classifyStatus(response.status);
    const detail = options.errorMessage?.(body) ?? genericErrorMessage(body);
    throw new ProviderCallError(outcome, detail ?? `HTTP ${response.status}`, response.status);
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

export function invalid(message: string): ProviderCallError {
  return new ProviderCallError("invalid_response", message);
}
