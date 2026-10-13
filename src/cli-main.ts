import { catalogEnabled, formatPrograms, readPrograms, short, shortLines } from "./catalog.js";
import { formatCheck, runCheck } from "./check.js";
import { type KeysOptions, runKeys } from "./cli-keys.js";
import { ConfigError, type RouterConfig, loadConfig } from "./config.js";
import { formatStatus } from "./format.js";
import { type KeyringLoader, type ResolvedKeys, resolveKeys } from "./keys.js";
import { defaultNoticesPath, introduced, markIntroduced } from "./notices.js";
import { type ConnectOptions, connect, disconnect } from "./programscape/connect.js";
import { PROGRAMSCAPE_ORIGIN, ProgramscapeError } from "./programscape/guard.js";
import { runMcpServer } from "./mcp.js";
import { type Router, RouterError, type RouterOptions, createRouter } from "./router.js";
import { PROVIDER_IDS, type ProviderId, type Routing } from "./types.js";
import { VERSION } from "./version.js";

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export interface CliOptions extends RouterOptions {
  /** How `connect` opens the browser. Defaults to the system browser. */
  openBrowser?: ConnectOptions["openBrowser"];
  /** How long `connect` waits for the browser. */
  connectWaitMs?: number;
  /** Loads the native keychain module. Tests replace it. */
  keyringLoader?: KeyringLoader;
  /** The terminal `keys set` reads from. Defaults to process.stdin. */
  stdin?: KeysOptions["stdin"];
  /** Where `keys set` shows its prompt. Defaults to process.stderr. */
  promptOutput?: KeysOptions["promptOutput"];
  platform?: NodeJS.Platform;
}

const USAGE = `programscape-router ${VERSION}
Routes web search and scrape calls across your own provider keys, spending the credits that end first.

Usage:
  programscape-router [mcp]                      Run the MCP server on stdio (default)
  programscape-router check [--json] [--verbose] One live search, scrape and balance read per key set
  programscape-router keys set <provider> [--stdin]  Store a key in the OS keychain, asked for at a hidden prompt
                                                 (brightdata also sets up its zones; --search-zone, --scrape-zone)
  programscape-router keys list [--json]         Which keys are set and where from (never the keys)
  programscape-router keys remove <provider>     Delete a stored key from the OS keychain
  programscape-router status [--json] [--refresh]
  programscape-router programs [--json]          Programs that can add more for the providers you have keys for
  programscape-router search "<query>" [--max N] [--json]
  programscape-router scrape <url> [--json]
  programscape-router connect [--no-browser]     Opt in: sync balance numbers to your Programscape plan (disconnect first to reconnect)
  programscape-router sync [--json]              Send live balances to your plan now
  programscape-router disconnect                 Revoke the connection and remove local tokens
  programscape-router --help | --version

Keys are read from BRIGHTDATA_API_KEY, EXA_API_KEY, FIRECRAWL_API_KEY, KEENABLE_API_KEY, LINKUP_API_KEY,
PARALLEL_API_KEY, TAVILY_API_KEY and YDC_API_KEY, or, when a variable isn't set, from the OS keychain (see keys
set). A variable wins over the keychain. Bright Data's zones are in config (keys set brightdata saves them), or in
BRIGHTDATA_SERP_ZONE and BRIGHTDATA_UNLOCKER_ZONE.
Providers: brightdata, exa, firecrawl, keenable, linkup, parallel, tavily, youcom.
Find startup credits for these tools at https://programscape.com
Without connect, the only call to Programscape is a read of its public catalog (which providers have a key set, at
most once a day; "programscape": { "catalog": false } in config or PROGRAMSCAPE_ROUTER_CATALOG=off turns it off).
After connect: sign-in, a read of your plan, and balance numbers with a runway estimate.
`;

function formatRouting(routing: Routing): string {
  const tried = routing.tried
    .map((attempt) => `${attempt.provider}: ${attempt.outcome}${attempt.status ? ` (HTTP ${attempt.status})` : ""}`)
    .join(", ");
  return `Served by ${routing.provider}. ${routing.reason}\nTried: ${tried}`;
}

