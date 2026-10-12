# Changelog

All notable changes to programscape-router. The project follows [Semantic Versioning](https://semver.org): from
1.0.0, the public API is what `programscape-router` exports from its package entry point (listed below), the CLI
commands and their `--json` output, the MCP tools, and the config file format.

## 1.1.0 (October 12, 2026)

Two new providers, Linkup and You.com, and "extend before they end": a runway estimate, a heads-up while there's
still time, and the programs that can add more.

### Extend before they end

Programscape decision 0151, "extend before they end": warn while there's time, and show what can add more. The site
side (the catalog endpoint, `my_plan` dates and the estimate on the plan) is founder-ecosystem#541, live on
programscape.com. If the catalog can't be reached, the read fails quietly and the router works as before.

#### Added

- **Balance readings.** Every live balance read (Firecrawl, Linkup, Tavily, You.com) is kept in `readings.json` beside
  the ledger: provider, balance label, unit, remaining, total if known, and when it was read. Nothing else. 90 days are
  kept; readings less than an hour apart are thinned to the latest (a rise is always kept); at most 500 per provider.
  The ledger stays counts-only.
- **Runway estimate.** From the readings since a balance last rose (a top-up or reset starts a new window), with at
  least two readings 24 hours apart: pace = what was used / days, days left = remaining / pace, rounded down. Shown as
  *About N days* (under 14), *About N weeks* (under 60) or *About N months*, always labelled: "About 3 weeks left on
  Firecrawl at your recent pace (estimate)". When the provider reports its billing period end and the balance lasts
  past it, it says *Lasts past this period* instead. In `status` (`providers[].runway`), `credits_status` and `check`
  (`providers[].runway`, our own words and whole days only).
- **Heads-up.** When an estimate is under the threshold, or an end date the founder gave (config or plan) is within it,
  `status` and `credits_status` list it under `headsUp`, with the short programs list and the `/extend/<provider>` link.
  `search` and `scrape` MCP results carry it as `notice`, at most once per provider per UTC day (remembered in
  `notices.json`). Threshold: config `headsUp.days` (default 30; `0` turns it off). `router.headsUpNotice()` returns the
  same notice.
- **Programs that can add more.** The router reads Programscape's public catalog (`GET
  https://programscape.com/api/router/programs?providers=<ids>`) with only the ids of providers with a key set and a
  `programscape-router/<version>` User-Agent: no key, query, URL, balance, token or identifier. At most once a day
  (again the same day only for a newly keyed provider), cached in `catalog.json`, 3-second timeout, through the same
  programscape.com-only, no-redirect guard as the sync. Any failure is silent. Off with
  `"programscape": { "catalog": false }` or `PROGRAMSCAPE_ROUTER_CATALOG=off`. The short version (program names, *Ask
  {Provider}* where it applies, and the link) shows after the first `keys set` ever, in `check`, in `status` and in the
  heads-up. The catalog's order is kept; nothing is ranked, and nothing says the founder qualifies.
- `programscape-router programs [--json]`: the full list for the providers with a key, including other providers that
  do the same job, each program with its official source and checked date.
- **Two-way sync.** Each sync now reads `my_plan` even when no balance is due, and keeps, per provider, the founder's
  own `expiresOn` and `award` for the approved program it maps to. Under credits ending first, the plan's date orders
  that provider (a `"plan"` balance in `status`), unless config gives the provider a date, which wins. This gives Exa,
  Keenable and Parallel real end dates without a config file. `disconnect` deletes them with the sync record.
- `report_balance` carries `estimate: { daysLeft }` with a balance when the router has an estimate for it (not when it
  lasts past the period or exceeds 3650 days). A plan that refuses the estimate gets the balance again without it.
- Config: `headsUp.days`, `programscape.catalog`. `createRouter` options: `readingsPath`, `catalogPath`, `noticesPath`
  (each a path or `false`). `runCheck` options: `config`, `readingsPath`, `catalogPath`.
- Types: `HeadsUp`, `RunwayEstimate`, `CatalogProgram`, `CatalogProvider`, `ProviderPrograms`. `RouterStatus` gains
  `headsUp`, `headsUpDays` and `programs`; `ProviderStatus` gains `runway`; `CheckReport` gains `programs` and
  `CheckProvider` gains `runway`.

#### Changed

- The privacy promise: without `connect`, the router's one call to Programscape is the catalog read above (it used to
  make none). The README says exactly what it sends, how often, and how to turn it off.
