import { PassThrough, Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli-main.js";
import { KEYCHAIN_SERVICE, KEY_ENV_VARS, classifyKeychainError, resolveKeys, useKeychainServiceForTests } from "../src/keys.js";
import { PromptCancelledError, readFirstLine, readHidden } from "../src/prompt.js";
import { ADAPTERS } from "../src/providers/index.js";
import { PROVIDER_IDS } from "../src/types.js";
import { fakeKeyring } from "./fake-keyring.js";
import { URLS, fixture, mockFetch, ok } from "./helpers.js";

const SECRET = "tvly-KEYCHAINSECRET-9999";

/** A terminal stand-in: a stream that says it is a TTY and records raw-mode changes. */
function terminal() {
  const stream = new PassThrough() as PassThrough & { isTTY: boolean; isRaw: boolean; setRawMode(mode: boolean): void; modes: boolean[] };
  stream.isTTY = true;
  stream.isRaw = false;
  stream.modes = [];
  stream.setRawMode = (mode: boolean) => {
    stream.isRaw = mode;
    stream.modes.push(mode);
  };
  return stream;
}

function output() {
  const text: string[] = [];
  return { write: (t: string) => text.push(t), text };
}

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { streams: { stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t) }, out, err, all: () => out.join("") + err.join("") };
}

describe("hidden prompt", () => {
  it("reads one line in raw mode without echoing it, and restores the terminal", async () => {
    const input = terminal();
    const shown = output();
    const answer = readHidden("Key: ", input, shown);
    input.write("tvly-abc");
    input.write("X\b"); // Backspace (Windows consoles send \b)
    input.write("d\u007f"); // Delete (macOS and Linux terminals send DEL)
    input.write("\u001b[D"); // an arrow key: dropped
    input.write("123\r\nignored");
    expect(await answer).toBe("tvly-abc123");
    expect(shown.text.join("")).toBe("Key: \n");
    expect(input.modes).toEqual([true, false]);
  });

  it("ends at Ctrl-D and cancels at Ctrl-C", async () => {
    const eof = terminal();
    const done = readHidden("Key: ", eof, output());
    eof.write("abc\u0004");
    expect(await done).toBe("abc");

    const cancel = terminal();
    const cancelled = readHidden("Key: ", cancel, output());
    cancel.write("abc\u0003");
    await expect(cancelled).rejects.toBeInstanceOf(PromptCancelledError);
    expect(cancel.modes).toEqual([true, false]);
  });

  it("refuses a stream that is not a terminal", async () => {
    await expect(readHidden("Key: ", new PassThrough(), output())).rejects.toThrow("Not a terminal.");
  });

  it("reads the first line from a pipe, with Unix or Windows line endings", async () => {
    expect(await readFirstLine(Readable.from(["tvly-abc\n", "more\n"]))).toBe("tvly-abc");
    expect(await readFirstLine(Readable.from(["tvly-abc\r\n"]))).toBe("tvly-abc");
    expect(await readFirstLine(Readable.from(["tvly-", "abc"]))).toBe("tvly-abc");
    expect(await readFirstLine(Readable.from(["\uFEFFtvly-abc\r\n"]))).toBe("tvly-abc");
  });
});

