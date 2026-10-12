/**
 * `programscape-router check`: one live call per provider and capability, made with the founder's own keys.
 *
 * Each adapter is called directly (no routing, no failover), so every provider is tested on its own.
 * The check writes nothing to the ledger and never talks to Programscape. Its report carries outcomes,
 * HTTP statuses, latencies, counts and lengths only: never a result title, URL, snippet or page content.
 */
import { ADAPTERS, type CallContext, type FetchLike, ProviderCallError, type ProviderAdapter } from "./providers/index.js";
import { type Capability, type Outcome, PROVIDER_IDS, type ProviderId } from "./types.js";
import { VERSION } from "./version.js";

/** The query each provider is asked to search for. */
export const CHECK_QUERY = "startup credits";
/** How many results each search asks for. */
export const CHECK_MAX_RESULTS = 3;
/** The page each provider is asked to scrape. */
export const CHECK_URL = "https://example.com";

const SEARCH_TIMEOUT_MS = 30_000;
const SCRAPE_TIMEOUT_MS = 60_000;
const BALANCE_TIMEOUT_MS = 10_000;
const MAX_MESSAGE_LENGTH = 300;

export type CheckCapability = Capability | "balance";

/** One live call, described by its outcome and sizes only. */
export interface CheckCall {
  capability: CheckCapability;
  /** True when the provider answered 2xx with a shape the adapter could read. */
  ok: boolean;
  /** `ok`, or the failure class (see the README's Troubleshooting section). */
  outcome: Outcome;
  /** The provider's HTTP status, when it answered with an error status. */
  status?: number;
  /** Wall-clock time for the call, in whole milliseconds. */
  latencyMs: number;
  /** search: how many results came back. */
  resultCount?: number;
  /** scrape: the length of the returned markdown, in characters. */
  markdownLength?: number;
  /** balance: how many balances the provider reported, and which fields each one carried (never the amounts). */
  balances?: Array<{ kind: string; fields: string[] }>;
  /** For a failure: the provider's own error message, with every key redacted and cut to 300 characters. */
  message?: string;
}

export interface CheckProvider {
  provider: ProviderId;
  name: string;
  envVar: string;
  /** Set when the provider was not called, and why (no key set). */
  skipped?: string;
  /** False when the provider publishes no balance endpoint, so no balance call was made. */
  balanceSupported: boolean;
  calls: CheckCall[];
}

export interface CheckReport {
  version: string;
  asOf: string;
  query: string;
  maxResults: number;
  url: string;
  providers: CheckProvider[];
  /** Calls made, calls that passed, calls that failed. */
  attempted: number;
  passed: number;
  failed: number;
  /** True when at least one call was made and every call passed. */
  ok: boolean;
}

export interface CheckOptions {
  /** Where keys are read from. Defaults to process.env. Each key is only ever sent to its own provider. */
  env?: Record<string, string | undefined>;
  /** Defaults to the global fetch. */
  fetch?: FetchLike;
  now?: () => Date;
  /** A millisecond clock for latencies. Defaults to performance.now(). */
  clock?: () => number;
}

function redactor(keys: readonly string[]): (message: string) => string {
  return (message) => {
    let clean = message;
    for (const key of keys) {
      if (key.length >= 4) clean = clean.split(key).join("[redacted]");
    }
    clean = clean.replace(/\s+/g, " ").trim();
    return clean.length > MAX_MESSAGE_LENGTH ? `${clean.slice(0, MAX_MESSAGE_LENGTH - 3)}...` : clean;
  };
}

async function timed(
  capability: CheckCapability,
  clock: () => number,
  redact: (message: string) => string,
  call: () => Promise<Partial<CheckCall>>,
): Promise<CheckCall> {
  const started = clock();
  try {
    const sizes = await call();
    return { capability, ok: true, outcome: "ok", latencyMs: Math.round(clock() - started), ...sizes };
  } catch (error) {
    const latencyMs = Math.round(clock() - started);
    if (error instanceof ProviderCallError) {
      return {
        capability,
        ok: false,
        outcome: error.outcome,
        ...(error.status !== undefined ? { status: error.status } : {}),
        latencyMs,
        message: redact(error.message),
      };
    }
    // An adapter bug, not a provider answer. Its message could hold anything, so only its type is reported.
    const kind = error instanceof Error ? error.name : typeof error;
    return { capability, ok: false, outcome: "provider_error", latencyMs, message: `The adapter failed unexpectedly (${kind}).` };
  }
}

