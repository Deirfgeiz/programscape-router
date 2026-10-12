import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { KEYCHAIN_SERVICE, resolveKeys } from "../src/keys.js";
import { sanitizeLedger } from "../src/ledger.js";
import { connect } from "../src/programscape/connect.js";
import { createRouter } from "../src/router.js";
import { URLS, fixture, mockFetch, ok, status, type Responder } from "./helpers.js";
import { ORIGIN, combine, fakeProgramscape } from "./programscape-fake.js";
import { fakeKeyring } from "./fake-keyring.js";

const KEYS = {
  EXA_API_KEY: "exa-SECRET-1111",
  FIRECRAWL_API_KEY: "fc-SECRET-2222",
  KEENABLE_API_KEY: "keen_SECRET-3333",
  LINKUP_API_KEY: "lk-SECRET-6666",
  PARALLEL_API_KEY: "par-SECRET-4444",
  TAVILY_API_KEY: "tvly-SECRET-5555",
  YDC_API_KEY: "ydc-SECRET-7777",
};
/** Each provider's own API hosts. You.com uses two: ydc-index.io for search and contents, api.you.com for its balance. */
const HOSTS: Record<keyof typeof KEYS, string[]> = {
  EXA_API_KEY: ["api.exa.ai"],
  FIRECRAWL_API_KEY: ["api.firecrawl.dev"],
  KEENABLE_API_KEY: ["api.keenable.ai"],
  LINKUP_API_KEY: ["api.linkup.so"],
  PARALLEL_API_KEY: ["api.parallel.ai"],
  TAVILY_API_KEY: ["api.tavily.com"],
  YDC_API_KEY: ["ydc-index.io", "api.you.com"],
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

// Every privacy rule holds whether a key came from the environment or from the OS keychain.
describe.each(["env", "keychain"] as const)("privacy (keys from %s)", (source) => {
  /** The environment for this run: the keys themselves only when they come from the environment. */
  const keyEnv = (extra: Record<string, string> = {}) => ({ ...(source === "env" ? KEYS : {}), ...extra });
  beforeEach(() => {
    if (source === "keychain") for (const [name, key] of Object.entries(KEYS)) fakeKeyring.put(KEYCHAIN_SERVICE, name, key);
  });
  async function keyed(extra: Record<string, string> = {}) {
    const env = keyEnv(extra);
    const keys = await resolveKeys({ env });
    expect(Object.values(keys.sources)).toEqual(Array(7).fill(source));
    return { env, keys };
  }

  it("never writes keys, queries, URLs or content to the ledger or the log", async () => {
    const dir = mkdtempSync(join(tmpdir(), "psr-ledger-"));
    const ledgerPath = join(dir, "ledger.json");
    const logs: string[] = [];
    const { fetch } = mockFetch({
      [URLS.exaSearch]: echo(402),
      [URLS.firecrawlCredits]: echo(500),
      [URLS.firecrawlSearch]: echo(401),
      [URLS.keenableSearch]: echo(429),
      [URLS.linkupBalance]: echo(500),
      [URLS.linkupSearch]: echo(429),
      [URLS.parallelSearch]: echo(503),
      [URLS.tavilyUsage]: echo(500),
      [URLS.tavilySearch]: echo(503),
      [URLS.youcomBalance]: echo(500),
      [URLS.youcomSearch]: ok(fixture("youcom-search")),
      [URLS.exaContents]: echo(402),
      [URLS.firecrawlScrape]: echo(401),
      [URLS.keenableFetch]: echo(402),
      [URLS.linkupFetch]: echo(402),
      [URLS.parallelExtract]: echo(402),
      [URLS.tavilyExtract]: echo(402),
      [URLS.youcomContents]: ok([{ url: PAGE, title: "Board minutes zebra", markdown: "secret board minutes zebra", html: null }]),
    });
    const router = createRouter({ ...(await keyed()), config: {}, fetch, ledgerPath, log: (m) => logs.push(m) });

    const search = await router.search({ query: QUERY });
    expect(search.routing.provider).toBe("youcom");
    const scrape = await router.scrape({ url: PAGE });
    expect(scrape.routing.provider).toBe("youcom");
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
      // Linkup's 429 without a documented code is a rate limit; its 402 means the key wasn't taken.
      linkup: { search: { rate_limited: 1 }, scrape: { unauthorized: 1 } },
      parallel: { search: { server_error: 1 }, scrape: { exhausted: 1 } },
      tavily: { search: { server_error: 1 }, scrape: { exhausted: 1 } },
      youcom: { search: { ok: 1 }, scrape: { ok: 1 } },
    });
    // The ledger is exactly its sanitized self: nothing but counts.
    expect(ledger).toEqual(sanitizeLedger(ledger));
  });

  it("sends each key only to its own provider's host, and with the catalog off makes no other network call", async () => {
    const { fetch, calls } = mockFetch({
      [URLS.exaSearch]: status(503),
      [URLS.firecrawlCredits]: ok(fixture("firecrawl-credit-usage")),
      [URLS.firecrawlSearch]: status(503),
      [URLS.keenableSearch]: status(503),
      [URLS.linkupBalance]: ok(fixture("linkup-balance")),
      [URLS.linkupSearch]: status(503),
      [URLS.parallelSearch]: status(503),
      [URLS.tavilyUsage]: ok(fixture("tavily-usage")),
      [URLS.tavilySearch]: status(503),
      [URLS.youcomBalance]: ok(fixture("youcom-balance")),
      [URLS.youcomSearch]: status(503),
    });
    const router = createRouter({ ...(await keyed({ PROGRAMSCAPE_ROUTER_CATALOG: "off" })), config: {}, fetch, ledgerPath: false, log: () => {} });
    await router.search({ query: QUERY }).catch(() => undefined);
    await router.status({ refresh: true });

    expect(calls.length).toBeGreaterThan(7);
    // Every provider's every host was called, so every key was checked against every other host.
    expect(new Set(calls.map((call) => new URL(call.url).host))).toEqual(new Set(Object.values(HOSTS).flat()));
    for (const call of calls) {
      const host = new URL(call.url).host;
      expect(Object.values(HOSTS).flat()).toContain(host);
      expect(host).not.toContain("programscape");
      const sent = JSON.stringify(call);
      for (const [name, key] of Object.entries(KEYS)) {
        if (HOSTS[name as keyof typeof KEYS].includes(host)) expect(sent).toContain(key);
        else expect(sent).not.toContain(key);
      }
    }
  });

  it("reads Programscape's public catalog with only the provider ids: no key, query, URL or balance", async () => {
    const root = mkdtempSync(join(tmpdir(), "psr-privacy-catalog-"));
    const { fetch, calls } = mockFetch({
      [URLS.exaSearch]: status(503),
      [URLS.firecrawlCredits]: ok(fixture("firecrawl-credit-usage")),
      [URLS.firecrawlSearch]: status(503),
      [URLS.keenableSearch]: status(503),
      [URLS.linkupBalance]: ok(fixture("linkup-balance")),
      [URLS.linkupSearch]: status(503),
      [URLS.parallelSearch]: status(503),
      [URLS.tavilyUsage]: ok(fixture("tavily-usage")),
      [URLS.tavilySearch]: ok(fixture("tavily-search")),
      [URLS.youcomBalance]: ok(fixture("youcom-balance")),
      [URLS.youcomSearch]: status(503),
      [`${ORIGIN}/api/router/programs`]: ok(fixture("programscape-programs")),
    });
    const router = createRouter({ ...(await keyed({ XDG_STATE_HOME: join(root, "state") })), config: {}, fetch, ledgerPath: false, log: () => {} });
    await router.search({ query: QUERY });
    await router.status({ refresh: true });
    const toProgramscape = calls.filter((call) => new URL(call.url).origin === ORIGIN);
    expect(toProgramscape).toHaveLength(1);
    const [call] = toProgramscape;
    expect(call?.url).toBe(`${ORIGIN}/api/router/programs?providers=exa,firecrawl,keenable,linkup,parallel,tavily,youcom`);
    expect(call?.body).toBeUndefined();
    expect(Object.keys(call?.headers ?? {}).sort()).toEqual(["accept", "user-agent"]);
    const sent = JSON.stringify(call);
    for (const key of Object.values(KEYS)) expect(sent).not.toContain(key);
    expect(sent).not.toContain("SECRET");
    expect(sent).not.toContain("zebra");
    expect(sent).not.toContain("1000"); // Firecrawl's balance
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
    const { env, keys } = await keyed({ XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state") });
    const fake = fakeProgramscape({
      kept: [
        { id: "firecrawl.startup-deal", provider: "firecrawl", approved: true },
        { id: "linkup.free-credits", provider: "linkup", approved: true },
        { id: "tavily.startup-credits", provider: "tavily", approved: true },
        { id: "youcom.free-credits", provider: "youcom", approved: true },
      ],
    });
    const providers = mockFetch({
      [URLS.exaSearch]: echo(503),
      [URLS.firecrawlCredits]: ok(fixture("firecrawl-credit-usage")),
      [URLS.firecrawlSearch]: echo(503),
      [URLS.firecrawlScrape]: echo(503),
      [URLS.keenableSearch]: echo(503),
      [URLS.linkupBalance]: ok({ balance: 20 }),
      [URLS.linkupSearch]: echo(503),
      [URLS.parallelSearch]: echo(503),
      [URLS.tavilyUsage]: ok(fixture("tavily-usage")),
      [URLS.tavilySearch]: ok(fixture("tavily-search")),
      [URLS.youcomBalance]: ok({ data: { type: "account", id: "x", attributes: { balance: 10000 } } }),
      [URLS.youcomSearch]: echo(503),
      [URLS.exaContents]: echo(503),
      [URLS.keenableFetch]: echo(503),
      [URLS.linkupFetch]: echo(503),
      [URLS.parallelExtract]: echo(503),
      [URLS.tavilyExtract]: ok({ results: [{ url: PAGE, raw_content: "secret board minutes zebra" }] }),
      [URLS.youcomContents]: echo(503),
    });
    const fetch = combine(fake.fetch, providers.fetch);
    await connect({ env, fetch, now: () => new Date(), print: () => {}, openBrowser: fake.browser });
    const logs: string[] = [];
    const config = {
      programscape: { sync: "auto" as const },
      providers: { exa: { credits: [{ label: "Exa grant", remaining: 600, unit: "usd" }] } },
    };
    const router = createRouter({ env, keys, config, fetch, ledgerPath: false, log: (m) => logs.push(m) });

    await router.search({ query: QUERY });
    await router.scrape({ url: PAGE });
    await router.flush(); // the automatic sync after the balance reads
    const manual = await router.syncBalances();
    expect(manual.filter((result) => result.outcome === "synced").map((result) => result.provider)).toEqual(["firecrawl", "linkup", "tavily", "youcom"]);

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
