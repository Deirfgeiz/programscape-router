/**
 * `programscape-router check`: one live call per provider and capability, made with the founder's own keys.
 *
 * Each adapter is called directly (no routing, no failover), so every provider is tested on its own.
 * The check writes nothing to the ledger. A balance it reads is kept in readings.json, like any live balance read, and
 * the report says how long it lasts at the recent pace (an estimate) where the readings allow. Its only call to
 * Programscape is the public catalog read (catalog.ts: provider ids only, at most once a day, off when the config or
 * environment says so), for the short list of programs that can add more. Its report carries outcomes, HTTP statuses,
 * documented error codes, latencies, counts and lengths only: never a key, a result title, URL, snippet, page content
 * or balance amount. A provider's own error text can echo any of those back (a short key, an amount, a URL, an email),
 * so it is left out unless `verbose` asks for it, and then marked as not for sharing.
 */
import { type ProviderPrograms, readPrograms, short, shortLines } from "./catalog.js";
import { type RouterConfig, missingZones, zonesFor } from "./config.js";
import { type KeySource, type ResolvedKeys, keysFromEnv } from "./keys.js";
import { Readings, defaultReadingsPath } from "./readings.js";
import { runwaysFor } from "./runway.js";
import { ADAPTERS, type CallContext, type FetchLike, ProviderCallError, type ProviderAdapter } from "./providers/index.js";
import { isDocumentedCode, searchTimeout } from "./providers/http.js";
import { type Balance, type Capability, type Outcome, PROVIDER_IDS, type ProviderId } from "./types.js";
import { VERSION } from "./version.js";

/** The query each provider is asked to search for. */
export const CHECK_QUERY = "startup credits";
/** How many results each search asks for. */
export const CHECK_MAX_RESULTS = 3;
/** The page each provider is asked to scrape. */
export const CHECK_URL = "https://example.com";

const SCRAPE_TIMEOUT_MS = 60_000;
const BALANCE_TIMEOUT_MS = 10_000;
const MAX_MESSAGE_LENGTH = 300;

export type CheckCapability = Capability | "balance";

/** What to do about each failure class: our own words, the same for every provider. */
export const CHECK_HINTS: Readonly<Record<Exclude<Outcome, "ok">, string>> = {
  exhausted: "Credits or quota spent. Check the provider's dashboard.",
  rate_limited: "Rate limited. Wait a minute and run check again.",
  unauthorized: "The key was refused. Copy it again from the provider's dashboard and store it again.",
  bad_request: "The provider rejected the request; its API may have changed. Please open an issue with check --json.",
  server_error: "The provider is having trouble. Try again later.",
  timeout: "No answer in time. Try again.",
  network_error: "The provider couldn't be reached. Check your connection, proxy or firewall.",
  fetch_failed: "The provider couldn't fetch the test page.",
  rejected: "The provider refused that content on policy grounds; the key is fine.",
  invalid_response: "An answer the adapter couldn't read; the API may have changed. Please open an issue with check --json.",
  provider_error: "An unexpected answer. Run check --verbose to see the provider's own message (don't share it).",
};

/** The line `--verbose` output starts with. */
export const VERBOSE_WARNING =
  "VERBOSE: this report includes the providers' own error messages. They may contain account details, so don't share it.";

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
  /** balance: our own words about the reading, from the adapter (never the provider's), such as why there is none. */
  note?: string;
  /** For a failure: the provider's error code, only when it is one the provider documents (an allow-list per adapter). */
  code?: string;
  /** For a failure: what to do, from a fixed table (CHECK_HINTS). Never the provider's words. */
  hint?: string;
  /**
   * Only with `verbose`: the provider's own error message, with every key redacted and cut to 300 characters. It may
   * still hold account details (an amount, a URL, an email), so a verbose report is not for sharing.
   */
  providerMessage?: string;
}

