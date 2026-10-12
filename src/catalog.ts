/**
 * The programs that can add more (0151 ruling 1): Programscape's public catalog, read on the router's own.
 *
 * What it sends: one GET to https://programscape.com/api/router/programs?providers=<ids>, where <ids> are the providers
 * with a key set, and a plain `programscape-router/<version>` User-Agent. Never a key, query, URL, balance, token or
 * identifier, and no cookie. It goes through the same guard as the sync (programscape.com only, no redirects).
 *
 * How often: at most once a day, kept in catalog.json beside the ledger. The same day, it reads again only when a
 * provider has a key that the day's read didn't ask about. A failed read counts as a read, so an unreachable or
 * missing endpoint costs one short attempt a day. Any failure is silent: the router says nothing about programs and
 * works as before. A list from an earlier read is shown for up to a week.
 *
 * Turned off by `"programscape": { "catalog": false }` in config, or PROGRAMSCAPE_ROUTER_CATALOG=off. Off means no
 * read, and nothing about programs anywhere.
 *
 * The list is Programscape's, in its order (alphabetical). The router never ranks it, and never says the founder
 * qualifies: each provider decides.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RouterConfig } from "./config.js";
import { stateDir } from "./paths.js";
import { PROGRAMSCAPE_ORIGIN, isProgramscapeUrl, programscapeFetch } from "./programscape/guard.js";
import { writeSecureJson } from "./programscape/store.js";
import type { FetchLike } from "./providers/index.js";
import { PROVIDER_IDS, type ProviderId } from "./types.js";
import { VERSION } from "./version.js";

export const CATALOG_URL = `${PROGRAMSCAPE_ORIGIN}/api/router/programs`;
/** At most one read per this long (unless a provider's key is new since the last read). */
export const CATALOG_INTERVAL_MS = 24 * 60 * 60_000;
/** How long a read may take before it is dropped. */
export const CATALOG_TIMEOUT_MS = 3_000;
/** How long a list from an earlier read may still be shown when the latest read failed. */
export const CATALOG_SHOW_FOR_MS = 7 * 24 * 60 * 60_000;

/** One program in the catalog, with its official source and the date Programscape checked it. */
export interface CatalogProgram {
  id: string;
  name: string;
  provider: { id: string; name: string };
  headline: string;
  /** "Ask Exa" where the provider decides on request; absent otherwise. */
  ask?: string;
  capabilities: string[];
  checkedOn: string;
  mayBeOutOfDate: boolean;
  officialSource: { title: string; url: string };
  /** The program on programscape.com, where a founder can see where they stand. */
  qualify?: string;
}

/** What the catalog lists for one provider. */
export interface CatalogProvider {
  provider: { id: ProviderId; name: string };
  /** The capabilities "the same job" was matched on. */
  capabilities: string[];
  /** More from the same provider. */
  more: CatalogProgram[];
  /** Other providers' programs that do the same job, alphabetical. Never ranked. */
  sameJob: CatalogProgram[];
  /** The full inventory: https://programscape.com/extend/<id>. */
  page: string;
}

export interface Catalog {
  about: string;
  asOf: string;
  providers: CatalogProvider[];
}

/** The short version shown in status, check, the heads-up and after the first `keys set`: no "same job" list. */
export type ProviderPrograms = Omit<CatalogProvider, "sameJob">;

interface CatalogCache {
  version: 1;
  /** When the last read was tried, whatever came of it. */
  attemptedAt?: string;
  /** The provider ids that read asked about. */
  asked?: string[];
  /** When the list below was read. */
  fetchedAt?: string;
  catalog?: Catalog;
}

/** ~/.local/state/programscape-router/catalog.json; %LOCALAPPDATA%\programscape-router\catalog.json on Windows. */
export function defaultCatalogPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  return join(stateDir(env, platform), "catalog.json");
}

