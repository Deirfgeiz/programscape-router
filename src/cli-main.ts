import { ConfigError } from "./config.js";
import { formatStatus } from "./format.js";
import { runMcpServer } from "./mcp.js";
import { type Router, RouterError, type RouterOptions, createRouter } from "./router.js";
import type { Routing } from "./types.js";
import { VERSION } from "./version.js";

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const USAGE = `programscape-router ${VERSION}
Routes web search and scrape calls across your own provider keys, spending the credits that end first.

Usage:
  programscape-router [mcp]                      Run the MCP server on stdio (default)
  programscape-router status [--json] [--refresh]
  programscape-router search "<query>" [--max N] [--json]
  programscape-router scrape <url> [--json]
  programscape-router --help | --version

Keys are read from EXA_API_KEY, FIRECRAWL_API_KEY, KEENABLE_API_KEY, PARALLEL_API_KEY and TAVILY_API_KEY.
Find startup credits for these tools at https://programscape.com
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

/** Runs one CLI command. Returns the exit code; "mcp" resolves once the server is connected. */
export async function main(argv: string[], io: CliIo, options: RouterOptions = {}): Promise<number> {
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

  let router: Router;
  try {
    router = createRouter({ log: (message) => io.stderr(`programscape-router: ${message}\n`), ...options });
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
