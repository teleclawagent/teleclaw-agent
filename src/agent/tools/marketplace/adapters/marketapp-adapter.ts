/**
 * Marketapp Adapter
 *
 * Supports: usernames, anonymous numbers, gifts
 * Method: REST API with token auth
 * Docs: https://api.marketapp.ws/docs/
 */

import type { MarketplaceAdapter, MarketplaceListing, SearchParams, AssetKind } from "../types.js";
import { createLogger } from "../../../../utils/logger.js";

const log = createLogger("Marketplace:MarketApp");

const BASE_URL = "https://api.marketapp.ws";

// ── Token management (set from outside via setMarketappToken) ────────

let _apiToken: string | null = null;

/** Set the Marketapp API token (called from tool context) */
export function setMarketappToken(token: string | null): void {
  _apiToken = token;
}

/** Check if a token is configured */
export function hasMarketappToken(): boolean {
  return !!_apiToken;
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (_apiToken) {
    headers["Authorization"] = _apiToken;
  }
  return headers;
}

// ── Helpers ──────────────────────────────────────────────────────────

interface CollectionItem {
  address?: string;
  name?: string;
  slug?: string;
  floor_price?: number;
  items_count?: number;
  owners_count?: number;
  stats?: {
    floor_price?: number;
    total_volume?: number;
  };
}

interface NftItem {
  address?: string;
  name?: string;
  index?: number;
  collection_address?: string;
  collection?: { name?: string };
  owner_address?: string;
  sale?: {
    price?: number;
    currency?: string;
    marketplace?: string;
  };
  status?: string;
  attributes?: { trait_type?: string; value?: string }[];
  previews?: { url?: string }[];
}

interface GiftOnSale {
  address?: string;
  name?: string;
  collection_name?: string;
  price?: number;
  currency?: string;
  seller_address?: string;
  model?: string;
  backdrop?: string;
  symbol?: string;
  rarity?: string;
  index?: number;
}

interface GiftsOnSaleResponse {
  items?: GiftOnSale[];
  total?: number;
}

interface NftsResponse {
  items?: NftItem[];
  total?: number;
}

// ── Adapter ─────────────────────────────────────────────────────────

