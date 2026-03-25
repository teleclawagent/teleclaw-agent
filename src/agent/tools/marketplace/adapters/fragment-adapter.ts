/**
 * Fragment.com Marketplace Adapter
 *
 * Supports: usernames, anonymous numbers, gifts (both on-chain & off-chain)
 * Fragment is Telegram's official marketplace — supports both upgraded (on-chain NFT)
 * and non-upgraded (off-chain) gifts, plus username and number trading.
 * Method: HTML scraping via cheerio (no official API)
 * Rate limit: 2s between requests, 5min cache
 */

import type { MarketplaceAdapter, MarketplaceListing, SearchParams, AssetKind } from "../types.js";
import type { FragmentUsername, FragmentNumber } from "../../fragment/fragment-service.js";
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

      // Gifts — Fragment gift listings via fragment-scraper
      if (params.collection) {
        try {
          const { fetchListings, fetchFloorPrice } = await import(
            "../../gift-market/fragment-scraper.js"
          );
          const slug = params.collection.toLowerCase().replace(/[^a-z0-9]/g, "");
          // Fetch more than needed — scraper regex can miss items, overfetch then trim
          const fetchLimit = Math.max((params.limit ?? 20) * 2, 30);
          const [listings, floor] = await Promise.all([
            fetchListings(slug, fetchLimit),
            fetchFloorPrice(slug),
          ]);

          if (listings.length === 0) {
            log.debug({ slug }, "Fragment scraper returned 0 listings — page may have changed");
            return [];
          }

          // Client-side sort to ensure cheapest first (scraper may not preserve order)
          listings.sort((a, b) => a.priceTon - b.priceTon);

          return listings
            .filter((l) => !params.maxPrice || l.priceTon <= params.maxPrice)
            .slice(0, params.limit ?? 20)
            .map(
              (l): MarketplaceListing => ({
                marketplace: "fragment",
                assetKind: "gift",
                externalId: `fragment-${slug}-${l.giftNum}`,
                url: l.url,
                identifier: floor?.collection || params.collection || l.slug,
                collection: floor?.collection || params.collection,
                giftNum: l.giftNum,
                priceTon: l.priceTon,
                originalCurrency: "TON",
                originalPrice: l.priceTon,
                floorPriceTon: floor?.floorTon ?? undefined,
                onSaleCount: floor?.listingCount,
                listingType: "fixed",
                onChain: true,
              })
            );
        } catch (err) {
          log.warn({ err, collection: params.collection }, "Fragment gift scraping failed");
          return [];
        }
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

      return null;
    } catch (err) {
      log.error({ err, assetKind, identifier }, "Fragment getListing failed");
      return null;
    }
  },

  async isAvailable(): Promise<boolean> {
    try {
      const svc = await getFragmentService();
      return svc !== null;
    } catch {
      return false;
    }
  },
};
