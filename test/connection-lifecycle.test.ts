import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { disconnect } from "../src/programscape/connect.js";
import {
  type ConnectionEvent,
  type ConnectionPhase,
  connectionLockPath,
  nextConnectionPhase,
  readConnectionState,
  transitionConnection,
  withConnectionLock,
} from "../src/programscape/store.js";
import { fakeKeyring } from "./fake-keyring.js";

const home = () => {
  const root = mkdtempSync(join(tmpdir(), "psr-lifecycle-"));
  return { XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state") };
};

const transitions: Array<[ConnectionPhase, ConnectionEvent, ConnectionPhase]> = [
  ["disconnected", "begin-connect", "awaiting-consent"],
  ["awaiting-consent", "begin-exchange", "cleanup-needed"],
  ["awaiting-consent", "cancel-connect", "disconnected"],
  ["cleanup-needed", "connect-succeeded", "connected"],
  ["cleanup-needed", "connect-rejected", "disconnected"],
  ["connected", "begin-refresh", "cleanup-needed"],
  ["cleanup-needed", "refresh-succeeded", "connected"],
  ["cleanup-needed", "refresh-refused", "sync-off"],
  ["disconnected", "begin-disconnect", "cleanup-needed"],
  ["awaiting-consent", "begin-disconnect", "cleanup-needed"],
  ["connected", "begin-disconnect", "cleanup-needed"],
  ["sync-off", "begin-disconnect", "cleanup-needed"],
  ["cleanup-needed", "begin-disconnect", "cleanup-needed"],
  ["cleanup-needed", "local-cleared", "disconnected"],
];

describe("connection lifecycle", () => {
  it.each(transitions)("persists %s + %s → %s across a restart", async (start, event, end) => {
    const env = home();
    if (start !== "disconnected") {
      // Each case starts with exactly the phase a prior process left on disk.
      const { writeConnectionState } = await import("../src/programscape/store.js");
      await writeConnectionState(env, { phase: start, keychainMayHoldGrant: false });
    }
    expect(nextConnectionPhase(start, event)).toBe(end);
    await transitionConnection(env, event);
    expect((await readConnectionState(env))?.phase ?? "disconnected").toBe(end);
  });

  it("rejects transitions that could silently replace a live grant", () => {
    expect(() => nextConnectionPhase("connected", "begin-connect")).toThrow("Invalid Programscape connection transition");
    expect(() => nextConnectionPhase("sync-off", "begin-connect")).toThrow("Invalid Programscape connection transition");
    expect(() => nextConnectionPhase("cleanup-needed", "begin-connect")).toThrow("Invalid Programscape connection transition");
  });

  it.each(["begin-connect", "begin-exchange", "begin-refresh", "begin-disconnect"] as const)("recovers after an interruption following %s", async (event) => {
    fakeKeyring.available = false;
    const env = home();
    if (event === "begin-exchange" || event === "begin-refresh") {
      await transitionConnection(env, "begin-connect");
    }
    if (event === "begin-refresh") {
      await transitionConnection(env, "begin-exchange");
      await transitionConnection(env, "connect-succeeded");
    }
    await transitionConnection(env, event, false);
    expect((await readConnectionState(env))?.phase).toBe(event === "begin-connect" ? "awaiting-consent" : "cleanup-needed");
    const result = await disconnect({ env, fetch: async () => { throw new Error("Unexpected network call"); } });
    expect(result.outcome).toBe(event === "begin-connect" ? "disconnected" : "remote-unverified");
    expect(await readConnectionState(env)).toBeUndefined();
    await transitionConnection(env, "begin-connect");
    expect((await readConnectionState(env))?.phase).toBe("awaiting-consent");
  });
});

describe("connection lock", () => {
  it("reclaims a dead pid's lock", async () => {
    const env = home();
    const dir = connectionLockPath(env);
    await withConnectionLock(env, async () => undefined); // creates its private parent directory
    writeFileSync(join(dir, "2147483647.dead.json"), JSON.stringify({ pid: 2_147_483_647, createdAt: Date.now(), nonce: "dead", ticket: 1 }));
    expect(await withConnectionLock(env, async () => "reclaimed")).toBe("reclaimed");
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it("never admits two contenders that encounter the same dead owner", async () => {
    const env = home();
    const dir = connectionLockPath(env);
    await withConnectionLock(env, async () => undefined);
    writeFileSync(join(dir, "2147483647.dead.json"), JSON.stringify({ pid: 2_147_483_647, createdAt: Date.now(), nonce: "dead", ticket: 1 }));
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let active = 0;
    let overlap = false;
    const work = () => withConnectionLock(env, async () => {
      active += 1;
      if (active > 1) overlap = true;
      await held;
      active -= 1;
    });
    const first = work().then(() => "entered", () => "blocked");
    const second = work().then(() => "entered", () => "blocked");
    await new Promise((resolve) => setTimeout(resolve, 600));
    release();
    expect((await Promise.all([first, second])).sort()).toEqual(["blocked", "entered"]);
    expect(overlap).toBe(false);
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it("does not steal an old choosing entry while its process is alive", async () => {
    const env = home();
    const dir = connectionLockPath(env);
    await withConnectionLock(env, async () => undefined);
    const path = join(dir, `${process.pid}.paused.json`);
    writeFileSync(path, JSON.stringify({ pid: process.pid, createdAt: Date.now() - 180_000, ownerStartedAt: Date.now() - process.uptime() * 1000, nonce: "paused" }));
    const old = new Date(Date.now() - 180_000);
    utimesSync(path, old, old);
    try {
      await expect(withConnectionLock(env, async () => undefined)).rejects.toThrow("Another Programscape connection change is running");
    } finally {
      rmSync(path, { force: true });
    }
  });

  it("reclaims an entry whose PID was reused by a different process", async () => {
    const env = home();
    const dir = connectionLockPath(env);
    await withConnectionLock(env, async () => undefined);
    // This PID is alive, but the saved start time predates this process, as after PID reuse.
    writeFileSync(join(dir, `${process.pid}.reused.json`), JSON.stringify({
      pid: process.pid,
      createdAt: Date.now() - 180_000,
      ownerStartedAt: Date.now() - process.uptime() * 1000 - 180_000,
      nonce: "reused",
      ticket: 1,
    }));
    expect(await withConnectionLock(env, async () => "reclaimed")).toBe("reclaimed");
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it.skipIf(process.platform === "win32")("removes a held lock on SIGINT in a child process", async () => {
    const env = home();
    const moduleUrl = pathToFileURL(join(fileURLToPath(new URL("..", import.meta.url)), "dist/programscape/store.js")).href;
    const script = `import { withConnectionLock } from ${JSON.stringify(moduleUrl)};\nawait withConnectionLock(process.env, async () => { console.log("LOCKED"); await new Promise(() => setInterval(() => {}, 1000)); });`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    try {
      await Promise.race([
        new Promise<void>((resolve, reject) => {
          child.stdout.on("data", (data: Buffer) => { if (data.toString().includes("LOCKED")) resolve(); });
          child.once("error", reject);
          child.once("exit", (code) => reject(new Error(`Lock holder exited before ready (${code}).`)));
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Lock holder did not start.")), 5_000)),
      ]);
      expect(readdirSync(connectionLockPath(env))).toHaveLength(1);
      child.kill("SIGINT");
      await Promise.race([once(child, "exit"), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Lock holder did not exit.")), 5_000))]);
      expect(readdirSync(connectionLockPath(env))).toHaveLength(0);
      expect(await withConnectionLock(env, async () => "next")).toBe("next");
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  });
});
