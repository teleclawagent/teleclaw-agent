/**
 * Portals.to Marketplace Adapter
 *
 * Supports: gifts ONLY (on-chain NFT trading)
 * Method: REST API
 */

import type {
  MarketplaceAdapter,
  MarketplaceListing,
  SearchParams,
  AssetKind,
} from "../types.js";
import { createLogger } from "../../../../utils/logger.js";

const log = createLogger("Marketplace:Portals");

const BASE_URL = "https://api.portals.to";

interface PortalsGift {
  id: string;
  collection_name: string;
  number?: number;
  model_name?: string;
  backdrop_name?: string;
  symbol_name?: string;
  price_ton?: number;
  seller_address?: string;
  rarity?: string;
}

export const portalsAdapter: MarketplaceAdapter = {
  id: "portals",
  name: "Portals",
  supports: ["gift"],

  async search(params: SearchParams): Promise<MarketplaceListing[]> {
    if (params.assetKind !== "gift") return [];

    try {
      const url = new URL("/api/v1/gifts", BASE_URL);
      if (params.collection) url.searchParams.set("collection", params.collection);
      if (params.maxPrice) url.searchParams.set("max_price", params.maxPrice.toString());
      if (params.limit) url.searchParams.set("limit", params.limit.toString());

      const res = await fetch(url.toString(), {
        headers: { "Accept": "application/json" },
      });

      if (!res.ok) {
        log.warn({ status: res.status }, "Portals API error");
        return [];
      }

      const data = await res.json() as { data?: PortalsGift[] };
      if (!data?.data) return [];

      return data.data.map((g): MarketplaceListing => ({
        marketplace: "portals",
        assetKind: "gift",
        externalId: g.id,
        url: `https://portals.to/gift/${g.id}`,
        collection: g.collection_name,
        giftNum: g.number,
        model: g.model_name,
        backdrop: g.backdrop_name,
        symbol: g.symbol_name,
        rarityTier: g.rarity,
        priceTon: g.price_ton ?? null,
        originalCurrency: "TON",
        originalPrice: g.price_ton ?? null,
        listingType: "fixed",
        seller: g.seller_address,
        onChain: true,
      }));
    } catch (err) {
      log.error({ err }, "Portals search failed");
      return [];
    }
  },

  async getListing(_assetKind: AssetKind, identifier: string): Promise<MarketplaceListing | null> {
    try {
      const res = await fetch(`${BASE_URL}/api/v1/gifts/${encodeURIComponent(identifier)}`);
      if (!res.ok) return null;

      const g = await res.json() as PortalsGift;
      return {
        marketplace: "portals",
        assetKind: "gift",
        externalId: g.id,
        url: `https://portals.to/gift/${g.id}`,
        collection: g.collection_name,
        giftNum: g.number,
        model: g.model_name,
        backdrop: g.backdrop_name,
        symbol: g.symbol_name,
        priceTon: g.price_ton ?? null,
        originalCurrency: "TON",
        originalPrice: g.price_ton ?? null,
        listingType: "fixed",
        seller: g.seller_address,
        onChain: true,
      };
    } catch (err) {
      log.error({ err }, "Portals getListing failed");
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
