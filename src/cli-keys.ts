/**
 * `programscape-router keys set|list|remove`: store provider keys in the OS keychain.
 *
 * A key is read at a hidden prompt (or from a pipe with --stdin), handed to the keychain, and never printed, logged
 * or written to a file by the router. `list` shows only whether each key is set and where it comes from.
 */
import { type Keychain, KEY_ENV_VARS, KeychainUnavailableError, type KeyringLoader, type KeySource, openKeychain } from "./keys.js";
import { PromptCancelledError, type PromptInput, canPrompt, readFirstLine, readHidden } from "./prompt.js";
import { setUpBrightDataZones, takeZoneFlags } from "./cli-zones.js";
import { ADAPTERS, type FetchLike } from "./providers/index.js";
import { PROVIDER_IDS, type ProviderId } from "./types.js";

export interface KeysIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export interface KeysOptions {
  env: Record<string, string | undefined>;
  /** The terminal the hidden prompt reads from. Defaults to process.stdin. */
  stdin?: PromptInput & AsyncIterable<string | Buffer>;
  /** Where the prompt is shown. Defaults to process.stderr, so stdout stays clean. */
  promptOutput?: { write(text: string): unknown };
  keyringLoader?: KeyringLoader;
  platform?: NodeJS.Platform;
  /** For `keys set brightdata`'s zone step, which calls Bright Data with the new key. Defaults to the global fetch. */
  fetch?: FetchLike;
  /** Where the config lookup starts, for saving zones. Defaults to process.cwd(). */
  cwd?: string;
}

export const KEYS_USAGE = `Usage:
  programscape-router keys set <provider> [--stdin]   Store a key in the OS keychain (asked for at a hidden prompt)
  programscape-router keys set brightdata [--stdin] [--search-zone <name>] [--scrape-zone <name>]
                                                      Also set up its zones: found in your account, created only if
                                                      you say yes, or named here
  programscape-router keys list [--json]              Which keys are set, and where from (never the keys)
  programscape-router keys remove <provider>          Delete a stored key from the OS keychain

Providers: ${PROVIDER_IDS.join(", ")}.
`;

function providerArg(value: string | undefined, io: KeysIo): ProviderId | undefined {
  const id = PROVIDER_IDS.find((candidate) => candidate === value?.toLowerCase());
  if (!id) io.stderr(`${value ? `"${value}" is not a provider this router knows.` : "Name a provider."} Use one of: ${PROVIDER_IDS.join(", ")}.\n`);
  return id;
}

function envSet(env: KeysOptions["env"], id: ProviderId): boolean {
  return (env[KEY_ENV_VARS[id]]?.trim() ?? "").length > 0;
}

async function keychainOr(io: KeysIo, options: KeysOptions): Promise<Keychain | undefined> {
  try {
    return await openKeychain({
      env: options.env,
      ...(options.keyringLoader ? { loader: options.keyringLoader } : {}),
      ...(options.platform ? { platform: options.platform } : {}),
    });
  } catch (error) {
    if (error instanceof KeychainUnavailableError) {
      io.stderr(`${error.message}\n`);
      return undefined;
    }
    throw error;
  }
}

