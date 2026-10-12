/**
 * Where the router keeps its files.
 *
 * macOS and Linux follow the XDG base directories: config in ~/.config/programscape-router, state (the ledger and
 * the sync record) in ~/.local/state/programscape-router, and the Programscape token beside the config.
 * Windows uses its own profile folders: config in %APPDATA%\programscape-router, and state, including the
 * Programscape token, in %LOCALAPPDATA%\programscape-router.
 * XDG_CONFIG_HOME and XDG_STATE_HOME win on every platform when they are set.
 */
import { homedir } from "node:os";
import { join } from "node:path";

const APP = "programscape-router";

type Env = Record<string, string | undefined>;

function set(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}

/** The directory the config file (and, outside Windows, the Programscape token) lives in. */
export function configDir(env: Env, platform: NodeJS.Platform = process.platform): string {
  if (set(env.XDG_CONFIG_HOME)) return join(env.XDG_CONFIG_HOME, APP);
  if (platform === "win32") return join(set(env.APPDATA) ? env.APPDATA : join(homedir(), "AppData", "Roaming"), APP);
  return join(homedir(), ".config", APP);
}

/** The directory the ledger and the sync record (and, on Windows, the Programscape token) live in. */
export function stateDir(env: Env, platform: NodeJS.Platform = process.platform): string {
  if (set(env.XDG_STATE_HOME)) return join(env.XDG_STATE_HOME, APP);
  if (platform === "win32") return join(set(env.LOCALAPPDATA) ? env.LOCALAPPDATA : join(homedir(), "AppData", "Local"), APP);
  return join(homedir(), ".local", "state", APP);
}

/**
 * The directory the Programscape token and client cache live in: beside the config, except on Windows, where
 * they are local state (%LOCALAPPDATA%, which doesn't roam to other machines) unless XDG_CONFIG_HOME is set.
 */
export function tokenDir(env: Env, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32" && !set(env.XDG_CONFIG_HOME)) return stateDir(env, platform);
  return configDir(env, platform);
}
