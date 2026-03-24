/**
 * 🏪 Gift Marketplace Aggregator
 *
 * Aggregates gift prices across multiple marketplaces:
 * - Telegram In-App (via GramJS getResaleStarGifts + getUniqueStarGiftValueInfo)
 * - Fragment (HTML scraping, existing infra)
 * - Tonnel (REST API at gifts2.tonnel.network)
 * - Portals (REST API at portal-market.com)
 * - Getgems (via tonapi.io NFT data)
 *
 * Architecture: Each marketplace adapter returns a common MarketplaceListing format.
 * The aggregator merges, deduplicates, and ranks by price.
 */

import { createLogger } from "../../../utils/logger.js";

const log = createLogger("GiftAggregator");

// ─── Types ───────────────────────────────────────────────────────────

export interface GiftListing {
  marketplace: "telegram" | "fragment" | "tonnel" | "portals" | "getgems" | "mrkt";
  giftName: string;
  giftNum?: number;
  model?: string;
  modelRarity?: number; // permille
  backdrop?: string;
  backdropRarity?: number;
  symbol?: string;
  symbolRarity?: number;
  priceTon?: number;
  priceStars?: number;
  priceUsd?: number;
  slug?: string; // for Telegram/Fragment purchase
  url?: string;
  listedAt?: string; // ISO date
  sellerId?: string;
}

export interface FloorPrice {
  marketplace: string;
  priceTon?: number;
  priceStars?: number;
  url?: string;
  listingCount: number;
}

export interface AggregatedResult {
  collection: string;
  model?: string;
  backdrop?: string;
  symbol?: string;
  floors: FloorPrice[];
  bestDeal: FloorPrice | null;
  totalListings: number;
  listings: GiftListing[];
  fetchedAt: string;
  errors: string[];
}

// ─── Cache ───────────────────────────────────────────────────────────

const CACHE_TTL = 3 * 60 * 1000; // 3 minutes
const cache = new Map<string, { data: unknown; ts: number }>();

