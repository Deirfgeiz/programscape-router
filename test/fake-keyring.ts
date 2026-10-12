/**
 * An in-memory stand-in for @napi-rs/keyring. test/setup.ts mocks the real module with it for every test, so no
 * test ever reads or writes the OS keychain of the machine running it.
 */
export const fakeKeyring = {
  store: new Map<string, string>(),
  /** False: every call fails the way a machine with no keychain does. */
  available: true,
  /** The options each entry was created with. */
  entryOptions: [] as unknown[],
  /** Operations that fail, each with the native error text to throw (which tests fill with secrets). */
  failing: {} as Partial<Record<"get" | "set" | "delete", string>>,
  reset() {
    this.store.clear();
    this.available = true;
    this.entryOptions = [];
    this.failing = {};
  },
  put(service: string, account: string, secret: string) {
    this.store.set(`${service}\u0000${account}`, secret);
  },
  peek(service: string, account: string): string | undefined {
    return this.store.get(`${service}\u0000${account}`);
  },
};

function check(op: "get" | "set" | "delete"): void {
  if (!fakeKeyring.available) throw new Error("Platform secure storage failure: no Secret Service provider is running");
  const message = fakeKeyring.failing[op];
  if (message !== undefined) throw new Error(message);
}

export class AsyncEntry {
  private readonly id: string;
  constructor(service: string, account: string, options?: unknown) {
    this.id = `${service}\u0000${account}`;
    fakeKeyring.entryOptions.push(options);
  }
  async getPassword(): Promise<string | null> {
    check("get");
    return fakeKeyring.store.get(this.id) ?? null;
  }
  async setPassword(password: string): Promise<void> {
    check("set");
    fakeKeyring.store.set(this.id, password);
  }
  async deleteCredential(): Promise<boolean> {
    check("delete");
    return fakeKeyring.store.delete(this.id);
  }
}
