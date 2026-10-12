/**
 * What the router has already told the founder (0151), so it says each thing once: notices.json beside the ledger.
 *
 * - `introducedAt`: when the programs that can add more were first shown after `keys set`.
 * - `headsUp`: per provider, the UTC day its last heads-up went out in an MCP tool result (one per provider per day).
 *
 * Nothing else: no key, balance, query or URL.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { stateDir } from "./paths.js";
import { writeSecureJson } from "./programscape/store.js";
import { PROVIDER_IDS, type ProviderId } from "./types.js";

export interface NoticesFile {
  version: 1;
  introducedAt?: string;
  headsUp: Partial<Record<ProviderId, string>>;
}

/** ~/.local/state/programscape-router/notices.json; %LOCALAPPDATA%\programscape-router\notices.json on Windows. */
export function defaultNoticesPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  return join(stateDir(env, platform), "notices.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readNotices(path: string): Promise<NoticesFile> {
  const clean: NoticesFile = { version: 1, headsUp: {} };
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!isRecord(raw)) return clean;
    if (typeof raw.introducedAt === "string" && !Number.isNaN(Date.parse(raw.introducedAt))) clean.introducedAt = raw.introducedAt;
    const headsUp = isRecord(raw.headsUp) ? raw.headsUp : {};
    for (const id of PROVIDER_IDS) {
      const day = headsUp[id];
      if (typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day)) clean.headsUp[id] = day;
    }
  } catch {
    // No file yet, or an unreadable one: nothing has been said.
  }
  return clean;
}

/**
 * Of `providers`, the ones whose heads-up hasn't gone out today (UTC), recorded as gone out now. If the file can't be
 * written, the heads-up still goes out (it may then repeat later the same day).
 */
export async function claimHeadsUps(path: string, providers: readonly ProviderId[], now: Date): Promise<ProviderId[]> {
  const today = now.toISOString().slice(0, 10);
  const file = await readNotices(path);
  const due = providers.filter((id) => file.headsUp[id] !== today);
  if (due.length === 0) return [];
  for (const id of due) file.headsUp[id] = today;
  await writeSecureJson(path, file).catch(() => undefined);
  return due;
}

/** Whether the programs have been shown after a `keys set` before. */
export async function introduced(path: string): Promise<boolean> {
  return (await readNotices(path)).introducedAt !== undefined;
}

/** Records that the programs were shown after a `keys set`. */
export async function markIntroduced(path: string, now: Date): Promise<void> {
  const file = await readNotices(path);
  file.introducedAt = now.toISOString();
  await writeSecureJson(path, file).catch(() => undefined);
}
