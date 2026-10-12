import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  READINGS_PER_PROVIDER,
  type Reading,
  Readings,
  addReadings,
  readingsFrom,
  sanitizeReadings,
} from "../src/readings.js";
import { currentWindow, estimateRunway, foundersEndDates, headsUpFor, runwayWords, runwaysFor } from "../src/runway.js";
import type { Balance } from "../src/types.js";

const T0 = Date.parse("2026-10-01T00:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function reading(hours: number, remaining: number, extra: Partial<Reading> = {}): Reading {
  return { provider: "firecrawl", label: "Firecrawl credits, current billing period", unit: "credits", remaining, asOf: new Date(T0 + hours * HOUR).toISOString(), ...extra };
}

describe("runway words", () => {
  it("says days under 14, weeks under 60, months beyond, and less than a day at 0", () => {
    expect(runwayWords(0)).toBe("Less than a day");
    expect(runwayWords(1)).toBe("About 1 day");
    expect(runwayWords(13)).toBe("About 13 days");
    expect(runwayWords(14)).toBe("About 2 weeks");
    expect(runwayWords(21)).toBe("About 3 weeks");
    expect(runwayWords(59)).toBe("About 8 weeks");
    expect(runwayWords(60)).toBe("About 2 months");
    expect(runwayWords(100)).toBe("About 3 months");
  });
});

describe("runway estimate", () => {
  it("works out the pace across the window and floors the days left", () => {
    // 3000 used over 2 days: 1500 a day; 32000 left is 21.3 days.
    const estimate = estimateRunway([reading(0, 35000), reading(24, 33500), reading(48, 32000)], "Firecrawl");
    expect(estimate).toMatchObject({ daysLeft: 21, perDay: 1500, since: reading(0, 0).asOf, asOf: reading(48, 0).asOf });
    expect(estimate?.words).toBe("About 3 weeks left on Firecrawl at your recent pace (estimate)");
  });

  it("needs two readings at least 24 hours apart", () => {
    expect(estimateRunway([], "Firecrawl")).toBeUndefined();
    expect(estimateRunway([reading(0, 100)], "Firecrawl")).toBeUndefined();
    expect(estimateRunway([reading(0, 100), reading(23.9, 50)], "Firecrawl")).toBeUndefined();
    expect(estimateRunway([reading(0, 100), reading(24, 50)], "Firecrawl")?.daysLeft).toBe(1);
  });

  it("gives no estimate when nothing was used, or the balance grew", () => {
    expect(estimateRunway([reading(0, 100), reading(48, 100)], "Firecrawl")).toBeUndefined();
  });

  it("starts a new window at a top-up or reset, and at a change of plan size", () => {
    const readings = [reading(0, 1000), reading(48, 200), reading(50, 5000), reading(60, 4900), reading(98, 4800)];
    expect(currentWindow(readings).map((entry) => entry.remaining)).toEqual([5000, 4900, 4800]);
    // 200 used over 2 days since the reset: 100 a day, 48 days left.
    expect(estimateRunway(readings, "Firecrawl")?.daysLeft).toBe(48);
    // Too soon after a reset: no estimate, even with older readings.
    expect(estimateRunway(readings.slice(0, 4), "Firecrawl")).toBeUndefined();
    const plan = [reading(0, 1000, { total: 1000 }), reading(48, 900, { total: 1000 }), reading(50, 880, { total: 5000 }), reading(60, 870, { total: 5000 })];
    expect(currentWindow(plan)).toHaveLength(2);
  });

  it("says it lasts past this period when the provider's period ends first, and gives no heads-up for it", () => {
    const readings = [reading(0, 1000), reading(48, 900)]; // 50 a day: 18 days left
    const lasts = estimateRunway(readings, "Firecrawl", "2026-10-10T00:00:00.000Z");
    expect(lasts).toMatchObject({ daysLeft: 18, lastsPastPeriodEnd: "2026-10-10T00:00:00.000Z" });
    expect(lasts?.words).toBe("Lasts past this period on Firecrawl (it ends 2026-10-10 00:00:00 UTC) at your recent pace (estimate)");
    expect(headsUpFor("firecrawl", [lasts!], [], 30, new Date(T0 + 48 * HOUR))).toBeUndefined();
    // When it runs out before the period ends, the days left stand.
    const short = estimateRunway(readings, "Firecrawl", "2026-12-31");
    expect(short?.lastsPastPeriodEnd).toBeUndefined();
    expect(short?.words).toBe("About 3 weeks left on Firecrawl at your recent pace (estimate)");
  });

  it("matches each live balance to the readings of its own label and unit", () => {
    const balances: Balance[] = [
      { label: "Tavily plan credits", kind: "credits", unit: "credits", remaining: 400, source: "provider", asOf: reading(48, 0).asOf },
      { label: "Tavily pay-as-you-go limit", kind: "pay-as-you-go", unit: "credits", remaining: 10, source: "provider" },
      { label: "Exa grant", kind: "credits", unit: "usd", remaining: 5, source: "config" },
    ];
    const readings = [
      reading(0, 600, { provider: "tavily", label: "Tavily plan credits" }),
      reading(48, 400, { provider: "tavily", label: "Tavily plan credits" }),
      reading(0, 99999, { provider: "tavily", label: "Tavily plan credits", unit: "requests" }),
      reading(48, 1, { provider: "tavily", label: "Tavily plan credits", unit: "requests" }),
      reading(0, 600, { provider: "firecrawl", label: "Tavily plan credits" }),
    ];
    const runways = runwaysFor("Tavily", "tavily", balances, readings);
    expect(runways).toHaveLength(1);
    expect(runways[0]).toMatchObject({ label: "Tavily plan credits", unit: "credits", daysLeft: 4, perDay: 100 });
  });
});