describe("resolveKeys", () => {
  it("maps each provider to its environment variable", () => {
    for (const id of PROVIDER_IDS) expect(KEY_ENV_VARS[id]).toBe(ADAPTERS[id].envVar);
  });

  it("prefers the environment, fills the rest from the keychain, and pins Linux to the Secret Service", async () => {
    fakeKeyring.put(KEYCHAIN_SERVICE, "TAVILY_API_KEY", "tvly-from-keychain");
    fakeKeyring.put(KEYCHAIN_SERVICE, "EXA_API_KEY", "exa-from-keychain");
    const resolved = await resolveKeys({ env: { EXA_API_KEY: "exa-from-env" } });
    expect(resolved.keys).toEqual({ exa: "exa-from-env", tavily: "tvly-from-keychain" });
    expect(resolved.sources).toEqual({ exa: "env", firecrawl: "none", keenable: "none", parallel: "none", tavily: "keychain" });
    expect(resolved.keychainNote).toBeUndefined();
    // Never the kernel keyring, which forgets keys at logout.
    expect(fakeKeyring.entryOptions.every((options) => JSON.stringify(options) === '{"linux":{"store":"secret-service"}}')).toBe(true);
  });

  it("doesn't touch the keychain when every key is in the environment, or when told not to", async () => {
    const env = Object.fromEntries(PROVIDER_IDS.map((id) => [KEY_ENV_VARS[id], `${id}-key`]));
    await resolveKeys({ env });
    await resolveKeys({ env: {}, keychain: false });
    expect(fakeKeyring.entryOptions).toEqual([]);
  });

  it("keeps the environment's keys, with a note, when there is no keychain", async () => {
    fakeKeyring.available = false;
    const resolved = await resolveKeys({ env: { EXA_API_KEY: "exa-from-env" }, platform: "linux" });
    expect(resolved.keys).toEqual({ exa: "exa-from-env" });
    expect(resolved.keychainNote).toContain("on Linux the router stores keys in the Secret Service");
    expect(resolved.keychainNote).toContain("Keep your keys safe");
    // One failure is enough: the store isn't asked four more times.
    expect(fakeKeyring.entryOptions).toHaveLength(1);
  });

  it("keeps the environment's keys, with a note, when the native module can't load", async () => {
    const resolved = await resolveKeys({
      env: { EXA_API_KEY: "exa-from-env" },
      loader: async () => {
        throw new Error("Cannot find module '@napi-rs/keyring-linux-x64-gnu'");
      },
    });
    expect(resolved.keys).toEqual({ exa: "exa-from-env" });
    expect(resolved.keychainNote).toContain("@napi-rs/keyring");
    expect(resolved.keychainNote).toContain("Keys in environment variables still work");
  });

  it("ignores any environment variable that tries to pick another keychain service", async () => {
    fakeKeyring.put("programscape-router-ci", "EXA_API_KEY", "exa-ci");
    fakeKeyring.put("some-other-app", "EXA_API_KEY", "exa-other");
    const env = { PROGRAMSCAPE_ROUTER_TEST_KEYCHAIN_SERVICE: "programscape-router-ci", PROGRAMSCAPE_ROUTER_KEYCHAIN_SERVICE: "some-other-app" };
    expect((await resolveKeys({ env })).keys.exa).toBeUndefined();
    const { streams } = io();
    expect(await main(["keys", "set", "exa", "--stdin"], streams, { env, stdin: Readable.from(["exa-mine\n"]) as never })).toBe(0);
    expect(fakeKeyring.peek(KEYCHAIN_SERVICE, "EXA_API_KEY")).toBe("exa-mine");
    expect(fakeKeyring.peek("programscape-router-ci", "EXA_API_KEY")).toBe("exa-ci");
    expect(fakeKeyring.peek("some-other-app", "EXA_API_KEY")).toBe("exa-other");
  });

  it("uses another service only through the test seam", async () => {
    fakeKeyring.put("programscape-router-ci", "EXA_API_KEY", "exa-ci");
    useKeychainServiceForTests("programscape-router-ci");
    try {
      expect((await resolveKeys({ env: {} })).keys.exa).toBe("exa-ci");
    } finally {
      useKeychainServiceForTests();
    }
    expect((await resolveKeys({ env: {} })).keys.exa).toBeUndefined();
  });
});

