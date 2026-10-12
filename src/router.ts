import { type RouterConfig, loadConfig } from "./config.js";
import { type KeySource, type ResolvedKeys, keysFromEnv } from "./keys.js";
import { Ledger, defaultLedgerPath } from "./ledger.js";
import { type CapabilityOrder, type ProviderStanding, type SkippedEntry, computeOrder } from "./order.js";
import { type BalanceSync, type ProgramscapeSyncStatus, type ProviderReading, type SyncResult, createBalanceSync } from "./programscape/sync.js";
import { ADAPTERS, type CallContext, type FetchLike, ProviderCallError, type ProviderAdapter, supports } from "./providers/index.js";
import {
  type Attempt,
  type Balance,
  CAPABILITIES,
  type Capability,
  type OrderRule,
  PROVIDER_IDS,
  type ProviderId,
  type Routing,
  type ScrapeRequest,
  type ScrapeResponse,
  type ScrapeResult,
  type SearchRequest,
  type SearchResponse,
  type SearchResult,
} from "./types.js";

/** Options for createRouter. All are optional; the defaults read keys from process.env and config from disk. */
export interface RouterOptions {
  /** Where keys (and paths) are read from. Defaults to process.env. Keys are only ever sent to their own provider. */
  env?: NodeJS.ProcessEnv;
  /**
   * Keys already resolved, for example by resolveKeys() from the environment and the OS keychain. When omitted,
   * keys come from `env` only. The CLI and MCP server pass keys resolved at startup.
   */
  keys?: ResolvedKeys;
  /** A config object. When omitted, the config file is looked up (see loadConfig). */
  config?: RouterConfig;
  /** Directory the ./programscape-router.json lookup starts from. Defaults to process.cwd(). */
  cwd?: string;
  /** Defaults to the global fetch. */
  fetch?: FetchLike;
  /** Path of the counts-only ledger, or false for none. Defaults to the XDG state directory. */
  ledgerPath?: string | false;
  /** Where notices go (never keys, queries or content). Defaults to stderr. */
  log?: (message: string) => void;
  /** The clock used for end dates and the ledger day. Defaults to the system clock. */
  now?: () => Date;
}

/** One provider in router.status(). */
export interface ProviderStatus {
  id: ProviderId;
  name: string;
  enabled: boolean;
  /** The environment variable its key is read from (and its account name in the OS keychain). */
  keyEnvVar: string;
  /** Where its key came from: the environment, the OS keychain, or none. Never the key itself. */
  keySource: KeySource;
  capabilities: Capability[];
  /** From config: whether you pay as you go with this provider. */
  paid?: boolean;
  /** Why it was switched off for this session (for example, the key was refused). */
  disabled?: string;
  /** Set when it reported its credits spent this session; skipped until `until`, or for the session. */
  exhausted?: { since: string; until?: string; reason: string };
  /** Each balance on its own, in its own unit. Never added together. */
  balances: Balance[];
  /** Why no live balance is shown, when none is. */
  balanceNote?: string;
  /** The official API documentation its adapter was built from. */
  docs: string[];
}

/** What router.status() returns, and what `programscape-router status --json` prints. */
export interface RouterStatus {
  asOf: string;
  configPath: string | null;
  ledgerPath: string | null;
  providers: ProviderStatus[];
  /** Why the OS keychain could not be read at startup, when a key was looked for there and it could not be. */
  keychainNote?: string;
  order: Record<Capability, CapabilityOrder>;
  /** The opt-in balance sync to the founder's Programscape plan, from local files only (no network call). */
  programscape: ProgramscapeSyncStatus;
}

/** A router made by createRouter. */
export interface Router {
  /** Searches through the first provider in the order that answers, failing over as the README describes. Throws RouterError. */
  search(request: SearchRequest): Promise<SearchResponse>;
  /** Fetches one page as markdown, the same way. Throws RouterError. */
  scrape(request: ScrapeRequest): Promise<ScrapeResponse>;
  /** Enabled providers, the order per capability with reasons, and balances with their read time. */
  status(options?: { refresh?: boolean }): Promise<RouterStatus>;
  /**
   * Re-reads live balances and sends them to the founder's Programscape plan (after `connect`). Only
   * { programId, amount, unit, asOf, source: "router" } is sent, for balances read from a provider's own endpoint.
   */
  syncBalances(): Promise<SyncResult[]>;
  /** Resolves when pending ledger writes and background syncs have finished. */
  flush(): Promise<void>;
  /** The config file in use, or null when none was found (or a config object was passed). */
  readonly configPath: string | null;
}

