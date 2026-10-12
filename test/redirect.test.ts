import { type IncomingHttpHeaders, type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ADAPTERS, ProviderCallError } from "../src/providers/index.js";
import { requestJson } from "../src/providers/http.js";
import { createRouter } from "../src/router.js";
import { URLS, fixture, mockFetch, ok, type Responder } from "./helpers.js";

const KEY = "secret-redirect-key-123";
const servers: Server[] = [];

async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

describe("redirects never carry a key to another host", () => {
  it.each([301, 302, 303, 307, 308])("a real %i to another host is not followed, so the key never arrives there", async (code) => {
    const received: IncomingHttpHeaders[] = [];
    const elsewhere = await listen((req, res) => {
      received.push(req.headers);
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
    // Same machine, different hostname and port: a different origin, as a hostile redirect would be.
    const target = `http://localhost:${elsewhere.split(":")[1]}/steal`;
    const provider = await listen((_req, res) => {
      res.writeHead(code, { location: target }).end();
    });

    let error: unknown;
    try {
      await requestJson({ key: KEY, fetch: (input, init) => globalThis.fetch(input, init), timeoutMs: 5000 }, `http://${provider}/search`, {
        headers: { "x-api-key": KEY, authorization: `Bearer ${KEY}` },
        body: { query: "q" },
      });
    } catch (caught) {
      error = caught;
    }

    expect(received).toEqual([]);
    expect(error).toBeInstanceOf(ProviderCallError);
    expect((error as ProviderCallError).outcome).toBe("provider_error");
    expect((error as ProviderCallError).status).toBe(code);
    expect((error as ProviderCallError).message).toContain("redirect");
    expect((error as ProviderCallError).message).not.toContain(KEY);
  });

  it("asks fetch not to follow redirects on every provider call, including balance reads", async () => {
    const { fetch, calls } = mockFetch({
      [URLS.exaSearch]: ok(fixture("exa-search")),
      [URLS.exaContents]: ok(fixture("exa-contents")),
      [URLS.firecrawlSearch]: ok(fixture("firecrawl-search")),
      [URLS.firecrawlScrape]: ok(fixture("firecrawl-scrape")),
      [URLS.firecrawlCredits]: ok(fixture("firecrawl-credit-usage")),
      [URLS.keenableSearch]: ok(fixture("keenable-search")),
      [URLS.keenableFetch]: ok(fixture("keenable-fetch")),
      [URLS.parallelSearch]: ok(fixture("parallel-search")),
      [URLS.parallelExtract]: ok(fixture("parallel-extract")),
      [URLS.tavilySearch]: ok(fixture("tavily-search")),
      [URLS.tavilyExtract]: ok(fixture("tavily-extract")),
      [URLS.tavilyUsage]: ok(fixture("tavily-usage")),
    });
    const ctx = { key: KEY, fetch, timeoutMs: 5000 };
    for (const adapter of Object.values(ADAPTERS)) {
      await adapter.search!({ query: "q" }, ctx);
      await adapter.scrape!({ url: "https://example.com/" }, ctx);
      await adapter.balance?.(ctx);
    }
    expect(calls).toHaveLength(12);
    for (const call of calls) expect(call.redirect).toBe("manual");
  });

  it("fails over to the next provider on a redirect, and never calls the redirect target", async () => {
    const redirect: Responder = () => new Response(null, { status: 302, headers: { location: "https://attacker.example/collect" } });
    const { fetch, calls } = mockFetch({
      [URLS.exaSearch]: redirect,
      [URLS.tavilyUsage]: redirect,
      [URLS.tavilySearch]: ok(fixture("tavily-search")),
    });
    const logs: string[] = [];
    const router = createRouter({
      env: { EXA_API_KEY: KEY, TAVILY_API_KEY: "tvly-other" },
      config: {},
      fetch,
      ledgerPath: false,
      log: (m) => logs.push(m),
    });
    const response = await router.search({ query: "q" });
    expect(response.routing.provider).toBe("tavily");
    expect(response.routing.tried[0]).toMatchObject({ provider: "exa", outcome: "provider_error", status: 302 });
    expect(calls.some((call) => call.url.includes("attacker.example"))).toBe(false);
    expect(JSON.stringify([response.routing, logs])).not.toContain(KEY);
    // A redirect is not a spent or refused key: Exa stays in the order for the next call.
    const status = await router.status();
    expect(status.order.search.entries.map((e) => e.provider)).toContain("exa");
  });
});