describe("keys set", () => {
  it("stores a key typed at the hidden prompt, and never prints it", async () => {
    const stdin = terminal();
    const prompt = output();
    const { streams, out, all } = io();
    const done = main(["keys", "set", "tavily"], streams, { env: {}, stdin, promptOutput: prompt, platform: "darwin" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    stdin.write(`${SECRET}\r`);
    expect(await done).toBe(0);
    expect(fakeKeyring.peek(KEYCHAIN_SERVICE, "TAVILY_API_KEY")).toBe(SECRET);
    expect(out.join("")).toContain("Saved the Tavily key in the macOS Keychain (service programscape-router, account TAVILY_API_KEY).");
    expect(prompt.text.join("")).toBe("Paste your Tavily key (TAVILY_API_KEY); it won't be shown: \n");
    expect(all()).not.toContain(SECRET);
    expect(all()).not.toContain("KEYCHAINSECRET");
  });

  it("stores a key piped in with --stdin, and says when the environment overrides it", async () => {
    const { streams, out, all } = io();
    const stdin = Readable.from([`  ${SECRET}  \n`]) as never;
    const code = await main(["keys", "set", "TAVILY", "--stdin"], streams, { env: { TAVILY_API_KEY: "tvly-env" }, stdin, platform: "win32" });
    expect(code).toBe(0);
    expect(fakeKeyring.peek(KEYCHAIN_SERVICE, "TAVILY_API_KEY")).toBe(SECRET);
    expect(out.join("")).toContain("Saved the Tavily key in Windows Credential Manager");
    expect(out.join("")).toContain("TAVILY_API_KEY is also set in this environment, and the environment wins over the keychain.");
    expect(all()).not.toContain(SECRET);
  });

  it("says when it replaces a stored key", async () => {
    fakeKeyring.put(KEYCHAIN_SERVICE, "EXA_API_KEY", "exa-old");
    const { streams, out, all } = io();
    expect(await main(["keys", "set", "exa", "--stdin"], streams, { env: {}, stdin: Readable.from(["exa-new\n"]) as never, platform: "linux" })).toBe(0);
    expect(out.join("")).toContain("Replaced the Exa key in the Secret Service keyring (service programscape-router, account EXA_API_KEY).");
    expect(fakeKeyring.peek(KEYCHAIN_SERVICE, "EXA_API_KEY")).toBe("exa-new");
    expect(all()).not.toContain("exa-old");
    expect(all()).not.toContain("exa-new");
  });

  it("refuses without a terminal or --stdin, and saves nothing", async () => {
    const { streams, err } = io();
    const code = await main(["keys", "set", "tavily"], streams, { env: {}, stdin: Readable.from([SECRET]) as never });
    expect(code).toBe(2);
    expect(err.join("")).toContain("keys set needs a terminal, so it can ask for the key without showing it.");
    expect(err.join("")).toContain("programscape-router keys set tavily --stdin");
    expect(fakeKeyring.store.size).toBe(0);
  });

  it("saves nothing on Ctrl-C or an empty key, and rejects an unknown provider", async () => {
    const stdin = terminal();
    const cancel = io();
    const done = main(["keys", "set", "exa"], cancel.streams, { env: {}, stdin, promptOutput: output() });
    await new Promise((resolve) => setTimeout(resolve, 0));
    stdin.write("exa-partial\u0003");
    expect(await done).toBe(1);
    expect(cancel.err.join("")).toContain("Cancelled. Nothing was saved.");

    const empty = io();
    expect(await main(["keys", "set", "exa", "--stdin"], empty.streams, { env: {}, stdin: Readable.from(["\n"]) as never })).toBe(1);
    expect(empty.err.join("")).toContain("No key was entered");

    const unknown = io();
    expect(await main(["keys", "set", "google", "--stdin"], unknown.streams, { env: {}, stdin: Readable.from(["x\n"]) as never })).toBe(2);
    expect(unknown.err.join("")).toContain('"google" is not a provider this router knows. Use one of: exa, firecrawl, keenable, parallel, tavily.');
    expect(fakeKeyring.store.size).toBe(0);
  });

  it("explains when there is no keychain, before asking for the key", async () => {
    fakeKeyring.available = false;
    const stdin = terminal();
    const prompt = output();
    const { streams, err } = io();
    const code = await main(["keys", "set", "exa"], streams, { env: {}, stdin, promptOutput: prompt, platform: "linux" });
    expect(code).toBe(1);
    expect(err.join("")).toContain("No keychain is available here: on Linux the router stores keys in the Secret Service");
    expect(err.join("")).toContain("Keep your keys safe");
    expect(prompt.text).toEqual([]);
    expect(stdin.modes).toEqual([]);
  });

  it("explains when the native module can't load", async () => {
    const { streams, err } = io();
    const code = await main(["keys", "set", "exa"], streams, {
      env: {},
      stdin: terminal(),
      promptOutput: output(),
      keyringLoader: async () => {
        throw new Error("no prebuilt binary");
      },
    });
    expect(code).toBe(1);
    expect(err.join("")).toContain("its native module (@napi-rs/keyring");
  });
});

describe("keys list and remove", () => {
  it("lists where each key comes from and never prints a key, as text or JSON", async () => {
    fakeKeyring.put(KEYCHAIN_SERVICE, "TAVILY_API_KEY", SECRET);
    fakeKeyring.put(KEYCHAIN_SERVICE, "EXA_API_KEY", "exa-KEYCHAINSECRET-1");
    const env = { EXA_API_KEY: "exa-ENVSECRET-2", FIRECRAWL_API_KEY: "fc-ENVSECRET-3" };

    const text = io();
    expect(await main(["keys", "list"], text.streams, { env, platform: "darwin" })).toBe(0);
    const printed = text.out.join("");
    expect(printed).toContain("  exa       EXA_API_KEY        set, from the environment (the keychain has one too, unused while the variable is set)");
    expect(printed).toContain("  firecrawl FIRECRAWL_API_KEY  set, from the environment");
    expect(printed).toContain("  keenable  KEENABLE_API_KEY   not set");
    expect(printed).toContain("  tavily    TAVILY_API_KEY     set, from the keychain");
    expect(printed).toContain("Keychain: the macOS Keychain (service programscape-router).");

    const json = io();
    expect(await main(["keys", "list", "--json"], json.streams, { env, platform: "darwin" })).toBe(0);
    const parsed = JSON.parse(json.out.join(""));
    expect(parsed.keys.find((k: { provider: string }) => k.provider === "tavily")).toEqual({ provider: "tavily", envVar: "TAVILY_API_KEY", source: "keychain", inKeychain: true });

    for (const shown of [text.all(), json.all()]) {
      expect(shown).not.toContain("SECRET");
      expect(shown).not.toContain(SECRET);
      // Not even part of a key.
      expect(shown).not.toContain("tvly-");
      expect(shown).not.toContain("9999");
    }
  });

  it("still lists environment keys when there is no keychain", async () => {
    fakeKeyring.available = false;
    const { streams, out } = io();
    expect(await main(["keys", "list"], streams, { env: { EXA_API_KEY: "exa-x" }, platform: "linux" })).toBe(0);
    expect(out.join("")).toContain("  exa       EXA_API_KEY        set, from the environment");
    expect(out.join("")).toContain("Keychain: No keychain is available here");
  });

  it("removes a stored key, and says when there was none", async () => {
    fakeKeyring.put(KEYCHAIN_SERVICE, "TAVILY_API_KEY", SECRET);
    const first = io();
    expect(await main(["keys", "remove", "tavily"], first.streams, { env: {}, platform: "win32" })).toBe(0);
    expect(first.out.join("")).toBe("Removed the Tavily key from Windows Credential Manager.\n");
    expect(fakeKeyring.store.size).toBe(0);

    const again = io();
    expect(await main(["keys", "remove", "tavily"], again.streams, { env: { TAVILY_API_KEY: "t" }, platform: "win32" })).toBe(0);
    expect(again.out.join("")).toContain("There was no Tavily key in Windows Credential Manager. Nothing to do.");
    expect(again.out.join("")).toContain("TAVILY_API_KEY is still set in this environment");
  });

  it("prints usage for an unknown keys command", async () => {
    const { streams, err } = io();
    expect(await main(["keys", "show"], streams, { env: {} })).toBe(2);
    expect(err.join("")).toContain('Unknown keys command "show".');
    expect(err.join("")).toContain("keys set <provider> [--stdin]");
  });
});

describe("key sources in status and check", () => {
  it("status and check say where each key came from, never the key", async () => {
    fakeKeyring.put(KEYCHAIN_SERVICE, "EXA_API_KEY", "exa-KEYCHAINSECRET-1");
    const env = { TAVILY_API_KEY: "tvly-ENVSECRET-2" };
    const { fetch } = mockFetch({
      [URLS.tavilyUsage]: ok(fixture("tavily-usage")),
      [URLS.exaSearch]: ok(fixture("exa-search")),
      [URLS.exaContents]: ok(fixture("exa-contents")),
      [URLS.tavilySearch]: ok(fixture("tavily-search")),
      [URLS.tavilyExtract]: ok(fixture("tavily-extract")),
    });

    const status = io();
    expect(await main(["status", "--json"], status.streams, { env, config: {}, fetch, ledgerPath: false })).toBe(0);
    const parsed = JSON.parse(status.out.join(""));
    const source = (id: string) => parsed.providers.find((p: { id: string }) => p.id === id).keySource;
    expect([source("exa"), source("tavily"), source("firecrawl")]).toEqual(["keychain", "env", "none"]);

    const text = io();
    await main(["status"], text.streams, { env, config: {}, fetch, ledgerPath: false });
    expect(text.out.join("")).toContain("exa: key set (EXA_API_KEY, from the OS keychain)");
    expect(text.out.join("")).toContain("tavily: key set (TAVILY_API_KEY, from the environment)");

    const check = io();
    expect(await main(["check"], check.streams, { env, fetch })).toBe(0);
    expect(check.out.join("")).toContain("exa (EXA_API_KEY, from the OS keychain)");
    expect(check.out.join("")).toContain("tavily (TAVILY_API_KEY, from the environment)");
    const checkJson = io();
    await main(["check", "--json"], checkJson.streams, { env, fetch });
    expect(JSON.parse(checkJson.out.join("")).providers.map((p: { keySource: string }) => p.keySource)).toEqual(["keychain", "none", "none", "none", "env"]);

    for (const shown of [status.all(), text.all(), check.all(), checkJson.all()]) expect(shown).not.toContain("SECRET");
  });

  it("works with environment keys when there is no keychain, and says why in status", async () => {
    fakeKeyring.available = false;
    const { fetch } = mockFetch({ [URLS.exaSearch]: ok(fixture("exa-search")) });
    const search = io();
    expect(await main(["search", "q"], search.streams, { env: { EXA_API_KEY: "exa-x" }, config: {}, fetch, ledgerPath: false, platform: "linux" })).toBe(0);
    expect(search.err.join("")).toContain("Served by exa.");

    const status = io();
    await main(["status"], status.streams, { env: { EXA_API_KEY: "exa-x" }, config: {}, fetch, ledgerPath: false, platform: "linux" });
    expect(status.out.join("")).toContain("Keychain: No keychain is available here");
  });
});

describe("short secrets in native errors", () => {
  // Characters our own messages never use, so any appearance is a leak.
  const SHORT_KEYS = ["§", "¤¶", "¥µ¦"];

  for (const key of SHORT_KEYS) {
    it(`never prints a ${key.length}-character key from a native error, on set or remove`, async () => {
      fakeKeyring.failing.set = `native refused to store ${key} for EXA_API_KEY`;
      const set = io();
      expect(await main(["keys", "set", "exa", "--stdin"], set.streams, { env: {}, stdin: Readable.from([`${key}\n`]) as never, platform: "darwin" })).toBe(1);
      expect(set.err.join("")).toContain("Could not save to the macOS Keychain: it reported an error (failed).");
      expect(set.all()).not.toContain(key);
      expect(set.all()).not.toContain("native refused");

      fakeKeyring.failing = { delete: `native could not delete ${key}` };
      fakeKeyring.put(KEYCHAIN_SERVICE, "EXA_API_KEY", key);
      const remove = io();
      expect(await main(["keys", "remove", "exa"], remove.streams, { env: {}, platform: "win32" })).toBe(1);
      expect(remove.err.join("")).toContain("Could not delete from Windows Credential Manager: it reported an error (failed).");
      expect(remove.all()).not.toContain(key);

      fakeKeyring.failing = { get: `native read ${key}` };
      const list = io();
      expect(await main(["keys", "list", "--json"], list.streams, { env: {}, platform: "darwin" })).toBe(0);
      expect(list.all()).not.toContain(key);
      expect(list.all()).not.toContain("native read");
    });

    it(`redacts a ${key.length}-character key in routing messages and check --verbose`, async () => {
      const { fetch } = mockFetch({ [URLS.exaSearch]: () => new Response(JSON.stringify({ error: `bad key ${key}!` }), { status: 503 }) });
      const err = io();
      expect(await main(["search", "q"], err.streams, { env: { EXA_API_KEY: key }, config: {}, fetch, ledgerPath: false })).toBe(1);
      expect(err.all()).toContain("bad key [redacted]!");
      expect(err.all()).not.toContain(key);

      const check = io();
      await main(["check", "--json", "--verbose"], check.streams, { env: { EXA_API_KEY: key }, fetch });
      expect(check.all()).not.toContain(key);
    });
  }

  it("classifies native errors into fixed problems without keeping their text", () => {
    expect(classifyKeychainError(new Error("A default keychain could not be found."), "darwin")).toBe("no-default-keychain");
    expect(classifyKeychainError(new Error("The user name or passphrase you entered is not correct; locked"), "darwin")).toBe("locked");
    expect(classifyKeychainError(new Error("org.freedesktop.DBus.Error.ServiceUnknown"), "linux")).toBe("no-secret-service");
    expect(classifyKeychainError(new Error("org.freedesktop.DBus.Error.AccessDenied"), "linux")).toBe("access-denied");
    expect(classifyKeychainError(new Error("org.freedesktop.Secret.Error.IsLocked"), "linux")).toBe("locked");
    expect(classifyKeychainError(new Error("anything else"), "linux")).toBe("failed");
    expect(classifyKeychainError(new Error("Attribute 'password' is longer than platform limit of 2560 chars"), "win32")).toBe("too-large");
    expect(classifyKeychainError(new Error("anything else"), "win32")).toBe("failed");
  });
});