export interface CheckProvider {
  provider: ProviderId;
  name: string;
  envVar: string;
  /** Where its key came from: the environment, the OS keychain, or none. Never the key itself. */
  keySource: KeySource;
  /** Set when the provider was not called, and why (no key set, or not set up: Bright Data without its zones). */
  skipped?: string;
  /** Set when part of the provider isn't set up (Bright Data with one of its two zones), and how to fix it. Not called for that part. */
  notSetUp?: string;
  /** False when the provider publishes no balance endpoint, so no balance call was made. */
  balanceSupported: boolean;
  calls: CheckCall[];
  /**
   * How long each balance lasts at the recent pace, from this read and earlier ones in readings.json: always an
   * estimate. Only our own words and a whole number of days; never an amount or the provider's label.
   */
  runway?: Array<{ daysLeft: number; lastsPastPeriodEnd?: string; words: string }>;
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
  /** Why the OS keychain could not be read, when a key was looked for there and it could not be. */
  keychainNote?: string;
  /** True when the report includes providers' own error messages (see VERBOSE_WARNING). */
  verbose: boolean;
  /** Set on a verbose report: don't share it. */
  warning?: string;
  /** Programs that can add more, from Programscape's public catalog (short version). Absent when off or unreadable. */
  programs?: ProviderPrograms[];
}

export interface CheckOptions {
  /** Where keys are read from. Defaults to process.env. Each key is only ever sent to its own provider. */
  env?: Record<string, string | undefined>;
  /** Keys already resolved (for example by resolveKeys(), from the environment and the OS keychain). Defaults to `env` only. */
  keys?: ResolvedKeys;
  /** Defaults to the global fetch. */
  fetch?: FetchLike;
  now?: () => Date;
  /** A millisecond clock for latencies. Defaults to performance.now(). */
  clock?: () => number;
  /** Include each provider's own error message (redacted, but not safe to share). Default false. */
  verbose?: boolean;
  /** The config, read only for the catalog switch (`programscape.catalog`) and Bright Data's zones (`providers.brightdata.zones`). */
  config?: RouterConfig;
  /** Path of readings.json, or false for none. Defaults to the state directory. */
  readingsPath?: string | false;
  /** Path of the catalog cache, or false to turn the catalog off. Defaults to the state directory. */
  catalogPath?: string | false;
}

function redactor(keys: readonly string[]): (message: string) => string {
  // Every key, however short, longest first so one key inside another is still caught.
  const sorted = [...keys].filter((key) => key.length > 0).sort((a, b) => b.length - a.length);
  return (message) => {
    let clean = message;
    for (const key of sorted) clean = clean.split(key).join("[redacted]");
    clean = clean.replace(/\s+/g, " ").trim();
    return clean.length > MAX_MESSAGE_LENGTH ? `${clean.slice(0, MAX_MESSAGE_LENGTH - 3)}...` : clean;
  };
}

async function timed(
  adapter: ProviderAdapter,
  capability: CheckCapability,
  clock: () => number,
  redact: ((message: string) => string) | undefined,
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
        ...(isDocumentedCode(adapter, error.code) ? { code: error.code } : {}),
        latencyMs,
        hint: error.fix ?? CHECK_HINTS[error.outcome],
        ...(redact ? { providerMessage: redact(error.message) } : {}),
      };
    }
    // An adapter bug, not a provider answer. Its message could hold anything, so it is never reported.
    return {
      capability,
      ok: false,
      outcome: "provider_error",
      latencyMs,
      hint: "The adapter failed unexpectedly. Please open an issue with check --json.",
    };
  }
}

async function checkProvider(
  adapter: ProviderAdapter,
  key: string,
  zones: Partial<Record<Capability, string>>,
  fetchImpl: FetchLike,
  clock: () => number,
  redact: ((message: string) => string) | undefined,
): Promise<{ calls: CheckCall[]; balances: Balance[] }> {
  const ctx = (timeoutMs: number): CallContext => ({
    key,
    fetch: fetchImpl,
    timeoutMs,
    ...(Object.keys(zones).length > 0 ? { zones } : {}),
  });
  const missing = missingZones(adapter, zones);
  const calls: CheckCall[] = [];
  let balances: Balance[] = [];
  if (adapter.search && !missing.includes("search")) {
    const search = adapter.search;
    calls.push(
      await timed(adapter, "search", clock, redact, async () => {
        const results = await search({ query: CHECK_QUERY, maxResults: CHECK_MAX_RESULTS }, ctx(searchTimeout(adapter)));
        return { resultCount: results.length };
      }),
    );
  }
  if (adapter.scrape && !missing.includes("scrape")) {
    const scrape = adapter.scrape;
    calls.push(
      await timed(adapter, "scrape", clock, redact, async () => {
        const result = await scrape({ url: CHECK_URL }, ctx(SCRAPE_TIMEOUT_MS));
        return { markdownLength: result.markdown.length };
      }),
    );
  }
  if (adapter.balance) {
    const balance = adapter.balance;
    calls.push(
      await timed(adapter, "balance", clock, redact, async () => {
        const reading = await balance(ctx(BALANCE_TIMEOUT_MS));
        balances = reading.balances;
        return {
          balances: reading.balances.map((entry) => ({
            kind: entry.kind,
            fields: (["remaining", "total", "unit", "endsOn"] as const).filter((field) => entry[field] !== undefined),
          })),
          ...(reading.note ? { note: reading.note } : {}),
        };
      }),
    );
  }
  return { calls, balances };
}

