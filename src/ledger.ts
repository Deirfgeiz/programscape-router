/**
 * The local ledger: counts only. For each UTC day, provider and capability it counts how
 * each call ended. It never stores a query, a URL, page content, a key or a balance.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { stateDir } from "./paths.js";
import { CAPABILITIES, PROVIDER_IDS, type Capability, type Outcome, type ProviderId } from "./types.js";

const OUTCOMES: readonly Outcome[] = [
  "ok",
  "exhausted",
  "rate_limited",
  "server_error",
  "timeout",
  "network_error",
  "unauthorized",
  "bad_request",
  "rejected",
  "fetch_failed",
  "invalid_response",
  "provider_error",
];

export type OutcomeCounts = Partial<Record<Outcome, number>>;
export type DayCounts = Partial<Record<ProviderId, Partial<Record<Capability, OutcomeCounts>>>>;

export interface LedgerFile {
  version: 1;
  about: string;
  days: Record<string, DayCounts>;
}

const ABOUT =
  "programscape-router call counts per UTC day, provider and capability. Counts only: no queries, URLs, content or keys.";

/** ~/.local/state/programscape-router/ledger.json; %LOCALAPPDATA%\programscape-router\ledger.json on Windows. */
export function defaultLedgerPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  return join(stateDir(env, platform), "ledger.json");
}

/** Keep only well-formed counts, so nothing else can ever be carried forward into the file. */
export function sanitizeLedger(input: unknown): LedgerFile {
  const clean: LedgerFile = { version: 1, about: ABOUT, days: {} };
  if (typeof input !== "object" || input === null) return clean;
  const days = (input as { days?: unknown }).days;
  if (typeof days !== "object" || days === null) return clean;
  for (const [day, providers] of Object.entries(days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || typeof providers !== "object" || providers === null) continue;
    for (const provider of PROVIDER_IDS) {
      const caps = (providers as Record<string, unknown>)[provider];
      if (typeof caps !== "object" || caps === null) continue;
      for (const capability of CAPABILITIES) {
        const outcomes = (caps as Record<string, unknown>)[capability];
        if (typeof outcomes !== "object" || outcomes === null) continue;
        for (const outcome of OUTCOMES) {
          const count = (outcomes as Record<string, unknown>)[outcome];
          if (typeof count === "number" && Number.isInteger(count) && count > 0) {
            const dayCounts = (clean.days[day] ??= {});
            const providerCounts = (dayCounts[provider] ??= {});
            const capabilityCounts = (providerCounts[capability] ??= {});
            capabilityCounts[outcome] = count;
          }
        }
      }
    }
  }
  return clean;
}

export class Ledger {
  readonly path: string;
  private queue: Promise<void> = Promise.resolve();
  private readonly onError: (message: string) => void;
  private warned = false;

  constructor(path: string, onError: (message: string) => void) {
    this.path = path;
    this.onError = onError;
  }

  async read(): Promise<LedgerFile> {
    try {
      return sanitizeLedger(JSON.parse(await readFile(this.path, "utf8")));
    } catch {
      return sanitizeLedger(undefined);
    }
  }

  /** Count one call. Never throws: a ledger problem must not break a search. */
  record(provider: ProviderId, capability: Capability, outcome: Outcome, now: Date = new Date()): Promise<void> {
    const day = now.toISOString().slice(0, 10);
    this.queue = this.queue.then(async () => {
      try {
        const ledger = await this.read();
        const dayCounts = (ledger.days[day] ??= {});
        const providerCounts = (dayCounts[provider] ??= {});
        const capabilityCounts = (providerCounts[capability] ??= {});
        capabilityCounts[outcome] = (capabilityCounts[outcome] ?? 0) + 1;
        await mkdir(dirname(this.path), { recursive: true });
        const temp = `${this.path}.${process.pid}.tmp`;
        await writeFile(temp, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
        await rename(temp, this.path);
      } catch (error) {
        if (!this.warned) {
          this.warned = true;
          const code = error instanceof Error && "code" in error ? ` (${String((error as { code: unknown }).code)})` : "";
          this.onError(`could not write the local ledger at ${this.path}${code}; calls still work.`);
        }
      }
    });
    return this.queue;
  }

  /** Resolves when every pending write has finished. */
  flush(): Promise<void> {
    return this.queue;
  }
}
