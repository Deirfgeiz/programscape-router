/**
 * 0151, end to end through the router: the runway estimate and heads-up in status and in MCP tool results, the
 * programs that can add more, and the two-way sync (the plan's dates order providers; the estimate goes with a balance).
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli-main.js";
import type { RouterConfig } from "../src/config.js";
import { formatStatus } from "../src/format.js";
import { createMcpServer } from "../src/mcp.js";
import { connect, disconnect } from "../src/programscape/connect.js";
import type { FetchLike } from "../src/providers/index.js";
import type { Reading } from "../src/readings.js";
import { createRouter } from "../src/router.js";
import { URLS, fixture, mockFetch, ok, type Responder } from "./helpers.js";
import { type KeptProgram, combine, fakeProgramscape } from "./programscape-fake.js";

const CATALOG = "https://programscape.com/api/router/programs";
const DAY = 86_400_000;
const LABEL = "Firecrawl credits, current billing period";

function homes() {
  const root = mkdtempSync(join(tmpdir(), "psr-extend-"));
  return { XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state") };
}

/** readings.json with Firecrawl readings 2 and 1 days ago: 7000 then 6000 credits, so 1000 a day. */
function seedReadings(env: { XDG_STATE_HOME: string }, at = Date.now()): void {
  const dir = join(env.XDG_STATE_HOME, "programscape-router");
  mkdirSync(dir, { recursive: true });
  const reading = (daysAgo: number, remaining: number): Reading => ({
    provider: "firecrawl",
    label: LABEL,
    unit: "credits",
    remaining,
    total: 100000,
    asOf: new Date(at - daysAgo * DAY).toISOString(),
  });
  writeFileSync(join(dir, "readings.json"), JSON.stringify({ version: 1, readings: [reading(2, 7000), reading(1, 6000)] }));
}

/** Firecrawl now reports 5000 left (no period end), so 5 days at 1000 a day. */
const FIRECRAWL_5000: Responder = ok({ success: true, data: { remainingCredits: 5000, planCredits: 100000 } });

function providers(extra: Record<string, Responder | Responder[]> = {}) {
  return mockFetch({
    [URLS.firecrawlCredits]: FIRECRAWL_5000,
    [URLS.firecrawlSearch]: ok(fixture("firecrawl-search")),
    [URLS.firecrawlScrape]: ok(fixture("firecrawl-scrape")),
    [URLS.tavilyUsage]: ok(fixture("tavily-usage")),
    [URLS.tavilySearch]: ok(fixture("tavily-search")),
    [CATALOG]: ok(fixture("programscape-programs")),
    ...extra,
  });
}

