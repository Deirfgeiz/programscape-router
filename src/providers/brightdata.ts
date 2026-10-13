/**
 * Bright Data adapter.
 *
 * Official docs (read 2026-10-12 for 1.2; the index is https://docs.brightdata.com/llms.txt), checked against live
 * answers on a founder's own account the same day, which win where the two differ:
 * - Auth:     https://docs.brightdata.com/api-reference/authentication. `Authorization: Bearer <key>`, exactly; the
 *   CLI and Bright Data's SDKs read the key from BRIGHTDATA_API_KEY.
 * - Search:   https://docs.brightdata.com/api-reference/rest-api/serp/serp-api  (POST https://api.brightdata.com/request)
 *   Fields sent: zone (a SERP zone), url (a Google search URL with `hl=en&gl=us&brd_json=1`), format: "raw". The
 *   answer is Google's results as JSON: `organic: [{ link, title, description, rank, ... }]`, with no dates. Google
 *   returns about 10 results a page (it retired `num` on September 11, 2025:
 *   https://docs.brightdata.com/products/serp-api/query-parameters/google), and every further page is another billed
 *   request, so the router asks for one page and gives at most 10 results. Live: without `hl`/`gl`, one search came
 *   back HTTP 200 with an empty body and `x-brd-error-code: captcha`; `format: "json"` with `data_format:
 *   "parsed_light"` wrapped the same error inside the body; Bing answered faster but with 2 results. Searches took
 *   2 to 27 seconds, so Bright Data gets the scrape limit (60 s) for search too, unless config sets timeoutMs.
 * - Scrape:   https://docs.brightdata.com/api-reference/rest-api/unlocker/unlock-website  (same endpoint)
 *   Fields sent: zone (a Web Unlocker zone), url, format: "json", data_format: "markdown". The answer is
 *   { status_code, headers, body }: the target page's status and headers, and the page as markdown. No title, and no
 *   final URL, so the requested URL is reported.
 * - Balance:  https://docs.brightdata.com/api-reference/account-management-api/Get_total_balance_through_API
 *   (GET https://api.brightdata.com/customer/balance) { balance, credit, prepayment, pending_costs }, in US dollars.
 *   Only `balance` is read, labelled as Bright Data's paid balance. Live, it read 2 while the dashboard showed an
 *   account balance of $9.50, so what it counts isn't settled; the note says it may differ from the dashboard. The
 *   free monthly credits (5,000 a month, https://docs.brightdata.com/general/account/billing-and-pricing/free-tier)
 *   aren't in any API, so a $0 reading is shown but never used for the order or sent to a Programscape plan
 *   (Dave, October 12, 2026: "Show it, never sync a $0"). A key without the permission gets 403 "Your API key lacks
 *   the required permissions for this action": the balance is unknown, and the key still works for search and scrape.
 * - Zones:    https://docs.brightdata.com/api-reference/account-management-api/Add_a_Zone (POST /zone) and
 *   GET /zone/get_active_zones, used only by `keys set brightdata` (listZones and createZone below). Every /request
 *   names a zone in the founder's account as well as the key.
 * - Errors:   https://docs.brightdata.com/products/web-unlocker/error-codes,
 *   https://docs.brightdata.com/products/serp-api/debugging and https://docs.brightdata.com/proxy-networks/errorCatalog
 *   "The outer response is 200 OK once the request reaches the unlocker. The result status is in the
 *   x-brd-status-code header", with the code in x-brd-error-code / x-brd-error (unlocker) or x-brd-err-code /
 *   x-brd-err-msg (proxy). With format "json" the same headers can arrive inside the body's `headers`. So any of those
 *   codes, or a result status of 400 or more, fails the call, whatever the HTTP status. Failed requests aren't billed.
 *   An unknown zone is HTTP 400 with a text/html body `zone "x" not found`: a setting, not a bad request, so the
 *   router switches Bright Data off for the session and tries the next provider.
 */
import type { Capability, Outcome } from "../types.js";
import {
  type Answer,
  type CallContext,
  type ProviderAdapter,
  ProviderCallError,
  asArray,
  clampResults,
  classifyStatus,
  invalid,
  isRecord,
  num,
  requestJson,
  str,
} from "./http.js";

export const BRIGHTDATA_API = "https://api.brightdata.com";

/** What to run when a zone is missing or wrong. */
export const BRIGHTDATA_ZONE_FIX = "Run `programscape-router keys set brightdata` to set up its zones.";