- `check` now reads the config, only for `programscape.catalog` (a config it can't read leaves the catalog off and the
  check runs anyway), keeps the balances it reads in `readings.json`, and may call the catalog. It still writes
  nothing to the ledger.
- `Balance.source` may be `"plan"`. Code that switches exhaustively over it needs the new case.
- `sync` messages say when the plan's date now orders a provider, or that the config date wins.

### Linkup and You.com

Two new providers, each built from its official API docs (read October 12, 2026; linked at the top of each adapter).
Checked live on October 12, 2026 with `programscape-router check`: search, scrape and balance passed for both, and
all seven providers passed (18 of 18 calls).

#### Added

- **Linkup** (`linkup`, key `LINKUP_API_KEY`): search through `POST /v1/search` (`depth: "fast"`,
  `outputType: "searchResults"`; image results are dropped), scrape through `POST /v1/fetch` (standard mode, no
  JavaScript rendering), and a live balance from `GET /v1/credits/balance`, in US dollars with no total or end date.
  Linkup's errors are read by their `error.code`: a 429 with `INSUFFICIENT_FUNDS_CREDITS` or `EXCEED_BUDGET_LIMIT` is
  `exhausted` (Linkup signals spent credits with 429, not 402), any other 429 is `rate_limited`; a 402 (Linkup's x402
  payment challenge, sent only when no key arrived) is `unauthorized`; a 400 `SEARCH_QUERY_NO_RESULT` is an empty
  result list; a 400 with a `FETCH_*` code is `fetch_failed`, so the router tries the next provider; a 504
  `REQUEST_DEADLINE_EXCEEDED` is `timeout`. `check` may show these documented codes.
- **You.com** (`youcom`, key `YDC_API_KEY`): search through `POST https://ydc-index.io/v1/search` (web results, then
  news results not already listed; only news results carry a publication date), scrape through
  `POST https://ydc-index.io/v1/contents` (markdown), and a live balance from
  `GET https://api.you.com/v1/billing/account_balance`, which You.com reports in cents and the router shows in
  dollars (divided by 100, never rounded). 402 is `exhausted`, 429 `rate_limited`, 401 `unauthorized`. A 403
  `Missing required scopes` (the key has no scope for that endpoint) is `provider_error`, not `unauthorized`, so
  You.com stays on for what the key can do. You.com documents no error codes, so `check` shows only its HTTP status.
  Nothing caches You.com's results, as its API Acceptable Use Policy asks.
- `keys set linkup` and `keys set youcom` store the keys in the OS keychain under the accounts `LINKUP_API_KEY` and
  `YDC_API_KEY`. `check`, `status`, the MCP tools and the opt-in balance sync cover both providers. A dollar balance
  with a fraction of a cent isn't synced (Programscape records dollars to the cent, and the router never rounds).

#### Changed

- `PROVIDER_IDS` and the `ProviderId` type now include `linkup` and `youcom` (seven providers, alphabetically). Code
  that switches exhaustively over `ProviderId` needs the two new cases.

## 1.0.0 (October 12, 2026)

The first release meant for npm. 0.1.0 was only ever installed from GitHub.

### Added

- Published to npm as `@programscape/router`, under the Programscape organization. `npx @programscape/router` runs it;
  installed globally, the command is still `programscape-router`. The keychain service, config and state folders and
  the MCP server name keep the `programscape-router` name, so keys saved before 1.0 keep working.
