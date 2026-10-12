import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { configDir } from "./paths.js";
import { z } from "zod";
import { PROVIDER_IDS, type ProviderId } from "./types.js";

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

const providerSettings = z.strictObject({
  paid: z.boolean().optional(),
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

export const configSchema = z.strictObject({
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

/** Validate a parsed config object, with messages a founder can act on. */
export function parseConfig(input: unknown, source = "config"): RouterConfig {
  const result = configSchema.safeParse(input);
  if (result.success) return result.data;
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
    return { path, config: parseConfig(raw, path) };
  }
  return { path: undefined, config: {} };
}

export function providerSettingsFor(config: RouterConfig, id: ProviderId) {
  return config.providers?.[id];
}
