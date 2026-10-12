import { describe, expect, it } from "vitest";
import { ADAPTERS, type CallContext, ProviderCallError } from "../src/providers/index.js";
import { URLS, fixture, json, mockFetch, ok, status } from "./helpers.js";

function ctx(fetch: CallContext["fetch"], key = "test-key"): CallContext {
  return { key, fetch, timeoutMs: 5000 };
}

async function failure(promise: Promise<unknown>): Promise<ProviderCallError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ProviderCallError) return error;
    throw error;
  }
  throw new Error("expected a ProviderCallError");
}

describe("Exa", () => {
  it("maps search requests and results", async () => {
    const { fetch, calls } = mockFetch({ [URLS.exaSearch]: ok(fixture("exa-search")) });
    const results = await ADAPTERS.exa.search!({ query: "llm survey", maxResults: 5 }, ctx(fetch));
    expect(calls[0]).toMatchObject({
      url: "https://api.exa.ai/search",
      method: "POST",
      headers: { "x-api-key": "test-key", "content-type": "application/json" },
      body: { query: "llm survey", numResults: 5, contents: { highlights: true } },
    });
    expect(results).toEqual([
      {
        title: "A Comprehensive Overview of Large Language Models",
        url: "https://arxiv.org/pdf/2307.06435.pdf",
        snippet: "Such requirements have limited their adoption...",
        publishedAt: "2023-11-16T01:36:32.547Z",
      },
      { title: "No date", url: "https://example.com/b", snippet: "A summary." },
    ]);
  });

  it("maps contents to a scrape result", async () => {
    const { fetch, calls } = mockFetch({ [URLS.exaContents]: ok(fixture("exa-contents")) });
    const result = await ADAPTERS.exa.scrape!({ url: "https://example.com/" }, ctx(fetch));
    expect(calls[0]?.body).toEqual({ urls: ["https://example.com/"], text: true });
    expect(result).toEqual({ url: "https://example.com/", title: "Example Domain", markdown: "# Example Domain\n\nThis domain is for use in examples." });
  });

  it("reads a per-URL error status as a failed fetch", async () => {
    const { fetch } = mockFetch({
      [URLS.exaContents]: ok({ results: [], statuses: [{ id: "x", status: "error", error: { tag: "CRAWL_TIMEOUT", httpStatusCode: 408 } }] }),
    });
    const error = await failure(ADAPTERS.exa.scrape!({ url: "https://example.com/" }, ctx(fetch)));
    expect(error.outcome).toBe("fetch_failed");
    expect(error.message).toBe("Exa could not fetch the page (CRAWL_TIMEOUT); the page answered HTTP 408");
    // The target page's status is not Exa's own HTTP status.
    expect(error.status).toBeUndefined();
  });

  it("reads 402 NO_MORE_CREDITS as exhausted and a content-policy 403 as rejected", async () => {
    const credits = mockFetch({ [URLS.exaSearch]: status(402, { requestId: "r", error: "No more credits", tag: "NO_MORE_CREDITS" }) });
    expect((await failure(ADAPTERS.exa.search!({ query: "q" }, ctx(credits.fetch)))).outcome).toBe("exhausted");
    const policy = mockFetch({ [URLS.exaSearch]: status(403, { requestId: "r", error: "blocked", tag: "PROHIBITED_CONTENT" }) });
    expect((await failure(ADAPTERS.exa.search!({ query: "q" }, ctx(policy.fetch)))).outcome).toBe("rejected");
    // FEATURE_DISABLED: the endpoint is not on the plan. The key is fine, so the provider is not switched off.
    const feature = mockFetch({ [URLS.exaSearch]: status(403, { requestId: "r", error: "disabled", tag: "FEATURE_DISABLED" }) });
    const disabled = await failure(ADAPTERS.exa.search!({ query: "q" }, ctx(feature.fetch)));
    expect(disabled.outcome).toBe("provider_error");
    expect(disabled.message).toBe("disabled (FEATURE_DISABLED)");
    const key = mockFetch({ [URLS.exaSearch]: status(401, { requestId: "r", error: "Invalid API key", tag: "INVALID_API_KEY" }) });
    expect((await failure(ADAPTERS.exa.search!({ query: "q" }, ctx(key.fetch)))).outcome).toBe("unauthorized");
    const team = mockFetch({ [URLS.exaSearch]: status(402, { requestId: "r", error: "Team budget exceeded", tag: "TEAM_BUDGET_EXCEEDED" }) });
    expect((await failure(ADAPTERS.exa.search!({ query: "q" }, ctx(team.fetch)))).outcome).toBe("exhausted");
  });

  it("clamps maxResults to Exa's maximum", async () => {
    const { fetch, calls } = mockFetch({ [URLS.exaSearch]: ok({ results: [] }) });
    await ADAPTERS.exa.search!({ query: "q", maxResults: 500 }, ctx(fetch));
    expect((calls[0]?.body as { numResults: number }).numResults).toBe(100);
  });
});

