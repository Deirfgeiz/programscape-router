import { describe, expect, it } from "vitest";
import { ADAPTERS, type CallContext, ProviderCallError } from "../src/providers/index.js";
import { requestJson } from "../src/providers/http.js";
import { BRIGHTDATA_ZONE_URLS, URLS, brdHeaders, fixture, json, mockFetch, ok, status, type Responder } from "./helpers.js";
import { createZone, listZones } from "../src/providers/brightdata.js";

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

describe("Bright Data", () => {
  const zones = { search: "programscape_serp", scrape: "web_unlocker1" };
  const bd = (fetch: CallContext["fetch"]): CallContext => ({ key: "test-key", fetch, timeoutMs: 5000, zones });
  const searchOnce = (fetch: CallContext["fetch"]) => ADAPTERS.brightdata.search!({ query: "startup credits" }, bd(fetch));
  const scrapeOnce = (fetch: CallContext["fetch"]) => ADAPTERS.brightdata.scrape!({ url: "https://example.com/a" }, bd(fetch));

  it("searches Google through the SERP zone, in English for the US, raw, and maps organic results", async () => {
    const { fetch, calls } = mockFetch({ [URLS.brightdataRequest]: ok(fixture("brightdata-search")) });
    const results = await ADAPTERS.brightdata.search!({ query: "seed & SAFE?", maxResults: 5 }, bd(fetch));
    expect(calls[0]).toMatchObject({
      url: "https://api.brightdata.com/request",
      method: "POST",
      headers: { authorization: "Bearer test-key", "content-type": "application/json" },
      body: {
        zone: "programscape_serp",
        url: "https://www.google.com/search?q=seed%20%26%20SAFE%3F&hl=en&gl=us&brd_json=1",
        format: "raw",
      },
    });
    expect(Object.keys(calls[0]?.body as object).sort()).toEqual(["format", "url", "zone"]);
    expect(results).toEqual([
      { title: "AWS Activate credits", url: "https://aws.amazon.com/startups/credits", snippet: "Get up to $100,000 in AWS credits for your startup." },
      { title: "Google for Startups Cloud Program", url: "https://cloud.google.com/startup", snippet: "Credits and support for startups building on Google Cloud." },
      { title: "A result without a description", url: "https://example.com/no-description" },
    ]);
  });

  it("gives at most 10 results, one page, however many are asked for, and reads no organic list as none", async () => {
    const organic = Array.from({ length: 12 }, (_, n) => ({ link: `https://example.com/${n}`, title: `R${n}`, rank: n + 1 }));
    const { fetch, calls } = mockFetch({ [URLS.brightdataRequest]: [ok({ organic }), ok({ general: {} })] });
    expect(await ADAPTERS.brightdata.search!({ query: "q", maxResults: 50 }, bd(fetch))).toHaveLength(10);
    expect(await ADAPTERS.brightdata.search!({ query: "q", maxResults: 2 }, bd(fetch))).toEqual([]);
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls)).not.toMatch(/start=|num=/);
  });

  it("reads a page through the Web Unlocker zone as markdown, with the requested URL and no title", async () => {
    const { fetch, calls } = mockFetch({ [URLS.brightdataRequest]: ok(fixture("brightdata-scrape")) });
    const result = await scrapeOnce(fetch);
    expect(calls[0]?.body).toEqual({ zone: "web_unlocker1", url: "https://example.com/a", format: "json", data_format: "markdown" });
    expect(result).toEqual({ url: "https://example.com/a", markdown: "# Example Domain\n\nThis domain is for use in illustrative examples in documents." });
  });

  it("reads a target page's error status as a failed fetch, and a wrapper without a body string too", async () => {
    for (const body of [{ status_code: 404, headers: {}, body: "Not found" }, { status_code: 200, headers: {} }]) {
      const { fetch } = mockFetch({ [URLS.brightdataRequest]: ok(body) });
      expect((await failure(scrapeOnce(fetch))).outcome).toBe("fetch_failed");
    }
    const { fetch } = mockFetch({ [URLS.brightdataRequest]: ok([1]) });
    expect((await failure(scrapeOnce(fetch))).outcome).toBe("invalid_response");
  });

  it("reads failures Bright Data reports in the headers of a 200, as live", async () => {
    // [headers, search outcome, scrape outcome, status, code]
    const cases: Array<[Record<string, string>, string, string, number, string | undefined]> = [
      [{ "x-brd-status-code": "502", "x-brd-error-code": "captcha", "x-brd-error": "redirect location was rejected" }, "provider_error", "fetch_failed", 502, "captcha"],
      [{ "x-brd-status-code": "502", "x-brd-error-code": "reject_block" }, "provider_error", "fetch_failed", 502, "reject_block"],
      [{ "x-brd-status-code": "429", "x-brd-error-code": "sr_rate_limit" }, "rate_limited", "rate_limited", 429, "sr_rate_limit"],
      [{ "x-brd-error-code": "bucket_rate_limit" }, "rate_limited", "rate_limited", 200, "bucket_rate_limit"],
      [{ "x-brd-status-code": "502", "x-brd-err-code": "client_10110", "x-brd-err-msg": "rate limit" }, "rate_limited", "rate_limited", 502, "client_10110"],
      [{ "x-brd-status-code": "429" }, "rate_limited", "rate_limited", 429, undefined],
      [{ "x-brd-status-code": "502", "x-brd-err-code": "client_10100", "x-brd-err-msg": "Zone has reached usage limit" }, "exhausted", "exhausted", 502, "client_10100"],
      [{ "x-brd-status-code": "407", "x-brd-err-code": "client_10020", "x-brd-err-msg": "Account is suspended" }, "exhausted", "exhausted", 407, "client_10020"],
      // A target page's own 401 or 403 is about the page, never the founder's key.
      [{ "x-brd-status-code": "403" }, "provider_error", "fetch_failed", 403, undefined],
    ];
    for (const [headers, search, scrape, code, brdCode] of cases) {
      for (const body of ["", JSON.stringify({ organic: [{ link: "https://x.example", title: "x" }] })]) {
        const { fetch } = mockFetch({ [URLS.brightdataRequest]: brdHeaders(headers, body) });
        expect(await failure(searchOnce(fetch))).toMatchObject({ outcome: search, status: code, code: brdCode, switchOff: false });
        expect(await failure(scrapeOnce(fetch))).toMatchObject({ outcome: scrape, status: code, code: brdCode, switchOff: false });
      }
    }
    const captcha = mockFetch({ [URLS.brightdataRequest]: brdHeaders({ "x-brd-status-code": "502", "x-brd-error-code": "captcha" }) });
    expect((await failure(searchOnce(captcha.fetch))).fix).toBe(
      "Bright Data couldn't complete this search (a captcha it couldn't get past); failed requests aren't billed. Try again; if it keeps happening, check the zone in Bright Data's dashboard.",
    );
    expect((await failure(scrapeOnce(captcha.fetch))).fix).toContain("Bright Data couldn't complete this page read");
    // A success status in the header is a success.
    const { fetch } = mockFetch({ [URLS.brightdataRequest]: () => json({ organic: [] }) });
    expect(await searchOnce(fetch)).toEqual([]);
    const okHeader = mockFetch({ [URLS.brightdataRequest]: brdHeaders({ "x-brd-status-code": "200" }, JSON.stringify({ organic: [] })) });
    expect(await searchOnce(okHeader.fetch)).toEqual([]);
  });

  it("reads documented Proxy-Status errors in direct and wrapped responses", async () => {
    const cases = [
      ["client_10100", 502, "exhausted"],
      ["client_10020", 407, "exhausted"],
      ["client_10110", 429, "rate_limited"],
      ["policy_20020", 403, "provider_error"],
    ] as const;
    for (const [code, received, outcome] of cases) {
      const value = `brd.superproxy.io; received-status=${received}; error=http_request_denied; details="${code}: request failed"`;
      const direct = mockFetch({ [URLS.brightdataRequest]: brdHeaders({ "proxy-status": value }, JSON.stringify({ organic: [] })) });
      expect(await failure(searchOnce(direct.fetch))).toMatchObject({ outcome, code, status: received });
      const wrapped = mockFetch({ [URLS.brightdataRequest]: ok({ status_code: received, headers: { "Proxy-Status": value }, body: "" }) });
      expect(await failure(scrapeOnce(wrapped.fetch))).toMatchObject({ outcome: outcome === "provider_error" ? "fetch_failed" : outcome, code, status: received });
    }
  });

  it("handles quoted Proxy-Status details and multiple hops without reading another proxy's codes", async () => {
    const value = 'other.example; error=http_request_denied; details="client_10020: unrelated", brd.superproxy.io; received-status=429; error=http_request_denied; details="client_10110: retry, later; please"';
    const limited = mockFetch({ [URLS.brightdataRequest]: brdHeaders({ "proxy-status": value }, JSON.stringify({ organic: [] })) });
    expect(await failure(searchOnce(limited.fetch))).toMatchObject({ outcome: "rate_limited", code: "client_10110", status: 429 });
    const unrelated = mockFetch({ [URLS.brightdataRequest]: brdHeaders({ "proxy-status": 'other.example; details="client_10020: unrelated"' }, JSON.stringify({ organic: [] })) });
    expect(await searchOnce(unrelated.fetch)).toEqual([]);
    const success = mockFetch({ [URLS.brightdataRequest]: brdHeaders({ "proxy-status": "brd.superproxy.io; received-status=200" }, JSON.stringify({ organic: [] })) });
    expect(await searchOnce(success.fetch)).toEqual([]);
  });

  it("fails over when Bright Data reports only an error message or a Proxy-Status error without a code", async () => {
    const cases: Array<Record<string, string>> = [
      { "x-brd-error": "Could not unlock this page" },
      { "x-brd-err-msg": "Proxy request failed" },
      { "proxy-status": "brd.superproxy.io; error=http_request_error" },
    ];
    for (const headers of cases) {
      const direct = mockFetch({ [URLS.brightdataRequest]: brdHeaders(headers, JSON.stringify({ organic: [] })) });
      expect((await failure(searchOnce(direct.fetch))).outcome).toBe("provider_error");
      const wrapped = mockFetch({ [URLS.brightdataRequest]: ok({ status_code: 200, headers, body: "# Looks like content" }) });
      expect((await failure(scrapeOnce(wrapped.fetch))).outcome).toBe("fetch_failed");
    }
  });

  it("reads the failure inside a format-json wrapper's headers", async () => {
    const wrapper = { status_code: 502, headers: { "X-Brd-Error-Code": "captcha", "x-brd-error": "redirect location was rejected" }, body: "" };
    const { fetch } = mockFetch({ [URLS.brightdataRequest]: ok(wrapper) });
    expect(await failure(scrapeOnce(fetch))).toMatchObject({ outcome: "fetch_failed", code: "captcha", status: 200 });
    const rate = mockFetch({ [URLS.brightdataRequest]: ok({ status_code: 200, headers: { "x-brd-err-code": ["client_10110"] }, body: "# x" }) });
    expect(await failure(scrapeOnce(rate.fetch))).toMatchObject({ outcome: "rate_limited", code: "client_10110" });
  });

  it("reads an unknown zone (HTTP 400, text/html) as a setting to fix that switches Bright Data off, not a bad request", async () => {
    const { fetch } = mockFetch({
      [URLS.brightdataRequest]: () => new Response('zone "programscape_serp" not found', { status: 400, headers: { "content-type": "text/html" } }),
    });
    const error = await failure(searchOnce(fetch));
    expect(error).toMatchObject({
      outcome: "provider_error",
      status: 400,
      switchOff: true,
      fix: "Bright Data zone programscape_serp not found; run `programscape-router keys set brightdata` again.",
    });
    expect((await failure(scrapeOnce(fetch))).fix).toBe("Bright Data zone web_unlocker1 not found; run `programscape-router keys set brightdata` again.");
  });

  it("reads 401 plain text as a bad key, 429 as a rate limit, a validation 400 as a bad request, a 502 code by its code", async () => {
    const cases: Array<[Responder, string, string]> = [
      [() => new Response("Invalid token", { status: 401, headers: { "content-type": "text/plain" } }), "unauthorized", "unauthorized"],
      [() => new Response("Auth method is not supported", { status: 401 }), "unauthorized", "unauthorized"],
      [status(429, "Too many requests"), "rate_limited", "rate_limited"],
      [status(400, { error: "Request validation failed", error_code: "validation" }), "bad_request", "bad_request"],
      [() => new Response("", { status: 502, headers: { "x-brd-error-code": "navigation_timeout" } }), "provider_error", "fetch_failed"],
      [() => new Response("", { status: 503 }), "server_error", "server_error"],
    ];
    for (const [responder, search, scrape] of cases) {
      const { fetch } = mockFetch({ [URLS.brightdataRequest]: responder });
      expect((await failure(searchOnce(fetch))).outcome).toBe(search);
      expect((await failure(scrapeOnce(fetch))).outcome).toBe(scrape);
    }
    const plain = mockFetch({ [URLS.brightdataRequest]: () => new Response("Invalid token", { status: 401 }) });
    expect((await failure(searchOnce(plain.fetch))).message).toBe("Invalid token");
  });

  it("says a capability isn't set up, without a call, when it has no zone", async () => {
    const { fetch, calls } = mockFetch({});
    const error = await failure(ADAPTERS.brightdata.search!({ query: "q" }, { key: "k", fetch, timeoutMs: 5000 }));
    expect(error).toMatchObject({ outcome: "provider_error", fix: "Run `programscape-router keys set brightdata` to set up its zones." });
    expect(calls).toHaveLength(0);
  });

  it("reads the balance as Bright Data's paid balance in US dollars, with the note that free credits aren't in it", async () => {
    const { fetch, calls } = mockFetch({ [URLS.brightdataBalance]: ok(fixture("brightdata-balance")) });
    const reading = await ADAPTERS.brightdata.balance!(bd(fetch));
    expect(calls[0]).toMatchObject({ url: "https://api.brightdata.com/customer/balance", method: "GET", headers: { authorization: "Bearer test-key" } });
    expect(reading.balances).toEqual([
      { label: "Bright Data paid balance", kind: "credits", unit: "usd", remaining: 2, source: "provider", asOf: expect.any(String) },
    ]);
    expect(reading.note).toContain("Bright Data's paid balance in US dollars, as Bright Data reports it");
    expect(reading.note).toContain("Free monthly credits aren't included: Bright Data doesn't report them.");
  });

  it("marks a $0 balance as shown only, so it never orders or syncs", async () => {
    const { fetch } = mockFetch({ [URLS.brightdataBalance]: ok({ balance: 0, credit: 0, prepayment: 0, pending_costs: 0 }) });
    const reading = await ADAPTERS.brightdata.balance!(bd(fetch));
    expect(reading.balances[0]).toMatchObject({ remaining: 0, informational: true });
    expect(reading.note).toContain("a $0 reading isn't used for the order or sent to your Programscape plan");
  });

  it("reads a balance 403 (a key without the permission) as unknown, never a bad key; a 401 is still a bad key", async () => {
    const limited = mockFetch({ [URLS.brightdataBalance]: () => new Response("Your API key lacks the required permissions for this action", { status: 403 }) });
    const reading = await ADAPTERS.brightdata.balance!(bd(limited.fetch));
    expect(reading.balances).toEqual([]);
    expect(reading.note).toContain("needs an Admin key");
    const bad = mockFetch({ [URLS.brightdataBalance]: () => new Response("Invalid token", { status: 401 }) });
    expect((await failure(ADAPTERS.brightdata.balance!(bd(bad.fetch)))).outcome).toBe("unauthorized");
  });

  it("lists zones by name and type, and reads a limited key's empty list as empty", async () => {
    const { fetch, calls } = mockFetch({ [BRIGHTDATA_ZONE_URLS.list]: [ok(fixture("brightdata-zones")), ok([])] });
    expect(await listZones(bd(fetch))).toEqual([
      { name: "web_unlocker1", type: "unblocker" },
      { name: "programscape_serp", type: "serp" },
    ]);
    expect(await listZones(bd(fetch))).toEqual([]);
    expect(calls[0]).toMatchObject({ method: "GET", headers: { authorization: "Bearer test-key" } });
  });

  it("creates a zone with the documented body, and keeps nothing of the answer, which holds a password", async () => {
    const answer = { zone: { name: "programscape_serp", password: ["zonepass-SECRET-123"] }, customer: "hl_userid_SECRET" };
    const { fetch, calls } = mockFetch({ [BRIGHTDATA_ZONE_URLS.create]: ok(answer) });
    expect(await createZone(bd(fetch), "programscape_serp", "search")).toBeUndefined();
    expect(await createZone(bd(fetch), "programscape_unlocker", "scrape")).toBeUndefined();
    expect(calls.map((call) => [call.method, call.body])).toEqual([
      ["POST", { zone: { name: "programscape_serp", type: "unblocker" }, plan: { type: "unblocker", serp: true } }],
      ["POST", { zone: { name: "programscape_unlocker", type: "unblocker" }, plan: { type: "unblocker" } }],
    ]);
    // A failure says only the status, never the answer's words.
    const refused = mockFetch({ [BRIGHTDATA_ZONE_URLS.create]: status(403, { error: "no permission zonepass-SECRET-123" }) });
    const error = await failure(createZone(bd(refused.fetch), "programscape_serp", "search"));
    expect(error).toMatchObject({ outcome: "unauthorized", status: 403, message: "Bright Data did not create the zone (HTTP 403)" });
  });
});

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

