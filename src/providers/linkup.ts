/**
 * Linkup adapter.
 *
 * Official docs (read 2026-10-12 for 1.1; the OpenAPI source of truth is https://api.linkup.so/v1/openapi.json):
 * - Search:  https://docs.linkup.so/pages/documentation/endpoints/search/reference   (POST https://api.linkup.so/v1/search)
 *   Fields sent: q, depth: "fast" ("the recommended default for most agentic applications"), outputType:
 *   "searchResults", maxResults (minimum 1, no published maximum). Results are `text` or `image`; only `text` is kept.
 *   Linkup gives no publication date.
 * - Fetch:   https://docs.linkup.so/pages/documentation/endpoints/fetch/reference    (POST https://api.linkup.so/v1/fetch)
 *   Fields sent: url only, so the documented defaults apply (mode "standard", renderJs false). The answer is
 *   { markdown, favicon }, with no title and no final URL.
 * - Balance: https://docs.linkup.so/pages/documentation/endpoints/account/balance  (GET  https://api.linkup.so/v1/credits/balance)
 *   { balance } only. Since May 2026 Linkup prices in USD, one credit to one dollar
 *   (https://docs.linkup.so/pages/documentation/platform/pricing), so the reading is in USD, with no total and no end date.
 * - Errors:  https://docs.linkup.so/pages/documentation/platform/errors (bodies are { statusCode, error: { code, message,
 *   details } }), and the official SDK's reading of each code:
 *   https://github.com/LinkupPlatform/linkup-js-sdk/blob/main/src/utils/refine-error.utils.ts
 *   429 INSUFFICIENT_FUNDS_CREDITS, EXCEED_BUDGET_LIMIT: credits or the key's budget spent ("If your account runs out,
 *   the API will respond with a 429"). 429 TOO_MANY_REQUESTS: rate limited.
 *   402: an x402 payment challenge, sent when no API key came with the request. The router always sends one, so a 402
 *   means Linkup didn't take it.
 *   400 SEARCH_QUERY_NO_RESULT: the search found nothing, read as an empty result list.
 *   400 FETCH_*: Linkup couldn't fetch that page, so the router tries the next provider.
 *   504 REQUEST_DEADLINE_EXCEEDED: Linkup ran out of time.
 */
import type { Outcome } from "../types.js";
import {
  type CallContext,
  type ProviderAdapter,
  ProviderCallError,
  asArray,
  clampResults,
  invalid,
  isRecord,
  num,
  requestJson,
  str,
} from "./http.js";

const BASE = "https://api.linkup.so/v1";

/** 400 codes that mean the target page couldn't be fetched, not that the request was wrong. */
const FETCH_CODES = [
  "FETCH_ERROR",
  "FETCH_RESPONSE_TOO_LARGE",
  "FETCH_TARGET_NOT_FOUND",
  "FETCH_TARGET_UNREACHABLE",
  "FETCH_UNSUPPORTED_CONTENT_TYPE",
  "FETCH_URL_IS_FILE",
];

/** 429 codes that mean credits or the key's budget are spent, not a rate limit. */
const SPENT_CODES = new Set(["INSUFFICIENT_FUNDS_CREDITS", "EXCEED_BUDGET_LIMIT"]);

function errorCode(body: unknown): string | undefined {
  return isRecord(body) && isRecord(body.error) ? str(body.error.code) : undefined;
}

function classify(status: number, body: unknown): Exclude<Outcome, "ok"> | undefined {
  const code = errorCode(body);
  if (status === 429 && code && SPENT_CODES.has(code)) return "exhausted";
  // Not spent credits: Linkup asks for an x402 payment only when no key came with the request.
  if (status === 402) return "unauthorized";
  if (status === 400 && code && FETCH_CODES.includes(code)) return "fetch_failed";
  if (status === 504 && code === "REQUEST_DEADLINE_EXCEEDED") return "timeout";
  return undefined;
}

function headers(ctx: CallContext): Record<string, string> {
  return { authorization: `Bearer ${ctx.key}` };
}

export const linkup: ProviderAdapter = {
  id: "linkup",
  name: "Linkup",
  envVar: "LINKUP_API_KEY",
  docs: [
    "https://docs.linkup.so/pages/documentation/endpoints/search/reference",
    "https://docs.linkup.so/pages/documentation/endpoints/fetch/reference",
    "https://docs.linkup.so/pages/documentation/endpoints/account/balance",
    "https://docs.linkup.so/pages/documentation/platform/errors",
    "https://github.com/LinkupPlatform/linkup-js-sdk/blob/main/src/utils/refine-error.utils.ts",
  ],
  // The codes the errors page and the official SDK name.
  errorCodes: [
    "VALIDATION_ERROR",
    "SEARCH_QUERY_NO_RESULT",
    ...FETCH_CODES,
    "IP_NOT_WHITELISTED",
    "INSUFFICIENT_FUNDS_CREDITS",
    "EXCEED_BUDGET_LIMIT",
    "TOO_MANY_REQUESTS",
    "REQUEST_DEADLINE_EXCEEDED",
  ],
  balanceTtlMs: 5 * 60_000,

  async search(req, ctx) {
    let body: unknown;
    try {
      body = await requestJson(ctx, `${BASE}/search`, {
        headers: headers(ctx),
        body: { q: req.query, depth: "fast", outputType: "searchResults", maxResults: clampResults(req.maxResults, 100) },
        classify,
        errorCode,
      });
    } catch (error) {
      // "Search query yields no result" is an answer, not a failure.
      if (error instanceof ProviderCallError && error.status === 400 && error.code === "SEARCH_QUERY_NO_RESULT") return [];
      throw error;
    }
    if (!isRecord(body) || !Array.isArray(body.results)) throw invalid("Linkup search answered without a results array");
    return asArray(body.results).flatMap((item) => {
      if (!isRecord(item) || item.type === "image") return [];
      const url = str(item.url);
      if (!url) return [];
      const snippet = str(item.content);
      return [{ title: str(item.name) ?? url, url, ...(snippet ? { snippet } : {}) }];
    });
  },

  async scrape(req, ctx) {
    const body = await requestJson(ctx, `${BASE}/fetch`, {
      headers: headers(ctx),
      body: { url: req.url },
      classify,
      errorCode,
    });
    if (!isRecord(body)) throw invalid("Linkup fetch answered with an unreadable body");
    const markdown = typeof body.markdown === "string" ? body.markdown : undefined;
    if (markdown === undefined) throw new ProviderCallError("fetch_failed", "Linkup returned no markdown for the page");
    // Linkup reports neither a title nor the URL it ended up at.
    return { url: req.url, markdown };
  },

  async balance(ctx) {
    const asOf = new Date().toISOString();
    const body = await requestJson(ctx, `${BASE}/credits/balance`, { headers: headers(ctx), classify, errorCode });
    const remaining = isRecord(body) ? num(body.balance) : undefined;
    if (remaining === undefined) throw invalid("Linkup balance answered without a balance");
    return {
      balances: [
        {
          label: "Linkup balance",
          kind: "credits",
          unit: "usd",
          remaining,
          source: "provider",
          asOf,
        },
      ],
    };
  },
};
