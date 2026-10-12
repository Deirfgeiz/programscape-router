/**
 * Local balance readings (0151): each live balance a provider reported for the founder's own key, over time, so the
 * router can work out a recent pace (see runway.ts). Kept in readings.json beside the ledger.
 *
 * A reading holds the provider, the balance's label and unit, the remaining amount, the total when the provider gave
 * one, and when it was read. Nothing else: no key, query, URL, content or call count. Only credits a provider reported
 * live are kept, never credits entered in config. Readings older than 90 days are dropped, and readings taken less
 * than an hour apart are thinned to the latest, so each provider keeps at most 500.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { stateDir } from "./paths.js";
import { writeSecureJson } from "./programscape/store.js";
import { type Balance, PROVIDER_IDS, type ProviderId } from "./types.js";

/** How long a reading is kept. */
export const READINGS_KEEP_DAYS = 90;
/** The most readings kept per provider; the oldest go first. */
export const READINGS_PER_PROVIDER = 500;
/** Readings closer together than this are thinned to the latest one, unless the balance rose between them. */
export const READINGS_SPACING_MS = 60 * 60_000;

const DAY_MS = 86_400_000;

/** One live balance reading. */
export interface Reading {
  provider: ProviderId;
  label: string;
  unit: string;
  remaining: number;
  /** The plan size or award, when the provider reported one. */
  total?: number;
  /** When the provider reported it (ISO 8601). */
  asOf: string;
}

export interface ReadingsFile {
  version: 1;
  about: string;
  readings: Reading[];
}

const ABOUT =
  "programscape-router balance readings: provider, balance label, unit, remaining, total if known, and when it was read. Nothing else.";

/** ~/.local/state/programscape-router/readings.json; %LOCALAPPDATA%\programscape-router\readings.json on Windows. */
export function defaultReadingsPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  return join(stateDir(env, platform), "readings.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** The readings a provider's live balances give: credits it reported, with a unit, a remaining amount and a time. */
export function readingsFrom(provider: ProviderId, balances: readonly Balance[]): Reading[] {
  return balances.flatMap((balance): Reading[] => {
    if (balance.source !== "provider" || balance.kind !== "credits") return [];
    if (!balance.unit || !finite(balance.remaining) || !balance.asOf || Number.isNaN(Date.parse(balance.asOf))) return [];
    return [
      {
        provider,
        label: balance.label,
        unit: balance.unit,
        remaining: balance.remaining,
        ...(finite(balance.total) ? { total: balance.total } : {}),
        asOf: new Date(Date.parse(balance.asOf)).toISOString(),
      },
    ];
  });
}

/** Keep only well-formed readings within 90 days of `now`, oldest first, so nothing else is ever carried forward. */
export function sanitizeReadings(input: unknown, now: Date): ReadingsFile {
  const clean: ReadingsFile = { version: 1, about: ABOUT, readings: [] };
  if (!isRecord(input) || !Array.isArray(input.readings)) return clean;
  const oldest = now.getTime() - READINGS_KEEP_DAYS * DAY_MS;
  for (const entry of input.readings) {
    if (!isRecord(entry)) continue;
    const provider = PROVIDER_IDS.find((id) => id === entry.provider);
    const time = typeof entry.asOf === "string" ? Date.parse(entry.asOf) : Number.NaN;
    if (!provider || typeof entry.label !== "string" || entry.label.length === 0 || entry.label.length > 200) continue;
    if (typeof entry.unit !== "string" || entry.unit.length === 0 || entry.unit.length > 40) continue;
    if (!finite(entry.remaining) || Number.isNaN(time) || time < oldest) continue;
    clean.readings.push({
      provider,
      label: entry.label,
      unit: entry.unit,
      remaining: entry.remaining,
      ...(finite(entry.total) ? { total: entry.total } : {}),
      asOf: new Date(time).toISOString(),
    });
  }
  clean.readings.sort((a, b) => Date.parse(a.asOf) - Date.parse(b.asOf));
  return clean;
}

const sameBalance = (a: Reading, b: Reading) => a.provider === b.provider && a.label === b.label && a.unit === b.unit;

/**
 * Adds `added` to `file` and applies the limits. A new reading replaces the latest one for the same balance when the
 * one before that is less than an hour older and the balance hasn't risen, so the file keeps points about an hour
 * apart plus the newest. Returns the file unchanged (the same object) when nothing new was added.
 */
export function addReadings(file: ReadingsFile, added: readonly Reading[], now: Date): ReadingsFile {
  let readings = [...file.readings];
  let changed = false;
  for (const reading of added) {
    const same = readings.filter((entry) => sameBalance(entry, reading));
    const last = same.at(-1);
    const prev = same.at(-2);
    const time = Date.parse(reading.asOf);
    if (last && Date.parse(last.asOf) >= time) continue; // already have this one, or a later one
    changed = true;
    const thin =
      last !== undefined &&
      prev !== undefined &&
      time - Date.parse(prev.asOf) < READINGS_SPACING_MS &&
      last.remaining <= prev.remaining &&
      reading.remaining <= last.remaining &&
      last.total === prev.total &&
      reading.total === last.total;
    if (thin) readings = readings.filter((entry) => entry !== last);
    readings.push(reading);
  }
  if (!changed) return file;
  const oldest = now.getTime() - READINGS_KEEP_DAYS * DAY_MS;
  readings = readings.filter((entry) => Date.parse(entry.asOf) >= oldest).sort((a, b) => Date.parse(a.asOf) - Date.parse(b.asOf));
  // Per provider, keep the newest READINGS_PER_PROVIDER.
  const kept: Reading[] = [];
  for (const id of PROVIDER_IDS) kept.push(...readings.filter((entry) => entry.provider === id).slice(-READINGS_PER_PROVIDER));
  kept.sort((a, b) => Date.parse(a.asOf) - Date.parse(b.asOf));
  return { version: 1, about: ABOUT, readings: kept };
}

/** readings.json, written atomically. A problem with the file never breaks a search, a status or a check. */
export class Readings {
  readonly path: string;
  private queue: Promise<void> = Promise.resolve();
  private readonly onError: (message: string) => void;
  private warned = false;

  constructor(path: string, onError: (message: string) => void = () => {}) {
    this.path = path;
    this.onError = onError;
  }

  private async load(now: Date): Promise<ReadingsFile> {
    try {
      return sanitizeReadings(JSON.parse(await readFile(this.path, "utf8")), now);
    } catch {
      return sanitizeReadings(undefined, now);
    }
  }

  /** Every reading kept, oldest first, after pending writes have finished. */
  read(now: Date = new Date()): Promise<ReadingsFile> {
    return this.queue.then(() => this.load(now));
  }

  /** Records the live credits in `balances`. Never throws. */
  record(provider: ProviderId, balances: readonly Balance[], now: Date = new Date()): Promise<void> {
    const added = readingsFrom(provider, balances);
    if (added.length === 0) return this.queue;
    this.queue = this.queue.then(async () => {
      try {
        const file = await this.load(now);
        const next = addReadings(file, added, now);
        if (next !== file) await writeSecureJson(this.path, next);
      } catch (error) {
        if (!this.warned) {
          this.warned = true;
          const code = error instanceof Error && "code" in error ? ` (${String((error as { code: unknown }).code)})` : "";
          this.onError(`could not write balance readings at ${this.path}${code}; calls still work.`);
        }
      }
    });
    return this.queue;
  }

  /** Resolves when every pending write has finished. */
  flush(): Promise<void> {
    return this.queue;
  }
}
