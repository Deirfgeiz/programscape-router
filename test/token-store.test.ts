import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { main } from "../src/cli-main.js";
import * as keys from "../src/keys.js";
import { KEYCHAIN_SERVICE } from "../src/keys.js";
import { TOKEN_KEYCHAIN_ACCOUNT, deleteTokenFile, readSyncState, readTokenFile, tokenPath, writeTokenFile } from "../src/programscape/store.js";
import { AsyncEntry, fakeKeyring } from "./fake-keyring.js";
import { fakeProgramscape } from "./programscape-fake.js";

function home() {
  const root = mkdtempSync(join(tmpdir(), "psr-tokens-"));
  return { XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state") };
}

const pair = (n: number) => ({
  version: 1 as const,
  issuer: "https://programscape.com",
  clientId: "client-1",
  accessToken: `ps-ACCESS-${n}-TOKENSECRET`,
  refreshToken: `ps-REFRESH-${n}-TOKENSECRET`,
  connectedAt: "2026-10-11T12:00:00.000Z",
});

const inKeychain = () => {
  const raw = fakeKeyring.peek(KEYCHAIN_SERVICE, TOKEN_KEYCHAIN_ACCOUNT);
  return raw ? (JSON.parse(raw) as { accessToken: string; seq: number }) : undefined;
};
const inFile = (env: ReturnType<typeof home>) =>
  existsSync(tokenPath(env)) ? (JSON.parse(readFileSync(tokenPath(env), "utf8")) as { accessToken: string; seq: number }) : undefined;

describe("token store", () => {
  it("a rotation the keychain refuses goes to the file, and the file's newer pair is the one read back", async () => {
    const env = home();
    expect(await writeTokenFile(env, pair(1))).toMatchObject({ kind: "keychain" });
    fakeKeyring.failing.set = "refused";
    expect(await writeTokenFile(env, pair(2))).toEqual({ kind: "file", path: tokenPath(env) });
    expect(inFile(env)).toMatchObject({ accessToken: "ps-ACCESS-2-TOKENSECRET", seq: 2 });
    // The stale keychain pair was deleted after the fallback write.
    expect(inKeychain()).toBeUndefined();
    expect(await readTokenFile(env)).toMatchObject({ accessToken: "ps-ACCESS-2-TOKENSECRET", refreshToken: "ps-REFRESH-2-TOKENSECRET" });
  });

  it("reads the newest pair even when the stale keychain copy can't be deleted", async () => {
    const env = home();
    await writeTokenFile(env, pair(1));
    fakeKeyring.failing.set = "refused";
    fakeKeyring.failing.delete = "refused";
    await writeTokenFile(env, pair(2));
    expect(inKeychain()).toMatchObject({ accessToken: "ps-ACCESS-1-TOKENSECRET", seq: 1 });
    expect(inFile(env)).toMatchObject({ accessToken: "ps-ACCESS-2-TOKENSECRET", seq: 2 });
    expect((await readTokenFile(env))?.accessToken).toBe("ps-ACCESS-2-TOKENSECRET");
  });

  it("uses the fallback file after a keychain read and rotation write both fail", async () => {
    const env = home();
    await writeTokenFile(env, pair(1));
    await writeTokenFile(env, pair(2));
    fakeKeyring.failing = { get: "read failed", set: "save failed", delete: "delete failed" };
    expect(await writeTokenFile(env, pair(3))).toMatchObject({ kind: "file" });
    expect(inKeychain()).toMatchObject({ accessToken: "ps-ACCESS-2-TOKENSECRET", seq: 2 });
    expect(inFile(env)).toMatchObject({ accessToken: "ps-ACCESS-3-TOKENSECRET", seq: 1 });
    fakeKeyring.failing = {};
    expect(await readTokenFile(env)).toMatchObject({
      accessToken: "ps-ACCESS-3-TOKENSECRET",
      refreshToken: "ps-REFRESH-3-TOKENSECRET",
    });
  });

  it("preserves an unreadable keychain grant even when a keychain write would work", async () => {
    const env = home();
    await writeTokenFile(env, pair(1));
    fakeKeyring.failing.get = "temporary read failure";
    expect(await writeTokenFile(env, pair(2))).toMatchObject({ kind: "file" });
    expect(inKeychain()?.accessToken).toBe("ps-ACCESS-1-TOKENSECRET");
    expect(inFile(env)?.accessToken).toBe("ps-ACCESS-2-TOKENSECRET");
    fakeKeyring.failing = {};
    expect((await readTokenFile(env))?.accessToken).toBe("ps-ACCESS-2-TOKENSECRET");
  });

  it("does not reuse an older keychain token when the authoritative file is unreadable", async () => {
    const env = home();
    await writeTokenFile(env, pair(1));
    fakeKeyring.failing = { set: "save failed", delete: "delete failed" };
    await writeTokenFile(env, pair(2));
    writeFileSync(tokenPath(env), "not valid JSON");
    fakeKeyring.failing = {};
    expect(await readTokenFile(env)).toBeUndefined();
  });

  it("keychain, then file, then keychain again: each read returns the latest, and the file copy is deleted", async () => {
    const env = home();
    await writeTokenFile(env, pair(1));
    expect((await readTokenFile(env))?.accessToken).toBe("ps-ACCESS-1-TOKENSECRET");

    fakeKeyring.failing = { set: "refused", delete: "refused" };
    await writeTokenFile(env, pair(2));
    expect((await readTokenFile(env))?.accessToken).toBe("ps-ACCESS-2-TOKENSECRET");

    fakeKeyring.failing = {};
    expect(await writeTokenFile(env, pair(3))).toMatchObject({ kind: "keychain" });
    expect(inKeychain()).toMatchObject({ accessToken: "ps-ACCESS-3-TOKENSECRET", seq: 3 });
    expect(existsSync(tokenPath(env))).toBe(false);
    expect((await readTokenFile(env))?.accessToken).toBe("ps-ACCESS-3-TOKENSECRET");
  });

  it("refreshes from the newer file pair after a failed keychain write, never from the revoked keychain pair", async () => {
    // What the sync's token rotation does: read, refresh with the refresh token, save the new pair.
    const env = home();
    await writeTokenFile(env, pair(1));
    const first = await readTokenFile(env);
    fakeKeyring.failing = { set: "refused", delete: "refused" };
    await writeTokenFile(env, { ...pair(2), clientId: first?.clientId ?? "" });
    const next = await readTokenFile(env);
    expect(next?.refreshToken).toBe("ps-REFRESH-2-TOKENSECRET");
  });

  it("delete reports each store, reads back to confirm, and names what is left", async () => {
    const env = home();
    await writeTokenFile(env, pair(1));
    fakeKeyring.failing.delete = "refused";
    const result = await deleteTokenFile(env);
    expect(result).toMatchObject({ keychain: "failed", file: "absent", gone: false });
    expect(result.manual?.[0]).toContain("programscape-router");
    expect(result.manual?.[0]).toContain("programscape-token");
    expect(await readTokenFile(env)).toBeDefined();

    fakeKeyring.failing = {};
    expect(await deleteTokenFile(env)).toEqual({ keychain: "deleted", file: "absent", gone: true });
    expect(await readTokenFile(env)).toBeUndefined();
  });
});

describe("disconnect", () => {
  async function connectedHome() {
    const fake = fakeProgramscape();
    const env = home();
    const io = { stdout: () => {}, stderr: () => {} };
    expect(await main(["connect"], io, { env, config: {}, fetch: fake.fetch, ledgerPath: false, openBrowser: fake.browser })).toBe(0);
    return { fake, env };
  }

  it("exits 1 and says exactly what is left when the keychain delete and the remote revoke both fail", async () => {
    const { fake, env } = await connectedHome();
    fakeKeyring.failing.delete = "native delete failed for ps-ACCESS-1-TOKENSECRET";
    fake.behaviour.revokeFails = true;
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(["disconnect"], { stdout: (t) => out.push(t), stderr: (t) => err.push(t) }, { env, fetch: fake.fetch, platform: "darwin" });
    expect(code).toBe(1);
    const all = out.join("") + err.join("");
    expect(all).toContain("Programscape: could not confirm the revocation");
    expect(all).toContain("OS keychain: COULD NOT DELETE");
    expect(all).toContain("Could not verify that every local sign-in token was removed.");
    expect(all).toMatch(/programscape-token/);
    expect(all).toContain("remove the router's access on programscape.com");
    expect(all).not.toContain("Disconnected:");
    expect(all).not.toContain("TOKENSECRET");
    expect(all).not.toContain("native delete failed");
    expect(await readTokenFile(env)).toBeDefined();
    expect((await readSyncState(env)).off?.reason).toContain("disconnect was requested");
  });

  it("exits 1 when only the remote revoke fails, though nothing is left locally", async () => {
    const { fake, env } = await connectedHome();
    fake.behaviour.revokeFails = true;
    const err: string[] = [];
    expect(await main(["disconnect"], { stdout: () => {}, stderr: (t) => err.push(t) }, { env, fetch: fake.fetch })).toBe(1);
    expect(err.join("")).toContain("remove the router's access on programscape.com");
    expect(err.join("")).not.toContain("every local sign-in token");
    expect(await readTokenFile(env)).toBeUndefined();
  });

  it("exits 0 only when the token is revoked and gone from every store", async () => {
    const { fake, env } = await connectedHome();
    const out: string[] = [];
    expect(await main(["disconnect"], { stdout: (t) => out.push(t), stderr: () => {} }, { env, fetch: fake.fetch })).toBe(0);
    expect(out.join("")).toContain("OS keychain: deleted");
    expect(out.join("")).toContain("Disconnected: no token is left on this machine, and Programscape revoked it.");
  });

  it("exits 1 and asks for manual checks when the keychain cannot be opened", async () => {
    const env = home();
    await writeTokenFile(env, pair(1));
    const open = vi.spyOn(keys, "openKeychain").mockRejectedValue(new Error("keychain unavailable"));
    try {
      const out: string[] = [];
      const err: string[] = [];
      const code = await main(["disconnect"], { stdout: (t) => out.push(t), stderr: (t) => err.push(t) }, { env, fetch: async () => { throw new Error("unexpected network call"); } });
      expect(code).toBe(1);
      expect(out.join("")).toContain("OS keychain: COULD NOT CHECK");
      expect(err.join("")).toContain("Could not verify that every local sign-in token was removed.");
      expect(err.join("")).toContain("programscape-token");
      expect(err.join("")).toContain("programscape.com");
      expect(inKeychain()).toBeDefined();
    } finally {
      open.mockRestore();
    }
  });

  it("does not claim success if the initial token read fails but deletion later succeeds", async () => {
    const env = home();
    await writeTokenFile(env, pair(1));
    const get = vi.spyOn(AsyncEntry.prototype, "getPassword").mockRejectedValueOnce(new Error("temporary read failure"));
    try {
      const out: string[] = [];
      const err: string[] = [];
      const code = await main(["disconnect"], { stdout: (t) => out.push(t), stderr: (t) => err.push(t) }, { env, fetch: async () => { throw new Error("unexpected network call"); } });
      expect(code).toBe(1);
      expect(out.join("")).not.toContain("Nothing to do");
      expect(err.join("")).toContain("Programscape did not confirm the revocation");
      expect(inKeychain()).toBeUndefined();
    } finally {
      get.mockRestore();
    }
  });

  it("does not claim remote revocation when a keychain entry cannot be parsed", async () => {
    const env = home();
    fakeKeyring.put(KEYCHAIN_SERVICE, TOKEN_KEYCHAIN_ACCOUNT, "invalid JSON");
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(["disconnect"], { stdout: (t) => out.push(t), stderr: (t) => err.push(t) }, { env, fetch: async () => { throw new Error("unexpected network call"); } });
    expect(code).toBe(1);
    expect(out.join("")).not.toContain("Nothing to do");
    expect(err.join("")).toContain("Programscape did not confirm the revocation");
    expect(inKeychain()).toBeUndefined();
    expect((await readSyncState(env)).off).toBeDefined();
  });

  it("revokes both grants when an old keychain entry survives a fallback connect", async () => {
    const { fake, env } = await connectedHome();
    fakeKeyring.failing = { set: "save failed", delete: "delete failed" };
    expect(await main(["connect"], { stdout: () => {}, stderr: () => {} }, { env, config: {}, fetch: fake.fetch, ledgerPath: false, openBrowser: fake.browser })).toBe(0);
    expect(inKeychain()?.accessToken).toBe("ps-ACCESS-1-TOKENSECRET");
    expect(inFile(env)?.accessToken).toBe("ps-ACCESS-2-TOKENSECRET");
    fakeKeyring.failing = {};
    const out: string[] = [];
    expect(await main(["disconnect"], { stdout: (t) => out.push(t), stderr: () => {} }, { env, fetch: fake.fetch })).toBe(0);
    expect(fake.revocations.map((form) => form.get("token")).sort()).toEqual([
      "ps-ACCESS-1-TOKENSECRET",
      "ps-ACCESS-2-TOKENSECRET",
      "ps-REFRESH-1-TOKENSECRET",
      "ps-REFRESH-2-TOKENSECRET",
    ]);
    expect(fake.access.size).toBe(0);
    expect(fake.refresh.size).toBe(0);
    expect(out.join("")).toContain("Disconnected:");
  });
});
