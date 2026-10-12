import { formatCheck, runCheck } from "./check.js";
import { type KeysOptions, runKeys } from "./cli-keys.js";
import { ConfigError, loadConfig } from "./config.js";
import { formatStatus } from "./format.js";
import { type KeyringLoader, resolveKeys } from "./keys.js";
import { type ConnectOptions, connect, disconnect } from "./programscape/connect.js";
import { ProgramscapeError } from "./programscape/guard.js";
import { runMcpServer } from "./mcp.js";
import { type Router, RouterError, type RouterOptions, createRouter } from "./router.js";
import type { Routing } from "./types.js";
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
  programscape-router keys list [--json]         Which keys are set and where from (never the keys)
  programscape-router keys remove <provider>     Delete a stored key from the OS keychain
  programscape-router status [--json] [--refresh]
  programscape-router search "<query>" [--max N] [--json]
  programscape-router scrape <url> [--json]
  programscape-router connect [--no-browser]     Opt in: sync balance numbers to your Programscape plan
  programscape-router sync [--json]              Send live balances to your plan now
  programscape-router disconnect                 Revoke the connection and remove local tokens
  programscape-router --help | --version

Keys are read from EXA_API_KEY, FIRECRAWL_API_KEY, KEENABLE_API_KEY, PARALLEL_API_KEY and TAVILY_API_KEY,
or, when a variable isn't set, from the OS keychain (see keys set). A variable wins over the keychain.
Providers: exa, firecrawl, keenable, parallel, tavily.
Find startup credits for these tools at https://programscape.com
Nothing goes to Programscape unless you run connect; then only sign-in, a read of your plan, and balance numbers.
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
              ? "no keychain was available; the file is protected by your Windows profile folder's default permissions"
              : "no keychain was available; the file is readable only by you"
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

  if (command === "keys") {
    return runKeys(args, io, {
      env,
      ...(options.stdin ? { stdin: options.stdin } : {}),
      ...(options.promptOutput ? { promptOutput: options.promptOutput } : {}),
      ...(options.keyringLoader ? { keyringLoader: options.keyringLoader } : {}),
      ...(options.platform ? { platform: options.platform } : {}),
    });
  }

  if (command === "check") {
    // Calls each adapter directly: no config, no routing, no ledger, no Programscape.
    const json = takeFlag(args, "--json");
    const verbose = takeFlag(args, "--verbose");
    const report = await runCheck({
      env,
      verbose,
      keys: options.keys ?? (await resolveKeys(keychainOptions)),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
    io.stdout(json ? `${JSON.stringify(report, null, 2)}\n` : `${formatCheck(report)}\n`);
    return report.ok ? 0 : 1;
  }

  if (command === "disconnect") {
    const result = await disconnect({ env, fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)) });
    const { local } = result;
    if (!result.wasConnected && result.tokenReadVerified && local.gone) {
      io.stdout("Programscape sync was not connected. Nothing to do.\n");
      return 0;
    }
    const words = { deleted: "deleted", absent: "none there", failed: "COULD NOT DELETE", unavailable: "COULD NOT CHECK" } as const;
    io.stdout(
      [
        "Disconnect from Programscape:",
        `  Programscape: ${result.revoked ? "revoked the router's access" : "could not confirm the revocation"}`,
        `  OS keychain: ${words[local.keychain]}`,
        `  token file: ${words[local.file]}`,
        "",
      ].join("\n"),
    );
    if (!local.gone) {
      io.stderr(`Could not verify that every local sign-in token was removed. Check these stores and remove any remaining entry by hand:\n${(local.manual ?? []).map((line) => `  ${line}`).join("\n")}\n`);
    }
    if (!result.automaticSyncDisabled) {
      io.stderr("Could not turn off automatic balance sync in local state. Stop any running router and remove its local sign-in tokens.\n");
    }
    if (!result.revoked && (result.wasConnected || !result.tokenReadVerified || !local.gone)) {
      io.stderr("Programscape did not confirm the revocation: check and remove the router's access on programscape.com as well.\n");
    }
    if (result.tokenReadVerified && local.gone && (result.revoked || !result.wasConnected)) {
      io.stdout("Disconnected: no token is left on this machine, and Programscape revoked it.\n");
      return 0;
    }
    return 1;
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
    const keys = options.keys ?? (await resolveKeys(keychainOptions));
    router = createRouter({ log: (message) => io.stderr(`programscape-router: ${message}\n`), ...routerOptions, keys });
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
