/**
 * 🏪 Marketplace Aggregator Service
 *
 * Queries all available marketplaces in parallel for a given asset,
 * normalizes results, and returns sorted by price.
 *
 * Gracefully handles unavailable marketplaces — if Fragment is down,
 * we still return Getgems + Market.app results.
 */

import type {
  MarketplaceAdapter,
  MarketplaceListing,
  SearchParams,
  AggregatedResult,
  AssetKind,
  MarketplaceId,
} from "./types.js";
import { getMarketplacesForAsset } from "./types.js";
import { fragmentAdapter } from "./adapters/fragment-adapter.js";
import { getgemsAdapter } from "./adapters/getgems-adapter.js";
import { createMarketAppAdapter } from "./adapters/marketapp-adapter.js";
import { tonnelAdapter } from "./adapters/tonnel-adapter.js";
import { portalsAdapter } from "./adapters/portals-adapter.js";
import { mrktAdapter } from "./adapters/mrkt-adapter.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("Aggregator");

// ─── Adapter Registry ────────────────────────────────────────────────

const STATIC_ADAPTERS: MarketplaceAdapter[] = [
  fragmentAdapter,
  getgemsAdapter,
  tonnelAdapter,
  portalsAdapter,
  mrktAdapter,
];

const adapterMap = new Map<MarketplaceId, MarketplaceAdapter>();
for (const adapter of STATIC_ADAPTERS) {
  adapterMap.set(adapter.id, adapter);
}

/** Get adapters that support a given asset type (plus optional Market.app) */
function getAdaptersForAsset(
  assetKind: AssetKind,
  marketappToken?: string | null
): MarketplaceAdapter[] {
  const ids = getMarketplacesForAsset(assetKind);
  const adapters: MarketplaceAdapter[] = [];
  for (const id of ids) {
    if (id === "marketapp") {
      if (marketappToken) adapters.push(createMarketAppAdapter(marketappToken));
      continue;
    }
    const adapter = adapterMap.get(id);
    if (adapter) adapters.push(adapter);
  }
  return adapters;
}

// ─── Aggregated Search ───────────────────────────────────────────────

const SEARCH_TIMEOUT_MS = 8000; // 8s per marketplace max

/**
 * Deduplicate listings from multiple marketplaces.
 * Same gift (by NFT address or giftNum+collection) may appear on Fragment, Market.app, Getgems.
 * Keep the cheapest listing for each unique gift. Prefer Market.app data (has floor/onSale).
 */
function deduplicateListings(listings: MarketplaceListing[]): MarketplaceListing[] {
  const seen = new Map<string, MarketplaceListing>();

  for (const listing of listings) {
    // Build dedup key: for gifts with a collection+giftNum, always use that as primary key
    // (same gift #1213 from Fragment and Market.app should dedup)
    // For non-gift assets, use externalId
    let key: string;
    if (listing.assetKind === "gift" && listing.collection && listing.giftNum) {
      key = `${listing.collection.toLowerCase().replace(/[^a-z0-9]/g, "")}#${listing.giftNum}`;
    } else if (
      listing.externalId &&
      !listing.externalId.startsWith("gift-") &&
      !listing.externalId.startsWith("nft-") &&
      !listing.externalId.startsWith("fragment-")
    ) {
      key = listing.externalId;
    } else {
      // Fallback: marketplace + externalId (won't dedup across marketplaces, but safe)
      key = `${listing.marketplace}:${listing.externalId}`;
    }

    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, listing);
      continue;
    }

    // Keep the one with better data: cheaper price wins, or prefer one with floor data
    const existingPrice = existing.priceTon ?? Infinity;
    const newPrice = listing.priceTon ?? Infinity;

    if (newPrice < existingPrice) {
      // New one is cheaper — keep it but merge floor data from existing if missing
      if (!listing.floorPriceTon && existing.floorPriceTon) {
        listing.floorPriceTon = existing.floorPriceTon;
        listing.onSaleCount = existing.onSaleCount;
        listing.ownerCount = existing.ownerCount;
      }
      seen.set(key, listing);
    } else if (!existing.floorPriceTon && listing.floorPriceTon) {
      // Existing is cheaper but new one has floor data — merge it in
      existing.floorPriceTon = listing.floorPriceTon;
      existing.onSaleCount = listing.onSaleCount;
      existing.ownerCount = listing.ownerCount;
    }
  }

  return [...seen.values()];
}

/**
 * Search across all marketplaces for a given asset type.
 * Runs queries in parallel with individual timeouts.
 */
