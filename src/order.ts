/**
 * The routing order. A pure, deterministic function of the founder's own facts:
 * which keys are set, the balances providers reported for those keys, the credits the
 * founder entered, and what happened earlier in this session. Nothing here judges quality.
 *
 * Default rule, "credits ending first":
 *   1. Providers whose credits carry an end date, soonest end date first.
 *   2. Providers whose credits have no known end date (or nothing is known about them).
 *   3. Pay-as-you-go: marked `paid: true`, or every known credit is spent or ended.
 *   Ties: the larger share remaining (remaining / plan or award, only where both are known)
 *   goes first, providers with a known share before those without; then provider id.
 *   Amounts in different units are never compared or added.
 */
import type { Balance, Capability, OrderRule, ProviderId } from "./types.js";

export type Tier = "credits-ending" | "credits-no-end-date" | "pay-as-you-go";

export interface ProviderStanding {
  id: ProviderId;
  /** True when the founder's key for this provider is set. */
  enabled: boolean;
  envVar: string;
  /** Why the provider was switched off for this session (for example, a 401). */
  disabled?: string;
  /** Set when the provider reported its credits spent during this session. */
  exhausted?: { since: string; until?: string; reason: string };
  paid?: boolean;
  balances: Balance[];
}

export interface OrderEntry {
  provider: ProviderId;
  position: number;
  tier: Tier;
  reason: string;
  endsOn?: string;
  shareRemaining?: number;
}

export interface SkippedEntry {
  provider: ProviderId;
  reason: string;
}

export interface CapabilityOrder {
  capability: Capability;
  rule: OrderRule;
  entries: OrderEntry[];
  skipped: SkippedEntry[];
}

interface Placement {
  tier: Tier;
  basis: string;
  endDay?: string;
  endsOn?: string;
  share?: number;
}

const TIER_RANK: Record<Tier, number> = { "credits-ending": 1, "credits-no-end-date": 2, "pay-as-you-go": 3 };

/** The instant credits stop being usable. A bare date means usable through the end of that UTC day. */
export function endInstant(endsOn: string): number {
  if (/^\d{4}-\d{2}-\d{2}$/.test(endsOn)) return Date.parse(`${endsOn}T00:00:00Z`) + 86_400_000;
  return Date.parse(endsOn);
}

/** The UTC calendar day credits end on, used to compare end dates. */
export function endDay(endsOn: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(endsOn)) return endsOn;
  return new Date(Date.parse(endsOn)).toISOString().slice(0, 10);
}

export function shareRemaining(balance: Balance): number | undefined {
  if (balance.remaining === undefined || balance.total === undefined || balance.total <= 0) return undefined;
  return Math.max(0, balance.remaining) / balance.total;
}

function isEnded(balance: Balance, now: Date): boolean {
  return balance.endsOn !== undefined && endInstant(balance.endsOn) <= now.getTime();
}

function isSpent(balance: Balance): boolean {
  return balance.remaining !== undefined && balance.remaining <= 0;
}

function pct(share: number): string {
  if (share > 0 && share < 0.01) return "under 1%";
  return `${Math.round(share * 100)}%`;
}

function describe(balance: Balance): string {
  const share = shareRemaining(balance);
  return `"${balance.label}"${share !== undefined ? ` (${pct(share)} remaining)` : ""}`;
}

/** Larger share first; a known share before an unknown one. Returns 0 when it cannot decide. */
function compareShare(a: number | undefined, b: number | undefined): number {
  if (a !== undefined && b !== undefined) return b - a;
  if (a !== undefined) return -1;
  if (b !== undefined) return 1;
  return 0;
}

/** Why a provider can't be used right now, or undefined when it can. */
export function unavailableReason(standing: ProviderStanding, now: Date): string | undefined {
  if (!standing.enabled) return `No key: set ${standing.envVar} to use it.`;
  if (standing.disabled) return standing.disabled;
  const exhausted = standing.exhausted;
  if (exhausted && (exhausted.until === undefined || endInstant(exhausted.until) > now.getTime())) {
    return exhausted.until
      ? `${exhausted.reason} Skipped until ${exhausted.until}.`
      : `${exhausted.reason} Skipped for the rest of this session.`;
  }
  return undefined;
}

/** Where a usable provider sits under the default rule, or why it is skipped. */
export function place(standing: ProviderStanding, now: Date): Placement | { skip: string } {
  if (standing.paid === true) {
    return { tier: "pay-as-you-go", basis: "Marked paid in your config, so it goes after every provider with credits." };
  }
  const credits = standing.balances.filter((balance) => balance.kind === "credits");
  const live = credits.filter((balance) => !isEnded(balance, now) && !isSpent(balance));

  const ending = live
    .filter((balance) => balance.endsOn !== undefined)
    .sort(
      (a, b) =>
        endInstant(a.endsOn as string) - endInstant(b.endsOn as string) || compareShare(shareRemaining(a), shareRemaining(b)),
    );
  const soonest = ending[0];
  if (soonest?.endsOn) {
    const day = endDay(soonest.endsOn);
    const share = shareRemaining(soonest);
    return {
      tier: "credits-ending",
      basis: `Credits ending first: ${describe(soonest)} ends ${day}.`,
      endDay: day,
      endsOn: soonest.endsOn,
      ...(share !== undefined ? { share } : {}),
    };
  }

  if (live.length > 0) {
    const best = [...live].sort((a, b) => compareShare(shareRemaining(a), shareRemaining(b)))[0] as Balance;
    const share = shareRemaining(best);
    return {
      tier: "credits-no-end-date",
      basis: `Credits with no known end date: ${describe(best)}.`,
      ...(share !== undefined ? { share } : {}),
    };
  }

  if (credits.length > 0) {
    const gone = credits.map((balance) => `"${balance.label}" ${isEnded(balance, now) ? "ended" : "spent"}`).join(", ");
    if (standing.paid === false) {
      return { skip: `No credits left in what is known (${gone}), and your config says paid: false.` };
    }
    return {
      tier: "pay-as-you-go",
      basis: `No credits left in what is known (${gone}); further use may be billed pay-as-you-go, so it goes last.`,
    };
  }

  return {
    tier: "credits-no-end-date",
    basis: "Nothing is known about its credits, so it counts as credits with no known end date.",
  };
}

