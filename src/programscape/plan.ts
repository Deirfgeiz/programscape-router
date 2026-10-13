/**
 * Reading the founder's plan (the `my_plan` tool) and deciding which kept, approved program a provider's live
 * balance belongs to. The router never guesses: one match is used, several or none are reported, and the founder
 * settles it in config with `providers.<id>.programscapeProgram`.
 *
 * `my_plan` (founder-ecosystem 0149 Phase C) lists kept programs as `{ id, name, provider: { id, ... }, ... }`, with
 * `approved: true` only when the founder marked the program approved; the key is absent otherwise. Since 0151
 * (ruling 5), an approved program may also carry the founder's own `expiresOn` (YYYY-MM-DD) and
 * `award: { amount, unit: "usd" }`, as they entered them. The router reads both only for an approved program, and
 * never works either out.
 */
import { ADAPTERS } from "../providers/index.js";
import { PROVIDER_IDS, type Balance, type ProviderId } from "../types.js";
import { type PlanDates, isPlanDay } from "./store.js";

export interface PlanProgram {
  id: string;
  providerId?: string;
  name?: string;
  approved: boolean;
  /** The founder's own expiration date, for an approved program. */
  expiresOn?: string;
  /** The award the founder entered, for an approved program. */
  award?: { amount: number; unit: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const text = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);


function providerIdOf(entry: Record<string, unknown>): string | undefined {
  if (isRecord(entry.provider)) return text(entry.provider.id);
  return text(entry.provider) ?? text(entry.providerId);
}

/** The kept programs on the plan `my_plan` returned. A plan with no kept program (or no plan) reads as an empty list. */
export function readPlanPrograms(output: unknown): PlanProgram[] {
  if (!isRecord(output) || !Array.isArray(output.kept)) return [];
  return output.kept.flatMap((entry): PlanProgram[] => {
    if (!isRecord(entry)) return [];
    const id = text(entry.id) ?? text(entry.programId);
    if (!id) return [];
    const providerId = providerIdOf(entry);
    const name = text(entry.name);
    const approved = entry.approved === true;
    const award = isRecord(entry.award) ? entry.award : undefined;
    const amount = award && typeof award.amount === "number" && Number.isFinite(award.amount) && award.amount >= 0 ? award.amount : undefined;
    const unit = award ? text(award.unit) : undefined;
    return [
      {
        id,
        ...(providerId ? { providerId } : {}),
        ...(name ? { name } : {}),
        approved,
        ...(approved && isPlanDay(entry.expiresOn) ? { expiresOn: entry.expiresOn } : {}),
        ...(approved && amount !== undefined && unit ? { award: { amount, unit } } : {}),
      },
    ];
  });
}

/**
 * Per provider, the founder's own dates for the one approved program it maps to (as for balances: one match, or the
 * config override). A provider whose program carries neither a date nor an award has no entry.
 */
export function planDatesByProvider(programs: PlanProgram[], overrides: Partial<Record<ProviderId, string | undefined>>): Partial<Record<ProviderId, PlanDates>> {
  const dates: Partial<Record<ProviderId, PlanDates>> = {};
  for (const provider of PROVIDER_IDS) {
    const mapping = mapProgram(provider, programs, overrides[provider]);
    if (mapping.kind !== "mapped") continue;
    const program = programs.find((entry) => entry.id === mapping.programId);
    if (!program || (!program.expiresOn && !program.award)) continue;
    dates[provider] = {
      programId: program.id,
      ...(program.name ? { name: program.name } : {}),
      ...(program.expiresOn ? { expiresOn: program.expiresOn } : {}),
      ...(program.award ? { award: program.award } : {}),
    };
  }
  return dates;
}

export type Mapping =
  | { kind: "mapped"; programId: string; via: "only-match" | "config" }
  | { kind: "unmapped"; message: string };

const CONFIG_HINT = (provider: ProviderId) => `providers.${provider}.programscapeProgram`;

/**
 * Which plan program this provider's balance goes to.
 * - With an override in config: that program, if it is a kept, approved program from this provider.
 * - Otherwise: the one kept, approved program from this provider, if there is exactly one.
 */
export function mapProgram(provider: ProviderId, programs: PlanProgram[], override?: string): Mapping {
  const name = ADAPTERS[provider].name;
  const fromProvider = programs.filter((program) => program.providerId === provider);
  const approved = fromProvider.filter((program) => program.approved);

  if (override) {
    const chosen = programs.find((program) => program.id === override);
    if (!chosen) {
      return { kind: "unmapped", message: `${CONFIG_HINT(provider)} is "${override}", which is not a kept program on your plan.` };
    }
    if (chosen.providerId !== provider) {
      return { kind: "unmapped", message: `${CONFIG_HINT(provider)} is "${override}", which is not a ${name} program.` };
    }
    if (!chosen.approved) {
      return { kind: "unmapped", message: `${CONFIG_HINT(provider)} is "${override}", which your plan doesn't show as approved yet.` };
    }
    return { kind: "mapped", programId: chosen.id, via: "config" };
  }

  if (approved.length === 1) return { kind: "mapped", programId: (approved[0] as PlanProgram).id, via: "only-match" };
  if (approved.length > 1) {
    return {
      kind: "unmapped",
      message:
        `Your plan has ${approved.length} kept, approved ${name} programs (${approved.map((program) => program.id).join(", ")}), ` +
        `so the router won't guess. Set ${CONFIG_HINT(provider)} in config to the one this balance belongs to.`,
    };
  }
  const waiting = fromProvider.map((program) => program.id).join(", ");
  return {
    kind: "unmapped",
    message: waiting
      ? `Your plan has no kept, approved ${name} program: ${waiting} ${fromProvider.length > 1 ? "are" : "is"} kept but not marked approved. ` +
        `Mark it approved on your plan at https://programscape.com/plans once ${name} says yes, or set ${CONFIG_HINT(provider)} in config.`
      : `Your plan has no kept, approved ${name} program. Keep the program this balance belongs to on your plan and mark it approved ` +
        `once ${name} says yes, or set ${CONFIG_HINT(provider)} in config.`,
  };
}

export const SYNC_UNITS = ["usd", "credits", "requests"] as const;
export type SyncUnit = (typeof SYNC_UNITS)[number];

/**
 * Why Programscape can't record this amount as it was reported, or undefined when it can: never negative, dollars to
 * the cent, credits and requests whole. The router reports as-is and never rounds, so such an amount is not sent.
 */
export function amountIssue(amount: number, unit: SyncUnit): string | undefined {
  if (!Number.isFinite(amount) || amount < 0) return "it is below zero";
  if (unit === "usd") return Math.abs(amount * 100 - Math.round(amount * 100)) < 1e-6 ? undefined : "it has fractions of a cent";
  return Number.isInteger(amount) ? undefined : `it is not a whole number of ${unit}`;
}

export interface LiveBalance {
  amount: number;
  unit: SyncUnit;
  asOf: string;
  label: string;
}

/**
 * The balance a provider reported live for the founder's own key, as it was reported. Credits entered in config are
 * never synced: Programscape already has what the founder entered.
 */
export function liveBalance(balances: readonly Balance[]): LiveBalance | undefined {
  for (const balance of balances) {
    if (balance.source !== "provider" || balance.kind !== "credits" || balance.informational) continue;
    if (balance.remaining === undefined || !Number.isFinite(balance.remaining) || !balance.asOf) continue;
    const unit = SYNC_UNITS.find((candidate) => candidate === balance.unit);
    if (!unit) continue;
    return { amount: balance.remaining, unit, asOf: balance.asOf, label: balance.label };
  }
  return undefined;
}