function cached<T>(key: string): T | null {
  const e = cache.get(key);
  if (!e || Date.now() - e.ts > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return e.data as T;
}

function setCache(key: string, data: unknown) {
  cache.set(key, { data, ts: Date.now() });
}

// ─── Tonnel Adapter ──────────────────────────────────────────────────

const TONNEL_API = "https://gifts2.tonnel.network/api/pageGifts";

async function fetchTonnel(
  giftName: string,
  model?: string,
  limit = 10
): Promise<{ listings: GiftListing[]; error?: string }> {
  try {
    // Build filter
    const filterObj: Record<string, unknown> = {
      price: { $exists: true },
      refunded: { $ne: true },
      buyer: { $exists: false },
      export_at: { $exists: true },
      gift_name: giftName,
      asset: "TON",
    };

    if (model) {
      // Use regex to match model name without needing rarity %
      filterObj.model = { $regex: `^${escapeRegex(model)} \\(` };
    }

    const body = {
      page: 1,
      limit,
      sort: JSON.stringify({ price: 1 }), // cheapest first
      filter: JSON.stringify(filterObj),
      price_range: null,
      user_auth: "",
    };

    const res = await fetch(TONNEL_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://market.tonnel.network",
        Referer: "https://market.tonnel.network/",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      return { listings: [], error: `Tonnel HTTP ${res.status}` };
    }

    const data = await res.json();
    const gifts = (data as { gifts?: TonnelGift[] }).gifts || [];

    return {
      listings: gifts.map((g) => ({
        marketplace: "tonnel" as const,
        giftName: g.gift_name,
        giftNum: g.gift_num,
        model: g.model?.replace(/\s*\([\d.]+%\)\s*$/, ""),
        modelRarity: parseRarityFromLabel(g.model),
        backdrop: g.backdrop?.replace(/\s*\([\d.]+%\)\s*$/, ""),
        backdropRarity: parseRarityFromLabel(g.backdrop),
        symbol: g.pattern?.replace(/\s*\([\d.]+%\)\s*$/, ""),
        symbolRarity: parseRarityFromLabel(g.pattern),
        priceTon: g.price,
        slug:
          g.gift_name && g.gift_num
            ? `${g.gift_name.toLowerCase().replace(/\s+/g, "")}-${g.gift_num}`
            : undefined,
        url: `https://market.tonnel.network/?gift=${encodeURIComponent(g.gift_name)}`,
        listedAt: g.export_at,
        sellerId: g.owner_id?.toString(),
      })),
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`Tonnel fetch failed: ${msg}`);
    return { listings: [], error: `Tonnel: ${msg}` };
  }
}

interface TonnelGift {
  gift_name: string;
  gift_num?: number;
  model?: string;
  backdrop?: string;
  pattern?: string;
  price: number;
  export_at?: string;
  owner_id?: number;
}

// ─── Portals Adapter ─────────────────────────────────────────────────

const PORTALS_COLLECTIONS_API = "https://portal-market.com/api/collections";
const PORTALS_SEARCH_API = "https://portal-market.com/api/gifts/search";

async function fetchPortals(
  giftName: string,
  model?: string,
  limit = 10
): Promise<{ listings: GiftListing[]; floor?: number; error?: string }> {
  try {
    // First get collection floor price (no auth needed for this)
    const collUrl = `${PORTALS_COLLECTIONS_API}?search=${encodeURIComponent(giftName)}&limit=1`;
    const collRes = await fetch(collUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!collRes.ok) {
      return { listings: [], error: `Portals HTTP ${collRes.status}` };
    }

    const collData = (await collRes.json()) as { collections?: PortalsCollection[] };
    const collection = collData.collections?.[0];

    if (!collection) {
      return { listings: [], error: "Not found on Portals" };
    }

    // Search for specific gifts (may need auth for full search)
    const searchUrl = `${PORTALS_SEARCH_API}?gift_name=${encodeURIComponent(giftName)}${model ? `&model=${encodeURIComponent(model)}` : ""}&limit=${limit}&sort=price_asc`;
    let listings: GiftListing[] = [];

    try {
      const searchRes = await fetch(searchUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        },
        signal: AbortSignal.timeout(10000),
      });

      if (searchRes.ok) {
        const searchData = (await searchRes.json()) as PortalsGift[];
        listings = (Array.isArray(searchData) ? searchData : []).map((g) => ({
          marketplace: "portals" as const,
          giftName: g.name,
          giftNum: g.tg_id,
          model: g.attributes?.find((a: PortalsAttribute) => a.type === "model")?.value,
          modelRarity: g.attributes?.find((a: PortalsAttribute) => a.type === "model")
            ?.rarity_per_mille,
          backdrop: g.attributes?.find((a: PortalsAttribute) => a.type === "backdrop")?.value,
          backdropRarity: g.attributes?.find((a: PortalsAttribute) => a.type === "backdrop")
            ?.rarity_per_mille,
          symbol: g.attributes?.find((a: PortalsAttribute) => a.type === "symbol")?.value,
          symbolRarity: g.attributes?.find((a: PortalsAttribute) => a.type === "symbol")
            ?.rarity_per_mille,
          priceTon: g.price ? parseFloat(g.price) : undefined,
          url: `https://t.me/portals/portals`,
          listedAt: g.listed_at,
        }));
      }
    } catch {
      // Search may fail without auth — that's OK, we still have floor price
    }

    return {
      listings,
      floor: collection.floor_price ? parseFloat(collection.floor_price) : undefined,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`Portals fetch failed: ${msg}`);
    return { listings: [], error: `Portals: ${msg}` };
  }
}

interface PortalsCollection {
  floor_price?: string;
  name?: string;
  total_listed?: number;
}

interface PortalsAttribute {
  type: string;
  value: string;
  rarity_per_mille?: number;
}

interface PortalsGift {
  name: string;
  tg_id?: number;
  price?: string;
  attributes?: PortalsAttribute[];
  listed_at?: string;
}

// ─── Fragment Adapter ────────────────────────────────────────────────

async function fetchFragment(
  giftName: string,
  _model?: string,
  limit = 10
): Promise<{ listings: GiftListing[]; error?: string }> {
  try {
    // Fragment gift listings via HTML scraping
    const slug = giftName.toLowerCase().replace(/['']/g, "").replace(/\s+/g, "-");
    const url = `https://fragment.com/gift/${slug}`;

    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      return { listings: [], error: `Fragment HTTP ${res.status}` };
    }

    const html = await res.text();

    // Extract listings from Fragment's HTML (price + gift number)
    const listings: GiftListing[] = [];
    const priceRegex = /data-price="([\d.]+)"/g;
    const numRegex = /data-num="(\d+)"/g;

    const prices: number[] = [];
    let match;
    while ((match = priceRegex.exec(html)) !== null) {
      prices.push(parseFloat(match[1]));
    }

    const nums: number[] = [];
    while ((match = numRegex.exec(html)) !== null) {
      nums.push(parseInt(match[1]));
    }

    const count = Math.min(prices.length, nums.length, limit);
    for (let i = 0; i < count; i++) {
      listings.push({
        marketplace: "fragment",
        giftName,
        giftNum: nums[i],
        priceTon: prices[i],
        slug: `${slug}-${nums[i]}`,
        url: `https://fragment.com/gift/${slug}/${nums[i]}`,
      });
    }

    return { listings };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`Fragment fetch failed: ${msg}`);
    return { listings: [], error: `Fragment: ${msg}` };
  }
}

