/**
 * Parallel adapter.
 *
 * Official docs (re-read 2026-10-11 for 1.0; the OpenAPI schema is in each page's .md source):
 * - Search:  https://docs.parallel.ai/api-reference/search/search    (POST https://api.parallel.ai/v1/search)
 *   Request fields sent, all from V1SearchRequest (additionalProperties: false):
 *     objective, search_queries (required), advanced_settings -> AdvancedSearchSettings.max_results
 *     ("Upper bound on the number of results to return. Defaults to 10 if not provided.")
 * - Extract: https://docs.parallel.ai/api-reference/extract/extract  (POST https://api.parallel.ai/v1/extract)
 *   Request fields sent, all from V1ExtractRequest (additionalProperties: false):
 *     urls (required), advanced_settings -> AdvancedExtractSettings.full_content
 *     ("Set to true to enable with defaults"; the result's full_content is "formatted as markdown, if requested")
 *   Per-URL failures come back in `errors` (ExtractError: url, error_type, http_status_code of the target page,
 *   content). Only error_type and the target's status are reported; `content` is never read.
 * - Errors:  https://docs.parallel.ai/resources/warnings-and-errors  (402 = insufficient credit in account;
 *   error bodies are { "type": "error", "error": { "ref_id", "message" } })
 *
 * Not yet exercised against the live API with a real key (`programscape-router check` does). The router also trims results to the
 * requested count, so maxResults holds even if a provider returns more.
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
      const type = error ? str(error.error_type) : undefined;
      // http_status_code is the target page's status, not Parallel's, so it goes in the message rather than `status`.
      const target = error && typeof error.http_status_code === "number" ? `; the page answered HTTP ${error.http_status_code}` : "";
      throw new ProviderCallError("fetch_failed", `Parallel could not fetch the page${type ? ` (${type})` : ""}${target}`);
    }
    const title = str(result.title);
    return { url: str(result.url) ?? req.url, ...(title ? { title } : {}), markdown };
  },
};
