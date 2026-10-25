import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatStatus } from "../src/format.js";
import { createRouter } from "../src/router.js";
import { ConfigError, loadConfig, parseConfig, parseConfigWithNotes, readZonesFile, saveZones, zonesFor, zonesPath } from "../src/config.js";
import { ADAPTERS } from "../src/providers/index.js";

const README_EXAMPLE = {
  order: { search: ["tavily", "exa"], scrape: ["firecrawl"] },
  providers: {
    exa: { credits: [{ label: "Exa startup grant", expiresOn: "2027-03-01", remaining: 600, award: 1000, unit: "usd" }] },
    parallel: { paid: false },
  },
};

function message(input: unknown): string {
  try {
    parseConfig(input, "test.json");
  } catch (error) {
    if (error instanceof ConfigError) return error.message;
    throw error;
  }
  throw new Error("expected a ConfigError");
}

describe("config validation", () => {
  it("accepts the README example and an empty object", () => {
    expect(parseConfig(README_EXAMPLE)).toEqual(README_EXAMPLE);
    expect(parseConfig({})).toEqual({});
  });

  it("accepts credits with every field unknown", () => {
    expect(parseConfig({ providers: { tavily: { credits: [{}] } } })).toEqual({ providers: { tavily: { credits: [{}] } } });
  });

  it("names an unknown provider and lists the known ones", () => {
    const text = message({ order: { search: ["bing"] } });
    expect(text).toContain("test.json is not valid");
    expect(text).toContain("order.search.0");
    expect(text).toContain('"bing" is not a provider this router knows. Use one of: brightdata, exa, firecrawl, keenable, linkup, parallel, tavily, youcom.');
  });

  it("parses a config written for 1.1.0 unchanged", () => {
    const v110 = {
      order: { search: ["youcom", "linkup", "tavily"], scrape: ["firecrawl"] },
      providers: {
        exa: { credits: [{ label: "Exa startup grant", expiresOn: "2027-03-01", remaining: 600, award: 1000, unit: "usd" }], programscapeProgram: "exa.startup-grant" },
        linkup: { paid: true },
        youcom: { paid: false, credits: [{ remaining: 100, unit: "usd" }] },
      },
      programscape: { sync: "auto", catalog: false },
      headsUp: { days: 14 },
      timeoutMs: 45000,
    };
    expect(parseConfigWithNotes(v110, "test.json")).toEqual({ config: v110, notes: [] });
  });

  it("ignores settings for a provider it doesn't know, with a note, and stays strict about everything else", () => {
    const shared = { providers: { tavily: { paid: true }, futurecorp: { paid: true, zones: { search: "x" } } } };
    expect(parseConfigWithNotes(shared, "test.json")).toEqual({
      config: { providers: { tavily: { paid: true } } },
      notes: ["Ignored providers.futurecorp in test.json: not a provider this version of the router knows (a newer version may)."],
    });
    expect(parseConfig(shared)).toEqual({ providers: { tavily: { paid: true } } });
    // An unknown provider in an order, or an unknown field, still stops it.
    expect(message({ order: { search: ["futurecorp"] } })).toContain('"futurecorp" is not a provider this router knows.');
    expect(message({ providers: { tavily: { nope: 1 } } })).toContain("providers.tavily");
    expect(message({ nope: 1 })).toContain("test.json is not valid");
  });

  it("loads a config with an unknown provider, and the router logs the note and shows it in status", async () => {
    const dir = mkdtempSync(join(tmpdir(), "psr-config-unknown-"));
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ providers: { futurecorp: { paid: true }, exa: { paid: false } } }));
    const env = { PROGRAMSCAPE_ROUTER_CONFIG: path };
    const located = loadConfig(env, dir);
    expect(located.config).toEqual({ providers: { exa: { paid: false } } });
    expect(located.notes).toEqual([`Ignored providers.futurecorp in ${path}: not a provider this version of the router knows (a newer version may).`]);
    const logs: string[] = [];
    const router = createRouter({ env, cwd: dir, ledgerPath: false, catalogPath: false, log: (m) => logs.push(m) });
    expect(logs).toEqual(located.notes);
    const status = await router.status();
    expect(status.configNotes).toEqual(located.notes);
    expect(formatStatus(status)).toContain(`  Ignored providers.futurecorp in ${path}`);
  });

  it("takes Bright Data's zone names, and only for Bright Data", () => {
    const zones = { providers: { brightdata: { zones: { search: "programscape_serp", scrape: "web_unlocker1" } } } };
    expect(parseConfig(zones)).toEqual(zones);
    expect(parseConfig({ providers: { brightdata: { zones: {} } } })).toEqual({ providers: { brightdata: { zones: {} } } });
    expect(message({ providers: { tavily: { zones: { search: "x" } } } })).toContain("providers.tavily.zones: Tavily has no zones; only brightdata takes them.");
    expect(message({ providers: { brightdata: { zones: { search: "bad name!" } } } })).toContain("providers.brightdata.zones.search: Use the zone's name as Bright Data shows it");
    expect(message({ providers: { brightdata: { zones: { crawl: "x" } } } })).toContain("providers.brightdata.zones");
  });

  it("reads each zone from its environment variable, then config.json, then zones.json", () => {
    const env = { XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "psr-zones-file-")) };
    expect(zonesFor(ADAPTERS.brightdata, {}, env)).toEqual({});
    const path = saveZones(env, "brightdata", { search: "file_serp", scrape: "file_unlocker" });
    expect(path).toBe(join(env.XDG_CONFIG_HOME, "programscape-router", "zones.json"));
    expect(path).toBe(zonesPath(env));
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: 1, brightdata: { search: "file_serp", scrape: "file_unlocker" } });
    expect(zonesFor(ADAPTERS.brightdata, {}, env)).toEqual({ search: "file_serp", scrape: "file_unlocker" });
    const config = { providers: { brightdata: { zones: { search: "config_serp" } } } };
    expect(zonesFor(ADAPTERS.brightdata, config, env)).toEqual({ search: "config_serp", scrape: "file_unlocker" });
    expect(zonesFor(ADAPTERS.brightdata, config, { ...env, BRIGHTDATA_SERP_ZONE: "env_serp", BRIGHTDATA_UNLOCKER_ZONE: "env_unlocker" })).toEqual({
      search: "env_serp",
      scrape: "env_unlocker",
    });
    // Saving one capability keeps the other; a broken file counts as none and is written fresh.
    saveZones(env, "brightdata", { search: "file_serp_2" });
    expect(readZonesFile(env)).toEqual({ brightdata: { search: "file_serp_2", scrape: "file_unlocker" } });
    writeFileSync(path, "{ not json");
    expect(readZonesFile(env)).toEqual({});
    expect(zonesFor(ADAPTERS.brightdata, {}, env)).toEqual({});
    saveZones(env, "brightdata", { scrape: "fresh" });
    expect(readZonesFile(env)).toEqual({ brightdata: { scrape: "fresh" } });
    // Only adapters with zones read it.
    expect(zonesFor(ADAPTERS.tavily, {}, env)).toEqual({});
  });

  it("reads each zone from its environment variable first, then config", () => {
    const config = { providers: { brightdata: { zones: { search: "config_serp", scrape: "config_unlocker" } } } };
    expect(zonesFor(ADAPTERS.brightdata, config, {})).toEqual({ search: "config_serp", scrape: "config_unlocker" });
    expect(zonesFor(ADAPTERS.brightdata, config, { BRIGHTDATA_SERP_ZONE: " env_serp ", BRIGHTDATA_UNLOCKER_ZONE: "" })).toEqual({ search: "env_serp", scrape: "config_unlocker" });
    expect(zonesFor(ADAPTERS.brightdata, {}, {})).toEqual({});
    expect(zonesFor(ADAPTERS.tavily, config, { BRIGHTDATA_SERP_ZONE: "x" })).toEqual({});
  });

  it("rejects a provider listed twice", () => {
    expect(message({ order: { scrape: ["exa", "exa"] } })).toContain("List each provider once.");
  });

  it("rejects dates that are not YYYY-MM-DD or not real", () => {
    expect(message({ providers: { exa: { credits: [{ expiresOn: "March 1" }] } } })).toContain("Use a date like 2027-03-01.");
    expect(message({ providers: { exa: { credits: [{ expiresOn: "2027-13-45" }] } } })).toContain("Not a real calendar date.");
  });

  it("rejects negative amounts, a zero award and unknown fields", () => {
    expect(message({ providers: { exa: { credits: [{ remaining: -1 }] } } })).toContain("providers.exa.credits.0.remaining");
    expect(message({ providers: { exa: { credits: [{ award: 0 }] } } })).toContain("providers.exa.credits.0.award");
    expect(message({ providers: { exa: { apiKey: "x" } } })).toContain("providers.exa");
    expect(message({ quality: { exa: 1 } })).toContain("quality");
    // From 1.2.0 an unknown provider under providers is ignored with a note, not an error (see below).
    expect(parseConfigWithNotes({ providers: { google: {} } }).notes).toHaveLength(1);
  });
});