async function set(argv: string[], io: KeysIo, options: KeysOptions): Promise<number> {
  const args = [...argv];
  const zoneFlags = takeZoneFlags(args);
  const fromStdin = args.includes("--stdin");
  const id = providerArg(args.find((arg) => !arg.startsWith("--")), io);
  if (!id) return 2;
  const adapter = ADAPTERS[id];
  if (zoneFlags.error) {
    io.stderr(`${zoneFlags.error}\n`);
    return 2;
  }
  if (Object.keys(zoneFlags.given).length > 0 && !adapter.zoneEnvVars) {
    io.stderr(`--search-zone and --scrape-zone are only for brightdata; ${adapter.name} has no zones.\n`);
    return 2;
  }
  const stdin = options.stdin ?? (process.stdin as unknown as NonNullable<KeysOptions["stdin"]>);

  if (!fromStdin && !canPrompt(stdin)) {
    io.stderr(
      `keys set needs a terminal, so it can ask for the key without showing it. In a script, pipe the key in instead:\n` +
        `  <command that prints the key> | programscape-router keys set ${id} --stdin\n`,
    );
    return 2;
  }

  // Reach the keychain first, so nobody pastes a key only to hear it can't be stored. The read also says whether
  // this replaces a stored key; the value itself is dropped.
  const keychain = await keychainOr(io, options);
  if (!keychain) return 1;
  let replacing: boolean;
  try {
    replacing = ((await keychain.get(adapter.envVar)) ?? "").length > 0;
  } catch (error) {
    if (error instanceof KeychainUnavailableError) {
      io.stderr(`${error.message}\n`);
      return 1;
    }
    throw error;
  }

  let key: string;
  try {
    key = fromStdin
      ? await readFirstLine(stdin)
      : await readHidden(`Paste your ${adapter.name} key (${adapter.envVar}); it won't be shown: `, stdin, options.promptOutput ?? process.stderr);
  } catch (error) {
    if (error instanceof PromptCancelledError) {
      io.stderr("Cancelled. Nothing was saved.\n");
      return 1;
    }
    throw error;
  }
  key = key.trim();
  if (key.length === 0) {
    io.stderr("No key was entered, so nothing was saved.\n");
    return 1;
  }

  try {
    await keychain.set(adapter.envVar, key);
  } catch (error) {
    if (error instanceof KeychainUnavailableError) {
      io.stderr(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
  io.stdout(`${replacing ? "Replaced" : "Saved"} the ${adapter.name} key in ${keychain.label} (service ${keychain.service}, account ${adapter.envVar}).\n`);
  if (envSet(options.env, id)) {
    io.stdout(`Note: ${adapter.envVar} is also set in this environment, and the environment wins over the keychain.\n`);
  }
  let code = 0;
  if (id === "brightdata") {
    code = await setUpBrightDataZones(io, {
      key,
      env: options.env,
      cwd: options.cwd ?? process.cwd(),
      fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
      given: zoneFlags.given,
      ...(fromStdin ? {} : { terminal: { input: stdin, output: options.promptOutput ?? process.stderr } }),
    }).catch((error: unknown) => {
      if (error instanceof PromptCancelledError) {
        io.stderr("Cancelled. The key is saved; run `programscape-router keys set brightdata` again to set up its zones.\n");
        return 1;
      }
      throw error;
    });
  }
  io.stdout(`Run \`programscape-router check\` to try it.\n`);
  return code;
}

interface ListEntry {
  provider: ProviderId;
  envVar: string;
  /** Which key the router uses. */
  source: KeySource;
  /** True when the keychain holds one too; null when the keychain can't be read. */
  inKeychain: boolean | null;
}

async function list(args: string[], io: KeysIo, options: KeysOptions): Promise<number> {
  const json = args.includes("--json");
  let keychain: Keychain | undefined;
  let note: string | undefined;
  try {
    keychain = await openKeychain({
      env: options.env,
      ...(options.keyringLoader ? { loader: options.keyringLoader } : {}),
      ...(options.platform ? { platform: options.platform } : {}),
    });
  } catch (error) {
    if (!(error instanceof KeychainUnavailableError)) throw error;
    note = error.message;
  }

  const entries: ListEntry[] = [];
  for (const id of PROVIDER_IDS) {
    const envVar = KEY_ENV_VARS[id];
    let inKeychain: boolean | null = null;
    if (keychain && !note) {
      try {
        // Only whether a key exists is kept; the value is dropped here and never printed.
        inKeychain = ((await keychain.get(envVar))?.trim() ?? "").length > 0;
      } catch (error) {
        if (!(error instanceof KeychainUnavailableError)) throw error;
        note = error.message;
      }
    }
    const source: KeySource = envSet(options.env, id) ? "env" : inKeychain ? "keychain" : "none";
    entries.push({ provider: id, envVar, source, inKeychain });
  }

  if (json) {
    io.stdout(`${JSON.stringify({ keychain: keychain && !note ? keychain.label : null, ...(note ? { keychainNote: note } : {}), keys: entries }, null, 2)}\n`);
    return 0;
  }
  const lines = ["Provider keys (never shown). An environment variable wins over the keychain."];
  for (const entry of entries) {
    const state =
      entry.source === "env"
        ? `set, from the environment${entry.inKeychain ? " (the keychain has one too, unused while the variable is set)" : ""}`
        : entry.source === "keychain"
          ? "set, from the keychain"
          : "not set";
    lines.push(`  ${entry.provider.padEnd(10)}${entry.envVar.padEnd(19)}${state}`);
  }
  lines.push(note ? `Keychain: ${note}` : `Keychain: ${keychain?.label} (service ${keychain?.service}).`);
  io.stdout(`${lines.join("\n")}\n`);
  return 0;
}

async function remove(args: string[], io: KeysIo, options: KeysOptions): Promise<number> {
  const id = providerArg(args.find((arg) => !arg.startsWith("--")), io);
  if (!id) return 2;
  const adapter = ADAPTERS[id];
  const keychain = await keychainOr(io, options);
  if (!keychain) return 1;
  let removed: boolean;
  try {
    removed = await keychain.remove(adapter.envVar);
  } catch (error) {
    if (error instanceof KeychainUnavailableError) {
      io.stderr(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
  io.stdout(removed ? `Removed the ${adapter.name} key from ${keychain.label}.\n` : `There was no ${adapter.name} key in ${keychain.label}. Nothing to do.\n`);
  if (envSet(options.env, id)) io.stdout(`Note: ${adapter.envVar} is still set in this environment, so the router still has a ${adapter.name} key.\n`);
  return 0;
}

/** Runs `keys <subcommand>`. Returns the exit code. */
export async function runKeys(args: string[], io: KeysIo, options: KeysOptions): Promise<number> {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "set":
      return set(rest, io, options);
    case "list":
      return list(rest, io, options);
    case "remove":
      return remove(rest, io, options);
    default:
      io.stderr(`${subcommand ? `Unknown keys command "${subcommand}".\n\n` : ""}${KEYS_USAGE}`);
      return 2;
  }
}
