import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { type Router, RouterError } from "./router.js";
import { VERSION } from "./version.js";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function ok(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function fail(error: unknown): ToolResult {
  if (error instanceof RouterError) {
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ error: error.code, message: error.message, routing: error.routing }, null, 2) }],
    };
  }
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: "internal", message: "Unexpected error" }) }] };
}

export function createMcpServer(router: Router): McpServer {
  const server = new McpServer({ name: "programscape-router", version: VERSION });

  server.registerTool(
    "search",
    {
      title: "Web search",
      description:
        "Search the web through one of the founder's own search providers (Exa, Firecrawl, Keenable, Parallel or Tavily, whichever keys are set). " +
        "Returns JSON: `results` as a list of { title, url, snippet?, publishedAt? }, and `routing` { provider, reason, rule, tried[] } saying which provider served it, " +
        "why it was chosen (the founder's order, or by default the credits that end first), and every provider tried with its outcome. " +
        "If a provider's credits are spent, rate limited or down, the next provider is tried automatically.",
      inputSchema: {
        query: z.string().min(1).describe("What to search for."),
        maxResults: z.number().int().min(1).max(100).optional().describe("Upper bound on results (default 10). Each provider's own maximum still applies."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, maxResults }) => {
      try {
        return ok(await router.search({ query, ...(maxResults !== undefined ? { maxResults } : {}) }));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "scrape",
    {
      title: "Scrape a page",
      description:
        "Fetch one web page as markdown through one of the founder's own scrape providers (Exa contents, Firecrawl scrape, Keenable fetch, Parallel extract or Tavily extract, whichever keys are set). " +
        "Returns JSON: `result` { url, title?, markdown } and `routing` { provider, reason, rule, tried[] } saying which provider served it and why. " +
        "Fails over to the next provider when one is out of credits, rate limited, down, or cannot fetch the page.",
      inputSchema: {
        url: z.string().url().describe("Absolute http(s) URL of the page."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ url }) => {
      try {
        return ok(await router.scrape({ url }));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "credits_status",
    {
      title: "Credits and routing order",
      description:
        "Show which providers are enabled (by which API keys are set), the order each capability (search, scrape) will try them in with the reason for each position, " +
        "every balance on its own with its unit and when it was read (`asOf`), and any provider marked spent or disabled this session. " +
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

export async function runMcpServer(router: Router): Promise<void> {
  const server = createMcpServer(router);
  await server.connect(new StdioServerTransport());
}
