import type { Capability, ProviderId } from "../types.js";
import { brightdata } from "./brightdata.js";
import { exa } from "./exa.js";
import { firecrawl } from "./firecrawl.js";
import type { ProviderAdapter } from "./http.js";
import { keenable } from "./keenable.js";
import { linkup } from "./linkup.js";
import { parallel } from "./parallel.js";
import { tavily } from "./tavily.js";
import { youcom } from "./youcom.js";

/** Every adapter, alphabetically by id. No provider is preferred by its place in this list. */
export const ADAPTERS: Record<ProviderId, ProviderAdapter> = { brightdata, exa, firecrawl, keenable, linkup, parallel, tavily, youcom };

export function supports(adapter: ProviderAdapter, capability: Capability): boolean {
  return capability === "search" ? adapter.search !== undefined : adapter.scrape !== undefined;
}

export type { ProviderAdapter, CallContext, FetchLike, BalanceReading, CallErrorDetails } from "./http.js";
export { ProviderCallError } from "./http.js";
