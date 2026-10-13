import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli-main.js";
import { KEYCHAIN_SERVICE } from "../src/keys.js";
import { fakeKeyring } from "./fake-keyring.js";
import { BRIGHTDATA_ZONE_URLS, fixture, mockFetch, ok, status, type Responder } from "./helpers.js";

const KEY = "brd-ZONESECRET-4242";
/** What a zone-creation answer holds, live: the zone's proxy password and the account's user id. */
const CREATED = { zone: { name: "programscape_unlocker", password: ["zonepass-ZONESECRET-1"] }, customer: "hl_ZONESECRET_user" };

/**
 * A terminal that answers each question as it is asked: each [pattern, answer] waits for a prompt matching the pattern,
 * then types the answer and Enter. Everything shown on it is kept in `shown`.
 */
function scripted(answers: Array<[RegExp, string]>) {
  const input = new PassThrough() as PassThrough & { isTTY: boolean; isRaw: boolean; setRawMode(mode: boolean): void };
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (mode: boolean) => {
    input.isRaw = mode;
  };
  const queue = [...answers];
  const shown: string[] = [];
  const asked: string[] = [];
  const output = {
    write(text: string) {
      shown.push(text);
      const next = queue[0];
      if (next && next[0].test(text)) {
        queue.shift();
        asked.push(text);
        queueMicrotask(() => input.write(`${next[1]}\r`));
      }
      return true;
    },
  };
  return { input, output, shown: () => shown.join(""), asked, left: () => queue.length };
}

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { streams: { stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t) }, out, err, all: () => out.join("") + err.join("") };
}