- `programscape-router check [--json] [--verbose]`: one live search (`"startup credits"`, up to 3 results) and one
  scrape (`https://example.com`) per provider with a key set, plus a balance read for Firecrawl and Tavily. Each
  adapter is called directly, with no routing or failover. Per call, the report gives ok or the failure class, the
  provider's HTTP status, its error code when the provider documents it (an allow-list per adapter), a fixed hint
  from our own table, latency, and a result count or markdown length; and per provider, where the key came from.
  The default and `--json` output are safe to share: no key, no result title, URL, snippet or page content, no
  balance amount, and nothing a provider wrote. `--verbose` adds each provider's own error message (every key
  redacted, whatever its length) under a "don't share" warning. It writes nothing to the ledger, never contacts
  Programscape and does not read the config file. Exits 0 only when at least one call was made and every call
  passed. Also available as `runCheck()` and `formatCheck()`.
- Keys in the OS keychain: `programscape-router keys set <provider>` (a hidden prompt; `--stdin` for scripts),
  `keys list` (set or not, and where from; never any part of a key) and `keys remove <provider>`. Keys are stored in
  the macOS Keychain, Windows Credential Manager or the Linux Secret Service under service `programscape-router`,
  account = the key's environment variable. Keys are read once at startup, and an environment variable always wins
  over the keychain. Linux is pinned to the Secret Service (never the kernel keyring, which forgets keys at logout).
  Where there is no keychain, the router still works with environment variables, and `keys` says why. `status` and
  `check` show each key's source (`env`, `keychain` or none). `resolveKeys()` does the same for library users.
- The Programscape sign-in tokens are stored in the OS keychain too (account `programscape-token`). Where the keychain
  module or backend is absent, or a readable keychain refuses to save, they go in a token file, and `connect` says
  which. A loaded but unreadable keychain blocks a new `connect` until it can be checked. A fallback file is
  authoritative while present, including when a keychain read and write both fail during rotation. A later keychain
  write updates the file first and then deletes it after the keychain save, except when the keychain holds a distinct
  older pair that `disconnect` still needs to revoke.
- `connect` requires `disconnect` before another sign-in. A nonsecret connection marker keeps this rule in force
  even during a temporary keychain outage; it also records whether this grant could have used the keychain, so a
  file-only connection can still be disconnected when no keychain backend exists. The marker has one lifecycle
  state: awaiting-consent, connected, sync-off, or cleanup-needed; no marker means disconnected. A pending browser
  sign-in is canceled by `disconnect`, and a second `connect` cannot start while it waits. Connect, disconnect and
  refresh rotations use per-attempt lock entries; the browser wait holds none, and entries from dead processes are
  ignored. A refused refresh turns sync off but retains the old pair for `disconnect` to revoke. A token response
  or rollback that cannot be verified leads `disconnect` to clear local state and warn the founder to check
  connected apps on programscape.com before another sign-in.
- `disconnect` blocks later automatic sync attempts when local state can be saved (an in-flight call may finish),
  revokes every readable token pair, reports remote revocation and both local stores separately, and reads both
  stores back. It exits 1 if local removal cannot be verified, 2 if local state was cleared but remote access is
  unverified, or 0 after verified cleanup. It names the entry to inspect in an inaccessible keychain and directs
  the founder to repair the store and rerun `disconnect`; no internal router file deletion is required.
- Keychain errors never carry the native library's text: each operation prints a fixed message and a problem class
  (`no-secret-service`, `no-default-keychain`, `locked`, `access-denied`, `too-large`, `failed`). Redaction of keys
  and tokens in routing messages and `check --verbose` now covers secrets of any length.
- The keychain service is fixed at `programscape-router`; no environment variable can change it. CI's real keychain
  round trips use a test-only entry script (`scripts/keychain-cli.mjs`, not published).
- The build no longer needs the optional module's type files, so a source or GitHub install with
  `--omit=optional` still builds and runs with environment variables (checked in CI).
