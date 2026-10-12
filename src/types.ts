export const PROVIDER_IDS = ["exa", "firecrawl", "keenable", "parallel", "tavily"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const CAPABILITIES = ["search", "scrape"] as const;
export type Capability = (typeof CAPABILITIES)[number];

export interface SearchRequest {
  query: string;
  /** Upper bound on results. Each provider's own maximum still applies. Default 10. */
  maxResults?: number;
}

export interface ScrapeRequest {
  url: string;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet?: string;
  publishedAt?: string;
}

export interface ScrapeResult {
  url: string;
  title?: string;
  markdown: string;
}

/**
 * What happened when the router asked one provider. `ok` ends the call; every other
 * outcome either fails over to the next provider or (for `bad_request`) stops.
 */
export type Outcome =
  | "ok"
  | "exhausted" // credits or quota spent (402, or a provider's documented quota error)
  | "rate_limited" // 429
  | "server_error" // 5xx
  | "timeout"
  | "network_error"
  | "unauthorized" // 401/403: bad, disabled or revoked key
  | "bad_request" // 400/422: the request itself was rejected; no failover
  | "rejected" // the provider refused this content (policy), not the key
  | "fetch_failed" // the provider could not fetch the target page
  | "invalid_response" // the provider answered 2xx with a shape we could not read
  | "provider_error"; // any other non-2xx

export interface Attempt {
  provider: ProviderId;
  outcome: Outcome;
  status?: number;
  message?: string;
}

export type OrderRule = "your-order" | "credits-ending-first";

export interface Routing {
  provider: ProviderId;
  /** Why this provider held its position in the order. */
  reason: string;
  rule: OrderRule;
  tried: Attempt[];
}

export interface SearchResponse {
  results: SearchResult[];
  routing: Routing;
}

export interface ScrapeResponse {
  result: ScrapeResult;
  routing: Routing;
}

export type BalanceKind = "credits" | "pay-as-you-go" | "key-limit";

/**
 * One balance, exactly as a provider reported it or as the founder entered it.
 * Balances are never added together: each keeps its own unit.
 */
export interface Balance {
  label: string;
  kind: BalanceKind;
  unit?: string;
  remaining?: number;
  /** The plan size or award the remaining amount is a share of. */
  total?: number;
  /** ISO date or date-time after which these credits end (or the billing period resets). */
  endsOn?: string;
  source: "provider" | "config";
  /** When the provider reported it. */
  asOf?: string;
}
