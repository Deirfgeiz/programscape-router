#!/usr/bin/env node
// Test-only entry point, never published (scripts/ is not in package.json "files").
//
//   node scripts/keychain-cli.mjs <package root> <service> <programscape-router args...>
//
// Runs the built CLI from <package root>/dist with its keychain service switched to <service> through the internal
// test seam, so CI's real keychain round trips never touch a real `programscape-router` entry. The released CLI has
// no way to change the service.
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [root, service, ...args] = process.argv.slice(2);
if (!root || !service) {
  process.stderr.write("usage: node scripts/keychain-cli.mjs <package root> <service> <args...>\n");
  process.exit(2);
}
const dist = (file) => pathToFileURL(join(resolve(root), "dist", file)).href;
const { useKeychainServiceForTests } = await import(dist("keys.js"));
const { main } = await import(dist("cli-main.js"));
useKeychainServiceForTests(service);
const code = await main(args, { stdout: (text) => process.stdout.write(text), stderr: (text) => process.stderr.write(text) });
process.exitCode = code;
