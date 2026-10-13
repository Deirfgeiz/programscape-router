import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli-main.js";
import type { RouterConfig } from "../src/config.js";
import { connect, disconnect } from "../src/programscape/connect.js";
import { Connection } from "../src/programscape/connection.js";
import { ProgramscapeError, programscapeFetch } from "../src/programscape/guard.js";
import { amountIssue, mapProgram, readPlanPrograms } from "../src/programscape/plan.js";
import { TOKEN_KEYCHAIN_ACCOUNT, readConnectionState, readSyncState, readTokenFile, tokenPath, writeConnectionState } from "../src/programscape/store.js";
import { fakeKeyring } from "./fake-keyring.js";
import { KEYCHAIN_SERVICE } from "../src/keys.js";
import { AUTO_SYNC_INTERVAL_MS } from "../src/programscape/sync.js";
import { createRouter } from "../src/router.js";
import { type FakeOptions, type KeptProgram, combine, fakeProgramscape } from "./programscape-fake.js";
import { URLS, fixture, mockFetch, ok, type Responder } from "./helpers.js";

const START = new Date("2026-10-11T12:00:00Z");

function homes() {
  const root = mkdtempSync(join(tmpdir(), "psr-sync-"));
  return { XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state") };
}

const FIRECRAWL_ONE: KeptProgram[] = [
  { id: "firecrawl.startup-deal", provider: "firecrawl", approved: true },
  { id: "aws.activate-founders", provider: "aws", approved: true },
];

const PROVIDER_ROUTES: Record<string, Responder | Responder[]> = {
  [URLS.firecrawlCredits]: ok(fixture("firecrawl-credit-usage")),
  [URLS.firecrawlSearch]: ok(fixture("firecrawl-search")),
  [URLS.tavilyUsage]: ok(fixture("tavily-usage")),
  [URLS.tavilySearch]: ok(fixture("tavily-search")),
  [URLS.exaSearch]: ok(fixture("exa-search")),
};

/** A connected founder: tokens on disk from a real connect against the fake. */
async function connected(fakeOptions: FakeOptions = {}, keys: Record<string, string> = { FIRECRAWL_API_KEY: "fc-KEYSECRET-1" }) {
  const fake = fakeProgramscape({ kept: FIRECRAWL_ONE, ...fakeOptions });
  const providers = mockFetch(PROVIDER_ROUTES);
  const fetch = combine(fake.fetch, providers.fetch);
  const env = { ...homes(), ...keys };
  let clock = START;
  const now = () => clock;
  await connect({ env, fetch, now, print: () => {}, openBrowser: fake.browser });
  const logs: string[] = [];
  const router = (config: RouterConfig = {}) => createRouter({ env, config, fetch, ledgerPath: false, log: (m) => logs.push(m), now });
  return { fake, providers, fetch, env, logs, router, advance: (ms: number) => (clock = new Date(clock.getTime() + ms)) };
}

function reports(fake: ReturnType<typeof fakeProgramscape>) {
  return fake.toolCalls.filter((call) => call.name === "report_balance").map((call) => call.arguments);
}

describe("connect", () => {
  it("registers a public client for the exact loopback redirect URI and uses PKCE S256", async () => {
    const fake = fakeProgramscape();
    const env = homes();
    const printed: string[] = [];
    await connect({ env, fetch: fake.fetch, now: () => START, print: (line) => printed.push(line), openBrowser: fake.browser });

    expect(fake.registrations).toHaveLength(1);
    const registration = fake.registrations[0] as Record<string, unknown>;
    const redirectUris = registration.redirect_uris as string[];
    expect(redirectUris).toHaveLength(1);
    const redirectUri = redirectUris[0] as string;
    expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(registration).toMatchObject({
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: "plans",
    });
    expect(registration).not.toHaveProperty("client_secret");

    const authorization = fake.authorizations[0] as URLSearchParams;
    expect(authorization.get("redirect_uri")).toBe(redirectUri);
    expect(authorization.get("response_type")).toBe("code");
    expect(authorization.get("code_challenge_method")).toBe("S256");
    expect(authorization.get("scope")).toBe("plans");
    expect(authorization.get("resource")).toBe("https://programscape.com/api/mcp");
    expect(authorization.get("state")).toMatch(/^[A-Za-z0-9_-]{20,}$/);

    const exchange = fake.tokenRequests[0] as URLSearchParams;
    expect(exchange.get("grant_type")).toBe("authorization_code");
    expect(exchange.get("redirect_uri")).toBe(redirectUri);
    expect(exchange.get("client_id")).toBe("client-1");
    const verifier = exchange.get("code_verifier") ?? "";
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(authorization.get("code_challenge"));

    // The authorization URL is printed for headless use; tokens never are.
    expect(printed.join("\n")).toContain("https://programscape.com/connect?");
    expect(printed.join("\n")).not.toContain("TOKENSECRET");
  });

  it("listens for the sign-in redirect on 127.0.0.1 only, so no firewall asks to open a port", async () => {
    const fake = fakeProgramscape();
    const env = homes();
    const reachable: Record<string, boolean> = {};
    const tryConnect = (host: string, port: number) =>
      new Promise<boolean>((resolve) => {
        const socket = createConnection({ host, port });
        socket.once("connect", () => {
          socket.destroy();
          resolve(true);
        });
        socket.once("error", () => resolve(false));
      });
    await connect({
      env,
      fetch: fake.fetch,
      now: () => START,
      print: () => {},
      openBrowser: async (authorizationUrl) => {
        const port = Number(new URL(new URL(authorizationUrl).searchParams.get("redirect_uri") ?? "").port);
        reachable.loopback = await tryConnect("127.0.0.1", port);
        reachable.ipv6Loopback = await tryConnect("::1", port);
        const lan = Object.values(networkInterfaces())
          .flat()
          .find((address) => address && address.family === "IPv4" && !address.internal);
        if (lan) reachable.lan = await tryConnect(lan.address, port);
        await fake.browser(authorizationUrl);
      },
    });
    expect(reachable.loopback).toBe(true);
    expect(reachable.ipv6Loopback).toBe(false);
    if ("lan" in reachable) expect(reachable.lan).toBe(false);
  });

  it("stores the tokens in the OS keychain, and leaves no token file", async () => {
    const fake = fakeProgramscape();
    const env = homes();
    const result = await connect({ env, fetch: fake.fetch, now: () => START, print: () => {}, openBrowser: fake.browser });
    expect(result.stored).toEqual({ kind: "keychain", label: expect.any(String) });
    expect(await readTokenFile(env)).toMatchObject({ refreshToken: "ps-REFRESH-1-TOKENSECRET" });
    const entry = fakeKeyring.peek(KEYCHAIN_SERVICE, TOKEN_KEYCHAIN_ACCOUNT);
    expect(JSON.parse(entry ?? "{}")).toMatchObject({ clientId: "client-1", accessToken: "ps-ACCESS-1-TOKENSECRET", refreshToken: "ps-REFRESH-1-TOKENSECRET" });
    const stored = await readTokenFile(env);
    expect(stored).toMatchObject({ clientId: "client-1", accessToken: "ps-ACCESS-1-TOKENSECRET", refreshToken: "ps-REFRESH-1-TOKENSECRET" });
    expect(stored?.expiresAt).toBe("2026-10-11T13:00:00.000Z");
    expect(stored).not.toHaveProperty("email");

    await disconnect({ env, fetch: fake.fetch });
    expect(fakeKeyring.peek(KEYCHAIN_SERVICE, TOKEN_KEYCHAIN_ACCOUNT)).toBeUndefined();
  });

  it("without a keychain, stores the tokens in a file: mode 600 in a mode 700 folder on macOS and Linux", async () => {
    fakeKeyring.available = false;
    const fake = fakeProgramscape();
    const env = homes();
    const result = await connect({ env, fetch: fake.fetch, now: () => START, print: () => {}, openBrowser: fake.browser });
    expect(result.stored).toEqual({ kind: "file", path: join(env.XDG_CONFIG_HOME, "programscape-router", "programscape-token.json") });
    // POSIX modes don't exist on Windows; there the profile folder's default permissions are all that protect it.
    if (process.platform !== "win32") {
      expect(statSync(tokenPath(env)).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(tokenPath(env))).mode & 0o777).toBe(0o700);
    }
    expect(await readTokenFile(env)).toMatchObject({ clientId: "client-1", accessToken: "ps-ACCESS-1-TOKENSECRET" });
    await disconnect({ env, fetch: fake.fetch });
    expect(existsSync(tokenPath(env))).toBe(false);
  });

  it("says it connected, names no account (the token response doesn't), and never prints a token", async () => {
    const fake = fakeProgramscape({ tokenExtras: { email: "founder@example.com" } });
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(["connect"], { stdout: (t) => out.push(t), stderr: (t) => err.push(t) }, {
      env: homes(),
      config: {},
      fetch: fake.fetch,
      ledgerPath: false,
      openBrowser: fake.browser,
    });
    expect(code).toBe(0);
    expect(out.join("")).toContain("Connected to Programscape. The sign-in token is stored in ");
    expect(out.join("") + err.join("")).not.toContain("founder@example.com");
    expect(out.join("") + err.join("")).not.toContain("TOKENSECRET");
  });

  it("ignores a redirect that doesn't carry this sign-in's state", async () => {
    const fake = fakeProgramscape();
    const env = homes();
    await connect({
      env,
      fetch: fake.fetch,
      now: () => START,
      print: () => {},
      openBrowser: async (url) => {
        const forged = new URL(fake.approve(url));
        forged.searchParams.set("state", "not-the-state");
        expect((await globalThis.fetch(forged)).status).toBe(400);
        await fake.browser(url);
      },
    });
    expect(await readTokenFile(env)).toBeDefined();
  });

  it("refuses sign-in metadata that points anywhere but programscape.com", async () => {
    const fake = fakeProgramscape();
    fake.behaviour.metadataOverrides = { token_endpoint: "https://evil.example.com/token" };
    const error = await connect({ env: homes(), fetch: fake.fetch, now: () => START, print: () => {}, openBrowser: false }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProgramscapeError);
    expect((error as Error).message).toContain("outside programscape.com");
  });
});