- Windows: config in `%APPDATA%\programscape-router`, state (ledger, sync record, and the token file if one is
  needed) in `%LOCALAPPDATA%\programscape-router`; `XDG_CONFIG_HOME` and `XDG_STATE_HOME` still win when set. A
  `chmod` never fails a write on Windows. Browser sign-in opens the URL as one argument with no shell, so `&` in it
  survives. README instructions for PowerShell and cmd, labelled per system.
- CI: typecheck and tests on Ubuntu, macOS and Windows with Node 22 and 24; the pack smoke test with a real keychain
  round trip on macOS and Windows, and a run with no Secret Service on Ubuntu.
- README: Troubleshooting, by failure class.
- README: Keep your keys safe. The OS keychain first, then 1Password's `op run` with secret references, other
  managers' run commands, and a hidden prompt for one terminal window (zsh, PowerShell 7, Windows PowerShell 5.1).
  The Claude Code and MCP client examples hold no keys by default.
- README: exactly what goes to Programscape after `connect` (sign-in, a `my_plan` read, and five-field balance
  reports) and what comes back.
- `CHANGELOG.md`, and a pack-and-import smoke test in CI (`npm run smoke:pack`).

### Changed

- Requires Node 22 or later (`engines.node` is `>=22`). Node 20 reached end of life on April 30, 2026, so 1.0 does
  not promise it. CI runs on Node 22 and 24.
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

### Dependency audit: `@napi-rs/keyring` (optional)

Checked on 2026-10-12 for 2.1.1, added as an `optionalDependency` and loaded lazily (`import()` only when a key isn't
in the environment, or for `keys` and `connect`):

- License MIT, like every platform package. No runtime dependencies, and no install scripts (no `postinstall`), so
  nothing is compiled or downloaded at install time.
- Maintained: published 2026-10-10, regular releases through 2026, about 5 million downloads a week; source at
  github.com/Brooooooklyn/keyring-node (the napi-rs maintainer), wrapping the Rust `keyring` crate.
- Prebuilt binaries, as their own optional packages, for darwin arm64/x64, win32 x64/arm64/ia32, linux x64/arm64 gnu
  and musl, linux arm gnueabihf and riscv64, and freebsd x64. npm installs only the one matching the machine. They
  are 0.5 to 3 MB unpacked; the wrapper is 47 kB.
- `package-lock.json` pins all of them at 2.1.1 with integrity hashes.
- If no prebuilt binary fits, or optional dependencies are skipped (`--omit=optional`), the module fails to load, and
  the router carries on with environment variables.

### Removed from the public API

These were exported by 0.1.0 but are internal. Use the CLI, or `createRouter()`, instead.

- `computeOrder` and `ProviderStanding`: the router computes the order; `router.status()` returns it.
- `configSchema`: use `parseConfig()` to validate a config object.
- `createBalanceSync`, `AUTO_SYNC_INTERVAL_MS`, `BalanceSync`, `BalanceReport`, `ProviderReading`: the router owns the
  balance sync; use `router.syncBalances()` and `router.status().programscape`.
- `connect`, `disconnect`: use `programscape-router connect` and `programscape-router disconnect`.
- `PROGRAMSCAPE_MCP_URL`, `PROGRAMSCAPE_ORIGIN`.

### Public API in 1.0.0

Values: `createRouter`, `RouterError`, `resolveKeys`, `loadConfig`, `parseConfig`, `ConfigError`, `runCheck`, `formatCheck`,
`CHECK_QUERY`, `CHECK_MAX_RESULTS`, `CHECK_URL`, `formatStatus`, `createMcpServer`, `runMcpServer`,
`ProgramscapeError`, `PROVIDER_IDS`, `CAPABILITIES`, `VERSION`.

Types: `Router`, `RouterOptions`, `RouterStatus`, `ProviderStatus`, `RouterErrorCode`, `RouterConfig`,
`CreditEntry`, `ConfigLocation`, `ResolvedKeys`, `KeySource`, `CheckReport`, `CheckProvider`, `CheckCall`, `CheckCapability`, `CheckOptions`,
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