// ─── Getgems Adapter (via tonapi) ────────────────────────────────────

async function fetchGetgems(
  giftName: string,
  _model?: string,
  _limit = 10
): Promise<{ listings: GiftListing[]; error?: string }> {
  try {
    // Getgems uses tonapi for NFT data — we query collection floor
    // Collection addresses need mapping; for now return empty
    // TODO: Map gift collection names to TON NFT collection addresses
    return { listings: [], error: "Getgems: address mapping not yet implemented" };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { listings: [], error: `Getgems: ${msg}` };
  }
}

// ─── Aggregator ──────────────────────────────────────────────────────

export async function aggregateGiftPrices(
  giftName: string,
  opts?: {
    model?: string;
    backdrop?: string;
    symbol?: string;
    limit?: number;
    marketplaces?: string[];
  }
): Promise<AggregatedResult> {
  const { model, backdrop, symbol, limit = 10 } = opts || {};
  const enabledMarkets = opts?.marketplaces || ["tonnel", "portals", "fragment"];

  const cacheKey = `agg:${giftName}:${model || ""}:${backdrop || ""}:${symbol || ""}`;
  const hit = cached<AggregatedResult>(cacheKey);
  if (hit) return hit;

  const errors: string[] = [];
  let allListings: GiftListing[] = [];

  // Fetch all marketplaces in parallel
  const fetchers: Promise<void>[] = [];

  if (enabledMarkets.includes("tonnel")) {
    fetchers.push(
      fetchTonnel(giftName, model, limit).then((r) => {
        allListings.push(...r.listings);
        if (r.error) errors.push(r.error);
      })
    );
  }

  if (enabledMarkets.includes("portals")) {
    fetchers.push(
      fetchPortals(giftName, model, limit).then((r) => {
        allListings.push(...r.listings);
        if (r.error) errors.push(r.error);
      })
    );
  }

  if (enabledMarkets.includes("fragment")) {
    fetchers.push(
      fetchFragment(giftName, model, limit).then((r) => {
        allListings.push(...r.listings);
        if (r.error) errors.push(r.error);
      })
    );
  }

  if (enabledMarkets.includes("getgems")) {
    fetchers.push(
      fetchGetgems(giftName, model, limit).then((r) => {
        allListings.push(...r.listings);
        if (r.error) errors.push(r.error);
      })
    );
  }

  await Promise.allSettled(fetchers);

  // Filter by backdrop/symbol if specified
  if (backdrop) {
    allListings = allListings.filter(
      (l) => !l.backdrop || l.backdrop.toLowerCase() === backdrop.toLowerCase()
    );
  }
  if (symbol) {
    allListings = allListings.filter(
      (l) => !l.symbol || l.symbol.toLowerCase() === symbol.toLowerCase()
    );
  }

  // Sort by price (TON)
  allListings.sort((a, b) => (a.priceTon ?? Infinity) - (b.priceTon ?? Infinity));

  // Calculate floor per marketplace
  const floorMap = new Map<string, FloorPrice>();
  for (const listing of allListings) {
    const existing = floorMap.get(listing.marketplace);
    if (!existing) {
      floorMap.set(listing.marketplace, {
        marketplace: listing.marketplace,
        priceTon: listing.priceTon,
        priceStars: listing.priceStars,
        url: listing.url,
        listingCount: 1,
      });
    } else {
      existing.listingCount++;
      if (listing.priceTon && (!existing.priceTon || listing.priceTon < existing.priceTon)) {
        existing.priceTon = listing.priceTon;
        existing.url = listing.url;
      }
    }
  }

  const floors = Array.from(floorMap.values()).sort(
    (a, b) => (a.priceTon ?? Infinity) - (b.priceTon ?? Infinity)
  );

  const result: AggregatedResult = {
    collection: giftName,
    model,
    backdrop,
    symbol,
    floors,
    bestDeal: floors[0] || null,
    totalListings: allListings.length,
    listings: allListings.slice(0, limit),
    fetchedAt: new Date().toISOString(),
    errors,
  };

  setCache(cacheKey, result);
  return result;
}

/**
 * Quick floor price comparison across all marketplaces.
 * Lighter than full aggregation — just floors, no individual listings.
 */
export async function compareFloorPrices(
  giftName: string
): Promise<{ floors: FloorPrice[]; bestDeal: FloorPrice | null; errors: string[] }> {
  const result = await aggregateGiftPrices(giftName, { limit: 1 });
  return {
    floors: result.floors,
    bestDeal: result.bestDeal,
    errors: result.errors,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseRarityFromLabel(label?: string): number | undefined {
  if (!label) return undefined;
  const m = label.match(/\(([\d.]+)%\)/);
  return m ? parseFloat(m[1]) * 10 : undefined; // convert to permille
}
