import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as api from "../src/index.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

describe("public API", () => {
  it("exports exactly the documented runtime values", () => {
    // Adding to this list is a minor release; removing from it is a major one.
    expect(Object.keys(api).sort()).toEqual(
      [
        "CAPABILITIES",
        "CHECK_MAX_RESULTS",
        "CHECK_QUERY",
        "CHECK_URL",
        "ConfigError",
        "PROVIDER_IDS",
        "ProgramscapeError",
        "RouterError",
        "VERSION",
        "createMcpServer",
        "createRouter",
        "formatCheck",
        "formatStatus",
        "loadConfig",
        "parseConfig",
        "resolveKeys",
        "runCheck",
        "runMcpServer",
      ].sort(),
    );
  });

  it("keeps VERSION equal to package.json", () => {
    expect(api.VERSION).toBe(pkg.version);
  });
});