/**
 * invalid_request: the request itself was malformed (empty query, bad URL); no provider was called.
 * no_provider: no provider is available for the capability (no key, switched off, spent, or not in your order).
 * bad_request: a provider rejected the request (400/422); no other provider was tried.
 * all_failed: every provider in the order was tried and failed.
 */
export type RouterErrorCode = "invalid_request" | "no_provider" | "bad_request" | "all_failed";

/** Thrown by search and scrape. `routing` lists every provider tried and every provider skipped. */
export class RouterError extends Error {
  readonly code: RouterErrorCode;
  readonly routing: { rule: OrderRule; tried: Attempt[]; skipped: SkippedEntry[] } | undefined;

  constructor(
    code: RouterErrorCode,
    message: string,
    routing?: { rule: OrderRule; tried: Attempt[]; skipped: SkippedEntry[] },
  ) {
    super(message);
    this.name = "RouterError";
    this.code = code;
    this.routing = routing;
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;
const SCRAPE_TIMEOUT_MS = 60_000;
const BALANCE_TIMEOUT_MS = 10_000;

interface BalanceCache {
  at: number;
  balances: Balance[];
  note?: string;
}

/** Creates a router. Reads keys from the environment and the config file unless options say otherwise. Throws ConfigError on an invalid config. */
export function createRouter(options: RouterOptions = {}): Router {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const log = options.log ?? ((message: string) => process.stderr.write(`programscape-router: ${message}\n`));
  const located = options.config ? { path: undefined, config: options.config } : loadConfig(env, options.cwd);
  const config = located.config;
  const configPath = located.path ?? null;
  const ledgerPath = options.ledgerPath === false ? null : (options.ledgerPath ?? defaultLedgerPath(env));
  const ledger = ledgerPath ? new Ledger(ledgerPath, log) : undefined;
  // Off until `connect`; with `programscape.sync: "auto"`, runs in the background after a balance read.
  const balanceSync: BalanceSync = createBalanceSync({ env, config, fetch: fetchImpl, now, log });

  // Read once, at creation. An environment variable wins over the keychain.
  const resolvedKeys = options.keys ?? keysFromEnv(env);
  const keys = new Map<ProviderId, string>();
  for (const id of PROVIDER_IDS) {
    const key = resolvedKeys.keys[id]?.trim();
    if (key) keys.set(id, key);
  }

  const disabled = new Map<ProviderId, string>();
  const exhausted = new Map<ProviderId, { since: string; until?: string; reason: string }>();
  const balanceCache = new Map<ProviderId, BalanceCache>();
  const inflight = new Map<ProviderId, Promise<BalanceCache>>();

  function redact(message: string): string {
    let clean = message;
    // Every key, however short, longest first so one key inside another is still caught.
    for (const key of [...keys.values()].sort((a, b) => b.length - a.length)) {
      if (key.length > 0) clean = clean.split(key).join("[redacted]");
    }
    return clean.length > 500 ? `${clean.slice(0, 497)}...` : clean;
  }

  function context(id: ProviderId, timeoutMs: number): CallContext {
    const key = keys.get(id);
    if (!key) throw new Error(`no key for ${id}`);
    return { key, fetch: fetchImpl, timeoutMs };
  }

  function disable(id: ProviderId, status: number | undefined): void {
    const adapter = ADAPTERS[id];
    const reason = `${adapter.name} refused the key in ${adapter.envVar}${status ? ` (HTTP ${status})` : ""}; disabled for this session.`;
    if (!disabled.has(id)) log(`${reason} Check the key and restart.`);
    disabled.set(id, reason);
  }

  function markExhausted(id: ProviderId, status: number | undefined): void {
    const adapter = ADAPTERS[id];
    const periodEnd = balanceCache
      .get(id)
      ?.balances.find((balance) => balance.source === "provider" && balance.kind === "credits" && balance.endsOn)?.endsOn;
    const since = now().toISOString();
    const reason = `${adapter.name} reported its credits spent${status ? ` (HTTP ${status})` : ""} at ${since}.`;
    exhausted.set(id, { since, ...(periodEnd ? { until: periodEnd } : {}), reason });
    balanceCache.delete(id);
    log(
      periodEnd
        ? `${adapter.name} reported its credits spent; skipping it until its billing period ends (${periodEnd}).`
        : `${adapter.name} reported its credits spent; skipping it for the rest of this session.`,
    );
  }

  async function readBalance(id: ProviderId, refresh: boolean, autoSync = true): Promise<BalanceCache> {
    const adapter = ADAPTERS[id];
    if (!adapter.balance || !keys.has(id) || disabled.has(id)) return { at: 0, balances: [] };
    const cached = balanceCache.get(id);
    const ttl = adapter.balanceTtlMs ?? 5 * 60_000;
    if (cached && !refresh && now().getTime() - cached.at < ttl) return cached;
    const pending = inflight.get(id);
    if (pending) return pending;
    const read = (async (): Promise<BalanceCache> => {
      try {
        const reading = await adapter.balance!(context(id, BALANCE_TIMEOUT_MS));
        const entry = { at: now().getTime(), balances: reading.balances };
        balanceCache.set(id, entry);
        // Fire and forget: never awaited, so a search or scrape never waits on Programscape.
        if (autoSync) void balanceSync.afterBalanceRead(id, reading.balances);
        return entry;
      } catch (error) {
        if (error instanceof ProviderCallError && error.outcome === "unauthorized") disable(id, error.status);
        const outcome = error instanceof ProviderCallError ? error.outcome : "provider_error";
        const entry = { at: now().getTime(), balances: [], note: `Could not read the balance (${outcome}); treated as unknown.` };
        balanceCache.set(id, entry);
        return entry;
      } finally {
        inflight.delete(id);
      }
    })();
    inflight.set(id, read);
    return read;
  }

  function configBalances(adapter: ProviderAdapter): Balance[] {
    return (config.providers?.[adapter.id]?.credits ?? []).map((credit) => ({
      label: credit.label ?? `${adapter.name} credits you entered`,
      kind: "credits" as const,
      ...(credit.unit ? { unit: credit.unit } : {}),
      ...(credit.remaining !== undefined ? { remaining: credit.remaining } : {}),
      ...(credit.award !== undefined ? { total: credit.award } : {}),
      ...(credit.expiresOn ? { endsOn: credit.expiresOn } : {}),
      source: "config" as const,
    }));
  }

  async function standings(refresh: boolean): Promise<Map<ProviderId, ProviderStanding & { balanceNote?: string }>> {
    const readings = await Promise.all(PROVIDER_IDS.map((id) => readBalance(id, refresh)));
    const result = new Map<ProviderId, ProviderStanding & { balanceNote?: string }>();
    PROVIDER_IDS.forEach((id, index) => {
      const adapter = ADAPTERS[id];
      const reading = readings[index] as BalanceCache;
      const paid = config.providers?.[id]?.paid;
      const disabledReason = disabled.get(id);
      const exhaustedState = exhausted.get(id);
      result.set(id, {
        id,
        enabled: keys.has(id),
        envVar: adapter.envVar,
        ...(disabledReason ? { disabled: disabledReason } : {}),
        ...(exhaustedState ? { exhausted: exhaustedState } : {}),
        ...(paid !== undefined ? { paid } : {}),
        balances: [...configBalances(adapter), ...reading.balances],
        ...(reading.note ? { balanceNote: reading.note } : {}),
      });
    });
    return result;
  }

  function orderFor(capability: Capability, all: Map<ProviderId, ProviderStanding>): CapabilityOrder {
    const candidates = PROVIDER_IDS.filter((id) => supports(ADAPTERS[id], capability)).map(
      (id) => all.get(id) as ProviderStanding,
    );
    return computeOrder(capability, candidates, config.order?.[capability], now());
  }

  async function route<T>(
    capability: Capability,
    call: (adapter: ProviderAdapter, ctx: CallContext) => Promise<T>,
    timeoutMs: number,
  ): Promise<{ value: T; routing: Routing }> {
    const order = orderFor(capability, await standings(false));
    const tried: Attempt[] = [];
    const base = { rule: order.rule, skipped: order.skipped };

    if (order.entries.length === 0) {
      const why = order.skipped.map((entry) => `${entry.provider}: ${entry.reason}`).join(" ");
      throw new RouterError("no_provider", `No provider is available for ${capability}. ${why}`.trim(), { ...base, tried });
    }

    for (const entry of order.entries) {
      const id = entry.provider;
      const adapter = ADAPTERS[id];
      try {
        const value = await call(adapter, context(id, timeoutMs));
        tried.push({ provider: id, outcome: "ok" });
        void ledger?.record(id, capability, "ok", now());
        return { value, routing: { provider: id, reason: entry.reason, rule: order.rule, tried } };
      } catch (error) {
        const failure =
          error instanceof ProviderCallError ? error : new ProviderCallError("provider_error", "The adapter failed unexpectedly");
        tried.push({
          provider: id,
          outcome: failure.outcome,
          ...(failure.status !== undefined ? { status: failure.status } : {}),
          message: redact(failure.message),
        });
        void ledger?.record(id, capability, failure.outcome, now());
        if (failure.outcome === "exhausted") markExhausted(id, failure.status);
        else if (failure.outcome === "unauthorized") disable(id, failure.status);
        else if (failure.outcome === "bad_request") {
          throw new RouterError(
            "bad_request",
            `${adapter.name} rejected the request: ${redact(failure.message)}`,
            { ...base, tried },
          );
        }
      }
    }

    const summary = tried.map((attempt) => `${attempt.provider}: ${attempt.outcome}`).join(", ");
    throw new RouterError("all_failed", `Every provider for ${capability} failed (${summary}).`, { ...base, tried });
  }

  const timeoutMs = config.timeoutMs;

  return {
    configPath,

    async search(request) {
      const query = typeof request?.query === "string" ? request.query.trim() : "";
      if (query.length === 0) throw new RouterError("invalid_request", "search needs a non-empty query.");
      if (request.maxResults !== undefined && !(Number.isInteger(request.maxResults) && request.maxResults >= 1)) {
        throw new RouterError("invalid_request", "maxResults must be a whole number of at least 1.");
      }
      const { value, routing } = await route<SearchResult[]>(
        "search",
        (adapter, ctx) => (adapter.search as NonNullable<ProviderAdapter["search"]>)({ ...request, query }, ctx),
        timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
      // Each adapter asks for at most this many; trimming here keeps the cap even if a provider ignores it.
      return { results: value.slice(0, request.maxResults ?? 10), routing };
    },

    async scrape(request) {
      const url = typeof request?.url === "string" ? request.url.trim() : "";
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new RouterError("invalid_request", "scrape needs an absolute http(s) URL.");
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new RouterError("invalid_request", "scrape needs an absolute http(s) URL.");
      }
      const { value, routing } = await route<ScrapeResult>(
        "scrape",
        (adapter, ctx) => (adapter.scrape as NonNullable<ProviderAdapter["scrape"]>)({ url }, ctx),
        timeoutMs ?? SCRAPE_TIMEOUT_MS,
      );
      return { result: value, routing };
    },

    async status(statusOptions = {}) {
      const all = await standings(statusOptions.refresh ?? false);
      const providers: ProviderStatus[] = PROVIDER_IDS.map((id) => {
        const adapter = ADAPTERS[id];
        const standing = all.get(id) as ProviderStanding & { balanceNote?: string };
        return {
          id,
          name: adapter.name,
          enabled: standing.enabled,
          keyEnvVar: adapter.envVar,
          keySource: keys.has(id) ? resolvedKeys.sources[id] : "none",
          capabilities: CAPABILITIES.filter((capability) => supports(adapter, capability)),
          ...(standing.paid !== undefined ? { paid: standing.paid } : {}),
          ...(standing.disabled ? { disabled: standing.disabled } : {}),
          ...(standing.exhausted ? { exhausted: standing.exhausted } : {}),
          balances: standing.balances,
          ...(standing.balanceNote
            ? { balanceNote: standing.balanceNote }
            : standing.enabled && !adapter.balance
              ? { balanceNote: `${adapter.name} publishes no balance endpoint; only credits from your config are shown.` }
              : {}),
          docs: adapter.docs,
        };
      });
      return {
        asOf: now().toISOString(),
        configPath,
        ledgerPath,
        providers,
        ...(resolvedKeys.keychainNote ? { keychainNote: resolvedKeys.keychainNote } : {}),
        order: { search: orderFor("search", all), scrape: orderFor("scrape", all) },
        programscape: await balanceSync.status(),
      };
    },

    async syncBalances() {
      const enabled = PROVIDER_IDS.filter((id) => keys.has(id) && !disabled.has(id));
      const readings: ProviderReading[] = await Promise.all(
        enabled.map(async (id) => {
          // Only what the provider reported live; credits from config are never part of a reading.
          const reading = await readBalance(id, true, false);
          return { provider: id, balances: reading.balances, ...(reading.note ? { note: reading.note } : {}) };
        }),
      );
      return balanceSync.sync(readings);
    },

    async flush() {
      await Promise.all([ledger?.flush(), balanceSync.flush()]);
    },
  };
}
