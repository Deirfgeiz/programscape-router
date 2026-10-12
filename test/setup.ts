import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, vi } from "vitest";
import { fakeKeyring } from "./fake-keyring.js";

// Never touch the real OS keychain from a test.
vi.mock("@napi-rs/keyring", () => import("./fake-keyring.js"));

// Never make a live network call from a test: only the loopback sign-in redirect may use the real fetch. Everything
// else (providers, programscape.com) goes through a mocked fetch passed in by the test.
const realFetch = globalThis.fetch;
globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return realFetch(input, init);
  return Promise.reject(new TypeError(`no live network calls in tests: ${url.origin}`));
};

beforeEach(() => {
  fakeKeyring.reset();
  // A fresh home for every test, so the router's default files (readings, catalog cache, notices) never reach the
  // developer's own folders, and no test sees another's.
  const home = mkdtempSync(join(tmpdir(), "psr-home-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
});