async function checkProvider(
  adapter: ProviderAdapter,
  key: string,
  fetchImpl: FetchLike,
  clock: () => number,
  redact: (message: string) => string,
): Promise<CheckCall[]> {
  const ctx = (timeoutMs: number): CallContext => ({ key, fetch: fetchImpl, timeoutMs });
  const calls: CheckCall[] = [];
  if (adapter.search) {
    const search = adapter.search;
    calls.push(
      await timed("search", clock, redact, async () => {
        const results = await search({ query: CHECK_QUERY, maxResults: CHECK_MAX_RESULTS }, ctx(SEARCH_TIMEOUT_MS));
        return { resultCount: results.length };
      }),
    );
  }
  if (adapter.scrape) {
    const scrape = adapter.scrape;
    calls.push(
      await timed("scrape", clock, redact, async () => {
        const result = await scrape({ url: CHECK_URL }, ctx(SCRAPE_TIMEOUT_MS));
        return { markdownLength: result.markdown.length };
      }),
    );
  }
  if (adapter.balance) {
    const balance = adapter.balance;
    calls.push(
      await timed("balance", clock, redact, async () => {
        const reading = await balance(ctx(BALANCE_TIMEOUT_MS));
        return {
          balances: reading.balances.map((entry) => ({
            kind: entry.kind,
            fields: (["remaining", "total", "unit", "endsOn"] as const).filter((field) => entry[field] !== undefined),
          })),
        };
      }),
    );
  }
  return calls;
}

/** Makes one search, one scrape and (where published) one balance read per provider with a key set. */
export async function runCheck(options: CheckOptions = {}): Promise<CheckReport> {
  const env = options.env ?? process.env;
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const now = options.now ?? (() => new Date());
  const clock = options.clock ?? (() => performance.now());

  const keys = new Map<ProviderId, string>();
  for (const id of PROVIDER_IDS) {
    const key = env[ADAPTERS[id].envVar]?.trim();
    if (key) keys.set(id, key);
  }
  const redact = redactor([...keys.values()]);
  const asOf = now().toISOString();

  // Providers run side by side; each provider's own calls run one after another.
  const providers = await Promise.all(
    PROVIDER_IDS.map(async (id): Promise<CheckProvider> => {
      const adapter = ADAPTERS[id];
      const base = { provider: id, name: adapter.name, envVar: adapter.envVar, balanceSupported: adapter.balance !== undefined };
      const key = keys.get(id);
      if (!key) return { ...base, skipped: `${adapter.envVar} is not set`, calls: [] };
      return { ...base, calls: await checkProvider(adapter, key, fetchImpl, clock, redact) };
    }),
  );

  const calls = providers.flatMap((provider) => provider.calls);
  const passed = calls.filter((call) => call.ok).length;
  return {
    version: VERSION,
    asOf,
    query: CHECK_QUERY,
    maxResults: CHECK_MAX_RESULTS,
    url: CHECK_URL,
    providers,
    attempted: calls.length,
    passed,
    failed: calls.length - passed,
    ok: calls.length > 0 && passed === calls.length,
  };
}

function describe(call: CheckCall): string {
  if (call.ok) {
    if (call.capability === "search") return `${call.resultCount} result${call.resultCount === 1 ? "" : "s"}`;
    if (call.capability === "scrape") return `markdown, ${call.markdownLength} chars`;
    const balances = call.balances ?? [];
    if (balances.length === 0) return "no balance reported";
    return balances.map((entry) => `${entry.kind} (${entry.fields.length > 0 ? entry.fields.join(", ") : "no fields"})`).join("; ");
  }
  return `${call.status !== undefined ? `HTTP ${call.status}: ` : ""}${call.message ?? "no message"}`;
}

/** The human-readable check report. Holds no titles, URLs, snippets or page content. */
export function formatCheck(report: CheckReport): string {
  const lines = [
    `programscape-router check ${report.version} at ${report.asOf}`,
    `Per provider: one search ("${report.query}", up to ${report.maxResults} results), one scrape (${report.url}), and a balance read where the provider publishes one.`,
    "Each provider is called directly: no routing, no failover, nothing written to the ledger, nothing sent to Programscape.",
    "",
  ];
  for (const provider of report.providers) {
    if (provider.skipped) {
      lines.push(`${provider.provider}: skipped (${provider.skipped})`, "");
      continue;
    }
    lines.push(`${provider.provider} (${provider.envVar})`);
    for (const call of provider.calls) {
      const verdict = call.ok ? "ok" : `FAIL ${call.outcome}`;
      lines.push(`  ${call.capability.padEnd(9)}${verdict.padEnd(22)}${`${call.latencyMs} ms`.padStart(8)}  ${describe(call)}`);
    }
    if (!provider.balanceSupported) lines.push(`  ${"balance".padEnd(9)}${"-".padEnd(30)}  no public balance endpoint (add your credits in config)`);
    lines.push("");
  }
  const skipped = report.providers.filter((provider) => provider.skipped).length;
  if (report.attempted === 0) {
    lines.push("No provider key is set, so nothing was checked. Set at least one of the keys above and run check again.");
  } else {
    lines.push(
      `${report.ok ? "PASS" : "FAIL"}: ${report.passed} of ${report.attempted} calls passed` +
        `${report.failed > 0 ? `, ${report.failed} failed` : ""}` +
        `${skipped > 0 ? `; ${skipped} provider${skipped === 1 ? "" : "s"} skipped (no key)` : ""}.`,
    );
  }
  return lines.join("\n");
}