describe("the programscape.com-only fetch", () => {
  it("refuses other hosts and never follows a redirect", async () => {
    const seen: Array<RequestInit["redirect"]> = [];
    const base = async (_input: string, init?: RequestInit) => {
      seen.push(init?.redirect);
      return new Response(null, { status: 302, headers: { location: "https://evil.example.com/" } });
    };
    const guarded = programscapeFetch(base, 1000);
    await expect(guarded("https://api.tavily.com/search")).rejects.toThrow("other than programscape.com");
    await expect(guarded("https://programscape.com.evil.example/x")).rejects.toThrow("other than programscape.com");
    await expect(guarded("http://programscape.com/api/mcp")).rejects.toThrow("other than programscape.com");
    await expect(guarded("https://programscape.com/api/mcp", { method: "POST", redirect: "follow" })).rejects.toThrow("redirect");
    expect(seen).toEqual(["manual"]);
  });
});

describe("mapping a provider's balance to a plan program", () => {
  const plan = (kept: KeptProgram[]) =>
    readPlanPrograms({ kept: kept.map((program) => ({ id: program.id, provider: { id: program.provider }, ...(program.approved ? { approved: true } : {}) })) });

  it("reads approval only from approved: true", () => {
    const programs = readPlanPrograms({ kept: [{ id: "a.x", provider: { id: "a" }, approved: true }, { id: "a.y", provider: { id: "a" }, approval: "approved" }, { id: "a.z", provider: { id: "a" } }] });
    expect(programs.map((program) => program.approved)).toEqual([true, false, false]);
  });

  it("checks amounts the way a plan records them", () => {
    expect(amountIssue(10.25, "usd")).toBeUndefined();
    expect(amountIssue(10.255, "usd")).toContain("fractions of a cent");
    expect(amountIssue(1000, "credits")).toBeUndefined();
    expect(amountIssue(-1, "requests")).toContain("below zero");
  });

  it("uses the one kept, approved program from that provider", () => {
    expect(mapProgram("firecrawl", plan(FIRECRAWL_ONE))).toEqual({ kind: "mapped", programId: "firecrawl.startup-deal", via: "only-match" });
  });

  it("doesn't guess between several", () => {
    const programs = plan([...FIRECRAWL_ONE, { id: "firecrawl.claude-startup-perks", provider: "firecrawl", approved: true }]);
    const mapping = mapProgram("firecrawl", programs);
    expect(mapping.kind).toBe("unmapped");
    expect(mapping.kind === "unmapped" && mapping.message).toContain("2 kept, approved Firecrawl programs (firecrawl.startup-deal, firecrawl.claude-startup-perks)");
    expect(mapping.kind === "unmapped" && mapping.message).toContain("providers.firecrawl.programscapeProgram");
  });

  it("says so when there is none, including a kept one not approved yet", () => {
    const none = mapProgram("tavily", plan(FIRECRAWL_ONE));
    expect(none.kind === "unmapped" && none.message).toContain("no kept, approved Tavily program");
    const waiting = mapProgram("firecrawl", plan([{ id: "firecrawl.startup-deal", provider: "firecrawl" }]));
    expect(waiting.kind === "unmapped" && waiting.message).toContain("firecrawl.startup-deal is kept but not marked approved. Mark it approved on your plan at https://programscape.com/plans");
  });

  it("follows the config override, only to a kept, approved program from that provider", () => {
    const programs = plan([
      ...FIRECRAWL_ONE,
      { id: "firecrawl.claude-startup-perks", provider: "firecrawl", approved: true },
      { id: "firecrawl.support", provider: "firecrawl" },
    ]);
    expect(mapProgram("firecrawl", programs, "firecrawl.claude-startup-perks")).toEqual({ kind: "mapped", programId: "firecrawl.claude-startup-perks", via: "config" });
    const missing = mapProgram("firecrawl", programs, "firecrawl.nope");
    expect(missing.kind === "unmapped" && missing.message).toContain("not a kept program on your plan");
    const other = mapProgram("firecrawl", programs, "aws.activate-founders");
    expect(other.kind === "unmapped" && other.message).toContain("not a Firecrawl program");
    const unapproved = mapProgram("firecrawl", programs, "firecrawl.support");
    expect(unapproved.kind === "unmapped" && unapproved.message).toContain("doesn't show as approved");
  });
});