/** Makes one search, one scrape and (where published) one balance read per provider with a key set. */
export async function runCheck(options: CheckOptions = {}): Promise<CheckReport> {
  const env = options.env ?? process.env;
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const now = options.now ?? (() => new Date());
  const clock = options.clock ?? (() => performance.now());

  const resolved = options.keys ?? keysFromEnv(env);
  const keys = new Map<ProviderId, string>();
  for (const id of PROVIDER_IDS) {
    const key = resolved.keys[id]?.trim();
    if (key) keys.set(id, key);
  }
  // Without verbose, no provider text is kept at all, so there is nothing to redact.
  const verbose = options.verbose === true;
  const redact = verbose ? redactor([...keys.values()]) : undefined;
  const asOf = now().toISOString();

  const readingsPath = options.readingsPath === false ? undefined : (options.readingsPath ?? defaultReadingsPath(env));
  const readings = readingsPath ? new Readings(readingsPath) : undefined;

  // Providers run side by side; each provider's own calls run one after another.
  const checked = await Promise.all(
    PROVIDER_IDS.map(async (id): Promise<CheckProvider & { balances: Balance[] }> => {
      const adapter = ADAPTERS[id];
      const key = keys.get(id);
      const base = {
        provider: id,
        name: adapter.name,
        envVar: adapter.envVar,
        keySource: key ? resolved.sources[id] : ("none" as const),
        balanceSupported: adapter.balance !== undefined,
      };
      if (!key) return { ...base, skipped: `no key: set ${adapter.envVar} or run \`programscape-router keys set ${id}\``, calls: [], balances: [] };
      const zones = zonesFor(adapter, options.config ?? {}, env);
      const missing = missingZones(adapter, zones);
      const fix = adapter.zoneFix ?? `Run \`programscape-router keys set ${id}\`.`;
      const parts = missing.map((capability) => (capability === "search" ? "search" : "page-read")).join(" or ");
      if (missing.length > 0 && missing.length === capabilityCount(adapter)) {
        return { ...base, skipped: `not set up: no ${adapter.name} ${parts} zone. ${fix}`, calls: [], balances: [] };
      }
      return {
        ...base,
        ...(missing.length > 0 ? { notSetUp: `no ${adapter.name} ${parts} zone, so it wasn't checked. ${fix}` } : {}),
        ...(await checkProvider(adapter, key, zones, fetchImpl, clock, redact)),
      };
    }),
  );
  for (const entry of checked) void readings?.record(entry.provider, entry.balances, now());
  const file = readings ? await readings.read(now()) : undefined;
  const providers = checked.map(({ balances, ...provider }): CheckProvider => {
    const runway = file ? runwaysFor(provider.name, provider.provider, balances, file.readings) : [];
    return {
      ...provider,
      ...(runway.length > 0
        ? { runway: runway.map((entry) => ({ daysLeft: entry.daysLeft, ...(entry.lastsPastPeriodEnd ? { lastsPastPeriodEnd: entry.lastsPastPeriodEnd } : {}), words: entry.words })) }
        : {}),
    };
  });
  const catalog = await readPrograms(
    { env, ...(options.config ? { config: options.config } : {}), fetch: fetchImpl, now, ...(options.catalogPath !== undefined ? { path: options.catalogPath } : {}) },
    [...keys.keys()],
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
    ...(resolved.keychainNote ? { keychainNote: resolved.keychainNote } : {}),
    verbose,
    ...(verbose ? { warning: VERBOSE_WARNING } : {}),
    ...(catalog ? { programs: catalog.providers.map(short) } : {}),
  };
}

