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
  item_num?: number;
  collection_address?: string;
  collection?: { name?: string };
  owner?: string;
  owner_address?: string;
  real_owner?: string;
  /** Nanoton bid (API returns string-like big numbers) */
  min_bid?: string | number;
  max_bid?: string | number;
  currency?: string;
  sale?: {
    price?: number;
    currency?: string;
    marketplace?: string;
  };
  status?: string;
  attributes?: { trait_type?: string; value?: string }[];
  previews?: { url?: string }[];
  listed_at?: number;
}

interface GiftOnSale {
  address?: string;
  name?: string;
  collection_name?: string;
  collection_address?: string;
  price?: number;
  /** Nanoton bid — API v1 returns this instead of price */
  min_bid?: string | number;
  max_bid?: string | number;
  currency?: string;
  seller_address?: string;
  owner?: string;
  real_owner?: string;
  model?: string;
  backdrop?: string;
  symbol?: string;
  rarity?: string;
  index?: number;
  item_num?: number;
  /** Whether the gift has been upgraded to an on-chain NFT */
  is_nft?: boolean;
  on_chain?: boolean;
  type?: string; // "nft" | "offchain" etc.
  attributes?: { trait_type?: string; value?: string }[];
}

interface GiftsOnSaleResponse {
  items?: GiftOnSale[];
  total?: number;
}

interface NftsResponse {
  items?: NftItem[];
  total?: number;
}

/** Convert nanoton string/number to TON (divide by 1e9) */
function nanoToTon(nano?: string | number): number | null {
  if (nano == null) return null;
  const val = typeof nano === "string" ? Number(nano) : nano;
  if (isNaN(val) || val <= 0) return null;
  return val / 1e9;
}

/** Extract price from gift/nft item — prefers min_bid (nanotons), falls back to price */
function extractPrice(item: { min_bid?: string | number; price?: number }): number | null {
  if (item.min_bid != null) return nanoToTon(item.min_bid);
  return item.price ?? null;
}

