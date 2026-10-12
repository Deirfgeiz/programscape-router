import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CATALOG_INTERVAL_MS,
  type CatalogOptions,
  catalogEnabled,
  formatPrograms,
  readPrograms,
  sanitizeCatalog,
  short,
  shortLines,
} from "../src/catalog.js";
import { VERSION } from "../src/version.js";
import { fixture, mockFetch, ok, status, timeout, type Responder } from "./helpers.js";

const CATALOG = "https://programscape.com/api/router/programs";
const START = new Date("2026-10-12T09:00:00Z");

function setup(responder: Responder | Responder[] = ok(fixture("programscape-programs")), extra: Partial<CatalogOptions> = {}) {
  const { fetch, calls } = mockFetch({ [CATALOG]: responder });
  const path = join(mkdtempSync(join(tmpdir(), "psr-catalog-")), "catalog.json");
  let clock = START;
  const options: CatalogOptions = { env: {}, fetch, now: () => clock, path, ...extra };
  return { options, calls, path, advance: (ms: number) => (clock = new Date(clock.getTime() + ms)) };
}

describe("catalog read", () => {
  it("sends only the ids of providers with a key set, with a plain User-Agent, and nothing else", async () => {
    const { options, calls } = setup();
    const catalog = await readPrograms(options, ["tavily", "firecrawl"]);
    expect(catalog?.providers.map((entry) => entry.provider.id)).toEqual(["firecrawl", "tavily"]);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(`${CATALOG}?providers=firecrawl,tavily`);
    expect(call.method).toBe("GET");
    expect(call.body).toBeUndefined();
    expect(call.redirect).toBe("manual");
    expect(call.headers).toEqual({ accept: "application/json", "user-agent": `programscape-router/${VERSION}` });
  });

  it("asks nothing when no provider has a key", async () => {
    const { options, calls } = setup();
    expect(await readPrograms(options, [])).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("is off with programscape.catalog: false in config or PROGRAMSCAPE_ROUTER_CATALOG=off, and reads nothing", async () => {
    expect(catalogEnabled({}, {})).toBe(true);
    expect(catalogEnabled({}, { programscape: { catalog: true } })).toBe(true);
    expect(catalogEnabled({}, { programscape: { catalog: false } })).toBe(false);
    for (const value of ["off", "OFF", "false", "0", "no"]) expect(catalogEnabled({ PROGRAMSCAPE_ROUTER_CATALOG: value }, {})).toBe(false);
    for (const extra of [{ config: { programscape: { catalog: false } } }, { env: { PROGRAMSCAPE_ROUTER_CATALOG: "off" } }, { path: false as const }]) {
      const { options, calls, path } = setup(undefined, extra);
      expect(await readPrograms(options, ["firecrawl"])).toBeUndefined();
      expect(calls).toHaveLength(0);
      expect(existsSync(path)).toBe(false);
    }
  });

  it("reads at most once a day, and again the same day only for a provider it didn't ask about", async () => {
    const { options, calls, advance } = setup();
    await readPrograms(options, ["firecrawl"]);
    advance(60_000);
    expect((await readPrograms(options, ["firecrawl"]))?.providers).toHaveLength(1);
    expect(calls).toHaveLength(1);
    // A new key: one more read, asking about every provider with a key.
    advance(60_000);
    expect((await readPrograms(options, ["firecrawl", "tavily"]))?.providers).toHaveLength(2);
    expect(calls.map((call) => call.url)).toEqual([`${CATALOG}?providers=firecrawl`, `${CATALOG}?providers=firecrawl,tavily`]);
    // Fewer keys than were asked about: the cache covers it.
    await readPrograms(options, ["tavily"]);
    expect(calls).toHaveLength(2);
    advance(CATALOG_INTERVAL_MS);
    await readPrograms(options, ["tavily"]);
    expect(calls).toHaveLength(3);
  });

  it("keeps the cache file to what was asked, when, and the catalog's own answer", async () => {
    const { options, path } = setup();
    await readPrograms(options, ["firecrawl"]);
    const cache = JSON.parse(readFileSync(path, "utf8"));
    expect(Object.keys(cache).sort()).toEqual(["asked", "attemptedAt", "catalog", "fetchedAt", "version"]);
    expect(cache.asked).toEqual(["firecrawl"]);
  });

  for (const [name, responder] of [
    ["a 404 (the endpoint isn't live yet)", status(404, { error: "not_found" })],
    ["a 500", status(500)],
    ["a timeout", timeout],
    ["a network error", () => Promise.reject(new TypeError("fetch failed"))],
    ["a redirect", () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } })],
    ["a body that isn't JSON", () => new Response("<html>", { status: 200 })],
    ["JSON of another shape", ok({ nope: true })],
  ] as Array<[string, Responder]>) {
    it(`says nothing after ${name}, and tries again only the next day`, async () => {
      const { options, calls, advance } = setup(responder);
      expect(await readPrograms(options, ["firecrawl"])).toBeUndefined();
      advance(60 * 60_000);
      expect(await readPrograms(options, ["firecrawl"])).toBeUndefined();
      expect(calls).toHaveLength(1);
      advance(CATALOG_INTERVAL_MS);
      await readPrograms(options, ["firecrawl"]);
      expect(calls).toHaveLength(2);
    });
  }

  it("keeps showing the last list for up to a week when a later read fails", async () => {
    const { options, advance } = setup([ok(fixture("programscape-programs")), status(503)]);
    await readPrograms(options, ["firecrawl"]);
    advance(CATALOG_INTERVAL_MS + 1);
    expect((await readPrograms(options, ["firecrawl"]))?.providers[0]?.provider.id).toBe("firecrawl");
    advance(7 * CATALOG_INTERVAL_MS);
    expect(await readPrograms(options, ["firecrawl"])).toBeUndefined();
  });

  it("never throws, even when the cache file can't be written", async () => {
    const { options } = setup();
    const dir = mkdtempSync(join(tmpdir(), "psr-catalog-"));
    writeFileSync(join(dir, "a-file"), "x");
    const catalog = await readPrograms({ ...options, path: join(dir, "a-file", "catalog.json") }, ["firecrawl"]);
    expect(catalog?.providers).toHaveLength(1);
  });

  it("only goes to programscape.com", async () => {
    const { fetch, calls } = mockFetch({});
    const path = join(mkdtempSync(join(tmpdir(), "psr-catalog-")), "catalog.json");
    await readPrograms({ env: {}, fetch, now: () => START, path }, ["exa"]);
    expect(calls.map((call) => new URL(call.url).origin)).toEqual(["https://programscape.com"]);
  });
});

