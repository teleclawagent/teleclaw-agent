/**
 * Tonnel.network Marketplace Adapter
 *
 * Supports: gifts ONLY (both on-chain and off-chain)
 * Method: REST API
 */

import type {
  MarketplaceAdapter,
  MarketplaceListing,
  SearchParams,
  AssetKind,
} from "../types.js";
import { createLogger } from "../../../../utils/logger.js";

const log = createLogger("Marketplace:Tonnel");

const BASE_URL = "https://api.tonnel.network";

interface TonnelGift {
  id: string;
  collection: string;
  gift_number?: number;
  model?: string;
  backdrop?: string;
  symbol?: string;
  price?: number;
  currency?: string;
  seller?: string;
  rarity_tier?: string;
  on_chain?: boolean;
  url?: string;
}

export const tonnelAdapter: MarketplaceAdapter = {
  id: "tonnel",
  name: "Tonnel",
  supports: ["gift"],

  async search(params: SearchParams): Promise<MarketplaceListing[]> {
    if (params.assetKind !== "gift") return [];

    try {
      const url = new URL("/v1/gifts", BASE_URL);
      if (params.collection) url.searchParams.set("collection", params.collection);
      if (params.model) url.searchParams.set("model", params.model);
      if (params.backdrop) url.searchParams.set("backdrop", params.backdrop);
      if (params.symbol) url.searchParams.set("symbol", params.symbol);
      if (params.maxPrice) url.searchParams.set("max_price", params.maxPrice.toString());
      if (params.minTier) url.searchParams.set("min_tier", params.minTier);
      if (params.limit) url.searchParams.set("limit", params.limit.toString());
      if (params.sortBy === "price") url.searchParams.set("sort", "price_asc");

      const res = await fetch(url.toString(), {
        headers: { "Accept": "application/json" },
      });

      if (!res.ok) {
        log.warn({ status: res.status }, "Tonnel API error");
        return [];
      }

      const data = await res.json() as { gifts?: TonnelGift[] };
      if (!data?.gifts) return [];

      return data.gifts.map((g): MarketplaceListing => ({
        marketplace: "tonnel",
        assetKind: "gift",
        externalId: g.id,
        url: g.url || `https://tonnel.network/gift/${g.id}`,
        collection: g.collection,
        giftNum: g.gift_number,
        model: g.model,
        backdrop: g.backdrop,
        symbol: g.symbol,
        rarityTier: g.rarity_tier,
        priceTon: g.currency === "TON" || !g.currency ? (g.price ?? null) : null,
        priceStars: g.currency === "Stars" ? (g.price ?? null) : null,
        originalCurrency: g.currency || "TON",
        originalPrice: g.price ?? null,
        listingType: "fixed",
        seller: g.seller,
        onChain: g.on_chain ?? false,
      }));
    } catch (err) {
      log.error({ err }, "Tonnel search failed");
      return [];
    }
  },

  async getListing(_assetKind: AssetKind, identifier: string): Promise<MarketplaceListing | null> {
    try {
      const res = await fetch(`${BASE_URL}/v1/gifts/${encodeURIComponent(identifier)}`, {
        headers: { "Accept": "application/json" },
      });
      if (!res.ok) return null;

      const g = await res.json() as TonnelGift;
      return {
        marketplace: "tonnel",
        assetKind: "gift",
        externalId: g.id,
        url: g.url || `https://tonnel.network/gift/${g.id}`,
        collection: g.collection,
        giftNum: g.gift_number,
        model: g.model,
        backdrop: g.backdrop,
        symbol: g.symbol,
        rarityTier: g.rarity_tier,
        priceTon: g.price ?? null,
        originalCurrency: g.currency || "TON",
        originalPrice: g.price ?? null,
        listingType: "fixed",
        seller: g.seller,
        onChain: g.on_chain ?? false,
      };
    } catch (err) {
      log.error({ err }, "Tonnel getListing failed");
      return null;
    }
  },

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(BASE_URL, { method: "HEAD" });
      return res.ok || res.status === 404;
    } catch {
      return false;
    }
  },
};