/** Codes Bright Data documents for being rate limited (in x-brd-error-code or x-brd-err-code). */
const RATE_CODES = new Set(["sr_rate_limit", "bucket_rate_limit", "failed_query_rejected", "repeat_query_rejected", "client_10110"]);

/**
 * Codes read as spent funds. Not verified live: Bright Data documents no "out of funds" code for SERP or Web Unlocker
 * (its free-tier page says only that "requests return an error"). client_10100 is "Zone has reached usage limit",
 * which Bright Data's own MCP server reads as the free-tier limit; client_10020 is "Account is suspended".
 */
const SPENT_CODES = new Set(["client_10100", "client_10020"]);

/** Unlock and search failures Bright Data documents (502 and the like): not billed, and not the key's fault. */
const UNLOCK_CODES = [
  "captcha",
  "reject_block",
  "http_status",
  "navigation_timeout",
  "no_peers",
  "unexpected_q",
  "verifying",
  "premium",
  "ub_bad_endpoint_robots",
];

const ZONE_NOT_FOUND = /zone\s+"[^"]*"\s+not found/i;

function headers(ctx: CallContext): Record<string, string> {
  return { authorization: `Bearer ${ctx.key}` };
}

/** A header from a Headers object or from a format-json wrapper's plain `headers` record. */
type HeaderLookup = (name: string) => string | undefined;

function fromHeaders(value: Headers): HeaderLookup {
  return (name) => value.get(name) ?? undefined;
}

function fromRecord(value: unknown): HeaderLookup {
  if (!isRecord(value)) return () => undefined;
  const lower = new Map(Object.entries(value).map(([name, entry]) => [name.toLowerCase(), entry]));
  return (name) => {
    const entry = lower.get(name);
    return typeof entry === "string" ? entry : typeof entry === "number" ? String(entry) : Array.isArray(entry) ? str(entry[0]) : undefined;
  };
}

/**
 * The failure Bright Data reports in x-brd-* headers, or undefined when they report none. `capability` decides what an
 * unlock failure means: a search that didn't come back, or a page that couldn't be fetched (both fail over).
 */
export function brdFailure(capability: Capability, header: HeaderLookup, httpStatus: number): ProviderCallError | undefined {
  const code = header("x-brd-error-code") ?? header("x-brd-err-code");
  const resultStatus = Number(header("x-brd-status-code"));
  const failedStatus = Number.isInteger(resultStatus) && resultStatus >= 400 ? resultStatus : undefined;
  if (!code && failedStatus === undefined) return undefined;
  const message = header("x-brd-error") ?? header("x-brd-err-msg") ?? `Bright Data reported ${code ?? `status ${failedStatus}`}`;
  const status = failedStatus ?? httpStatus;
  let outcome: Exclude<Outcome, "ok">;
  if (code && SPENT_CODES.has(code)) outcome = "exhausted";
  else if ((code && RATE_CODES.has(code)) || failedStatus === 429) outcome = "rate_limited";
  // Anything else here is about this search or page, never the key: an outer 401 is the only bad key.
  else outcome = capability === "search" ? "provider_error" : "fetch_failed";
  return new ProviderCallError(outcome, message, status, code);
}

/** Reads every /request answer: the unknown zone, the outer error statuses, and failures inside a 200. */
function inspectRequest(capability: Capability, ctx: CallContext) {
  return (answer: Answer): ProviderCallError | undefined => {
    if (answer.status === 400 && ZONE_NOT_FOUND.test(answer.text)) {
      // The zone named is the one sent, from the founder's own settings, never words taken from the answer.
      const zone = ctx.zones?.[capability] ?? "";
      const fix = `Bright Data zone ${zone} not found; run \`programscape-router keys set brightdata\` again.`;
      return new ProviderCallError("provider_error", `Bright Data zone ${zone} not found`, 400, undefined, { fix, switchOff: true });
    }
    const inHeaders = brdFailure(capability, fromHeaders(answer.headers), answer.status);
    if (answer.status >= 200 && answer.status < 300) {
      if (inHeaders) return inHeaders;
      // format: "json" wraps the target's answer, with Bright Data's own headers inside it.
      if (isRecord(answer.body) && "status_code" in answer.body && isRecord(answer.body.headers)) {
        return brdFailure(capability, fromRecord(answer.body.headers), answer.status);
      }
      return undefined;
    }
    // An error status. 401 and 403 are the key; 429 a rate limit; a documented code says the rest.
    const body = isRecord(answer.body) ? answer.body : undefined;
    const code = inHeaders?.code ?? str(body?.error_code);
    const message = str(body?.error) ?? (answer.text.trim().slice(0, 300) || `HTTP ${answer.status}`);
    if (answer.status === 401 || answer.status === 403) return new ProviderCallError("unauthorized", message, answer.status, code);
    if (code && SPENT_CODES.has(code)) return new ProviderCallError("exhausted", message, answer.status, code);
    if (answer.status === 429 || (code && RATE_CODES.has(code))) return new ProviderCallError("rate_limited", message, answer.status, code);
    if (code && UNLOCK_CODES.includes(code)) {
      return new ProviderCallError(capability === "search" ? "provider_error" : "fetch_failed", message, answer.status, code);
    }
    return new ProviderCallError(classifyStatus(answer.status), message, answer.status, code);
  };
}