export async function aggregatedSearch(
  params: SearchParams,
  options?: { marketappToken?: string | null }
): Promise<AggregatedResult> {
  const marketappToken = options?.marketappToken ?? null;
  let adapters = getAdaptersForAsset(params.assetKind, marketappToken);

  // Usernames & numbers: Fragment + Getgems only.
  // Market.app returns irrelevant results (cheapest listings ignoring query).
  if (!params.marketplace && (params.assetKind === "username" || params.assetKind === "number")) {
    log.debug(`${params.assetKind} search — Fragment + Getgems only (Market.app excluded)`);
    adapters = adapters.filter((a) => a.id === "fragment" || a.id === "getgems");
  }

  // If a specific marketplace is requested, filter to only that adapter
  if (params.marketplace) {
    const target = params.marketplace.toLowerCase();
    adapters = adapters.filter((a) => a.id === target);
    if (adapters.length === 0) {
      log.warn(
        { marketplace: params.marketplace },
        "Requested marketplace not found or doesn't support this asset type"
      );
    }
  } else if (marketappToken && params.assetKind === "gift") {
    // Market.app is a meta-aggregator for gifts: it already shows listings from
    // Fragment, Getgems, and Portals with source attribution. Use it as single
    // source for gifts to avoid duplicates.
    log.debug("Market.app token available — using as primary source for gifts");
    adapters = adapters.filter((a) => a.id === "marketapp");
  }

  const checked: MarketplaceId[] = [];
  const failed: MarketplaceId[] = [];
  const allListings: MarketplaceListing[] = [];

  // Query all adapters in parallel
  const results = await Promise.allSettled(
    adapters.map(async (adapter) => {
      checked.push(adapter.id);

      // Wrap each adapter call with a timeout
      const timeoutPromise = new Promise<MarketplaceListing[]>((_, reject) => {
        setTimeout(() => reject(new Error("Timeout")), SEARCH_TIMEOUT_MS);
      });

      try {
        const listings = await Promise.race([adapter.search(params), timeoutPromise]);
        return { id: adapter.id, listings };
      } catch (err) {
        log.warn({ marketplace: adapter.id, err }, "Adapter search failed");
        failed.push(adapter.id);
        return { id: adapter.id, listings: [] as MarketplaceListing[] };
      }
    })
  );

  // Collect results
  for (const result of results) {
    if (result.status === "fulfilled" && result.value.listings.length > 0) {
      allListings.push(...result.value.listings);
    }
  }

  // Deduplicate: same gift can appear on multiple marketplaces or adapters.
  // Keep the cheapest listing per unique gift (by externalId or giftNum+collection).
  const deduped = deduplicateListings(allListings);

  // Sort by price (lowest first, null prices at end)
  deduped.sort((a, b) => {
    if (a.priceTon === null && b.priceTon === null) return 0;
    if (a.priceTon === null) return 1;
    if (b.priceTon === null) return -1;
    return a.priceTon - b.priceTon;
  });

  // Apply overall limit
  const limited = deduped.slice(0, params.limit ?? 30);

  // Single-source floor: derive from sorted listings[0], NOT from a separate endpoint.
  // This guarantees floor and cheapest listing always agree.
  const bestDeal = limited.find((l) => l.priceTon !== null) ?? null;

  // Price range — all from the same sorted list
  const priced = limited.filter((l) => l.priceTon !== null);
  const lowest = priced.length > 0 ? priced[0].priceTon : null;
  const highest = priced.length > 0 ? priced[priced.length - 1].priceTon : null;

  return {
    listings: limited,
    marketplacesChecked: checked,
    marketplacesFailed: failed,
    bestDeal,
    totalFound: deduped.length,
    priceRange: {
      lowest,
      highest,
      marketplace_lowest: bestDeal?.marketplace ?? null,
    },
  };
}

/**
 * Get a specific listing from all marketplaces.
 * Returns the first match found (useful for cross-marketplace price comparison).
 */
export async function aggregatedGetListing(
  assetKind: AssetKind,
  identifier: string,
  options?: { marketappToken?: string | null }
): Promise<{
  listings: MarketplaceListing[];
  cheapest: MarketplaceListing | null;
}> {
  const adapters = getAdaptersForAsset(assetKind, options?.marketappToken ?? null);

  const results = await Promise.allSettled(
    adapters.map(async (adapter) => {
      try {
        return await adapter.getListing(assetKind, identifier);
      } catch {
        return null;
      }
    })
  );

  const listings = results
    .filter((r) => r.status === "fulfilled" && r.value !== null)
    .map((r) => (r as PromiseFulfilledResult<MarketplaceListing>).value);

  listings.sort((a, b) => {
    if (a.priceTon === null) return 1;
    if (b.priceTon === null) return -1;
    return a.priceTon - b.priceTon;
  });

  return {
    listings,
    cheapest: listings[0] ?? null,
  };
}

/**
 * Check which marketplaces are currently available.
 */
export async function checkMarketplaceHealth(options?: {
  marketappToken?: string | null;
}): Promise<Array<{ id: MarketplaceId; name: string; available: boolean; supports: AssetKind[] }>> {
  const adapters: MarketplaceAdapter[] = [...STATIC_ADAPTERS];
  if (options?.marketappToken) {
    adapters.push(createMarketAppAdapter(options.marketappToken));
  }

  const results = await Promise.allSettled(
    adapters.map(async (adapter) => ({
      id: adapter.id,
      name: adapter.name,
      available: await adapter.isAvailable(),
      supports: adapter.supports,
    }))
  );

  return results.map((r) =>
    r.status === "fulfilled"
      ? r.value
      : {
          id: "unknown" as MarketplaceId,
          name: "Unknown",
          available: false,
          supports: [] as AssetKind[],
        }
  );
}