describe("sync", () => {
  it("sends exactly programId, amount, unit, asOf and source for the live balance", async () => {
    const { fake, router } = await connected();
    const results = await router().syncBalances();
    expect(results).toEqual([
      { provider: "firecrawl", outcome: "synced", programId: "firecrawl.startup-deal", message: expect.stringContaining("Synced 1000 credits") },
    ]);
    const sent = reports(fake);
    expect(sent).toHaveLength(1);
    expect(Object.keys(sent[0] as object).sort()).toEqual(["amount", "asOf", "programId", "source", "unit"]);
    expect(sent[0]).toMatchObject({ programId: "firecrawl.startup-deal", amount: 1000, unit: "credits", source: "router" });
    expect(fake.toolCalls.every((call) => call.authorization === "Bearer ps-ACCESS-1-TOKENSECRET")).toBe(true);
  });

  it("reports several and none in the sync output and in status, and follows the config override", async () => {
    const kept: KeptProgram[] = [
      { id: "firecrawl.startup-deal", provider: "firecrawl", approved: true },
      { id: "firecrawl.claude-startup-perks", provider: "firecrawl", approved: true },
    ];
    const { fake, router } = await connected({ kept }, { FIRECRAWL_API_KEY: "fc-KEYSECRET-1", TAVILY_API_KEY: "tvly-KEYSECRET-2" });
    const results = await router().syncBalances();
    expect(results.map((result) => [result.provider, result.outcome])).toEqual([
      ["firecrawl", "unmapped"],
      ["tavily", "unmapped"],
    ]);
    expect(results[0]?.message).toContain("won't guess");
    expect(results[1]?.message).toContain("no kept, approved Tavily program");
    expect(reports(fake)).toHaveLength(0);

    const status = await router().status();
    expect(status.programscape.sync).toBe("on");
    expect(status.programscape.providers.map((entry) => entry.outcome)).toEqual(["unmapped", "unmapped"]);

    const overridden = await router({ providers: { firecrawl: { programscapeProgram: "firecrawl.claude-startup-perks" } } }).syncBalances();
    expect(overridden[0]).toMatchObject({ provider: "firecrawl", outcome: "synced", programId: "firecrawl.claude-startup-perks" });
    expect(reports(fake)).toEqual([expect.objectContaining({ programId: "firecrawl.claude-startup-perks" })]);
  });

  it("syncs only balances read live from a provider, never credits entered in config", async () => {
    const kept: KeptProgram[] = [
      { id: "firecrawl.startup-deal", provider: "firecrawl", approved: true },
      { id: "exa.startup-grant", provider: "exa", approved: true },
    ];
    const { fake, router } = await connected({ kept }, { FIRECRAWL_API_KEY: "fc-KEYSECRET-1", EXA_API_KEY: "exa-KEYSECRET-3" });
    const config: RouterConfig = {
      providers: {
        exa: { credits: [{ label: "Exa grant", remaining: 600, award: 1000, unit: "usd" }] },
        firecrawl: { credits: [{ label: "Firecrawl deal I typed in", remaining: 77777, unit: "credits" }] },
      },
    };
    const results = await router(config).syncBalances();
    expect(results.find((result) => result.provider === "exa")).toMatchObject({ outcome: "skipped" });
    expect(results.find((result) => result.provider === "exa")?.message).toContain("your own numbers, not a provider's reading");
    const sent = reports(fake);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ programId: "firecrawl.startup-deal", amount: 1000 });
    expect(sent[0]).toEqual({ programId: "firecrawl.startup-deal", amount: 1000, unit: "credits", asOf: expect.any(String), source: "router" });
    expect(fake.toolCalls.every((call) => !Object.hasOwn(call.arguments, "credits"))).toBe(true);
  });

  it("treats a later reading already on the plan as success with no change", async () => {
    const later = { amount: 900, unit: "credits", asOf: "2099-01-01T00:00:00.000Z", source: "founder" };
    const { fake, router } = await connected({ kept: [{ id: "firecrawl.startup-deal", provider: "firecrawl", approved: true, balance: later }] });
    const results = await router().syncBalances();
    expect(results[0]).toMatchObject({ provider: "firecrawl", outcome: "synced" });
    expect(results[0]?.message).toContain("Already current: your plan holds a later reading for firecrawl program firecrawl.startup-deal");
    expect(reports(fake)).toHaveLength(1);
  });

  it("shows Programscape's own words when it refuses a balance, and changes nothing", async () => {
    const { fake, env, fetch } = await connected();
    fake.behaviour.refuseReport = "The founder’s low-balance reminder for Firecrawl is in usd, and this balance is in credits. Report it in usd; nothing is converted. Nothing was changed.";
    const out: string[] = [];
    const code = await main(["sync"], { stdout: (t) => out.push(t), stderr: () => {} }, { env, config: {}, fetch, ledgerPath: false });
    expect(code).toBe(1);
    expect(out.join("")).toContain("firecrawl: Programscape refused it: The founder’s low-balance reminder for Firecrawl is in usd");
  });

  it("doesn't send an amount a plan can't record as reported, and never rounds it", async () => {
    const fake = fakeProgramscape({ kept: FIRECRAWL_ONE });
    const providers = mockFetch({ [URLS.firecrawlCredits]: ok({ success: true, data: { remainingCredits: 12.5, planCredits: 500 } }) });
    const fetch = combine(fake.fetch, providers.fetch);
    const env = { ...homes(), FIRECRAWL_API_KEY: "fc-KEYSECRET-1" };
    await connect({ env, fetch, now: () => START, print: () => {}, openBrowser: fake.browser });
    const results = await createRouter({ env, config: {}, fetch, ledgerPath: false, log: () => {} }).syncBalances();
    expect(results[0]).toMatchObject({ provider: "firecrawl", outcome: "failed" });
    expect(results[0]?.message).toContain("not a whole number of credits");
    // The plan is still read (for its dates), but no balance goes.
    expect(fake.toolCalls.map((call) => call.name)).toEqual(["my_plan"]);
  });

  it("never sends Bright Data's $0, manually or automatically, and says why; sends an amount above $0", async () => {
    const fake = fakeProgramscape({ kept: [{ id: "brightdata.free-tier", provider: "brightdata", approved: true }] });
    const balances = [
      ok({ balance: 0, credit: 0, prepayment: 0, pending_costs: 0 }),
      ok({ balance: 0, credit: 0, prepayment: 0, pending_costs: 0 }),
      ok({ balance: 2, credit: 0, prepayment: 0, pending_costs: 0 }),
    ];
    const providers = mockFetch({
      [URLS.brightdataBalance]: balances,
      [URLS.brightdataRequest]: ok(fixture("brightdata-search")),
    });
    const fetch = combine(fake.fetch, providers.fetch);
    const env = { ...homes(), BRIGHTDATA_API_KEY: "brd-KEYSECRET-8", BRIGHTDATA_SERP_ZONE: "programscape_serp", BRIGHTDATA_UNLOCKER_ZONE: "web_unlocker1" };
    await connect({ env, fetch, now: () => START, print: () => {}, openBrowser: fake.browser });

    // Automatic: the search's balance read is $0, so no sync is due at all.
    const auto = createRouter({ env, config: { programscape: { sync: "auto" } }, fetch, ledgerPath: false, log: () => {} });
    await auto.search({ query: "q" });
    await auto.flush();
    expect(reports(fake)).toHaveLength(0);

    // Manual: skipped, with the reason, and not a failure.
    const out: string[] = [];
    const code = await main(["sync"], { stdout: (t) => out.push(t), stderr: () => {} }, { env, config: {}, fetch, ledgerPath: false });
    expect(code).toBe(0);
    expect(out.join("")).toBe(
      'brightdata: Not synced. Bright Data reported 0 usd for "Bright Data paid balance", which leaves out free credits it doesn\'t report, so it isn\'t sent to your plan.\n',
    );
    expect(reports(fake)).toHaveLength(0);

    // Above $0, it goes like any live balance.
    const results = await createRouter({ env, config: {}, fetch, ledgerPath: false, log: () => {} }).syncBalances();
    expect(results[0]).toMatchObject({ provider: "brightdata", outcome: "synced", programId: "brightdata.free-tier" });
    expect(reports(fake)).toEqual([{ programId: "brightdata.free-tier", amount: 2, unit: "usd", asOf: expect.any(String), source: "router" }]);
  });

  it("refreshes an expired token, storing the rotated refresh token", async () => {
    const { fake, env, router, advance } = await connected();
    advance(61 * 60_000);
    await router().syncBalances();
    const refreshes = fake.tokenRequests.filter((form) => form.get("grant_type") === "refresh_token");
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0]?.get("refresh_token")).toBe("ps-REFRESH-1-TOKENSECRET");
    expect(refreshes[0]?.get("client_id")).toBe("client-1");
    expect(await readTokenFile(env)).toMatchObject({ accessToken: "ps-ACCESS-2-TOKENSECRET", refreshToken: "ps-REFRESH-2-TOKENSECRET" });
    expect(reports(fake)).toHaveLength(1);
    expect(fake.toolCalls.at(-1)?.authorization).toBe("Bearer ps-ACCESS-2-TOKENSECRET");
  });

  it("refreshes and retries once when Programscape answers 401", async () => {
    const { fake, router } = await connected();
    fake.access.clear(); // revoked server-side before it expired
    const results = await router().syncBalances();
    expect(results[0]?.outcome).toBe("synced");
    expect(fake.tokenRequests.filter((form) => form.get("grant_type") === "refresh_token")).toHaveLength(1);
  });

  it("does not let disconnect report success while a token rotation is in flight", async () => {
    const { fake, env, fetch } = await connected();
    let release!: () => void;
    let entered!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const slowFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (new URL(String(input)).pathname === "/api/oauth/token" && String(init?.body).includes("grant_type=refresh_token")) {
        entered();
        await hold;
      }
      return response;
    };
    const connection = new Connection({
      env,
      fetch: programscapeFetch(slowFetch, 15_000),
      now: () => new Date(START.getTime() + 61 * 60_000),
    });
    const active = connection.session((call) => call("my_plan", {}));
    await started;
    try {
      await expect(disconnect({ env, fetch })).rejects.toThrow("Another Programscape connection change is running");
    } finally {
      release();
    }
    await active;
    expect((await readTokenFile(env))?.refreshToken).toBe("ps-REFRESH-2-TOKENSECRET");
    const result = await disconnect({ env, fetch });
    expect(result).toMatchObject({ outcome: "disconnected", local: { gone: true } });
    expect(fake.refresh.size).toBe(0);
  });

  it("reports remote cleanup when a rotated pair cannot be saved or revoked", async () => {
    const { fake, env, fetch } = await connected();
    const originalConfig = env.XDG_CONFIG_HOME;
    const blocked = join(dirname(originalConfig), "blocked-rotation-root");
    writeFileSync(blocked, "not a directory");
    fake.behaviour.revokeFails = true;
    fakeKeyring.failing.set = "save refused";
    const riskyFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      const path = new URL(String(input)).pathname;
      if (path === "/api/oauth/token" && String(init?.body).includes("grant_type=refresh_token")) env.XDG_CONFIG_HOME = blocked;
      if (path === "/api/oauth/revoke") env.XDG_CONFIG_HOME = originalConfig;
      return response;
    };
    const connection = new Connection({
      env,
      fetch: programscapeFetch(riskyFetch, 15_000),
      now: () => new Date(START.getTime() + 61 * 60_000),
    });
    const error = await connection.session((call) => call("my_plan", {})).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ProgramscapeError);
    expect((error as Error).message).toContain("check Apps connected to your plan on programscape.com");
    expect((error as Error).message).not.toContain("TOKENSECRET");
    expect(fake.refresh.has("ps-REFRESH-2-TOKENSECRET")).toBe(true);
    expect((await readConnectionState(env))?.phase).toBe("cleanup-needed");
    fake.behaviour.revokeFails = false;
    const disconnected = await disconnect({ env, fetch });
    expect(disconnected).toMatchObject({ outcome: "remote-unverified" });
    expect(fake.refresh.has("ps-REFRESH-2-TOKENSECRET")).toBe(true);
  });

  it("keeps an uncertain grant marker when a refresh response is lost", async () => {
    const { fake, env, fetch } = await connected();
    const lostResponse: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (new URL(String(input)).pathname === "/api/oauth/token" && String(init?.body).includes("grant_type=refresh_token")) {
        throw new Error("response lost");
      }
      return response;
    };
    const connection = new Connection({
      env,
      fetch: programscapeFetch(lostResponse, 15_000),
      now: () => new Date(START.getTime() + 61 * 60_000),
    });
    await expect(connection.session((call) => call("my_plan", {}))).rejects.toThrow("programscape-router disconnect");
    expect((await readConnectionState(env))?.phase).toBe("cleanup-needed");
    const disconnected = await disconnect({ env, fetch });
    expect(disconnected).toMatchObject({ outcome: "remote-unverified" });
    expect(fake.refresh.has("ps-REFRESH-2-TOKENSECRET")).toBe(true);
  });

  it("does not sync while a saved token still has an uncertain grant marker", async () => {
    const { fake, env, router } = await connected();
    const marker = await readConnectionState(env);
    expect(marker).toBeDefined();
    await writeConnectionState(env, { ...marker!, phase: "cleanup-needed" });
    expect((await router().status()).programscape.sync).toBe("off");
    await expect(router().syncBalances()).rejects.toThrow("programscape.com");
    expect(fake.toolCalls).toHaveLength(0);
  });

  it("turns itself off when the refresh is refused, and requires disconnect before connect", async () => {
    const { fake, env, router, advance } = await connected();
    fake.behaviour.failRefresh = true;
    advance(61 * 60_000);
    const error = await router().syncBalances().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProgramscapeError);
    expect((error as Error).message).toContain("Run `programscape-router disconnect`, then `programscape-router connect`");
    expect((error as Error).message).not.toContain("TOKENSECRET");
    expect(existsSync(tokenPath(env))).toBe(false);
    const status = await router().status();
    expect(status.programscape).toMatchObject({ sync: "off", note: expect.stringContaining("connect") });

    const out: string[] = [];
    await main(["status"], { stdout: (t) => out.push(t), stderr: () => {} }, { env, config: {}, fetch: fake.fetch, ledgerPath: false });
    expect(out.join("")).toContain("Programscape sync: off. Programscape sync is off");
    const requestsBefore = fake.seen.length;
    const blocked: string[] = [];
    expect(await main(["connect"], { stdout: () => {}, stderr: (line) => blocked.push(line) }, { env, config: {}, fetch: fake.fetch, ledgerPath: false, openBrowser: fake.browser })).toBe(1);
    expect(blocked.join("")).toContain("disconnect` before connecting again");
    expect(fake.seen).toHaveLength(requestsBefore);
  });

  it("keeps sync off in the connection marker if the state directory becomes unwritable", async () => {
    const { fake, env, router, advance } = await connected();
    const blocked = join(dirname(env.XDG_STATE_HOME), "blocked-state-root");
    writeFileSync(blocked, "not a directory");
    env.XDG_STATE_HOME = blocked;
    fake.behaviour.failRefresh = true;
    advance(61 * 60_000);
    await expect(router().syncBalances()).rejects.toThrow("connect");
    expect((await readConnectionState(env))?.phase).toBe("sync-off");
    const attempts = fake.tokenRequests.length;
    await expect(router().syncBalances()).rejects.toThrow("connect");
    expect(fake.tokenRequests).toHaveLength(attempts);
    expect((await router().status()).programscape.sync).toBe("off");
  });

  it("allows an existing router process to sync after a successful external disconnect and reconnect", async () => {
    const { fake, env, fetch, router, advance } = await connected();
    const running = router();
    fake.behaviour.failRefresh = true;
    advance(61 * 60_000);
    await expect(running.syncBalances()).rejects.toThrow("connect");
    expect((await disconnect({ env, fetch })).outcome).toBe("disconnected");
    fake.behaviour.failRefresh = false;
    await connect({ env, fetch, now: () => new Date(START.getTime() + 61 * 60_000), print: () => {}, openBrowser: fake.browser });
    expect((await running.syncBalances())[0]?.outcome).toBe("synced");
  });

  it("shows on with the last sync in status, and off before connect", async () => {
    const { env, fetch, router } = await connected();
    const before = await router().status();
    expect(before.programscape).toMatchObject({ sync: "on", mode: "manual" });
    expect(before.programscape.lastSyncedAt).toBeUndefined();
    await router().syncBalances();
    const out: string[] = [];
    await main(["status"], { stdout: (t) => out.push(t), stderr: () => {} }, { env, config: {}, fetch, ledgerPath: false });
    expect(out.join("")).toContain("Programscape sync: on (last synced 2026-10-11T12:00:00.000Z; manual");
    expect(out.join("")).toContain("firecrawl: Synced 1000 credits");

    // A machine that never connected: no token in its keychain either (the keychain is per user, not per folder).
    fakeKeyring.reset();
    const fresh: string[] = [];
    await main(["status"], { stdout: (t) => fresh.push(t), stderr: () => {} }, { env: homes(), config: {}, ledgerPath: false });
    expect(fresh.join("")).toContain("Programscape sync: off (run `programscape-router connect` to turn it on)");
  });
});

