#!/usr/bin/env node
// Pack the package, install the tarball into a fresh project, and use it the way a consumer would:
// an ESM import, a TypeScript type check against the shipped .d.ts files, and the bin.
// Run after `npm run build`. Needs the npm registry for the package's dependencies.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const work = mkdtempSync(join(tmpdir(), "psr-pack-smoke-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

try {
  const [packed] = JSON.parse(run(npm, ["pack", "--json", "--pack-destination", work], root));
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
  run(npm, ["install", "--no-audit", "--no-fund", "--loglevel=error", tarball, `typescript@${devDeps.typescript}`, `@types/node@${devDeps["@types/node"]}`], app);

  // 1. ESM import of the public API, with no keys and no network.
  writeFileSync(
    join(app, "esm.mjs"),
    `import * as api from "programscape-router";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const pkg = require("programscape-router/package.json");
if (api.VERSION !== pkg.version) throw new Error("VERSION " + api.VERSION + " != package.json " + pkg.version);
for (const name of ["createRouter", "runCheck", "formatCheck", "formatStatus", "loadConfig", "parseConfig", "createMcpServer", "runMcpServer"]) {
  if (typeof api[name] !== "function") throw new Error(name + " is not exported as a function");
}
for (const name of ["computeOrder", "configSchema", "createBalanceSync", "connect", "disconnect", "ADAPTERS"]) {
  if (name in api) throw new Error(name + " is internal but exported");
}
const router = api.createRouter({ env: {}, config: {}, ledgerPath: false, log: () => {} });
const status = await router.status();
if (status.providers.length !== 5) throw new Error("expected five providers");
const report = await api.runCheck({ env: {} });
if (report.attempted !== 0 || report.ok) throw new Error("check with no keys should attempt nothing and not pass");
let blocked = false;
try { await import("programscape-router/dist/router.js"); } catch (error) { blocked = error.code === "ERR_PACKAGE_PATH_NOT_EXPORTED"; }
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
} from "programscape-router";

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

  // 3. The bin.
  const bin = join(app, "node_modules", ".bin", "programscape-router");
  const version = run(bin, ["--version"], app).trim();
  if (version !== pkg.version) throw new Error(`bin --version printed ${version}`);
  const env = { PATH: process.env.PATH ?? "", HOME: work };
  const check = spawnSync(bin, ["check", "--json"], { cwd: app, env, encoding: "utf8" });
  const report = JSON.parse(check.stdout);
  if (check.status !== 1 || report.attempted !== 0) throw new Error(`check with no keys: exit ${check.status}, attempted ${report.attempted}`);
  console.log(`bin ok: --version ${version}; check with no keys exits 1 and attempts nothing`);
  console.log("pack smoke passed");
} finally {
  if (!process.env.KEEP_SMOKE) rmSync(work, { recursive: true, force: true });
}
