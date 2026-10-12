/**
 * Opt-in balance sync to the founder's Programscape plan (0149 Phase C).
 *
 * Off until `programscape-router connect`. Then `programscape-router sync` sends, for each provider whose balance the
 * router read live from the provider's own endpoint, exactly { programId, amount, unit, asOf, source: "router" } to
 * the `report_balance` tool, for the one kept, approved program it belongs to. With `programscape.sync: "auto"` in
 * config, the same happens after a balance read, at most once per provider every six hours, without ever holding up
 * a search or scrape.
 *
 * Never sent: queries, URLs, page content, provider keys, credits entered in config, or anything else.
 */
import type { RouterConfig } from "../config.js";
import { ADAPTERS, type FetchLike } from "../providers/index.js";
import type { Balance, ProviderId } from "../types.js";
import { Connection, RECONNECT_MESSAGE } from "./connection.js";
import { ProgramscapeError, programscapeFetch } from "./guard.js";
import { type LiveBalance, amountIssue, liveBalance, mapProgram, readPlanPrograms } from "./plan.js";
import { type ProviderSyncRecord, type SyncState, hasTokenFile, readSyncState, writeSyncState } from "./store.js";

export const AUTO_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
const AUTO_SYNC_TIMEOUT_MS = 30_000;

/** "manual": only on `programscape-router sync`. "auto": also after a balance read, at most every 6 hours per provider. */
export type SyncMode = "manual" | "auto";

export interface BalanceReport {
  programId: string;
  amount: number;
  unit: LiveBalance["unit"];
  asOf: string;
  source: "router";
}

/** One provider's result from router.syncBalances(). */
export interface SyncResult {
  provider: ProviderId;
  outcome: ProviderSyncRecord["outcome"] | "skipped";
  message: string;
  programId?: string;
}

export interface ProviderReading {
  provider: ProviderId;
  balances: readonly Balance[];
  /** Why the balance could not be read, when it could not. */
  note?: string;
}

/** The balance sync's state, read from local files only. Part of router.status(). */
export interface ProgramscapeSyncStatus {
  sync: "on" | "off";
  mode: SyncMode;
  lastSyncedAt?: string;
  /** Why sync is off, when it turned itself off. */
  note?: string;
  providers: Array<{ provider: ProviderId } & ProviderSyncRecord>;
}

export interface BalanceSyncOptions {
  env: NodeJS.ProcessEnv;
  config: RouterConfig;
  fetch: FetchLike;
  now: () => Date;
  /** stderr. Never given a key, a token, a query or a URL. */
  log: (message: string) => void;
}

export interface BalanceSync {
  readonly mode: SyncMode;
  status(): Promise<ProgramscapeSyncStatus>;
  /** Sends the live balances in `readings` now. Manual: no six-hour wait. */
  sync(readings: readonly ProviderReading[]): Promise<SyncResult[]>;
  /**
   * The automatic path, called after a provider's balance is read. Returns at once; the sync (if one is due) runs in
   * the background with a timeout, and any failure is logged once. The returned promise is for tests and flush.
   */
  afterBalanceRead(provider: ProviderId, balances: readonly Balance[]): Promise<void>;
  /** Resolves when background syncs and state writes have finished. */
  flush(): Promise<void>;
}

function hasLiveEndpoint(provider: ProviderId): boolean {
  return ADAPTERS[provider].balance !== undefined;
}

/** What `report_balance` said it stored. A `note` means the plan already held a later reading: success, no change. */
function syncedMessage(stored: unknown, balance: LiveBalance, programId: string): string {
  const output = typeof stored === "object" && stored !== null ? (stored as Record<string, unknown>) : {};
  const name = typeof output.name === "string" && output.name.length > 0 && output.name !== programId ? `${output.name} (${programId})` : programId;
  if (typeof output.note === "string") {
    return `Already current: your plan holds a later reading for ${name} than this one (read ${balance.asOf}), so nothing changed.`;
  }
  if (output.unchanged === true) return `Already current: ${balance.amount} ${balance.unit} (read ${balance.asOf}) is what ${name} shows on your plan.`;
  return `Synced ${balance.amount} ${balance.unit} (read ${balance.asOf}) to ${name}.`;
}

