import { beforeEach, vi } from "vitest";
import { fakeKeyring } from "./fake-keyring.js";

// Never touch the real OS keychain from a test.
vi.mock("@napi-rs/keyring", () => import("./fake-keyring.js"));

beforeEach(() => fakeKeyring.reset());
