/** Every provider the router has an adapter for, alphabetically. Order here is not a preference. */
export const PROVIDER_IDS = ["exa", "firecrawl", "keenable", "linkup", "parallel", "tavily", "youcom"] as const;
/** One of PROVIDER_IDS. */
export type ProviderId = (typeof PROVIDER_IDS)[number];

/** What a provider can be asked to do. */
export const CAPABILITIES = ["search", "scrape"] as const;
/** One of CAPABILITIES. */
export type Capability = (typeof CAPABILITIES)[number];

/** A web search. */
export interface SearchRequest {
  /** What to search for. Must not be empty. */
  query: string;
  /** Upper bound on results. Each provider's own maximum still applies. Default 10. */
  maxResults?: number;
}

/** One page to fetch as markdown. */
export interface ScrapeRequest {
  /** An absolute http(s) URL. */
  url: string;
}

/** One search hit, as the serving provider returned it. */
export interface SearchResult {
  title: string;
  url: string;
  /** The provider's excerpt or description, when it gave one. */
  snippet?: string;
  /** ISO 8601, when the provider gave a publication date. */
  publishedAt?: string;
}

/** One fetched page. */
export interface ScrapeResult {
  /** The page URL the provider reports (after its redirects), or the requested URL. */
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

/** One provider tried for a call, and how it ended. */
export interface Attempt {
  provider: ProviderId;
  outcome: Outcome;
  /** The provider's HTTP status, when it answered with an error status. */
  status?: number;
  /** The provider's error message, with keys redacted. */
  message?: string;
}

/** "credits-ending-first" (the default) or "your-order" (an order from config). */
export type OrderRule = "your-order" | "credits-ending-first";

/** Which provider served a call, why it held its position, and every provider tried. */
export interface Routing {
  provider: ProviderId;
  /** Why this provider held its position in the order. */
  reason: string;
  rule: OrderRule;
  tried: Attempt[];
}

/** What router.search() returns. */
export interface SearchResponse {
  results: SearchResult[];
  routing: Routing;
}

/** What router.scrape() returns. */
export interface ScrapeResponse {
  result: ScrapeResult;
  routing: Routing;
}

/** Plan or award credits, a pay-as-you-go limit, or a limit set on one key. */
export type BalanceKind = "credits" | "pay-as-you-go" | "key-limit";

/**
 * One balance, exactly as a provider reported it or as the founder entered it (in config, or on their Programscape
 * plan). Balances are never added together: each keeps its own unit.
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
  /**
   * "provider": read live from the provider's own endpoint. "config": entered in the config file. "plan": the
   * founder's own expiration date and award on their Programscape plan, read by the opt-in sync (a config date wins).
   */
  source: "provider" | "config" | "plan";
  /** When the provider reported it. */
  asOf?: string;
  /**
   * True for a reading shown for information only: it never places the provider in the order, never counts toward a
   * runway, and is never sent to a Programscape plan. Bright Data's paid balance is one when it reads $0, since
   * Bright Data doesn't report the free monthly credits that may still be left.
   */
  informational?: true;
}
