import { describe, expect, it } from "vitest";
import type { RouterConfig } from "../src/config.js";
import { type RouterOptions, RouterError, createRouter } from "../src/router.js";
import { URLS, fixture, mockFetch, ok, status, timeout, type Responder } from "./helpers.js";

const NOW = new Date("2026-10-11T12:00:00Z");

const TAVILY_RESULTS = fixture("tavily-search");
const EXA_RESULTS = fixture("exa-search");
const KEENABLE_RESULTS = fixture("keenable-search");

function setup(
  routes: Record<string, Responder | Responder[]>,
  keys: Partial<
    Record<
      "EXA_API_KEY" | "FIRECRAWL_API_KEY" | "KEENABLE_API_KEY" | "LINKUP_API_KEY" | "PARALLEL_API_KEY" | "TAVILY_API_KEY" | "YDC_API_KEY",
      string
    >
  >,
  config: RouterConfig = {},
  extra: Partial<RouterOptions> = {},
) {
  const mock = mockFetch(routes);
  const logs: string[] = [];
  let clock = NOW;
  const router = createRouter({
    env: keys,
    config,
    fetch: mock.fetch,
    ledgerPath: false,
    log: (message) => logs.push(message),
    now: () => clock,
    ...extra,
  });
  return { router, logs, calls: mock.calls, advance: (ms: number) => (clock = new Date(clock.getTime() + ms)) };
}

async function routerError(promise: Promise<unknown>): Promise<RouterError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RouterError) return error;
    throw error;
  }
  throw new Error("expected a RouterError");
}

// With exa and tavily credits of no known end date and nothing else known, the default order is by id: exa, then tavily.
const twoProviders = { EXA_API_KEY: "exa-key", TAVILY_API_KEY: "tvly-key" };
const tavilyUsageUnknown = { [URLS.tavilyUsage]: status(500) };

describe("routing", () => {
  it("serves from the first provider and says which and why", async () => {
    const { router } = setup({ [URLS.exaSearch]: ok(EXA_RESULTS), ...tavilyUsageUnknown }, twoProviders);
    const response = await router.search({ query: "q" });
    expect(response.results).toHaveLength(2);
    expect(response.routing).toEqual({
      provider: "exa",
      rule: "credits-ending-first",
      reason: "Nothing is known about its credits, so it counts as credits with no known end date.",
      tried: [{ provider: "exa", outcome: "ok" }],
    });
  });

  it("orders by balances the provider reports: a billing period ending soon goes first", async () => {
    const { router } = setup(
      {
        [URLS.firecrawlCredits]: ok(fixture("firecrawl-credit-usage")),
        [URLS.firecrawlSearch]: ok(fixture("firecrawl-search")),
      },
      { EXA_API_KEY: "exa-key", FIRECRAWL_API_KEY: "fc-key" },
      { providers: { exa: { credits: [{ label: "Exa startup grant", expiresOn: "2027-03-01", remaining: 600, award: 1000, unit: "usd" }] } } },
    );
    const response = await router.search({ query: "q" });
    expect(response.routing.provider).toBe("firecrawl");
    expect(response.routing.reason).toBe('Credits ending first: "Firecrawl credits, current billing period" (under 1% remaining) ends 2026-10-31 23:59:59 UTC.');
  });

  it("follows the founder's order", async () => {
    const { router } = setup(
      { [URLS.tavilySearch]: ok(TAVILY_RESULTS), ...tavilyUsageUnknown },
      twoProviders,
      { order: { search: ["tavily", "exa"] } },
    );
    const response = await router.search({ query: "q" });
    expect(response.routing).toMatchObject({ provider: "tavily", rule: "your-order", reason: "Position 1 in your order for search (config order.search)." });
  });

  it("caches the Tavily usage reading across calls", async () => {
    const { router, calls } = setup(
      { [URLS.tavilyUsage]: ok(fixture("tavily-usage")), [URLS.tavilySearch]: ok(TAVILY_RESULTS) },
      { TAVILY_API_KEY: "tvly-key" },
    );
    await router.search({ query: "a" });
    await router.search({ query: "b" });
    await router.status();
    expect(calls.filter((call) => call.url === URLS.tavilyUsage)).toHaveLength(1);
    await router.status({ refresh: true });
    expect(calls.filter((call) => call.url === URLS.tavilyUsage)).toHaveLength(2);
  });

  it("treats an unreadable balance as unknown, not as a failure", async () => {
    const { router } = setup({ [URLS.tavilyUsage]: status(500), [URLS.tavilySearch]: ok(TAVILY_RESULTS) }, { TAVILY_API_KEY: "k" });
    const response = await router.search({ query: "q" });
    expect(response.routing.provider).toBe("tavily");
    const tavily = (await router.status()).providers.find((p) => p.id === "tavily");
    expect(tavily?.balanceNote).toContain("Could not read the balance (server_error)");
  });
});

