#!/usr/bin/env node
// Pack the package, install the tarball into a fresh project, and use it the way a consumer would:
// an ESM import, a TypeScript type check against the shipped .d.ts files, and the bin.
// Run after `npm run build`. Needs the npm registry for the package's dependencies.
//
//   --keychain     also do a real set -> get -> remove round trip in the OS keychain (macOS, Windows), under the
//                  test service "programscape-router-ci", never the real one
//   --no-keychain  on a machine with no keychain (Linux without a Secret Service): check that `keys` explains
//                  the problem and that the router still works with environment variables
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const work = mkdtempSync(join(tmpdir(), "psr-pack-smoke-"));
const mode = process.argv.includes("--keychain") ? "keychain" : process.argv.includes("--no-keychain") ? "no-keychain" : "basic";
// Every keychain-touching run uses a test service, through the test-only entry script scripts/keychain-cli.mjs
// (the released CLI can't change the service), so a developer's real stored keys are never read or touched.
const TEST_SERVICE = mode === "keychain" ? "programscape-router-ci" : "programscape-router-smoke-empty";
const testEntry = join(root, "scripts", "keychain-cli.mjs");

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

// npm through node and npm's own JS entry point, never through npm.cmd: Node won't spawn a .cmd shim without a
// shell, and a shell would re-parse the arguments. `npm run` provides the entry point; otherwise it sits beside node.
function npmCli() {
  const fromNpm = process.env.npm_execpath;
  if (fromNpm && /\.c?js$/.test(fromNpm)) return fromNpm;
  const besideNode = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (existsSync(besideNode)) return besideNode;
  const unixLayout = join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  if (existsSync(unixLayout)) return unixLayout;
  throw new Error("Can't find npm's entry point; run this through `npm run smoke:pack`.");
}

function npm(args, cwd) {
  return run(process.execPath, [npmCli(), ...args], cwd);
}

