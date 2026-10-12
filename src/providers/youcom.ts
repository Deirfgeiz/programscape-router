/**
 * You.com adapter.
 *
 * Official docs (read 2026-10-12 for 1.1; the OpenAPI sources of truth are https://you.com/docs/openapi/web-search.json,
 * https://you.com/docs/openapi/contents.json and https://you.com/docs/openapi/billing.json):
 * - Search:   https://you.com/docs/api-reference/search/v1-search  (POST https://ydc-index.io/v1/search)
 *   Fields sent: query, count (1-100, applied "per section": `web` and `news`). Web results come first, then news
 *   results not already listed; the router trims the list to the requested count. Only news results carry a
 *   publication date ("UTC timestamp of the article's publication date"); a web result's `page_age` is described as
 *   "the age of the search result", so it is not read as one.
 * - Contents: https://you.com/docs/api-reference/contents  (POST https://ydc-index.io/v1/contents)
 *   Fields sent: urls, formats: ["markdown"]. The answer is a JSON array of { url, title, markdown, html }, and
 *   `markdown` may be null.
 * - Balance:  https://you.com/docs/api-reference/billing/get-account-balance  (GET https://api.you.com/v1/billing/account_balance)
 *   { data: { attributes: { balance } } }, where "Balance values are expressed in cents". It is reported in USD, as
 *   cents divided by 100 and never rounded, with no total and no end date. This one endpoint is on api.you.com;
 *   search and contents are on ydc-index.io. Both hosts are You.com's own.
 * - Errors:   https://you.com/docs/using-the-api/error-code-reference
 *   402 { "detail": "Insufficient credits" }: credits spent. 401: missing, invalid or expired key. 429: rate limited.
 *   403 { "detail": "Missing required scopes" }: the key "lacks scope for this path" (contents, say), so the key still
 *   works for the other capability. 403 { "message": "Missing Authentication Token" }: the wrong host, an adapter bug.
 *   You.com documents no machine-readable error codes, so `check` shows only the HTTP status.
 *
 * You.com's API Acceptable Use Policy (May 15, 2026) forbids storing "significant portions" of its content for re-use,
 * so nothing here caches a result.
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

const INDEX = "https://ydc-index.io/v1";
const ACCOUNT = "https://api.you.com/v1";

function classify(status: number, body: unknown): Exclude<Outcome, "ok"> | undefined {
  // Not a bad key: switching the provider off would also stop the capability the key does have scope for.
  if (status === 403 && /missing required scopes|missing authentication token/i.test(errorMessage(body) ?? "")) return "provider_error";
  return undefined;
}

function errorMessage(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  return str(body.detail) ?? str(body.message) ?? str(body.error);
}

function headers(ctx: CallContext): Record<string, string> {
  return { "x-api-key": ctx.key };
}

/** A news `page_age` is UTC but may be written without an offset, which Date.parse would read as local time. */
function utcDate(value: unknown): string | undefined {
  const text = str(value);
  if (text && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(text)) return isoDate(`${text}Z`);
  return isoDate(text);
}

function snippetOf(item: Record<string, unknown>): string | undefined {
  const snippets = asArray(item.snippets).filter((part): part is string => typeof part === "string" && part.length > 0);
  return snippets.length > 0 ? snippets.join(" … ") : str(item.description);
}

export const youcom: ProviderAdapter = {
  id: "youcom",
  name: "You.com",
  envVar: "YDC_API_KEY",
  docs: [
    "https://you.com/docs/api-reference/search/v1-search",
    "https://you.com/docs/api-reference/contents",
    "https://you.com/docs/api-reference/billing/get-account-balance",
    "https://you.com/docs/using-the-api/error-code-reference",
  ],
  balanceTtlMs: 5 * 60_000,

  async search(req, ctx) {
    const body = await requestJson(ctx, `${INDEX}/search`, {
      headers: headers(ctx),
      body: { query: req.query, count: clampResults(req.maxResults, 100) },
      classify,
      errorMessage,
    });
    if (!isRecord(body) || !isRecord(body.results)) throw invalid("You.com search answered without results");
    const seen = new Set<string>();
    const read = (items: unknown, dated: boolean) =>
      asArray(items).flatMap((item) => {
        if (!isRecord(item)) return [];
        const url = str(item.url);
        if (!url || seen.has(url)) return [];
        seen.add(url);
        const snippet = snippetOf(item);
        const publishedAt = dated ? utcDate(item.page_age) : undefined;
        return [
          {
            title: str(item.title) ?? url,
            url,
            ...(snippet ? { snippet } : {}),
            ...(publishedAt ? { publishedAt } : {}),
          },
        ];
      });
    return [...read(body.results.web, false), ...read(body.results.news, true)];
  },

  async scrape(req, ctx) {
    const body = await requestJson(ctx, `${INDEX}/contents`, {
      headers: headers(ctx),
      body: { urls: [req.url], formats: ["markdown"] },
      classify,
      errorMessage,
    });
    if (!Array.isArray(body)) throw invalid("You.com contents answered without a list of pages");
    const page = body.find(isRecord);
    const markdown = page && typeof page.markdown === "string" ? page.markdown : undefined;
    if (!page || markdown === undefined) throw new ProviderCallError("fetch_failed", "You.com returned no markdown for the page");
    const title = str(page.title);
    return { url: str(page.url) ?? req.url, ...(title ? { title } : {}), markdown };
  },

  async balance(ctx) {
    const asOf = new Date().toISOString();
    const body = await requestJson(ctx, `${ACCOUNT}/billing/account_balance`, { headers: headers(ctx), classify, errorMessage });
    const data = isRecord(body) && isRecord(body.data) ? body.data : undefined;
    const cents = data && isRecord(data.attributes) ? num(data.attributes.balance) : undefined;
    if (cents === undefined) throw invalid("You.com account balance answered without a balance");
    return {
      balances: [
        {
          label: "You.com account balance",
          kind: "credits",
          unit: "usd",
          remaining: cents / 100,
          source: "provider",
          asOf,
        },
      ],
    };
  },
};
