/**
 * Firecrawl adapter (API v2).
 *
 * Official docs (read 2026-10-11):
 * - Search:       https://docs.firecrawl.dev/api-reference/endpoint/search        (POST https://api.firecrawl.dev/v2/search)
 * - Scrape:       https://docs.firecrawl.dev/api-reference/endpoint/scrape        (POST https://api.firecrawl.dev/v2/scrape)
 * - Credit usage: https://docs.firecrawl.dev/api-reference/endpoint/credit-usage  (GET  https://api.firecrawl.dev/v2/team/credit-usage)
 *
 * 402 means insufficient credits; the scrape docs show `"code": "insufficient_credits"` in its body.
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
  num,
  requestJson,
  str,
} from "./http.js";

const BASE = "https://api.firecrawl.dev/v2";

function classify(status: number, body: unknown): Exclude<Outcome, "ok"> | undefined {
  if (isRecord(body) && body.code === "insufficient_credits") return "exhausted";
  return status === 402 ? "exhausted" : undefined;
}

function headers(ctx: CallContext): Record<string, string> {
  return { authorization: `Bearer ${ctx.key}` };
}

function unwrap(body: unknown, what: string): Record<string, unknown> {
  if (!isRecord(body)) throw invalid(`Firecrawl ${what} answered with an unreadable body`);
  if (body.success === false) {
    throw new ProviderCallError("provider_error", str(body.error) ?? `Firecrawl ${what} reported a failure`);
  }
  if (!isRecord(body.data)) throw invalid(`Firecrawl ${what} answered without data`);
  return body.data;
}

export const firecrawl: ProviderAdapter = {
  id: "firecrawl",
  name: "Firecrawl",
  envVar: "FIRECRAWL_API_KEY",
  docs: [
    "https://docs.firecrawl.dev/api-reference/endpoint/search",
    "https://docs.firecrawl.dev/api-reference/endpoint/scrape",
    "https://docs.firecrawl.dev/api-reference/endpoint/credit-usage",
  ],
  balanceTtlMs: 5 * 60_000,

  async search(req, ctx) {
    const body = await requestJson(ctx, `${BASE}/search`, {
      headers: headers(ctx),
      body: { query: req.query, limit: clampResults(req.maxResults, 100), sources: [{ type: "web" }] },
      classify,
    });
    const data = unwrap(body, "search");
    return asArray(data.web).flatMap((item) => {
      if (!isRecord(item)) return [];
      const url = str(item.url);
      if (!url) return [];
      const snippet = str(item.description);
      return [{ title: str(item.title) ?? url, url, ...(snippet ? { snippet } : {}) }];
    });
  },

  async scrape(req, ctx) {
    const body = await requestJson(ctx, `${BASE}/scrape`, {
      headers: headers(ctx),
      body: { url: req.url, formats: ["markdown"], onlyMainContent: true },
      classify,
    });
    const data = unwrap(body, "scrape");
    const markdown = typeof data.markdown === "string" ? data.markdown : undefined;
    if (markdown === undefined) throw new ProviderCallError("fetch_failed", "Firecrawl returned no markdown for the page");
    const metadata = isRecord(data.metadata) ? data.metadata : {};
    const title = str(metadata.title);
    return {
      url: str(metadata.url) ?? str(metadata.sourceURL) ?? req.url,
      ...(title ? { title } : {}),
      markdown,
    };
  },

  async balance(ctx) {
    const asOf = new Date().toISOString();
    const body = await requestJson(ctx, `${BASE}/team/credit-usage`, { headers: headers(ctx), classify });
    const data = unwrap(body, "credit usage");
    const remaining = num(data.remainingCredits);
    const total = num(data.planCredits);
    const endsOn = isoDate(data.billingPeriodEnd);
    return {
      balances: [
        {
          label: "Firecrawl credits, current billing period",
          kind: "credits",
          unit: "credits",
          ...(remaining !== undefined ? { remaining } : {}),
          ...(total !== undefined ? { total } : {}),
          ...(endsOn ? { endsOn } : {}),
          source: "provider",
          asOf,
        },
      ],
    };
  },
};
