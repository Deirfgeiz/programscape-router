import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, parseConfig } from "../src/config.js";

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
    expect(text).toContain('"bing" is not a provider this router knows. Use one of: exa, firecrawl, keenable, parallel, tavily.');
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
    expect(message({ providers: { google: {} } })).toContain("google");
  });
});

describe("Programscape sync settings", () => {
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
