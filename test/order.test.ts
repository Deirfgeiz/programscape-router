import { describe, expect, it } from "vitest";
import { type ProviderStanding, computeOrder } from "../src/order.js";
import type { Balance, ProviderId } from "../src/types.js";

const NOW = new Date("2026-10-11T12:00:00Z");

function standing(id: ProviderId, overrides: Partial<ProviderStanding> = {}): ProviderStanding {
  return { id, enabled: true, envVar: `${id.toUpperCase()}_API_KEY`, balances: [], ...overrides };
}

function credit(fields: Partial<Balance>): Balance {
  return { label: "credits", kind: "credits", source: "config", ...fields };
}

const ids = (order: ReturnType<typeof computeOrder>) => order.entries.map((entry) => entry.provider);

describe("credits ending first", () => {
  it("puts credits with an end date first, soonest first, then no end date, then pay-as-you-go", () => {
    const order = computeOrder(
      "search",
      [
        standing("exa", { balances: [credit({ label: "Exa grant", endsOn: "2027-03-01" })] }),
        standing("firecrawl", {
          balances: [credit({ label: "Firecrawl period", endsOn: "2026-10-31T23:59:59Z", source: "provider" })],
        }),
        standing("keenable", { balances: [credit({ label: "Keenable monthly", remaining: 100 })] }),
        standing("parallel", { paid: true }),
        standing("tavily"),
      ],
      undefined,
      NOW,
    );
    expect(order.rule).toBe("credits-ending-first");
    expect(ids(order)).toEqual(["firecrawl", "exa", "keenable", "tavily", "parallel"]);
    expect(order.entries.map((entry) => entry.tier)).toEqual([
      "credits-ending",
      "credits-ending",
      "credits-no-end-date",
      "credits-no-end-date",
      "pay-as-you-go",
    ]);
    expect(order.entries[0]?.reason).toBe('Credits ending first: "Firecrawl period" ends 2026-10-31.');
    expect(order.entries[3]?.reason).toContain("Nothing is known about its credits");
    expect(order.entries[4]?.reason).toContain("Marked paid in your config");
    expect(order.entries.map((entry) => entry.position)).toEqual([1, 2, 3, 4, 5]);
  });

  it("uses a provider's soonest live credit and ignores ended or spent ones", () => {
    const order = computeOrder(
      "search",
      [
        standing("exa", {
          balances: [
            credit({ label: "ended", endsOn: "2026-10-01" }),
            credit({ label: "spent", endsOn: "2026-10-12", remaining: 0 }),
            credit({ label: "live", endsOn: "2026-12-01" }),
          ],
        }),
        standing("tavily", { balances: [credit({ label: "t", endsOn: "2026-11-01" })] }),
      ],
      undefined,
      NOW,
    );
    expect(ids(order)).toEqual(["tavily", "exa"]);
    expect(order.entries[1]?.reason).toContain('"live" ends 2026-12-01');
  });

  it("counts a bare date as usable through the end of that UTC day", () => {
    const today = computeOrder("search", [standing("exa", { balances: [credit({ endsOn: "2026-10-11" })] })], undefined, NOW);
    expect(today.entries[0]?.tier).toBe("credits-ending");
    const yesterday = computeOrder("search", [standing("exa", { balances: [credit({ endsOn: "2026-10-10" })] })], undefined, NOW);
    expect(yesterday.entries[0]?.tier).toBe("pay-as-you-go");
  });

  it("moves a provider whose known credits are all spent or ended to pay-as-you-go", () => {
    const order = computeOrder(
      "search",
      [standing("exa", { balances: [credit({ label: "grant", remaining: 0 })] }), standing("tavily")],
      undefined,
      NOW,
    );
    expect(ids(order)).toEqual(["tavily", "exa"]);
    expect(order.entries[1]?.tier).toBe("pay-as-you-go");
    expect(order.entries[1]?.reason).toContain('"grant" spent');
  });

  it("skips a provider with no credits left when the founder says paid: false", () => {
    const order = computeOrder(
      "search",
      [standing("parallel", { paid: false, balances: [credit({ label: "signup", remaining: 0 })] }), standing("tavily")],
      undefined,
      NOW,
    );
    expect(ids(order)).toEqual(["tavily"]);
    expect(order.skipped).toEqual([{ provider: "parallel", reason: expect.stringContaining("paid: false") }]);
  });

  it("keeps paid: false providers with credits or unknown balances in their tier", () => {
    const order = computeOrder("search", [standing("parallel", { paid: false })], undefined, NOW);
    expect(order.entries[0]?.tier).toBe("credits-no-end-date");
  });

  it("treats a pay-as-you-go balance as no credits", () => {
    const order = computeOrder(
      "search",
      [standing("tavily", { balances: [credit({ kind: "pay-as-you-go", remaining: 50, total: 100 })] }), standing("exa")],
      undefined,
      NOW,
    );
    expect(ids(order)).toEqual(["exa", "tavily"]);
  });
});

