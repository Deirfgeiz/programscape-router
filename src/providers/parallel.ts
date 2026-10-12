/**
 * Parallel adapter.
 *
 * Official docs (read 2026-10-11):
 * - Search:  https://docs.parallel.ai/api-reference/search/search    (POST https://api.parallel.ai/v1/search)
 * - Extract: https://docs.parallel.ai/api-reference/extract/extract  (POST https://api.parallel.ai/v1/extract)
 * - Errors:  https://docs.parallel.ai/resources/warnings-and-errors  (402 = insufficient credit in account)
 *
 * Parallel publishes no balance endpoint, so balances come only from the founder's config.
 */
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

const BASE = "https://api.parallel.ai/v1";

function headers(ctx: CallContext): Record<string, string> {
  return { "x-api-key": ctx.key };
}

function excerptsOf(value: unknown): string | undefined {
  const parts = asArray(value).filter((part): part is string => typeof part === "string" && part.length > 0);
  return parts.length > 0 ? parts.join(" … ") : undefined;
}

export const parallel: ProviderAdapter = {
  id: "parallel",
  name: "Parallel",
  envVar: "PARALLEL_API_KEY",
  docs: [
    "https://docs.parallel.ai/api-reference/search/search",
    "https://docs.parallel.ai/api-reference/extract/extract",
    "https://docs.parallel.ai/resources/warnings-and-errors",
  ],

  async search(req, ctx) {
    const body = await requestJson(ctx, `${BASE}/search`, {
      headers: headers(ctx),
      body: {
        objective: req.query,
        search_queries: [req.query],
        advanced_settings: { max_results: clampResults(req.maxResults, 100) },
      },
    });
    if (!isRecord(body) || !Array.isArray(body.results)) throw invalid("Parallel search answered without a results array");
    return asArray(body.results).flatMap((item) => {
      if (!isRecord(item)) return [];
      const url = str(item.url);
      if (!url) return [];
      const snippet = excerptsOf(item.excerpts);
      const publishedAt = isoDate(item.publish_date);
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
    const body = await requestJson(ctx, `${BASE}/extract`, {
      headers: headers(ctx),
      body: { urls: [req.url], advanced_settings: { full_content: true } },
    });
    if (!isRecord(body)) throw invalid("Parallel extract answered with an unreadable body");
    const result = asArray(body.results).find(isRecord);
    const markdown = result && typeof result.full_content === "string" ? result.full_content : undefined;
    if (!result || markdown === undefined) {
      const error = asArray(body.errors).find(isRecord);
      throw new ProviderCallError(
        "fetch_failed",
        error && str(error.error_type) ? `Parallel could not fetch the page (${str(error.error_type)})` : "Parallel could not fetch the page",
        error && typeof error.http_status_code === "number" ? error.http_status_code : undefined,
      );
    }
    const title = str(result.title);
    return { url: str(result.url) ?? req.url, ...(title ? { title } : {}), markdown };
  },
};
