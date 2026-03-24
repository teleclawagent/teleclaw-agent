/**
 * 🏪 Fragment Marketplace Scraper
 *
 * Scrapes Fragment.com for gift prices, listings, and sales.
 * No API key needed — HTML scraping with 3-minute cache.
 * This is the primary data source until marketplace API keys are added.
 */

import { createLogger } from "../../../utils/logger.js";

const log = createLogger("FragmentScraper");

const FRAGMENT_BASE = "https://fragment.com";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const CACHE_TTL = 3 * 60 * 1000; // 3 minutes

// ─── Cache ───────────────────────────────────────────────────────────

interface CacheEntry<T> {
  data: T;
  ts: number;
}

const cache = new Map<string, CacheEntry<unknown>>();

function getCached<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry || Date.now() - entry.ts > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return entry.data as T;
}

function setCache<T>(key: string, data: T): void {
  cache.set(key, { data, ts: Date.now() });
}

// ─── Fetch Helper ────────────────────────────────────────────────────

async function fetchFragment(path: string): Promise<string> {
  const url = `${FRAGMENT_BASE}${path}`;
  let res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "no-cache",
    },
  });

  // Retry once on transient failures
  if (!res.ok && (res.status === 429 || res.status === 502 || res.status === 503)) {
    await new Promise((r) => setTimeout(r, 2000));
    res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
  }

  if (!res.ok) throw new Error(`Fragment ${res.status}: ${url}`);
  return res.text();
}

// ─── Types ───────────────────────────────────────────────────────────

export interface FragmentListing {
  slug: string; // e.g. "plushpepe-1213"
  giftNum: number;
  priceTon: number;
  url: string;
}

export interface FragmentFloorData {
  collection: string;
  slug: string;
  floorTon: number | null;
  listingCount: number;
  highestTon: number | null;
  fetchedAt: string;
}

export interface FragmentSale {
  slug: string;
  giftNum: number;
  priceTon: number;
  url: string;
  soldAt?: string;
}

// ─── Slug Resolver ───────────────────────────────────────────────────

let _slugMap: Map<string, string> | null = null;

function _loadSlugMap(): Map<string, string> {
  if (_slugMap) return _slugMap;
  _slugMap = new Map();
  return _slugMap;
}

/**
 * Resolve a collection name to a Fragment slug.
 * e.g. "Plush Pepe" -> "plushpepe"
 */
