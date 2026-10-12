import type { Capability, ProviderId } from "../types.js";
import { exa } from "./exa.js";
import { firecrawl } from "./firecrawl.js";
import type { ProviderAdapter } from "./http.js";
import { keenable } from "./keenable.js";
import { parallel } from "./parallel.js";
import { tavily } from "./tavily.js";

/** Every adapter, alphabetically by id. No provider is preferred by its place in this list. */
export const ADAPTERS: Record<ProviderId, ProviderAdapter> = { exa, firecrawl, keenable, parallel, tavily };

export function supports(adapter: ProviderAdapter, capability: Capability): boolean {
  return capability === "search" ? adapter.search !== undefined : adapter.scrape !== undefined;
}

export type { ProviderAdapter, CallContext, FetchLike, BalanceReading } from "./http.js";
export { ProviderCallError } from "./http.js";
