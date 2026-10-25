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
 *   times and the outcome, never a token, key, query or URL. It also keeps, per provider, the founder's own expiration
 *   date and award for the approved program that provider maps to, as `my_plan` returned them (0151 ruling 5).
 */
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { KEYCHAIN_SERVICE, KeychainUnavailableError, type Keychain, openKeychain } from "../keys.js";
import { stateDir, tokenDir } from "../paths.js";
import { PROVIDER_IDS, type ProviderId } from "../types.js";

export function tokenPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
  return join(tokenDir(env, platform), "programscape-token.json");
}

export function connectionLockPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
  return join(tokenDir(env, platform), "programscape-connection.locks");
}

/** Nonsecret reminder that a grant may exist even while its keychain backend is unavailable. */
export function connectionMarkerPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
  return join(tokenDir(env, platform), "programscape-connection.json");
}

/** One local lifecycle state. Absence of the file means disconnected. The keychain field describes storage, not state. */
export type ConnectionPhase = "disconnected" | "awaiting-consent" | "connected" | "sync-off" | "cleanup-needed";
export interface ConnectionState {
  phase: Exclude<ConnectionPhase, "disconnected">;
  /** Set before any attempt to save this grant in the keychain. */
  keychainMayHoldGrant: boolean;
  /** Fences a browser callback after another process has disconnected or started a new sign-in. */
  attemptId?: string;
}

export type ConnectionEvent =
  | "begin-connect" | "begin-exchange" | "cancel-connect" | "connect-succeeded" | "connect-rejected"
  | "begin-refresh" | "refresh-succeeded" | "refresh-refused"
  | "begin-disconnect" | "local-cleared";

/** Allowed lifecycle transitions; every persistent change passes through this table. */
const TRANSITIONS: Record<ConnectionEvent, readonly ConnectionPhase[]> = {
  "begin-connect": ["disconnected"],
  "begin-exchange": ["awaiting-consent"],
  "cancel-connect": ["awaiting-consent"],
  "connect-succeeded": ["cleanup-needed"],
  "connect-rejected": ["cleanup-needed"],
  "begin-refresh": ["connected"],
  "refresh-succeeded": ["cleanup-needed"],
  "refresh-refused": ["cleanup-needed"],
  "begin-disconnect": ["disconnected", "awaiting-consent", "connected", "sync-off", "cleanup-needed"],
  "local-cleared": ["cleanup-needed"],
};
const NEXT_PHASE: Record<ConnectionEvent, ConnectionPhase> = {
  "begin-connect": "awaiting-consent",
  "begin-exchange": "cleanup-needed",
  "cancel-connect": "disconnected",
  "connect-succeeded": "connected",
  "connect-rejected": "disconnected",
  "begin-refresh": "cleanup-needed",
  "refresh-succeeded": "connected",
  "refresh-refused": "sync-off",
  "begin-disconnect": "cleanup-needed",
  "local-cleared": "disconnected",
};

export function nextConnectionPhase(current: ConnectionPhase, event: ConnectionEvent): ConnectionPhase {
  if (!TRANSITIONS[event].includes(current)) throw new Error(`Invalid Programscape connection transition: ${current} + ${event}.`);
  return NEXT_PHASE[event];
}

export async function readConnectionState(env: NodeJS.ProcessEnv): Promise<ConnectionState | undefined> {
  const path = connectionMarkerPath(env);
  if (!existsSync(path)) return undefined;
  const raw = await readJson(path);
  // Accept the old marker written by the unreleased branch. A damaged marker requires cleanup.
  const phase = isRecord(raw) && (raw.phase === "awaiting-consent" || raw.phase === "connected" || raw.phase === "sync-off" || raw.phase === "cleanup-needed")
    ? raw.phase
    : isRecord(raw) && raw.remoteGrantUncertain === true ? "cleanup-needed"
      : isRecord(raw) && raw.syncOff === true ? "sync-off" : isRecord(raw) && raw.remoteGrantUncertain === false ? "connected" : "cleanup-needed";
  return {
    phase,
    keychainMayHoldGrant: !isRecord(raw) || raw.keychainMayHoldGrant !== false,
    ...(isRecord(raw) && typeof raw.attemptId === "string" ? { attemptId: raw.attemptId } : {}),
  };
}

