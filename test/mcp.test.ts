import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createMcpServer } from "../src/mcp.js";
import { createRouter } from "../src/router.js";
import { URLS, fixture, mockFetch, ok, status } from "./helpers.js";

async function connect(env: Record<string, string>, routes: Parameters<typeof mockFetch>[0]) {
  const { fetch } = mockFetch(routes);
  const router = createRouter({ env, config: {}, fetch, ledgerPath: false, log: () => {} });
  const server = createMcpServer(router);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as Array<{ type: string; text: string }>;
  return content[0]?.text ?? "";
}

describe("MCP server", () => {
  it("lists search, scrape and credits_status with descriptions of what they return", async () => {
    const client = await connect({}, {});
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(["credits_status", "scrape", "search"]);
    for (const tool of tools) expect(tool.description).toMatch(/Returns|Show/);
    expect(tools.find((t) => t.name === "credits_status")?.description).toContain("never combined into a total");
  });

  it("answers a search with results and routing", async () => {
    const client = await connect({ TAVILY_API_KEY: "t" }, { [URLS.tavilySearch]: ok(fixture("tavily-search")), [URLS.tavilyUsage]: status(500) });
    const result = await client.callTool({ name: "search", arguments: { query: "messi", maxResults: 2 } });
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(text(result));
    expect(body.results[0].url).toBe("https://www.britannica.com/facts/Lionel-Messi");
    expect(body.routing.provider).toBe("tavily");
  });

  it("returns a tool error with the routing when no provider is available", async () => {
    const client = await connect({}, {});
    const result = await client.callTool({ name: "scrape", arguments: { url: "https://example.com" } });
    expect(result.isError).toBe(true);
    expect(JSON.parse(text(result)).error).toBe("no_provider");
  });

  it("answers credits_status", async () => {
    const client = await connect({}, {});
    const result = await client.callTool({ name: "credits_status", arguments: {} });
    const body = JSON.parse(text(result));
    expect(body.order.scrape.rule).toBe("credits-ending-first");
    expect(body.providers.map((p: { id: string }) => p.id)).toEqual(["exa", "firecrawl", "keenable", "linkup", "parallel", "tavily", "youcom"]);
  });
});