function takeFlag(args: string[], flag: string): boolean {
  const index = args.indexOf(flag);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}

function takeValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
}

async function runConnect(args: string[], io: CliIo, options: CliOptions): Promise<number> {
  const env = options.env ?? process.env;
  const noBrowser = takeFlag(args, "--no-browser");
  try {
    const result = await connect({
      env,
      fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
      now: options.now ?? (() => new Date()),
      print: (line) => io.stdout(`${line}\n`),
      ...(noBrowser ? { openBrowser: false as const } : options.openBrowser !== undefined ? { openBrowser: options.openBrowser } : {}),
      ...(options.connectWaitMs !== undefined ? { waitMs: options.connectWaitMs } : {}),
    });
    io.stdout(
      result.stored.kind === "keychain"
        ? `Connected to Programscape. The sign-in token is stored in ${result.stored.label}.\n`
        : `Connected to Programscape. The sign-in token is stored at ${result.stored.path} (${
            process.platform === "win32"
              ? "the keychain could not store it; the file is protected by your Windows profile folder's default permissions"
              : "the keychain could not store it; the file is readable only by you"
          }).\n`,
    );
    const config = options.config ?? loadConfig(env, options.cwd).config;
    io.stdout(
      config.programscape?.sync === "auto"
        ? "Balances will sync automatically after a balance read, at most once per provider every 6 hours.\n"
        : 'Run `programscape-router sync` to send balances now, or set "programscape": { "sync": "auto" } in config to sync automatically.\n',
    );
    return 0;
  } catch (error) {
    if (error instanceof ProgramscapeError) {
      io.stderr(`Not connected: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

const KEYED_COMMANDS = new Set(["mcp", "status", "search", "scrape", "sync"]);

/** The config, or undefined when it can't be read: the catalog then stays off, since an opt-out can't be ruled out. */
function configOrUndefined(env: NodeJS.ProcessEnv, options: CliOptions): RouterConfig | undefined {
  try {
    return options.config ?? loadConfig(env, options.cwd).config;
  } catch (error) {
    if (error instanceof ConfigError) return undefined;
    throw error;
  }
}

const keyed = (keys: ResolvedKeys): ProviderId[] => PROVIDER_IDS.filter((id) => (keys.keys[id]?.trim() ?? "").length > 0);

/** After the first `keys set` that stores a key: the programs that can add more, once ever (0151 ruling 1). */
async function introducePrograms(io: CliIo, options: CliOptions, env: NodeJS.ProcessEnv, keys: () => Promise<ResolvedKeys>): Promise<void> {
  try {
    const path = defaultNoticesPath(env);
    if (await introduced(path)) return;
    const config = configOrUndefined(env, options);
    if (!config || !catalogEnabled(env, config)) return;
    const now = options.now ?? (() => new Date());
    const catalog = await readPrograms(
      { env, config, fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)), now },
      keyed(await keys()),
    );
    if (!catalog) return;
    io.stdout(`\n${shortLines(catalog.providers.map(short)).join("\n")}\n`);
    await markIntroduced(path, now());
  } catch {
    // Saying nothing is always fine here.
  }
}

async function runPrograms(args: string[], io: CliIo, options: CliOptions, env: NodeJS.ProcessEnv, keys: () => Promise<ResolvedKeys>): Promise<number> {
  const json = takeFlag(args, "--json");
  let config: RouterConfig;
  try {
    config = options.config ?? loadConfig(env, options.cwd).config;
  } catch (error) {
    if (error instanceof ConfigError) {
      io.stderr(`${error.message}\n`);
      return 2;
    }
    throw error;
  }
  const say = (code: number, note: string, providers: unknown[] = []) => {
    io.stdout(json ? `${JSON.stringify({ providers, note }, null, 2)}\n` : `${note}\n`);
    return code;
  };
  if (!catalogEnabled(env, config)) {
    return say(0, 'The programs list is off ("programscape": { "catalog": false } in config, or PROGRAMSCAPE_ROUTER_CATALOG=off), so the router reads nothing from Programscape. Browse https://programscape.com instead.');
  }
  const ids = keyed(await keys());
  if (ids.length === 0) {
    return say(1, "No provider key is set, so there is nothing to look up. Set one with `programscape-router keys set <provider>`, or browse https://programscape.com.");
  }
  const catalog = await readPrograms({ env, config, fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)), now: options.now ?? (() => new Date()) }, ids);
  if (!catalog) {
    const links = ids.map((id) => `  ${id}: ${PROGRAMSCAPE_ORIGIN}/extend/${id}`).join("\n");
    return say(1, `Couldn't read Programscape's public catalog just now (the router tries at most once a day). Each provider's page:\n${links}`);
  }
  io.stdout(json ? `${JSON.stringify(catalog, null, 2)}\n` : `${formatPrograms(catalog.providers, catalog.asOf || undefined)}\n`);
  return 0;
}

/** Runs one CLI command. Returns the exit code; "mcp" resolves once the server is connected. */
export async function main(argv: string[], io: CliIo, options: CliOptions = {}): Promise<number> {
  const args = [...argv];
  const command = args.shift() ?? "mcp";

  if (command === "--help" || command === "-h" || command === "help") {
    io.stdout(USAGE);
    return 0;
  }
  if (command === "--version" || command === "-v") {
    io.stdout(`${VERSION}\n`);
    return 0;
  }

  const env = options.env ?? process.env;
  const keychainOptions = {
    env,
    ...(options.keyringLoader ? { loader: options.keyringLoader } : {}),
    ...(options.platform ? { platform: options.platform } : {}),
  };

  const keys = () => (options.keys ? Promise.resolve(options.keys) : resolveKeys(keychainOptions));

  if (command === "keys") {
    const code = await runKeys(args, io, {
      env,
      ...(options.stdin ? { stdin: options.stdin } : {}),
      ...(options.promptOutput ? { promptOutput: options.promptOutput } : {}),
      ...(options.keyringLoader ? { keyringLoader: options.keyringLoader } : {}),
      ...(options.platform ? { platform: options.platform } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.cwd ? { cwd: options.cwd } : {}),
    });
    if (code === 0 && args[0] === "set") await introducePrograms(io, options, env, keys);
    return code;
  }

  if (command === "programs") return runPrograms(args, io, options, env, keys);

  if (command === "check") {
    // Calls each adapter directly: no routing, no ledger. The config is read only for the catalog switch, and a config
    // that can't be read leaves the catalog off rather than stopping the check.
    const json = takeFlag(args, "--json");
    const verbose = takeFlag(args, "--verbose");
    const config = configOrUndefined(env, options);
    const report = await runCheck({
      env,
      verbose,
      keys: await keys(),
      ...(config ? { config } : { catalogPath: false as const }),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.readingsPath !== undefined ? { readingsPath: options.readingsPath } : {}),
      ...(options.catalogPath !== undefined && config ? { catalogPath: options.catalogPath } : {}),
    });
    io.stdout(json ? `${JSON.stringify(report, null, 2)}\n` : `${formatCheck(report)}\n`);
    return report.ok ? 0 : 1;
  }

  if (command === "disconnect") {
    const result = await disconnect({ env, fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)) });
    const { local } = result;
    if (result.outcome === "nothing-to-do") {
      io.stdout("Programscape sync was not connected. Nothing to do.\n");
      return 0;
    }
    const words = { deleted: "deleted", absent: "none there", failed: "COULD NOT DELETE", unavailable: "COULD NOT CHECK" } as const;
    io.stdout(
      [
        "Disconnect from Programscape:",
        `  Programscape: ${result.outcome === "disconnected" ? "revoked the known router tokens" : "remote access not fully verified"}`,
        `  OS keychain: ${words[local.keychain]}`,
        `  token file: ${words[local.file]}`,
        "",
      ].join("\n"),
    );
    if (result.outcome === "local-incomplete") {
      io.stderr(`Could not verify local token removal. Unlock or repair the reported store, then rerun \`programscape-router disconnect\`:\n${(local.manual ?? []).map((line) => `  ${line}`).join("\n")}\n`);
      io.stderr("Check Apps connected to your plan on programscape.com (My plans) for any router access as well.\n");
      return 1;
    }
    if (result.outcome === "remote-unverified") {
      io.stdout("Local connection cleared; remote access was not verified. You can connect again.\n");
      io.stderr("Check Apps connected to your plan on programscape.com (My plans) and remove programscape-router if it is listed.\n");
      return 2;
    }
    io.stdout("Disconnected: local tokens removed and known Programscape tokens revoked.\n");
    return 0;
  }

  const {
    openBrowser: _openBrowser,
    connectWaitMs: _connectWaitMs,
    keyringLoader: _keyringLoader,
    stdin: _stdin,
    promptOutput: _promptOutput,
    platform: _platform,
    ...routerOptions
  } = options;
  let router: Router;
  try {
    if (command === "connect") {
      // Validate the config before starting a sign-in.
      if (!options.config) loadConfig(env, options.cwd);
      return await runConnect(args, io, options);
    }
    if (!KEYED_COMMANDS.has(command)) {
      io.stderr(`Unknown command "${command}".\n\n${USAGE}`);
      return 2;
    }
    // Keys are read once, at startup: each environment variable, or the OS keychain where one isn't set.
    router = createRouter({ log: (message) => io.stderr(`programscape-router: ${message}\n`), ...routerOptions, keys: await keys() });
  } catch (error) {
    if (error instanceof ConfigError) {
      io.stderr(`${error.message}\n`);
      return 2;
    }
    throw error;
  }

  try {
    switch (command) {
      case "mcp": {
        await runMcpServer(router);
        return 0;
      }
      case "status": {
        const json = takeFlag(args, "--json");
        const refresh = takeFlag(args, "--refresh");
        const status = await router.status({ refresh });
        io.stdout(json ? `${JSON.stringify(status, null, 2)}\n` : `${formatStatus(status)}\n`);
        return 0;
      }
      case "search": {
        const json = takeFlag(args, "--json");
        const max = takeValue(args, "--max");
        const query = args.join(" ");
        const maxResults = max === undefined ? undefined : Number(max);
        const response = await router.search({ query, ...(maxResults !== undefined ? { maxResults } : {}) });
        if (json) {
          io.stdout(`${JSON.stringify(response, null, 2)}\n`);
        } else {
          response.results.forEach((result, index) => {
            io.stdout(`${index + 1}. ${result.title}\n   ${result.url}\n${result.snippet ? `   ${result.snippet}\n` : ""}`);
          });
          io.stderr(`${formatRouting(response.routing)}\n`);
        }
        return 0;
      }
      case "scrape": {
        const json = takeFlag(args, "--json");
        const url = args[0] ?? "";
        const response = await router.scrape({ url });
        if (json) io.stdout(`${JSON.stringify(response, null, 2)}\n`);
        else {
          io.stdout(`${response.result.markdown}\n`);
          io.stderr(`${formatRouting(response.routing)}\n`);
        }
        return 0;
      }
      case "sync": {
        const json = takeFlag(args, "--json");
        try {
          const results = await router.syncBalances();
          if (json) io.stdout(`${JSON.stringify(results, null, 2)}\n`);
          else if (results.length === 0) io.stdout("No provider key is set, so there is no balance to sync.\n");
          else for (const result of results) io.stdout(`${result.provider}: ${result.message}\n`);
          return results.some((result) => result.outcome === "failed" || result.outcome === "refused") ? 1 : 0;
        } catch (error) {
          if (error instanceof ProgramscapeError) {
            io.stderr(`${error.message}\n`);
            return 1;
          }
          throw error;
        }
      }
      default:
        io.stderr(`Unknown command "${command}".\n\n${USAGE}`);
        return 2;
    }
  } catch (error) {
    if (error instanceof RouterError) {
      io.stderr(`${error.message}\n`);
      for (const attempt of error.routing?.tried ?? []) {
        io.stderr(`  ${attempt.provider}: ${attempt.outcome}${attempt.status ? ` (HTTP ${attempt.status})` : ""}${attempt.message ? `: ${attempt.message}` : ""}\n`);
      }
      return 1;
    }
    throw error;
  } finally {
    if (command !== "mcp") await router.flush();
  }
}
