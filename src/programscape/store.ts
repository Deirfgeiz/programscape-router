/**
 * Local files for the opt-in Programscape balance sync.
 *
 * - The OAuth tokens live in the OS keychain (account programscape-token) between `connect` and `disconnect`. Only
 *   where there is no keychain, or it refuses the entry, do they go in the token file: mode 600 inside a directory
 *   with mode 700 on macOS and Linux. On Windows, POSIX modes don't apply, so the file is protected only by the
 *   default permissions of the user's profile folder (%LOCALAPPDATA%). Tokens are never printed or logged.
 * - The client file caches the dynamically registered public client (no secret), so a later `connect` can reuse it
 *   when the same loopback port is free.
 * - The sync state file records, per provider, when a sync was last tried and how it ended. It holds program ids,
 *   times and the outcome, never a token, key, query or URL.
 */
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { KEYCHAIN_SERVICE, type Keychain, manualRemoval, openKeychain } from "../keys.js";
import { stateDir, tokenDir } from "../paths.js";
import { PROVIDER_IDS, type ProviderId } from "../types.js";

export function tokenPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
  return join(tokenDir(env, platform), "programscape-token.json");
}

export function clientPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
  return join(tokenDir(env, platform), "programscape-client.json");
}

export function syncStatePath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
  return join(stateDir(env, platform), "programscape-sync.json");
}

export interface TokenFile {
  version: 1;
  issuer: string;
  clientId: string;
  accessToken: string;
  refreshToken?: string;
  /** ISO time the access token stops working. */
  expiresAt?: string;
  connectedAt: string;
  /** Save counter for diagnostics. It may lag a keychain copy that could not be read. */
  seq?: number;
  /** When this copy was saved. */
  savedAt?: string;
}

export interface ClientCache {
  version: 1;
  issuer: string;
  clientId: string;
  redirectUri: string;
}

export type ProviderSyncOutcome = "synced" | "unmapped" | "refused" | "failed";

export interface ProviderSyncRecord {
  /** Last attempt of any kind; the automatic sync waits six hours from this. */
  attemptedAt: string;
  outcome: ProviderSyncOutcome;
  /** Words for the founder: where the balance went, or why it did not. */
  message: string;
  syncedAt?: string;
  programId?: string;
}

export interface SyncState {
  version: 1;
  lastSyncedAt?: string;
  /** Set when sync turned itself off (a refresh was refused). Cleared by `connect`. */
  off?: { since: string; reason: string };
  providers: Partial<Record<ProviderId, ProviderSyncRecord>>;
}

/**
 * chmod, except on Windows, where it can only toggle the read-only flag. There the folder's own permissions (the
 * user's profile, restricted to that user by default) are what protect the file, so a chmod failure never stops a write.
 */
async function restrict(path: string, mode: number): Promise<void> {
  if (process.platform === "win32") {
    await chmod(path, mode).catch(() => undefined);
    return;
  }
  await chmod(path, mode);
}

/** Write JSON atomically: mode 600 in a directory with mode 700 on macOS and Linux; the user's profile folder on Windows. */
export async function writeSecureJson(path: string, value: unknown): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await restrict(dir, 0o700);
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await restrict(temp, 0o600);
  await rename(temp, path);
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const text = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);

/** The keychain account the Programscape tokens are stored under (service programscape-router). */
export const TOKEN_KEYCHAIN_ACCOUNT = "programscape-token";

/** Where the tokens are kept: the OS keychain when it can hold them, otherwise a file. */
export type TokenLocation = { kind: "keychain"; label: string } | { kind: "file"; path: string };