try {
  const [packed] = JSON.parse(npm(["pack", "--json", "--pack-destination", work], root));
  const tarball = join(work, packed.filename);
  const files = packed.files.map((file) => file.path);
  console.log(`packed ${packed.filename}: ${files.length} files, ${packed.size} bytes`);
  for (const required of ["package.json", "README.md", "CHANGELOG.md", "LICENSE", "dist/index.js", "dist/index.d.ts", "dist/cli.js"]) {
    if (!files.includes(required)) throw new Error(`the tarball is missing ${required}`);
  }
  const stray = files.filter((file) => /^(src|test|scripts)\/|\.map$|\.test\./.test(file));
  if (stray.length > 0) throw new Error(`the tarball ships files it should not: ${stray.join(", ")}`);

  const app = join(work, "app");
  mkdirSync(app);
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "psr-smoke", private: true, type: "module" }, null, 2));
  const devDeps = pkg.devDependencies;
  npm(["install", "--no-audit", "--no-fund", "--loglevel=error", tarball, `typescript@${devDeps.typescript}`, `@types/node@${devDeps["@types/node"]}`], app);

  // 1. ESM import of the public API, with no keys and no network.
  writeFileSync(
    join(app, "esm.mjs"),
    `import * as api from "@programscape/router";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const pkg = require("@programscape/router/package.json");
if (api.VERSION !== pkg.version) throw new Error("VERSION " + api.VERSION + " != package.json " + pkg.version);
for (const name of ["createRouter", "runCheck", "formatCheck", "formatStatus", "loadConfig", "parseConfig", "createMcpServer", "runMcpServer"]) {
  if (typeof api[name] !== "function") throw new Error(name + " is not exported as a function");
}
for (const name of ["computeOrder", "configSchema", "createBalanceSync", "connect", "disconnect", "ADAPTERS"]) {
  if (name in api) throw new Error(name + " is internal but exported");
}
const router = api.createRouter({ env: {}, config: {}, ledgerPath: false, log: () => {} });
const status = await router.status();
const ids = status.providers.map((provider) => provider.id).join(",");
if (ids !== "exa,firecrawl,keenable,linkup,parallel,tavily,youcom") throw new Error("expected the seven providers, alphabetically: " + ids);
const report = await api.runCheck({ env: {} });
if (report.attempted !== 0 || report.ok) throw new Error("check with no keys should attempt nothing and not pass");
let blocked = false;
try { await import("@programscape/router/dist/router.js"); } catch (error) { blocked = error.code === "ERR_PACKAGE_PATH_NOT_EXPORTED"; }
if (!blocked) throw new Error("deep imports should be blocked by exports");
console.log("esm import ok: " + Object.keys(api).length + " exports, version " + api.VERSION);
`,
  );
  console.log(run(process.execPath, ["esm.mjs"], app).trim());

  // 2. The shipped types, checked by TypeScript as a consumer would (skipLibCheck off, so the .d.ts files are checked).
  writeFileSync(
    join(app, "tsconfig.json"),
    JSON.stringify(
      { compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, skipLibCheck: false, types: ["node"] }, files: ["types.ts"] },
      null,
      2,
    ),
  );
  writeFileSync(
    join(app, "types.ts"),
    `import {
  createRouter, runCheck, formatCheck, RouterError, ConfigError, ProgramscapeError, VERSION, PROVIDER_IDS,
  type Router, type RouterOptions, type RouterStatus, type SearchResponse, type ScrapeResponse, type CheckReport,
  type CheckCall, type Outcome, type ProviderId, type Balance, type RouterConfig, type SyncResult, type FetchLike,
} from "@programscape/router";

const fetchImpl: FetchLike = (input, init) => fetch(input, init);
const config: RouterConfig = { order: { search: ["tavily", "exa"] }, providers: { exa: { credits: [{ expiresOn: "2027-03-01", remaining: 1 }] } } };
const options: RouterOptions = { env: {}, config, fetch: fetchImpl, ledgerPath: false };
const router: Router = createRouter(options);
export async function use(): Promise<void> {
  const searched: SearchResponse = await router.search({ query: "q", maxResults: 3 });
  const scraped: ScrapeResponse = await router.scrape({ url: "https://example.com" });
  const status: RouterStatus = await router.status({ refresh: true });
  const synced: SyncResult[] = await router.syncBalances();
  const report: CheckReport = await runCheck({ env: {} });
  const call: CheckCall | undefined = report.providers[0]?.calls[0];
  const outcome: Outcome | undefined = call?.outcome;
  const id: ProviderId = PROVIDER_IDS[0];
  const balances: Balance[] = status.providers[0]?.balances ?? [];
  console.log(searched.routing.provider, scraped.result.markdown.length, synced.length, formatCheck(report), outcome, id, balances.length, VERSION);
  try { await router.search({ query: "" }); } catch (error) { if (error instanceof RouterError) console.log(error.code, error.routing?.tried.length); }
  console.log(new ConfigError("x").message, new ProgramscapeError("rejected", "x").kind);
}
`,
  );
  run(process.execPath, [join(app, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"], app);
  console.log("types ok: the shipped .d.ts files type-check with skipLibCheck off");

  // 3. The bin. npm made the shim; the CLI is run through node so this works the same on Windows.
  const shim = join(app, "node_modules", ".bin", process.platform === "win32" ? "programscape-router.cmd" : "programscape-router");
  if (!existsSync(shim)) throw new Error(`npm did not create the bin shim at ${shim}`);
  const cliPath = join(app, "node_modules", "@programscape", "router", "dist", "cli.js");
  const home = join(work, "home");
  mkdirSync(home);
  // A throwaway home keeps the run away from the developer's own config and ledger. The keychain round trip keeps
  // the real one: macOS finds the login keychain through HOME. XDG_* still keep files out of it.
  const homes =
    mode === "keychain"
      ? Object.fromEntries(["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"].filter((name) => process.env[name]).map((name) => [name, process.env[name]]))
      : { HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local") };
  const baseEnv = {
    PATH: process.env.PATH ?? "",
    SystemRoot: process.env.SystemRoot ?? "",
    ...homes,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_STATE_HOME: join(home, "state"),
  };
  // On Linux and macOS the keychain needs the session's own variables (D-Bus, the user) to reach the store.
  for (const name of ["DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "USER", "LOGNAME", "TMPDIR", "TEMP", "TMP"]) {
    if (process.env[name]) baseEnv[name] = process.env[name];
  }
  const packageRoot = join(app, "node_modules", "@programscape", "router");
  // The installed package's own CLI, with the keychain service switched to the test one.
  const cli = (args, { env = {}, input } = {}) =>
    spawnSync(process.execPath, [testEntry, packageRoot, TEST_SERVICE, ...args], { cwd: app, env: { ...baseEnv, ...env }, encoding: "utf8", input, timeout: 60_000 });

  // The published bin itself, exactly as npx runs it.
  const version = spawnSync(process.execPath, [cliPath, "--version"], { cwd: app, env: baseEnv, encoding: "utf8", timeout: 60_000 });
  if (version.stdout.trim() !== pkg.version) throw new Error(`bin --version printed ${version.stdout}`);
  const check = cli(["check", "--json"]);
  const report = JSON.parse(check.stdout);
  if (check.status !== 1 || report.attempted !== 0) throw new Error(`check with no keys: exit ${check.status}, attempted ${report.attempted}`);
  console.log(`bin ok: --version ${version.stdout.trim()}; check with no keys exits 1 and attempts nothing`);

  if (mode === "keychain") keychainRoundTrip(cli, app);
  if (mode === "no-keychain") noKeychain(cli);
  console.log("pack smoke passed");
} finally {
  if (!process.env.KEEP_SMOKE) rmSync(work, { recursive: true, force: true });
}

function expectRun(result, code, what) {
  if (result.error) throw new Error(`${what}: ${result.error.message}`);
  if (result.status !== code) throw new Error(`${what}: exit ${result.status}, expected ${code}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  return result;
}

/** A real set -> get -> remove round trip in the OS keychain, under the test service. */
function keychainRoundTrip(cli, app) {
  const secret = `exa-ci-${Math.random().toString(36).slice(2)}${Date.now()}`;
  const leaked = (result) => `${result.stdout}${result.stderr}`.includes(secret);
  try {
    cli(["keys", "remove", "exa"]); // a leftover from an earlier run, if any
    const set = expectRun(cli(["keys", "set", "exa", "--stdin"], { input: `${secret}\n` }), 0, "keys set --stdin");
    if (!/^Saved the Exa key in /m.test(set.stdout) || leaked(set)) throw new Error(`keys set printed: ${set.stdout}`);

    // The native module itself reads back exactly what was stored.
    const read = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", `const { AsyncEntry } = await import("@napi-rs/keyring"); process.stdout.write(String(await new AsyncEntry("${TEST_SERVICE}", "EXA_API_KEY").getPassword()));`],
      { cwd: join(app, "node_modules", "@programscape", "router"), encoding: "utf8", timeout: 60_000 },
    );
    if (read.stdout !== secret) throw new Error(`the keychain did not hold the key (got ${read.stdout.length} chars; ${read.stderr})`);

    // The entry exists under the name the "remove it by hand" instructions give.
    if (process.platform === "darwin") {
      const found = spawnSync("security", ["find-generic-password", "-s", TEST_SERVICE, "-a", "EXA_API_KEY"], { encoding: "utf8" });
      if (found.status !== 0) throw new Error(`security find-generic-password did not find the item: ${found.stderr}`);
    } else if (process.platform === "win32") {
      const target = `EXA_API_KEY.${TEST_SERVICE}`;
      const found = spawnSync("cmdkey", [`/list:${target}`], { encoding: "utf8" });
      if (!found.stdout.includes(target)) throw new Error(`cmdkey did not list ${target}: ${found.stdout}`);
    }

    const list = expectRun(cli(["keys", "list", "--json"]), 0, "keys list");
    const exa = JSON.parse(list.stdout).keys.find((entry) => entry.provider === "exa");
    if (exa.source !== "keychain" || exa.inKeychain !== true || leaked(list)) throw new Error(`keys list: ${list.stdout}`);

    const status = expectRun(cli(["status", "--json"]), 0, "status");
    const parsed = JSON.parse(status.stdout);
    if (parsed.providers.find((p) => p.id === "exa").keySource !== "keychain" || leaked(status)) throw new Error(`status: ${status.stdout}`);

    const removed = expectRun(cli(["keys", "remove", "exa"]), 0, "keys remove");
    if (!removed.stdout.startsWith("Removed the Exa key from ")) throw new Error(`keys remove printed: ${removed.stdout}`);
    const after = JSON.parse(expectRun(cli(["keys", "list", "--json"]), 0, "keys list after remove").stdout);
    if (after.keys.find((entry) => entry.provider === "exa").source !== "none") throw new Error("the key was still listed after remove");
    console.log(`keychain ok: set -> get -> named entry -> list -> status -> remove in ${JSON.parse(list.stdout).keychain}`);
  } finally {
    cli(["keys", "remove", "exa"]);
  }
}

/** No keychain here: `keys` says so, and the router still works with environment variables. */
function noKeychain(cli) {
  const set = expectRun(cli(["keys", "set", "exa", "--stdin"], { input: "exa-not-stored\n" }), 1, "keys set with no keychain");
  if (!/keychain|native module/i.test(set.stderr) || !set.stderr.includes("Keep your keys safe")) throw new Error(`keys set said: ${set.stderr}`);
  const list = expectRun(cli(["keys", "list"], { env: { EXA_API_KEY: "exa-from-env" } }), 0, "keys list with no keychain");
  if (!list.stdout.includes("set, from the environment")) throw new Error(`keys list: ${list.stdout}`);
  const status = expectRun(cli(["status", "--json"], { env: { EXA_API_KEY: "exa-from-env" } }), 0, "status with no keychain");
  const parsed = JSON.parse(status.stdout);
  if (parsed.providers.find((p) => p.id === "exa").keySource !== "env") throw new Error(`status: ${status.stdout}`);
  if (!parsed.keychainNote) throw new Error("status should say why the keychain could not be read");
  console.log(`no keychain ok: keys explains it; status works with env keys (${parsed.keychainNote.slice(0, 80)}...)`);
}
