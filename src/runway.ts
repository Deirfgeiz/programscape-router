/**
 * The runway estimate and the heads-up (0151). Pure functions of the founder's own readings, credits and dates, worked
 * out on this machine. An estimate is always labelled as one, and never becomes an end date.
 *
 * Runway, for one balance (one label and unit from one provider):
 *   - Only the readings since the balance last rose count: a top-up or a monthly reset starts a new window. A change
 *     in the plan size (total) starts one too.
 *   - It needs at least two readings in that window, at least 24 hours apart.
 *   - pace = what was used across the window / the days it spans. There is no estimate when the pace is zero or less.
 *   - daysLeft = floor(remaining / pace), from the latest reading.
 *   - When the provider reports the end of its billing period and the balance lasts past it, the estimate says so
 *     instead of a number of days, and there is no heads-up for it.
 *
 * Heads-up, per provider: when an estimate is under the threshold (config headsUp.days, 30 by default), or when an end
 * date the founder gave (in config, or on their Programscape plan) is within it. A provider's own billing-period end
 * is not one of those dates: a monthly allowance comes back.
 */
import { endInstant, formatEnd } from "./order.js";
import type { Reading } from "./readings.js";
import type { Balance, ProviderId } from "./types.js";

const DAY_MS = 86_400_000;
/** The default heads-up threshold, in days (0151 ruling 3). */
export const DEFAULT_HEADS_UP_DAYS = 30;
/** Readings must span at least this long before there is a pace. */
export const MIN_SPAN_MS = DAY_MS;

/** How long one balance lasts at the recent pace. An estimate, worked out locally from readings.json. */
export interface RunwayEstimate {
  /** The balance it is for, as the provider labelled it. */
  label: string;
  unit: string;
  /** Whole days the balance lasts at the recent pace. */
  daysLeft: number;
  /** Set when the balance lasts past the end of the provider's billing period, which this is. */
  lastsPastPeriodEnd?: string;
  /** What was used per day across the window, in `unit`. */
  perDay: number;
  /** The first and latest readings the pace comes from. */
  since: string;
  asOf: string;
  /** For example "About 3 weeks left on Firecrawl at your recent pace (estimate)". */
  words: string;
}

/** "About N days" under 14 days, "About N weeks" under 60, otherwise "About N months". */
export function runwayWords(daysLeft: number): string {
  if (daysLeft < 1) return "Less than a day";
  if (daysLeft < 14) return `About ${daysLeft} day${daysLeft === 1 ? "" : "s"}`;
  if (daysLeft < 60) return `About ${Math.round(daysLeft / 7)} weeks`;
  return `About ${Math.round(daysLeft / 30)} months`;
}

/** The readings since the balance last rose (or its total changed), oldest first. `readings` are one balance's. */
export function currentWindow(readings: readonly Reading[]): Reading[] {
  const sorted = [...readings].sort((a, b) => Date.parse(a.asOf) - Date.parse(b.asOf));
  let start = 0;
  for (let index = 1; index < sorted.length; index += 1) {
    const before = sorted[index - 1] as Reading;
    const after = sorted[index] as Reading;
    if (after.remaining > before.remaining || after.total !== before.total) start = index;
  }
  return sorted.slice(start);
}

/**
 * The runway for one balance, from that balance's readings (one provider, label and unit). `periodEnd` is the end of
 * the provider's billing period when it reports one. Undefined when there is no pace yet.
 */
export function estimateRunway(readings: readonly Reading[], providerName: string, periodEnd?: string): RunwayEstimate | undefined {
  const window = currentWindow(readings);
  const first = window[0];
  const last = window.at(-1);
  if (!first || !last || first === last) return undefined;
  const span = Date.parse(last.asOf) - Date.parse(first.asOf);
  if (span < MIN_SPAN_MS) return undefined;
  const perDay = (first.remaining - last.remaining) / (span / DAY_MS);
  if (!(perDay > 0)) return undefined;
  const remaining = Math.max(0, last.remaining);
  const exact = remaining / perDay;
  const daysLeft = Math.floor(exact);
  const base = { label: last.label, unit: last.unit, daysLeft, perDay, since: first.asOf, asOf: last.asOf };
  if (periodEnd && !Number.isNaN(endInstant(periodEnd)) && Date.parse(last.asOf) + exact * DAY_MS > endInstant(periodEnd)) {
    return {
      ...base,
      lastsPastPeriodEnd: periodEnd,
      words: `Lasts past this period on ${providerName} (it ends ${formatEnd(periodEnd)}) at your recent pace (estimate)`,
    };
  }
  return { ...base, words: `${runwayWords(daysLeft)} left on ${providerName} at your recent pace (estimate)` };
}

/** One estimate per live balance the provider reports now, from the readings of that same label and unit. */
export function runwaysFor(providerName: string, provider: ProviderId, balances: readonly Balance[], readings: readonly Reading[]): RunwayEstimate[] {
  return balances.flatMap((balance): RunwayEstimate[] => {
    if (balance.source !== "provider" || balance.kind !== "credits" || balance.informational || !balance.unit) return [];
    const mine = readings.filter((reading) => reading.provider === provider && reading.label === balance.label && reading.unit === balance.unit);
    const estimate = estimateRunway(mine, providerName, balance.endsOn);
    return estimate ? [estimate] : [];
  });
}

/** An end date the founder gave: in config, or on their Programscape plan. */
export interface FoundersEndDate {
  label: string;
  endsOn: string;
  from: "config" | "plan";
}

/** The founder's own end dates among `balances` (never a provider's billing period). */
export function foundersEndDates(balances: readonly Balance[]): FoundersEndDate[] {
  return balances.flatMap((balance): FoundersEndDate[] =>
    (balance.source === "config" || balance.source === "plan") && balance.kind === "credits" && balance.endsOn
      ? [{ label: balance.label, endsOn: balance.endsOn, from: balance.source }]
      : [],
  );
}

/** Why a provider gets a heads-up: its estimates and dates under the threshold, in words. */
export interface HeadsUpReason {
  provider: ProviderId;
  /** Each reason on its own, for example "About 3 weeks left on Firecrawl at your recent pace (estimate)". */
  reasons: string[];
}

/** The heads-up for one provider, or undefined when nothing is under `thresholdDays`. */
export function headsUpFor(
  provider: ProviderId,
  runways: readonly RunwayEstimate[],
  endDates: readonly FoundersEndDate[],
  thresholdDays: number,
  now: Date,
): HeadsUpReason | undefined {
  const reasons: string[] = [];
  for (const runway of runways) {
    if (runway.lastsPastPeriodEnd === undefined && runway.daysLeft < thresholdDays) reasons.push(runway.words);
  }
  const limit = now.getTime() + thresholdDays * DAY_MS;
  for (const date of endDates) {
    const end = endInstant(date.endsOn);
    if (Number.isNaN(end) || end <= now.getTime() || end > limit) continue;
    const whose = date.from === "plan" ? "your date, from your Programscape plan" : "your date, from config";
    reasons.push(`"${date.label}" ends ${formatEnd(date.endsOn)} (${whose})`);
  }
  return reasons.length > 0 ? { provider, reasons } : undefined;
}