/** How many of search and scrape an adapter has. */
function capabilityCount(adapter: ProviderAdapter): number {
  return (adapter.search ? 1 : 0) + (adapter.scrape ? 1 : 0);
}

function describe(call: CheckCall): string {
  if (call.ok) {
    if (call.capability === "search") return `${call.resultCount} result${call.resultCount === 1 ? "" : "s"}`;
    if (call.capability === "scrape") return `markdown, ${call.markdownLength} chars`;
    const balances = call.balances ?? [];
    if (balances.length === 0) return call.note ?? "no balance reported";
    return balances.map((entry) => `${entry.kind} (${entry.fields.length > 0 ? entry.fields.join(", ") : "no fields"})`).join("; ");
  }
  const parts = [call.status !== undefined ? `HTTP ${call.status}` : undefined, call.code, call.hint].filter(Boolean);
  // Plain ASCII separators: legacy Windows consoles may not show other characters.
  return parts.join(" - ");
}

/** The human-readable check report. Holds no keys, titles, result URLs, snippets, page content or provider text (unless verbose). */
export function formatCheck(report: CheckReport): string {
  const lines = [
    ...(report.warning ? [report.warning, ""] : []),
    `programscape-router check ${report.version} at ${report.asOf}`,
    `Per provider: one search ("${report.query}", up to ${report.maxResults} results), one scrape (${report.url}), and a balance read where the provider publishes one.`,
    "Each provider is called directly: no routing, no failover, nothing written to the ledger. Balances read are kept in readings.json, for the runway estimate.",
    "",
  ];
  for (const provider of report.providers) {
    if (provider.skipped) {
      lines.push(`${provider.provider}: skipped (${provider.skipped})`, "");
      continue;
    }
    lines.push(`${provider.provider} (${provider.envVar}, from ${provider.keySource === "keychain" ? "the OS keychain" : "the environment"})`);
    for (const call of provider.calls) {
      const verdict = call.ok ? "ok" : `FAIL ${call.outcome}`;
      lines.push(`  ${call.capability.padEnd(9)}${verdict.padEnd(22)}${`${call.latencyMs} ms`.padStart(8)}  ${describe(call)}`);
      if (call.providerMessage !== undefined) lines.push(`           provider said (not for sharing): ${call.providerMessage}`);
    }
    if (provider.notSetUp) lines.push(`  not set up: ${provider.notSetUp}`);
    if (!provider.balanceSupported) lines.push(`  ${"balance".padEnd(9)}${"-".padEnd(30)}  no public balance endpoint (add your credits in config)`);
    for (const runway of provider.runway ?? []) lines.push(`  ${"runway".padEnd(9)}${runway.words}`);
    lines.push("");
  }
  if (report.keychainNote) lines.push(`Keychain: ${report.keychainNote}`, "");
  const skipped = report.providers.filter((provider) => provider.skipped).length;
  const notSetUp = report.providers.filter((provider) => provider.skipped?.startsWith("not set up")).length;
  const why = notSetUp === 0 ? "no key" : notSetUp === skipped ? "not set up" : "no key, or not set up";
  if (report.attempted === 0) {
    lines.push(
      notSetUp > 0
        ? "Nothing was checked: no provider key is set, or the providers with one aren't set up yet (see above)."
        : "No provider key is set, so nothing was checked. Set at least one of the keys above and run check again.",
    );
  } else {
    lines.push(
      `${report.ok ? "PASS" : "FAIL"}: ${report.passed} of ${report.attempted} calls passed` +
        `${report.failed > 0 ? `, ${report.failed} failed` : ""}` +
        `${skipped > 0 ? `; ${skipped} provider${skipped === 1 ? "" : "s"} skipped (${why})` : ""}.`,
    );
  }
  const programs = shortLines(report.programs);
  if (programs.length > 0) lines.push("", ...programs);
  if (report.warning) lines.push("", report.warning);
  return lines.join("\n");
}
