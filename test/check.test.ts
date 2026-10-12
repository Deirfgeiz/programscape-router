import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CHECK_HINTS, CHECK_URL, VERBOSE_WARNING, formatCheck, runCheck } from "../src/check.js";
import { main } from "../src/cli-main.js";
import { URLS, fixture, json, mockFetch, ok, status, timeout, type Responder } from "./helpers.js";

const KEYS = {
  EXA_API_KEY: "exa-CHECKSECRET-1111",
  FIRECRAWL_API_KEY: "fc-CHECKSECRET-2222",
  KEENABLE_API_KEY: "keen_CHECKSECRET-3333",
  LINKUP_API_KEY: "lk-CHECKSECRET-6666",
  PARALLEL_API_KEY: "par-CHECKSECRET-4444",
  TAVILY_API_KEY: "tvly-CHECKSECRET-5555",
  YDC_API_KEY: "ydc-CHECKSECRET-7777",
};
const PROVIDER_HOSTS = new Set([
  "api.exa.ai",
  "api.firecrawl.dev",
  "api.keenable.ai",
  "api.linkup.so",
  "api.parallel.ai",
  "api.tavily.com",
  "ydc-index.io",
  "api.you.com",
]);

/** Every piece of content a provider hands back carries "zebra", so a leak anywhere is easy to find. */
const TITLE = "Result title zebra-title";
const RESULT_URL = "https://results.example/zebra-url";
const SNIPPET = "Snippet text zebra-snippet";
const PAGE = "# Page heading zebra-page\n\nBody text zebra-body.";

const success: Record<string, Responder> = {
  [URLS.exaSearch]: ok({
    requestId: "r",
    results: [1, 2, 3].map((n) => ({ title: `${TITLE} ${n}`, url: `${RESULT_URL}/${n}`, highlights: [SNIPPET] })),
  }),
  [URLS.exaContents]: ok({ results: [{ url: CHECK_URL, title: TITLE, text: PAGE }], statuses: [{ id: CHECK_URL, status: "success" }] }),
  [URLS.firecrawlSearch]: ok({ success: true, data: { web: [{ url: RESULT_URL, title: TITLE, description: SNIPPET }] } }),
  [URLS.firecrawlScrape]: ok({ success: true, data: { markdown: PAGE, metadata: { title: TITLE, url: RESULT_URL } } }),
  [URLS.firecrawlCredits]: ok(fixture("firecrawl-credit-usage")),
  [URLS.keenableSearch]: ok({ results: [{ url: RESULT_URL, title: TITLE, snippet: SNIPPET }, { url: `${RESULT_URL}/2`, title: TITLE }] }),
  [URLS.keenableFetch]: ok({ url: CHECK_URL, title: TITLE, content: PAGE }),
  [URLS.linkupSearch]: ok({ results: [{ type: "text", name: TITLE, url: RESULT_URL, content: SNIPPET, favicon: "" }] }),
  [URLS.linkupFetch]: ok({ markdown: PAGE, favicon: "https://favicons.linkup.so?domain=example.com" }),
  [URLS.linkupBalance]: ok(fixture("linkup-balance")),
  [URLS.parallelSearch]: ok({ search_id: "s", session_id: "x", results: [{ url: RESULT_URL, title: TITLE, excerpts: [SNIPPET] }] }),
  [URLS.parallelExtract]: ok({ extract_id: "e", session_id: "x", errors: [], results: [{ url: CHECK_URL, title: TITLE, excerpts: [], full_content: PAGE }] }),
  [URLS.tavilySearch]: ok({ results: [{ url: RESULT_URL, title: TITLE, content: SNIPPET }, { url: `${RESULT_URL}/2`, title: TITLE, content: SNIPPET }] }),
  [URLS.tavilyExtract]: ok({ results: [{ url: CHECK_URL, title: TITLE, raw_content: PAGE }], failed_results: [] }),
  [URLS.tavilyUsage]: ok(fixture("tavily-usage")),
  [URLS.youcomSearch]: ok({ results: { web: [{ url: RESULT_URL, title: TITLE, snippets: [SNIPPET] }], news: [] }, metadata: {} }),
  [URLS.youcomContents]: ok([{ url: CHECK_URL, title: TITLE, markdown: PAGE, html: null }]),
  [URLS.youcomBalance]: ok(fixture("youcom-balance")),
};