describe("heads-up", () => {
  const now = new Date(T0);
  const estimate = (daysLeft: number) => ({ label: "x", unit: "credits", daysLeft, perDay: 1, since: "", asOf: "", words: `${runwayWords(daysLeft)} left on Firecrawl at your recent pace (estimate)` });

  it("fires under the threshold, not at or over it", () => {
    expect(headsUpFor("firecrawl", [estimate(29)], [], 30, now)?.reasons).toEqual(["About 4 weeks left on Firecrawl at your recent pace (estimate)"]);
    expect(headsUpFor("firecrawl", [estimate(30)], [], 30, now)).toBeUndefined();
    expect(headsUpFor("firecrawl", [estimate(45)], [], 60, now)).toBeDefined();
    expect(headsUpFor("firecrawl", [estimate(0)], [], 0, now)).toBeUndefined();
  });

  it("fires for an end date the founder gave within the threshold, never one that has passed or is further out", () => {
    const balances: Balance[] = [
      { label: "Exa startup grant", kind: "credits", endsOn: "2026-10-20", source: "config" },
      { label: "Exa grant (on your Programscape plan)", kind: "credits", endsOn: "2026-10-25", source: "plan" },
      { label: "Ended", kind: "credits", endsOn: "2026-09-01", source: "config" },
      { label: "Far", kind: "credits", endsOn: "2027-06-01", source: "config" },
      { label: "Provider period", kind: "credits", endsOn: "2026-10-05T00:00:00Z", source: "provider" },
    ];
    expect(foundersEndDates(balances).map((date) => date.label)).toEqual(["Exa startup grant", "Exa grant (on your Programscape plan)", "Ended", "Far"]);
    expect(headsUpFor("exa", [], foundersEndDates(balances), 30, now)?.reasons).toEqual([
      '"Exa startup grant" ends 2026-10-20 (your date, from config)',
      '"Exa grant (on your Programscape plan)" ends 2026-10-25 (your date, from your Programscape plan)',
    ]);
    expect(headsUpFor("exa", [], foundersEndDates(balances), 10, now)).toBeUndefined();
  });
});

