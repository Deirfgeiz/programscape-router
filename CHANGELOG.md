# Changelog

All notable changes to programscape-router. The project follows [Semantic Versioning](https://semver.org): from
1.0.0, the public API is what `programscape-router` exports from its package entry point (listed below), the CLI
commands and their `--json` output, the MCP tools, and the config file format.

## 1.0.0 (unreleased)

The first release meant for npm. 0.1.0 was only ever installed from GitHub.

### Added

- `programscape-router check [--json]`: one live search (`"startup credits"`, up to 3 results) and one scrape
  (`https://example.com`) per provider with a key set, plus a balance read for Firecrawl and Tavily. Each adapter is
  called directly, with no routing or failover. The report gives, per call, ok or the failure class, the provider's
  HTTP status, latency, and a result count or markdown length; for a failure, the provider's own message with every
  key redacted. It never prints a result title, URL, snippet or page content, and never a balance amount. It writes
  nothing to the ledger, never contacts Programscape and does not read the config file. Exits 0 only when at least
  one call was made and every call passed. Also available as `runCheck()` and `formatCheck()`.
- README: Troubleshooting, by failure class.
- `CHANGELOG.md`, and a pack-and-import smoke test in CI (`npm run smoke:pack`).

### Changed

- Exa `403 FEATURE_DISABLED` (the endpoint or option is not on the plan) is now a `provider_error` for that call, not
  `unauthorized`. The key is fine, so Exa is no longer switched off for the session, and the other capability keeps
  working.
- Exa contents and Parallel extract: when the target page could not be fetched, the page's own HTTP status now goes
  in the message ("the page answered HTTP 404") instead of `status`, which is reserved for the provider's own answer.
- Every adapter re-read against its official API docs on 2026-10-11; the doc links and the fields sent are recorded at
  the top of each adapter's source. No request shape changed.
- The build no longer ships source maps (they pointed at sources the package does not include), and starts from a
  clean `dist/`.
- `package.json` also exports `./package.json`.

### Removed from the public API

These were exported by 0.1.0 but are internal. Use the CLI, or `createRouter()`, instead.

- `computeOrder` and `ProviderStanding`: the router computes the order; `router.status()` returns it.
- `configSchema`: use `parseConfig()` to validate a config object.
- `createBalanceSync`, `AUTO_SYNC_INTERVAL_MS`, `BalanceSync`, `BalanceReport`, `ProviderReading`: the router owns the
  balance sync; use `router.syncBalances()` and `router.status().programscape`.
- `connect`, `disconnect`: use `programscape-router connect` and `programscape-router disconnect`.
- `PROGRAMSCAPE_MCP_URL`, `PROGRAMSCAPE_ORIGIN`.

### Public API in 1.0.0

Values: `createRouter`, `RouterError`, `loadConfig`, `parseConfig`, `ConfigError`, `runCheck`, `formatCheck`,
`CHECK_QUERY`, `CHECK_MAX_RESULTS`, `CHECK_URL`, `formatStatus`, `createMcpServer`, `runMcpServer`,
`ProgramscapeError`, `PROVIDER_IDS`, `CAPABILITIES`, `VERSION`.

Types: `Router`, `RouterOptions`, `RouterStatus`, `ProviderStatus`, `RouterErrorCode`, `RouterConfig`,
`CreditEntry`, `ConfigLocation`, `CheckReport`, `CheckProvider`, `CheckCall`, `CheckCapability`, `CheckOptions`,
`CapabilityOrder`, `OrderEntry`, `SkippedEntry`, `Tier`, `SyncResult`, `ProgramscapeSyncStatus`, `SyncMode`,
`FetchLike`, and everything in `types.ts` (`ProviderId`, `Capability`, `SearchRequest`, `ScrapeRequest`,
`SearchResult`, `ScrapeResult`, `SearchResponse`, `ScrapeResponse`, `Outcome`, `Attempt`, `OrderRule`, `Routing`,
`Balance`, `BalanceKind`).

## 0.1.0 (2026-10-11, GitHub only)

- Adapters for Exa, Firecrawl, Keenable, Parallel and Tavily, each built from the provider's official API docs.
- Routing by credits ending first (or your own order), with failover on spent credits, rate limits, server errors,
  timeouts and pages a provider could not fetch; a refused key switches that provider off for the session.
- Live balances from Firecrawl (`/v2/team/credit-usage`) and Tavily (`/usage`); credits you hold can be entered in
  config. Balances are never added together.
- A counts-only local ledger. No telemetry. Keys go only to their own provider, and redirects are never followed.
- A local MCP server (`search`, `scrape`, `credits_status`) and a CLI (`status`, `search`, `scrape`).
- Opt-in balance sync to the founder's Programscape plan (`connect`, `sync`, `disconnect`), sending only
  `{ programId, amount, unit, asOf, source }` for balances read live from a provider.