function zoneFor(capability: Capability, ctx: CallContext): string {
  const zone = ctx.zones?.[capability];
  if (!zone) {
    const what = capability === "search" ? "search" : "page-read";
    throw new ProviderCallError("provider_error", `No Bright Data ${what} zone is set up.`, undefined, undefined, { fix: BRIGHTDATA_ZONE_FIX });
  }
  return zone;
}

/** Google's results page for `query`, in English for the US: without hl and gl, Google answered with a captcha. */
export function googleUrl(query: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en&gl=us&brd_json=1`;
}

const BALANCE_NOTE =
  "Bright Data's paid balance in US dollars, as Bright Data reports it (it may differ from the account balance on Bright Data's dashboard). " +
  "Free monthly credits aren't included: Bright Data doesn't report them.";

export const brightdata: ProviderAdapter = {
  id: "brightdata",
  name: "Bright Data",
  envVar: "BRIGHTDATA_API_KEY",
  docs: [
    "https://docs.brightdata.com/api-reference/authentication",
    "https://docs.brightdata.com/api-reference/rest-api/serp/serp-api",
    "https://docs.brightdata.com/api-reference/rest-api/unlocker/unlock-website",
    "https://docs.brightdata.com/api-reference/account-management-api/Get_total_balance_through_API",
    "https://docs.brightdata.com/api-reference/account-management-api/Add_a_Zone",
    "https://docs.brightdata.com/products/web-unlocker/error-codes",
    "https://docs.brightdata.com/products/serp-api/debugging",
    "https://docs.brightdata.com/proxy-networks/errorCatalog",
  ],
  // The codes the error pages above name. client_* codes are Bright Data's proxy error catalog.
  errorCodes: [...RATE_CODES, ...SPENT_CODES, ...UNLOCK_CODES, "validation", /^client_\d{5}$/],
  balanceTtlMs: 5 * 60_000,
  zoneEnvVars: { search: "BRIGHTDATA_SERP_ZONE", scrape: "BRIGHTDATA_UNLOCKER_ZONE" },
  zoneFix: BRIGHTDATA_ZONE_FIX,
  searchTimeoutMs: 60_000,

  async search(req, ctx) {
    const zone = zoneFor("search", ctx);
    const body = await requestJson(ctx, `${BRIGHTDATA_API}/request`, {
      headers: headers(ctx),
      body: { zone, url: googleUrl(req.query), format: "raw" },
      inspect: inspectRequest("search", ctx),
    });
    if (!isRecord(body)) throw invalid("Bright Data search answered with an unreadable body");
    // "Only `organic` is guaranteed", and a page with no organic results may leave it out.
    if (body.organic !== undefined && !Array.isArray(body.organic)) throw invalid("Bright Data search answered without an organic list");
    const results = asArray(body.organic).flatMap((item) => {
      if (!isRecord(item)) return [];
      const url = str(item.link);
      if (!url) return [];
      const snippet = str(item.description);
      return [{ title: str(item.title) ?? url, url, ...(snippet ? { snippet } : {}) }];
    });
    return results.slice(0, clampResults(req.maxResults, 10));
  },

  async scrape(req, ctx) {
    const zone = zoneFor("scrape", ctx);
    const body = await requestJson(ctx, `${BRIGHTDATA_API}/request`, {
      headers: headers(ctx),
      body: { zone, url: req.url, format: "json", data_format: "markdown" },
      inspect: inspectRequest("scrape", ctx),
    });
    if (!isRecord(body)) throw invalid("Bright Data answered with an unreadable body");
    const target = num(body.status_code);
    if (target !== undefined && target >= 400) {
      throw new ProviderCallError("fetch_failed", `Bright Data fetched the page, which answered HTTP ${target}`, target);
    }
    const markdown = typeof body.body === "string" ? body.body : undefined;
    if (markdown === undefined) throw new ProviderCallError("fetch_failed", "Bright Data returned no markdown for the page");
    return { url: req.url, markdown };
  },

  async balance(ctx) {
    const asOf = new Date().toISOString();
    let body: unknown;
    try {
      body = await requestJson(ctx, `${BRIGHTDATA_API}/customer/balance`, { headers: headers(ctx) });
    } catch (error) {
      // A key without billing permission: the balance is unknown, and the key is fine for search and scrape.
      if (error instanceof ProviderCallError && error.status === 403) {
        return {
          balances: [],
          note: "Bright Data didn't let this key read the balance (reading it needs an Admin key); treated as unknown. Searches and page reads still use this key.",
        };
      }
      throw error;
    }
    const remaining = isRecord(body) ? num(body.balance) : undefined;
    if (remaining === undefined) throw invalid("Bright Data balance answered without a balance");
    const shownOnly = remaining <= 0;
    return {
      balances: [
        {
          label: "Bright Data paid balance",
          kind: "credits",
          unit: "usd",
          remaining,
          source: "provider",
          asOf,
          ...(shownOnly ? { informational: true as const } : {}),
        },
      ],
      note: shownOnly ? `${BALANCE_NOTE} So a $0 reading isn't used for the order or sent to your Programscape plan.` : BALANCE_NOTE,
    };
  },
};

