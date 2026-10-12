import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
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
});

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
  timeoutMs: z.number().int().min(1000).max(300_000).optional(),
});

export type RouterConfig = z.infer<typeof configSchema>;
export type CreditEntry = z.infer<typeof credit>;

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

export interface ConfigLocation {
  path: string | undefined;
  config: RouterConfig;
}

/**
 * Where a config file is looked for, in order: $PROGRAMSCAPE_ROUTER_CONFIG, ./programscape-router.json,
 * then $XDG_CONFIG_HOME/programscape-router/config.json (default ~/.config/...).
 */
export function configCandidates(env: NodeJS.ProcessEnv, cwd: string): string[] {
  const xdg = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0 ? env.XDG_CONFIG_HOME : join(homedir(), ".config");
  return [
    ...(env.PROGRAMSCAPE_ROUTER_CONFIG ? [resolve(cwd, env.PROGRAMSCAPE_ROUTER_CONFIG)] : []),
    resolve(cwd, "programscape-router.json"),
    join(xdg, "programscape-router", "config.json"),
  ];
}

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
