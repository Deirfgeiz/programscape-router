import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sanitizeLedger } from "../src/ledger.js";
import { connect } from "../src/programscape/connect.js";
import { createRouter } from "../src/router.js";
import { URLS, fixture, mockFetch, ok, status, type Responder } from "./helpers.js";
import { ORIGIN, combine, fakeProgramscape } from "./programscape-fake.js";

const KEYS = {
  EXA_API_KEY: "exa-SECRET-1111",
  FIRECRAWL_API_KEY: "fc-SECRET-2222",
  KEENABLE_API_KEY: "keen_SECRET-3333",
  PARALLEL_API_KEY: "par-SECRET-4444",
  TAVILY_API_KEY: "tvly-SECRET-5555",
};
const HOSTS: Record<keyof typeof KEYS, string> = {
  EXA_API_KEY: "api.exa.ai",
  FIRECRAWL_API_KEY: "api.firecrawl.dev",
  KEENABLE_API_KEY: "api.keenable.ai",
  PARALLEL_API_KEY: "api.parallel.ai",
  TAVILY_API_KEY: "api.tavily.com",
};
const QUERY = "confidential acquisition target zebra-otter-42";
const PAGE = "https://private.example.com/board-minutes-zebra";

/** An error body that echoes both the key and the query back, the worst case for leaking. */
function echo(code: number): Responder {
  return (call) =>
    new Response(JSON.stringify({ error: `bad ${JSON.stringify(call.headers)} for ${JSON.stringify(call.body ?? call.url)}` }), {
      status: code,
    });
}