describe("Programscape sync settings", () => {
  it("accepts an explicit saved-plan UUID and rejects an invalid plan selection", () => {
    const planId = "11111111-1111-4111-8111-111111111111";
    expect(parseConfig({ programscape: { planId } })).toEqual({ programscape: { planId } });
    expect(message({ programscape: { planId: "Acme" } })).toContain("programscape.planId");
  });

  it("accepts sync auto or manual and a program per provider", () => {
    const config = { programscape: { sync: "auto" }, providers: { firecrawl: { programscapeProgram: "firecrawl.startup-deal" } } };
    expect(parseConfig(config)).toEqual(config);
    expect(parseConfig({ programscape: { sync: "manual" } })).toEqual({ programscape: { sync: "manual" } });
  });

  it("explains a wrong sync value and rejects a token in config", () => {
    expect(message({ programscape: { sync: "always" } })).toContain('programscape.sync: Use "manual"');
    expect(message({ programscape: { token: "x" } })).toContain("programscape");
    expect(message({ providers: { firecrawl: { programscapeProgram: "" } } })).toContain("providers.firecrawl.programscapeProgram");
  });
});

describe("config lookup", () => {
  function dirs() {
    const root = mkdtempSync(join(tmpdir(), "psr-config-"));
    const cwd = join(root, "project");
    const xdg = join(root, "xdg");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(xdg, "programscape-router"), { recursive: true });
    return { root, cwd, xdg };
  }

  it("prefers $PROGRAMSCAPE_ROUTER_CONFIG, then ./programscape-router.json, then the XDG config", () => {
    const { root, cwd, xdg } = dirs();
    writeFileSync(join(xdg, "programscape-router", "config.json"), JSON.stringify({ timeoutMs: 3000 }));
    expect(loadConfig({ XDG_CONFIG_HOME: xdg }, cwd)).toEqual({ path: join(xdg, "programscape-router", "config.json"), config: { timeoutMs: 3000 } });

    writeFileSync(join(cwd, "programscape-router.json"), JSON.stringify({ timeoutMs: 4000 }));
    expect(loadConfig({ XDG_CONFIG_HOME: xdg }, cwd).config).toEqual({ timeoutMs: 4000 });

    writeFileSync(join(root, "explicit.json"), JSON.stringify({ timeoutMs: 5000 }));
    expect(loadConfig({ XDG_CONFIG_HOME: xdg, PROGRAMSCAPE_ROUTER_CONFIG: join(root, "explicit.json") }, cwd).config).toEqual({
      timeoutMs: 5000,
    });
  });

  it("returns defaults when no file exists", () => {
    const { cwd, xdg } = dirs();
    expect(loadConfig({ XDG_CONFIG_HOME: xdg }, cwd)).toEqual({ path: undefined, config: {} });
  });

  it("explains a missing explicit file and invalid JSON", () => {
    const { root, cwd, xdg } = dirs();
    expect(() => loadConfig({ XDG_CONFIG_HOME: xdg, PROGRAMSCAPE_ROUTER_CONFIG: join(root, "nope.json") }, cwd)).toThrow(/does not exist/);
    writeFileSync(join(cwd, "programscape-router.json"), "{ not json");
    expect(() => loadConfig({ XDG_CONFIG_HOME: xdg }, cwd)).toThrow(/is not valid JSON/);
  });
});