/** False when config or the environment turns the catalog off. */
export function catalogEnabled(env: Record<string, string | undefined>, config: RouterConfig | undefined): boolean {
  if (config?.programscape?.catalog === false) return false;
  const flag = env.PROGRAMSCAPE_ROUTER_CATALOG?.trim().toLowerCase();
  return !(flag === "off" || flag === "false" || flag === "0" || flag === "no");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const range = (from: number, to: number) => `${String.fromCharCode(from)}-${String.fromCharCode(to)}`;
/** Control characters (C0 and C1) and invisible formatting and direction marks, which a terminal could act on. */
const UNSAFE = new RegExp(`[${range(0x00, 0x1f)}${range(0x7f, 0x9f)}${range(0x200b, 0x200f)}${range(0x2028, 0x202e)}${range(0x2066, 0x2069)}]`, "g");

/** Text for a terminal: no control characters (so no escape sequences), one line, and not too long. */
function words(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(UNSAFE, " ").replace(/\s+/g, " ").trim();
  if (clean.length === 0) return undefined;
  return clean.length > max ? `${clean.slice(0, max - 3)}...` : clean;
}

function httpsUrl(value: unknown): string | undefined {
  const text = words(value, 2000);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    return url.protocol === "https:" && url.username === "" && url.password === "" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function program(value: unknown): CatalogProgram | undefined {
  if (!isRecord(value)) return undefined;
  const id = words(value.id, 160);
  const name = words(value.name, 200);
  const provider = isRecord(value.provider) ? value.provider : {};
  const providerId = words(provider.id, 80);
  const providerName = words(provider.name, 120);
  const source = isRecord(value.officialSource) ? value.officialSource : {};
  const sourceUrl = httpsUrl(source.url);
  const checkedOn = typeof value.checkedOn === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.checkedOn) ? value.checkedOn : undefined;
  // Every program needs its official source and the date it was checked; without them it isn't shown.
  if (!id || !name || !providerId || !providerName || !sourceUrl || !checkedOn) return undefined;
  const ask = words(value.ask, 120);
  const qualify = httpsUrl(value.qualify);
  return {
    id,
    name,
    provider: { id: providerId, name: providerName },
    headline: words(value.headline, 400) ?? "",
    ...(ask ? { ask } : {}),
    capabilities: Array.isArray(value.capabilities) ? value.capabilities.flatMap((entry) => words(entry, 40) ?? []).slice(0, 20) : [],
    checkedOn,
    mayBeOutOfDate: value.mayBeOutOfDate === true,
    officialSource: { title: words(source.title, 200) ?? sourceUrl, url: sourceUrl },
    ...(qualify && isProgramscapeUrl(qualify) ? { qualify } : {}),
  };
}

const programs = (value: unknown): CatalogProgram[] =>
  Array.isArray(value) ? value.slice(0, 100).flatMap((entry) => program(entry) ?? []) : [];

/** Keep only well-formed entries, in the catalog's own order, for providers this router knows. */
export function sanitizeCatalog(input: unknown): Catalog | undefined {
  if (!isRecord(input) || !Array.isArray(input.providers)) return undefined;
  const providers = input.providers.flatMap((entry): CatalogProvider[] => {
    const provider = isRecord(entry) && isRecord(entry.provider) ? entry.provider : undefined;
    if (!isRecord(entry) || !provider) return [];
    const id = PROVIDER_IDS.find((candidate) => candidate === provider.id);
    const name = words(provider.name, 120);
    if (!id || !name) return [];
    const fallback = `${PROGRAMSCAPE_ORIGIN}/extend/${id}`;
    const page = httpsUrl(entry.page);
    return [
      {
        provider: { id, name },
        capabilities: Array.isArray(entry.capabilities) ? entry.capabilities.flatMap((value) => words(value, 40) ?? []).slice(0, 20) : [],
        more: programs(entry.more),
        sameJob: programs(entry.sameJob),
        page: page && isProgramscapeUrl(page) ? page : fallback,
      },
    ];
  });
  return {
    about: words(input.about, 600) ?? "",
    asOf: typeof input.asOf === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.asOf) ? input.asOf : "",
    providers,
  };
}

async function readCache(path: string): Promise<CatalogCache> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!isRecord(raw)) return { version: 1 };
    const time = (value: unknown) => (typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : undefined);
    const attemptedAt = time(raw.attemptedAt);
    const fetchedAt = time(raw.fetchedAt);
    const asked = Array.isArray(raw.asked) ? raw.asked.filter((id): id is string => typeof id === "string") : undefined;
    const catalog = sanitizeCatalog(raw.catalog);
    return { version: 1, ...(attemptedAt ? { attemptedAt } : {}), ...(asked ? { asked } : {}), ...(fetchedAt ? { fetchedAt } : {}), ...(catalog ? { catalog } : {}) };
  } catch {
    return { version: 1 };
  }
}

export interface CatalogOptions {
  env: Record<string, string | undefined>;
  config?: RouterConfig;
  fetch: FetchLike;
  now: () => Date;
  /** The cache file, or false to turn the catalog off. Defaults to catalog.json in the state directory. */
  path?: string | false;
}

/** The ids sent: the providers with a key set, once each, alphabetically. */
function askFor(providers: readonly ProviderId[]): ProviderId[] {
  return PROVIDER_IDS.filter((id) => providers.includes(id));
}