function places() {
  const root = mkdtempSync(join(tmpdir(), "psr-zones-"));
  const cwd = join(root, "project");
  mkdirSync(cwd);
  const env = { XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state"), PROGRAMSCAPE_ROUTER_CATALOG: "off" };
  const folder = join(root, "config", "programscape-router");
  return { cwd, env, configPath: join(folder, "config.json"), zonesPath: join(folder, "zones.json") };
}

const KEY_PROMPT: [RegExp, string] = [/Paste your Bright Data key/, KEY];

async function run(argv: string[], routes: Record<string, Responder | Responder[]>, terminal?: ReturnType<typeof scripted>, extraEnv: Record<string, string> = {}) {
  const where = places();
  const mock = mockFetch(routes);
  const out = io();
  const stdin = terminal ? terminal.input : (Readable.from([`${KEY}\n`]) as never);
  const code = await main(["keys", "set", "brightdata", ...argv], out.streams, {
    env: { ...where.env, ...extraEnv },
    cwd: where.cwd,
    stdin: stdin as never,
    ...(terminal ? { promptOutput: terminal.output } : {}),
    fetch: mock.fetch,
    platform: "darwin",
  });
  // keys set never creates or edits config.json: a 1.1.0 router would refuse to start on providers.brightdata.
  expect(existsSync(where.configPath)).toBe(false);
  expect(existsSync(join(where.cwd, "programscape-router.json"))).toBe(false);
  const saved = existsSync(where.zonesPath) ? JSON.parse(readFileSync(where.zonesPath, "utf8")) : undefined;
  return { code, ...out, calls: mock.calls, saved, ...where };
}

function noSecrets(...texts: string[]) {
  for (const text of texts) {
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("ZONESECRET");
    expect(text).not.toContain("zonepass");
  }
}

describe("keys set brightdata: zones", () => {
  it("finds the search and page-read zones by type and saves them in config, asking nothing more", async () => {
    const terminal = scripted([KEY_PROMPT]);
    const result = await run([], { [BRIGHTDATA_ZONE_URLS.list]: ok(fixture("brightdata-zones")) }, terminal);
    expect(result.code).toBe(0);
    expect(fakeKeyring.peek(KEYCHAIN_SERVICE, "BRIGHTDATA_API_KEY")).toBe(KEY);
    expect(result.saved).toEqual({ version: 1, brightdata: { search: "programscape_serp", scrape: "web_unlocker1" } });
    expect(result.out.join("")).toContain(`Saved the Bright Data zones in ${result.zonesPath}: search programscape_serp, page reads web_unlocker1.`);
    expect(result.calls.map((call) => [call.method, call.url])).toEqual([["GET", BRIGHTDATA_ZONE_URLS.list]]);
    expect(result.calls[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(terminal.asked).toHaveLength(1);
    noSecrets(result.all(), terminal.shown());
  });

  it("asks which one, by number, when there are several of a kind", async () => {
    const zones = [
      { name: "serp_a", type: "serp" },
      { name: "serp_b", type: "serp" },
      { name: "web_unlocker1", type: "unblocker" },
    ];
    const terminal = scripted([KEY_PROMPT, [/^Number \(1-2\): $/, "7"], [/^Number \(1-2\): $/, "2"]]);
    const result = await run([], { [BRIGHTDATA_ZONE_URLS.list]: ok(zones) }, terminal);
    expect(result.code).toBe(0);
    expect(terminal.shown()).toContain("Your account has 2 SERP API zones. Which one should search use?\n  1. serp_a\n  2. serp_b\n");
    expect(result.saved.brightdata).toEqual({ search: "serp_b", scrape: "web_unlocker1" });
  });

  it("offers to create a missing zone, and creates nothing on Enter (the default is No)", async () => {
    const terminal = scripted([
      KEY_PROMPT,
      [/^Create programscape_unlocker \(page reads\) in your Bright Data account\? Free-tier credits cover them; nothing is bought\. \[y\/N\] $/, ""],
      [/Name of your Web Unlocker API zone for page reads \(blank to skip\): /, ""],
    ]);
    const result = await run([], { [BRIGHTDATA_ZONE_URLS.list]: ok([{ name: "programscape_serp", type: "serp" }]) }, terminal);
    expect(terminal.left()).toBe(0);
    expect(result.calls.some((call) => call.method === "POST")).toBe(false);
    expect(result.out.join("")).toContain("Nothing was created.");
    expect(result.saved.brightdata).toEqual({ search: "programscape_serp" });
    expect(result.err.join("")).toContain(
      "No Web Unlocker API zone is set up, so Bright Data won't be used for page reads. Run `programscape-router keys set brightdata` again (or set BRIGHTDATA_UNLOCKER_ZONE).",
    );
    expect(result.code).toBe(1);
  });

  it("asks about both missing zones in one question, as the ruling words it", async () => {
    const terminal = scripted([
      KEY_PROMPT,
      [/^Create programscape_serp \(search\) \/ programscape_unlocker \(page reads\) in your Bright Data account\? Free-tier credits cover them; nothing is bought\. \[y\/N\] $/, "n"],
      [/zone for search/, ""],
      [/zone for page reads/, ""],
    ]);
    const result = await run([], { [BRIGHTDATA_ZONE_URLS.list]: ok([{ name: "browser1", type: "browser_api" }]) }, terminal);
    expect(terminal.left()).toBe(0);
    expect(result.calls.some((call) => call.method === "POST")).toBe(false);
    expect(result.saved).toBeUndefined();
  });

  it("creates the zone on yes, with the documented body, and never shows any of the answer", async () => {
    const terminal = scripted([KEY_PROMPT, [/\[y\/N\] $/, "y"]]);
    const result = await run(
      [],
      { [BRIGHTDATA_ZONE_URLS.list]: ok([{ name: "programscape_serp", type: "serp" }]), [BRIGHTDATA_ZONE_URLS.create]: ok(CREATED) },
      terminal,
    );
    expect(result.code).toBe(0);
    const posts = result.calls.filter((call) => call.method === "POST");
    expect(posts.map((call) => [call.url, call.body])).toEqual([
      [BRIGHTDATA_ZONE_URLS.create, { zone: { name: "programscape_unlocker", type: "unblocker" }, plan: { type: "unblocker" } }],
    ]);
    expect(result.out.join("")).toContain("Created programscape_unlocker for page reads in your Bright Data account.");
    expect(result.saved.brightdata).toEqual({ search: "programscape_serp", scrape: "programscape_unlocker" });
    noSecrets(result.all(), terminal.shown(), JSON.stringify(result.saved));
  });

  it("creates the SERP zone with serp: true", async () => {
    const terminal = scripted([KEY_PROMPT, [/\[y\/N\] $/, "yes"]]);
    const result = await run(
      [],
      { [BRIGHTDATA_ZONE_URLS.list]: ok([{ name: "web_unlocker1", type: "unblocker" }]), [BRIGHTDATA_ZONE_URLS.create]: ok(CREATED) },
      terminal,
    );
    expect(result.calls.find((call) => call.method === "POST")?.body).toEqual({ zone: { name: "programscape_serp", type: "unblocker" }, plan: { type: "unblocker", serp: true } });
    expect(result.saved.brightdata).toEqual({ search: "programscape_serp", scrape: "web_unlocker1" });
  });

  it("when creating is refused (403), explains the Admin key and the dashboard, then asks for the name", async () => {
    const terminal = scripted([KEY_PROMPT, [/\[y\/N\] $/, "y"], [/Name of your Web Unlocker API zone for page reads/, "my_unlocker"]]);
    const result = await run(
      [],
      {
        [BRIGHTDATA_ZONE_URLS.list]: ok([{ name: "programscape_serp", type: "serp" }]),
        [BRIGHTDATA_ZONE_URLS.create]: status(403, { error: "forbidden zonepass-ZONESECRET-1" }),
      },
      terminal,
    );
    expect(result.err.join("")).toContain("Bright Data didn't let this key create programscape_unlocker (HTTP 403): creating zones needs an Admin key.");
    expect(result.err.join("")).toContain("create the zone in Bright Data's dashboard instead, under Web Access API");
    expect(terminal.shown()).toContain("Each zone's name is at the top of its page in Bright Data, under Web Access API.");
    expect(result.saved.brightdata).toEqual({ search: "programscape_serp", scrape: "my_unlocker" });
    expect(result.code).toBe(0);
    noSecrets(result.all(), terminal.shown());
  });

  it("reads an empty list (a key without Admin permission) as 'can't tell', and asks for the names with the hint", async () => {
    const terminal = scripted([
      KEY_PROMPT,
      [/zone for search/, "not a name!"],
      [/zone for search/, "programscape_serp"],
      [/zone for page reads/, "web_unlocker1"],
    ]);
    const result = await run([], { [BRIGHTDATA_ZONE_URLS.list]: ok([]) }, terminal);
    expect(result.code).toBe(0);
    expect(result.out.join("")).toContain(
      "Bright Data listed no zones for this key (a key without Admin permission sees none). Each zone's name is at the top of its page in Bright Data, under Web Access API.",
    );
    expect(result.all()).not.toMatch(/you have no zones/i);
    // Nothing is offered for creation from an empty list: it says nothing about the account.
    expect(terminal.shown()).not.toContain("[y/N]");
    expect(result.calls.some((call) => call.method === "POST")).toBe(false);
    expect(result.saved.brightdata).toEqual({ search: "programscape_serp", scrape: "web_unlocker1" });
  });

  it("never edits an existing config.json, merges zones.json on a re-run, and says when config's own zones win", async () => {
    const where = places();
    const local = join(where.cwd, "programscape-router.json");
    const handWritten = JSON.stringify({ headsUp: { days: 14 }, providers: { brightdata: { paid: true, zones: { scrape: "config_unlocker" } } } });
    writeFileSync(local, handWritten);
    const go = async (argv: string[], routes: Record<string, Responder>) => {
      const out = io();
      const code = await main(["keys", "set", "brightdata", "--stdin", ...argv], out.streams, {
        env: where.env,
        cwd: where.cwd,
        stdin: Readable.from([`${KEY}\n`]) as never,
        fetch: mockFetch(routes).fetch,
        platform: "darwin",
      });
      return { code, out: out.out.join("") };
    };
    const first = await go(["--search-zone", "serp_one"], { [BRIGHTDATA_ZONE_URLS.list]: ok([{ name: "web_unlocker1", type: "unblocker" }]) });
    expect(first.code).toBe(0);
    expect(first.out).toContain("Your config file's providers.brightdata.zones names config_unlocker for page reads, and it wins over zones.json.");
    expect(JSON.parse(readFileSync(where.zonesPath, "utf8"))).toEqual({ version: 1, brightdata: { search: "serp_one", scrape: "web_unlocker1" } });
    // A re-run naming only the search zone keeps the page-read one.
    await go(["--search-zone", "serp_two", "--scrape-zone", "web_unlocker1"], {});
    const third = await go(["--search-zone", "serp_three"], { [BRIGHTDATA_ZONE_URLS.list]: ok([]) });
    // The page-read zone saved earlier still counts as set up.
    expect(third.code).toBe(0);
    expect(JSON.parse(readFileSync(where.zonesPath, "utf8"))).toEqual({ version: 1, brightdata: { search: "serp_three", scrape: "web_unlocker1" } });
    expect(readFileSync(local, "utf8")).toBe(handWritten);
    expect(existsSync(where.configPath)).toBe(false);
  });

  it("says a refused key when listing, and saves no zones", async () => {
    const terminal = scripted([KEY_PROMPT]);
    const result = await run([], { [BRIGHTDATA_ZONE_URLS.list]: () => new Response("Invalid token", { status: 401 }) }, terminal);
    expect(result.code).toBe(1);
    expect(result.err.join("")).toContain("Bright Data refused this key when listing its zones (HTTP 401).");
    expect(result.saved).toBeUndefined();
  });

  it("leaves a zone its environment variable names alone", async () => {
    const terminal = scripted([KEY_PROMPT]);
    const result = await run([], { [BRIGHTDATA_ZONE_URLS.list]: ok(fixture("brightdata-zones")) }, terminal, { BRIGHTDATA_SERP_ZONE: "env_serp" });
    expect(result.saved.brightdata).toEqual({ scrape: "web_unlocker1" });
    expect(result.out.join("")).toContain("BRIGHTDATA_SERP_ZONE is set in this environment, so search use that zone (it wins over config).");
    expect(result.code).toBe(0);
  });
});

describe("keys set brightdata --stdin: zones", () => {
  it("takes --search-zone and --scrape-zone, and calls nothing", async () => {
    const result = await run(["--stdin", "--search-zone", "my_serp", "--scrape-zone", "my_unlocker"], {});
    expect(result.code).toBe(0);
    expect(result.calls).toHaveLength(0);
    expect(fakeKeyring.peek(KEYCHAIN_SERVICE, "BRIGHTDATA_API_KEY")).toBe(KEY);
    expect(result.saved.brightdata).toEqual({ search: "my_serp", scrape: "my_unlocker" });
    noSecrets(result.all());
  });

  it("without flags, takes a zone only when the list has exactly one of its kind, and never asks or creates", async () => {
    const zones = [
      { name: "serp_a", type: "serp" },
      { name: "serp_b", type: "serp" },
    ];
    const result = await run(["--stdin"], { [BRIGHTDATA_ZONE_URLS.list]: ok(zones), [BRIGHTDATA_ZONE_URLS.create]: ok(CREATED) });
    expect(result.calls.map((call) => call.method)).toEqual(["GET"]);
    expect(result.saved).toBeUndefined();
    expect(result.err.join("")).toContain("Your account has several SERP API zones; name one with --search-zone.");
    expect(result.err.join("")).toContain("Run `programscape-router keys set brightdata` in a terminal, or pass --scrape-zone <name> (or set BRIGHTDATA_UNLOCKER_ZONE).");
    expect(result.code).toBe(1);

    const found = await run(["--stdin", "--search-zone", "serp_b"], { [BRIGHTDATA_ZONE_URLS.list]: ok(fixture("brightdata-zones")) });
    expect(found.saved.brightdata).toEqual({ search: "serp_b", scrape: "web_unlocker1" });
    expect(found.code).toBe(0);
  });

  it("rejects a bad zone name before reading the key, and zone flags on another provider", async () => {
    const bad = await run(["--stdin", "--search-zone", "no spaces"], {});
    expect(bad.code).toBe(2);
    expect(bad.err.join("")).toContain("--search-zone needs a zone name, such as programscape_serp");
    expect(fakeKeyring.peek(KEYCHAIN_SERVICE, "BRIGHTDATA_API_KEY")).toBeUndefined();
    const out = io();
    expect(await main(["keys", "set", "tavily", "--stdin", "--search-zone", "x"], out.streams, { env: {}, stdin: Readable.from(["k\n"]) as never })).toBe(2);
    expect(out.err.join("")).toContain("--search-zone and --scrape-zone are only for brightdata; Tavily has no zones.");
  });
});