/** Extract model/backdrop/symbol from attributes array */
function attrValue(
  attrs?: { trait_type?: string; value?: string }[],
  trait?: string
): string | undefined {
  if (!attrs || !trait) return undefined;
  return attrs.find((a) => a.trait_type?.toLowerCase() === trait.toLowerCase())?.value;
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
      log.info(
        `Marketapp search: kind=${params.assetKind}, hasToken=${!!_apiToken}, tokenLen=${_apiToken?.length ?? 0}`
      );
      if (params.assetKind === "gift") {
        // Try gifts/onsale first, then fall back to NFT collections endpoint
        const giftResults = await searchGifts(params);
        if (giftResults.length > 0) return giftResults;
        // Gift collections (like Plush Pepe) are under /nfts/collections/
        log.debug("No gifts from onsale endpoint, trying NFT collections fallback");
        return await searchNfts({ ...params, assetKind: "gift" });
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

// ── Gift collection cache (from /v1/collections/gifts/) ─────────────

interface GiftCollectionInfo {
  name: string;
  address: string;
  items?: number;
  floor?: number; // in TON
  rentFloor?: number;
  volume7d?: number;
  volume30d?: number;
  owners?: number;
  onSaleAll?: number;
  onSaleOnchain?: number;
}

let _giftCollectionsCache: GiftCollectionInfo[] | null = null;
let _giftCollectionsCacheAt = 0;
const GIFT_COLLECTIONS_TTL_MS = 5 * 60 * 1000; // 5 min

async function getGiftCollections(): Promise<GiftCollectionInfo[]> {
  const now = Date.now();
  if (_giftCollectionsCache && now - _giftCollectionsCacheAt < GIFT_COLLECTIONS_TTL_MS) {
    return _giftCollectionsCache;
  }

  const res = await fetch(`${BASE_URL}/v1/collections/gifts/`, {
    headers: authHeaders(),
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    log.warn({ status: res.status }, "Failed to fetch gift collections");
    return _giftCollectionsCache ?? [];
  }

  const raw = (await res.json()) as Array<{
    name?: string;
    address?: string;
    extra_data?: {
      items?: number;
      floor?: string | number;
      rent_floor?: string | number;
      volume7d?: string | number;
      volume30d?: string | number;
      owners?: number;
      on_sale_all?: number;
      on_sale_onchain?: number;
    };
  }>;

  _giftCollectionsCache = raw
    .filter((c) => c.address && c.name)
    .map((c) => ({
      name: c.name ?? "",
      address: c.address ?? "",
      items: c.extra_data?.items,
      floor: nanoToTon(c.extra_data?.floor) ?? undefined,
      rentFloor: nanoToTon(c.extra_data?.rent_floor) ?? undefined,
      volume7d: nanoToTon(c.extra_data?.volume7d) ?? undefined,
      volume30d: nanoToTon(c.extra_data?.volume30d) ?? undefined,
      owners: c.extra_data?.owners,
      onSaleAll: c.extra_data?.on_sale_all,
      onSaleOnchain: c.extra_data?.on_sale_onchain,
    }));
  _giftCollectionsCacheAt = now;
  log.debug(`Cached ${_giftCollectionsCache.length} gift collections`);
  return _giftCollectionsCache;
}

/** Find a gift collection by name (fuzzy) */
function findGiftCollection(
  collections: GiftCollectionInfo[],
  query: string
): GiftCollectionInfo | undefined {
  const q = query.toLowerCase();
  // Exact match first
  const exact = collections.find((c) => c.name.toLowerCase() === q);
  if (exact) return exact;
  // Includes match
  return collections.find((c) => c.name.toLowerCase().includes(q));
}

// ── Gift search ─────────────────────────────────────────────────────

async function searchGifts(params: SearchParams): Promise<MarketplaceListing[]> {
  // Resolve collection address from gift collections endpoint
  const collections = await getGiftCollections();
  const query = params.collection?.toLowerCase() || params.query?.toLowerCase();

  let collectionAddr: string | undefined;
  let collectionInfo: GiftCollectionInfo | undefined;

  if (query) {
    collectionInfo = findGiftCollection(collections, query);
    collectionAddr = collectionInfo?.address;
  }

  const url = new URL("/v1/gifts/onsale/", BASE_URL);
  if (collectionAddr) {
    url.searchParams.set("collection_address", collectionAddr);
  } else if (params.collection) {
    // Fallback: try collection_name directly
    url.searchParams.set("collection_name", params.collection);
  }
  // sort_by: min_bid_asc (default), min_bid_desc, recently_touch
  url.searchParams.set("sort_by", params.sortBy === "price" ? "min_bid_asc" : "min_bid_asc");
  // Filter by model/backdrop/symbol if provided
  if (params.model) url.searchParams.set("model", params.model);
  if (params.backdrop) url.searchParams.set("backdrop", params.backdrop);
  if (params.symbol) url.searchParams.set("symbol", params.symbol);
  // Price filters (in TON, not nanotons)
  if (params.minPrice) url.searchParams.set("min_price", String(params.minPrice));
  if (params.maxPrice) url.searchParams.set("max_price", String(params.maxPrice));

  const res = await fetch(url.toString(), {
    headers: authHeaders(),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    log.warn(
      { status: res.status, body: errBody.slice(0, 200) },
      "Marketapp gifts/onsale returned error"
    );
    return [];
  }

  const data = (await res.json()) as GiftsOnSaleResponse;
  if (!data?.items?.length) return [];

  return data.items
    .map((g) => {
      const priceTon = extractPrice(g);
      const currency = g.currency || "TON";
      const model = g.model || attrValue(g.attributes, "Model");
      const backdrop = g.backdrop || attrValue(g.attributes, "Backdrop");
      const symbol = g.symbol || attrValue(g.attributes, "Symbol");
      const num = g.item_num ?? g.index;
      return {
        ...g,
        _priceTon: priceTon,
        _currency: currency,
        _model: model,
        _backdrop: backdrop,
        _symbol: symbol,
        _num: num,
      };
    })
    .filter((g) => {
      if (params.maxPrice && g._priceTon && g._priceTon > params.maxPrice) return false;
      if (params.minPrice && g._priceTon && g._priceTon < params.minPrice) return false;
      return true;
    })
    .map(
      (g): MarketplaceListing => ({
        marketplace: "marketapp",
        assetKind: "gift",
        externalId: g.address || `gift-${g._num}`,
        url: `https://marketapp.ws/gift/${g.address || g._num}`,
        identifier: g.name,
        collection: collectionInfo?.name || g.collection_name,
        giftNum: g._num,
        model: g._model,
        backdrop: g._backdrop,
        symbol: g._symbol,
        rarityTier: g.rarity,
        priceTon: g._currency === "TON" || !g._currency ? (g._priceTon ?? null) : null,
        priceStars: g._currency === "Stars" ? (g._priceTon ?? null) : null,
        originalCurrency: g._currency,
        originalPrice: g._priceTon ?? null,
        listingType: "fixed",
        seller: g.seller_address || g.owner,
        onChain: g.is_nft === true || g.on_chain === true || g.type === "nft",
        floorPriceTon: collectionInfo?.floor,
        onSaleCount: collectionInfo?.onSaleAll,
        ownerCount: collectionInfo?.owners,
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
  // For numbers, auto-resolve to "Anonymous Telegram Numbers" collection
  // For usernames, auto-resolve to "Telegram Usernames"
  const query = params.query?.toLowerCase() || params.collection?.toLowerCase();
  let matchedCol: CollectionItem | undefined;

  if (params.assetKind === "number") {
    matchedCol = collections.find((c) => c.name?.toLowerCase().includes("anonymous telegram"));
  } else if (params.assetKind === "username") {
    matchedCol = collections.find((c) => c.name?.toLowerCase().includes("telegram usernames"));
  }

  // If not auto-resolved, try query/collection match
  if (!matchedCol && query) {
    matchedCol = collections.find(
      (c) => c.name?.toLowerCase().includes(query) || c.slug?.toLowerCase().includes(query)
    );
  }

  if (!matchedCol?.address) {
    log.debug(`No collection matched for kind=${params.assetKind}, query=${query}`);
    return [];
  }
  log.debug(`Matched collection: ${matchedCol.name} (${matchedCol.address})`);

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
    .map((n) => {
      // Price can be in sale.price OR min_bid (nanotons)
      const priceTon = extractPrice(n) ?? n.sale?.price ?? null;
      const currency = n.currency || n.sale?.currency || "TON";
      const num = n.item_num ?? n.index;
      return { ...n, _priceTon: priceTon, _currency: currency, _num: num };
    })
    .filter((n) => n._priceTon != null)
    .filter((n) => {
      if (params.maxPrice && n._priceTon && n._priceTon > params.maxPrice) return false;
      if (params.minPrice && n._priceTon && n._priceTon < params.minPrice) return false;
      return true;
    })
    .map(
      (n): MarketplaceListing => ({
        marketplace: "marketapp",
        assetKind: params.assetKind,
        externalId: n.address || `nft-${n._num}`,
        url: `https://marketapp.ws/nft/${n.address}`,
        identifier: n.name,
        collection: matchedCol.name,
        giftNum: n._num,
        model: attrValue(n.attributes, "Model"),
        backdrop: attrValue(n.attributes, "Backdrop"),
        symbol: attrValue(n.attributes, "Symbol"),
        priceTon: n._currency === "TON" || !n._currency ? (n._priceTon ?? null) : null,
        priceStars: n._currency === "Stars" ? (n._priceTon ?? null) : null,
        originalCurrency: n._currency,
        originalPrice: n._priceTon ?? null,
        listingType: "fixed",
        seller: n.owner_address || n.owner,
        onChain: true,
      })
    );
}
