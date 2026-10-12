# programscape-router

A small, open-source router for your AI agent's web **search** and **scrape** calls. It runs on your own
machine, uses your own API keys, and spends your free credits in an order you can see: by default, the credits
that end first. When one provider's credits run out, it moves to the next.

It works as a local MCP server (for Claude Code, Cursor and other MCP clients), as a command-line tool, and as a
TypeScript library.

Looking for credits to put in it? [Programscape](https://programscape.com) is a source-backed catalog of startup
credits, including programs from these providers.

## Your keys stay on your machine

- Keys are read from your environment, or from your operating system's keychain if you stored them there with
  `keys set`. A provider is switched on only when its key is set.
- Each key is sent only to its own provider's API, and nowhere else. Redirects are never followed, so a key can't
  be carried to another host.
- Keys are never logged, never printed (`keys list`, `status` and `check` say only where a key came from), and never
  written to a file by the router. The OS keychain holds a key you store with `keys set`.
- The router's own files (an optional config and a counts-only ledger) stay in your user folders. If you connect to
  Programscape, its sign-in tokens go in your OS keychain too; only without a keychain do they go in a file (mode
  600 on macOS and Linux; on Windows, protected only by your profile folder's default permissions).
- The router has no telemetry. It makes no call to Programscape unless you run `connect`. After that, it signs in,
  reads which programs you kept on your plan, and sends balance numbers; never your keys, queries, URLs, page
  content or call counts (see [What goes to Programscape](#what-goes-to-programscape-and-what-comes-back)).
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

## Keep your keys safe

Your provider keys work like passwords: anyone holding one can spend that account's credits. Store them somewhere
safe, and let the router read them only when it starts. The router itself never writes a key to a file.

### In your computer's keychain (recommended)

The router can keep each key in your operating system's own password store: the macOS Keychain, Windows Credential
Manager, or the Secret Service (GNOME Keyring or KWallet) on Linux. It works the same on every system:

```bash
npx programscape-router keys set tavily      # paste the key at the prompt; nothing is shown as you paste
npx programscape-router keys set firecrawl
npx programscape-router keys list            # which keys are set and where from; never the keys themselves
```

Providers are `exa`, `firecrawl`, `keenable`, `parallel` and `tavily`. That's all: the router finds the keys
itself, so your agent's config holds none (see [Add it to your agent](#add-it-to-your-agent)).
`keys remove tavily` deletes one. Keys are stored under service `programscape-router`, with the variable name
(such as `TAVILY_API_KEY`) as the account, so you can also find them in Keychain Access, Credential Manager (as
`TAVILY_API_KEY.programscape-router`) or Seahorse. To store a key from a script, pipe it in: `... | npx programscape-router keys set
tavily --stdin`.

- An environment variable always wins over the keychain, so `op run` (below) and CI keep working.
- On macOS, after you update Node, the Keychain may ask whether `node` may read the router's keys. Choose
  **Always Allow**.
- A Linux machine with no desktop session (a server, a container, WSL without a keyring) usually has no Secret
  Service. `keys set` then says so; use 1Password or another manager below instead.

### With 1Password

1. Install the 1Password CLI and turn on its integration with the 1Password app:
   [Get started with 1Password CLI](https://developer.1password.com/docs/cli/get-started/).
2. Create a `keys.env` file in the router's config folder: `~/.config/programscape-router/keys.env` on macOS and
   Linux, `%APPDATA%\programscape-router\keys.env` on Windows. It holds *secret references*, not keys: each line
   says where in 1Password a key lives. In the 1Password app, open the item, click the field's menu and choose
   **Copy Secret Reference**.

   ```bash
   EXA_API_KEY=op://Private/Exa/credential
   FIRECRAWL_API_KEY=op://Private/Firecrawl/credential
   KEENABLE_API_KEY=op://Private/Keenable/credential
   TAVILY_API_KEY=op://Private/Tavily/credential
   ```

   Use your own vault, item and field names. Leave out any provider you don't have.
3. Run the router through `op run`. 1Password asks you to approve, then hands the keys to that one process only.

   macOS and Linux:

   ```bash
   op run --env-file="$HOME/.config/programscape-router/keys.env" -- npx programscape-router check
   ```

   Windows (PowerShell):

   ```powershell
   op run --env-file="$env:APPDATA\programscape-router\keys.env" -- npx programscape-router check
   ```

To add it to your agent this way, see [Add it to your agent](#add-it-to-your-agent).

### With another password manager

Most managers have a command that works like `op run`: it starts a program with your keys in its environment and
nowhere else. For example `bws run -- npx programscape-router check` (Bitwarden Secrets Manager),
`doppler run -- npx programscape-router check` (Doppler) or `infisical run -- npx programscape-router check`
(Infisical). Name each secret after its variable, such as `TAVILY_API_KEY`.

### Just for one terminal window

Copy a key from your password manager and paste it at a hidden prompt. It stays out of your shell history and
disappears when you close the window.

macOS and Linux (zsh, the macOS default):

```bash
read -rs "TAVILY_API_KEY?Paste your Tavily key, then press Return: " && export TAVILY_API_KEY
```

Windows, PowerShell 7:

```powershell
$env:TAVILY_API_KEY = Read-Host "Paste your Tavily key" -MaskInput
```

Windows PowerShell 5.1 (the one built into Windows):

```powershell
$key = Read-Host "Paste your Tavily key" -AsSecureString
$env:TAVILY_API_KEY = [System.Net.NetworkCredential]::new("", $key).Password
```

Repeat for each key, then run the router in the same window.

### What to avoid

- Pasting a key into a chat, an issue, or a file you commit.
- Adding `export ..._API_KEY=...` to `~/.zshrc` or another shell profile, or setting it as a permanent Windows
  environment variable, which keeps the key in plain text.
- Passing keys with `claude mcp add -e`, or in the `env` block of an MCP client's JSON config. That works, but the
  client saves the key in plain text in its config file in your home folder. Prefer the keychain or `op run`.

## Install

You need Node 22 or later. On Windows: `winget install OpenJS.NodeJS.LTS`. On macOS and Linux: the LTS installer
from [nodejs.org](https://nodejs.org), or your package manager.

Once the router is on npm, there is nothing else to install: `npx programscape-router` runs the latest version.
Until then, run it from GitHub: use `npx github:Deirfgeiz/programscape-router` wherever this page says
`npx programscape-router`. It builds itself on install.

The keychain support comes as a small prebuilt native module (`@napi-rs/keyring`) for macOS, Windows and Linux, so
no compiler is needed. It is an optional dependency: if it can't be installed on your system, or you install with
`--omit=optional`, the router (including the GitHub install, which builds itself) still installs and works with
environment variables, and `keys` says the keychain isn't available.

## Quick check

Store your keys (see [Keep your keys safe](#keep-your-keys-safe)), then check that each one works. With 1Password,
put `op run --env-file=... --` in front of each command.

```bash
npx programscape-router keys set tavily   # once per provider: store the key in your OS keychain
npx programscape-router check             # one live search, scrape and balance read per key, each provider on its own
npx programscape-router status            # enabled providers, the order and why, balances
npx programscape-router search "seed round SAFE templates"
npx programscape-router scrape https://example.com
```

`check` makes one small search (`"startup credits"`, up to 3 results) and one scrape (`https://example.com`) with
each key that is set, and reads the balance from Firecrawl and Tavily. It calls each provider directly, with no
routing or failover, so every key is tested on its own. It prints, per call, ok or the failure class (see
[Troubleshooting](#troubleshooting)), the provider's HTTP status and documented error code if it gave one, what to do
next, the latency, and how many results or characters came back:

```text
exa (EXA_API_KEY, from the OS keychain)
  search   ok                      640 ms  3 results
  scrape   ok                      910 ms  markdown, 1256 chars
  balance  -                               no public balance endpoint (add your credits in config)

firecrawl (FIRECRAWL_API_KEY, from the environment)
  search   FAIL unauthorized       120 ms  HTTP 401 - The key was refused. Copy it again from the provider's dashboard and store it again.
  scrape   FAIL unauthorized        95 ms  HTTP 401 - The key was refused. Copy it again from the provider's dashboard and store it again.
  balance  FAIL unauthorized        88 ms  HTTP 401 - The key was refused. Copy it again from the provider's dashboard and store it again.

keenable: skipped (no key: set KEENABLE_API_KEY or run `programscape-router keys set keenable`)

parallel (PARALLEL_API_KEY, from the OS keychain)
  search   ok                     1610 ms  3 results
  scrape   FAIL exhausted         2970 ms  HTTP 402 - Credits or quota spent. Check the provider's dashboard.
  balance  -                               no public balance endpoint (add your credits in config)

tavily: skipped (no key: set TAVILY_API_KEY or run `programscape-router keys set tavily`)

FAIL: 3 of 7 calls passed, 4 failed; 2 providers skipped (no key).
```

`check --json` prints the same report as JSON. Both are safe to share: they hold where each key came from (never a
key), outcome classes, HTTP statuses, error codes the provider documents (such as Exa `FEATURE_DISABLED` or Firecrawl
`insufficient_credits`), our own hints, latencies, and counts and lengths. They never hold a key, a result title,
URL or snippet, page content, a balance amount, or anything else a provider wrote, since an error message can echo
account details back. The only URL in them is the fixed test page, `https://example.com`.

`check --verbose` adds each provider's own error message, with your keys replaced by `[redacted]`. It may still
contain account details (an amount, an email, a URL), so the report starts and ends with a warning: read it
yourself, but don't share it.

`check` writes nothing to the ledger, sends nothing to Programscape, and doesn't read your config file. It exits 0
when every call it made passed, and 1 otherwise (or when no key is set). A check costs each provider one search, one
scrape and, where there is one, one balance read.

`status --json` prints the status as JSON. `status --refresh` re-reads balances.

## Add it to your agent

With your keys in the OS keychain, the agent's config holds no key at all: the router reads them when it starts.

### Claude Code

macOS, Linux and Windows:

```bash
claude mcp add programscape-router -s user -- npx -y programscape-router
```

`-s user` makes it available in every project. On native Windows, Claude Code 2.1.119 and later start `npx`
directly. With an older version, wrap it in `cmd /c`:

```powershell
claude mcp add programscape-router -s user -- cmd /c npx -y programscape-router
```

With 1Password instead of the keychain, run the router through `op run`. Use the full path to your `keys.env`;
1Password asks you to approve when Claude Code starts the router.

macOS (`~` isn't expanded here):

```bash
claude mcp add programscape-router -s user -- op run --env-file=/Users/YOU/.config/programscape-router/keys.env -- npx -y programscape-router
```

Linux (`~` isn't expanded here):

```bash
claude mcp add programscape-router -s user -- op run --env-file=/home/YOU/.config/programscape-router/keys.env -- npx -y programscape-router
```

Windows:

```powershell
claude mcp add programscape-router -s user -- op run --env-file=C:\Users\YOU\AppData\Roaming\programscape-router\keys.env -- npx -y programscape-router
```

Without the keychain or a password manager (not recommended: Claude Code saves the keys in plain text in its
config), pass each key with `-e`:

```bash
claude mcp add programscape-router -s user -e TAVILY_API_KEY=tvly-... -e FIRECRAWL_API_KEY=fc-... -- npx -y programscape-router
```

### Cursor, Claude Desktop and other MCP clients

Add a stdio server to the client's MCP config (for Cursor, `~/.cursor/mcp.json`; on Windows,
`%USERPROFILE%\.cursor\mcp.json`). With your keys in the keychain, it holds no keys:

```json
{
  "mcpServers": {
    "programscape-router": {
      "command": "npx",
      "args": ["-y", "programscape-router"]
    }
  }
}
```

On Windows, if the client says it can't start `npx`, start it through `cmd`:

```json
{
  "mcpServers": {
    "programscape-router": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "programscape-router"]
    }
  }
}
```

With 1Password, run it through `op run`. Use the path for your OS:

macOS:

```json
{
  "mcpServers": {
    "programscape-router": {
      "command": "op",
      "args": ["run", "--env-file=/Users/YOU/.config/programscape-router/keys.env", "--", "npx", "-y", "programscape-router"]
    }
  }
}
```

Linux:

```json
{
  "mcpServers": {
    "programscape-router": {
      "command": "op",
      "args": ["run", "--env-file=/home/YOU/.config/programscape-router/keys.env", "--", "npx", "-y", "programscape-router"]
    }
  }
}
```

Windows (JSON requires each path backslash to be doubled):

```json
{
  "mcpServers": {
    "programscape-router": {
      "command": "op",
      "args": ["run", "--env-file=C:\\Users\\YOU\\AppData\\Roaming\\programscape-router\\keys.env", "--", "npx", "-y", "programscape-router"]
    }
  }
}
```

Without the keychain or a password manager (not recommended: the client saves the keys in plain text), add an
`"env"` block with your keys to the first example.

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
3. `config.json` in the router's config folder: `~/.config/programscape-router/` on macOS and Linux,
   `%APPDATA%\programscape-router\` on Windows, or `$XDG_CONFIG_HOME/programscape-router/` when that is set.
   `status` prints the one it found.

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

### What goes to Programscape, and what comes back

Only after `connect`, and only to `https://programscape.com`. There are three kinds of call.

**Signing in** (`connect`, an occasional token refresh, and `disconnect`). Standard OAuth with PKCE:

- `connect` reads Programscape's public sign-in metadata, registers the router as a public client (its name
  `programscape-router`, its version, and the `http://127.0.0.1:<port>/callback` address to return to; no secret),
  and opens your browser at the sign-in page. You sign in there, on programscape.com; the router never sees your
  email or password. Programscape sends the browser back to `127.0.0.1` with a one-time code, which the router
  exchanges (with its PKCE verifier) for an access token and a refresh token.
- When the access token expires, the router sends the refresh token to get a new pair.
- `disconnect` sends both tokens to Programscape's revocation endpoint, then deletes them locally and checks that
  they're gone.

What comes back is the tokens. They are stored in your OS keychain (or, where there is none, in a token file; see
[Connect and disconnect](#connect-and-disconnect)), sent only to `https://programscape.com`, and never printed or
logged. Redirects are never followed, as with provider calls.

**Reading your plan** (each `sync`). The router opens an MCP session (which tells Programscape the client's name,
`programscape-router`, and its version) and calls `my_plan` with no arguments. Programscape answers with your plan:
the router uses only the programs you kept, with their ids, providers and whether each shows as approved, to decide
which program a provider's balance belongs to. It keeps nothing from the answer but the program id it chose, in the
local sync record.

**Each balance report.** For each provider whose balance the router reads live from the provider's own endpoint
(Firecrawl's remaining credits, Tavily's plan credits), and only for a program you kept on your plan that shows as
approved, it calls `report_balance` with exactly these five fields:

```json
{ "programId": "firecrawl.startup-deal", "amount": 1000, "unit": "credits", "asOf": "2026-10-11T12:00:00.000Z", "source": "router" }
```

The amount goes in the unit the provider reported (`usd`, `credits` or `requests`); it is never converted, rounded or
added to another balance. `asOf` is when the router read it from the provider. Programscape answers whether it took
the reading: if your plan already holds a later one, it keeps that, and `sync` says nothing changed. When it refuses
a balance (the program isn't kept or approved, or your low-balance reminder is in another unit), `sync` shows its
reason, and nothing on your plan changes.

### What is never sent

- Your queries, the URLs you scrape, or any page content.
- Your provider keys. They still go only to their own provider.
- Credits you entered in config (Exa, Keenable, Parallel, or anything under `providers.<id>.credits`). Those are
  your own numbers, not a provider's reading; your plan has whatever you entered on programscape.com.
- Call counts from the local ledger, your config file, or anything else.

### Connect and disconnect

```bash
npx programscape-router connect      # opens your browser to sign in to Programscape and allow the router
npx programscape-router sync         # send live balances to your plan now
npx programscape-router status       # ends with "Programscape sync: off" or "on (last synced ...)"
npx programscape-router disconnect   # revokes the router's access and deletes the tokens
```

`connect` prints the sign-in link too, so it works on a machine without a browser (`--no-browser` skips opening
one). It listens on `127.0.0.1` only for the redirect, so no firewall asks to open a port.

To connect again, run `programscape-router disconnect` first, including when an old sign-in has expired. A second
`connect` stops before contacting Programscape while a token or connection record remains, even if the keychain
temporarily cannot be reached. The record contains no token or personal data. It has one lifecycle state:
`awaiting-consent` (the browser sign-in is pending), `connected`, `sync-off` (the sign-in was refused), or
`cleanup-needed` (a change was interrupted or its remote result is uncertain); it also records whether the keychain
may hold a grant. No record means `disconnected`. Connect, disconnect and token refreshes use local lock entries
around connection changes. The lock is released while `connect` waits for the browser, but the pending attempt
stays recorded. Running `disconnect` then cancels that attempt. Ctrl+C and other termination signals remove a held
entry where possible; a later command ignores an entry whose process has died. An incomplete entry without an
owner expires after two minutes.

The tokens go in your OS keychain, beside your provider keys (service `programscape-router`, account
`programscape-token`), and `connect` says so. If the optional keychain module is missing, no keychain backend exists,
or the keychain can be checked but refuses to save the entry (for example, an entry too large for Windows Credential
Manager), the router writes a token file instead. If a loaded keychain cannot be checked, `connect` stops and asks
you to unlock or repair it before trying again; it cannot safely rule out an older grant. `connect` names the store
used:

- macOS and Linux: `~/.config/programscape-router/programscape-token.json` (or under `$XDG_CONFIG_HOME`), mode 600
  in a mode 700 folder, so only your user account can read it.
- Windows: `%LOCALAPPDATA%\programscape-router\programscape-token.json`. Windows has no file modes; the file is
  protected only by your profile folder's default permissions, which let your account, administrators and the
  system read it.

While a fallback file exists, the router reads that copy. It tries to delete the old keychain entry after a fallback
write. When the keychain works again, it updates the fallback file before saving there and then deletes the file,
unless the keychain still holds a different token pair. In that case it keeps both copies so `disconnect` can revoke
both. This keeps a rotated token current even if a keychain read or write fails. If Programscape refuses a refresh, sync
turns off and keeps the old token pair locally so `disconnect` can attempt to revoke it before another sign-in.

If Programscape stops accepting the tokens (for example after 30 days without use, or if you remove the router's
access on programscape.com), sync turns itself off. Run `disconnect`, then `connect` to sign in again.

`disconnect` blocks later automatic balance sync attempts when it can save local state; a call already in progress may
finish. It asks Programscape to revoke every readable token pair in the keychain and file, deletes the local copies,
then reads both stores back. It prints what happened in each place:

```text
Disconnect from Programscape:
  Programscape: revoked the known router tokens
  OS keychain: deleted
  token file: none there
Disconnected: local tokens removed and known Programscape tokens revoked.
```

It exits 0 when the known tokens were revoked and every store this connection could have used is verified empty. A
file-only connection made without a keychain backend can disconnect successfully without one: its nonsecret record
shows that it never attempted a keychain write. If local removal cannot be verified, `disconnect` exits 1; unlock
or repair the reported store and rerun `disconnect`. If local tokens are gone but remote revocation cannot be
verified, it clears the local connection, exits 2, and asks you to check
**Apps connected to your plan** on programscape.com → My plans for `programscape-router`. You may then connect again. A token response
lost during sign-in or refresh can leave an unknown remote grant; `disconnect` also clears local state and gives
the same warning. Disconnecting the router there is the way to revoke an unknown grant.

If a local token cannot be removed, `disconnect` names the store and its entry so you can inspect it:

- macOS: in Keychain Access, delete the item `programscape-router` with account `programscape-token`, or run
  `security delete-generic-password -s programscape-router -a programscape-token`.
- Windows: in Credential Manager (Windows Credentials, Generic Credentials), remove
  `programscape-token.programscape-router`, or run `cmdkey /delete:programscape-token.programscape-router`.
- Linux: in Seahorse or KWallet Manager, delete the item for service `programscape-router`, username
  `programscape-token`, or run `secret-tool clear service programscape-router username programscape-token`.
- If Programscape didn't confirm the revocation, also remove the router's access on programscape.com.

If a token entry is corrupted, `disconnect` may remove it locally but cannot revoke a grant it cannot read. It
reports the remote result as unverified and points you to **Apps connected to your plan** on My plans. You do not need to edit router files.

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

`~/.local/state/programscape-router/ledger.json` on macOS and Linux, `%LOCALAPPDATA%\programscape-router\ledger.json`
on Windows (or `$XDG_STATE_HOME/programscape-router/ledger.json` when that is set) counts
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
| `unauthorized` | 401 or 403 (Keenable also uses 400 for a malformed key): the key is wrong, disabled or revoked. | Copy the key again from the provider's dashboard and store it again (`keys set <provider>`, or the variable `check` names), then restart your MCP client so it picks it up. |
| `bad_request` | 400 or 422: the provider rejected the request itself. | Run `check --verbose` and read the message (don't share it). If it says a field is wrong, the provider's API has probably changed: please open an issue with the `check --json` output. |
| `server_error` | 5xx: the provider is having trouble. | Try again later. |
| `timeout` | No answer within the timeout (30 s for search, 60 s for scrape, 10 s for a balance read; `timeoutMs` in config). | Try again; if it keeps happening, raise `timeoutMs`. |
| `network_error` | The provider couldn't be reached at all. | Check your connection, proxy or firewall. |
| `fetch_failed` | The provider answered, but couldn't fetch that page. | Try another page; the router tries the next provider for that call. |
| `rejected` | The provider refused that content on policy grounds (Exa `PROHIBITED_CONTENT`). | Nothing is wrong with the key; the router tries the next provider. |
| `invalid_response` | A 2xx answer in a shape the adapter couldn't read. | The provider's API has probably changed: please open an issue with the `check --json` output. |
| `provider_error` | Any other answer, including a redirect (never followed, so your key stays with the provider) or a feature not on your plan (Exa `FEATURE_DISABLED`). | Run `check --verbose` and read the provider's message (don't share it). |

If `keys set` says no keychain is available, the router can't reach your system's password store (most often a
Linux machine without a desktop session). Keys in environment variables still work: use 1Password, another
password manager's run command, or the one-window prompt in [Keep your keys safe](#keep-your-keys-safe).

`check` and `check --json` output is safe to paste into an issue: it holds no key, nothing a provider wrote, and no
result or page content (see [Quick check](#quick-check)). Don't paste `check --verbose` output.

## What it never does

- No telemetry, and no call to Programscape unless you run `connect`; then only sign-in, a read of your plan, and
  balance numbers.
- No quality ranking, and no LLM deciding anything. The order is a rule you can read.
- No combined credit total. Each balance is shown on its own, in its own unit.
- It doesn't create accounts, keep your keys anywhere but your environment or your OS keychain, or proxy through a
  server.

## As a library

```ts
import { createRouter } from "programscape-router";

const router = createRouter(); // reads keys from process.env and the config file
const { results, routing } = await router.search({ query: "seed SAFE templates", maxResults: 5 });
const { result } = await router.scrape({ url: "https://example.com" });
const status = await router.status();
const synced = await router.syncBalances(); // after `programscape-router connect`: reads your plan, sends balance numbers
```

`createRouter()` reads keys from the environment only. To use keys stored with `keys set` too, resolve them first:
`createRouter({ keys: await resolveKeys() })`. `createRouter` also takes `env`, `config`, `cwd`, `fetch`,
`ledgerPath` (or `false`), `log` and `now`, mostly for testing. `runCheck()` and `formatCheck()` are the `check` command as functions. Everything the package exports is
listed in [CHANGELOG.md](CHANGELOG.md); anything else is internal.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
npm run smoke:pack   # packs the tarball, installs it in a temp project, imports it and type-checks it
```

CI runs the first four on Ubuntu, macOS and Windows with Node 22 and 24. The pack smoke test runs on Ubuntu (with
no keychain, where the router must still work with environment variables) and on macOS and Windows, where it also
stores, reads and removes a key in the real OS keychain under a test service name.

## License

MIT. Copyright (c) 2026 Forgotten Things Labs LLC.