export async function writeConnectionState(env: NodeJS.ProcessEnv, state: ConnectionState): Promise<void> {
  await writeSecureJson(connectionMarkerPath(env), { version: 2, ...state });
}

export async function markConnectionKeychainPossible(env: NodeJS.ProcessEnv): Promise<void> {
  const state = await readConnectionState(env);
  if (state && !state.keychainMayHoldGrant) await writeConnectionState(env, { ...state, keychainMayHoldGrant: true });
}

export async function transitionConnection(env: NodeJS.ProcessEnv, event: ConnectionEvent, keychainMayHoldGrant = false, attemptId?: string): Promise<ConnectionPhase> {
  const current = await readConnectionState(env);
  const phase = nextConnectionPhase(current?.phase ?? "disconnected", event);
  if (phase === "disconnected") await deleteConnectionMarker(env);
  else await writeConnectionState(env, { phase, keychainMayHoldGrant: current?.keychainMayHoldGrant ?? keychainMayHoldGrant, ...(event === "begin-connect" && attemptId ? { attemptId } : {}) });
  return phase;
}

export async function deleteConnectionMarker(env: NodeJS.ProcessEnv): Promise<void> {
  await rm(connectionMarkerPath(env), { force: true });
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
  /** The configured company selection, absent for the account's default single plan. */
  planId?: string;
  /** Last attempt of any kind; the automatic sync waits six hours from this. */
  attemptedAt: string;
  outcome: ProviderSyncOutcome;
  /** Words for the founder: where the balance went, or why it did not. */
  message: string;
  syncedAt?: string;
  programId?: string;
}

/** The founder's own dates for the approved program a provider maps to, as `my_plan` returned them. Never computed. */
export interface PlanDates {
  programId: string;
  name?: string;
  /** The founder's own expiration date (YYYY-MM-DD). */
  expiresOn?: string;
  /** The award the founder entered. */
  award?: { amount: number; unit: string };
}

export interface SyncState {
  version: 1;
  lastSyncedAt?: string;
  providers: Partial<Record<ProviderId, ProviderSyncRecord>>;
  /** From the last read of the plan: when it was read, and the dates per provider. */
  plan?: { readAt: string; planId?: string; dates: Partial<Record<ProviderId, PlanDates>> };
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

/** A new sign-in must not replace a grant that still needs to be revoked. */
export class TokenStoreOccupiedError extends Error {
  constructor() {
    super("A Programscape token entry is already stored.");
    this.name = "TokenStoreOccupiedError";
  }
}

export class ConnectionLockError extends Error {
  constructor(path: string) {
    super(`Another Programscape connection change is running. Retry shortly; an abandoned lock at ${path} is reclaimed automatically.`);
    this.name = "ConnectionLockError";
  }
}

const LOCK_MAX_AGE_MS = 2 * 60_000;
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const heldLocks = new Map<string, string>();

function cleanHeldLocks(): void {
  for (const [path, marker] of heldLocks) {
    try {
      if (readFileSync(path, "utf8") === marker) rmSync(path, { force: true });
    } catch { /* The next process can reclaim an abandoned lock. */ }
  }
  heldLocks.clear();
}

function onSignal(signal: typeof SIGNALS[number]): void {
  // A library caller may handle this signal and continue running. Keep serialization until the work's finally
  // block in that case; removing the lock while the operation is live would let another process mutate the grant.
  if (process.listenerCount(signal) > 1) return;
  cleanHeldLocks();
  removeSignalHandlers();
  process.kill(process.pid, signal);
}

const signalHandlers = Object.fromEntries(SIGNALS.map((signal) => [signal, () => onSignal(signal)])) as Record<typeof SIGNALS[number], () => void>;
function addSignalHandlers(): void {
  if (heldLocks.size !== 1) return;
  for (const signal of SIGNALS) process.on(signal, signalHandlers[signal]);
}
function removeSignalHandlers(): void {
  for (const signal of SIGNALS) process.off(signal, signalHandlers[signal]);
}

interface LockEntry { pid: number; createdAt: number; ownerStartedAt: number; nonce: string; ticket?: number }

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return !isRecord(error) || error.code !== "ESRCH"; }
}