describe("Firecrawl", () => {
  it("maps v2 search", async () => {
    const { fetch, calls } = mockFetch({ [URLS.firecrawlSearch]: ok(fixture("firecrawl-search")) });
    const results = await ADAPTERS.firecrawl.search!({ query: "web scraping" }, ctx(fetch));
    expect(calls[0]).toMatchObject({
      url: "https://api.firecrawl.dev/v2/search",
      method: "POST",
      headers: { authorization: "Bearer test-key" },
      body: { query: "web scraping", limit: 10, sources: [{ type: "web" }] },
    });
    expect(results).toEqual([{ title: "Page Title", url: "https://example.com/page", snippet: "Page description text" }]);
  });

  it("maps v2 scrape", async () => {
    const { fetch, calls } = mockFetch({ [URLS.firecrawlScrape]: ok(fixture("firecrawl-scrape")) });
    const result = await ADAPTERS.firecrawl.scrape!({ url: "https://example.com" }, ctx(fetch));
    expect(calls[0]?.body).toEqual({ url: "https://example.com", formats: ["markdown"], onlyMainContent: true });
    expect(result).toEqual({ url: "https://example.com/", title: "Example Page Title", markdown: "# Example Page\n\nBody text." });
  });

  it("reads the credit-usage endpoint as one balance with its billing period end", async () => {
    const { fetch, calls } = mockFetch({ [URLS.firecrawlCredits]: ok(fixture("firecrawl-credit-usage")) });
    const reading = await ADAPTERS.firecrawl.balance!(ctx(fetch));
    expect(calls[0]).toMatchObject({ method: "GET", headers: { authorization: "Bearer test-key" } });
    expect(reading.balances).toEqual([
      expect.objectContaining({
        kind: "credits",
        unit: "credits",
        remaining: 1000,
        total: 500000,
        endsOn: "2026-10-31T23:59:59.000Z",
        source: "provider",
      }),
    ]);
    expect(reading.balances[0]?.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("reads insufficient_credits as exhausted and success:false as a provider error", async () => {
    const spent = mockFetch({
      [URLS.firecrawlScrape]: status(402, { success: false, error: "Payment required to access this resource.", code: "insufficient_credits" }),
    });
    expect((await failure(ADAPTERS.firecrawl.scrape!({ url: "https://e.com" }, ctx(spent.fetch)))).outcome).toBe("exhausted");
    const soft = mockFetch({ [URLS.firecrawlScrape]: ok({ success: false, error: "nope" }) });
    expect((await failure(ADAPTERS.firecrawl.scrape!({ url: "https://e.com" }, ctx(soft.fetch)))).outcome).toBe("provider_error");
  });
});

describe("Keenable", () => {
  it("maps search", async () => {
    const { fetch, calls } = mockFetch({ [URLS.keenableSearch]: ok(fixture("keenable-search")) });
    const results = await ADAPTERS.keenable.search!({ query: "typescript best practices", maxResults: 80 }, ctx(fetch, "keen_abc"));
    expect(calls[0]).toMatchObject({
      url: "https://api.keenable.ai/v1/search",
      method: "POST",
      headers: { "x-api-key": "keen_abc" },
      body: { query: "typescript best practices", max_results: 50 },
    });
    expect(results).toEqual([
      {
        title: "TypeScript Best Practices 2026",
        url: "https://example.com/ts-best-practices",
        snippet: "TypeScript Best Practices 2026 Use strict mode...",
        publishedAt: "2026-01-15T10:30:00.000Z",
      },
    ]);
  });

  it("maps fetch, sending the URL as a query parameter with live=true", async () => {
    const { fetch, calls } = mockFetch({ [URLS.keenableFetch]: ok(fixture("keenable-fetch")) });
    const result = await ADAPTERS.keenable.scrape!({ url: "https://example.com/?a=1&b=2" }, ctx(fetch, "keen_abc"));
    const sent = new URL(calls[0]!.url);
    expect(calls[0]?.method).toBe("GET");
    expect(sent.origin + sent.pathname).toBe("https://api.keenable.ai/v1/fetch");
    expect(sent.searchParams.get("url")).toBe("https://example.com/?a=1&b=2");
    expect(sent.searchParams.get("live")).toBe("true");
    expect(result).toEqual({ url: "https://example.com/", title: "Example Domain", markdown: "# Example Domain\n\nThis domain is for use in examples." });
  });

  it("reads a malformed-key 400 as unauthorized, a plain 400 as a bad request, 402 as exhausted", async () => {
    const malformed = mockFetch({ [URLS.keenableSearch]: status(400, { detail: "Malformed API key" }) });
    expect((await failure(ADAPTERS.keenable.search!({ query: "q" }, ctx(malformed.fetch)))).outcome).toBe("unauthorized");
    const bad = mockFetch({ [URLS.keenableSearch]: status(400, { detail: "query too long" }) });
    expect((await failure(ADAPTERS.keenable.search!({ query: "q" }, ctx(bad.fetch)))).outcome).toBe("bad_request");
    const spent = mockFetch({ [URLS.keenableSearch]: status(402, { detail: "No credits available" }) });
    expect((await failure(ADAPTERS.keenable.search!({ query: "q" }, ctx(spent.fetch)))).outcome).toBe("exhausted");
  });
});

describe("Parallel", () => {
  it("maps search, with the result cap in advanced_settings", async () => {
    const { fetch, calls } = mockFetch({ [URLS.parallelSearch]: ok(fixture("parallel-search")) });
    const results = await ADAPTERS.parallel.search!({ query: "founder credits", maxResults: 3 }, ctx(fetch));
    expect(calls[0]).toMatchObject({
      url: "https://api.parallel.ai/v1/search",
      headers: { "x-api-key": "test-key" },
      body: { objective: "founder credits", search_queries: ["founder credits"], advanced_settings: { max_results: 3 } },
    });
    expect(results).toEqual([
      {
        title: "Sample webpage title",
        url: "https://www.example.com",
        snippet: "Sample excerpt 1 … Sample excerpt 2",
        publishedAt: "2024-01-15T00:00:00.000Z",
      },
    ]);
  });

  it("maps extract with full content", async () => {
    const { fetch, calls } = mockFetch({ [URLS.parallelExtract]: ok(fixture("parallel-extract")) });
    const result = await ADAPTERS.parallel.scrape!({ url: "https://www.example.com" }, ctx(fetch));
    expect(calls[0]?.body).toEqual({ urls: ["https://www.example.com"], advanced_settings: { full_content: true } });
    expect(result).toEqual({ url: "https://www.example.com", title: "Example Title", markdown: "Full content ..." });
  });

  it("reads a per-URL error as a failed fetch and 402 as exhausted", async () => {
    const fetchError = mockFetch({
      [URLS.parallelExtract]: ok({ results: [], errors: [{ url: "u", error_type: "fetch_error", http_status_code: 500, content: "x" }] }),
    });
    const fetchFailed = await failure(ADAPTERS.parallel.scrape!({ url: "https://e.com" }, ctx(fetchError.fetch)));
    expect(fetchFailed.outcome).toBe("fetch_failed");
    expect(fetchFailed.message).toBe("Parallel could not fetch the page (fetch_error); the page answered HTTP 500");
    expect(fetchFailed.status).toBeUndefined();
    const spent = mockFetch({ [URLS.parallelSearch]: status(402, { error: { message: "Insufficient credit in account", detail: {} } }) });
    const error = await failure(ADAPTERS.parallel.search!({ query: "q" }, ctx(spent.fetch)));
    expect(error.outcome).toBe("exhausted");
    expect(error.message).toBe("Insufficient credit in account");
  });
});

describe("Tavily", () => {
  it("maps search", async () => {
    const { fetch, calls } = mockFetch({ [URLS.tavilySearch]: ok(fixture("tavily-search")) });
    const results = await ADAPTERS.tavily.search!({ query: "Who is Leo Messi?", maxResults: 50 }, ctx(fetch, "tvly-abc"));
    expect(calls[0]).toMatchObject({
      url: "https://api.tavily.com/search",
      headers: { authorization: "Bearer tvly-abc" },
      body: { query: "Who is Leo Messi?", max_results: 20 },
    });
    expect(results[0]).toEqual({
      title: "Lionel Messi Facts | Britannica",
      url: "https://www.britannica.com/facts/Lionel-Messi",
      snippet: expect.stringContaining("Argentine footballer"),
      publishedAt: "2025-03-11T17:00:00.000Z",
    });
  });

  it("maps extract", async () => {
    const { fetch, calls } = mockFetch({ [URLS.tavilyExtract]: ok(fixture("tavily-extract")) });
    const result = await ADAPTERS.tavily.scrape!({ url: "https://example.com/article" }, ctx(fetch));
    expect(calls[0]?.body).toEqual({ urls: ["https://example.com/article"], format: "markdown" });
    expect(result).toEqual({ url: "https://example.com/article", markdown: "Example extracted article content." });
  });

  it("reads failed_results as a failed fetch", async () => {
    const { fetch } = mockFetch({ [URLS.tavilyExtract]: ok({ results: [], failed_results: [{ url: "u", error: "blocked" }] }) });
    expect((await failure(ADAPTERS.tavily.scrape!({ url: "https://e.com" }, ctx(fetch)))).outcome).toBe("fetch_failed");
  });

  it("reads 432 and 433 as exhausted", async () => {
    for (const code of [432, 433]) {
      const { fetch } = mockFetch({ [URLS.tavilySearch]: status(code, { detail: { error: "This request exceeds your plan's set usage limit." } }) });
      const error = await failure(ADAPTERS.tavily.search!({ query: "q" }, ctx(fetch)));
      expect(error.outcome).toBe("exhausted");
      expect(error.message).toContain("usage limit");
    }
  });

  it("reads usage as separate balances, never a sum", async () => {
    const { fetch } = mockFetch({ [URLS.tavilyUsage]: ok(fixture("tavily-usage")) });
    const { balances } = await ADAPTERS.tavily.balance!(ctx(fetch));
    expect(balances.map((b) => [b.label, b.kind, b.remaining, b.total])).toEqual([
      ["Tavily plan credits (Bootstrap)", "credits", 14500, 15000],
      ["Tavily pay-as-you-go limit", "pay-as-you-go", 75, 100],
      ["Tavily limit on this key", "key-limit", 850, 1000],
    ]);
    expect(balances.every((b) => b.endsOn === undefined)).toBe(true);
  });
});

describe("shared HTTP handling", () => {
  it("classifies 429, 5xx, 401 and empty bodies", async () => {
    const cases: Array<[number, string]> = [
      [429, "rate_limited"],
      [500, "server_error"],
      [503, "server_error"],
      [401, "unauthorized"],
      [422, "bad_request"],
      [404, "provider_error"],
    ];
    for (const [code, outcome] of cases) {
      const { fetch } = mockFetch({ [URLS.tavilySearch]: status(code) });
      expect((await failure(ADAPTERS.tavily.search!({ query: "q" }, ctx(fetch)))).outcome).toBe(outcome);
    }
    const empty = mockFetch({ [URLS.tavilySearch]: () => new Response("", { status: 200 }) });
    expect((await failure(ADAPTERS.tavily.search!({ query: "q" }, ctx(empty.fetch)))).outcome).toBe("invalid_response");
    const html = mockFetch({ [URLS.tavilySearch]: () => new Response("<html>", { status: 200 }) });
    expect((await failure(ADAPTERS.tavily.search!({ query: "q" }, ctx(html.fetch)))).outcome).toBe("invalid_response");
    const shape = mockFetch({ [URLS.tavilySearch]: () => json({ nope: true }) });
    expect((await failure(ADAPTERS.tavily.search!({ query: "q" }, ctx(shape.fetch)))).outcome).toBe("invalid_response");
  });

  it("classifies timeouts and network errors", async () => {
    const slow = mockFetch({
      [URLS.exaSearch]: () => {
        throw new DOMException("timed out", "TimeoutError");
      },
    });
    expect((await failure(ADAPTERS.exa.search!({ query: "q" }, ctx(slow.fetch)))).outcome).toBe("timeout");
    const down = mockFetch({
      [URLS.exaSearch]: () => {
        throw new TypeError("fetch failed");
      },
    });
    expect((await failure(ADAPTERS.exa.search!({ query: "q" }, ctx(down.fetch)))).outcome).toBe("network_error");
  });

  it("aborts a request that runs past the timeout", async () => {
    const fetch: CallContext["fetch"] = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const error = await failure(ADAPTERS.exa.search!({ query: "q" }, { key: "k", fetch, timeoutMs: 20 }));
    expect(error.outcome).toBe("timeout");
  });

  it("every adapter cites its official docs", () => {
    for (const adapter of Object.values(ADAPTERS)) {
      expect(adapter.docs.length).toBeGreaterThan(0);
      for (const doc of adapter.docs) expect(doc).toMatch(/^https:\/\//);
    }
  });
});

describe("Parallel request contract", () => {
  // Property names copied from the OpenAPI schema in the cited references (read 2026-10-11).
  // Both request objects and both advanced-settings objects declare additionalProperties: false,
  // so an undocumented field would be rejected with a 422.
  const V1SearchRequest = ["objective", "search_queries", "mode", "max_chars_total", "session_id", "client_model", "advanced_settings"];
  const AdvancedSearchSettings = ["source_policy", "fetch_policy", "excerpt_settings", "location", "max_results"];
  const V1ExtractRequest = ["urls", "objective", "search_queries", "max_chars_total", "session_id", "client_model", "advanced_settings"];
  const AdvancedExtractSettings = ["fetch_policy", "excerpt_settings", "full_content"];

  function keysOf(value: unknown): string[] {
    return Object.keys(value as Record<string, unknown>);
  }

  it("sends only documented search fields, with search_queries present", async () => {
    const { fetch, calls } = mockFetch({ [URLS.parallelSearch]: ok(fixture("parallel-search")) });
    await ADAPTERS.parallel.search!({ query: "q", maxResults: 4 }, ctx(fetch));
    const body = calls[0]?.body as { search_queries: unknown; advanced_settings: unknown };
    for (const key of keysOf(body)) expect(V1SearchRequest).toContain(key);
    for (const key of keysOf(body.advanced_settings)) expect(AdvancedSearchSettings).toContain(key);
    expect(body.search_queries).toEqual(["q"]);
  });

  it("sends only documented extract fields, with urls present", async () => {
    const { fetch, calls } = mockFetch({ [URLS.parallelExtract]: ok(fixture("parallel-extract")) });
    await ADAPTERS.parallel.scrape!({ url: "https://www.example.com" }, ctx(fetch));
    const body = calls[0]?.body as { urls: unknown; advanced_settings: unknown };
    for (const key of keysOf(body)) expect(V1ExtractRequest).toContain(key);
    for (const key of keysOf(body.advanced_settings)) expect(AdvancedExtractSettings).toContain(key);
    expect(body.urls).toEqual(["https://www.example.com"]);
  });
});
