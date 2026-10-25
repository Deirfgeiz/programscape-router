import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { configDir } from "./paths.js";
import { z } from "zod";
import { ADAPTERS, type ProviderAdapter } from "./providers/index.js";
import { CAPABILITIES, type Capability, PROVIDER_IDS, type ProviderId } from "./types.js";

const providerId = z.enum(PROVIDER_IDS, {
  error: (issue) => `"${String(issue.input)}" is not a provider this router knows. Use one of: ${PROVIDER_IDS.join(", ")}.`,
});

const isoDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2027-03-01.")
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), "Not a real calendar date.");

const credit = z
  .strictObject({
    label: z.string().min(1).optional(),
    expiresOn: isoDay.optional(),
    remaining: z.number().min(0).optional(),
    award: z.number().positive().optional(),
    unit: z.string().min(1).optional(),
  })
  .describe("Credits you hold with this provider. Every field is optional; leave out what you don't know.");

/** A zone name as Bright Data shows it: letters, digits, underscores and hyphens. Not a secret. */
export const zoneName = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, "Use the zone's name as Bright Data shows it, such as programscape_serp (letters, digits, _ and -).");

const zoneSettings = z
  .strictObject({ search: zoneName.optional(), scrape: zoneName.optional() })
  .describe("The zone in your account each capability's requests go to (Bright Data). `keys set` fills it in.");

const providerSettings = z.strictObject({
  paid: z.boolean().optional(),
  zones: zoneSettings.optional(),
  credits: z.array(credit).optional(),
  /**
   * Which kept, approved program on the founder's Programscape plan this provider's live balance belongs to,
   * when the plan has several (or none) from this provider. Used only by the opt-in balance sync.
   */
  programscapeProgram: z.string().min(1).max(200).optional(),
});

const programscapeSettings = z
  .strictObject({
    sync: z.enum(["manual", "auto"], {
      error: () => 'Use "manual" (only when you run `programscape-router sync`) or "auto".',
    }),
    /** false: never read Programscape's public catalog, and say nothing about programs (0151). */
    catalog: z.boolean({ error: () => "Use true or false." }),
    /** Required for sync when the account has more than one saved company plan. */
    planId: z.uuid({ error: () => "Use the saved plan's UUID from the company choices shown by sync." }),
  })
  .partial()
  .describe(
    "Opt-in balance sync to the founder's Programscape plan (nothing is sent until `programscape-router connect`), and the public programs catalog (on unless catalog is false).",
  );

const headsUpSettings = z
  .strictObject({
    days: z
      .number({ error: () => "Use a whole number of days, such as 30 (0 turns the heads-up off)." })
      .int("Use a whole number of days, such as 30 (0 turns the heads-up off).")
      .min(0)
      .max(3650),
  })
  .partial()
  .describe("The heads-up when estimated runway, or an end date you gave, is under this many days (default 30).");

const orderList = z
  .array(providerId)
  .refine((list) => new Set(list).size === list.length, "List each provider once.");

export const configSchema = z
  .strictObject({
    order: z
      .strictObject({
        search: orderList.optional(),
        scrape: orderList.optional(),
      })
      .optional(),
    providers: z.partialRecord(providerId, providerSettings).optional(),
    programscape: programscapeSettings.optional(),
    headsUp: headsUpSettings.optional(),
    timeoutMs: z.number().int().min(1000).max(300_000).optional(),
  })
  .superRefine((config, ctx) => {
    for (const id of PROVIDER_IDS) {
      if (config.providers?.[id]?.zones !== undefined && !ADAPTERS[id].zoneEnvVars) {
        ctx.addIssue({ code: "custom", path: ["providers", id, "zones"], message: `${ADAPTERS[id].name} has no zones; only brightdata takes them.` });
      }
    }
  });

/** The config file's shape. Every field is optional; see the README's Config section. */
export type RouterConfig = z.infer<typeof configSchema>;
/** One entry in providers.<id>.credits: credits you hold, as you know them. */
export type CreditEntry = z.infer<typeof credit>;

/** A config file that is missing (when named), not JSON, or not valid. The message says which field and why. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Validate a parsed config object, with messages a founder can act on. Settings for an unknown provider are ignored. */
export function parseConfig(input: unknown, source = "config"): RouterConfig {
  return parseConfigWithNotes(input, source).config;
}

/**
 * Like parseConfig, and says what it ignored. For forward compatibility from 1.2.0 on, settings under `providers` for
 * a provider this version doesn't know (one a newer version added, in a config shared with it) are ignored with a
 * note instead of stopping the router. Everything else stays strict.
 */
export function parseConfigWithNotes(input: unknown, source = "config"): { config: RouterConfig; notes: string[] } {
  const notes: string[] = [];
  let checked = input;
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    const providers = (input as Record<string, unknown>).providers;
    if (typeof providers === "object" && providers !== null && !Array.isArray(providers)) {
      const known = Object.fromEntries(Object.entries(providers).filter(([id]) => (PROVIDER_IDS as readonly string[]).includes(id)));
      for (const id of Object.keys(providers)) {
        if (!(id in known)) {
          notes.push(`Ignored providers.${JSON.stringify(id).slice(1, -1).slice(0, 40)} in ${source}: not a provider this version of the router knows (a newer version may).`);
        }
      }
      checked = { ...(input as Record<string, unknown>), providers: known };
    }
  }
  const result = configSchema.safeParse(checked);
  if (result.success) return { config: result.data, notes };
  const lines = result.error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.map(String).join(".") : "(top level)";
    return `  - ${path}: ${issue.message}`;
  });
  throw new ConfigError(`${source} is not valid:\n${lines.join("\n")}`);
}

