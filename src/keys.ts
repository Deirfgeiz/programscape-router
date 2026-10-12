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
 * The service used when openKeychain isn't given one. Only test code changes it (useKeychainServiceForTests), so
 * the CI round trip never touches a real entry. Nothing in the environment can change it.
 */
let defaultService = KEYCHAIN_SERVICE;

/** Test seam: the keychain service the CLI and the token store use. Never called by the router itself. */
export function useKeychainServiceForTests(service: string = KEYCHAIN_SERVICE): void {
  defaultService = service;
}

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

/**
 * The part of @napi-rs/keyring this module uses, declared here so the build never needs the optional package's own
 * type files: a source install with optional dependencies omitted still builds.
 */
export interface KeyringModule {
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

// A variable specifier: TypeScript doesn't resolve it, so the build doesn't depend on the optional package.
const KEYRING_MODULE: string = "@napi-rs/keyring";
const defaultLoader: KeyringLoader = async () => (await import(KEYRING_MODULE)) as KeyringModule;

/** What went wrong with the keychain, as one of a fixed set of classes. Never the native error's own text. */
export type KeychainProblem =
  | "module-missing"
  | "no-secret-service"
  | "no-default-keychain"
  | "locked"
  | "access-denied"
  | "too-large"
  | "failed";

export class KeychainUnavailableError extends Error {
  readonly problem: KeychainProblem;
  constructor(message: string, problem: KeychainProblem) {
    super(message);
    this.name = "KeychainUnavailableError";
    this.problem = problem;
  }
}

const ALTERNATIVES =
  'Keys in environment variables still work: see "Keep your keys safe" in the README for 1Password\'s op run, other password managers, or a hidden prompt.';

function storeLabel(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "the macOS Keychain";
  if (platform === "win32") return "Windows Credential Manager";
  return "the Secret Service keyring";
}

/**
 * Sorts a native keyring error into a fixed class. Its text is only matched against, never kept or printed: on a
 * path that handles a secret, the text could hold the secret itself (of any length).
 */
export function classifyKeychainError(error: unknown, platform: NodeJS.Platform): KeychainProblem {
  const text = error instanceof Error ? `${error.message} ${(error as { code?: unknown }).code ?? ""}` : String(error);
  if (/locked/i.test(text)) return "locked";
  if (/denied|not allowed|cancel|permission|unauthori[sz]ed/i.test(text)) return "access-denied";
  if (/default keychain/i.test(text)) return "no-default-keychain";
  if (/serviceunknown|namehasnoowner|no secret ?service|secret ?service provider is not running|not provided by any \.service files/i.test(text)) return "no-secret-service";
  if (/too (long|large|big)|longer than|size|length|limit/i.test(text)) return "too-large";
  // An unrecognised Linux read error may be a temporary failure with an existing entry: do not call it absent.
  return "failed";
}

const PROBLEM_WORDS: Record<KeychainProblem, string> = {
  "module-missing": "its native module could not be loaded",
  "no-secret-service": "no Secret Service answered",
  "no-default-keychain": "there is no default keychain for this user",
  locked: "it is locked",
  "access-denied": "access was denied",
  "too-large": "the entry is too large for it",
  failed: "it reported an error",
};

/** A fixed message per operation and problem class. */
function unavailable(platform: NodeJS.Platform, operation: "read" | "save" | "delete", error: unknown): KeychainUnavailableError {
  const problem = classifyKeychainError(error, platform);
  const label = storeLabel(platform);
  const what = { read: "read from", save: "save to", delete: "delete from" }[operation];
  if (problem === "no-secret-service") {
    return new KeychainUnavailableError(
      `No keychain is available here: on Linux the router stores keys in the Secret Service (GNOME Keyring or KWallet), and none answered. ${ALTERNATIVES}`,
      problem,
    );
  }
  return new KeychainUnavailableError(`Could not ${what} ${label}: ${PROBLEM_WORDS[problem]} (${problem}). ${ALTERNATIVES}`, problem);
}

export interface KeychainOptions {
  /** Kept for callers; the keychain no longer reads anything from the environment. */
  env?: Record<string, string | undefined>;
  loader?: KeyringLoader;
  platform?: NodeJS.Platform;
  /** Test seam: the keychain service. Defaults to programscape-router. The CLI never sets it. */
  service?: string;
}

/**
 * Opens the OS keychain. Throws KeychainUnavailableError, with a message that says what to do instead, when the
 * native module can't be loaded. A keychain that loads but can't be reached fails on first use the same way.
 * No error from here ever carries a native error's text.
 */
export async function openKeychain(options: KeychainOptions = {}): Promise<Keychain> {
  const platform = options.platform ?? process.platform;
  const service = options.service ?? defaultService;
  let keyring: KeyringModule;
  try {
    keyring = await (options.loader ?? defaultLoader)();
  } catch {
    throw new KeychainUnavailableError(
      `The OS keychain isn't available: its native module (@napi-rs/keyring, an optional dependency with prebuilt binaries for macOS, Windows and Linux) could not be loaded on this system (${platform} ${process.arch}). ${ALTERNATIVES}`,
      "module-missing",
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
        throw unavailable(platform, "read", error);
      }
    },
    async set(account, secret) {
      try {
        await entry(account).setPassword(secret);
      } catch (error) {
        throw unavailable(platform, "save", error);
      }
    },
    async remove(account) {
      try {
        return await entry(account).deleteCredential();
      } catch (error) {
        throw unavailable(platform, "delete", error);
      }
    },
  };
}

/** How to find and delete an entry by hand, per system. */
export function manualRemoval(service: string, account: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") {
    return `In Keychain Access, delete the item "${service}" with account "${account}", or run: security delete-generic-password -s ${service} -a ${account}`;
  }
  if (platform === "win32") {
    return `In Credential Manager (Windows Credentials, Generic Credentials), remove "${account}.${service}", or run: cmdkey /delete:${account}.${service}`;
  }
  return `In your keyring app (Seahorse or KWallet Manager), delete the item for service "${service}", username "${account}", or run: secret-tool clear service ${service} username ${account}`;
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
