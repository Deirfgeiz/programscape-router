/**
 * A stand-in for programscape.com: OAuth metadata, dynamic client registration, the token endpoint (codes bound to
 * a PKCE challenge and an exact redirect URI, refresh tokens that rotate), revocation, and a real MCP server
 * (the SDK's, over Streamable HTTP) with `my_plan` and `report_balance` behind a bearer token.
 */
import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { FetchLike } from "../src/providers/index.js";
import { json } from "./helpers.js";

export const ORIGIN = "https://programscape.com";

export interface SeenRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  redirect: RequestInit["redirect"];
}

export interface KeptProgram {
  id: string;
  provider: string;
  approval?: string;
}

export interface FakeOptions {
  kept?: KeptProgram[];
  /** Extra fields on the token response, e.g. { email }. */
  tokenExtras?: Record<string, unknown>;
  expiresIn?: number;
}

export function fakeProgramscape(options: FakeOptions = {}) {
  const seen: SeenRequest[] = [];
  const toolCalls: Array<{ name: string; arguments: Record<string, unknown>; authorization: string | undefined }> = [];
  const registrations: Array<Record<string, unknown>> = [];
  const authorizations: URLSearchParams[] = [];
  const tokenRequests: URLSearchParams[] = [];
  const revocations: URLSearchParams[] = [];
  const codes = new Map<string, { clientId: string; challenge: string; redirectUri: string }>();
  const clients = new Map<string, string[]>();
  const access = new Set<string>();
  const refresh = new Set<string>();
  let counter = 0;
  const behaviour = {
    kept: options.kept ?? [],
    failRefresh: false,
    /** Make the MCP endpoint answer with this status instead of serving. */
    mcpStatus: undefined as number | undefined,
    /** Make the MCP endpoint never answer (until the request is aborted). */
    mcpHangs: false,
    metadataOverrides: {} as Record<string, unknown>,
  };

  function issue() {
    counter += 1;
    const accessToken = `ps-ACCESS-${counter}-TOKENSECRET`;
    const refreshToken = `ps-REFRESH-${counter}-TOKENSECRET`;
    access.add(accessToken);
    refresh.add(refreshToken);
    return json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: options.expiresIn ?? 3600,
      refresh_token: refreshToken,
      scope: "plans",
      ...options.tokenExtras,
    });
  }

  function mcpServer(): McpServer {
    const server = new McpServer({ name: "fake-programscape", version: "0.0.0" });
    server.registerTool("my_plan", { inputSchema: { planId: z.string().optional() } }, async () => {
      const plan = {
        hasPlan: true,
        plan: { id: "11111111-1111-4111-8111-111111111111", role: "owner" },
        kept: behaviour.kept.map((program) => ({
          id: program.id,
          name: program.id,
          provider: { id: program.provider, name: program.provider },
          ...(program.approval ? { approval: program.approval } : {}),
        })),
        setAside: [],
      };
      return { content: [{ type: "text", text: JSON.stringify(plan) }], structuredContent: plan };
    });
    server.registerTool(
      "report_balance",
      {
        inputSchema: {
          programId: z.string(),
          amount: z.number(),
          unit: z.enum(["usd", "credits", "requests"]),
          asOf: z.string(),
          source: z.literal("router").optional(),
        },
      },
      async (args) => {
        const program = behaviour.kept.find((entry) => entry.id === args.programId);
        if (!program || program.approval !== "approved") {
          return { isError: true, content: [{ type: "text", text: "That program isn't kept and approved on your plan." }] };
        }
        const stored = { programId: args.programId, balance: { amount: args.amount, unit: args.unit, asOf: args.asOf, source: "router" } };
        return { content: [{ type: "text", text: JSON.stringify(stored) }], structuredContent: stored };
      },
    );
    return server;
  }

  async function handle(request: Request, signal: AbortSignal | undefined): Promise<Response> {
    const url = new URL(request.url);
    const body = request.method === "GET" ? "" : await request.clone().text();
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });
    seen.push({ url: request.url, method: request.method, headers, body, redirect: request.redirect });

    switch (url.pathname) {
      case "/.well-known/oauth-authorization-server":
        return json({
          issuer: ORIGIN,
          authorization_endpoint: `${ORIGIN}/oauth/authorize`,
          token_endpoint: `${ORIGIN}/api/oauth/token`,
          registration_endpoint: `${ORIGIN}/api/oauth/register`,
          revocation_endpoint: `${ORIGIN}/api/oauth/revoke`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          scopes_supported: ["plans"],
          ...behaviour.metadataOverrides,
        });
      case "/api/oauth/register": {
        const metadata = JSON.parse(body) as Record<string, unknown>;
        registrations.push(metadata);
        const clientId = `client-${registrations.length}`;
        clients.set(clientId, metadata.redirect_uris as string[]);
        return json({ client_id: clientId, ...metadata }, 201);
      }
      case "/api/oauth/token": {
        const form = new URLSearchParams(body);
        tokenRequests.push(form);
        if (form.get("resource") !== `${ORIGIN}/api/mcp`) return json({ error: "invalid_target" }, 400);
        if (form.get("grant_type") === "authorization_code") {
          const grant = codes.get(form.get("code") ?? "");
          codes.delete(form.get("code") ?? "");
          const verifier = form.get("code_verifier") ?? "";
          const challenge = createHash("sha256").update(verifier).digest("base64url");
          if (!grant || grant.clientId !== form.get("client_id") || grant.redirectUri !== form.get("redirect_uri") || grant.challenge !== challenge) {
            return json({ error: "invalid_grant" }, 400);
          }
          return issue();
        }
        if (form.get("grant_type") === "refresh_token") {
          const token = form.get("refresh_token") ?? "";
          if (behaviour.failRefresh || !refresh.has(token)) return json({ error: "invalid_grant", error_description: `bad ${token}` }, 400);
          refresh.delete(token); // rotation: each refresh token works once
          return issue();
        }
        return json({ error: "unsupported_grant_type" }, 400);
      }
      case "/api/oauth/revoke": {
        const form = new URLSearchParams(body);
        revocations.push(form);
        access.delete(form.get("token") ?? "");
        refresh.delete(form.get("token") ?? "");
        return new Response(null, { status: 200 });
      }
      case "/api/mcp": {
        if (behaviour.mcpHangs) {
          return new Promise((_, reject) => {
            signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          });
        }
        if (behaviour.mcpStatus) return json({ error: "nope" }, behaviour.mcpStatus);
        const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "");
        if (!bearer || !access.has(bearer)) return json({ error: "invalid_token" }, 401);
        if (request.method === "POST") {
          const message = JSON.parse(body) as { method?: string; params?: { name: string; arguments: Record<string, unknown> } };
          if (message.method === "tools/call" && message.params) {
            toolCalls.push({ name: message.params.name, arguments: message.params.arguments, authorization: request.headers.get("authorization") ?? undefined });
          }
        }
        const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        await mcpServer().connect(transport);
        return transport.handleRequest(request);
      }
      default:
        return json({ error: "not_found" }, 404);
    }
  }

  // The caller's own signal is passed along: a Request's copy of it may not fire once the Request is unreferenced.
  const fetch: FetchLike = (input, init) => handle(new Request(input, init), init?.signal ?? undefined);

  /** The founder approving in the browser: returns the loopback URL Programscape would redirect to. */
  function approve(authorizationUrl: string): string {
    const url = new URL(authorizationUrl);
    authorizations.push(url.searchParams);
    const clientId = url.searchParams.get("client_id") ?? "";
    const redirectUri = url.searchParams.get("redirect_uri") ?? "";
    if (!clients.get(clientId)?.includes(redirectUri)) throw new Error("redirect URI does not match the registration exactly");
    const code = `code-${codes.size + 1}-${Math.random().toString(36).slice(2)}`;
    codes.set(code, { clientId, challenge: url.searchParams.get("code_challenge") ?? "", redirectUri });
    const back = new URL(redirectUri);
    back.searchParams.set("code", code);
    back.searchParams.set("state", url.searchParams.get("state") ?? "");
    return back.toString();
  }

  /** An openBrowser for connect: approves and follows the redirect to the router's loopback listener. */
  const browser = async (authorizationUrl: string) => {
    const response = await globalThis.fetch(approve(authorizationUrl));
    await response.text();
  };

  return { fetch, browser, approve, seen, toolCalls, registrations, authorizations, tokenRequests, revocations, access, refresh, behaviour };
}

/** Programscape's requests to the fake, every other host to `providers`. */
export function combine(programscape: FetchLike, providers: FetchLike): FetchLike {
  return (input, init) => (new URL(String(input)).origin === ORIGIN ? programscape(input, init) : providers(input, init));
}