export async function resolveSlug(collectionName: string): Promise<string | null> {
  const cacheKey = `slug:${collectionName}`;
  const cached = getCached<string>(cacheKey);
  if (cached) return cached;

  // Try direct lowercase no-space conversion first (covers most cases)
  const guess = collectionName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .replace(/\s+/g, "");

  // Verify by fetching the page
  try {
    const html = await fetchFragment(`/gifts/${guess}`);
    if (html.includes("tm-value") || html.includes("tm-section-header")) {
      setCache(cacheKey, guess);
      return guess;
    }
  } catch {
    // Try with common variations
  }

  // Try other patterns
  const variations = [
    collectionName.toLowerCase().replace(/[^a-z0-9]/g, ""),
    collectionName
      .toLowerCase()
      .replace(/\s+/g, "")
      .replace(/[^a-z0-9]/g, ""),
    collectionName.toLowerCase().replace(/[']/g, "").replace(/\s+/g, ""),
  ];

  for (const v of variations) {
    if (v === guess) continue;
    try {
      const html = await fetchFragment(`/gifts/${v}`);
      if (html.includes("tm-value") || html.includes("tm-section-header")) {
        setCache(cacheKey, v);
        return v;
      }
    } catch {
      continue;
    }
  }

  log.warn({ collection: collectionName }, "Could not resolve Fragment slug");
  return null;
}

// ─── All Collection Slugs ────────────────────────────────────────────

let _allSlugs: string[] | null = null;

export async function getAllCollectionSlugs(): Promise<string[]> {
  if (_allSlugs) return _allSlugs;

  const cacheKey = "all-slugs";
  const cached = getCached<string[]>(cacheKey);
  if (cached) return cached;

  try {
    const html = await fetchFragment("/gifts");
    const matches = html.match(/href="\/gifts\/([a-z0-9]+)"/g) || [];
    const slugs = [...new Set(matches.map((m) => m.replace('href="/gifts/', "").replace('"', "")))];
    _allSlugs = slugs;
    setCache(cacheKey, slugs);
    return slugs;
  } catch (err) {
    log.error({ err }, "Failed to fetch collection slugs");
    return [];
  }
}

// ─── Floor Price ─────────────────────────────────────────────────────

export async function fetchFloorPrice(slugOrName: string): Promise<FragmentFloorData | null> {
  // Determine if input is a slug or name
  const slug = slugOrName.toLowerCase().replace(/[^a-z0-9]/g, "");

  const cacheKey = `floor:${slug}`;
  const cached = getCached<FragmentFloorData>(cacheKey);
  if (cached) return cached;

  try {
    const html = await fetchFragment(`/gifts/${slug}?sort=price_asc&filter=sale`);

    // Extract prices from tm-value spans
    const priceMatches = html.match(/tm-value[^"]*">([\d,]+)/g) || [];
    const prices = priceMatches
      .map((m) => {
        const match = m.match(/([\d,]+)/);
        return match ? parseInt(match[1].replace(/,/g, ""), 10) : null;
      })
      .filter((p): p is number => p !== null && p > 0);

    // Extract collection display name
    const titleMatch = html.match(/<title>([^–<]+)/);
    const displayName = titleMatch ? titleMatch[1].trim() : slugOrName;

    // Count listings (each href="/gift/{slug}-{num}" is a listing)
    const listingMatches = html.match(/href="\/gift\/[^"]+"/g) || [];
    const listingCount = listingMatches.length;

    const result: FragmentFloorData = {
      collection: displayName,
      slug,
      floorTon: prices.length > 0 ? Math.min(...prices) : null,
      listingCount,
      highestTon: prices.length > 0 ? Math.max(...prices) : null,
      fetchedAt: new Date().toISOString(),
    };

    setCache(cacheKey, result);
    return result;
  } catch (err) {
    log.error({ err, slug }, "Failed to fetch floor price");
    return null;
  }
}

// ─── Listings ────────────────────────────────────────────────────────

export async function fetchListings(slugOrName: string, limit = 20): Promise<FragmentListing[]> {
  const slug = slugOrName.toLowerCase().replace(/[^a-z0-9]/g, "");

  const cacheKey = `listings:${slug}:${limit}`;
  const cached = getCached<FragmentListing[]>(cacheKey);
  if (cached) return cached;

  try {
    const html = await fetchFragment(`/gifts/${slug}?sort=price_asc&filter=sale`);

    // Extract listing entries: href="/gift/{slug}-{num}" followed by a price
    const pattern = /href="\/gift\/([\w-]+?)(?:\?[^"]*)?"[\s\S]*?tm-value[^"]*">([\d,]+)/g;
    const listings: FragmentListing[] = [];
    let match;

    while ((match = pattern.exec(html)) !== null && listings.length < limit) {
      const fullSlug = match[1];
      const price = parseInt(match[2].replace(/,/g, ""), 10);
      const numMatch = fullSlug.match(/-(\d+)$/);
      const giftNum = numMatch ? parseInt(numMatch[1], 10) : 0;

      listings.push({
        slug: fullSlug,
        giftNum,
        priceTon: price,
        url: `${FRAGMENT_BASE}/gift/${fullSlug}`,
      });
    }

    setCache(cacheKey, listings);
    return listings;
  } catch (err) {
    log.error({ err, slug }, "Failed to fetch listings");
    return [];
  }
}

// ─── Recent Sales ────────────────────────────────────────────────────

export async function fetchRecentSales(slugOrName: string, limit = 20): Promise<FragmentSale[]> {
  const slug = slugOrName.toLowerCase().replace(/[^a-z0-9]/g, "");

  const cacheKey = `sales:${slug}:${limit}`;
  const cached = getCached<FragmentSale[]>(cacheKey);
  if (cached) return cached;

  try {
    const html = await fetchFragment(`/gifts/${slug}?sort=price_asc&filter=sold`);

    const pattern = /href="\/gift\/([\w-]+?)(?:\?[^"]*)?"[\s\S]*?tm-value[^"]*">([\d,]+)/g;
    const sales: FragmentSale[] = [];
    let match;

    while ((match = pattern.exec(html)) !== null && sales.length < limit) {
      const fullSlug = match[1];
      const price = parseInt(match[2].replace(/,/g, ""), 10);
      const numMatch = fullSlug.match(/-(\d+)$/);
      const giftNum = numMatch ? parseInt(numMatch[1], 10) : 0;

      sales.push({
        slug: fullSlug,
        giftNum,
        priceTon: price,
        url: `${FRAGMENT_BASE}/gift/${fullSlug}`,
      });
    }

    setCache(cacheKey, sales);
    return sales;
  } catch (err) {
    log.error({ err, slug }, "Failed to fetch recent sales");
    return [];
  }
}

// ─── All Floors (batch) ─────────────────────────────────────────────

export async function fetchAllFloorPrices(): Promise<FragmentFloorData[]> {
  const cacheKey = "all-floors";
  const cached = getCached<FragmentFloorData[]>(cacheKey);
  if (cached) return cached;

  const slugs = await getAllCollectionSlugs();
  const results: FragmentFloorData[] = [];

  // Process in batches of 5 to avoid rate limiting
  for (let i = 0; i < slugs.length; i += 5) {
    const batch = slugs.slice(i, i + 5);
    const batchResults = await Promise.allSettled(batch.map((slug) => fetchFloorPrice(slug)));

    for (const result of batchResults) {
      if (result.status === "fulfilled" && result.value) {
        results.push(result.value);
      }
    }

    // Small delay between batches
    if (i + 5 < slugs.length) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  setCache(cacheKey, results);
  return results;
}