describe("catalog contents", () => {
  it("keeps the catalog's order and never ranks or adds", () => {
    const catalog = sanitizeCatalog(fixture("programscape-programs"))!;
    expect(catalog.providers[0]?.more.map((program) => program.id)).toEqual(["firecrawl.claude-startup-perks", "firecrawl.startup-deal"]);
  });

  it("drops programs without an official source or checked date, foreign links, providers it doesn't know, and control characters", () => {
    const raw = fixture("programscape-programs") as { providers: Array<Record<string, unknown>> };
    const firecrawl = raw.providers[0] as { more: Array<Record<string, unknown>>; page: string };
    firecrawl.more.push(
      { ...firecrawl.more[0], id: "no-source", officialSource: { title: "x", url: "http://insecure.example" } },
      { ...firecrawl.more[0], id: "no-date", checkedOn: "recently" },
      { ...firecrawl.more[0], id: "escape", name: "Evil\u001b[31m red\u0007 name", qualify: "https://elsewhere.example/" },
    );
    firecrawl.page = "https://elsewhere.example/extend/firecrawl";
    raw.providers.push({ provider: { id: "aws", name: "AWS" }, capabilities: [], more: [], sameJob: [], page: "https://programscape.com/extend/aws" });
    const catalog = sanitizeCatalog(raw)!;
    expect(catalog.providers.map((entry) => entry.provider.id)).toEqual(["firecrawl", "tavily"]);
    const more = catalog.providers[0]!.more;
    expect(more.map((program) => program.id)).toEqual(["firecrawl.claude-startup-perks", "firecrawl.startup-deal", "escape"]);
    expect(more[2]?.name).toBe("Evil [31m red name");
    expect(more[2]).not.toHaveProperty("qualify");
    expect(catalog.providers[0]?.page).toBe("https://programscape.com/extend/firecrawl");
  });

  it("prints a short line per provider with Ask X, and the full list with sources, dates and the same job", () => {
    const catalog = sanitizeCatalog(fixture("programscape-programs"))!;
    expect(shortLines(catalog.providers.map(short))).toEqual([
      "Programs that can add more (Programscape's public catalog; each provider decides who qualifies)",
      "  Firecrawl: Claude for Startups: Firecrawl perk; Firecrawl startup deal (Ask Firecrawl). More: https://programscape.com/extend/firecrawl",
      "  Tavily: no Tavily startup program in the catalog today; other providers that do the same job: https://programscape.com/extend/tavily",
    ]);
    expect(shortLines([])).toEqual([]);
    const full = formatPrograms(catalog.providers, catalog.asOf);
    expect(full).toContain("Programs that can add more, from Programscape's public catalog (as of 2026-10-12).");
    expect(full).toContain("Listed alphabetically, never ranked. Whether you qualify is each provider's decision.");
    expect(full).toContain("    - Firecrawl startup deal (Ask Firecrawl): A year of Firecrawl credits for early-stage startups");
    expect(full).toContain("      Checked 2026-09-30 (may be out of date: confirm on the official page). Official source: Firecrawl for startups, https://www.firecrawl.dev/startups");
    expect(full).toContain("  Other providers that do the same job:\n    - Exa, Exa startup grant (Ask Exa): Exa API credits for startups");
    expect(full).toContain("  Everything that can add more: https://programscape.com/extend/firecrawl");
    // Never a claim about the founder, and never a pick.
    for (const text of [full, ...shortLines(catalog.providers.map(short))]) {
      expect(text).not.toMatch(/you qualify(?! is)|you're eligible|you are eligible|best|recommended|switch to/i);
    }
  });

  it("keeps only the contract's fields when the endpoint sends more", () => {
    const raw = fixture("programscape-programs") as Record<string, unknown>;
    const catalog = sanitizeCatalog({ ...raw, tracking: "zebra", providers: (raw.providers as object[]).map((entry) => ({ ...entry, secret: "zebra" })) });
    expect(JSON.stringify(catalog)).not.toContain("zebra");
  });
});
