/**
 * Fragment.com Marketplace Adapter
 *
 * Supports: usernames, anonymous numbers, gifts (both on-chain & off-chain)
 * Fragment is Telegram's official marketplace — supports both upgraded (on-chain NFT)
 * and non-upgraded (off-chain) gifts, plus username and number trading.
 * Method: HTML scraping (no official API)
 * Rate limit: 2s between requests, 3min cache
 */

import type { MarketplaceAdapter, MarketplaceListing, SearchParams, AssetKind } from "../types.js";
import type { FragmentUsername, FragmentNumber } from "../../fragment/fragment-service.js";
import {
  fetchListings as fetchGiftListings,
  resolveSlug,
  type FragmentListing,
} from "../../gift-market/fragment-scraper.js";
import { createLogger } from "../../../../utils/logger.js";

const log = createLogger("Marketplace:Fragment");

let fragmentServiceLoaded = false;
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
let fragmentService: typeof import("../../fragment/fragment-service.js") | null = null;

async function getFragmentService() {
  if (!fragmentServiceLoaded) {
    try {
      fragmentService = await import("../../fragment/fragment-service.js");
      fragmentServiceLoaded = true;
    } catch {
      log.warn("Fragment service not available");
    }
  }
  return fragmentService;
}

/** Convert a FragmentListing (from scraper) to a unified MarketplaceListing */
function giftToListing(g: FragmentListing, collection?: string): MarketplaceListing {
  return {
    marketplace: "fragment",
    assetKind: "gift",
    externalId: g.slug,
    url: g.url,
    identifier: g.slug,
    collection: collection || g.slug.replace(/-\d+$/, ""),
    giftNum: g.giftNum,
    priceTon: g.priceTon,
    originalCurrency: "TON",
    originalPrice: g.priceTon,
    listingType: "fixed",
    onChain: false, // Fragment lists both on-chain and off-chain; scraper doesn't distinguish
  };
}

function usernameToListing(u: FragmentUsername): MarketplaceListing {
  return {
    marketplace: "fragment",
    assetKind: "username",
    externalId: u.username,
    url: u.url,
    identifier: u.username,
    priceTon: u.priceRaw ?? null,
    originalCurrency: "TON",
    originalPrice: u.priceRaw ?? null,
    listingType: u.status === "auction" ? "auction" : "fixed",
    seller: u.owner,
    endsAt: u.endsAt,
    onChain: true,
  };
}

function numberToListing(n: FragmentNumber): MarketplaceListing {
  return {
    marketplace: "fragment",
    assetKind: "number",
    externalId: n.rawDigits,
    url: n.url,
    identifier: n.number,
    priceTon: n.priceRaw ?? null,
    originalCurrency: "TON",
    originalPrice: n.priceRaw ?? null,
    listingType: n.status === "auction" ? "auction" : "fixed",
    endsAt: n.endsAt,
    onChain: true,
  };
}

export const fragmentAdapter: MarketplaceAdapter = {
  id: "fragment",
  name: "Fragment",
  supports: ["username", "number", "gift"],

  async search(params: SearchParams): Promise<MarketplaceListing[]> {
    const svc = await getFragmentService();
    if (!svc) return [];

    try {
      if (params.assetKind === "username") {
        const results = await svc.fetchUsernames();
        let filtered = results;
        if (params.query) {
          const q = params.query.toLowerCase();
          filtered = filtered.filter((u) => u.username.toLowerCase().includes(q));
        }
        if (params.maxPrice) {
          filtered = filtered.filter(
            (u) => u.priceRaw != null && u.priceRaw <= (params.maxPrice as number)
          );
        }
        return filtered.slice(0, params.limit ?? 20).map(usernameToListing);
      }

      if (params.assetKind === "number") {
        const results = await svc.fetchNumbers();
        let filtered = results;
        if (params.query) {
          filtered = filtered.filter(
            (n) =>
              n.number.includes(params.query as string) ||
              n.rawDigits.includes(params.query as string)
          );
        }
        if (params.maxPrice) {
          filtered = filtered.filter(
            (n) => n.priceRaw != null && n.priceRaw <= (params.maxPrice as number)
          );
        }
        return filtered.slice(0, params.limit ?? 20).map(numberToListing);
      }

      // Gifts — use Fragment scraper (covers on-chain + off-chain)
      if (params.assetKind === "gift") {
        const collectionName = params.collection || params.query;
        if (!collectionName) {
          log.debug("No collection name provided for gift search");
          return [];
        }

        const slug = await resolveSlug(collectionName);
        if (!slug) {
          log.debug({ collectionName }, "Could not resolve Fragment slug");
          return [];
        }

        // Overfetch then trim — scraper regex can miss items
        const limit = params.limit ?? 20;
        const fetchLimit = Math.max(limit * 2, 30);
        const listings = await fetchGiftListings(slug, fetchLimit);

        // Client-side sort to ensure cheapest first
        listings.sort((a, b) => a.priceTon - b.priceTon);

        let results = listings.map((l) => giftToListing(l, collectionName));

        // Apply price filters
        if (params.maxPrice) {
          results = results.filter(
            (r) => r.priceTon != null && r.priceTon <= (params.maxPrice as number)
          );
        }
        if (params.minPrice) {
          results = results.filter(
            (r) => r.priceTon != null && r.priceTon >= (params.minPrice as number)
          );
        }

        return results.slice(0, limit);
      }

      return [];
    } catch (err) {
      log.error({ err }, "Fragment search failed");
      return [];
    }
  },

  async getListing(assetKind: AssetKind, identifier: string): Promise<MarketplaceListing | null> {
    const svc = await getFragmentService();
    if (!svc) return null;

    try {
      if (assetKind === "username") {
        const result = await svc.checkUsername(identifier);
        if (!result) return null;
        return usernameToListing(result);
      }

      if (assetKind === "number") {
        const result = await svc.checkNumber(identifier);
        if (!result) return null;
        return numberToListing(result);
      }

      // Gift by slug identifier
      if (assetKind === "gift") {
        const listings = await fetchGiftListings(identifier, 1);
        if (listings.length === 0) return null;
        return giftToListing(listings[0]);
      }

      return null;
    } catch (err) {
      log.error({ err, assetKind, identifier }, "Fragment getListing failed");
      return null;
    }
  },

  async isAvailable(): Promise<boolean> {
    try {
      // Fragment is always available (HTML scraping, no auth needed for gifts)
      // Even if fragment-service isn't loaded, gift scraping works independently
      return true;
    } catch {
      return false;
    }
  },
};
