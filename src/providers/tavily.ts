/**
 * Tavily adapter.
 *
 * Official docs (read 2026-10-11):
 * - Search:  https://docs.tavily.com/documentation/api-reference/endpoint/search   (POST https://api.tavily.com/search)
 * - Extract: https://docs.tavily.com/documentation/api-reference/endpoint/extract  (POST https://api.tavily.com/extract)
 * - Usage:   https://docs.tavily.com/documentation/api-reference/endpoint/usage    (GET  https://api.tavily.com/usage)
 *
 * Tavily signals spent credits with its own status codes: 432 (key or plan limit exceeded) and
 * 433 (pay-as-you-go limit exceeded). Error bodies look like `{ "detail": { "error": "..." } }`.
 * The usage endpoint is rate limited, so readings are cached for ten minutes.
 */
import type { Balance, Outcome } from "../types.js";
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

const BASE = "https://api.tavily.com";

function classify(status: number): Exclude<Outcome, "ok"> | undefined {
  if (status === 432 || status === 433) return "exhausted";
  return undefined;
}

function headers(ctx: CallContext): Record<string, string> {
  return { authorization: `Bearer ${ctx.key}` };
}

function remainingOf(usage: unknown, limit: unknown): { remaining?: number; total?: number } {
  const used = num(usage);
  const cap = num(limit);
  if (cap === undefined) return {};
  return used === undefined ? { total: cap } : { remaining: cap - used, total: cap };
}

export const tavily: ProviderAdapter = {
  id: "tavily",
  name: "Tavily",
  envVar: "TAVILY_API_KEY",
  docs: [
    "https://docs.tavily.com/documentation/api-reference/endpoint/search",
    "https://docs.tavily.com/documentation/api-reference/endpoint/extract",
    "https://docs.tavily.com/documentation/api-reference/endpoint/usage",
  ],
  balanceTtlMs: 10 * 60_000,

  async search(req, ctx) {
    const body = await requestJson(ctx, `${BASE}/search`, {
      headers: headers(ctx),
      body: { query: req.query, max_results: clampResults(req.maxResults, 20) },
      classify,
    });
    if (!isRecord(body) || !Array.isArray(body.results)) throw invalid("Tavily search answered without a results array");
    return asArray(body.results).flatMap((item) => {
      if (!isRecord(item)) return [];
      const url = str(item.url);
      if (!url) return [];
      const snippet = str(item.content);
      const publishedAt = isoDate(item.published_date);
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
      body: { urls: [req.url], format: "markdown" },
      classify,
    });
    if (!isRecord(body)) throw invalid("Tavily extract answered with an unreadable body");
    const result = asArray(body.results).find(isRecord);
    const markdown = result && typeof result.raw_content === "string" ? result.raw_content : undefined;
    if (!result || markdown === undefined) {
      const failed = asArray(body.failed_results).find(isRecord);
      throw new ProviderCallError(
        "fetch_failed",
        failed && str(failed.error) ? `Tavily could not extract the page: ${str(failed.error)}` : "Tavily could not extract the page",
      );
    }
    const title = str(result.title);
    return { url: str(result.url) ?? req.url, ...(title ? { title } : {}), markdown };
  },

  async balance(ctx) {
    const asOf = new Date().toISOString();
    const body = await requestJson(ctx, `${BASE}/usage`, { headers: headers(ctx), classify });
    if (!isRecord(body)) throw invalid("Tavily usage answered with an unreadable body");
    const balances: Balance[] = [];
    const account = isRecord(body.account) ? body.account : undefined;
    const key = isRecord(body.key) ? body.key : undefined;
    if (account) {
      const plan = str(account.current_plan);
      balances.push({
        label: plan ? `Tavily plan credits (${plan})` : "Tavily plan credits",
        kind: "credits",
        unit: "credits",
        ...remainingOf(account.plan_usage, account.plan_limit),
        source: "provider",
        asOf,
      });
      if (num(account.paygo_limit) !== undefined) {
        balances.push({
          label: "Tavily pay-as-you-go limit",
          kind: "pay-as-you-go",
          unit: "credits",
          ...remainingOf(account.paygo_usage, account.paygo_limit),
          source: "provider",
          asOf,
        });
      }
    }
    if (key && num(key.limit) !== undefined) {
      balances.push({
        label: "Tavily limit on this key",
        kind: "key-limit",
        unit: "credits",
        ...remainingOf(key.usage, key.limit),
        source: "provider",
        asOf,
      });
    }
    return { balances };
  },
};