describe("automatic sync", () => {
  it("is off unless config says auto", async () => {
    const { fake, router } = await connected();
    const r = router();
    await r.search({ query: "q" });
    await r.flush();
    expect(reports(fake)).toHaveLength(0);
  });

  it("runs after a balance read, at most once per provider every six hours", async () => {
    const { fake, router, advance } = await connected();
    const r = router({ programscape: { sync: "auto" } });
    await r.search({ query: "q" });
    await r.flush();
    expect(reports(fake)).toHaveLength(1);

    advance(60 * 60_000); // past the balance cache, so the balance is read again
    await r.search({ query: "q" });
    await r.flush();
    expect(reports(fake)).toHaveLength(1);

    // A new process an hour later still waits: the six hours are kept on disk.
    const later = router({ programscape: { sync: "auto" } });
    await later.status({ refresh: true });
    await later.flush(); // its background sync settles before the clock moves on
    expect(reports(fake)).toHaveLength(1);

    advance(AUTO_SYNC_INTERVAL_MS);
    await r.search({ query: "q" });
    await r.flush();
    expect(reports(fake)).toHaveLength(2);
  });

  it("never holds up or breaks a search when Programscape hangs or fails, and logs once without tokens", async () => {
    const { fake, env, logs, router } = await connected();
    fake.behaviour.mcpHangs = true;
    const r = router({ programscape: { sync: "auto" } });
    const started = Date.now();
    const response = await r.search({ query: "q" });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(response.routing.provider).toBe("firecrawl");
    expect(response.results.length).toBeGreaterThan(0);
    await r.flush();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("Programscape sync for firecrawl failed");
    expect(logs[0]).toContain("Searches and scrapes are unaffected");
    for (const line of logs) {
      expect(line).not.toContain("TOKENSECRET");
      expect(line).not.toContain("KEYSECRET");
    }
    const state = await readSyncState(env);
    expect(state.providers.firecrawl?.outcome).toBe("failed");

  }, 20_000);

  it("keeps searching when Programscape answers with an error", async () => {
    const { fake, logs, router } = await connected();
    fake.behaviour.mcpStatus = 500;
    const r = router({ programscape: { sync: "auto" } });
    expect((await r.search({ query: "q" })).routing.provider).toBe("firecrawl");
    await r.flush();
    expect(logs).toEqual([expect.stringContaining("Programscape's MCP endpoint answered HTTP 500")]);
    expect(reports(fake)).toHaveLength(0);
  });
});