describe("readings file", () => {
  const live: Balance = {
    label: "Firecrawl credits, current billing period",
    kind: "credits",
    unit: "credits",
    remaining: 500,
    total: 1000,
    endsOn: "2026-10-31T23:59:59Z",
    source: "provider",
    asOf: "2026-10-01T00:00:00.000Z",
  };

  it("keeps only live credits with a unit, an amount and a time, and only those six fields", () => {
    expect(
      readingsFrom("firecrawl", [
        live,
        { ...live, source: "config" },
        { ...live, kind: "pay-as-you-go" },
        { ...live, unit: undefined },
        { ...live, remaining: undefined },
        { ...live, asOf: undefined },
      ] as Balance[]),
    ).toEqual([{ provider: "firecrawl", label: live.label, unit: "credits", remaining: 500, total: 1000, asOf: live.asOf }]);
  });

  it("drops anything that isn't a reading, and readings older than 90 days", () => {
    const now = new Date("2026-10-01T00:00:00Z");
    const clean = sanitizeReadings(
      {
        version: 1,
        query: "zebra",
        readings: [
          { ...reading(0, 5), key: "fc-SECRET", url: "https://zebra.example" },
          { ...reading(0, 5), provider: "evil" },
          { ...reading(0, 5), remaining: "5" },
          { ...reading(0, 5), asOf: "2026-06-01T00:00:00Z" },
        ],
      },
      now,
    );
    expect(clean.readings).toEqual([reading(0, 5)]);
    expect(JSON.stringify(clean)).not.toContain("zebra");
    expect(JSON.stringify(clean)).not.toContain("SECRET");
  });

  it("thins readings taken within an hour to the latest, keeping a rise", () => {
    let file = sanitizeReadings(undefined, new Date(T0));
    for (const [minutes, remaining] of [[0, 100], [5, 99], [10, 98], [15, 97], [70, 90], [75, 89]] as const) {
      file = addReadings(file, [reading(minutes / 60, remaining)], new Date(T0 + minutes * 60_000));
    }
    // 0 (first), 15 (the latest before the hour passed), 70 and 75 (the newest).
    expect(file.readings.map((entry) => entry.remaining)).toEqual([100, 97, 90, 89]);
    // A rise is never thinned away, so the new window still starts at it.
    file = addReadings(file, [reading(80 / 60, 5000)], new Date(T0 + 80 * 60_000));
    file = addReadings(file, [reading(85 / 60, 4990)], new Date(T0 + 85 * 60_000));
    expect(file.readings.map((entry) => entry.remaining)).toEqual([100, 97, 90, 89, 5000, 4990]);
    // The same reading twice is kept once.
    expect(addReadings(file, [reading(85 / 60, 4990)], new Date(T0 + 85 * 60_000))).toBe(file);
  });

  it("caps each provider at the newest readings and drops those over 90 days old", () => {
    let file = sanitizeReadings(undefined, new Date(T0));
    const many = Array.from({ length: READINGS_PER_PROVIDER + 20 }, (_, index) => reading(index * 2, 100000 - index));
    const now = new Date(T0 + many.length * 2 * HOUR);
    file = addReadings(file, many, now);
    file = addReadings(file, [reading(0, 7, { provider: "tavily", label: "Tavily plan credits" })], now);
    const firecrawl = file.readings.filter((entry) => entry.provider === "firecrawl");
    expect(firecrawl).toHaveLength(READINGS_PER_PROVIDER);
    expect(firecrawl[0]?.remaining).toBe(100000 - 20);
    expect(file.readings.filter((entry) => entry.provider === "tavily")).toHaveLength(1);
    const later = addReadings(file, [reading(91 * 24, 1, { provider: "linkup", label: "Linkup" })], new Date(T0 + 91 * DAY));
    expect(later.readings.some((entry) => entry.provider === "tavily")).toBe(false);
  });

  it("writes readings.json atomically, beside nothing else, with only the reading fields", async () => {
    const dir = mkdtempSync(join(tmpdir(), "psr-readings-"));
    const path = join(dir, "readings.json");
    const store = new Readings(path);
    await store.record("firecrawl", [live], new Date("2026-10-01T00:00:00Z"));
    await store.record("firecrawl", [{ ...live, remaining: 400, asOf: "2026-10-02T00:00:00.000Z" }], new Date("2026-10-02T00:00:00Z"));
    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(written.readings).toEqual([
      { provider: "firecrawl", label: live.label, unit: "credits", remaining: 500, total: 1000, asOf: "2026-10-01T00:00:00.000Z" },
      { provider: "firecrawl", label: live.label, unit: "credits", remaining: 400, total: 1000, asOf: "2026-10-02T00:00:00.000Z" },
    ]);
    expect(Object.keys(written).sort()).toEqual(["about", "readings", "version"]);
    expect((await store.read(new Date("2026-10-02T00:00:00Z"))).readings).toHaveLength(2);
  });

  it("never throws when the file can't be written, and says so once", async () => {
    const logs: string[] = [];
    const store = new Readings(join(mkdtempSync(join(tmpdir(), "psr-readings-")), "readings.json", "nested-under-a-file"), (message) => logs.push(message));
    // The parent "readings.json" doesn't exist as a folder, and can't be made into one once it is a file.
    const blocker = new Readings(join(store.path, ".."));
    await blocker.record("firecrawl", [live]);
    await store.record("firecrawl", [live]);
    await store.record("firecrawl", [{ ...live, asOf: "2026-10-02T00:00:00.000Z" }]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("could not write balance readings");
  });
});