function parseTokens(raw: unknown): TokenFile | undefined {
  if (!isRecord(raw)) return undefined;
  const issuer = text(raw.issuer);
  const clientId = text(raw.clientId);
  const accessToken = text(raw.accessToken);
  const connectedAt = text(raw.connectedAt);
  if (!issuer || !clientId || !accessToken || !connectedAt) return undefined;
  const refreshToken = text(raw.refreshToken);
  const expiresAt = text(raw.expiresAt);
  const savedAt = text(raw.savedAt);
  const seq = typeof raw.seq === "number" && Number.isSafeInteger(raw.seq) && raw.seq >= 0 ? raw.seq : 0;
  return {
    version: 1,
    issuer,
    clientId,
    accessToken,
    connectedAt,
    seq,
    ...(savedAt ? { savedAt } : {}),
    ...(refreshToken ? { refreshToken } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  };
}

/** The OS keychain, or undefined when there is none here (the tokens then live in a file). */
async function tokenKeychain(): Promise<Keychain | undefined> {
  try {
    return await openKeychain();
  } catch {
    return undefined;
  }
}

/** Read each store separately, preserving whether the keychain was actually checked. */
async function readBoth(env: NodeJS.ProcessEnv, keychain: Keychain | undefined): Promise<{
  keychain?: TokenFile;
  keychainReadable: boolean;
  keychainPresent: boolean;
  file?: TokenFile;
}> {
  let fromKeychain: TokenFile | undefined;
  let keychainReadable = false;
  let keychainPresent = false;
  if (keychain) {
    try {
      const stored = await keychain.get(TOKEN_KEYCHAIN_ACCOUNT);
      keychainReadable = true;
      keychainPresent = stored !== null;
      if (stored) fromKeychain = parseTokens(JSON.parse(stored));
    } catch {
      // Unreadable keychain or entry.
    }
  }
  const fromFile = parseTokens(await readJson(tokenPath(env)));
  return { keychainReadable, keychainPresent, ...(fromKeychain ? { keychain: fromKeychain } : {}), ...(fromFile ? { file: fromFile } : {}) };
}

/**
 * A fallback file is authoritative while it exists. A keychain read may fail during rotation, leaving an older
 * keychain entry with a higher sequence number than the new file; comparing those numbers would reuse old tokens.
 */
export async function inspectTokenFile(env: NodeJS.ProcessEnv): Promise<{ tokens?: TokenFile; copies: TokenFile[]; readVerified: boolean }> {
  const both = await readBoth(env, await tokenKeychain());
  const filePresent = existsSync(tokenPath(env));
  const copies = both.file ? [both.file] : [];
  if (
    both.keychain &&
    (!both.file ||
      both.keychain.accessToken !== both.file.accessToken ||
      both.keychain.refreshToken !== both.file.refreshToken ||
      both.keychain.clientId !== both.file.clientId)
  ) copies.push(both.keychain);
  const readVerified = both.keychainReadable && (!both.keychainPresent || Boolean(both.keychain)) && (!filePresent || Boolean(both.file));
  // If the authoritative file exists but cannot be parsed, never fall through to an older keychain copy.
  if (filePresent) return { ...(both.file ? { tokens: both.file } : {}), copies, readVerified };
  return { ...(both.keychain ? { tokens: both.keychain } : {}), copies, readVerified };
}

export async function readTokenFile(env: NodeJS.ProcessEnv): Promise<TokenFile | undefined> {
  return (await inspectTokenFile(env)).tokens;
}

/**
 * Stores the tokens in the OS keychain (the same store as provider keys) and deletes any token file. Where the
 * keychain is unavailable or refuses the entry, writes the token file instead (mode 600 in a mode 700 folder on
 * macOS and Linux; on Windows, %LOCALAPPDATA%, protected only by the profile folder's default permissions) and then
 * tries to delete the stale keychain copy. If a fallback file already exists, updates it before trying the keychain
 * so a failed write or file cleanup cannot make an older token authoritative again.
 */
export async function writeTokenFile(env: NodeJS.ProcessEnv, tokens: Omit<TokenFile, "seq" | "savedAt">): Promise<TokenLocation> {
  const keychain = await tokenKeychain();
  const both = await readBoth(env, keychain);
  const seq = Math.max(both.keychain?.seq ?? 0, both.file?.seq ?? 0) + 1;
  const record: TokenFile = { ...tokens, seq, savedAt: new Date().toISOString() };
  const path = tokenPath(env);
  // Never overwrite or delete an entry whose old grant could not be read; keep it available for disconnect.
  const safeToWriteKeychain = Boolean(keychain && both.keychainReadable && (!both.keychainPresent || both.keychain));
  if (existsSync(path)) {
    try {
      await writeSecureJson(path, record);
    } catch (fileError) {
      // A recovered keychain can save the rotation when the old fallback file can no longer be updated.
      // The old file must then be removed: it would otherwise remain authoritative on the next read.
      if (!keychain || !safeToWriteKeychain) throw fileError;
      await keychain.set(TOKEN_KEYCHAIN_ACCOUNT, JSON.stringify(record));
      await rm(path, { force: true });
      return { kind: "keychain", label: keychain.label };
    }
  }
  if (keychain && safeToWriteKeychain) {
    try {
      await keychain.set(TOKEN_KEYCHAIN_ACCOUNT, JSON.stringify(record));
      try {
        await rm(path, { force: true });
        return { kind: "keychain", label: keychain.label };
      } catch {
        return { kind: "file", path };
      }
    } catch {
      // For example Windows Credential Manager's size limit, or a locked keychain: use the file instead.
    }
  }
  await writeSecureJson(path, record);
  if (keychain && safeToWriteKeychain) await keychain.remove(TOKEN_KEYCHAIN_ACCOUNT).catch(() => false);
  return { kind: "file", path };
}

/** What happened to each store's copy of the tokens on delete. */
export type DeleteState = "deleted" | "absent" | "failed" | "unavailable";

export interface TokenDeletion {
  keychain: DeleteState;
  file: DeleteState;
  /** True only when the keychain was checked and both stores were verified empty. */
  gone: boolean;
  /** How to delete what is left by hand, when something is. */
  manual?: string[];
}

/** Deletes the tokens from the keychain and the token file, then reads both back to confirm. */
export async function deleteTokenFile(env: NodeJS.ProcessEnv): Promise<TokenDeletion> {
  const keychain = await tokenKeychain();
  let keychainState: DeleteState = "unavailable";
  if (keychain) {
    try {
      keychainState = (await keychain.remove(TOKEN_KEYCHAIN_ACCOUNT)) ? "deleted" : "absent";
    } catch {
      keychainState = "failed";
    }
  }
  let fileState: DeleteState;
  const path = tokenPath(env);
  const hadFile = existsSync(path);
  try {
    await rm(path, { force: true });
    fileState = hadFile ? "deleted" : "absent";
  } catch {
    fileState = "failed";
  }
  const left = await readBoth(env, keychain);
  const manual: string[] = [];
  const keychainGone = left.keychainReadable && !left.keychainPresent;
  const fileGone = fileState !== "failed" && !existsSync(path);
  if (!keychainGone) manual.push(manualRemoval(keychain?.service ?? KEYCHAIN_SERVICE, TOKEN_KEYCHAIN_ACCOUNT));
  if (!fileGone) manual.push(`Delete the file ${path}.`);
  const gone = keychainGone && fileGone;
  return { keychain: keychainState, file: fileState, gone, ...(manual.length > 0 ? { manual } : {}) };
}

/** Whether tokens are stored, in the keychain or the file. */
export async function hasTokenFile(env: NodeJS.ProcessEnv): Promise<boolean> {
  return (await readTokenFile(env)) !== undefined;
}

export async function readClientCache(env: NodeJS.ProcessEnv): Promise<ClientCache | undefined> {
  const raw = await readJson(clientPath(env));
  if (!isRecord(raw)) return undefined;
  const issuer = text(raw.issuer);
  const clientId = text(raw.clientId);
  const redirectUri = text(raw.redirectUri);
  return issuer && clientId && redirectUri ? { version: 1, issuer, clientId, redirectUri } : undefined;
}

export async function deleteClientCache(env: NodeJS.ProcessEnv): Promise<void> {
  await rm(clientPath(env), { force: true });
}

export function writeClientCache(env: NodeJS.ProcessEnv, client: ClientCache): Promise<void> {
  return writeSecureJson(clientPath(env), client);
}

const OUTCOMES: readonly ProviderSyncOutcome[] = ["synced", "unmapped", "refused", "failed"];

/** Read the sync state, keeping only well-formed fields. */
export async function readSyncState(env: NodeJS.ProcessEnv): Promise<SyncState> {
  const raw = await readJson(syncStatePath(env));
  const clean: SyncState = { version: 1, providers: {} };
  if (!isRecord(raw)) return clean;
  const last = text(raw.lastSyncedAt);
  if (last) clean.lastSyncedAt = last;
  if (isRecord(raw.off) && text(raw.off.since) && text(raw.off.reason)) {
    clean.off = { since: raw.off.since as string, reason: raw.off.reason as string };
  }
  const providers = isRecord(raw.providers) ? raw.providers : {};
  for (const id of PROVIDER_IDS) {
    const entry = providers[id];
    if (!isRecord(entry)) continue;
    const attemptedAt = text(entry.attemptedAt);
    const message = text(entry.message);
    const outcome = OUTCOMES.find((candidate) => candidate === entry.outcome);
    if (!attemptedAt || !message || !outcome) continue;
    const syncedAt = text(entry.syncedAt);
    const programId = text(entry.programId);
    clean.providers[id] = {
      attemptedAt,
      outcome,
      message,
      ...(syncedAt ? { syncedAt } : {}),
      ...(programId ? { programId } : {}),
    };
  }
  return clean;
}

export function writeSyncState(env: NodeJS.ProcessEnv, state: SyncState): Promise<void> {
  return writeSecureJson(syncStatePath(env), state);
}

export async function deleteSyncState(env: NodeJS.ProcessEnv): Promise<void> {
  await rm(syncStatePath(env), { force: true });
}
