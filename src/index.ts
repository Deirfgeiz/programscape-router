/**
 * programscape-router: route an AI agent's web search and scrape calls across the founder's own provider keys,
 * spending the credits that end first.
 *
 * The public API is everything exported here; anything else in the package is internal and may change in a minor
 * release. See the README for usage.
 */

// The router.
export { createRouter, RouterError } from "./router.js";
export type { Router, RouterOptions, RouterStatus, ProviderStatus, RouterErrorCode, HeadsUp } from "./router.js";

// The runway estimate (worked out locally from readings.json) and the programs that can add more (Programscape's
// public catalog), as router.status() and runCheck() report them.
export type { RunwayEstimate } from "./runway.js";
export type { CatalogProgram, CatalogProvider, ProviderPrograms } from "./catalog.js";

// Requests, results, outcomes and balances.
export * from "./types.js";

// The routing order shown in status (type-only: the order is computed by the router).
export type { CapabilityOrder, OrderEntry, SkippedEntry, Tier } from "./order.js";

// Keys: from the environment, or the OS keychain where a variable isn't set (pass the result as createRouter's `keys`).
export { resolveKeys } from "./keys.js";
export type { ResolvedKeys, KeySource } from "./keys.js";

// Config.
export { loadConfig, parseConfig, parseConfigWithNotes, ConfigError } from "./config.js";
export type { RouterConfig, CreditEntry, ConfigLocation } from "./config.js";

// The live check (`programscape-router check`).
export { runCheck, formatCheck, CHECK_QUERY, CHECK_MAX_RESULTS, CHECK_URL } from "./check.js";
export type { CheckReport, CheckProvider, CheckCall, CheckCapability, CheckOptions } from "./check.js";

// Formatting and the MCP server.
export { formatStatus } from "./format.js";
export { createMcpServer, runMcpServer } from "./mcp.js";

// The opt-in balance sync to the founder's Programscape plan (results of router.syncBalances() and status()).
export { ProgramscapeError } from "./programscape/guard.js";
export type { SyncResult, ProgramscapeSyncStatus, SyncMode } from "./programscape/sync.js";

// What the `fetch` options take.
export type { FetchLike } from "./providers/index.js";

export { VERSION } from "./version.js";
