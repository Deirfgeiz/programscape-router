/**
 * Local files for the opt-in Programscape balance sync.
 *
 * - The token file holds the OAuth tokens. It exists only between `connect` and `disconnect`. On macOS and Linux it
 *   is written with mode 600 inside a directory with mode 700. On Windows, POSIX modes don't apply: the file sits in
 *   the user's own profile folder (%LOCALAPPDATA%), which Windows restricts to that user by default. Tokens are
 *   never printed or logged.
 * - The client file caches the dynamically registered public client (no secret), so a later `connect` can reuse it
 *   when the same loopback port is free.
 * - The sync state file records, per provider, when a sync was last tried and how it ended. It holds program ids,
 *   times and the outcome, never a token, key, query or URL.
 */
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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

export async function readTokenFile(env: NodeJS.ProcessEnv): Promise<TokenFile | undefined> {
  const raw = await readJson(tokenPath(env));
  if (!isRecord(raw)) return undefined;
  const issuer = text(raw.issuer);
  const clientId = text(raw.clientId);
  const accessToken = text(raw.accessToken);
  const connectedAt = text(raw.connectedAt);
  if (!issuer || !clientId || !accessToken || !connectedAt) return undefined;
  const refreshToken = text(raw.refreshToken);
  const expiresAt = text(raw.expiresAt);
  return {
    version: 1,
    issuer,
    clientId,
    accessToken,
    connectedAt,
    ...(refreshToken ? { refreshToken } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  };
}

export function writeTokenFile(env: NodeJS.ProcessEnv, tokens: TokenFile): Promise<void> {
  return writeSecureJson(tokenPath(env), tokens);
}

export async function deleteTokenFile(env: NodeJS.ProcessEnv): Promise<void> {
  await rm(tokenPath(env), { force: true });
}

export async function hasTokenFile(env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    return (await stat(tokenPath(env))).isFile();
  } catch {
    return false;
  }
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