describe("failover", () => {
  it("on 402 marks the provider spent for the session and moves on", async () => {
    const { router, calls, logs } = setup(
      { [URLS.exaSearch]: status(402, { error: "No more credits", tag: "NO_MORE_CREDITS" }), [URLS.tavilySearch]: ok(TAVILY_RESULTS), ...tavilyUsageUnknown },
      twoProviders,
    );
    const first = await router.search({ query: "q" });
    expect(first.routing.provider).toBe("tavily");
    expect(first.routing.tried).toEqual([
      { provider: "exa", outcome: "exhausted", status: 402, message: "No more credits (NO_MORE_CREDITS)" },
      { provider: "tavily", outcome: "ok" },
    ]);
    await router.search({ query: "again" });
    expect(calls.filter((call) => call.url === URLS.exaSearch)).toHaveLength(1);
    expect(logs).toEqual(["Exa reported its credits spent; skipping it for the rest of this session."]);
    const status402 = await router.status();
    expect(status402.order.search.skipped).toEqual([
      expect.objectContaining({ provider: "exa", reason: expect.stringContaining("Skipped for the rest of this session.") }),
      expect.objectContaining({ provider: "firecrawl" }),
      expect.objectContaining({ provider: "keenable" }),
      expect.objectContaining({ provider: "linkup" }),
      expect.objectContaining({ provider: "parallel" }),
      expect.objectContaining({ provider: "youcom" }),
    ]);
  });

  it("on a documented quota error body (Tavily 432) marks the provider spent", async () => {
    const { router } = setup(
      {
        [URLS.tavilySearch]: status(432, { detail: { error: "This request exceeds your plan's set usage limit." } }),
        [URLS.exaSearch]: ok(EXA_RESULTS),
        ...tavilyUsageUnknown,
      },
      twoProviders,
      { order: { search: ["tavily", "exa"] } },
    );
    const response = await router.search({ query: "q" });
    expect(response.routing.provider).toBe("exa");
    expect(response.routing.tried[0]).toMatchObject({ provider: "tavily", outcome: "exhausted", status: 432 });
    expect((await router.status()).providers.find((p) => p.id === "tavily")?.exhausted).toBeDefined();
  });

  it("keeps a spent provider out until its billing period ends, then tries it again", async () => {
    const { router, advance } = setup(
      {
        [URLS.firecrawlCredits]: [
          ok(fixture("firecrawl-credit-usage")),
          ok({
            success: true,
            data: { remainingCredits: 3000, planCredits: 3000, billingPeriodStart: "2026-11-01T00:00:00Z", billingPeriodEnd: "2026-11-30T23:59:59Z" },
          }),
        ],
        [URLS.firecrawlSearch]: [
          status(402, { success: false, error: "Payment required", code: "insufficient_credits" }),
          ok(fixture("firecrawl-search")),
        ],
        [URLS.exaSearch]: ok(EXA_RESULTS),
      },
      { EXA_API_KEY: "exa-key", FIRECRAWL_API_KEY: "fc-key" },
    );
    expect((await router.search({ query: "q" })).routing.provider).toBe("exa");
    const spent = (await router.status()).providers.find((p) => p.id === "firecrawl")?.exhausted;
    expect(spent?.until).toBe("2026-10-31T23:59:59.000Z");
    expect((await router.search({ query: "q" })).routing.provider).toBe("exa");
    advance(21 * 86_400_000); // past the billing period end; the next reading shows a new period
    const renewed = await router.search({ query: "q" });
    expect(renewed.routing.provider).toBe("firecrawl");
    expect(renewed.routing.reason).toContain("ends 2026-11-30");
  });

  it.each([
    ["429", status(429, { error: "Too many requests" }), "rate_limited"],
    ["500", status(500), "server_error"],
    ["503", status(503), "server_error"],
    ["timeout", timeout, "timeout"],
  ] as const)("on %s tries the next provider without marking the first spent", async (_name, responder, outcome) => {
    const { router, calls } = setup(
      { [URLS.exaSearch]: responder, [URLS.tavilySearch]: ok(TAVILY_RESULTS), ...tavilyUsageUnknown },
      twoProviders,
    );
    const response = await router.search({ query: "q" });
    expect(response.routing.provider).toBe("tavily");
    expect(response.routing.tried[0]).toMatchObject({ provider: "exa", outcome });
    await router.search({ query: "q" });
    expect(calls.filter((call) => call.url === URLS.exaSearch)).toHaveLength(2);
    expect((await router.status()).providers.find((p) => p.id === "exa")?.exhausted).toBeUndefined();
  });

  it("on 401 disables the provider for the session with a clear message and fails over", async () => {
    const { router, calls, logs } = setup(
      { [URLS.exaSearch]: status(401, { error: "Invalid API key", tag: "INVALID_API_KEY" }), [URLS.tavilySearch]: ok(TAVILY_RESULTS), ...tavilyUsageUnknown },
      twoProviders,
    );
    const response = await router.search({ query: "q" });
    expect(response.routing.provider).toBe("tavily");
    expect(response.routing.tried[0]).toMatchObject({ provider: "exa", outcome: "unauthorized", status: 401 });
    expect(logs).toEqual(["Exa refused the key in EXA_API_KEY (HTTP 401); disabled for this session. Check the key and restart."]);
    await router.search({ query: "q" });
    expect(calls.filter((call) => call.url === URLS.exaSearch)).toHaveLength(1);
    const exa = (await router.status()).providers.find((p) => p.id === "exa");
    expect(exa?.disabled).toContain("disabled for this session");
  });

  it("on 403 also disables the provider", async () => {
    const { router } = setup(
      { [URLS.keenableSearch]: status(403, { detail: "API key disabled" }), [URLS.tavilySearch]: ok(TAVILY_RESULTS), ...tavilyUsageUnknown },
      { KEENABLE_API_KEY: "keen_x", TAVILY_API_KEY: "tvly" },
    );
    const response = await router.search({ query: "q" });
    expect(response.routing.tried[0]).toMatchObject({ provider: "keenable", outcome: "unauthorized", status: 403 });
  });

  it("on Exa 403 FEATURE_DISABLED fails over for that call but keeps Exa on for what the plan includes", async () => {
    const { router, logs } = setup(
      {
        [URLS.exaSearch]: status(403, { requestId: "r", error: "Not on your plan", tag: "FEATURE_DISABLED" }),
        [URLS.exaContents]: ok(fixture("exa-contents")),
        [URLS.tavilySearch]: ok(TAVILY_RESULTS),
        ...tavilyUsageUnknown,
      },
      twoProviders,
    );
    const response = await router.search({ query: "q" });
    expect(response.routing.provider).toBe("tavily");
    expect(response.routing.tried[0]).toMatchObject({ provider: "exa", outcome: "provider_error", status: 403 });
    expect(logs).toEqual([]);
    expect((await router.scrape({ url: "https://example.com/" })).routing.provider).toBe("exa");
    expect((await router.status()).providers.find((p) => p.id === "exa")?.disabled).toBeUndefined();
  });

  it("on 400 returns the error to the caller without failover", async () => {
    const { router, calls } = setup(
      { [URLS.exaSearch]: status(400, { error: "numResults must be <= 100", tag: "INVALID_REQUEST_BODY" }), [URLS.tavilySearch]: ok(TAVILY_RESULTS), ...tavilyUsageUnknown },
      twoProviders,
    );
    const error = await routerError(router.search({ query: "q" }));
    expect(error.code).toBe("bad_request");
    expect(error.message).toContain("numResults must be <= 100");
    expect(error.routing?.tried).toEqual([
      { provider: "exa", outcome: "bad_request", status: 400, message: "numResults must be <= 100 (INVALID_REQUEST_BODY)" },
    ]);
    expect(calls.some((call) => call.url === URLS.tavilySearch)).toBe(false);
  });

  it("fails over when a provider cannot fetch the page", async () => {
    const { router } = setup(
      {
        [URLS.exaContents]: ok({ results: [], statuses: [{ id: "u", status: "error", error: { tag: "CRAWL_NOT_FOUND", httpStatusCode: 404 } }] }),
        [URLS.tavilyExtract]: ok(fixture("tavily-extract")),
        ...tavilyUsageUnknown,
      },
      twoProviders,
    );
    const response = await router.scrape({ url: "https://example.com/article" });
    expect(response.result.markdown).toBe("Example extracted article content.");
    expect(response.routing.tried.map((t) => t.outcome)).toEqual(["fetch_failed", "ok"]);
  });

  it("fails over when Linkup cannot fetch the page (a FETCH_* 400), rather than stopping as on a bad request", async () => {
    const { router } = setup(
      {
        [URLS.linkupFetch]: status(400, { statusCode: 400, error: { code: "FETCH_TARGET_UNREACHABLE", message: "Unreachable", details: [] } }),
        [URLS.linkupBalance]: status(500),
        [URLS.tavilyExtract]: ok(fixture("tavily-extract")),
        ...tavilyUsageUnknown,
      },
      { LINKUP_API_KEY: "lk", TAVILY_API_KEY: "tvly" },
    );
    const response = await router.scrape({ url: "https://example.com/article" });
    expect(response.routing.provider).toBe("tavily");
    expect(response.routing.tried).toEqual([
      { provider: "linkup", outcome: "fetch_failed", status: 400, message: "Unreachable" },
      { provider: "tavily", outcome: "ok" },
    ]);
  });

  it("marks Linkup spent on its out-of-credit 429, but only rate limited on TOO_MANY_REQUESTS", async () => {
    const busy = setup(
      {
        [URLS.linkupSearch]: status(429, { statusCode: 429, error: { code: "TOO_MANY_REQUESTS", message: "Too many requests", details: [] } }),
        [URLS.linkupBalance]: status(500),
        [URLS.tavilySearch]: ok(TAVILY_RESULTS),
        ...tavilyUsageUnknown,
      },
      { LINKUP_API_KEY: "lk", TAVILY_API_KEY: "tvly" },
    );
    expect((await busy.router.search({ query: "q" })).routing.tried[0]).toMatchObject({ provider: "linkup", outcome: "rate_limited", status: 429 });
    expect((await busy.router.status()).providers.find((p) => p.id === "linkup")?.exhausted).toBeUndefined();

    const spent = setup(
      {
        [URLS.linkupSearch]: status(429, fixture("linkup-error-429")),
        [URLS.linkupBalance]: status(500),
        [URLS.tavilySearch]: ok(TAVILY_RESULTS),
        ...tavilyUsageUnknown,
      },
      { LINKUP_API_KEY: "lk", TAVILY_API_KEY: "tvly" },
    );
    expect((await spent.router.search({ query: "q" })).routing.tried[0]).toMatchObject({ provider: "linkup", outcome: "exhausted", status: 429 });
    expect(spent.logs).toEqual(["Linkup reported its credits spent; skipping it for the rest of this session."]);
    await spent.router.search({ query: "again" });
    expect(spent.calls.filter((call) => call.url === URLS.linkupSearch)).toHaveLength(1);
  });

  it("serves an empty list when Linkup finds nothing, without trying anyone else", async () => {
    const { router, calls } = setup(
      {
        [URLS.linkupSearch]: status(400, { statusCode: 400, error: { code: "SEARCH_QUERY_NO_RESULT", message: "Search query yields no result", details: [] } }),
        [URLS.linkupBalance]: status(500),
        ...tavilyUsageUnknown,
      },
      { LINKUP_API_KEY: "lk", TAVILY_API_KEY: "tvly" },
    );
    const response = await router.search({ query: "q" });
    expect(response).toMatchObject({ results: [], routing: { provider: "linkup", tried: [{ provider: "linkup", outcome: "ok" }] } });
    expect(calls.some((call) => call.url === URLS.tavilySearch)).toBe(false);
  });

  it("on a You.com 403 for a missing scope fails over for that call but keeps You.com on for search", async () => {
    const { router, logs } = setup(
      {
        [URLS.youcomContents]: status(403, { detail: "Missing required scopes" }),
        [URLS.youcomSearch]: ok(fixture("youcom-search")),
        [URLS.youcomBalance]: status(403, { detail: "Missing required scopes" }),
        [URLS.tavilyExtract]: ok(fixture("tavily-extract")),
        ...tavilyUsageUnknown,
      },
      { YDC_API_KEY: "ydc", TAVILY_API_KEY: "tvly" },
      { order: { search: ["youcom"], scrape: ["youcom", "tavily"] } },
    );
    const scrape = await router.scrape({ url: "https://example.com/article" });
    expect(scrape.routing.provider).toBe("tavily");
    expect(scrape.routing.tried[0]).toMatchObject({ provider: "youcom", outcome: "provider_error", status: 403 });
    expect((await router.search({ query: "q" })).routing.provider).toBe("youcom");
    expect(logs).toEqual([]);
    const youcom = (await router.status()).providers.find((p) => p.id === "youcom");
    expect(youcom?.disabled).toBeUndefined();
    // A balance read the key has no scope for is unknown, not a refused key.
    expect(youcom?.balanceNote).toContain("Could not read the balance (provider_error)");
  });

  it("reports every attempt when all providers fail", async () => {
    const { router } = setup(
      { [URLS.exaSearch]: status(503), [URLS.tavilySearch]: status(429), ...tavilyUsageUnknown },
      twoProviders,
    );
    const error = await routerError(router.search({ query: "q" }));
    expect(error.code).toBe("all_failed");
    expect(error.message).toBe("Every provider for search failed (exa: server_error, tavily: rate_limited).");
  });

  it("says why when no provider is available", async () => {
    const { router } = setup({}, {});
    const error = await routerError(router.search({ query: "q" }));
    expect(error.code).toBe("no_provider");
    expect(error.message).toContain("exa: No key: set EXA_API_KEY to use it.");
  });

  it("rejects empty queries and non-http URLs before calling anyone", async () => {
    const { router, calls } = setup({}, twoProviders);
    expect((await routerError(router.search({ query: "  " }))).code).toBe("invalid_request");
    expect((await routerError(router.search({ query: "q", maxResults: 0 }))).code).toBe("invalid_request");
    expect((await routerError(router.scrape({ url: "file:///etc/passwd" }))).code).toBe("invalid_request");
    expect((await routerError(router.scrape({ url: "not a url" }))).code).toBe("invalid_request");
    expect(calls).toHaveLength(0);
  });

  it("uses Keenable for search when it is the only key", async () => {
    const { router } = setup({ [URLS.keenableSearch]: ok(KEENABLE_RESULTS) }, { KEENABLE_API_KEY: "keen_x" });
    expect((await router.search({ query: "q" })).routing.provider).toBe("keenable");
  });
});

