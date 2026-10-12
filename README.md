# programscape-router

A small, open-source router for your AI agent's web **search** and **scrape** calls. It runs on your own
machine, uses your own API keys, and spends your free credits in an order you can see: by default, the credits
that end first. When one provider's credits run out, it moves to the next.

It works as a local MCP server (for Claude Code, Cursor and other MCP clients), as a command-line tool, and as a
TypeScript library.

Looking for credits to put in it? [Programscape](https://programscape.com) is a source-backed catalog of startup
credits, including programs from these providers.

## Your keys stay on your machine

- Keys are read only from your environment. A provider is switched on only when its key is set.
- Each key is sent only to its own provider's API, and nowhere else. Redirects are never followed, so a key can't
  be carried to another host.
- Keys are never logged and never written to disk by the router.
- The router has no telemetry. It makes no call to Programscape unless you run `connect`, and then it sends only
  balance numbers (see [Sync balances to your Programscape plan](#sync-balances-to-your-programscape-plan-optional)).
- Your queries, URLs and page content are never logged or saved. The local ledger keeps counts only.

## Providers

Listed alphabetically. Every adapter is built from the provider's official API documentation, linked at the top of
its source file.

| Provider | Key | Search | Scrape | Balance read live |
|---|---|---|---|---|
| Exa | `EXA_API_KEY` | `/search` | `/contents` | No public endpoint; add your credits in config |
| Firecrawl | `FIRECRAWL_API_KEY` | `/v2/search` | `/v2/scrape` | Yes: `/v2/team/credit-usage`, including when the billing period ends |
| Keenable | `KEENABLE_API_KEY` | `/v1/search` | `/v1/fetch` | No public endpoint; add your credits in config |
| Parallel | `PARALLEL_API_KEY` | `/v1/search` | `/v1/extract` | No public endpoint; add your credits in config |
| Tavily | `TAVILY_API_KEY` | `/search` | `/extract` | Yes: `/usage` (no end date published) |

## Install

Once it is on npm, nothing to install: `npx programscape-router` runs the latest version.

Until then, run it from GitHub: use `npx github:Deirfgeiz/programscape-router` wherever this page says
`npx programscape-router`. It builds itself on install. Node 20 or later.

## Quick check

Set the keys you have, then check that each one works:

```bash
export TAVILY_API_KEY=tvly-...
export FIRECRAWL_API_KEY=fc-...

npx programscape-router check             # one live search, scrape and balance read per key, each provider on its own
npx programscape-router status            # enabled providers, the order and why, balances
npx programscape-router search "seed round SAFE templates"
npx programscape-router scrape https://example.com
```

`check` makes one small search (`"startup credits"`, up to 3 results) and one scrape (`https://example.com`) with
each key that is set, and reads the balance from Firecrawl and Tavily. It calls each provider directly, with no
routing or failover, so every key is tested on its own. It prints, per call, ok or the failure class (see
[Troubleshooting](#troubleshooting)), the latency, and how many results or characters came back:

```text
exa (EXA_API_KEY)
  search   ok                      640 ms  3 results
  scrape   ok                      910 ms  markdown, 1256 chars
  balance  -                               no public balance endpoint (add your credits in config)

firecrawl (FIRECRAWL_API_KEY)
  search   FAIL unauthorized       120 ms  HTTP 401: Unauthorized: Invalid token
  scrape   FAIL unauthorized        95 ms  HTTP 401: Unauthorized: Invalid token
  balance  FAIL unauthorized        88 ms  HTTP 401: Unauthorized: Invalid token

keenable: skipped (KEENABLE_API_KEY is not set)

parallel: skipped (PARALLEL_API_KEY is not set)

tavily: skipped (TAVILY_API_KEY is not set)

FAIL: 2 of 5 calls passed, 3 failed; 3 providers skipped (no key).
```

It never prints result titles, URLs, snippets, page content or balance amounts, and a provider's error message is
shown with every key replaced by `[redacted]`. It writes nothing to the ledger, sends nothing to Programscape, and
doesn't read your config file. `check --json` prints the same report as JSON. It exits 0 when every call it made
passed, and 1 otherwise (or when no key is set). A check costs each provider one search, one scrape and, where there
is one, one balance read.

`status --json` prints the status as JSON. `status --refresh` re-reads balances.

## Add it to your agent

### Claude Code

```bash
claude mcp add programscape-router \
  -e TAVILY_API_KEY=tvly-... \
  -e FIRECRAWL_API_KEY=fc-... \
  -- npx -y programscape-router
```

Add one `-e` per key you have, and `-s user` to use it in every project. Claude Code keeps these values in its own
local config on your machine.

### Cursor, Claude Desktop and other MCP clients

Add a stdio server to the client's MCP config (for Cursor, `~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "programscape-router": {
      "command": "npx",
      "args": ["-y", "programscape-router"],
      "env": {
        "TAVILY_API_KEY": "tvly-...",
        "FIRECRAWL_API_KEY": "fc-..."
      }
    }
  }
}
```

The server offers three tools:

- **`search`**: `{ query, maxResults? }` returns `results` (`title`, `url`, `snippet?`, `publishedAt?`) and `routing`.
- **`scrape`**: `{ url }` returns `result` (`url`, `title?`, `markdown`) and `routing`.
- **`credits_status`**: the enabled providers, the order for each capability with the reason for each position,
  every balance with its unit and when it was read, and any provider marked spent or switched off.

Every result says which provider served it and why:

```json
"routing": {
  "provider": "tavily",
  "reason": "Credits with no known end date: \"Tavily plan credits (Researcher)\" (97% remaining).",
  "rule": "credits-ending-first",
  "tried": [
    { "provider": "firecrawl", "outcome": "exhausted", "status": 402, "message": "Payment required to access this resource." },
    { "provider": "tavily", "outcome": "ok" }
  ]
}
```

## The order

### Default: credits ending first

1. Providers whose credits have an end date come first, the soonest first. A monthly allowance ends when its
   billing period ends (Firecrawl reports this). Credits you enter in config can carry `expiresOn`.
2. Then providers whose credits have no known end date. A provider you've told the router nothing about goes here.
3. Pay-as-you-go comes last: a provider whose known credits are all spent or ended, or one you mark `"paid": true` with no credits left that the router knows of. Credits you still hold are always spent before paid usage.

End dates are compared to the exact time, so credits ending at 09:00 go before credits ending at 23:59 the same
day; a date without a time lasts through the end of that day, UTC. Ties go to the larger share remaining (remaining
divided by the plan or award, only where both are known; a known share goes before an unknown one), then to the
provider id, alphabetically. Amounts in different units are never compared, and never added up. A provider that reported its credits spent is skipped.

The order is a fixed rule over your own credits and dates. It does not rank providers on quality, and no provider
can pay to move up.

### Your own order

Set an order per capability in config. Only the providers you list are used, in that order:

```json
{ "order": { "search": ["tavily", "exa"], "scrape": ["firecrawl"] } }
```

## Config

Config is optional. The router looks in this order:

1. the path in `$PROGRAMSCAPE_ROUTER_CONFIG`
2. `./programscape-router.json`
3. `~/.config/programscape-router/config.json` (or `$XDG_CONFIG_HOME/programscape-router/config.json`)

```json
{
  "order": { "search": ["tavily", "exa"], "scrape": ["firecrawl"] },
  "providers": {
    "exa": {
      "credits": [
        { "label": "Exa startup grant", "expiresOn": "2027-03-01", "remaining": 600, "award": 1000, "unit": "usd" }
      ]
    },
    "parallel": { "paid": false }
  },
  "timeoutMs": 30000
}
```

| Field | Meaning |
|---|---|
| `order.search`, `order.scrape` | Your order. Leave it out to use credits ending first. |
| `providers.<id>.credits[]` | Credits you hold. `label`, `expiresOn` (YYYY-MM-DD, usable through that day, UTC), `remaining`, `award`, `unit`. All optional; what you leave out stays unknown. |
| `providers.<id>.paid: true` | You pay as you go with this provider; once its known credits are spent, it goes last. |
| `providers.<id>.paid: false` | You don't pay with this provider; once its known credits are spent, it is skipped. |
| `timeoutMs` | Per-call timeout (default 30 s for search, 60 s for scrape). |
| `programscape.sync` | `"manual"` (the default: only when you run `programscape-router sync`) or `"auto"`. Does nothing until you run `connect`. |
| `providers.<id>.programscapeProgram` | The program on your Programscape plan that this provider's live balance belongs to, when your plan has several from that provider (or the router can't tell). |

Keys never go in the config file. The router rejects unknown fields with a message that says which one.

## Sync balances to your Programscape plan (optional)

If you keep a plan on [Programscape](https://programscape.com), the router can keep the balances on it current with
what your providers report. It is off until you turn it on.

### What is sent

For each provider whose balance the router reads live from the provider's own endpoint (Firecrawl's remaining
credits, Tavily's plan credits), and only for a program you kept on your plan that shows as approved:

```json
{ "programId": "firecrawl.startup-deal", "amount": 1000, "unit": "credits", "asOf": "2026-10-11T12:00:00.000Z", "source": "router" }
```

That is the whole message. The amount goes in the unit the provider reported (`usd`, `credits` or `requests`); it is
never converted, rounded or added to another balance. `asOf` is when the router read it from the provider. If your
plan already holds a later reading, Programscape keeps that one, and `sync` says nothing changed. When Programscape
refuses a balance (the program isn't kept or approved, or your low-balance reminder is in another unit), `sync`
shows its reason, and nothing on your plan changes.

### What is never sent

- Your queries, the URLs you scrape, or any page content.
- Your provider keys. They still go only to their own provider.
- Credits you entered in config (Exa, Keenable, Parallel, or anything under `providers.<id>.credits`). Those are
  your own numbers, not a provider's reading; your plan has whatever you entered on programscape.com.
- Call counts from the local ledger, or anything else.

The Programscape token is sent only to `https://programscape.com`, redirects are never followed (as with provider
calls), and it is never printed or logged.

### Connect and disconnect

```bash
npx programscape-router connect      # opens your browser to sign in to Programscape and allow the router
npx programscape-router sync         # send live balances to your plan now
npx programscape-router status       # ends with "Programscape sync: off" or "on (last synced ...)"
npx programscape-router disconnect   # revokes the router's access and deletes the token file
```

`connect` prints the sign-in link too, so it works on a machine without a browser (`--no-browser` skips opening
one). It listens on `127.0.0.1` for the redirect, and stores the token at
`~/.config/programscape-router/programscape-token.json` (or under `$XDG_CONFIG_HOME`), readable only by you. If
Programscape stops accepting it (for example after 30 days without use, or if you remove the router's access on
programscape.com), sync turns itself off and says to run `connect` again.

### Which program a balance goes to

A provider's balance goes to the one program from that provider you kept on your plan that shows as approved. If there
are several (Firecrawl has two offers, for example) or none, the router doesn't guess: `sync` and `status` say so, and
you choose in config:

```json
{ "providers": { "firecrawl": { "programscapeProgram": "firecrawl.claude-startup-perks" } } }
```

Programscape refuses a balance for a program that isn't kept and approved on your plan.

### Manual or automatic

Manual is the default: balances go only when you run `programscape-router sync`. With
`{ "programscape": { "sync": "auto" } }` in config, the router also sends a provider's balance after it reads it, at
most once per provider every six hours. An automatic sync runs in the background with a timeout: it never holds up a
search or scrape, and if it fails it says so once on stderr and your calls carry on.

## When a provider fails

| What the provider says | What the router does |
|---|---|
| 402, or its documented "out of credits" error (Tavily 432/433, Firecrawl `insufficient_credits`, Exa `NO_MORE_CREDITS`) | Marks it spent until its billing period ends (if known) or for the rest of the session, and tries the next |
| 429 rate limit, 5xx, timeout, network error, a feature not on your plan (Exa `FEATURE_DISABLED`) | Tries the next provider for this call; doesn't mark it spent |
| Couldn't fetch that page, or refused that content | Tries the next provider for this call |
| 401 or 403 (bad, disabled or revoked key) | Switches the provider off for the session, says so on stderr, and tries the next |
| 400 or 422 (the request itself was wrong) | Returns the error to you without trying anyone else |

## The local ledger

`~/.local/state/programscape-router/ledger.json` (or `$XDG_STATE_HOME/programscape-router/ledger.json`) counts
calls per UTC day, provider and capability, and how each ended. It stores nothing else: no queries, URLs, content,
keys or balances.

```json
{ "days": { "2026-10-11": { "tavily": { "search": { "ok": 12, "rate_limited": 1 } } } } }
```

## Troubleshooting

`check`, the `tried` list in every `routing`, and the errors from `search` and `scrape` name what happened with one
of these classes:

| Class | What it means | What to do |
|---|---|---|
| `exhausted` | The provider says your credits or quota are spent (402, Tavily 432/433, Firecrawl `insufficient_credits`, Exa `NO_MORE_CREDITS` or a budget tag). | Check the provider's dashboard. A monthly allowance comes back when its billing period ends; credits from a program don't. |
| `rate_limited` | 429: too many calls, too fast. | Wait and try again. The router moves to the next provider meanwhile. |
| `unauthorized` | 401 or 403 (Keenable also uses 400 for a malformed key): the key is wrong, disabled or revoked. | Copy the key again from the provider's dashboard into the variable `check` names, and restart your MCP client so it picks it up. |
| `bad_request` | 400 or 422: the provider rejected the request itself. | Read the message. If it says a field is wrong, the provider's API has probably changed: please open an issue with the `check --json` output. |
| `server_error` | 5xx: the provider is having trouble. | Try again later. |
| `timeout` | No answer within the timeout (30 s for search, 60 s for scrape, 10 s for a balance read; `timeoutMs` in config). | Try again; if it keeps happening, raise `timeoutMs`. |
| `network_error` | The provider couldn't be reached at all. | Check your connection, proxy or firewall. |
| `fetch_failed` | The provider answered, but couldn't fetch that page. | Try another page; the router tries the next provider for that call. |
| `rejected` | The provider refused that content on policy grounds (Exa `PROHIBITED_CONTENT`). | Nothing is wrong with the key; the router tries the next provider. |
| `invalid_response` | A 2xx answer in a shape the adapter couldn't read. | The provider's API has probably changed: please open an issue with the `check --json` output. |
| `provider_error` | Any other answer, including a redirect (never followed, so your key stays with the provider) or a feature not on your plan (Exa `FEATURE_DISABLED`). | Read the message. |

`check --json` output is safe to paste into an issue: it holds outcomes, statuses, latencies and counts, and the
provider's error messages with your keys redacted.

## What it never does

- No telemetry, and no call to Programscape unless you run `connect`, and then only balance numbers.
- No quality ranking, and no LLM deciding anything. The order is a rule you can read.
- No combined credit total. Each balance is shown on its own, in its own unit.
- It doesn't create accounts, hold your keys anywhere but your environment, or proxy through a server.

## As a library

```ts
import { createRouter } from "programscape-router";

const router = createRouter(); // reads keys from process.env and the config file
const { results, routing } = await router.search({ query: "seed SAFE templates", maxResults: 5 });
const { result } = await router.scrape({ url: "https://example.com" });
const status = await router.status();
const synced = await router.syncBalances(); // after `programscape-router connect`; only balance numbers are sent
```

`createRouter` also takes `env`, `config`, `cwd`, `fetch`, `ledgerPath` (or `false`), `log` and `now`, mostly for
testing. `runCheck()` and `formatCheck()` are the `check` command as functions. Everything the package exports is
listed in [CHANGELOG.md](CHANGELOG.md); anything else is internal.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
npm run smoke:pack   # packs the tarball, installs it in a temp project, imports it and type-checks it
```

CI runs the first four on Node 20, 22 and 24, and the pack smoke test on Node 20 and 24.

## License

MIT. Copyright (c) 2026 Forgotten Things Labs LLC.