/** OS process start time distinguishes a reused PID from the process that wrote an old lock entry. */
function processStartedAt(pid: number): number | undefined {
  if (pid === process.pid) return Date.now() - process.uptime() * 1000;
  try {
    const output = process.platform === "win32"
      ? execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`], { encoding: "utf8", timeout: 1500, stdio: ["ignore", "pipe", "ignore"] })
      : execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 1500, stdio: ["ignore", "pipe", "ignore"] });
    const parsed = Date.parse(output.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  } catch { return undefined; }
}

async function contenders(dir: string, starts: Map<string, number | undefined>): Promise<Array<{ name: string; entry?: LockEntry; choosing: boolean }>> {
  const names = await readdir(dir);
  const found: Array<{ name: string; entry?: LockEntry; choosing: boolean }> = [];
  for (const name of names) {
    const path = join(dir, name);
    const pid = Number(name.split(".", 1)[0]);
    if (!Number.isSafeInteger(pid) || pid < 1) {
      const info = await stat(path).catch(() => undefined);
      if (info && info.mtimeMs < Date.now() - LOCK_MAX_AGE_MS) await rm(path, { force: true }).catch(() => undefined);
      else if (info) found.push({ name, choosing: true });
      continue;
    }
    if (!processAlive(pid)) { await rm(path, { force: true }).catch(() => undefined); continue; }
    const raw = await readFile(path, "utf8").catch(() => "");
    let entry: LockEntry | undefined;
    let owner: LockEntry | undefined;
    try {
      const parsed = JSON.parse(raw) as LockEntry;
      if (parsed.pid === pid && Number.isFinite(parsed.ownerStartedAt)) {
        owner = parsed;
        if (Number.isSafeInteger(parsed.ticket) && (parsed.ticket ?? 0) > 0) entry = parsed;
      }
    } catch { /* A contender may still be choosing or writing its ticket. */ }
    if (owner) {
      if (!starts.has(name)) starts.set(name, processStartedAt(pid));
      const startedAt = starts.get(name);
      if (startedAt !== undefined && Math.abs(startedAt - owner.ownerStartedAt) > 3_000) {
        await rm(path, { force: true }).catch(() => undefined);
        continue;
      }
    }
    if (!entry) {
      const info = await stat(path).catch(() => undefined);
      if (!info) continue;
      if (!owner) {
        if (!starts.has(name)) starts.set(name, processStartedAt(pid));
        const startedAt = starts.get(name);
        if (startedAt !== undefined && startedAt > info.mtimeMs + 3_000) {
          await rm(path, { force: true }).catch(() => undefined);
          continue;
        }
      }
    }
    found.push({ name, ...(entry ? { entry } : {}), choosing: !entry });
  }
  return found;
}

/** Bakery-style lock: each process owns a unique entry. Dead entries are ignored; no contender unlinks another's live lock. */
export async function withConnectionLock<T>(env: NodeJS.ProcessEnv, work: () => Promise<T>): Promise<T> {
  const dir = connectionLockPath(env);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await restrict(dir, 0o700);
  const nonce = randomUUID();
  const name = `${process.pid}.${nonce}.json`;
  const path = join(dir, name);
  const base: LockEntry = { pid: process.pid, createdAt: Date.now(), ownerStartedAt: processStartedAt(process.pid)!, nonce };
  await writeFile(path, JSON.stringify(base), { flag: "wx", mode: 0o600 });
  try {
    const starts = new Map<string, number | undefined>();
    const initial = await contenders(dir, starts);
    const ticket = 1 + Math.max(0, ...initial.map((other) => other.entry?.ticket ?? 0));
    const ready = JSON.stringify({ ...base, ticket });
    await writeFile(path, ready);
    const deadline = Date.now() + 500;
    for (;;) {
      const current = await contenders(dir, starts);
      if (!current.some((other) => other.name === name)) throw new ConnectionLockError(dir);
      const blocks = current.some((other) => other.name !== name && (other.choosing ||
        (other.entry!.ticket! < ticket || (other.entry!.ticket === ticket && other.name < name))));
      if (!blocks) break;
      if (Date.now() >= deadline) throw new ConnectionLockError(dir);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    heldLocks.set(path, ready);
    addSignalHandlers();
    return await work();
  } finally {
    heldLocks.delete(path);
    if (heldLocks.size === 0) removeSignalHandlers();
    await rm(path, { force: true }).catch(() => undefined);
  }
}

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
  keychainBackendUnavailable: boolean;
  file?: TokenFile;
}> {
  let fromKeychain: TokenFile | undefined;
  let keychainReadable = false;
  let keychainPresent = false;
  let keychainBackendUnavailable = false;
  if (keychain) {
    try {
      const stored = await keychain.get(TOKEN_KEYCHAIN_ACCOUNT);
      keychainReadable = true;
      keychainPresent = stored !== null;
      if (stored) fromKeychain = parseTokens(JSON.parse(stored));
    } catch (error) {
      // Unreadable keychain or entry.
      keychainBackendUnavailable = error instanceof KeychainUnavailableError &&
        (error.problem === "no-secret-service" || error.problem === "no-default-keychain");
    }
  }
  const fromFile = parseTokens(await readJson(tokenPath(env)));
  return { keychainReadable, keychainPresent, keychainBackendUnavailable, ...(fromKeychain ? { keychain: fromKeychain } : {}), ...(fromFile ? { file: fromFile } : {}) };
}

/**
 * A fallback file is authoritative while it exists. A keychain read may fail during rotation, leaving an older
 * keychain entry with a higher sequence number than the new file; comparing those numbers would reuse old tokens.
 */
export async function inspectTokenFile(env: NodeJS.ProcessEnv): Promise<{
  tokens?: TokenFile;
  copies: TokenFile[];
  hasLocalEntry: boolean;
  keychainLoaded: boolean;
  /** The module should be usable, but opening it failed unexpectedly. */
  keychainOpenFailed: boolean;
  keychainReadable: boolean;
  keychainBackendUnavailable: boolean;
  readVerified: boolean;
}> {
  let keychain: Keychain | undefined;
  let keychainOpenFailed = false;
  try {
    keychain = await openKeychain();
  } catch (error) {
    keychainOpenFailed = !(error instanceof KeychainUnavailableError &&
      (error.problem === "module-missing" || error.problem === "no-secret-service" || error.problem === "no-default-keychain"));
  }
  const both = await readBoth(env, keychain);
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
  const hasLocalEntry = both.keychainPresent || filePresent;
  // If the authoritative file exists but cannot be parsed, never fall through to an older keychain copy.
  const status = { copies, hasLocalEntry, keychainLoaded: Boolean(keychain), keychainOpenFailed, keychainReadable: both.keychainReadable, keychainBackendUnavailable: both.keychainBackendUnavailable, readVerified };
  if (filePresent) return { ...(both.file ? { tokens: both.file } : {}), ...status };
  return { ...(both.keychain ? { tokens: both.keychain } : {}), ...status };
}

export async function readTokenFile(env: NodeJS.ProcessEnv): Promise<TokenFile | undefined> {
  return (await inspectTokenFile(env)).tokens;
}

/**
 * Stores the tokens in the OS keychain (the same store as provider keys) and deletes any token file. Where the
 * keychain is unavailable or refuses the entry, writes the token file instead (mode 600 in a mode 700 folder on
 * macOS and Linux; on Windows, %LOCALAPPDATA%, protected only by the profile folder's default permissions) and then
 * tries to delete the stale keychain copy. If a fallback file already exists, updates it before trying the keychain
 * so a failed write or file cleanup cannot make an older token authoritative again. A distinct old keychain pair is
 * preserved for disconnect to revoke, rather than overwritten by a later refresh.
 */
export async function writeTokenFile(
  env: NodeJS.ProcessEnv,
  tokens: Omit<TokenFile, "seq" | "savedAt">,
  options: { requireEmpty?: boolean } = {},
): Promise<TokenLocation> {
  const keychain = await tokenKeychain();
  const both = await readBoth(env, keychain);
  if (options.requireEmpty && (both.keychainPresent || existsSync(tokenPath(env)) || (keychain && !both.keychainReadable && !both.keychainBackendUnavailable))) {
    throw new TokenStoreOccupiedError();
  }
  const seq = Math.max(both.keychain?.seq ?? 0, both.file?.seq ?? 0) + 1;
  const record: TokenFile = { ...tokens, seq, savedAt: new Date().toISOString() };
  const path = tokenPath(env);
  if (keychain && both.keychainReadable) await markConnectionKeychainPossible(env);
  // A failed fallback cleanup can leave a different (possibly still active) grant in the keychain. Never replace
  // that entry while refreshing the file: disconnect must be able to read and revoke both pairs.
  const distinctKeychainGrant = Boolean(both.file && both.keychain && (
    both.file.clientId !== both.keychain.clientId ||
    both.file.accessToken !== both.keychain.accessToken ||
    both.file.refreshToken !== both.keychain.refreshToken
  ));
  // Never overwrite or delete an entry whose old grant could not be read; keep it available for disconnect.
  const safeToWriteKeychain = Boolean(keychain && both.keychainReadable && (!both.keychainPresent || both.keychain));
  if (existsSync(path)) {
    try {
      await writeSecureJson(path, record);
    } catch (fileError) {
      // A recovered keychain can save the rotation when the old fallback file can no longer be updated.
      // The old file must then be removed: it would otherwise remain authoritative on the next read.
      if (!keychain || !safeToWriteKeychain || distinctKeychainGrant) throw fileError;
      await keychain.set(TOKEN_KEYCHAIN_ACCOUNT, JSON.stringify(record));
      await rm(path, { force: true });
      return { kind: "keychain", label: keychain.label };
    }
  }
  if (distinctKeychainGrant) return { kind: "file", path };
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
  if (!keychainGone) manual.push(`Unlock or repair the OS keychain, then rerun \`programscape-router disconnect\`. The router entry is ${keychain?.service ?? KEYCHAIN_SERVICE}/${TOKEN_KEYCHAIN_ACCOUNT}.`);
  if (!fileGone) manual.push(`Restore write access to ${path}, then rerun \`programscape-router disconnect\`.`);
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
    const planId = text(entry.planId);
    clean.providers[id] = {
      ...(planId ? { planId } : {}),
      attemptedAt,
      outcome,
      message,
      ...(syncedAt ? { syncedAt } : {}),
      ...(programId ? { programId } : {}),
    };
  }
  const plan = isRecord(raw.plan) ? raw.plan : undefined;
  const readAt = plan ? text(plan.readAt) : undefined;
  if (plan && readAt) {
    const dates = isRecord(plan.dates) ? plan.dates : {};
    const planId = text(plan.planId);
    clean.plan = { readAt, ...(planId ? { planId } : {}), dates: {} };
    for (const id of PROVIDER_IDS) {
      const entry = dates[id];
      const parsed = isRecord(entry) ? readPlanDates(entry) : undefined;
      if (parsed) clean.plan.dates[id] = parsed;
    }
  }
  return clean;
}

/** A plan date as the founder entered it: a real calendar day, YYYY-MM-DD. */
export function isPlanDay(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function readPlanDates(entry: Record<string, unknown>): PlanDates | undefined {
  const programId = text(entry.programId);
  if (!programId) return undefined;
  const name = text(entry.name);
  const award = isRecord(entry.award) ? entry.award : undefined;
  const amount = award && typeof award.amount === "number" && Number.isFinite(award.amount) && award.amount >= 0 ? award.amount : undefined;
  const unit = award ? text(award.unit) : undefined;
  return {
    programId,
    ...(name ? { name } : {}),
    ...(isPlanDay(entry.expiresOn) ? { expiresOn: entry.expiresOn } : {}),
    ...(amount !== undefined && unit ? { award: { amount, unit } } : {}),
  };
}

export function writeSyncState(env: NodeJS.ProcessEnv, state: SyncState): Promise<void> {
  return writeSecureJson(syncStatePath(env), state);
}

export async function deleteSyncState(env: NodeJS.ProcessEnv): Promise<void> {
  await rm(syncStatePath(env), { force: true });
}