describe("disconnect", () => {
  it("revokes both tokens at the revocation endpoint and deletes the file", async () => {
    const { fake, env, fetch } = await connected();
    const result = await disconnect({ env, fetch });
    expect(result).toEqual({ outcome: "disconnected", knownGrants: 1, local: { keychain: "deleted", file: "absent", gone: true } });
    expect(fakeKeyring.peek(KEYCHAIN_SERVICE, TOKEN_KEYCHAIN_ACCOUNT)).toBeUndefined();
    expect(fake.revocations.map((form) => [form.get("token"), form.get("token_type_hint"), form.get("client_id")]).sort()).toEqual([
      ["ps-ACCESS-1-TOKENSECRET", "access_token", "client-1"],
      ["ps-REFRESH-1-TOKENSECRET", "refresh_token", "client-1"],
    ]);
    expect(existsSync(tokenPath(env))).toBe(false);
    const out: string[] = [];
    expect(await main(["disconnect"], { stdout: (t) => out.push(t), stderr: () => {} }, { env, fetch })).toBe(0);
    expect(out.join("")).toContain("was not connected");
  });
});

describe("sync command", () => {
  it("prints per-provider lines and says to connect first when off", async () => {
    const { env, fetch } = await connected();
    const out: string[] = [];
    expect(await main(["sync"], { stdout: (t) => out.push(t), stderr: () => {} }, { env, config: {}, fetch, ledgerPath: false })).toBe(0);
    expect(out.join("")).toContain("firecrawl: Synced 1000 credits");

    fakeKeyring.reset(); // a machine that never connected
    const err: string[] = [];
    expect(await main(["sync"], { stdout: () => {}, stderr: (t) => err.push(t) }, { env: homes(), config: {}, fetch, ledgerPath: false })).toBe(1);
    expect(err.join("")).toContain("Run `programscape-router connect` first");
  });
});