export const marketAppAdapter: MarketplaceAdapter = {
  id: "marketapp",
  name: "Market.app",
  supports: ["username", "number", "gift"],

  async search(params: SearchParams): Promise<MarketplaceListing[]> {
    if (!_apiToken) {
      log.debug("No Marketapp token configured, skipping");
      return [];
    }

    try {
      if (params.assetKind === "gift") {
        return await searchGifts(params);
      }
      // For usernames/numbers, use NFT collections endpoint
      return await searchNfts(params);
    } catch (err) {
      log.error({ err }, "Marketapp search failed");
      return [];
    }
  },

  async getListing(assetKind: AssetKind, identifier: string): Promise<MarketplaceListing | null> {
    if (!_apiToken) return null;

    try {
      const res = await fetch(`${BASE_URL}/v1/nfts/${encodeURIComponent(identifier)}/`, {
        headers: authHeaders(),
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) return null;

      const item = (await res.json()) as { nft?: NftItem };
      const nft = item.nft;
      if (!nft) return null;

      return {
        marketplace: "marketapp",
        assetKind,
        externalId: nft.address || identifier,
        url: `https://marketapp.ws/nft/${nft.address || identifier}`,
        identifier: nft.name || identifier,
        collection: nft.collection?.name,
        priceTon: nft.sale?.currency === "TON" ? (nft.sale?.price ?? null) : null,
        priceStars: nft.sale?.currency === "Stars" ? (nft.sale?.price ?? null) : null,
        originalCurrency: nft.sale?.currency || "TON",
        originalPrice: nft.sale?.price ?? null,
        listingType: "fixed",
        seller: nft.owner_address,
        onChain: true,
      };
    } catch (err) {
      log.error({ err }, "Marketapp getListing failed");
      return null;
    }
  },

  async isAvailable(): Promise<boolean> {
    if (!_apiToken) return false;
    try {
      const res = await fetch(`${BASE_URL}/v1/collections/`, {
        headers: authHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  },
};

// ── Gift search ─────────────────────────────────────────────────────

async function searchGifts(params: SearchParams): Promise<MarketplaceListing[]> {
  const url = new URL("/v1/gifts/onsale/", BASE_URL);
  if (params.collection) url.searchParams.set("collection_name", params.collection);
  if (params.limit) url.searchParams.set("limit", String(Math.min(params.limit, 100)));
  if (params.sortBy === "price") url.searchParams.set("sort_by", "price");

  const res = await fetch(url.toString(), {
    headers: authHeaders(),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    log.warn({ status: res.status }, "Marketapp gifts/onsale returned error");
    return [];
  }

  const data = (await res.json()) as GiftsOnSaleResponse;
  if (!data?.items?.length) return [];

  return data.items
    .filter((g) => {
      if (params.maxPrice && g.price && g.price > params.maxPrice) return false;
      if (params.minPrice && g.price && g.price < params.minPrice) return false;
      return true;
    })
    .map(
      (g): MarketplaceListing => ({
        marketplace: "marketapp",
        assetKind: "gift",
        externalId: g.address || `gift-${g.index}`,
        url: `https://marketapp.ws/gift/${g.address || g.index}`,
        identifier: g.name,
        collection: g.collection_name,
        giftNum: g.index,
        model: g.model,
        backdrop: g.backdrop,
        symbol: g.symbol,
        rarityTier: g.rarity,
        priceTon: g.currency === "TON" || !g.currency ? (g.price ?? null) : null,
        priceStars: g.currency === "Stars" ? (g.price ?? null) : null,
        originalCurrency: g.currency || "TON",
        originalPrice: g.price ?? null,
        listingType: "fixed",
        seller: g.seller_address,
        onChain: true,
      })
    );
}

// ── NFT/Username/Number search ──────────────────────────────────────

async function searchNfts(params: SearchParams): Promise<MarketplaceListing[]> {
  // Get gift collections or all collections based on asset type
  const collectionsUrl = new URL("/v1/collections/", BASE_URL);
  const colRes = await fetch(collectionsUrl.toString(), {
    headers: authHeaders(),
    signal: AbortSignal.timeout(10000),
  });

  if (!colRes.ok) {
    log.warn({ status: colRes.status }, "Marketapp collections returned error");
    return [];
  }

  const collections = (await colRes.json()) as CollectionItem[];
  if (!collections?.length) return [];

  // Find matching collection
  const query = params.query?.toLowerCase() || params.collection?.toLowerCase();
  const matchedCol = query
    ? collections.find(
        (c) => c.name?.toLowerCase().includes(query) || c.slug?.toLowerCase().includes(query)
      )
    : null;

  if (!matchedCol?.address) return [];

  // Get NFTs in that collection
  const nftsUrl = new URL(`/v1/nfts/collections/${matchedCol.address}/`, BASE_URL);
  if (params.limit) nftsUrl.searchParams.set("limit", String(Math.min(params.limit, 100)));
  if (params.sortBy === "price") nftsUrl.searchParams.set("sort_by", "price");

  const nftsRes = await fetch(nftsUrl.toString(), {
    headers: authHeaders(),
    signal: AbortSignal.timeout(15000),
  });

  if (!nftsRes.ok) return [];

  const nftsData = (await nftsRes.json()) as NftsResponse;
  if (!nftsData?.items?.length) return [];

  return nftsData.items
    .filter((n) => n.sale?.price != null)
    .filter((n) => {
      if (params.maxPrice && n.sale?.price && n.sale.price > params.maxPrice) return false;
      if (params.minPrice && n.sale?.price && n.sale.price < params.minPrice) return false;
      return true;
    })
    .map(
      (n): MarketplaceListing => ({
        marketplace: "marketapp",
        assetKind: params.assetKind,
        externalId: n.address || `nft-${n.index}`,
        url: `https://marketapp.ws/nft/${n.address}`,
        identifier: n.name,
        collection: matchedCol.name,
        giftNum: n.index,
        priceTon: n.sale?.currency === "TON" || !n.sale?.currency ? (n.sale?.price ?? null) : null,
        priceStars: n.sale?.currency === "Stars" ? (n.sale?.price ?? null) : null,
        originalCurrency: n.sale?.currency || "TON",
        originalPrice: n.sale?.price ?? null,
        listingType: "fixed",
        seller: n.owner_address,
        onChain: true,
      })
    );
}