function tieNote(prev: { id: ProviderId; placement: Placement }, cur: { placement: Placement }): string {
  const what =
    cur.placement.tier === "credits-ending"
      ? `on end date (${cur.placement.endDay})`
      : cur.placement.tier === "credits-no-end-date"
        ? "with no known end date"
        : "as pay-as-you-go";
  const a = prev.placement.share;
  const b = cur.placement.share;
  if (a !== undefined && b !== undefined && a !== b) {
    return ` Tied with ${prev.id} ${what}; ${prev.id} has the larger share remaining (${pct(a)} vs ${pct(b)}).`;
  }
  if (a !== undefined && b === undefined) {
    return ` Tied with ${prev.id} ${what}; ${prev.id}'s share remaining is known and this one's is not.`;
  }
  return ` Tied with ${prev.id} ${what}; ordered by provider id.`;
}

export function computeOrder(
  capability: Capability,
  standings: ProviderStanding[],
  explicitOrder: ProviderId[] | undefined,
  now: Date,
): CapabilityOrder {
  const skipped: SkippedEntry[] = [];
  const byId = new Map(standings.map((standing) => [standing.id, standing]));

  if (explicitOrder) {
    const entries: OrderEntry[] = [];
    for (const id of explicitOrder) {
      const standing = byId.get(id);
      if (!standing) {
        skipped.push({ provider: id, reason: `Listed in your order, but this router has no ${capability} for it.` });
        continue;
      }
      const unavailable = unavailableReason(standing, now);
      if (unavailable) {
        skipped.push({ provider: id, reason: unavailable });
        continue;
      }
      const placement = place(standing, now);
      if ("skip" in placement) {
        skipped.push({ provider: id, reason: placement.skip });
        continue;
      }
      entries.push({
        provider: id,
        position: entries.length + 1,
        tier: placement.tier,
        reason: `Position ${explicitOrder.indexOf(id) + 1} in your order for ${capability} (config order.${capability}).`,
        ...(placement.endsOn ? { endsOn: placement.endsOn } : {}),
        ...(placement.share !== undefined ? { shareRemaining: placement.share } : {}),
      });
    }
    for (const standing of standings) {
      if (!explicitOrder.includes(standing.id)) {
        skipped.push({
          provider: standing.id,
          reason: standing.enabled
            ? `Not in your order for ${capability} (config order.${capability}).`
            : `No key: set ${standing.envVar} to use it. Also not in your order for ${capability}.`,
        });
      }
    }
    return { capability, rule: "your-order", entries, skipped: sortSkipped(skipped) };
  }

  const placed: Array<{ id: ProviderId; placement: Placement }> = [];
  for (const standing of standings) {
    const unavailable = unavailableReason(standing, now);
    if (unavailable) {
      skipped.push({ provider: standing.id, reason: unavailable });
      continue;
    }
    const placement = place(standing, now);
    if ("skip" in placement) skipped.push({ provider: standing.id, reason: placement.skip });
    else placed.push({ id: standing.id, placement });
  }

  placed.sort((a, b) => {
    const tier = TIER_RANK[a.placement.tier] - TIER_RANK[b.placement.tier];
    if (tier !== 0) return tier;
    if (a.placement.endDay && b.placement.endDay && a.placement.endDay !== b.placement.endDay) {
      return a.placement.endDay < b.placement.endDay ? -1 : 1;
    }
    return compareShare(a.placement.share, b.placement.share) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });

  const entries = placed.map((item, index): OrderEntry => {
    const prev = placed[index - 1];
    const tied =
      prev !== undefined &&
      prev.placement.tier === item.placement.tier &&
      prev.placement.endDay === item.placement.endDay;
    return {
      provider: item.id,
      position: index + 1,
      tier: item.placement.tier,
      reason: item.placement.basis + (tied && prev ? tieNote(prev, item) : ""),
      ...(item.placement.endsOn ? { endsOn: item.placement.endsOn } : {}),
      ...(item.placement.share !== undefined ? { shareRemaining: item.placement.share } : {}),
    };
  });

  return { capability, rule: "credits-ending-first", entries, skipped: sortSkipped(skipped) };
}

function sortSkipped(skipped: SkippedEntry[]): SkippedEntry[] {
  return [...skipped].sort((a, b) => (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0));
}
