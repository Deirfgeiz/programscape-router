/**
 * Reading the founder's plan (the `my_plan` tool) and deciding which kept, approved program a provider's live
 * balance belongs to. The router never guesses: one match is used, several or none are reported, and the founder
 * settles it in config with `providers.<id>.programscapeProgram`.
 *
 * The shape read here is the expected contract for 0149 Phase C; anything about it that changes is aligned in this
 * file alone.
 */
import { ADAPTERS } from "../providers/index.js";
import type { Balance, ProviderId } from "../types.js";

export interface PlanProgram {
  id: string;
  providerId?: string;
  name?: string;
  approved: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const text = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);

/** Approval as the plan states it. Anything not plainly approved counts as not approved. */
function isApproved(entry: Record<string, unknown>): boolean {
  if (entry.approved === true) return true;
  for (const field of ["approval", "approvalState", "status", "progress"]) {
    const value = entry[field];
    if (value === "approved") return true;
    if (isRecord(value) && (value.state === "approved" || value.status === "approved")) return true;
  }
  return false;
}

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
    return [{ id, ...(providerId ? { providerId } : {}), ...(name ? { name } : {}), approved: isApproved(entry) }];
  });
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
  const waiting = fromProvider.length > 0 ? ` (${fromProvider.map((program) => program.id).join(", ")} is kept but not approved yet)` : "";
  return {
    kind: "unmapped",
    message: `Your plan has no kept, approved ${name} program${waiting}. Keep it on programscape.com once it's approved, or set ${CONFIG_HINT(provider)} in config.`,
  };
}

export const SYNC_UNITS = ["usd", "credits", "requests"] as const;
export type SyncUnit = (typeof SYNC_UNITS)[number];

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
    if (balance.source !== "provider" || balance.kind !== "credits") continue;
    if (balance.remaining === undefined || !Number.isFinite(balance.remaining) || !balance.asOf) continue;
    const unit = SYNC_UNITS.find((candidate) => candidate === balance.unit);
    if (!unit) continue;
    return { amount: balance.remaining, unit, asOf: balance.asOf, label: balance.label };
  }
  return undefined;
}