async function fetchCatalog(fetchImpl: FetchLike, ids: readonly ProviderId[]): Promise<Catalog | undefined> {
  const guarded = programscapeFetch(fetchImpl, CATALOG_TIMEOUT_MS);
  // Exactly one parameter: the provider ids. The comma is left as is, as the endpoint's own examples write it.
  const response = await guarded(`${CATALOG_URL}?providers=${ids.join(",")}`, {
    method: "GET",
    headers: { accept: "application/json", "user-agent": `programscape-router/${VERSION}` },
    credentials: "omit",
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return undefined;
  }
  return sanitizeCatalog(await response.json());
}

/**
 * The catalog, with only the entries for `providers` (the ones with a key set), in the catalog's order. Reads Programscape's catalog
 * when the cache is more than a day old or doesn't cover a provider, as described at the top of this file. Undefined
 * when the catalog is off, nothing could be read, or no provider has a key. Never throws.
 */
export async function readPrograms(options: CatalogOptions, providers: readonly ProviderId[]): Promise<Catalog | undefined> {
  const { env, config, now } = options;
  if (options.path === false || !catalogEnabled(env, config)) return undefined;
  const ids = askFor(providers);
  if (ids.length === 0) return undefined;
  const path = options.path ?? defaultCatalogPath(env);
  try {
    const cache = await readCache(path);
    const at = now().getTime();
    const recent = cache.attemptedAt !== undefined && at - Date.parse(cache.attemptedAt) < CATALOG_INTERVAL_MS;
    const covered = recent && ids.every((id) => cache.asked?.includes(id));
    let current = cache;
    if (!covered) {
      const catalog = await fetchCatalog(options.fetch, ids).catch(() => undefined);
      const attemptedAt = now().toISOString();
      current = catalog
        ? { version: 1, attemptedAt, asked: ids, fetchedAt: attemptedAt, catalog }
        : { ...cache, version: 1, attemptedAt, asked: ids };
      await writeSecureJson(path, current).catch(() => undefined);
    }
    if (!current.catalog || !current.fetchedAt || at - Date.parse(current.fetchedAt) > CATALOG_SHOW_FOR_MS) return undefined;
    const entries = current.catalog.providers.filter((entry) => ids.includes(entry.provider.id));
    return entries.length > 0 ? { ...current.catalog, providers: entries } : undefined;
  } catch {
    return undefined;
  }
}

/** The short version of a provider's entry: no "same job" list (that is on its page). */
export function short(entry: CatalogProvider): ProviderPrograms {
  const { sameJob: _sameJob, ...rest } = entry;
  return rest;
}

/** A program's name, with "Ask X" where the provider decides on request. */
export function programName(program: Pick<CatalogProgram, "name" | "ask">): string {
  return program.ask ? `${program.name} (${program.ask})` : program.name;
}

/** One line per provider: its programs' names and the link to everything that can add more. */
export function shortLine(entry: ProviderPrograms): string {
  const name = entry.provider.name;
  if (entry.more.length === 0) return `${name}: no ${name} startup program in the catalog today; other providers that do the same job: ${entry.page}`;
  return `${name}: ${entry.more.map(programName).join("; ")}. More: ${entry.page}`;
}

/** The heading over the short list. */
export const PROGRAMS_HEADING = "Programs that can add more (Programscape's public catalog; each provider decides who qualifies)";

/** The short list, as lines: the heading, then one line per provider. Empty when there is nothing to show. */
export function shortLines(entries: readonly ProviderPrograms[] | undefined): string[] {
  if (!entries || entries.length === 0) return [];
  return [PROGRAMS_HEADING, ...entries.map((entry) => `  ${shortLine(entry)}`)];
}

function programLines(program: CatalogProgram, indent: string, withProvider: boolean): string[] {
  const lines = [`${indent}- ${withProvider ? `${program.provider.name}, ` : ""}${programName(program)}${program.headline ? `: ${program.headline}` : ""}`];
  lines.push(
    `${indent}  Checked ${program.checkedOn}${program.mayBeOutOfDate ? " (may be out of date: confirm on the official page)" : ""}. Official source: ${program.officialSource.title}, ${program.officialSource.url}`,
  );
  if (program.qualify) lines.push(`${indent}  See where you stand: ${program.qualify}`);
  return lines;
}

/** The full list `programscape-router programs` prints. */
export function formatPrograms(entries: readonly CatalogProvider[], asOf?: string): string {
  const lines = [
    `Programs that can add more, from Programscape's public catalog${asOf ? ` (as of ${asOf})` : ""}.`,
    "Listed alphabetically, never ranked. Whether you qualify is each provider's decision.",
    "",
  ];
  for (const entry of entries) {
    const name = entry.provider.name;
    lines.push(`${name}${entry.capabilities.length > 0 ? ` (${entry.capabilities.join(", ")})` : ""}`);
    lines.push(`  More from ${name}:`);
    if (entry.more.length === 0) lines.push(`    (no ${name} startup program in the catalog today)`);
    for (const item of entry.more) lines.push(...programLines(item, "    ", false));
    if (entry.sameJob.length > 0) {
      lines.push("  Other providers that do the same job:");
      for (const item of entry.sameJob) lines.push(...programLines(item, "    ", true));
    }
    lines.push(`  Everything that can add more: ${entry.page}`, "");
  }
  return lines.join("\n").trimEnd();
}
