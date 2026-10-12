import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configCandidates } from "../src/config.js";
import { defaultLedgerPath } from "../src/ledger.js";
import { browserCommand } from "../src/programscape/connect.js";
import { clientPath, syncStatePath, tokenPath } from "../src/programscape/store.js";
import { configDir, stateDir, tokenDir } from "../src/paths.js";

const WIN = { APPDATA: join("C:", "Users", "dana", "AppData", "Roaming"), LOCALAPPDATA: join("C:", "Users", "dana", "AppData", "Local") };

describe("folders", () => {
  it("macOS and Linux: ~/.config for config and the token, ~/.local/state for state", () => {
    for (const platform of ["darwin", "linux"] as const) {
      expect(configDir({}, platform)).toBe(join(homedir(), ".config", "programscape-router"));
      expect(stateDir({}, platform)).toBe(join(homedir(), ".local", "state", "programscape-router"));
      expect(tokenDir({}, platform)).toBe(configDir({}, platform));
      expect(configCandidates({}, "/work", platform).at(-1)).toBe(join(homedir(), ".config", "programscape-router", "config.json"));
      expect(defaultLedgerPath({}, platform)).toBe(join(homedir(), ".local", "state", "programscape-router", "ledger.json"));
    }
  });

  it("Windows: %APPDATA% for config, %LOCALAPPDATA% for state and the Programscape token", () => {
    expect(configCandidates(WIN, "/work", "win32").at(-1)).toBe(join(WIN.APPDATA, "programscape-router", "config.json"));
    expect(defaultLedgerPath(WIN, "win32")).toBe(join(WIN.LOCALAPPDATA, "programscape-router", "ledger.json"));
    expect(tokenPath(WIN, "win32")).toBe(join(WIN.LOCALAPPDATA, "programscape-router", "programscape-token.json"));
    expect(clientPath(WIN, "win32")).toBe(join(WIN.LOCALAPPDATA, "programscape-router", "programscape-client.json"));
    expect(syncStatePath(WIN, "win32")).toBe(join(WIN.LOCALAPPDATA, "programscape-router", "programscape-sync.json"));
  });

  it("Windows without APPDATA or LOCALAPPDATA falls back to the profile's AppData folders", () => {
    expect(configDir({}, "win32")).toBe(join(homedir(), "AppData", "Roaming", "programscape-router"));
    expect(stateDir({}, "win32")).toBe(join(homedir(), "AppData", "Local", "programscape-router"));
  });

  it("XDG_CONFIG_HOME and XDG_STATE_HOME win on every platform", () => {
    const xdg = { ...WIN, XDG_CONFIG_HOME: join("x", "config"), XDG_STATE_HOME: join("x", "state") };
    for (const platform of ["darwin", "linux", "win32"] as const) {
      expect(configCandidates(xdg, "/work", platform).at(-1)).toBe(join("x", "config", "programscape-router", "config.json"));
      expect(defaultLedgerPath(xdg, platform)).toBe(join("x", "state", "programscape-router", "ledger.json"));
      expect(tokenPath(xdg, platform)).toBe(join("x", "config", "programscape-router", "programscape-token.json"));
      expect(syncStatePath(xdg, platform)).toBe(join("x", "state", "programscape-router", "programscape-sync.json"));
    }
  });
});

describe("opening the browser for connect", () => {
  // A sign-in URL carries several query parameters; a shell (cmd's `start`) would split it at the first `&`.
  const url = "https://programscape.com/oauth/authorize?response_type=code&client_id=abc&redirect_uri=http%3A%2F%2F127.0.0.1%3A53682%2Fcallback&state=x%26y&code_challenge=z";

  it("passes the whole URL as one argument, with no shell, on every platform", () => {
    expect(browserCommand(url, "win32")).toEqual(["rundll32", ["url.dll,FileProtocolHandler", url]]);
    expect(browserCommand(url, "darwin")).toEqual(["open", [url]]);
    expect(browserCommand(url, "linux")).toEqual(["xdg-open", [url]]);
  });
});
