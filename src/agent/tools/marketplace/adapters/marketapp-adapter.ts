/**
 * Market.app (Whales Market) Adapter
 *
 * Supports: usernames, anonymous numbers, gifts
 * Method: REST API
 */

import type { MarketplaceAdapter, MarketplaceListing, SearchParams, AssetKind } from "../types.js";
import { createLogger } from "../../../../utils/logger.js";

const log = createLogger("Marketplace:MarketApp");

const BASE_URL = "https://api.marketapp.ws";

interface MarketAppListing {
  id: string;
  name?: string;
  price?: number;
  currency?: string;
  seller?: string;
  status?: string;
  type?: string;
  collection?: string;
  url?: string;
  metadata?: Record<string, unknown>;
}

export const marketAppAdapter: MarketplaceAdapter = {
  id: "marketapp",
  name: "Market.app",
  supports: ["username", "number", "gift"],

  async search(params: SearchParams): Promise<MarketplaceListing[]> {
    try {
      const endpoint =
        params.assetKind === "gift"
          ? "/v1/gifts"
          : params.assetKind === "number"
            ? "/v1/numbers"
            : "/v1/usernames";

      const url = new URL(endpoint, BASE_URL);
      if (params.query) url.searchParams.set("q", params.query);
      if (params.collection) url.searchParams.set("collection", params.collection);
      if (params.maxPrice) url.searchParams.set("max_price", params.maxPrice.toString());
      if (params.limit) url.searchParams.set("limit", params.limit.toString());
      if (params.sortBy === "price") url.searchParams.set("sort", "price_asc");

      const res = await fetch(url.toString(), {
        headers: { Accept: "application/json" },
      });

      if (!res.ok) {
        log.warn({ status: res.status }, "Market.app API returned error");
        return [];
      }

      const data = (await res.json()) as { items?: MarketAppListing[] };
      if (!data?.items) return [];

      return data.items.map(
        (item): MarketplaceListing => ({
          marketplace: "marketapp",
          assetKind: params.assetKind,
          externalId: item.id,
          url: item.url || `https://marketapp.ws/${params.assetKind}/${item.id}`,
          identifier: item.name,
          collection: item.collection,
          priceTon: item.currency === "TON" ? (item.price ?? null) : null,
          priceStars: item.currency === "Stars" ? (item.price ?? null) : null,
          originalCurrency: item.currency || "TON",
          originalPrice: item.price ?? null,
          listingType: "fixed",
          seller: item.seller,
          onChain: false,
        })
      );
    } catch (err) {
      log.error({ err }, "Market.app search failed");
      return [];
    }
  },

  async getListing(assetKind: AssetKind, identifier: string): Promise<MarketplaceListing | null> {
    try {
      const endpoint =
        assetKind === "gift"
          ? "/v1/gifts"
          : assetKind === "number"
            ? "/v1/numbers"
            : "/v1/usernames";

      const res = await fetch(`${BASE_URL}${endpoint}/${encodeURIComponent(identifier)}`, {
        headers: { Accept: "application/json" },
      });

      if (!res.ok) return null;

      const item = (await res.json()) as MarketAppListing;
      return {
        marketplace: "marketapp",
        assetKind,
        externalId: item.id,
        url: item.url || `https://marketapp.ws/${assetKind}/${item.id}`,
        identifier: item.name || identifier,
        priceTon: item.currency === "TON" ? (item.price ?? null) : null,
        originalCurrency: item.currency || "TON",
        originalPrice: item.price ?? null,
        listingType: "fixed",
        seller: item.seller,
        onChain: false,
      };
    } catch (err) {
      log.error({ err }, "Market.app getListing failed");
      return null;
    }
  },

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch("https://marketapp.ws", { method: "HEAD" });
      return res.ok || res.status === 404;
    } catch {
      return false;
    }
  },
};