describe("privacy", () => {
  it("never writes keys, queries, URLs or content to the ledger or the log", async () => {
    const dir = mkdtempSync(join(tmpdir(), "psr-ledger-"));
    const ledgerPath = join(dir, "ledger.json");
    const logs: string[] = [];
    const { fetch } = mockFetch({
      [URLS.exaSearch]: echo(402),
      [URLS.firecrawlCredits]: echo(500),
      [URLS.firecrawlSearch]: echo(401),
      [URLS.keenableSearch]: echo(429),
      [URLS.parallelSearch]: echo(503),
      [URLS.tavilyUsage]: echo(500),
      [URLS.tavilySearch]: ok(fixture("tavily-search")),
      [URLS.exaContents]: echo(402),
      [URLS.firecrawlScrape]: echo(401),
      [URLS.keenableFetch]: echo(402),
      [URLS.parallelExtract]: echo(402),
      [URLS.tavilyExtract]: ok({ results: [{ url: PAGE, raw_content: "secret board minutes zebra" }] }),
    });
    const router = createRouter({ env: KEYS, config: {}, fetch, ledgerPath, log: (m) => logs.push(m) });

    const search = await router.search({ query: QUERY });
    expect(search.routing.provider).toBe("tavily");
    const scrape = await router.scrape({ url: PAGE });
    expect(scrape.routing.provider).toBe("tavily");
    await router.flush();

    // Messages handed back to the caller have keys redacted.
    const returned = JSON.stringify([search.routing, scrape.routing]);
    for (const key of Object.values(KEYS)) expect(returned).not.toContain(key);

    const ledgerText = readFileSync(ledgerPath, "utf8");
    const logText = logs.join("\n");
    for (const text of [ledgerText, logText]) {
      for (const key of Object.values(KEYS)) expect(text).not.toContain(key);
      expect(text).not.toContain("SECRET");
      expect(text).not.toContain("zebra");
      expect(text).not.toContain("private.example.com");
      expect(text).not.toContain("board");
    }

    const ledger = JSON.parse(ledgerText);
    const day = new Date().toISOString().slice(0, 10);
    expect(ledger.days[day]).toEqual({
      exa: { search: { exhausted: 1 } },
      firecrawl: { search: { unauthorized: 1 } },
      keenable: { search: { rate_limited: 1 }, scrape: { exhausted: 1 } },
      parallel: { search: { server_error: 1 }, scrape: { exhausted: 1 } },
      tavily: { search: { ok: 1 }, scrape: { ok: 1 } },
    });
    // The ledger is exactly its sanitized self: nothing but counts.
    expect(ledger).toEqual(sanitizeLedger(ledger));
  });

  it("sends each key only to its own provider's host and makes no other network call", async () => {
    const { fetch, calls } = mockFetch({
      [URLS.exaSearch]: status(503),
      [URLS.firecrawlCredits]: ok(fixture("firecrawl-credit-usage")),
      [URLS.firecrawlSearch]: status(503),
      [URLS.keenableSearch]: status(503),
      [URLS.parallelSearch]: status(503),
      [URLS.tavilyUsage]: ok(fixture("tavily-usage")),
      [URLS.tavilySearch]: status(503),
    });
    const router = createRouter({ env: KEYS, config: {}, fetch, ledgerPath: false, log: () => {} });
    await router.search({ query: QUERY }).catch(() => undefined);
    await router.status({ refresh: true });

    expect(calls.length).toBeGreaterThan(5);
    for (const call of calls) {
      const host = new URL(call.url).host;
      expect(Object.values(HOSTS)).toContain(host);
      expect(host).not.toContain("programscape");
      const sent = JSON.stringify(call);
      for (const [name, key] of Object.entries(KEYS)) {
        if (HOSTS[name as keyof typeof KEYS] === host) expect(sent).toContain(key);
        else expect(sent).not.toContain(key);
      }
    }
  });

  it("drops anything that is not a count when it reads an existing ledger", () => {
    const dirty = {
      version: 1,
      query: QUERY,
      days: {
        "2026-10-11": { exa: { search: { ok: 2, note: QUERY, exhausted: -1 }, crawl: { ok: 1 } }, evil: { search: { ok: 1 } } },
        "not-a-day": { exa: { search: { ok: 1 } } },
      },
    };
    const clean = sanitizeLedger(dirty);
    expect(JSON.stringify(clean)).not.toContain("zebra");
    expect(clean.days).toEqual({ "2026-10-11": { exa: { search: { ok: 2 } } } });
  });

  it("sends Programscape only balance numbers: no query, URL or key, and its token goes nowhere else", async () => {
    const root = mkdtempSync(join(tmpdir(), "psr-privacy-sync-"));
    const env = { ...KEYS, XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state") };
    const fake = fakeProgramscape({
      kept: [
        { id: "firecrawl.startup-deal", provider: "firecrawl", approval: "approved" },
        { id: "tavily.startup-credits", provider: "tavily", approval: "approved" },
      ],
    });
    const providers = mockFetch({
      [URLS.exaSearch]: echo(503),
      [URLS.firecrawlCredits]: ok(fixture("firecrawl-credit-usage")),
      [URLS.firecrawlSearch]: echo(503),
      [URLS.firecrawlScrape]: echo(503),
      [URLS.keenableSearch]: echo(503),
      [URLS.parallelSearch]: echo(503),
      [URLS.tavilyUsage]: ok(fixture("tavily-usage")),
      [URLS.tavilySearch]: ok(fixture("tavily-search")),
      [URLS.exaContents]: echo(503),
      [URLS.keenableFetch]: echo(503),
      [URLS.parallelExtract]: echo(503),
      [URLS.tavilyExtract]: ok({ results: [{ url: PAGE, raw_content: "secret board minutes zebra" }] }),
    });
    const fetch = combine(fake.fetch, providers.fetch);
    await connect({ env, fetch, now: () => new Date(), print: () => {}, openBrowser: fake.browser });
    const logs: string[] = [];
    const config = {
      programscape: { sync: "auto" as const },
      providers: { exa: { credits: [{ label: "Exa grant", remaining: 600, unit: "usd" }] } },
    };
    const router = createRouter({ env, config, fetch, ledgerPath: false, log: (m) => logs.push(m) });

    await router.search({ query: QUERY });
    await router.scrape({ url: PAGE });
    await router.flush(); // the automatic sync after the balance reads
    const manual = await router.syncBalances();
    expect(manual.filter((result) => result.outcome === "synced").map((result) => result.provider)).toEqual(["firecrawl", "tavily"]);

    const toProgramscape = fake.seen;
    expect(toProgramscape.length).toBeGreaterThan(0);
    for (const request of toProgramscape) {
      expect(new URL(request.url).origin).toBe(ORIGIN);
      expect(request.redirect).toBe("manual");
      const sent = JSON.stringify(request);
      for (const key of Object.values(KEYS)) expect(sent).not.toContain(key);
      expect(sent).not.toContain("SECRET-");
      expect(sent).not.toContain("zebra");
      expect(sent).not.toContain("private.example.com");
      expect(sent).not.toContain("board");
    }

    // Tool calls: my_plan with no arguments, and report_balance with exactly the five allowed fields.
    expect(new Set(fake.toolCalls.map((call) => call.name))).toEqual(new Set(["my_plan", "report_balance"]));
    for (const call of fake.toolCalls) {
      if (call.name === "my_plan") expect(call.arguments).toEqual({});
      else {
        expect(Object.keys(call.arguments).sort()).toEqual(["amount", "asOf", "programId", "source", "unit"]);
        expect(call.arguments.source).toBe("router");
        expect(typeof call.arguments.amount).toBe("number");
        expect(["usd", "credits", "requests"]).toContain(call.arguments.unit);
      }
    }
    // Config-entered credits are never reported.
    expect(fake.toolCalls.some((call) => call.arguments.amount === 600)).toBe(false);

    // Provider calls never carry the Programscape token, and Programscape calls carry no provider key (above).
    for (const call of providers.calls) {
      expect(JSON.stringify(call)).not.toContain("TOKENSECRET");
      expect(new URL(call.url).host).not.toContain("programscape");
    }
    for (const line of logs) expect(line).not.toContain("TOKENSECRET");
  });
});