async function mcpClient(router: ReturnType<typeof createRouter>) {
  const server = createMcpServer(router);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function body(result: Awaited<ReturnType<Client["callTool"]>>) {
  return JSON.parse((result.content as Array<{ text: string }>)[0]?.text ?? "{}");
}

describe("runway and heads-up in status", () => {
  it("shows the estimate, the heads-up with what can add more, and the programs list", async () => {
    const env = { ...homes(), FIRECRAWL_API_KEY: "fc-1", TAVILY_API_KEY: "tv-1" };
    seedReadings(env);
    const { fetch, calls } = providers();
    const router = createRouter({ env, config: {}, fetch, ledgerPath: false, log: () => {} });
    const status = await router.status();

    const firecrawl = status.providers.find((provider) => provider.id === "firecrawl");
    expect(firecrawl?.runway).toEqual([
      expect.objectContaining({ label: LABEL, unit: "credits", daysLeft: 5, words: "About 5 days left on Firecrawl at your recent pace (estimate)" }),
    ]);
    expect(status.headsUpDays).toBe(30);
    expect(status.headsUp).toHaveLength(1);
    expect(status.headsUp[0]).toMatchObject({ provider: "firecrawl", reasons: ["About 5 days left on Firecrawl at your recent pace (estimate)"] });
    expect(status.headsUp[0]?.words).toBe(
      "Heads-up: About 5 days left on Firecrawl at your recent pace (estimate). " +
        "Programs that can add more, from Programscape's public catalog (Firecrawl decides who qualifies): " +
        "Claude for Startups: Firecrawl perk; Firecrawl startup deal (Ask Firecrawl). " +
        "More, and other providers that do the same job: https://programscape.com/extend/firecrawl",
    );
    expect(status.programs?.map((entry) => entry.provider.id)).toEqual(["firecrawl", "tavily"]);

    const text = formatStatus(status);
    expect(text).toContain("    About 5 days left on Firecrawl at your recent pace (estimate).");
    expect(text).toContain("Heads-up (under 30 days)\n  firecrawl: About 5 days left on Firecrawl");
    expect(text).toContain("  Firecrawl: Claude for Startups: Firecrawl perk; Firecrawl startup deal (Ask Firecrawl). More: https://programscape.com/extend/firecrawl");

    // The catalog was asked about the providers with a key, and nothing else went to Programscape.
    expect(calls.filter((call) => call.url.startsWith("https://programscape.com")).map((call) => call.url)).toEqual([`${CATALOG}?providers=firecrawl,tavily`]);
    // The new reading was kept.
    await router.flush();
  });

  it("takes the threshold from config, and 0 turns the heads-up off", async () => {
    for (const [days, expected] of [[5, 0], [6, 1], [0, 0]] as const) {
      const env = { ...homes(), FIRECRAWL_API_KEY: "fc-1" };
      seedReadings(env);
      const { fetch } = providers();
      const status = await createRouter({ env, config: { headsUp: { days } }, fetch, ledgerPath: false, log: () => {} }).status();
      expect(status.headsUp).toHaveLength(expected);
      expect(status.providers.find((provider) => provider.id === "firecrawl")?.runway?.[0]?.daysLeft).toBe(5);
    }
  });

  it("gives a heads-up for an end date in config within the threshold, with no readings needed", async () => {
    const now = new Date("2026-10-12T12:00:00Z");
    const env = { ...homes(), EXA_API_KEY: "exa-1" };
    const config: RouterConfig = { providers: { exa: { credits: [{ label: "Exa startup grant", expiresOn: "2026-10-30" }] } } };
    const { fetch } = providers();
    const status = await createRouter({ env, config, fetch, ledgerPath: false, log: () => {}, now: () => now, catalogPath: false }).status();
    expect(status.headsUp.map((entry) => entry.words)).toEqual(['Heads-up: "Exa startup grant" ends 2026-10-30 (your date, from config).']);
  });

  it("with the catalog off, still gives the heads-up, but nothing about programs and no call to Programscape", async () => {
    const env = { ...homes(), FIRECRAWL_API_KEY: "fc-1", PROGRAMSCAPE_ROUTER_CATALOG: "off" };
    seedReadings(env);
    const { fetch, calls } = providers();
    const status = await createRouter({ env, config: {}, fetch, ledgerPath: false, log: () => {} }).status();
    expect(status.headsUp[0]?.words).toBe("Heads-up: About 5 days left on Firecrawl at your recent pace (estimate).");
    expect(status.programs).toBeUndefined();
    expect(formatStatus(status)).not.toContain("Programs that can add more");
    expect(calls.some((call) => call.url.includes("programscape"))).toBe(false);
  });

  it("when Programscape can't be reached, works exactly as before", async () => {
    const env = { ...homes(), FIRECRAWL_API_KEY: "fc-1" };
    seedReadings(env);
    const { fetch } = providers({ [CATALOG]: () => Promise.reject(new TypeError("offline")) });
    const status = await createRouter({ env, config: {}, fetch, ledgerPath: false, log: () => {} }).status();
    expect(status.programs).toBeUndefined();
    expect(status.headsUp[0]?.words).toBe("Heads-up: About 5 days left on Firecrawl at your recent pace (estimate).");
    expect(status.order.search.entries.map((entry) => entry.provider)).toEqual(["firecrawl"]);
  });

  it("records each live balance read in readings.json", async () => {
    const env = { ...homes(), FIRECRAWL_API_KEY: "fc-1" };
    const { fetch } = providers();
    const router = createRouter({ env, config: {}, fetch, ledgerPath: false, log: () => {}, catalogPath: false });
    await router.search({ query: "q" });
    await router.flush();
    const { readFileSync } = await import("node:fs");
    const file = JSON.parse(readFileSync(join(env.XDG_STATE_HOME, "programscape-router", "readings.json"), "utf8"));
    expect(file.readings).toEqual([{ provider: "firecrawl", label: LABEL, unit: "credits", remaining: 5000, total: 100000, asOf: expect.any(String) }]);
  });
});

describe("heads-up in MCP tool results", () => {
  it("adds a notice once per provider per UTC day, which an agent can pass on", async () => {
    const env = { ...homes(), FIRECRAWL_API_KEY: "fc-1" };
    seedReadings(env);
    const { fetch } = providers();
    let clock = new Date();
    const router = createRouter({ env, config: {}, fetch, ledgerPath: false, log: () => {}, now: () => clock });
    const client = await mcpClient(router);

    const first = body(await client.callTool({ name: "search", arguments: { query: "q" } }));
    expect(first.routing.provider).toBe("firecrawl");
    expect(first.notice).toContain("Heads-up: About 5 days left on Firecrawl at your recent pace (estimate).");
    expect(first.notice).toContain("https://programscape.com/extend/firecrawl");

    const again = body(await client.callTool({ name: "scrape", arguments: { url: "https://example.com" } }));
    expect(again).not.toHaveProperty("notice");

    clock = new Date(clock.getTime() + DAY);
    const nextDay = body(await client.callTool({ name: "search", arguments: { query: "q" } }));
    expect(nextDay.notice).toContain("About 5 days left on Firecrawl");

    const { tools } = await client.listTools();
    expect(tools.find((tool) => tool.name === "search")?.description).toContain("`notice`");
  });

  it("adds no notice when nothing is under the threshold, and never fails a call over it", async () => {
    const env = { ...homes(), FIRECRAWL_API_KEY: "fc-1" };
    const { fetch } = providers();
    const client = await mcpClient(createRouter({ env, config: {}, fetch, ledgerPath: false, log: () => {} }));
    const result = await client.callTool({ name: "search", arguments: { query: "q" } });
    expect(result.isError).toBeFalsy();
    expect(body(result)).not.toHaveProperty("notice");
  });
});

/** A connected founder, with tokens from a real connect against the fake. */
async function connected(kept: KeptProgram[], keys: Record<string, string>, extra: Record<string, Responder | Responder[]> = {}) {
  const fake = fakeProgramscape({ kept });
  const provider = providers(extra);
  const fetch: FetchLike = combine(fake.fetch, provider.fetch);
  const env = { ...homes(), ...keys };
  await connect({ env, fetch, now: () => new Date(), print: () => {}, openBrowser: fake.browser });
  const router = (config: RouterConfig = {}) => createRouter({ env, config, fetch, ledgerPath: false, log: () => {}, catalogPath: false });
  return { fake, env, fetch, router };
}

function reports(fake: ReturnType<typeof fakeProgramscape>) {
  return fake.toolCalls.filter((call) => call.name === "report_balance").map((call) => call.arguments);
}

describe("two-way sync", () => {
  const EXA: KeptProgram = { id: "exa.startup-grant", provider: "exa", approved: true, expiresOn: "2026-11-01", award: { amount: 1000, unit: "usd" } };

  it("orders a provider with no balance endpoint by the plan's expiration date, labelled as the founder's own", async () => {
    const { router } = await connected([EXA], { EXA_API_KEY: "exa-1", TAVILY_API_KEY: "tv-1" });
    const results = await router().syncBalances();
    expect(results.find((result) => result.provider === "exa")?.message).toContain(
      "Your plan's expiration date for exa.startup-grant, 2026-11-01, places Exa under credits ending first.",
    );
    const status = await router().status();
    expect(status.order.search.entries[0]).toMatchObject({
      provider: "exa",
      tier: "credits-ending",
      endsOn: "2026-11-01",
      reason: 'Credits ending first: "exa program exa.startup-grant (on your Programscape plan)" ends 2026-11-01.',
    });
    const exa = status.providers.find((provider) => provider.id === "exa");
    expect(exa?.balances).toEqual([
      { label: "exa program exa.startup-grant (on your Programscape plan)", kind: "credits", unit: "usd", total: 1000, endsOn: "2026-11-01", source: "plan" },
    ]);
    expect(formatStatus(status)).toContain(
      '"exa program exa.startup-grant (on your Programscape plan)" (credits): 1000 usd in total, remaining unknown, ends 2026-11-01, your own date, from your Programscape plan',
    );
  });

  it("lets a date in config win over the plan's", async () => {
    const { router } = await connected([EXA], { EXA_API_KEY: "exa-1" });
    const config: RouterConfig = { providers: { exa: { credits: [{ label: "Exa grant", expiresOn: "2027-03-01" }] } } };
    const results = await router(config).syncBalances();
    expect(results[0]?.message).toContain("Your plan's expiration date for exa.startup-grant is 2026-11-01; the date in your config wins for Exa.");
    const status = await router(config).status();
    expect(status.order.search.entries[0]).toMatchObject({ provider: "exa", endsOn: "2027-03-01" });
    expect(status.providers.find((provider) => provider.id === "exa")?.balances.map((balance) => balance.source)).toEqual(["config"]);
  });

  it("reads dates only for an approved program", async () => {
    const waiting: KeptProgram = { ...EXA, approved: false };
    const pending = await connected([waiting], { EXA_API_KEY: "exa-1" });
    await pending.router().syncBalances();
    expect((await pending.router().status()).providers.find((provider) => provider.id === "exa")?.balances).toEqual([]);
  });

  it("stops using the plan's dates after disconnect", async () => {
    const { router, env, fetch } = await connected([EXA], { EXA_API_KEY: "exa-1" });
    await router().syncBalances();
    expect((await router().status()).order.search.entries[0]?.endsOn).toBe("2026-11-01");
    await disconnect({ env, fetch });
    expect((await router().status()).order.search.entries[0]?.endsOn).toBeUndefined();
  });

  it("sends the runway estimate with the balance it was worked out for", async () => {
    const FIRECRAWL: KeptProgram = { id: "firecrawl.startup-deal", provider: "firecrawl", approved: true };
    const { fake, env, router } = await connected([FIRECRAWL], { FIRECRAWL_API_KEY: "fc-1" });
    seedReadings(env);
    const results = await router().syncBalances();
    expect(reports(fake)).toEqual([
      { programId: "firecrawl.startup-deal", amount: 5000, unit: "credits", asOf: expect.any(String), source: "router", estimate: { daysLeft: 5 } },
    ]);
    expect(results[0]?.message).toContain("Synced 5000 credits");
    expect(results[0]?.message).toContain("with the runway estimate (5 days)");
  });

  it("sends no estimate without enough readings", async () => {
    const FIRECRAWL: KeptProgram = { id: "firecrawl.startup-deal", provider: "firecrawl", approved: true };
    const none = await connected([FIRECRAWL], { FIRECRAWL_API_KEY: "fc-1" });
    await none.router().syncBalances();
    expect(reports(none.fake)[0]).not.toHaveProperty("estimate");
  });

  it("sends no estimate when the balance lasts past the provider's period", async () => {
    const FIRECRAWL: KeptProgram = { id: "firecrawl.startup-deal", provider: "firecrawl", approved: true };
    // 5000 left at 1000 a day, but the period ends tomorrow: it lasts past it.
    const tomorrow = new Date(Date.now() + DAY).toISOString();
    const past = await connected([FIRECRAWL], { FIRECRAWL_API_KEY: "fc-1" }, {
      [URLS.firecrawlCredits]: ok({ success: true, data: { remainingCredits: 5000, planCredits: 100000, billingPeriodEnd: tomorrow } }),
    });
    seedReadings(past.env);
    await past.router().syncBalances();
    expect(reports(past.fake)[0]).not.toHaveProperty("estimate");
  });

  it("still sends the balance to a plan that doesn't take an estimate yet", async () => {
    const FIRECRAWL: KeptProgram = { id: "firecrawl.startup-deal", provider: "firecrawl", approved: true };
    const { fake, env, router } = await connected([FIRECRAWL], { FIRECRAWL_API_KEY: "fc-1" });
    fake.behaviour.refuseEstimate = true;
    seedReadings(env);
    const results = await router().syncBalances();
    expect(reports(fake).map((report) => Object.keys(report).sort())).toEqual([
      ["amount", "asOf", "estimate", "programId", "source", "unit"],
      ["amount", "asOf", "programId", "source", "unit"],
    ]);
    expect(results[0]).toMatchObject({ outcome: "synced" });
    expect(results[0]?.message).not.toContain("runway estimate");
  });

  it("asks for the estimate only when an automatic sync is due", async () => {
    const FIRECRAWL: KeptProgram = { id: "firecrawl.startup-deal", provider: "firecrawl", approved: true };
    const { fake, env, router } = await connected([FIRECRAWL], { FIRECRAWL_API_KEY: "fc-1" });
    seedReadings(env);
    const auto = router({ programscape: { sync: "auto" } });
    await auto.search({ query: "q" });
    await auto.flush();
    expect(reports(fake)).toEqual([expect.objectContaining({ estimate: { daysLeft: 5 } })]);
  });
});

describe("cli", () => {
  function io() {
    const out: string[] = [];
    const err: string[] = [];
    return { streams: { stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t) }, out, err };
  }

  it("programs prints the full list for the providers with a key, and --json prints the catalog", async () => {
    const env = { ...homes(), FIRECRAWL_API_KEY: "fc-1" };
    const { fetch, calls } = providers();
    const text = io();
    expect(await main(["programs"], text.streams, { env, fetch, config: {} })).toBe(0);
    const printed = text.out.join("");
    expect(printed).toContain("Programs that can add more, from Programscape's public catalog (as of 2026-10-12).");
    expect(printed).toContain("  More from Firecrawl:");
    expect(printed).toContain("  Other providers that do the same job:");
    expect(printed).not.toContain("Tavily");
    const json = io();
    expect(await main(["programs", "--json"], json.streams, { env, fetch, config: {} })).toBe(0);
    const parsed = JSON.parse(json.out.join(""));
    expect(parsed.providers.map((entry: { provider: { id: string } }) => entry.provider.id)).toEqual(["firecrawl"]);
    expect(parsed.providers[0].sameJob[0].provider.id).toBe("exa");
    // Both from one read.
    expect(calls.filter((call) => call.url.startsWith(CATALOG))).toHaveLength(1);
  });

  it("programs says why when it has nothing: off, no key, or no answer", async () => {
    const { fetch, calls } = providers({ [CATALOG]: () => Promise.reject(new TypeError("offline")) });
    const off = io();
    expect(await main(["programs"], off.streams, { env: { ...homes(), FIRECRAWL_API_KEY: "f", PROGRAMSCAPE_ROUTER_CATALOG: "off" }, fetch, config: {} })).toBe(0);
    expect(off.out.join("")).toContain("The programs list is off");
    const none = io();
    expect(await main(["programs", "--json"], none.streams, { env: homes(), fetch, config: {} })).toBe(1);
    expect(JSON.parse(none.out.join(""))).toMatchObject({ providers: [], note: expect.stringContaining("No provider key is set") });
    expect(calls).toHaveLength(0);
    const offline = io();
    expect(await main(["programs"], offline.streams, { env: { ...homes(), FIRECRAWL_API_KEY: "f" }, fetch, config: {} })).toBe(1);
    expect(offline.out.join("")).toContain("Couldn't read Programscape's public catalog just now");
    expect(offline.out.join("")).toContain("  firecrawl: https://programscape.com/extend/firecrawl");
  });

  it("shows the programs after the first keys set ever, and not after later ones", async () => {
    const env = homes();
    const { fetch, calls } = providers();
    const first = io();
    expect(await main(["keys", "set", "firecrawl", "--stdin"], first.streams, { env, fetch, config: {}, stdin: Readable.from(["fc-new\n"]) as never })).toBe(0);
    expect(first.out.join("")).toContain("Programs that can add more (Programscape's public catalog; each provider decides who qualifies)");
    expect(first.out.join("")).toContain("  Firecrawl: Claude for Startups: Firecrawl perk; Firecrawl startup deal (Ask Firecrawl).");
    expect(calls.map((call) => call.url)).toEqual([`${CATALOG}?providers=firecrawl`]);
    const second = io();
    expect(await main(["keys", "set", "tavily", "--stdin"], second.streams, { env, fetch, config: {}, stdin: Readable.from(["tv-new\n"]) as never })).toBe(0);
    expect(second.out.join("")).not.toContain("Programs that can add more");
    // The key itself never went to Programscape.
    for (const call of calls) expect(JSON.stringify(call)).not.toContain("fc-new");
  });

  it("doesn't count a keys set as the first one when nothing could be shown", async () => {
    const env = { ...homes(), PROGRAMSCAPE_ROUTER_CATALOG: "off" };
    const { fetch } = providers();
    await main(["keys", "set", "firecrawl", "--stdin"], io().streams, { env, fetch, config: {}, stdin: Readable.from(["fc-new\n"]) as never });
    const later = io();
    const { PROGRAMSCAPE_ROUTER_CATALOG: _off, ...on } = env;
    expect(await main(["keys", "set", "tavily", "--stdin"], later.streams, { env: on, fetch, config: {}, stdin: Readable.from(["tv-new\n"]) as never })).toBe(0);
    expect(later.out.join("")).toContain("Programs that can add more");
  });
});