describe("Linkup", () => {
  it("maps search, keeping text results and dropping images", async () => {
    const { fetch, calls } = mockFetch({ [URLS.linkupSearch]: ok(fixture("linkup-search")) });
    const results = await ADAPTERS.linkup.search!({ query: "What is Microsoft's 2024 revenue?", maxResults: 5 }, ctx(fetch));
    expect(calls[0]).toMatchObject({
      url: "https://api.linkup.so/v1/search",
      method: "POST",
      headers: { authorization: "Bearer test-key", "content-type": "application/json" },
      body: { q: "What is Microsoft's 2024 revenue?", depth: "fast", outputType: "searchResults", maxResults: 5 },
      redirect: "manual",
    });
    expect(results).toEqual([
      {
        title: "Microsoft 2024 Annual Report",
        url: "https://www.microsoft.com/investor/reports/ar24/index.html",
        snippet: "Highlights from fiscal year 2024 compared with fiscal year 2023 included: Microsoft Cloud revenue increased 23% to $137.4 billion.",
      },
      { title: "https://example.com/no-title", url: "https://example.com/no-title" },
    ]);
  });

  it("clamps maxResults, and reads SEARCH_QUERY_NO_RESULT as an empty list", async () => {
    const { fetch, calls } = mockFetch({ [URLS.linkupSearch]: ok({ results: [] }) });
    await ADAPTERS.linkup.search!({ query: "q", maxResults: 500 }, ctx(fetch));
    expect((calls[0]?.body as { maxResults: number }).maxResults).toBe(100);
    const none = mockFetch({
      [URLS.linkupSearch]: status(400, { statusCode: 400, error: { code: "SEARCH_QUERY_NO_RESULT", message: "Search query yields no result", details: [] } }),
    });
    expect(await ADAPTERS.linkup.search!({ query: "q" }, ctx(none.fetch))).toEqual([]);
    const shape = mockFetch({ [URLS.linkupSearch]: ok({ answer: "x" }) });
    expect((await failure(ADAPTERS.linkup.search!({ query: "q" }, ctx(shape.fetch)))).outcome).toBe("invalid_response");
  });

  it("maps fetch, with the requested URL and no title", async () => {
    const { fetch, calls } = mockFetch({ [URLS.linkupFetch]: ok(fixture("linkup-fetch")) });
    const result = await ADAPTERS.linkup.scrape!({ url: "https://docs.linkup.so" }, ctx(fetch));
    expect(calls[0]).toMatchObject({ url: "https://api.linkup.so/v1/fetch", method: "POST", body: { url: "https://docs.linkup.so" } });
    expect(result).toEqual({ url: "https://docs.linkup.so", markdown: "Get started for free, no credit card required..." });
    const empty = mockFetch({ [URLS.linkupFetch]: ok({ favicon: "https://favicons.linkup.so?domain=e.com" }) });
    expect((await failure(ADAPTERS.linkup.scrape!({ url: "https://e.com" }, ctx(empty.fetch)))).outcome).toBe("fetch_failed");
  });

  it("reads 429 by its code: spent credits or budget are exhausted, too many requests is rate limited", async () => {
    const credits = mockFetch({ [URLS.linkupSearch]: status(429, fixture("linkup-error-429")) });
    const spent = await failure(ADAPTERS.linkup.search!({ query: "q" }, ctx(credits.fetch)));
    expect(spent).toMatchObject({ outcome: "exhausted", status: 429, code: "INSUFFICIENT_FUNDS_CREDITS" });
    expect(spent.message).toBe("You do not have enough credits to perform this request.");
    const budget = mockFetch({
      [URLS.linkupFetch]: status(429, { statusCode: 429, error: { code: "EXCEED_BUDGET_LIMIT", message: "The API key has reached its configured budget limit.", details: [] } }),
    });
    expect((await failure(ADAPTERS.linkup.scrape!({ url: "https://e.com" }, ctx(budget.fetch)))).outcome).toBe("exhausted");
    const busy = mockFetch({ [URLS.linkupSearch]: status(429, { statusCode: 429, error: { code: "TOO_MANY_REQUESTS", message: "Too many requests", details: [] } }) });
    expect(await failure(ADAPTERS.linkup.search!({ query: "q" }, ctx(busy.fetch)))).toMatchObject({ outcome: "rate_limited", code: "TOO_MANY_REQUESTS" });
    // A 429 without a code is read as a rate limit, never as spent credits.
    const bare = mockFetch({ [URLS.linkupSearch]: status(429, {}) });
    expect((await failure(ADAPTERS.linkup.search!({ query: "q" }, ctx(bare.fetch)))).outcome).toBe("rate_limited");
  });

  it("reads the x402 challenge (402) as an unaccepted key, not spent credits; 401 and 403 too", async () => {
    const challenge = mockFetch({ [URLS.linkupSearch]: () => new Response("", { status: 402, headers: { "payment-required": "x402" } }) });
    expect(await failure(ADAPTERS.linkup.search!({ query: "q" }, ctx(challenge.fetch)))).toMatchObject({ outcome: "unauthorized", status: 402 });
    const balance = mockFetch({ [URLS.linkupBalance]: status(402, {}) });
    expect((await failure(ADAPTERS.linkup.balance!(ctx(balance.fetch)))).outcome).toBe("unauthorized");
    const key = mockFetch({ [URLS.linkupSearch]: status(401, { statusCode: 401, error: { code: "UNAUTHORIZED", message: "Invalid API key", details: [] } }) });
    expect((await failure(ADAPTERS.linkup.search!({ query: "q" }, ctx(key.fetch)))).outcome).toBe("unauthorized");
    const ip = mockFetch({ [URLS.linkupSearch]: status(403, { statusCode: 403, error: { code: "IP_NOT_WHITELISTED", message: "IP not allowed", details: [] } }) });
    expect((await failure(ADAPTERS.linkup.search!({ query: "q" }, ctx(ip.fetch)))).outcome).toBe("unauthorized");
  });

  it("reads every documented FETCH_* 400 as a failed fetch, so the router fails over; other 400s stay bad requests", async () => {
    const codes = [
      "FETCH_ERROR",
      "FETCH_RESPONSE_TOO_LARGE",
      "FETCH_TARGET_NOT_FOUND",
      "FETCH_TARGET_UNREACHABLE",
      "FETCH_UNSUPPORTED_CONTENT_TYPE",
      "FETCH_URL_IS_FILE",
    ];
    for (const code of codes) {
      const { fetch } = mockFetch({ [URLS.linkupFetch]: status(400, { statusCode: 400, error: { code, message: "Could not fetch", details: [] } }) });
      expect(await failure(ADAPTERS.linkup.scrape!({ url: "https://e.com" }, ctx(fetch)))).toMatchObject({ outcome: "fetch_failed", status: 400, code });
      expect(ADAPTERS.linkup.errorCodes).toContain(code);
    }
    const invalidBody = mockFetch({
      [URLS.linkupSearch]: status(400, { statusCode: 400, error: { code: "VALIDATION_ERROR", message: "Validation failed", details: [{ field: "outputType", message: "bad" }] } }),
    });
    expect(await failure(ADAPTERS.linkup.search!({ query: "q" }, ctx(invalidBody.fetch)))).toMatchObject({
      outcome: "bad_request",
      code: "VALIDATION_ERROR",
      message: "Validation failed",
    });
    const deadline = mockFetch({ [URLS.linkupSearch]: status(504, { statusCode: 504, error: { code: "REQUEST_DEADLINE_EXCEEDED", message: "Deadline", details: [] } }) });
    expect((await failure(ADAPTERS.linkup.search!({ query: "q" }, ctx(deadline.fetch)))).outcome).toBe("timeout");
    const down = mockFetch({ [URLS.linkupSearch]: status(500) });
    expect((await failure(ADAPTERS.linkup.search!({ query: "q" }, ctx(down.fetch)))).outcome).toBe("server_error");
  });

  it("reads the balance as one USD amount with no total or end date", async () => {
    const { fetch, calls } = mockFetch({ [URLS.linkupBalance]: ok(fixture("linkup-balance")) });
    const reading = await ADAPTERS.linkup.balance!(ctx(fetch));
    expect(calls[0]).toMatchObject({ url: "https://api.linkup.so/v1/credits/balance", method: "GET", headers: { authorization: "Bearer test-key" } });
    expect(reading.balances).toEqual([
      { label: "Linkup balance", kind: "credits", unit: "usd", remaining: 123.456, source: "provider", asOf: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) },
    ]);
    const shape = mockFetch({ [URLS.linkupBalance]: ok({ credits: 5 }) });
    expect((await failure(ADAPTERS.linkup.balance!(ctx(shape.fetch)))).outcome).toBe("invalid_response");
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

describe("You.com", () => {
  it("maps search: web results, then news results not already listed, with news dates read as UTC", async () => {
    const { fetch, calls } = mockFetch({ [URLS.youcomSearch]: ok(fixture("youcom-search")) });
    const results = await ADAPTERS.youcom.search!({ query: "global birth rate trends", maxResults: 5 }, ctx(fetch, "ydc-abc"));
    expect(calls[0]).toMatchObject({
      url: "https://ydc-index.io/v1/search",
      method: "POST",
      headers: { "x-api-key": "ydc-abc", "content-type": "application/json" },
      body: { query: "global birth rate trends", count: 5 },
      redirect: "manual",
    });
    expect(results).toEqual([
      {
        title: "Geopolitics News | Latest News on Geopolitics - Times of India",
        url: "https://timesofindia.indiatimes.com/topic/geopolitics/news",
        snippet: "European nations, particularly Denmark and Norway, ... … A second snippet.",
      },
      { title: "Description only", url: "https://example.com/description-only", snippet: "Only a description." },
      {
        title: "India entering golden era of defence innovation: Rajnath",
        url: "https://theprint.in/defence/india-golden-era-defence-innovation/",
        snippet: "Defence minister speaks at an innovation summit.",
        publishedAt: "2025-11-25T12:31:29.000Z",
      },
    ]);
  });

  it("clamps count to You.com's maximum and accepts a results object with no hits", async () => {
    const { fetch, calls } = mockFetch({ [URLS.youcomSearch]: ok({ results: {}, metadata: {} }) });
    expect(await ADAPTERS.youcom.search!({ query: "q", maxResults: 500 }, ctx(fetch))).toEqual([]);
    expect((calls[0]?.body as { count: number }).count).toBe(100);
    const shape = mockFetch({ [URLS.youcomSearch]: ok({ results: [] }) });
    expect((await failure(ADAPTERS.youcom.search!({ query: "q" }, ctx(shape.fetch)))).outcome).toBe("invalid_response");
  });

  it("maps contents, which answers with a list", async () => {
    const { fetch, calls } = mockFetch({ [URLS.youcomContents]: ok(fixture("youcom-contents")) });
    const result = await ADAPTERS.youcom.scrape!({ url: "https://competitor.com/pricing" }, ctx(fetch));
    expect(calls[0]).toMatchObject({
      url: "https://ydc-index.io/v1/contents",
      method: "POST",
      headers: { "x-api-key": "test-key" },
      body: { urls: ["https://competitor.com/pricing"], formats: ["markdown"] },
    });
    expect(result).toEqual({ url: "https://competitor.com/pricing", title: "Pricing — Competitor Inc.", markdown: "# Pricing\n\n## Starter Plan\n$49/month..." });
  });

  it("reads null markdown or an empty list as a failed fetch, and an object as an unreadable answer", async () => {
    const empty = mockFetch({ [URLS.youcomContents]: ok([{ url: "https://e.com", title: "t", markdown: null, html: null }]) });
    expect((await failure(ADAPTERS.youcom.scrape!({ url: "https://e.com" }, ctx(empty.fetch)))).outcome).toBe("fetch_failed");
    const none = mockFetch({ [URLS.youcomContents]: ok([]) });
    expect((await failure(ADAPTERS.youcom.scrape!({ url: "https://e.com" }, ctx(none.fetch)))).outcome).toBe("fetch_failed");
    const shape = mockFetch({ [URLS.youcomContents]: ok({ markdown: "x" }) });
    expect((await failure(ADAPTERS.youcom.scrape!({ url: "https://e.com" }, ctx(shape.fetch)))).outcome).toBe("invalid_response");
  });

  it("reads 402 as exhausted, 429 as rate limited, 401 as unauthorized, 422 as a bad request, 500 as a server error", async () => {
    const spent = mockFetch({ [URLS.youcomSearch]: status(402, { detail: "Insufficient credits" }) });
    expect(await failure(ADAPTERS.youcom.search!({ query: "q" }, ctx(spent.fetch)))).toMatchObject({
      outcome: "exhausted",
      status: 402,
      message: "Insufficient credits",
    });
    // The search reference's 402 shape: `error` is a code You.com doesn't list, so the message comes from `message`.
    const upgrade = mockFetch({
      [URLS.youcomContents]: status(402, { error: "payment_required", message: "The account cannot make paid API requests.", upgrade_url: "https://you.com/platform" }),
    });
    const upgradeError = await failure(ADAPTERS.youcom.scrape!({ url: "https://e.com" }, ctx(upgrade.fetch)));
    expect(upgradeError).toMatchObject({ outcome: "exhausted", message: "The account cannot make paid API requests." });
    expect(upgradeError.code).toBeUndefined();
    const busy = mockFetch({ [URLS.youcomSearch]: status(429, { detail: "Too many requests" }) });
    expect((await failure(ADAPTERS.youcom.search!({ query: "q" }, ctx(busy.fetch)))).outcome).toBe("rate_limited");
    const key = mockFetch({ [URLS.youcomSearch]: status(401, { detail: "Invalid or expired API key" }) });
    expect(await failure(ADAPTERS.youcom.search!({ query: "q" }, ctx(key.fetch)))).toMatchObject({ outcome: "unauthorized", message: "Invalid or expired API key" });
    const params = mockFetch({ [URLS.youcomSearch]: status(422, { error: "invalid request parameter(s)" }) });
    expect((await failure(ADAPTERS.youcom.search!({ query: "q" }, ctx(params.fetch)))).outcome).toBe("bad_request");
    const auth = mockFetch({ [URLS.youcomSearch]: status(500, { detail: "Internal authentication error" }) });
    expect((await failure(ADAPTERS.youcom.search!({ query: "q" }, ctx(auth.fetch)))).outcome).toBe("server_error");
  });

  it("reads a 403 for a missing scope as a provider error, so the key keeps working elsewhere; any other 403 as unauthorized", async () => {
    const scope = mockFetch({ [URLS.youcomContents]: status(403, { detail: "Missing required scopes" }) });
    expect(await failure(ADAPTERS.youcom.scrape!({ url: "https://e.com" }, ctx(scope.fetch)))).toMatchObject({ outcome: "provider_error", status: 403 });
    const billing = mockFetch({ [URLS.youcomBalance]: status(403, { detail: "Missing required scopes" }) });
    expect((await failure(ADAPTERS.youcom.balance!(ctx(billing.fetch)))).outcome).toBe("provider_error");
    const host = mockFetch({ [URLS.youcomBalance]: status(403, { message: "Missing Authentication Token" }) });
    expect((await failure(ADAPTERS.youcom.balance!(ctx(host.fetch)))).outcome).toBe("provider_error");
    const other = mockFetch({ [URLS.youcomSearch]: status(403, { detail: "Forbidden" }) });
    expect((await failure(ADAPTERS.youcom.search!({ query: "q" }, ctx(other.fetch)))).outcome).toBe("unauthorized");
  });

  it("reads the account balance from api.you.com, converting cents to dollars without rounding", async () => {
    const { fetch, calls } = mockFetch({ [URLS.youcomBalance]: ok(fixture("youcom-balance")) });
    const reading = await ADAPTERS.youcom.balance!(ctx(fetch, "ydc-abc"));
    expect(calls[0]).toMatchObject({ url: "https://api.you.com/v1/billing/account_balance", method: "GET", headers: { "x-api-key": "ydc-abc" }, redirect: "manual" });
    expect(reading.balances).toEqual([
      { label: "You.com account balance", kind: "credits", unit: "usd", remaining: 7189.245, source: "provider", asOf: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) },
    ]);
    const shape = mockFetch({ [URLS.youcomBalance]: ok({ data: { type: "account", id: "x", attributes: {} } }) });
    expect((await failure(ADAPTERS.youcom.balance!(ctx(shape.fetch)))).outcome).toBe("invalid_response");
  });
});

describe("Linkup and You.com keep the key out of what they return", () => {
  const KEY = "SECRET-KEY-zz9-plural-z-alpha";
  const cases = [
    { adapter: ADAPTERS.linkup, search: URLS.linkupSearch, scrape: URLS.linkupFetch, balance: URLS.linkupBalance },
    { adapter: ADAPTERS.youcom, search: URLS.youcomSearch, scrape: URLS.youcomContents, balance: URLS.youcomBalance },
  ];

  it("in every error outcome's message and code, and in every success", async () => {
    const body = { statusCode: 0, error: { code: "INSUFFICIENT_FUNDS_CREDITS", message: "provider text" }, detail: "Missing required scopes" };
    for (const { adapter, search, scrape, balance } of cases) {
      for (const code of [400, 401, 402, 403, 404, 422, 429, 500, 504]) {
        const { fetch } = mockFetch({ [search]: status(code, body), [scrape]: status(code, body), [balance]: status(code, body) });
        for (const error of [
          await failure(adapter.search!({ query: "q" }, ctx(fetch, KEY))),
          await failure(adapter.scrape!({ url: "https://e.com" }, ctx(fetch, KEY))),
          await failure(adapter.balance!(ctx(fetch, KEY))),
        ]) {
          expect(JSON.stringify({ message: error.message, code: error.code, outcome: error.outcome })).not.toContain(KEY);
        }
      }
    }
    const linkupOk = mockFetch({
      [URLS.linkupSearch]: ok(fixture("linkup-search")),
      [URLS.linkupFetch]: ok(fixture("linkup-fetch")),
      [URLS.linkupBalance]: ok(fixture("linkup-balance")),
    });
    const youcomOk = mockFetch({
      [URLS.youcomSearch]: ok(fixture("youcom-search")),
      [URLS.youcomContents]: ok(fixture("youcom-contents")),
      [URLS.youcomBalance]: ok(fixture("youcom-balance")),
    });
    for (const [adapter, fetch] of [
      [ADAPTERS.linkup, linkupOk.fetch],
      [ADAPTERS.youcom, youcomOk.fetch],
    ] as const) {
      const outputs = [
        await adapter.search!({ query: "q" }, ctx(fetch, KEY)),
        await adapter.scrape!({ url: "https://e.com" }, ctx(fetch, KEY)),
        await adapter.balance!(ctx(fetch, KEY)),
      ];
      expect(JSON.stringify(outputs)).not.toContain(KEY);
    }
    // The key went out only in the provider's own auth header, to the provider's own hosts.
    for (const call of [...linkupOk.calls, ...youcomOk.calls]) {
      const host = new URL(call.url).host;
      expect(["api.linkup.so", "ydc-index.io", "api.you.com"]).toContain(host);
      expect(JSON.stringify(call.body ?? "")).not.toContain(KEY);
      expect(call.url).not.toContain(KEY);
      const carrying = Object.entries(call.headers).filter(([, value]) => value.includes(KEY)).map(([name]) => name);
      expect(carrying).toEqual([host === "api.linkup.so" ? "authorization" : "x-api-key"]);
    }
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

  it("lets an adapter read headers and the raw text of every answer, 2xx included, and fail it", async () => {
    const { fetch } = mockFetch({
      "https://api.example.test/ok": () => new Response('{"fine":true}', { status: 200, headers: { "x-error": "captcha" } }),
      "https://api.example.test/text": () => new Response('zone "x" not found', { status: 400, headers: { "content-type": "text/html" } }),
    });
    const seen: Array<{ status: number; header: string | null; body: unknown; text: string }> = [];
    const inspect = (answer: { status: number; headers: Headers; body: unknown; text: string }) => {
      seen.push({ status: answer.status, header: answer.headers.get("x-error"), body: answer.body, text: answer.text });
      return answer.headers.get("x-error") ? new ProviderCallError("provider_error", "header said so", answer.status, "captcha") : undefined;
    };
    const failed = await failure(requestJson(ctx(fetch), "https://api.example.test/ok", { headers: {}, inspect }));
    expect(failed).toMatchObject({ outcome: "provider_error", status: 200, code: "captcha", switchOff: false });
    // A text body reaches the hook as text; returning undefined leaves the shared reading (400 is a bad request).
    const plain = await failure(requestJson(ctx(fetch), "https://api.example.test/text", { headers: {}, inspect }));
    expect(plain.outcome).toBe("bad_request");
    expect(seen).toEqual([
      { status: 200, header: "captcha", body: { fine: true }, text: '{"fine":true}' },
      { status: 400, header: null, body: undefined, text: 'zone "x" not found' },
    ]);
    // Without a hook nothing changes.
    expect(await requestJson(ctx(fetch), "https://api.example.test/ok", { headers: {} })).toEqual({ fine: true });
  });

  it("carries our own fix and the switch-off flag on a failure", () => {
    const error = new ProviderCallError("provider_error", "m", 400, undefined, { fix: "Run setup.", switchOff: true });
    expect(error).toMatchObject({ fix: "Run setup.", switchOff: true });
    expect(new ProviderCallError("timeout", "m")).toMatchObject({ fix: undefined, switchOff: false });
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
