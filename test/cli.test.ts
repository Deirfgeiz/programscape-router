import { describe, expect, it } from "vitest";
import { main } from "../src/cli-main.js";
import { VERSION } from "../src/version.js";
import { URLS, fixture, mockFetch, ok, status } from "./helpers.js";

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t) }, out, err };
}

describe("cli", () => {
  it("prints status with no keys", async () => {
    const { io: streams, out } = io();
    const code = await main(["status"], streams, { env: {}, config: {}, ledgerPath: false });
    expect(code).toBe(0);
    const text = out.join("");
    expect(text).toContain("exa: no key (set EXA_API_KEY, or run `programscape-router keys set exa`)");
    expect(text).toContain("Order for search (rule: credits ending first)");
    expect(text).toContain("(no provider available)");
    expect(text).toContain("Balances are never added together.");
  });

  it("prints the order with reasons when keys are set", async () => {
    const { fetch } = mockFetch({
      [URLS.firecrawlCredits]: ok(fixture("firecrawl-credit-usage")),
      [URLS.tavilyUsage]: ok(fixture("tavily-usage")),
    });
    const { io: streams, out } = io();
    const code = await main(["status"], streams, {
      env: { FIRECRAWL_API_KEY: "fc-test", TAVILY_API_KEY: "tvly-test", EXA_API_KEY: "exa-test" },
      config: { providers: { exa: { credits: [{ label: "Exa startup grant", expiresOn: "2027-03-01", remaining: 600, award: 1000, unit: "usd" }] } } },
      fetch,
      ledgerPath: false,
      now: () => new Date("2026-10-11T12:00:00Z"),
    });
    expect(code).toBe(0);
    const text = out.join("");
    expect(text).toContain('1. firecrawl: Credits ending first: "Firecrawl credits, current billing period" (under 1% remaining) ends 2026-10-31 23:59:59 UTC.');
    expect(text).toContain('2. exa: Credits ending first: "Exa startup grant" (60% remaining) ends 2027-03-01.');
    expect(text).toContain('3. tavily: Credits with no known end date: "Tavily plan credits (Bootstrap)" (97% remaining).');
    expect(text).toContain('"Exa startup grant" (credits): 600 of 1000 usd remaining, ends 2027-03-01, from your config');
    expect(text).not.toContain("fc-test");
  });

  it("prints status as JSON", async () => {
    const { io: streams, out } = io();
    await main(["status", "--json"], streams, { env: {}, config: {}, ledgerPath: false });
    const parsed = JSON.parse(out.join(""));
    expect(parsed.order.search.rule).toBe("credits-ending-first");
    expect(parsed.providers).toHaveLength(5);
  });

  it("searches, printing results to stdout and routing to stderr", async () => {
    const { fetch } = mockFetch({ [URLS.tavilySearch]: ok(fixture("tavily-search")), [URLS.tavilyUsage]: status(500) });
    const { io: streams, out, err } = io();
    const code = await main(["search", "who", "is", "messi", "--max", "3"], streams, {
      env: { TAVILY_API_KEY: "t" },
      config: {},
      fetch,
      ledgerPath: false,
    });
    expect(code).toBe(0);
    expect(out.join("")).toContain("1. Lionel Messi Facts | Britannica");
    expect(err.join("")).toContain("Served by tavily.");
  });

  it("scrapes to stdout as markdown", async () => {
    const { fetch } = mockFetch({ [URLS.exaContents]: ok(fixture("exa-contents")) });
    const { io: streams, out } = io();
    const code = await main(["scrape", "https://example.com/"], streams, { env: { EXA_API_KEY: "e" }, config: {}, fetch, ledgerPath: false });
    expect(code).toBe(0);
    expect(out.join("")).toContain("# Example Domain");
  });

  it("exits 1 with the attempts when every provider fails", async () => {
    const { fetch } = mockFetch({ [URLS.exaSearch]: status(503) });
    const { io: streams, err } = io();
    const code = await main(["search", "q"], streams, { env: { EXA_API_KEY: "e" }, config: {}, fetch, ledgerPath: false });
    expect(code).toBe(1);
    expect(err.join("")).toContain("exa: server_error (HTTP 503)");
  });

  it("exits 2 on an invalid config file and on an unknown command", async () => {
    const bad = io();
    const code = await main(["status"], bad.io, {
      env: { PROGRAMSCAPE_ROUTER_CONFIG: "/definitely/not/here.json" },
      ledgerPath: false,
    });
    expect(code).toBe(2);
    expect(bad.err.join("")).toContain("does not exist");
    const unknown = io();
    expect(await main(["frobnicate"], unknown.io, { env: {}, config: {}, ledgerPath: false })).toBe(2);
  });

  it("prints help and version", async () => {
    const help = io();
    expect(await main(["--help"], help.io)).toBe(0);
    expect(help.out.join("")).toContain("programscape-router status");
    expect(help.out.join("")).toContain("programscape-router check [--json]");
    const version = io();
    expect(await main(["--version"], version.io)).toBe(0);
    expect(version.out.join("")).toBe(`${VERSION}\n`);
  });
});
