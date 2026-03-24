/**
 * MRKT.tg Marketplace Adapter
 *
 * Supports: gifts ONLY
 * Method: REST API (Telegram-native marketplace)
 */

import type { MarketplaceAdapter, MarketplaceListing, SearchParams, AssetKind } from "../types.js";
import { createLogger } from "../../../../utils/logger.js";

const log = createLogger("Marketplace:MRKT");

const BASE_URL = "https://api.mrkt.tg";

interface MRKTGift {
  id: string;
  collection: string;
  number?: number;
  model?: string;
  backdrop?: string;
  symbol?: string;
  price?: number;
  currency?: string;
  seller_id?: number;
  rarity_tier?: string;
}

export const mrktAdapter: MarketplaceAdapter = {
  id: "mrkt",
  name: "MRKT",
  supports: ["gift"],

  async search(params: SearchParams): Promise<MarketplaceListing[]> {
    if (params.assetKind !== "gift") return [];

    try {
      const url = new URL("/api/gifts/search", BASE_URL);
      if (params.collection) url.searchParams.set("collection", params.collection);
      if (params.maxPrice) url.searchParams.set("max_price", params.maxPrice.toString());
      if (params.limit) url.searchParams.set("limit", params.limit.toString());

      const res = await fetch(url.toString(), {
        headers: { Accept: "application/json" },
      });

      if (!res.ok) {
        log.warn({ status: res.status }, "MRKT API error");
        return [];
      }

      const data = (await res.json()) as { results?: MRKTGift[] };
      if (!data?.results) return [];

      return data.results.map(
        (g): MarketplaceListing => ({
          marketplace: "mrkt",
          assetKind: "gift",
          externalId: g.id,
          url: `https://mrkt.tg/gift/${g.id}`,
          collection: g.collection,
          giftNum: g.number,
          model: g.model,
          backdrop: g.backdrop,
          symbol: g.symbol,
          rarityTier: g.rarity_tier,
          priceTon: g.currency === "TON" || !g.currency ? (g.price ?? null) : null,
          priceStars: g.currency === "Stars" ? (g.price ?? null) : null,
          originalCurrency: g.currency || "TON",
          originalPrice: g.price ?? null,
          listingType: "fixed",
          onChain: false,
        })
      );
    } catch (err) {
      log.error({ err }, "MRKT search failed");
      return [];
    }
  },

  async getListing(_assetKind: AssetKind, identifier: string): Promise<MarketplaceListing | null> {
    try {
      const res = await fetch(`${BASE_URL}/api/gifts/${encodeURIComponent(identifier)}`);
      if (!res.ok) return null;

      const g = (await res.json()) as MRKTGift;
      return {
        marketplace: "mrkt",
        assetKind: "gift",
        externalId: g.id,
        url: `https://mrkt.tg/gift/${g.id}`,
        collection: g.collection,
        giftNum: g.number,
        model: g.model,
        backdrop: g.backdrop,
        symbol: g.symbol,
        priceTon: g.price ?? null,
        originalCurrency: g.currency || "TON",
        originalPrice: g.price ?? null,
        listingType: "fixed",
        onChain: false,
      };
    } catch (err) {
      log.error({ err }, "MRKT getListing failed");
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