function skipped(provider: ProviderId): SyncResult {
  return {
    provider,
    outcome: "skipped",
    message: `Not synced. ${ADAPTERS[provider].name} publishes no balance endpoint, and credits you entered in config are your own numbers, not a provider's reading; your plan has whatever you entered on programscape.com.`,
  };
}

export function createBalanceSync(options: BalanceSyncOptions): BalanceSync {
  const { env, config, now, log } = options;
  const mode: SyncMode = config.programscape?.sync === "auto" ? "auto" : "manual";
  const guarded = programscapeFetch(options.fetch, REQUEST_TIMEOUT_MS);
  let stateQueue: Promise<unknown> = Promise.resolve();
  const background = new Set<Promise<void>>();
  const inflight = new Set<ProviderId>();
  let warned = false;

  function updateState(change: (state: SyncState) => void): Promise<void> {
    const next = stateQueue.then(async () => {
      const state = await readSyncState(env);
      change(state);
      await writeSyncState(env, state);
    });
    stateQueue = next.catch(() => undefined);
    return next;
  }

  const connection = new Connection({
    env,
    fetch: guarded,
    now,
    onRejected: () =>
      updateState((state) => {
        state.off = { since: now().toISOString(), reason: RECONNECT_MESSAGE };
      }).catch(() => undefined),
  });

  /** Removes token material from a message, whatever produced it. */
  function clean(message: string): string {
    let text = message;
    for (const secret of connection.secrets()) {
      if (secret.length >= 4) text = text.split(secret).join("[redacted]");
    }
    return text;
  }

  async function connected(): Promise<boolean> {
    const state = await readSyncState(env);
    return !state.off && (await hasTokenFile(env));
  }

  async function run(readings: readonly ProviderReading[]): Promise<SyncResult[]> {
    const results: SyncResult[] = [];
    const due: Array<{ provider: ProviderId; balance: LiveBalance }> = [];
    for (const reading of readings) {
      if (!hasLiveEndpoint(reading.provider)) {
        results.push(skipped(reading.provider));
        continue;
      }
      const balance = liveBalance(reading.balances);
      if (!balance) {
        results.push({
          provider: reading.provider,
          outcome: "failed",
          message: `No live balance to sync. ${reading.note ?? `${ADAPTERS[reading.provider].name} did not report a remaining amount in usd, credits or requests.`}`,
        });
        continue;
      }
      const issue = amountIssue(balance.amount, balance.unit);
      if (issue) {
        results.push({
          provider: reading.provider,
          outcome: "failed",
          message: `Not synced. ${ADAPTERS[reading.provider].name} reported ${balance.amount} ${balance.unit}, which a plan can't record as it is (${issue}), and the router never rounds it.`,
        });
        continue;
      }
      due.push({ provider: reading.provider, balance });
    }
    if (due.length === 0) return results;

    await connection.session(async (call) => {
      const programs = readPlanPrograms(await call("my_plan", {}));
      for (const { provider, balance } of due) {
        const mapping = mapProgram(provider, programs, config.providers?.[provider]?.programscapeProgram);
        if (mapping.kind === "unmapped") {
          results.push({ provider, outcome: "unmapped", message: `Not synced. ${mapping.message}` });
          continue;
        }
        // Exactly these five fields, and nothing else, leave for Programscape.
        const report: BalanceReport = {
          programId: mapping.programId,
          amount: balance.amount,
          unit: balance.unit,
          asOf: balance.asOf,
          source: "router",
        };
        try {
          const stored = await call("report_balance", { ...report });
          results.push({ provider, outcome: "synced", programId: mapping.programId, message: syncedMessage(stored, balance, mapping.programId) });
        } catch (error) {
          if (error instanceof ProgramscapeError && error.kind === "refused") {
            results.push({ provider, outcome: "refused", programId: mapping.programId, message: `Programscape refused it: ${error.message}` });
          } else {
            throw error;
          }
        }
      }
    });
    return results;
  }

  async function record(results: readonly SyncResult[]): Promise<void> {
    const at = now().toISOString();
    await updateState((state) => {
      for (const result of results) {
        if (result.outcome === "skipped") continue;
        const previous = state.providers[result.provider];
        state.providers[result.provider] = {
          attemptedAt: at,
          outcome: result.outcome,
          message: clean(result.message),
          ...(result.outcome === "synced" ? { syncedAt: at } : previous?.syncedAt ? { syncedAt: previous.syncedAt } : {}),
          ...(result.programId ? { programId: result.programId } : {}),
        };
        if (result.outcome === "synced") state.lastSyncedAt = at;
      }
    });
  }

  /** The same failure for every provider with a live balance, when the call to Programscape as a whole failed. */
  function failedAll(readings: readonly ProviderReading[], error: unknown): SyncResult[] {
    const message =
      error instanceof ProgramscapeError ? clean(error.message) : "Something went wrong talking to Programscape.";
    return readings
      .filter((reading) => hasLiveEndpoint(reading.provider))
      .map((reading) => ({ provider: reading.provider, outcome: "failed" as const, message: `Not synced. ${message}` }));
  }

  return {
    mode,

    async status() {
      const state = await readSyncState(env);
      const on = !state.off && (await hasTokenFile(env));
      return {
        sync: on ? "on" : "off",
        mode,
        ...(state.lastSyncedAt && on ? { lastSyncedAt: state.lastSyncedAt } : {}),
        ...(state.off ? { note: state.off.reason } : {}),
        providers: on
          ? Object.entries(state.providers).map(([provider, entry]) => ({ provider: provider as ProviderId, ...(entry as ProviderSyncRecord) }))
          : [],
      };
    },

    async sync(readings) {
      if (!(await connected())) {
        const state = await readSyncState(env);
        throw new ProgramscapeError("rejected", state.off?.reason ?? "Programscape sync is off. Run `programscape-router connect` first.");
      }
      let results: SyncResult[];
      try {
        results = await run(readings);
      } catch (error) {
        // Sign-in refused: sync has turned itself off, and the caller says so.
        if (error instanceof ProgramscapeError && error.kind === "rejected") throw new ProgramscapeError("rejected", clean(error.message));
        results = [
          ...readings.filter((reading) => !hasLiveEndpoint(reading.provider)).map((reading) => skipped(reading.provider)),
          ...failedAll(readings, error),
        ];
      }
      await record(results);
      return results;
    },

    afterBalanceRead(provider, balances) {
      if (mode !== "auto" || !hasLiveEndpoint(provider) || inflight.has(provider)) return Promise.resolve();
      inflight.add(provider);
      const task = (async () => {
        if (!(await connected())) return;
        const state = await readSyncState(env);
        const last = state.providers[provider]?.attemptedAt;
        if (last && now().getTime() - Date.parse(last) < AUTO_SYNC_INTERVAL_MS) return;
        if (!liveBalance(balances)) return;
        let timer: NodeJS.Timeout | undefined;
        const limit = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new ProgramscapeError("unreachable", "The automatic sync took too long and was dropped.")), AUTO_SYNC_TIMEOUT_MS);
          timer.unref?.();
        });
        const reading: ProviderReading = { provider, balances };
        try {
          const results = await Promise.race([run([reading]), limit]);
          await record(results);
          const result = results[0];
          if (result && result.outcome !== "synced") warnOnce(`Programscape sync for ${provider}: ${clean(result.message)}`);
        } catch (error) {
          // Record the attempt so the six-hour wait applies to failures too.
          await record(failedAll([reading], error)).catch(() => undefined);
          if (error instanceof ProgramscapeError && error.kind === "rejected") warnOnce(clean(error.message));
          else warnOnce(`Programscape sync for ${provider} failed: ${error instanceof ProgramscapeError ? clean(error.message) : "unexpected error"} Searches and scrapes are unaffected.`);
        } finally {
          clearTimeout(timer);
        }
      })()
        .catch(() => undefined)
        .finally(() => {
          inflight.delete(provider);
          background.delete(task);
        });
      background.add(task);
      return task;
    },

    async flush() {
      await Promise.all([...background]);
      await stateQueue;
    },
  };

  function warnOnce(message: string): void {
    if (warned) return;
    warned = true;
    log(message);
  }
}