describe("ties", () => {
  it("breaks a same-day end date by the larger share remaining", () => {
    const order = computeOrder(
      "search",
      [
        standing("exa", { balances: [credit({ endsOn: "2026-11-01", remaining: 100, total: 1000, unit: "usd" })] }),
        standing("tavily", { balances: [credit({ endsOn: "2026-11-01T08:00:00Z", remaining: 900, total: 1000, unit: "credits" })] }),
      ],
      undefined,
      NOW,
    );
    expect(ids(order)).toEqual(["tavily", "exa"]);
    expect(order.entries[1]?.reason).toContain("Tied with tavily on end date (2026-11-01); tavily has the larger share remaining (90% vs 10%).");
  });

  it("compares shares, never raw amounts in different units", () => {
    // exa holds the larger raw number but the smaller share of its own award.
    const order = computeOrder(
      "search",
      [
        standing("exa", { balances: [credit({ remaining: 5000, total: 100000, unit: "credits" })] }),
        standing("firecrawl", { balances: [credit({ remaining: 40, total: 50, unit: "usd" })] }),
      ],
      undefined,
      NOW,
    );
    expect(ids(order)).toEqual(["firecrawl", "exa"]);
  });

  it("puts a known share before an unknown one", () => {
    const order = computeOrder(
      "search",
      [
        standing("exa", { balances: [credit({ remaining: 10 })] }),
        standing("tavily", { balances: [credit({ remaining: 1, total: 100 })] }),
      ],
      undefined,
      NOW,
    );
    expect(ids(order)).toEqual(["tavily", "exa"]);
    expect(order.entries[1]?.reason).toContain("tavily's share remaining is known and this one's is not");
  });

  it("falls back to provider id, and the order does not depend on input order", () => {
    const forward = computeOrder("search", [standing("tavily"), standing("exa"), standing("keenable")], undefined, NOW);
    const backward = computeOrder("search", [standing("keenable"), standing("exa"), standing("tavily")], undefined, NOW);
    expect(ids(forward)).toEqual(["exa", "keenable", "tavily"]);
    expect(ids(backward)).toEqual(ids(forward));
    expect(forward.entries[1]?.reason).toContain("Tied with exa with no known end date; ordered by provider id.");
  });

  it("uses provider id when shares are equal", () => {
    const order = computeOrder(
      "search",
      [
        standing("tavily", { balances: [credit({ remaining: 5, total: 10 })] }),
        standing("exa", { balances: [credit({ remaining: 50, total: 100 })] }),
      ],
      undefined,
      NOW,
    );
    expect(ids(order)).toEqual(["exa", "tavily"]);
    expect(order.entries[1]?.reason).toContain("ordered by provider id");
  });

  it("orders pay-as-you-go providers by id", () => {
    const order = computeOrder("search", [standing("tavily", { paid: true }), standing("exa", { paid: true })], undefined, NOW);
    expect(ids(order)).toEqual(["exa", "tavily"]);
    expect(order.entries[1]?.reason).toContain("Tied with exa as pay-as-you-go");
  });
});

describe("availability", () => {
  it("skips providers without a key, disabled this session, or reported spent", () => {
    const order = computeOrder(
      "scrape",
      [
        standing("exa", { enabled: false }),
        standing("firecrawl", { disabled: "Firecrawl refused the key." }),
        standing("keenable", { exhausted: { since: "2026-10-11T11:00:00Z", reason: "Keenable reported its credits spent." } }),
        standing("tavily", {
          exhausted: { since: "2026-10-01T00:00:00Z", until: "2026-10-10T23:59:59Z", reason: "Tavily reported its credits spent." },
        }),
      ],
      undefined,
      NOW,
    );
    expect(ids(order)).toEqual(["tavily"]);
    expect(order.skipped).toEqual([
      { provider: "exa", reason: "No key: set EXA_API_KEY to use it." },
      { provider: "firecrawl", reason: "Firecrawl refused the key." },
      { provider: "keenable", reason: "Keenable reported its credits spent. Skipped for the rest of this session." },
    ]);
  });

  it("keeps skipping a spent provider until its period ends", () => {
    const order = computeOrder(
      "search",
      [standing("firecrawl", { exhausted: { since: "x", until: "2026-10-31T23:59:59Z", reason: "Spent." } })],
      undefined,
      NOW,
    );
    expect(order.entries).toEqual([]);
    expect(order.skipped[0]?.reason).toBe("Spent. Skipped until 2026-10-31T23:59:59Z.");
  });
});

describe("your order", () => {
  it("uses the founder's order exactly and leaves unlisted providers out", () => {
    const order = computeOrder(
      "search",
      [
        standing("exa", { balances: [credit({ endsOn: "2026-10-20" })] }),
        standing("firecrawl"),
        standing("tavily", { paid: true }),
        standing("keenable", { enabled: false }),
      ],
      ["tavily", "keenable", "exa"],
      NOW,
    );
    expect(order.rule).toBe("your-order");
    expect(ids(order)).toEqual(["tavily", "exa"]);
    expect(order.entries[0]?.reason).toBe("Position 1 in your order for search (config order.search).");
    expect(order.entries[1]?.reason).toBe("Position 3 in your order for search (config order.search).");
    expect(order.entries[1]?.position).toBe(2);
    expect(order.skipped).toEqual([
      { provider: "firecrawl", reason: "Not in your order for search (config order.search)." },
      { provider: "keenable", reason: "No key: set KEENABLE_API_KEY to use it." },
    ]);
  });

  it("still skips spent providers in the founder's order", () => {
    const order = computeOrder(
      "search",
      [standing("exa", { exhausted: { since: "x", reason: "Exa reported its credits spent." } }), standing("tavily")],
      ["exa", "tavily"],
      NOW,
    );
    expect(ids(order)).toEqual(["tavily"]);
  });
});
