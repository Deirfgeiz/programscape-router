import type { CapabilityOrder } from "./order.js";
import type { ProgramscapeSyncStatus } from "./programscape/sync.js";
import type { RouterStatus } from "./router.js";
import type { Balance } from "./types.js";

const RULE_NAMES = { "credits-ending-first": "credits ending first", "your-order": "your order from config" } as const;

export function formatBalance(balance: Balance): string {
  const unit = balance.unit ? ` ${balance.unit}` : "";
  const parts: string[] = [];
  if (balance.remaining !== undefined && balance.total !== undefined) {
    parts.push(`${balance.remaining} of ${balance.total}${unit} remaining`);
  } else if (balance.remaining !== undefined) {
    parts.push(`${balance.remaining}${unit} remaining`);
  } else if (balance.total !== undefined) {
    parts.push(`${balance.total}${unit} in total, remaining unknown`);
  } else {
    parts.push("amount unknown");
  }
  if (balance.endsOn) parts.push(`ends ${balance.endsOn}`);
  parts.push(balance.source === "provider" ? `reported by the provider at ${balance.asOf ?? "an unknown time"}` : "from your config");
  return `"${balance.label}" (${balance.kind}): ${parts.join(", ")}`;
}

function formatOrder(order: CapabilityOrder): string[] {
  const lines = [`Order for ${order.capability} (rule: ${RULE_NAMES[order.rule]})`];
  if (order.entries.length === 0) lines.push("  (no provider available)");
  for (const entry of order.entries) lines.push(`  ${entry.position}. ${entry.provider}: ${entry.reason}`);
  if (order.skipped.length > 0) {
    lines.push("  Skipped:");
    for (const entry of order.skipped) lines.push(`  - ${entry.provider}: ${entry.reason}`);
  }
  return lines;
}

export function formatSync(sync: ProgramscapeSyncStatus): string[] {
  if (sync.sync === "off") {
    return [`Programscape sync: off${sync.note ? `. ${sync.note}` : " (run `programscape-router connect` to turn it on)"}`];
  }
  const when = sync.lastSyncedAt ? `last synced ${sync.lastSyncedAt}` : "not synced yet";
  const how = sync.mode === "auto" ? "automatic, at most every 6 hours per provider" : "manual: `programscape-router sync`";
  const lines = [`Programscape sync: on (${when}; ${how})`];
  for (const entry of sync.providers) lines.push(`  ${entry.provider}: ${entry.message} (${entry.attemptedAt})`);
  return lines;
}

/** The human-readable status report that `programscape-router status` prints. */
export function formatStatus(status: RouterStatus): string {
  const lines: string[] = [
    `programscape-router status at ${status.asOf}`,
    `Config: ${status.configPath ?? "none found (defaults apply)"}`,
    `Ledger: ${status.ledgerPath ? `${status.ledgerPath} (counts only)` : "off"}`,
    "",
    "Providers",
  ];
  for (const provider of status.providers) {
    const state = provider.enabled
      ? `key set (${provider.keyEnvVar}, from ${provider.keySource === "keychain" ? "the OS keychain" : "the environment"})`
      : `no key (set ${provider.keyEnvVar}, or run \`programscape-router keys set ${provider.id}\`)`;
    lines.push(`  ${provider.id}: ${state}; ${provider.capabilities.join(", ")}${provider.paid !== undefined ? `; paid: ${provider.paid}` : ""}`);
    if (provider.disabled) lines.push(`    disabled: ${provider.disabled}`);
    if (provider.exhausted) lines.push(`    credits spent: ${provider.exhausted.reason}${provider.exhausted.until ? ` Until ${provider.exhausted.until}.` : ""}`);
    for (const balance of provider.balances) lines.push(`    - ${formatBalance(balance)}`);
    if (provider.balanceNote) lines.push(`    ${provider.balanceNote}`);
  }
  if (status.keychainNote) lines.push(`  Keychain: ${status.keychainNote}`);
  lines.push("", ...formatOrder(status.order.search), "", ...formatOrder(status.order.scrape), "");
  lines.push(...formatSync(status.programscape), "");
  lines.push("Each balance is shown on its own, in its own unit. Balances are never added together.");
  return lines.join("\n");
}
