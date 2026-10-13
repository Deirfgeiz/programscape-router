/**
 * Opt-in balance sync to the founder's Programscape plan (0149 Phase C), both ways since 0151 (ruling 5).
 *
 * Off until `programscape-router connect`. Then `programscape-router sync` sends, for each provider whose balance the
 * router read live from the provider's own endpoint, exactly { programId, amount, unit, asOf, source: "router" } to
 * the `report_balance` tool, for the one kept, approved program it belongs to, plus `estimate: { daysLeft }` when the
 * router has a runway estimate for that balance (0151 ruling 2). With `programscape.sync: "auto"` in config, the same
 * happens after a balance read, at most once per provider every six hours, without ever holding up a search or scrape.
 *
 * Each sync also keeps, from `my_plan`, the founder's own expiration date and award for the approved program each
 * provider maps to, so the order can use those dates (a date in config still wins).
 *
 * Never sent: queries, URLs, page content, provider keys, credits entered in config, or anything else.
 */
import type { RouterConfig } from "../config.js";
import { ADAPTERS, type FetchLike } from "../providers/index.js";
import type { Balance, ProviderId } from "../types.js";
import { type CallTool, Connection, RECONNECT_MESSAGE, REMOTE_UNCERTAIN_MESSAGE } from "./connection.js";
import { ProgramscapeError, programscapeFetch } from "./guard.js";
import type { RunwayEstimate } from "../runway.js";
import { type LiveBalance, amountIssue, liveBalance, mapProgram, planDatesByProvider, readPlanPrograms } from "./plan.js";
import {
  type PlanDates,
  type ProviderSyncRecord,
  type SyncState,
  hasTokenFile,
  readConnectionState,
  readSyncState,
  writeSyncState,
} from "./store.js";

export const AUTO_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
const PENDING_MESSAGE = "Programscape sign-in is waiting for browser consent. Run `programscape-router disconnect` to cancel it.";
const AUTO_SYNC_TIMEOUT_MS = 30_000;
/** The most days of runway report_balance takes (founder-ecosystem#541). A longer estimate isn't sent. */
export const MAX_ESTIMATE_DAYS = 3650;

/** "manual": only on `programscape-router sync`. "auto": also after a balance read, at most every 6 hours per provider. */
export type SyncMode = "manual" | "auto";

export interface BalanceReport {
  programId: string;
  amount: number;
  unit: LiveBalance["unit"];
  asOf: string;
  source: "router";
  /** The router's runway estimate for this balance, when it has one (0151 ruling 2). Labelled as an estimate on the plan. */
  estimate?: { daysLeft: number };
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
  /** The router's runway estimates for these balances, worked out locally. */
  runway?: readonly RunwayEstimate[];
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
   * `runway` is asked for only when a sync is due.
   */
  afterBalanceRead(provider: ProviderId, balances: readonly Balance[], runway?: () => Promise<readonly RunwayEstimate[]>): Promise<void>;
  /**
   * The founder's own dates per provider from the last read of their plan, from local files only. Empty unless
   * connected.
   */
  planDates(): Promise<Partial<Record<ProviderId, PlanDates>>>;
  /** Resolves when background syncs and state writes have finished. */
  flush(): Promise<void>;
}

function hasLiveEndpoint(provider: ProviderId): boolean {
  return ADAPTERS[provider].balance !== undefined;
}

/** What `report_balance` said it stored. A `note` means the plan already held a later reading: success, no change. */
function syncedMessage(stored: unknown, balance: LiveBalance, programId: string, estimate?: { daysLeft: number }): string {
  const output = typeof stored === "object" && stored !== null ? (stored as Record<string, unknown>) : {};
  const name = typeof output.name === "string" && output.name.length > 0 && output.name !== programId ? `${output.name} (${programId})` : programId;
  if (typeof output.note === "string") {
    return `Already current: your plan holds a later reading for ${name} than this one (read ${balance.asOf}), so nothing changed.`;
  }
  if (output.unchanged === true) return `Already current: ${balance.amount} ${balance.unit} (read ${balance.asOf}) is what ${name} shows on your plan.`;
  return `Synced ${balance.amount} ${balance.unit} (read ${balance.asOf})${estimate ? `, with the runway estimate (${estimate.daysLeft} days),` : ""} to ${name}.`;
}

/**
 * Calls report_balance. A plan that doesn't take an estimate yet (before founder-ecosystem#541) may refuse the whole
 * call over it, so a refused or failed call that carried one is tried once more without it.
 */
async function reportBalance(call: CallTool, report: BalanceReport): Promise<{ stored: unknown; estimateSent: boolean }> {
  try {
    return { stored: await call("report_balance", { ...report }), estimateSent: report.estimate !== undefined };
  } catch (error) {
    const retry = report.estimate !== undefined && error instanceof ProgramscapeError && error.kind !== "rejected" && error.status === undefined;
    if (!retry) throw error;
    const { estimate: _estimate, ...plain } = report;
    return { stored: await call("report_balance", { ...plain }), estimateSent: false };
  }
}

/** The estimate sent with `balance`: the one for the same label and unit, unless it lasts past the period or is too long. */
export function estimateFor(balance: LiveBalance, runway: readonly RunwayEstimate[] | undefined): { daysLeft: number } | undefined {
  const match = runway?.find((entry) => entry.label === balance.label && entry.unit === balance.unit);
  if (!match || match.lastsPastPeriodEnd !== undefined || match.daysLeft > MAX_ESTIMATE_DAYS) return undefined;
  return { daysLeft: match.daysLeft };
}