/** Where loadConfig found a config, and what it holds. */
export interface ConfigLocation {
  /** The file used, or undefined when none was found (defaults apply). */
  path: string | undefined;
  config: RouterConfig;
  /** What was ignored in the file (settings for a provider this version doesn't know), in words. */
  notes?: string[];
}

/**
 * Where a config file is looked for, in order: $PROGRAMSCAPE_ROUTER_CONFIG, ./programscape-router.json, then
 * config.json in the config directory: $XDG_CONFIG_HOME/programscape-router when set, otherwise
 * ~/.config/programscape-router on macOS and Linux and %APPDATA%\programscape-router on Windows.
 */
export function configCandidates(env: NodeJS.ProcessEnv, cwd: string, platform: NodeJS.Platform = process.platform): string[] {
  return [
    ...(env.PROGRAMSCAPE_ROUTER_CONFIG ? [resolve(cwd, env.PROGRAMSCAPE_ROUTER_CONFIG)] : []),
    resolve(cwd, "programscape-router.json"),
    join(configDir(env, platform), "config.json"),
  ];
}

/** Finds and validates the config file (see configCandidates for the lookup order). Throws ConfigError. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): ConfigLocation {
  const explicit = env.PROGRAMSCAPE_ROUTER_CONFIG;
  if (explicit && !existsSync(resolve(cwd, explicit))) {
    throw new ConfigError(`PROGRAMSCAPE_ROUTER_CONFIG points to ${resolve(cwd, explicit)}, which does not exist.`);
  }
  for (const path of configCandidates(env, cwd)) {
    if (!existsSync(path)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new ConfigError(`${path} is not valid JSON: ${reason}`);
    }
    const { config, notes } = parseConfigWithNotes(raw, path);
    return { path, config, ...(notes.length > 0 ? { notes } : {}) };
  }
  return { path: undefined, config: {} };
}

/**
 * The zone each capability uses, for an adapter that needs zones: its environment variable when set (so
 * BRIGHTDATA_SERP_ZONE and BRIGHTDATA_UNLOCKER_ZONE win), then config `providers.<id>.zones` (written by hand; needs
 * 1.2.0 or later), then zones.json (written by `keys set`). Empty for an adapter without zones.
 */
export function zonesFor(
  adapter: Pick<ProviderAdapter, "id" | "zoneEnvVars">,
  config: RouterConfig,
  env: Record<string, string | undefined>,
): Partial<Record<Capability, string>> {
  if (!adapter.zoneEnvVars) return {};
  let file: ReturnType<typeof readZonesFile> | undefined;
  const saved = () => (file ??= readZonesFile(env));
  const zones: Partial<Record<Capability, string>> = {};
  for (const capability of CAPABILITIES) {
    const envVar = adapter.zoneEnvVars[capability];
    const zone =
      (envVar ? env[envVar]?.trim() : undefined) || config.providers?.[adapter.id]?.zones?.[capability] || saved()[adapter.id]?.[capability];
    if (zone) zones[capability] = zone;
  }
  return zones;
}

/** The capabilities an adapter has that still need a zone (none for a provider without zones). */
export function missingZones(adapter: ProviderAdapter, zones: Partial<Record<Capability, string>>): Capability[] {
  if (!adapter.zoneEnvVars) return [];
  return CAPABILITIES.filter((capability) => (capability === "search" ? adapter.search : adapter.scrape) !== undefined && !zones[capability]);
}

/**
 * Where `keys set brightdata` keeps the zones it finds, creates or is told: zones.json in the config folder, beside
 * config.json. It is a separate file because 1.1.0 and earlier check config.json strictly and refuse to start on a
 * provider they don't know, so writing `providers.brightdata` there would break a founder's older router still
 * running (a pinned or cached npx, an MCP client started before the update). Older versions never read zones.json.
 */
export function zonesPath(env: Record<string, string | undefined>, platform: NodeJS.Platform = process.platform): string {
  return join(configDir(env, platform), "zones.json");
}

const zonesFileSchema = z.object({
  version: z.literal(1),
  brightdata: zoneSettings.optional(),
});

/** The zones in zones.json, per provider. An unreadable or invalid file counts as none (keys set writes it again). */
export function readZonesFile(env: Record<string, string | undefined>): Partial<Record<ProviderId, Partial<Record<Capability, string>>>> {
  const path = zonesPath(env);
  if (!existsSync(path)) return {};
  try {
    const parsed = zonesFileSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success && parsed.data.brightdata ? { brightdata: parsed.data.brightdata } : {};
  } catch {
    return {};
  }
}

/**
 * Saves zone names (never a key) for `id` in zones.json, keeping zones already there for its other capability, and
 * writes it atomically. Never touches config.json. Returns the file's path. Throws ConfigError when it can't be written.
 */
export function saveZones(env: Record<string, string | undefined>, id: ProviderId, zones: Partial<Record<Capability, string>>): string {
  const path = zonesPath(env);
  const current = readZonesFile(env);
  const next = { version: 1 as const, ...current, [id]: { ...current[id], ...zones } };
  const checked = zonesFileSchema.safeParse(next);
  if (!checked.success) throw new ConfigError(`The zones to save aren't valid: ${checked.error.issues.map((issue) => issue.message).join("; ")}`);
  try {
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(checked.data, null, 2)}\n`);
    renameSync(temp, path);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? ` (${String((error as { code?: unknown }).code)})` : "";
    throw new ConfigError(`Couldn't write ${path}${code}, so the zones weren't saved.`);
  }
  return path;
}

export function providerSettingsFor(config: RouterConfig, id: ProviderId) {
  return config.providers?.[id];
}
