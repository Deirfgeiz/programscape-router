/**
 * Where provider keys come from: the environment first, then the OS keychain.
 *
 * The keychain is the operating system's own credential store (macOS Keychain, Windows Credential Manager, the
 * Secret Service on Linux), reached through the optional native module @napi-rs/keyring. The module is loaded
 * lazily, and only when a key isn't in the environment, so a failed native install or a machine with no keychain
 * never stops the router: it still works with environment variables.
 *
 * The router never writes a key to disk itself, and never logs one. Nothing here puts a key in an error message.
 */
import { ADAPTERS } from "./providers/index.js";
import { PROVIDER_IDS, type ProviderId } from "./types.js";

/** The keychain service every key is stored under. The account is the key's environment variable name. */
export const KEYCHAIN_SERVICE = "programscape-router";

/**
 * Overrides the keychain service name. For the CI round trip only, so it never touches a real
 * `programscape-router` entry; not a documented option.
 */
const TEST_SERVICE_ENV = "PROGRAMSCAPE_ROUTER_TEST_KEYCHAIN_SERVICE";

/** The environment variable each provider's key is read from, which is also its keychain account name. */
export const KEY_ENV_VARS: Readonly<Record<ProviderId, string>> = Object.fromEntries(
  PROVIDER_IDS.map((id) => [id, ADAPTERS[id].envVar]),
) as Record<ProviderId, string>;

/** Where a provider's key came from: the environment, the OS keychain, or nowhere. */
export type KeySource = "env" | "keychain" | "none";

/** The keys the router will use, and where each came from. Holds secrets: never log or serialize it. */
export interface ResolvedKeys {
  keys: Partial<Record<ProviderId, string>>;
  sources: Record<ProviderId, KeySource>;
  /** Why the keychain could not be read, when a key was looked for there and it could not be. */
  keychainNote?: string;
}

/** A minimal keychain: one service, an account per key. */
export interface Keychain {
  /** Where keys are kept, in words ("the macOS Keychain"). */
  readonly label: string;
  /** The keychain service the entries are under. */
  readonly service: string;
  get(account: string): Promise<string | null>;
  set(account: string, secret: string): Promise<void>;
  /** True when something was deleted. */
  remove(account: string): Promise<boolean>;
}

/** The shape of @napi-rs/keyring this module uses. */
interface KeyringModule {
  AsyncEntry: new (
    service: string,
    account: string,
    options?: { linux?: { store?: "secret-service" | "keyutils" } },
  ) => {
    getPassword(): Promise<string | null>;
    setPassword(password: string): Promise<void>;
    deleteCredential(): Promise<boolean>;
  };
}

/** Loads the native keyring module. Tests replace it. */
export type KeyringLoader = () => Promise<KeyringModule>;

const defaultLoader: KeyringLoader = async () => (await import("@napi-rs/keyring")) as unknown as KeyringModule;

export class KeychainUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeychainUnavailableError";
  }
}

const ALTERNATIVES =
  'Keys in environment variables still work: see "Keep your keys safe" in the README for 1Password\'s op run, other password managers, or a hidden prompt.';

function storeLabel(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "the macOS Keychain";
  if (platform === "win32") return "Windows Credential Manager";
  return "the Secret Service keyring";
}

/** A short, key-free reason from a keyring error. */
function reasonOf(error: unknown, secret?: string): string {
  let text = error instanceof Error ? error.message : String(error);
  if (secret && secret.length >= 4) text = text.split(secret).join("[redacted]");
  text = text.replace(/\s+/g, " ").trim();
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}

function unavailable(platform: NodeJS.Platform, error: unknown, secret?: string): KeychainUnavailableError {
  const reason = reasonOf(error, secret);
  if (platform === "linux") {
    return new KeychainUnavailableError(
      `No keychain is available here: on Linux the router stores keys in the Secret Service (GNOME Keyring or KWallet), and none answered (${reason}). ${ALTERNATIVES}`,
    );
  }
  const label = storeLabel(platform);
  return new KeychainUnavailableError(`${label.charAt(0).toUpperCase()}${label.slice(1)} could not be used (${reason}). ${ALTERNATIVES}`);
}

export interface KeychainOptions {
  env?: Record<string, string | undefined>;
  loader?: KeyringLoader;
  platform?: NodeJS.Platform;
}

/**
 * Opens the OS keychain. Throws KeychainUnavailableError, with a message that says what to do instead, when the
 * native module can't be loaded. A keychain that loads but can't be reached fails on first use the same way.
 */
export async function openKeychain(options: KeychainOptions = {}): Promise<Keychain> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const service = env[TEST_SERVICE_ENV] || KEYCHAIN_SERVICE;
  let keyring: KeyringModule;
  try {
    keyring = await (options.loader ?? defaultLoader)();
  } catch {
    throw new KeychainUnavailableError(
      `The OS keychain isn't available: its native module (@napi-rs/keyring, an optional dependency with prebuilt binaries for macOS, Windows and Linux) could not be loaded on this system (${platform} ${process.arch}). ${ALTERNATIVES}`,
    );
  }
  // On Linux, require the Secret Service. Without it the library would fall back to the kernel keyring, which
  // forgets keys at logout or reboot: a key that silently disappears is worse than a clear "not available".
  const entry = (account: string) => new keyring.AsyncEntry(service, account, { linux: { store: "secret-service" } });
  const label = storeLabel(platform);
  return {
    label,
    service,
    async get(account) {
      try {
        return await entry(account).getPassword();
      } catch (error) {
        throw unavailable(platform, error);
      }
    },
    async set(account, secret) {
      try {
        await entry(account).setPassword(secret);
      } catch (error) {
        throw unavailable(platform, error, secret);
      }
    },
    async remove(account) {
      try {
        return await entry(account).deleteCredential();
      } catch (error) {
        throw unavailable(platform, error);
      }
    },
  };
}

/** The keys in the environment alone, without touching the keychain. */
export function keysFromEnv(env: Record<string, string | undefined>): ResolvedKeys {
  const keys: Partial<Record<ProviderId, string>> = {};
  const sources = {} as Record<ProviderId, KeySource>;
  for (const id of PROVIDER_IDS) {
    const key = env[KEY_ENV_VARS[id]]?.trim();
    if (key) keys[id] = key;
    sources[id] = key ? "env" : "none";
  }
  return { keys, sources };
}

export interface ResolveKeysOptions extends KeychainOptions {
  /** False skips the keychain entirely. */
  keychain?: boolean;
}

/**
 * Reads each provider's key once: from its environment variable when set (so `op run` and CI always win), and
 * otherwise from the OS keychain. When the keychain can't be read, the environment's keys are still returned,
 * with a note saying why.
 */
export async function resolveKeys(options: ResolveKeysOptions = {}): Promise<ResolvedKeys> {
  const env = options.env ?? process.env;
  const resolved = keysFromEnv(env);
  if (options.keychain === false) return resolved;
  const missing = PROVIDER_IDS.filter((id) => resolved.sources[id] === "none");
  if (missing.length === 0) return resolved;

  let keychain: Keychain;
  try {
    keychain = await openKeychain(options);
  } catch (error) {
    return { ...resolved, keychainNote: error instanceof Error ? error.message : String(error) };
  }
  for (const id of missing) {
    try {
      const key = (await keychain.get(KEY_ENV_VARS[id]))?.trim();
      if (key) {
        resolved.keys[id] = key;
        resolved.sources[id] = "keychain";
      }
    } catch (error) {
      // One failure means the store can't be reached; don't ask it four more times.
      return { ...resolved, keychainNote: error instanceof Error ? error.message : String(error) };
    }
  }
  return resolved;
}
