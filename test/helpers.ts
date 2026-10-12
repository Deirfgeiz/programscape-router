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
  exaSearch: "https://api.exa.ai/search",
  exaContents: "https://api.exa.ai/contents",
  firecrawlSearch: "https://api.firecrawl.dev/v2/search",
  firecrawlScrape: "https://api.firecrawl.dev/v2/scrape",
  firecrawlCredits: "https://api.firecrawl.dev/v2/team/credit-usage",
  keenableSearch: "https://api.keenable.ai/v1/search",
  keenableFetch: "https://api.keenable.ai/v1/fetch",
  parallelSearch: "https://api.parallel.ai/v1/search",
  parallelExtract: "https://api.parallel.ai/v1/extract",
  tavilySearch: "https://api.tavily.com/search",
  tavilyExtract: "https://api.tavily.com/extract",
  tavilyUsage: "https://api.tavily.com/usage",
} as const;

import { readFileSync } from "node:fs";

export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
}
