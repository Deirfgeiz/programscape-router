/**
 * Keenable adapter.
 *
 * Official docs (read 2026-10-11):
 * - Search:         https://docs.keenable.ai/api-reference/search  (POST https://api.keenable.ai/v1/search)
 * - Fetch:          https://docs.keenable.ai/api-reference/fetch   (GET  https://api.keenable.ai/v1/fetch?url=...)
 * - Error statuses: https://docs.keenable.ai/authentication        (400 malformed key, 401 missing or invalid key,
 *                   402 monthly allowance spent and no purchased credits, 403 key disabled or revoked, 429 rate limit)
 *
 * Keenable shows the remaining allowance only in its web console, so balances come only from the founder's config.
 * Fetch is called with `live=true`, because by default only pages already in Keenable's index can be fetched.
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
  isoDate,
  requestJson,
  str,
} from "./http.js";

const BASE = "https://api.keenable.ai/v1";

function classify(status: number, body: unknown): Exclude<Outcome, "ok"> | undefined {
  // Keenable answers 400 for a malformed API key; that is a key problem, not a bad request.
  if (status === 400 && /api key/i.test(JSON.stringify(body ?? ""))) return "unauthorized";
  return undefined;
}

function headers(ctx: CallContext): Record<string, string> {
  return { "x-api-key": ctx.key };
}

export const keenable: ProviderAdapter = {
  id: "keenable",
  name: "Keenable",
  envVar: "KEENABLE_API_KEY",
  docs: [
    "https://docs.keenable.ai/api-reference/search",
    "https://docs.keenable.ai/api-reference/fetch",
    "https://docs.keenable.ai/authentication",
  ],

  async search(req, ctx) {
    const body = await requestJson(ctx, `${BASE}/search`, {
      headers: headers(ctx),
      body: { query: req.query, max_results: clampResults(req.maxResults, 50) },
      classify,
    });
    if (!isRecord(body) || !Array.isArray(body.results)) throw invalid("Keenable search answered without a results array");
    return asArray(body.results).flatMap((item) => {
      if (!isRecord(item)) return [];
      const url = str(item.url);
      if (!url) return [];
      const snippet = str(item.snippet) ?? str(item.description);
      const publishedAt = isoDate(item.published_at);
      return [
        {
          title: str(item.title) ?? url,
          url,
          ...(snippet ? { snippet } : {}),
          ...(publishedAt ? { publishedAt } : {}),
        },
      ];
    });
  },

  async scrape(req, ctx) {
    const params = new URLSearchParams({ url: req.url, live: "true" });
    const body = await requestJson(ctx, `${BASE}/fetch?${params.toString()}`, {
      method: "GET",
      headers: headers(ctx),
      classify,
    });
    if (!isRecord(body)) throw invalid("Keenable fetch answered with an unreadable body");
    const markdown = typeof body.content === "string" ? body.content : undefined;
    if (markdown === undefined) throw new ProviderCallError("fetch_failed", "Keenable returned no content for the page");
    const title = str(body.title);
    return { url: str(body.url) ?? req.url, ...(title ? { title } : {}), markdown };
  },
};
