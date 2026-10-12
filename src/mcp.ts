import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { type Router, RouterError } from "./router.js";
import { VERSION } from "./version.js";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function ok(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function fail(error: unknown, notice?: string): ToolResult {
  if (error instanceof RouterError) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: error.code, message: error.message, routing: error.routing, ...(notice ? { notice } : {}) }, null, 2),
        },
      ],
    };
  }
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: "internal", message: "Unexpected error" }) }] };
}

/** Today's heads-ups, if any are due. A problem working them out never fails the call. */
async function notice(router: Router): Promise<{ notice?: string }> {
  const words = await router.headsUpNotice().catch(() => undefined);
  return words ? { notice: words } : {};
}

const NOTICE =
  "The result may also carry `notice`: a heads-up, at most once a day per provider, when a provider's credits are estimated to run out within the founder's threshold (30 days by default) " +
  "or an end date they gave is near, with programs from Programscape's public catalog that can add more and a link. Pass it on to the founder as it is: the estimate is labelled as one, and the provider decides who qualifies.";

/** An MCP server with the search, scrape and credits_status tools, backed by `router`. Not yet connected. */
export function createMcpServer(router: Router): McpServer {
  const server = new McpServer({ name: "programscape-router", version: VERSION });

  server.registerTool(
    "search",
    {
      title: "Web search",
      description:
        "Search the web through one of the founder's own search providers (Exa, Firecrawl, Keenable, Linkup, Parallel, Tavily or You.com, whichever keys are set). " +
        "Returns JSON: `results` as a list of { title, url, snippet?, publishedAt? }, and `routing` { provider, reason, rule, tried[] } saying which provider served it, " +
        "why it was chosen (the founder's order, or by default the credits that end first), and every provider tried with its outcome. " +
        "If a provider's credits are spent, rate limited or down, the next provider is tried automatically. " +
        NOTICE,
      inputSchema: {
        query: z.string().min(1).describe("What to search for."),
        maxResults: z.number().int().min(1).max(100).optional().describe("Upper bound on results (default 10). Each provider's own maximum still applies."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, maxResults }) => {
      try {
        const response = await router.search({ query, ...(maxResults !== undefined ? { maxResults } : {}) });
        return ok({ ...response, ...(await notice(router)) });
      } catch (error) {
        return fail(error, (await notice(router)).notice);
      }
    },
  );

  server.registerTool(
    "scrape",
    {
      title: "Scrape a page",
      description:
        "Fetch one web page as markdown through one of the founder's own scrape providers (Exa contents, Firecrawl scrape, Keenable fetch, Linkup fetch, Parallel extract, Tavily extract or You.com contents, whichever keys are set). " +
        "Returns JSON: `result` { url, title?, markdown } and `routing` { provider, reason, rule, tried[] } saying which provider served it and why. " +
        "Fails over to the next provider when one is out of credits, rate limited, down, or cannot fetch the page. " +
        NOTICE,
      inputSchema: {
        url: z.string().url().describe("Absolute http(s) URL of the page."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ url }) => {
      try {
        const response = await router.scrape({ url });
        return ok({ ...response, ...(await notice(router)) });
      } catch (error) {
        return fail(error, (await notice(router)).notice);
      }
    },
  );

  server.registerTool(
    "credits_status",
    {
      title: "Credits and routing order",
      description:
        "Show which providers are enabled (by which API keys are set), the order each capability (search, scrape) will try them in with the reason for each position, " +
        "every balance on its own with its unit and when it was read (`asOf`), any provider marked spent or disabled this session, " +
        "and whether the founder's opt-in balance sync to their Programscape plan is on (`programscape`). " +
        "Where the router has readings over at least a day, each provider's `runway` says how long a balance lasts at the recent pace (always labelled as an estimate); " +
        "`headsUp` lists providers under the founder's threshold (`headsUpDays`), and `programs` lists programs from Programscape's public catalog that can add more, with a link for each provider. " +
        "Never say the founder qualifies: each provider decides. " +
        "Balances are listed one by one in their own units and are never combined into a total. Nothing is ranked on quality.",
      inputSchema: {
        refresh: z.boolean().optional().describe("Re-read balances from providers that publish them, instead of using the cached reading."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ refresh }) => {
      try {
        return ok(await router.status({ refresh: refresh ?? false }));
      } catch (error) {
        return fail(error);
      }
    },
  );

  return server;
}

/** Creates the MCP server and connects it to stdio. Resolves once connected; the process then stays up. */
export async function runMcpServer(router: Router): Promise<void> {
  const server = createMcpServer(router);
  await server.connect(new StdioServerTransport());
}