/** One zone in the founder's account. Live, a SERP zone lists as type "serp" and a Web Unlocker zone as "unblocker". */
export interface BrightDataZone {
  name: string;
  type: string;
}

/** The zone type each capability uses. */
export const ZONE_TYPES: Readonly<Record<Capability, string>> = { search: "serp", scrape: "unblocker" };

/** The names the router gives zones it creates, when the founder says yes. */
export const ZONE_NAMES: Readonly<Record<Capability, string>> = { search: "programscape_serp", scrape: "programscape_unlocker" };

/**
 * The account's active zones (GET /zone/get_active_zones). Live, a key without Admin permission gets 200 `[]`, not an
 * error, so an empty list means "can't tell", never "no zones".
 */
export async function listZones(ctx: CallContext): Promise<BrightDataZone[]> {
  const body = await requestJson(ctx, `${BRIGHTDATA_API}/zone/get_active_zones`, { headers: headers(ctx) });
  if (!Array.isArray(body)) throw invalid("Bright Data's zone list answered without a list");
  return body.flatMap((item) => {
    const name = isRecord(item) ? str(item.name) : undefined;
    const type = isRecord(item) ? str(item.type) : undefined;
    return name && type && /^[A-Za-z0-9_-]{1,64}$/.test(name) ? [{ name, type }] : [];
  });
}

/**
 * Creates a zone (POST /zone), with the body Bright Data's docs give for each kind: a SERP zone is an unblocker plan
 * with `serp: true` (checked live), a Web Unlocker zone a plain unblocker plan (not yet checked live). Only Admin and
 * Ops keys may. The answer holds the zone's proxy password and the account's user id, so nothing of it is read,
 * kept, logged or returned: only whether it succeeded. A failure carries the HTTP status and fixed words only.
 */
export async function createZone(ctx: CallContext, name: string, capability: Capability): Promise<void> {
  const plan = capability === "search" ? { type: "unblocker", serp: true } : { type: "unblocker" };
  try {
    await requestJson(ctx, `${BRIGHTDATA_API}/zone`, { headers: headers(ctx), body: { zone: { name, type: "unblocker" }, plan } });
  } catch (error) {
    if (!(error instanceof ProviderCallError)) throw new ProviderCallError("provider_error", "Bright Data could not create the zone");
    // A 2xx whose body isn't JSON is still a success.
    if (error.outcome === "invalid_response" && error.status !== undefined && error.status >= 200 && error.status < 300) return;
    throw new ProviderCallError(error.outcome, `Bright Data did not create the zone${error.status ? ` (HTTP ${error.status})` : ""}`, error.status);
  }
}
