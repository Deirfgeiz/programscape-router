/**
 * Exa adapter.
 *
 * Official docs (read 2026-10-11):
 * - Search:      https://exa.ai/docs/reference/search        (POST https://api.exa.ai/search)
 * - Contents:    https://exa.ai/docs/reference/get-contents  (POST https://api.exa.ai/contents)
 * - Error codes: https://exa.ai/docs/reference/error-codes   (402 tags NO_MORE_CREDITS, API_KEY_BUDGET_EXCEEDED, ...)
 *
 * Exa publishes no balance endpoint, so balances come only from the founder's config.
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

const BASE = "https://api.exa.ai";

/** 403 tags that refuse this content, not the key. */
const CONTENT_TAGS = new Set(["PROHIBITED_CONTENT", "CONTENT_FILTER_ERROR"]);

function classify(status: number, body: unknown): Exclude<Outcome, "ok"> | undefined {
  const tag = isRecord(body) ? str(body.tag) : undefined;
  if (status === 403 && tag && CONTENT_TAGS.has(tag)) return "rejected";
  return undefined;
}

function errorMessage(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  const error = str(body.error);
  const tag = str(body.tag);
  if (error && tag) return `${error} (${tag})`;
  return error ?? tag;
}

function headers(ctx: CallContext): Record<string, string> {
  return { "x-api-key": ctx.key };
}

export const exa: ProviderAdapter = {
  id: "exa",
  name: "Exa",
  envVar: "EXA_API_KEY",
  docs: [
    "https://exa.ai/docs/reference/search",
    "https://exa.ai/docs/reference/get-contents",
    "https://exa.ai/docs/reference/error-codes",
  ],

  async search(req, ctx) {
    const body = await requestJson(ctx, `${BASE}/search`, {
      headers: headers(ctx),
      body: {
        query: req.query,
        numResults: clampResults(req.maxResults, 100),
        contents: { highlights: true },
      },
      classify,
      errorMessage,
    });
    if (!isRecord(body) || !Array.isArray(body.results)) throw invalid("Exa search answered without a results array");
    return asArray(body.results).flatMap((item) => {
      if (!isRecord(item)) return [];
      const url = str(item.url);
      if (!url) return [];
      const highlights = asArray(item.highlights).filter((h): h is string => typeof h === "string");
      const snippet = highlights.length > 0 ? highlights.join(" … ") : str(item.summary);
      return [
        {
          title: str(item.title) ?? url,
          url,
          ...(snippet ? { snippet } : {}),
          ...(isoDate(item.publishedDate) ? { publishedAt: isoDate(item.publishedDate) } : {}),
        },
      ];
    });
  },

  async scrape(req, ctx) {
    const body = await requestJson(ctx, `${BASE}/contents`, {
      headers: headers(ctx),
      body: { urls: [req.url], text: true },
      classify,
      errorMessage,
    });
    if (!isRecord(body)) throw invalid("Exa contents answered with an unreadable body");
    const status = asArray(body.statuses).find(isRecord);
    if (status && status.status === "error") {
      const error = isRecord(status.error) ? status.error : {};
      const tag = str(error.tag);
      throw new ProviderCallError(
        "fetch_failed",
        `Exa could not fetch the page${tag ? ` (${tag})` : ""}`,
        typeof error.httpStatusCode === "number" ? error.httpStatusCode : undefined,
      );
    }
    const result = asArray(body.results).find(isRecord);
    const text = result ? str(result.text) : undefined;
    if (!result || text === undefined) throw new ProviderCallError("fetch_failed", "Exa returned no text for the page");
    return {
      url: str(result.url) ?? req.url,
      ...(str(result.title) ? { title: str(result.title) } : {}),
      markdown: text,
    };
  },
};