/** A clock that advances 42 ms per reading, so every latency is 42 ms. */
function steppingClock(): () => number {
  let t = 0;
  return () => (t += 42);
}

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { streams: { stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t) }, out, err, all: () => out.join("") + err.join("") };
}

function expectNoContent(text: string): void {
  expect(text).not.toContain("zebra");
  expect(text).not.toContain("results.example");
  expect(text).not.toContain("Result title");
  expect(text).not.toContain("Snippet text");
  expect(text).not.toContain("Page heading");
  for (const key of Object.values(KEYS)) expect(text).not.toContain(key);
  expect(text).not.toContain("CHECKSECRET");
}

describe("check", () => {
  it("calls every provider directly, once per capability, and passes when every call passes", async () => {
    const { fetch, calls } = mockFetch(success);
    // Providers run side by side, so a stepping clock would interleave; a fixed one keeps latencies at 0 here.
    const report = await runCheck({ env: KEYS, fetch, now: () => new Date("2026-10-11T12:00:00Z"), clock: () => 1000 });

    expect(report.ok).toBe(true);
    expect(report).toMatchObject({ attempted: 18, passed: 18, failed: 0, query: "startup credits", maxResults: 3, url: "https://example.com" });

    // One call per endpoint: no routing, no failover, no retries.
    const urls = calls.map((call) => call.url.split("?")[0]);
    expect(urls.sort()).toEqual(Object.values(URLS).sort());
    for (const call of calls) expect(PROVIDER_HOSTS.has(new URL(call.url).host)).toBe(true);

    // The fixed query and page.
    expect(calls.find((c) => c.url === URLS.exaSearch)?.body).toMatchObject({ query: "startup credits", numResults: 3 });
    expect(calls.find((c) => c.url === URLS.parallelSearch)?.body).toMatchObject({ objective: "startup credits", search_queries: ["startup credits"], advanced_settings: { max_results: 3 } });
    expect(calls.find((c) => c.url.startsWith(URLS.keenableFetch))?.url).toBe("https://api.keenable.ai/v1/fetch?url=https%3A%2F%2Fexample.com&live=true");
    expect(calls.find((c) => c.url === URLS.tavilyExtract)?.body).toMatchObject({ urls: ["https://example.com"] });
    expect(calls.find((c) => c.url === URLS.linkupSearch)?.body).toMatchObject({ q: "startup credits", maxResults: 3 });
    expect(calls.find((c) => c.url === URLS.linkupFetch)?.body).toEqual({ url: "https://example.com" });
    expect(calls.find((c) => c.url === URLS.youcomSearch)?.body).toEqual({ query: "startup credits", count: 3 });
    expect(calls.find((c) => c.url === URLS.youcomContents)?.body).toMatchObject({ urls: ["https://example.com"] });

    // Each key went only to its own provider.
    for (const call of calls) {
      const sent = JSON.stringify(call.headers);
      const own = Object.entries(KEYS).filter(([, key]) => sent.includes(key));
      expect(own).toHaveLength(1);
    }

    const exa = report.providers.find((p) => p.provider === "exa");
    expect(exa).toMatchObject({
      balanceSupported: false,
      calls: [
        { capability: "search", ok: true, outcome: "ok", latencyMs: 0, resultCount: 3 },
        { capability: "scrape", ok: true, outcome: "ok", latencyMs: 0, markdownLength: PAGE.length },
      ],
    });
    const firecrawl = report.providers.find((p) => p.provider === "firecrawl");
    expect(firecrawl?.calls[2]).toEqual({
      capability: "balance",
      ok: true,
      outcome: "ok",
      latencyMs: 0,
      balances: [{ kind: "credits", fields: ["remaining", "total", "unit", "endsOn"] }],
    });
    const tavily = report.providers.find((p) => p.provider === "tavily");
    expect(tavily?.calls[2]?.balances).toEqual([
      { kind: "credits", fields: ["remaining", "total", "unit"] },
      { kind: "pay-as-you-go", fields: ["remaining", "total", "unit"] },
      { kind: "key-limit", fields: ["remaining", "total", "unit"] },
    ]);
    // Linkup and You.com each report one USD amount: no total, no end date.
    for (const id of ["linkup", "youcom"]) {
      expect(report.providers.find((p) => p.provider === id)).toMatchObject({
        balanceSupported: true,
        calls: [
          { capability: "search", ok: true, resultCount: 1 },
          { capability: "scrape", ok: true, markdownLength: PAGE.length },
          { capability: "balance", ok: true, balances: [{ kind: "credits", fields: ["remaining", "unit"] }] },
        ],
      });
    }

    const text = formatCheck(report);
    expect(text).toContain("exa (EXA_API_KEY, from the environment)");
    expect(text).toContain("  search   ok                        0 ms  3 results");
    expect(text).toContain(`  scrape   ok                        0 ms  markdown, ${PAGE.length} chars`);
    expect(text).toContain("  balance  -                               no public balance endpoint (add your credits in config)");
    expect(text).toContain("  balance  ok                        0 ms  credits (remaining, total, unit, endsOn)");
    expect(text).toContain("PASS: 18 of 18 calls passed.");
    expectNoContent(text);
    expectNoContent(JSON.stringify(report));
    // Balance amounts are not part of the report either.
    expect(JSON.stringify(report)).not.toContain("500000");
    expect(JSON.stringify(report)).not.toContain("123.456");
    expect(JSON.stringify(report)).not.toContain("7189");
  });

  // [name, response, outcome, HTTP status, documented code shown]
  const outcomes: Array<[string, Responder, string, number | undefined, string | undefined]> = [
    ["exhausted (402)", status(402, { requestId: "r", error: "No more credits", tag: "NO_MORE_CREDITS" }), "exhausted", 402, "NO_MORE_CREDITS"],
    ["rate_limited (429)", status(429, { requestId: "r", error: "Slow down", tag: "RATE_LIMIT_EXCEEDED" }), "rate_limited", 429, "RATE_LIMIT_EXCEEDED"],
    ["unauthorized (401)", status(401, { requestId: "r", error: "Invalid API key", tag: "INVALID_API_KEY" }), "unauthorized", 401, "INVALID_API_KEY"],
    ["bad_request (400)", status(400, fixture("exa-error")), "bad_request", 400, "INVALID_REQUEST_BODY"],
    ["server_error (503)", status(503, { requestId: "r", error: "Over capacity", tag: "SERVICE_OVERLOADED" }), "server_error", 503, "SERVICE_OVERLOADED"],
    ["provider_error (404, undocumented tag)", status(404, { requestId: "r", error: "Not found", tag: "NOT_FOUND" }), "provider_error", 404, undefined],
    ["provider_error (FEATURE_DISABLED)", status(403, { requestId: "r", error: "Not on your plan", tag: "FEATURE_DISABLED" }), "provider_error", 403, "FEATURE_DISABLED"],
    ["timeout", timeout, "timeout", undefined, undefined],
  ];

  for (const [name, responder, outcome, httpStatus, code] of outcomes) {
    it(`reports ${name} with its class, status, documented code and our hint, and exits 1`, async () => {
      const { fetch } = mockFetch({ ...success, [URLS.exaSearch]: responder });
      const report = await runCheck({ env: { EXA_API_KEY: KEYS.EXA_API_KEY }, fetch, clock: steppingClock() });
      const search = report.providers.find((p) => p.provider === "exa")?.calls[0];
      expect(search).toMatchObject({ capability: "search", ok: false, outcome, latencyMs: 42, hint: CHECK_HINTS[outcome as keyof typeof CHECK_HINTS] });
      expect(search?.status).toBe(httpStatus);
      expect(search?.code).toBe(code);
      expect(search).not.toHaveProperty("providerMessage");
      expect(report).toMatchObject({ ok: false, attempted: 2, passed: 1, failed: 1, verbose: false });
      expect(formatCheck(report)).toContain(`  search   FAIL ${outcome}`);
      expect(formatCheck(report)).toContain("FAIL: 1 of 2 calls passed, 1 failed; 6 providers skipped (no key).");

      const { streams } = io();
      expect(await main(["check"], streams, { env: { EXA_API_KEY: KEYS.EXA_API_KEY }, fetch })).toBe(1);
    });
  }

  it("reads each provider's documented out-of-credits answer as exhausted", async () => {
    const { fetch } = mockFetch({
      ...success,
      [URLS.firecrawlScrape]: status(402, fixture("firecrawl-error-402")),
      [URLS.tavilySearch]: status(432, fixture("tavily-error-432")),
      [URLS.parallelSearch]: status(402, { type: "error", error: { ref_id: "r", message: "Insufficient credit in account" } }),
      [URLS.keenableFetch]: status(402, { detail: "No credits available" }),
      [URLS.linkupSearch]: status(429, fixture("linkup-error-429")),
      [URLS.youcomSearch]: status(402, { detail: "Insufficient credits" }),
    });
    const report = await runCheck({ env: KEYS, fetch });
    const outcome = (provider: string, capability: string) =>
      report.providers.find((p) => p.provider === provider)?.calls.find((c) => c.capability === capability);
    expect(outcome("firecrawl", "scrape")).toMatchObject({ outcome: "exhausted", status: 402, code: "insufficient_credits" });
    expect(outcome("tavily", "search")).toMatchObject({ outcome: "exhausted", status: 432 });
    expect(outcome("parallel", "search")).toMatchObject({ outcome: "exhausted", status: 402 });
    expect(outcome("keenable", "scrape")).toMatchObject({ outcome: "exhausted", status: 402 });
    expect(outcome("linkup", "search")).toMatchObject({ outcome: "exhausted", status: 429, code: "INSUFFICIENT_FUNDS_CREDITS" });
    expect(outcome("youcom", "search")).toMatchObject({ outcome: "exhausted", status: 402 });
    expect(outcome("youcom", "search")).not.toHaveProperty("code");
    expect(report.failed).toBe(6);
    // The providers' own words stay out of the default report.
    expect(JSON.stringify(report)).not.toContain("Insufficient credit");
    expect(JSON.stringify(report)).not.toContain("No credits available");
    expect(JSON.stringify(report)).not.toContain("Insufficient credits");
    expect(JSON.stringify(report)).not.toContain("enough credits");
  });

  it("tells Linkup's rate limit apart from its spent credits, and keeps a You.com scope 403 from reading as a bad key", async () => {
    const { fetch } = mockFetch({
      ...success,
      [URLS.linkupSearch]: status(429, { statusCode: 429, error: { code: "TOO_MANY_REQUESTS", message: "Too many requests", details: [] } }),
      [URLS.linkupFetch]: status(400, { statusCode: 400, error: { code: "FETCH_TARGET_UNREACHABLE", message: "Unreachable", details: [] } }),
      [URLS.youcomContents]: status(403, { detail: "Missing required scopes" }),
    });
    const report = await runCheck({ env: { LINKUP_API_KEY: KEYS.LINKUP_API_KEY, YDC_API_KEY: KEYS.YDC_API_KEY }, fetch });
    const calls = (provider: string) => report.providers.find((p) => p.provider === provider)?.calls;
    expect(calls("linkup")).toMatchObject([
      { capability: "search", outcome: "rate_limited", status: 429, code: "TOO_MANY_REQUESTS" },
      { capability: "scrape", outcome: "fetch_failed", status: 400, code: "FETCH_TARGET_UNREACHABLE" },
      { capability: "balance", ok: true },
    ]);
    expect(calls("youcom")).toMatchObject([
      { capability: "search", ok: true },
      { capability: "scrape", outcome: "provider_error", status: 403 },
      { capability: "balance", ok: true },
    ]);
    expectNoContent(JSON.stringify(report));
  });

  it("reads Parallel's documented error envelope for a rejected request", async () => {
    const { fetch } = mockFetch({ ...success, [URLS.parallelSearch]: status(422, fixture("parallel-error")) });
    const report = await runCheck({ env: { PARALLEL_API_KEY: "par-key-1" }, fetch });
    expect(report.providers.find((p) => p.provider === "parallel")?.calls[0]).toMatchObject({ outcome: "bad_request", status: 422 });
    const verbose = await runCheck({ env: { PARALLEL_API_KEY: "par-key-1" }, fetch, verbose: true });
    expect(verbose.providers.find((p) => p.provider === "parallel")?.calls[0]?.providerMessage).toBe("Request validation error");
  });

  it("reports a page the provider could not fetch, and a balance it could not read", async () => {
    const { fetch } = mockFetch({
      ...success,
      [URLS.exaContents]: ok(fixture("exa-contents-error")),
      [URLS.firecrawlCredits]: status(500, { success: false, error: "Internal server error while fetching credit usage" }),
    });
    const report = await runCheck({ env: { EXA_API_KEY: "exa-key-1", FIRECRAWL_API_KEY: "fc-key-1" }, fetch });
    const exaScrape = report.providers.find((p) => p.provider === "exa")?.calls[1];
    expect(exaScrape).toEqual(expect.objectContaining({ outcome: "fetch_failed", code: "CRAWL_NOT_FOUND" }));
    expect(exaScrape?.status).toBeUndefined();
    const balance = report.providers.find((p) => p.provider === "firecrawl")?.calls[2];
    expect(balance).toMatchObject({ capability: "balance", ok: false, outcome: "server_error", status: 500 });
  });

  it("keeps a short key, an amount, a URL and an email a provider echoes out of the default and --json output", async () => {
    // The case a review found: a 3-character key, a balance amount, a private URL and an email in an error body,
    // and in an error code field too.
    const leaky = "key abc; balance 777 credits; URL https://private.example/page; contact founder@example.com";
    const responder: Responder = () => json({ error: leaky, tag: leaky, code: leaky, detail: { error: leaky } }, 401);
    const routes: Record<string, Responder> = {};
    for (const url of Object.values(URLS)) routes[url] = responder;
    const { fetch } = mockFetch(routes);
    const env = {
      EXA_API_KEY: "abc",
      FIRECRAWL_API_KEY: "fc-x",
      KEENABLE_API_KEY: "kx",
      LINKUP_API_KEY: "lk-x",
      PARALLEL_API_KEY: "p",
      TAVILY_API_KEY: "t-1",
      YDC_API_KEY: "yd-x",
    };

    const text = io();
    expect(await main(["check"], text.streams, { env, fetch })).toBe(1);
    const jsonOut = io();
    expect(await main(["check", "--json"], jsonOut.streams, { env, fetch })).toBe(1);
    for (const output of [text.all(), jsonOut.all()]) {
      expect(output).not.toContain("abc");
      expect(output).not.toContain("777");
      expect(output).not.toContain("private.example");
      expect(output).not.toContain("founder@example.com");
      expect(output).not.toContain("key abc");
    }
    const report = JSON.parse(jsonOut.out.join(""));
    expect(report.verbose).toBe(false);
    for (const provider of report.providers) {
      for (const call of provider.calls) {
        expect(call.outcome).toBe("unauthorized");
        expect(call).not.toHaveProperty("providerMessage");
        expect(call).not.toHaveProperty("code"); // not a documented code, so not shown
      }
    }
  });

  it("shows providers' messages only with --verbose, keys redacted, under a do-not-share warning", async () => {
    // Error bodies that echo the request headers (and so the key) back.
    const echo: Responder = (call) => json({ error: `bad key ${JSON.stringify(call.headers)} and also ${KEYS.TAVILY_API_KEY}` }, 401);
    const routes: Record<string, Responder> = {};
    for (const url of Object.values(URLS)) routes[url] = echo;
    const { fetch } = mockFetch(routes);

    const text = io();
    expect(await main(["check", "--verbose"], text.streams, { env: KEYS, fetch })).toBe(1);
    const json_ = io();
    expect(await main(["check", "--json", "--verbose"], json_.streams, { env: KEYS, fetch })).toBe(1);

    expect(text.out.join("").startsWith(`${VERBOSE_WARNING}\n`)).toBe(true);
    expect(text.out.join("")).toContain("provider said (not for sharing): bad key");
    const report = JSON.parse(json_.out.join(""));
    expect(report).toMatchObject({ verbose: true, warning: VERBOSE_WARNING, failed: 18 });
    for (const output of [text.out.join(""), JSON.stringify(report)]) {
      expect(output).toContain("[redacted]");
      expectNoContent(output);
    }
  });

  it("redacts even a very short key in --verbose output", async () => {
    const { fetch } = mockFetch({ ...success, [URLS.exaSearch]: status(401, { error: "key abc is not valid" }) });
    const report = await runCheck({ env: { EXA_API_KEY: "abc" }, fetch, verbose: true });
    expect(report.providers[0]?.calls[0]?.providerMessage).toBe("key [redacted] is not valid");
  });

  it("cuts long provider messages in --verbose output", async () => {
    const { fetch } = mockFetch({ ...success, [URLS.exaSearch]: status(500, { error: "x".repeat(2000) }) });
    const report = await runCheck({ env: { EXA_API_KEY: "exa-key-1" }, fetch, verbose: true });
    expect(report.providers[0]?.calls[0]?.providerMessage).toHaveLength(300);
  });

  it("reports a fetch that throws as a network error, without its message", async () => {
    const { fetch } = mockFetch({
      ...success,
      [URLS.exaSearch]: () => {
        throw new TypeError(`boom ${PAGE}`);
      },
    });
    const report = await runCheck({ env: { EXA_API_KEY: "exa-key-1" }, fetch, verbose: true });
    expect(report.providers[0]?.calls[0]).toMatchObject({ outcome: "network_error", providerMessage: "Could not reach the provider" });
    expectNoContent(JSON.stringify(report));
  });

  it("never reports an unexpected adapter error's own message, even with --verbose", async () => {
    // A response object that blows up when read: an adapter bug, not a provider answer.
    const broken = {
      get type(): string {
        throw new TypeError(`boom ${PAGE} ${RESULT_URL}`);
      },
    } as unknown as Response;
    const { fetch } = mockFetch({ ...success, [URLS.exaSearch]: () => broken });
    const report = await runCheck({ env: { EXA_API_KEY: "exa-key-1" }, fetch, verbose: true });
    expect(report.providers[0]?.calls[0]).toMatchObject({
      ok: false,
      outcome: "provider_error",
      hint: "The adapter failed unexpectedly. Please open an issue with check --json.",
    });
    expect(report.providers[0]?.calls[0]).not.toHaveProperty("providerMessage");
    expectNoContent(JSON.stringify(report));
  });

  it("skips providers without a key and says so", async () => {
    const { fetch, calls } = mockFetch(success);
    const { streams, out } = io();
    const code = await main(["check"], streams, { env: { TAVILY_API_KEY: "tvly-key-1" }, fetch });
    expect(code).toBe(0);
    const text = out.join("");
    expect(text).toContain("exa: skipped (no key: set EXA_API_KEY or run `programscape-router keys set exa`)");
    expect(text).toContain("parallel: skipped (no key: set PARALLEL_API_KEY or run `programscape-router keys set parallel`)");
    expect(text).toContain("tavily (TAVILY_API_KEY, from the environment)");
    expect(text).toContain("linkup: skipped (no key: set LINKUP_API_KEY or run `programscape-router keys set linkup`)");
    expect(text).toContain("youcom: skipped (no key: set YDC_API_KEY or run `programscape-router keys set youcom`)");
    expect(text).toContain("PASS: 3 of 3 calls passed; 6 providers skipped (no key).");
    expect(calls.every((call) => new URL(call.url).host === "api.tavily.com")).toBe(true);
  });

  it("exits 1 and says so when no key is set at all", async () => {
    const { fetch, calls } = mockFetch({});
    const { streams, out } = io();
    expect(await main(["check"], streams, { env: {}, fetch })).toBe(1);
    expect(out.join("")).toContain("No provider key is set, so nothing was checked.");
    expect(calls).toHaveLength(0);
  });

  it("prints JSON with --json and exits 0 when every call passes", async () => {
    const { fetch } = mockFetch(success);
    const { streams, out } = io();
    expect(await main(["check", "--json"], streams, { env: KEYS, fetch })).toBe(0);
    const report = JSON.parse(out.join(""));
    expect(report).toMatchObject({ ok: true, attempted: 18, passed: 18, failed: 0 });
    expect(report.providers.map((p: { provider: string }) => p.provider)).toEqual(["exa", "firecrawl", "keenable", "linkup", "parallel", "tavily", "youcom"]);
    expectNoContent(out.join(""));
  });

  it("writes nothing to the ledger, never calls Programscape, and ignores the config file", async () => {
    const state = mkdtempSync(join(tmpdir(), "psr-check-state-"));
    const config = mkdtempSync(join(tmpdir(), "psr-check-config-"));
    const { fetch, calls } = mockFetch(success);
    const { streams } = io();
    const env = {
      ...KEYS,
      XDG_STATE_HOME: state,
      XDG_CONFIG_HOME: config,
      // A broken config would stop every other command; check does not read config at all.
      PROGRAMSCAPE_ROUTER_CONFIG: "/definitely/not/here.json",
    };
    expect(await main(["check"], streams, { env, fetch })).toBe(0);
    expect(readdirSync(state)).toEqual([]);
    expect(readdirSync(config)).toEqual([]);
    expect(calls.some((call) => call.url.includes("programscape"))).toBe(false);
  });
});