/** What the plan's dates do for this provider, in words, or undefined when the plan gives it none. */
function planDatesNote(provider: ProviderId, dates: PlanDates | undefined, config: RouterConfig): string | undefined {
  if (!dates?.expiresOn) return undefined;
  const name = ADAPTERS[provider].name;
  const configDated = (config.providers?.[provider]?.credits ?? []).some((credit) => credit.expiresOn !== undefined);
  return configDated
    ? `Your plan's expiration date for ${dates.programId} is ${dates.expiresOn}; the date in your config wins for ${name}.`
    : `Your plan's expiration date for ${dates.programId}, ${dates.expiresOn}, places ${name} under credits ending first.`;
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
  });

  /** Removes token material from a message, whatever produced it. */
  function clean(message: string): string {
    let text = message;
    for (const secret of [...connection.secrets()].sort((a, b) => b.length - a.length)) {
      if (secret.length > 0) text = text.split(secret).join("[redacted]");
    }
    return text;
  }

  async function connected(): Promise<boolean> {
    return (await readConnectionState(env))?.phase === "connected" && (await hasTokenFile(env));
  }

  async function run(readings: readonly ProviderReading[]): Promise<SyncResult[]> {
    const results: SyncResult[] = [];
    const due: Array<{ provider: ProviderId; balance: LiveBalance; estimate: { daysLeft: number } | undefined }> = [];
    for (const reading of readings) {
      if (!hasLiveEndpoint(reading.provider)) {
        results.push(skipped(reading.provider));
        continue;
      }
      const balance = liveBalance(reading.balances);
      const shownOnly = reading.balances.find((entry) => entry.source === "provider" && entry.informational);
      if (!balance && shownOnly) {
        // Never sent: a $0 that leaves out free credits would tell the plan the credits are gone.
        results.push({
          provider: reading.provider,
          outcome: "skipped",
          message: `Not synced. ${ADAPTERS[reading.provider].name} reported ${shownOnly.remaining ?? "no"} ${shownOnly.unit ?? ""} for "${shownOnly.label}", which leaves out free credits it doesn't report, so it isn't sent to your plan.`.replace(/ {2,}/g, " "),
        });
        continue;
      }
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
      due.push({ provider: reading.provider, balance, estimate: estimateFor(balance, reading.runway) });
    }
    if (readings.length === 0) return results;

    // The plan is read even when no balance is due: its dates order providers that publish no balance (0151 ruling 5).
    await connection.session(async (call) => {
      const programs = readPlanPrograms(await call("my_plan", {}));
      const overrides = Object.fromEntries(Object.entries(config.providers ?? {}).map(([id, settings]) => [id, settings?.programscapeProgram]));
      const dates = planDatesByProvider(programs, overrides);
      // A state file that can't be written costs the dates, never the balance reports.
      await updateState((state) => {
        state.plan = { readAt: now().toISOString(), dates };
      }).catch(() => undefined);
      for (const { provider, balance, estimate } of due) {
        const mapping = mapProgram(provider, programs, config.providers?.[provider]?.programscapeProgram);
        if (mapping.kind === "unmapped") {
          results.push({ provider, outcome: "unmapped", message: `Not synced. ${mapping.message}` });
          continue;
        }
        // Exactly these five fields (and the estimate, when there is one), and nothing else, leave for Programscape.
        const report: BalanceReport = {
          programId: mapping.programId,
          amount: balance.amount,
          unit: balance.unit,
          asOf: balance.asOf,
          source: "router",
          ...(estimate ? { estimate } : {}),
        };
        try {
          const { stored, estimateSent } = await reportBalance(call, report);
          results.push({ provider, outcome: "synced", programId: mapping.programId, message: syncedMessage(stored, balance, mapping.programId, estimateSent ? report.estimate : undefined) });
        } catch (error) {
          if (error instanceof ProgramscapeError && error.kind === "refused") {
            results.push({ provider, outcome: "refused", programId: mapping.programId, message: `Programscape refused it: ${error.message}` });
          } else {
            throw error;
          }
        }
      }
      for (const result of results) {
        const note = planDatesNote(result.provider, dates[result.provider], config);
        if (note) result.message = `${result.message} ${note}`;
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
      const connectionState = await readConnectionState(env);
      const on = connectionState?.phase === "connected" && (await hasTokenFile(env));
      return {
        sync: on ? "on" : "off",
        mode,
        ...(state.lastSyncedAt && on ? { lastSyncedAt: state.lastSyncedAt } : {}),
        ...(connectionState?.phase === "cleanup-needed" ? { note: REMOTE_UNCERTAIN_MESSAGE } : {}),
        ...(connectionState?.phase === "sync-off" ? { note: RECONNECT_MESSAGE } : {}),
        ...(connectionState?.phase === "awaiting-consent" ? { note: PENDING_MESSAGE } : {}),
        providers: on
          ? Object.entries(state.providers).map(([provider, entry]) => ({ provider: provider as ProviderId, ...(entry as ProviderSyncRecord) }))
          : [],
      };
    },

    async sync(readings) {
      if (!(await connected())) {
        const state = await readConnectionState(env);
        throw new ProgramscapeError("rejected", state?.phase === "cleanup-needed" ? REMOTE_UNCERTAIN_MESSAGE : state?.phase === "sync-off" ? RECONNECT_MESSAGE : state?.phase === "awaiting-consent" ? PENDING_MESSAGE : "Programscape sync is off. Run `programscape-router connect` first.");
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

    async planDates() {
      if ((await readConnectionState(env))?.phase !== "connected") return {};
      return (await readSyncState(env)).plan?.dates ?? {};
    },

    afterBalanceRead(provider, balances, runway) {
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
        const reading: ProviderReading = { provider, balances, ...(runway ? { runway: await runway().catch(() => []) } : {}) };
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
