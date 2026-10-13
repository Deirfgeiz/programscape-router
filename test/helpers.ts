import type { FetchLike } from "../src/providers/index.js";

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  redirect: RequestInit["redirect"];
}

export type Responder = (call: RecordedCall) => Response | Promise<Response>;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/**
 * A fetch stand-in. Routes are matched by URL prefix; the first match answers.
 * A route may hold a list of responders, used one per call (the last repeats).
 */
export function mockFetch(routes: Record<string, Responder | Responder[]>) {
  const calls: RecordedCall[] = [];
  const counters = new Map<string, number>();
  const fetch: FetchLike = async (input, init = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const call: RecordedCall = {
      url: String(input),
      method: init.method ?? "GET",
      headers,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      redirect: init.redirect,
    };
    calls.push(call);
    const prefix = Object.keys(routes)
      .filter((candidate) => call.url.startsWith(candidate))
      .sort((a, b) => b.length - a.length)[0];
    if (prefix === undefined) throw new Error(`unmocked fetch: ${call.method} ${call.url}`);
    const route = routes[prefix] as Responder | Responder[];
    if (!Array.isArray(route)) return route(call);
    const index = counters.get(prefix) ?? 0;
    counters.set(prefix, index + 1);
    const responder = route[Math.min(index, route.length - 1)] as Responder;
    return responder(call);
  };
  return { fetch, calls };
}

export const ok = (body: unknown): Responder => () => json(body);
export const status = (code: number, body: unknown = { error: `HTTP ${code}` }): Responder => () => json(body, code);
export const timeout: Responder = () => {
  throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
};

export const URLS = {
  /** Bright Data's search and scrape both go here; brightdata() tells them apart by the request body. */
  brightdataRequest: "https://api.brightdata.com/request",
  brightdataBalance: "https://api.brightdata.com/customer/balance",
  exaSearch: "https://api.exa.ai/search",
  exaContents: "https://api.exa.ai/contents",
  firecrawlSearch: "https://api.firecrawl.dev/v2/search",
  firecrawlScrape: "https://api.firecrawl.dev/v2/scrape",
  firecrawlCredits: "https://api.firecrawl.dev/v2/team/credit-usage",
  keenableSearch: "https://api.keenable.ai/v1/search",
  keenableFetch: "https://api.keenable.ai/v1/fetch",
  linkupSearch: "https://api.linkup.so/v1/search",
  linkupFetch: "https://api.linkup.so/v1/fetch",
  linkupBalance: "https://api.linkup.so/v1/credits/balance",
  parallelSearch: "https://api.parallel.ai/v1/search",
  parallelExtract: "https://api.parallel.ai/v1/extract",
  tavilySearch: "https://api.tavily.com/search",
  tavilyExtract: "https://api.tavily.com/extract",
  tavilyUsage: "https://api.tavily.com/usage",
  youcomSearch: "https://ydc-index.io/v1/search",
  youcomContents: "https://ydc-index.io/v1/contents",
  youcomBalance: "https://api.you.com/v1/billing/account_balance",
} as const;

/** Bright Data's zone endpoints, used only by `keys set brightdata`. Kept out of URLS, which lists the call endpoints. */
export const BRIGHTDATA_ZONE_URLS = {
  list: "https://api.brightdata.com/zone/get_active_zones",
  create: "https://api.brightdata.com/zone",
} as const;

/** The zones tests give Bright Data, through its environment variables. */
export const BRIGHTDATA_ZONES = { BRIGHTDATA_SERP_ZONE: "programscape_serp", BRIGHTDATA_UNLOCKER_ZONE: "web_unlocker1" } as const;

/** Answers Bright Data's /request: a search (format "raw") with `search`, a page read (format "json") with `scrape`. */
export function brightdata(search: Responder, scrape: Responder): Responder {
  return (call) => ((call.body as { format?: string } | undefined)?.format === "raw" ? search(call) : scrape(call));
}

/** A 200 that carries Bright Data's failure in its headers, with an empty body (as a captcha came back live). */
export function brdHeaders(headers: Record<string, string>, body = ""): Responder {
  return () => new Response(body, { status: 200, headers });
}

import { readFileSync } from "node:fs";

export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
}