describe("status", () => {
  it("lists balances one by one with their read time and never a total", async () => {
    const { router } = setup(
      { [URLS.firecrawlCredits]: ok(fixture("firecrawl-credit-usage")), [URLS.tavilyUsage]: ok(fixture("tavily-usage")) },
      { FIRECRAWL_API_KEY: "fc", TAVILY_API_KEY: "tv", EXA_API_KEY: "ex" },
      { providers: { exa: { credits: [{ label: "Exa startup grant", expiresOn: "2027-03-01", remaining: 600, award: 1000, unit: "usd" }] } } },
    );
    const status = await router.status();
    expect(status.providers.map((p) => [p.id, p.enabled])).toEqual([
      ["exa", true],
      ["firecrawl", true],
      ["keenable", false],
      ["linkup", false],
      ["parallel", false],
      ["tavily", true],
      ["youcom", false],
    ]);
    const firecrawl = status.providers.find((p) => p.id === "firecrawl");
    expect(firecrawl?.balances[0]?.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(status.providers.find((p) => p.id === "exa")?.balanceNote).toContain("publishes no balance endpoint");
    expect(status.order.search.entries.map((e) => e.provider)).toEqual(["firecrawl", "exa", "tavily"]);
    expect(JSON.stringify(status)).not.toMatch(/total(Credits|Balance)|combined|sum/i);
  });
});

describe("result cap", () => {
  it("trims results to maxResults even when a provider returns more", async () => {
    const many = { results: Array.from({ length: 7 }, (_, i) => ({ url: `https://example.com/${i}`, title: `r${i}` })) };
    const { router } = setup({ [URLS.parallelSearch]: ok(many) }, { PARALLEL_API_KEY: "p" });
    expect((await router.search({ query: "q", maxResults: 3 })).results.map((r) => r.url)).toEqual([
      "https://example.com/0",
      "https://example.com/1",
      "https://example.com/2",
    ]);
    expect((await router.search({ query: "q" })).results).toHaveLength(7);
  });
});
