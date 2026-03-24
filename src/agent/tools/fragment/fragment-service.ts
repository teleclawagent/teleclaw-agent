/**
 * Fragment.com scraping service for Telegram usernames & anonymous numbers.
 *
 * Fragment has no official API — we scrape their internal API endpoints
 * which return HTML fragments via POST requests.
 *
 * Data flow: Fragment HTML → cheerio parse → structured data → cache
 */

import * as cheerio from "cheerio";
import { fetchWithTimeout } from "../../../utils/fetch.js";
import { tonapiFetch } from "../../../constants/api-endpoints.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("Fragment");

const FRAGMENT_BASE = "https://fragment.com";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const REQUEST_DELAY_MS = 2000; // 2s between requests to avoid bans

// ─── Types ───────────────────────────────────────────────────────────

export interface MarketplaceListing {
  marketplace: "fragment" | "getgems" | "marketapp" | "unknown";
  saleType: "auction" | "fixed_price";
  price: number; // TON
  url: string;
  marketAddress?: string;
}

export interface FragmentUsername {
  username: string;
  status: "auction" | "sale" | "sold" | "unavailable" | "available";
  price?: string; // e.g. "150 TON"
  priceRaw?: number; // numeric TON value
  bids?: number;
  endsAt?: string; // ISO date
  owner?: string; // wallet address
  nftAddress?: string; // NFT item address on TON
  url: string;
  /** All active listings across marketplaces */
  marketplaceListings?: MarketplaceListing[];
}

export interface FragmentSaleHistory {
  username: string;
  soldPrice: number; // in TON
  soldDate: string;
  buyer?: string;
}

export interface MarketStats {
  totalListings: number;
  avgPrice: number;
  medianPrice: number;
  minPrice: number;
  maxPrice: number;
  recentSales: FragmentSaleHistory[];
  trending: FragmentUsername[];
  fetchedAt: string;
}

// ─── Cache ───────────────────────────────────────────────────────────

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

const cache = new Map<string, CacheEntry<unknown>>();

function getCached<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.data as T;
}

function setCache<T>(key: string, data: T): void {
  cache.set(key, { data, timestamp: Date.now() });
}

// ─── Rate Limiter ────────────────────────────────────────────────────

let lastRequestTime = 0;

async function rateLimitedFetch(url: string, init?: RequestInit): Promise<Response> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < REQUEST_DELAY_MS) {
    await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS - elapsed));
  }
  lastRequestTime = Date.now();

  return fetchWithTimeout(url, {
    ...init,
    timeoutMs: 15000,
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: "https://fragment.com/",
      ...(init?.headers as Record<string, string>),
    },
  });
}

// ─── Parsers ─────────────────────────────────────────────────────────

function parsePrice(text: string): { display: string; raw: number } | null {
  if (!text) return null;
  const cleaned = text.replace(/,/g, "").trim();
  // Match TON amounts (with or without "TON" suffix)
  const match = cleaned.match(/([\d.]+)\s*TON/i);
  if (match) {
    return { display: `${match[1]} TON`, raw: parseFloat(match[1]) };
  }
  // Fragment shows prices as plain numbers (e.g. "47,250" without TON)
  const numMatch = cleaned.match(/^([\d.]+)$/);
  if (numMatch) {
    return { display: `${numMatch[1]} TON`, raw: parseFloat(numMatch[1]) };
  }
  return null;
}

function parseEndTime(text: string): string | null {
  if (!text) return null;
  // Fragment shows "ends in Xh Ym" or a date
  const now = Date.now();
  const hoursMatch = text.match(/(\d+)h/);
  const minsMatch = text.match(/(\d+)m/);
  if (hoursMatch || minsMatch) {
    const hours = hoursMatch ? parseInt(hoursMatch[1]) : 0;
    const mins = minsMatch ? parseInt(minsMatch[1]) : 0;
    const endMs = now + (hours * 3600 + mins * 60) * 1000;
    return new Date(endMs).toISOString();
  }
  return null;
}

// ─── Core Fetch Methods ──────────────────────────────────────────────

/**
 * Fetch username listings from Fragment.
 * type: "auction" | "sale" | "sold"
 * sort: "price_asc" | "price_desc" | "ending_soon" | "recent"
 */
export async function fetchUsernames(
  type: "auction" | "sale" | "sold" = "sale",
  sort: string = "recent",
  limit: number = 50
): Promise<FragmentUsername[]> {
  const cacheKey = `usernames:${type}:${sort}:${limit}`;
  const cached = getCached<FragmentUsername[]>(cacheKey);
  if (cached) return cached;

  try {
    const url = `${FRAGMENT_BASE}?sort=${sort}&filter=${type}`;
    const response = await rateLimitedFetch(url);

    if (!response.ok) {
      log.error(`Fragment fetch failed: ${response.status}`);
      return [];
    }

    const html = await response.text();
    const $ = cheerio.load(html);
    const results: FragmentUsername[] = [];
    const seen = new Set<string>();

    // Fragment structure: tr.tm-row-selectable > td(username) > td(price) > td(time)
    $("tr.tm-row-selectable").each((_i, el) => {
      const $row = $(el);
      const tds = $row.find("td");
      if (tds.length < 2) return;

      // TD[0]: username
      const link = tds.eq(0).find("a[href*='/username/']").first();
      const href = link.attr("href") || "";
      const usernameMatch = href.match(/\/username\/(\w+)/);
      if (!usernameMatch) return;

      const username = usernameMatch[1];
      if (seen.has(username)) return;
      seen.add(username);

      // TD[1]: price (first .table-cell-value in second td)
      const priceText = tds.eq(1).find(".table-cell-value").first().text().trim();
      const price = parsePrice(priceText);

      // TD[1] or TD[2]: time info
      const timeText =
        tds.length >= 3
          ? tds.eq(2).find(".table-cell-value").first().text().trim()
          : tds.eq(1).find(".table-cell-desc.thin-only").text().trim();
      const endTime = parseEndTime(timeText);

      const entry: FragmentUsername = {
        username: `@${username}`,
        status: type,
        url: `${FRAGMENT_BASE}/username/${username}`,
      };

      if (price) {
        entry.price = price.display;
        entry.priceRaw = price.raw;
      }
      if (endTime) {
        entry.endsAt = endTime;
      }

      results.push(entry);
    });

    const limited = results.slice(0, limit);
    setCache(cacheKey, limited);
    return limited;
  } catch (error) {
    log.error({ err: error }, "Fragment username fetch error");
    return [];
  }
}

/**
 * Get details for a specific username from Fragment.
 */
export async function checkUsername(username: string): Promise<FragmentUsername | null> {
  const clean = username.replace(/^@/, "").toLowerCase();
  const cacheKey = `username:${clean}`;
  const cached = getCached<FragmentUsername>(cacheKey);
  if (cached) return cached;

  try {
    const url = `${FRAGMENT_BASE}/username/${clean}`;
    const response = await rateLimitedFetch(url);

    if (!response.ok) {
      if (response.status === 404) {
        return {
          username: `@${clean}`,
          status: "available",
          url,
        };
      }
      return null;
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // Extract status from .tm-section-header-status
    const statusText = $(".tm-section-header-status").text().trim().toLowerCase();
    const statusClass = $(".tm-section-header-status").attr("class") || "";
    let status: FragmentUsername["status"] = "unavailable";
    if (statusText.includes("auction") || statusClass.includes("tm-status-avail")) {
      status = "auction";
    } else if (statusText.includes("sale")) {
      status = "sale";
    } else if (statusText.includes("sold")) {
      status = "sold";
    } else if (statusText.includes("taken")) {
      status = "unavailable"; // Owned but not for sale
    } else if (statusText.includes("available")) {
      status = "available";
    }

    // Extract price — first .table-cell-value.tm-value with icon-ton class
    const priceEl = $(".tm-section-bid-info .table-cell-value.icon-before.icon-ton").first();
    const price = parsePrice(priceEl.text().trim());

    // Extract owner from tonviewer link
    const ownerEl = $("a[href*='tonviewer.com']").first();
    const ownerHref = ownerEl.attr("href") || "";
    const owner = ownerHref ? ownerHref.split("/").pop() : undefined;

    // Extract bids
    const pageText = $("body").text();
    const bidsMatch = pageText.match(/(\d+)\s*bid/i);

    const result: FragmentUsername = {
      username: `@${clean}`,
      status,
      price: price?.display,
      priceRaw: price?.raw,
      bids: bidsMatch ? parseInt(bidsMatch[1]) : undefined,
      owner,
      url,
    };

    // End time from countdown section
    const timeText = $(".tm-section-countdown-wrap .table-cell-value").first().text().trim();
    const endTime = parseEndTime(timeText);
    if (endTime) result.endsAt = endTime;

    // ── Multi-marketplace enrichment ──
    // If username is owned (sold/unavailable), check secondary markets via TonAPI
    if (result.owner && (result.status === "sold" || result.status === "unavailable")) {
      try {
        const enriched = await checkSecondaryMarkets(clean, result.owner);
        if (enriched) {
          result.nftAddress = enriched.nftAddress;
          result.marketplaceListings = enriched.listings;
          // If listed on a secondary market, update status
          if (enriched.listings.length > 0) {
            result.status = "sale";
            const cheapest = enriched.listings.reduce(
              (min, l) => (l.price < min.price ? l : min),
              enriched.listings[0]
            );
            result.price = `${cheapest.price} TON`;
            result.priceRaw = cheapest.price;
          }
        }
      } catch (err) {
        log.warn({ err, username: clean }, "Secondary market check failed (non-fatal)");
      }
    }

    setCache(cacheKey, result);
    return result;
  } catch (error) {
    log.error({ err: error }, `Fragment check error for @${clean}`);
    return null;
  }
}

// ─── Secondary Market Lookup (GetGems, MarketApp, etc.) ──────────────

/** Telegram Usernames NFT collection address */
const TG_USERNAME_COLLECTION = "EQCA14o1-VWhS2efqoh_9M1b_A9DtKTuoqfmkn83AbJzwnPi";

/** Known marketplace addresses → names */
const KNOWN_MARKETPLACES: Record<string, MarketplaceListing["marketplace"]> = {
  "0:584ee61b2dff0837116d0fcb5078d93964bcbe9c05fd6a141b1bfca5d6a43e18": "getgems",
  // MarketApp proxy contract (marketapp-proxy.ton) — routes buy transactions via 0x3f2b92d2
  // MarketApp often deploys GetGems-compatible sale contracts, so sales may appear as GetGems
  // on TonAPI. This proxy address catches cases where MarketApp is the direct market.
  "0:98080fb8ee500ba6cf74c6814520f5739ceb221e5595285ddc1030a12a03f725": "marketapp",
  // Fragment auctions use a different mechanism (not NFT sale contracts)
};

interface SecondaryMarketResult {
  nftAddress: string;
  listings: MarketplaceListing[];
}

/**
 * Check if a username is listed on secondary markets (GetGems, MarketApp, etc.)
 * by querying TonAPI for the owner's NFT sale status.
 *
 * Flow:
 * 1. Find the username NFT in the owner's holdings (Telegram Usernames collection)
 * 2. If the NFT has a `sale` object, extract marketplace info
 */
async function checkSecondaryMarkets(
  username: string,
  ownerAddress: string
): Promise<SecondaryMarketResult | null> {
  const clean = username.replace(/^@/, "").toLowerCase();

  try {
    // Query owner's NFTs in the Telegram Usernames collection
    const response = await tonapiFetch(
      `/accounts/${encodeURIComponent(ownerAddress)}/nfts?collection=${encodeURIComponent(TG_USERNAME_COLLECTION)}&limit=50`
    );

    if (!response.ok) {
      log.warn({ status: response.status, ownerAddress }, "TonAPI NFT query failed");
      return null;
    }

    const data = await response.json();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TonAPI response is untyped
    const items: any[] = data.nft_items || [];

    // Find the specific username NFT
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TonAPI response is untyped
    const nftItem = items.find((item: any) => {
      const name = (item.metadata?.name || "").replace(/^@/, "").toLowerCase();
      return name === clean;
    });

    if (!nftItem) {
      // Owner might have transferred it, or different collection format
      log.debug({ username: clean, ownerAddress }, "Username NFT not found in owner's holdings");
      return null;
    }

    const nftAddress = nftItem.address;
    const listings: MarketplaceListing[] = [];

    // Check if NFT has an active sale
    if (nftItem.sale) {
      const sale = nftItem.sale;
      const marketAddress = sale.market?.address || "";
      const marketName = sale.market?.name || "";
      const priceRaw = parseInt(sale.price?.value || "0");
      const priceTon = priceRaw / 1e9;

      // Determine marketplace
      let marketplace: MarketplaceListing["marketplace"] =
        KNOWN_MARKETPLACES[marketAddress] || "unknown";

      // Fallback: identify by market name
      if (marketplace === "unknown") {
        const nameLower = marketName.toLowerCase();
        if (nameLower.includes("getgems")) marketplace = "getgems";
        else if (nameLower.includes("fragment")) marketplace = "fragment";
        else if (nameLower.includes("market")) marketplace = "marketapp";
      }

      // Determine sale type (GetGems can do fixed price, Fragment is always auction)
      // On-chain: if it's a Getgems sale contract, check if it has auction fields
      // For now: Fragment = auction, GetGems = fixed_price (most common), others = fixed_price
      const saleType: MarketplaceListing["saleType"] =
        marketplace === "fragment" ? "auction" : "fixed_price";

      // Build marketplace URL
      let url: string;
      switch (marketplace) {
        case "getgems":
          url = `https://getgems.io/nft/${nftAddress}`;
          break;
        case "marketapp":
          url = `https://marketapp.ws/nft/${nftAddress}`;
          break;
        case "fragment":
          url = `https://fragment.com/username/${clean}`;
          break;
        default:
          url = `https://tonviewer.com/${nftAddress}`;
      }

      listings.push({
        marketplace,
        saleType,
        price: priceTon,
        url,
        marketAddress,
      });
    }

    return { nftAddress, listings };
  } catch (error) {
    log.error({ err: error, username: clean }, "Secondary market check error");
    return null;
  }
}

/**
 * Fetch sold username history for price analysis.
 */
export async function fetchSoldHistory(limit: number = 100): Promise<FragmentSaleHistory[]> {
  const cacheKey = `sold_history:${limit}`;
  const cached = getCached<FragmentSaleHistory[]>(cacheKey);
  if (cached) return cached;

  const listings = await fetchUsernames("sold", "recent", limit);
  const history: FragmentSaleHistory[] = listings
    .filter((l) => l.priceRaw !== undefined)
    .map((l) => ({
      username: l.username,
      soldPrice: l.priceRaw ?? 0,
      soldDate: new Date().toISOString(), // Fragment doesn't always show exact date in list view
      buyer: l.owner,
    }));

  setCache(cacheKey, history);
  return history;
}

/**
 * Get market statistics for username valuations.
 */
export async function getMarketStats(): Promise<MarketStats> {
  const cacheKey = "market_stats";
  const cached = getCached<MarketStats>(cacheKey);
  if (cached) return cached;

  const [salesData, auctionData, saleData] = await Promise.all([
    fetchSoldHistory(100),
    fetchUsernames("auction", "ending_soon", 30),
    fetchUsernames("sale", "price_asc", 30),
  ]);

  const prices = salesData.map((s) => s.soldPrice).sort((a, b) => a - b);

  const stats: MarketStats = {
    totalListings: auctionData.length + saleData.length,
    avgPrice: prices.length > 0 ? prices.reduce((a, b) => a + b, 0) / prices.length : 0,
    medianPrice: prices.length > 0 ? prices[Math.floor(prices.length / 2)] : 0,
    minPrice: prices.length > 0 ? prices[0] : 0,
    maxPrice: prices.length > 0 ? prices[prices.length - 1] : 0,
    recentSales: salesData.slice(0, 10),
    trending: auctionData
      .filter((a) => (a.bids ?? 0) > 1)
      .sort((a, b) => (b.bids ?? 0) - (a.bids ?? 0))
      .slice(0, 10),
    fetchedAt: new Date().toISOString(),
  };

  setCache(cacheKey, stats);
  return stats;
}

/**
 * Estimate username value based on characteristics and market data.
 */
export async function estimateValue(username: string): Promise<{
  estimated: { low: number; mid: number; high: number };
  factors: string[];
  confidence: "low" | "medium" | "high";
  comparables: FragmentSaleHistory[];
}> {
  const clean = username.replace(/^@/, "").toLowerCase();
  const len = clean.length;

  // Get market data for comparisons
  const soldHistory = await fetchSoldHistory(100);

  // Classify the username quality
  const isReadableWord = /^[a-z]+$/.test(clean) && clean.length >= 3;
  const isNumeric = /^\d+$/.test(clean);
  const isMixed = /[a-z]/.test(clean) && /\d/.test(clean); // e.g. "hvvtb13"
  const isGibberish =
    !isReadableWord && !isNumeric && !isMixed
      ? true
      : isMixed && !/^[a-z]+\d+$/.test(clean) && !/^\d+[a-z]+$/.test(clean); // random mix like "hvvtb13"

  // Find comparable sales — match by length AND quality tier
  const comparables = soldHistory.filter((s) => {
    const sClean = s.username.replace(/^@/, "").toLowerCase();
    const sLen = sClean.length;
    if (Math.abs(sLen - len) > 1) return false;

    // Don't compare gibberish usernames against dictionary words
    const sIsReadable = /^[a-z]+$/.test(sClean);
    const sIsNumeric = /^\d+$/.test(sClean);
    if (isGibberish && sIsReadable) return false; // Don't compare "hvvtb13" against "casino"
    if (isNumeric && !sIsNumeric) return false; // Don't compare "88888" against "hello"
    if (isReadableWord && !sIsReadable && !sIsNumeric) return false;

    return true;
  });

  const factors: string[] = [];
  let multiplier = 1;

  // Length factor (shorter = more valuable)
  if (len <= 3) {
    multiplier += 8;
    factors.push("Ultra-short (≤3 chars) — very rare");
  } else if (len === 4) {
    multiplier += 4;
    factors.push("4-letter — premium category");
  } else if (len === 5) {
    multiplier += 2;
    factors.push("5-letter — high demand");
  } else if (len <= 7) {
    multiplier += 0.5;
    factors.push("6-7 letter — moderate demand");
  } else {
    multiplier += 0;
    factors.push("8+ chars — standard");
  }

  // Dictionary word check (basic)
  const commonWords = [
    "wallet",
    "crypto",
    "trade",
    "bank",
    "coin",
    "token",
    "swap",
    "pay",
    "cash",
    "money",
    "gold",
    "gem",
    "star",
    "moon",
    "sun",
    "fire",
    "king",
    "boss",
    "pro",
    "vip",
    "top",
    "best",
    "mega",
    "super",
    "ton",
    "nft",
    "defi",
    "dao",
    "web3",
    "ai",
    "bot",
    "dev",
    "app",
    "game",
    "play",
    "bet",
    "win",
    "rich",
    "club",
    "shop",
    "news",
    "tech",
  ];
  const isWord = commonWords.some((w) => clean === w || clean.startsWith(w) || clean.endsWith(w));
  if (isWord) {
    multiplier += 1.5;
    factors.push("Contains high-value keyword");
  }

  // All numeric
  if (/^\d+$/.test(clean)) {
    multiplier += len <= 5 ? 3 : 0.5;
    factors.push("All-numeric — collector value");
  }

  // Repeating pattern
  if (/^(.)\1+$/.test(clean)) {
    multiplier += 2;
    factors.push("Repeating character — rare");
  }

  // Chinese cultural value (lucky numbers, pinyin meaning)
  if (/^\d+$/.test(clean)) {
    const { analyzeChineseNumbers } = await import("./categorizer.js");
    const chineseAnalysis = analyzeChineseNumbers(clean);
    if (chineseAnalysis.tier === "ultra_lucky") {
      multiplier += 3;
      factors.push(
        `Chinese ultra-lucky number 🔥 — ${chineseAnalysis.meaning.slice(0, 2).join("; ")}`
      );
    } else if (chineseAnalysis.tier === "very_lucky") {
      multiplier += 1.5;
      factors.push(`Chinese very lucky number — ${chineseAnalysis.meaning.slice(0, 2).join("; ")}`);
    } else if (chineseAnalysis.tier === "lucky") {
      multiplier += 0.5;
      factors.push(`Chinese lucky number — ${chineseAnalysis.meaning[0] || "auspicious digits"}`);
    } else if (chineseAnalysis.tier === "unlucky") {
      multiplier *= 0.5;
      factors.push(`Chinese unlucky number ⚠️ — contains 四 (4 = death)`);
    }
  }

  // Gibberish/random string penalty
  if (isGibberish || (isMixed && !isWord)) {
    multiplier *= 0.3; // Heavy discount for random strings
    factors.push("⚠️ Random/gibberish string — very low demand");
  }

  // Base price from comparables (use MEDIAN, not average — avoids outlier skew)
  let basePrice: number;
  if (comparables.length > 0) {
    const sorted = comparables.map((c) => c.soldPrice).sort((a, b) => a - b);
    const midIdx = Math.floor(sorted.length / 2);
    basePrice =
      sorted.length % 2 === 0 ? (sorted[midIdx - 1] + sorted[midIdx]) / 2 : sorted[midIdx];
  } else {
    // Conservative defaults when no comparables
    if (isGibberish || isMixed) {
      // Random strings: near-zero value
      basePrice = len <= 5 ? 2 : 1;
    } else {
      basePrice = len <= 3 ? 50 : len === 4 ? 20 : len === 5 ? 8 : len <= 7 ? 3 : 1;
    }
  }

  const mid = Math.round(basePrice * multiplier);
  // Hard caps based on quality
  const maxCap = isGibberish ? 50 : comparables.length >= 5 ? Infinity : 50000;
  const cappedMid = Math.min(mid, maxCap);
  const low = Math.round(cappedMid * 0.5);
  const high = Math.round(cappedMid * 2.0);

  if (cappedMid < mid) {
    factors.push("⚠️ Capped — low comparable data or low-demand pattern");
  }

  const confidence: "low" | "medium" | "high" =
    comparables.length >= 10 ? "high" : comparables.length >= 3 ? "medium" : "low";

  return {
    estimated: { low, mid: cappedMid, high },
    factors,
    confidence,
    comparables: comparables.slice(0, 5),
  };
}

/**
 * Find undervalued usernames (sniper mode).
 * Compares current listing price against estimated value.
 */
export async function findUndervalued(
  budget?: number,
  minDiscount: number = 0.3 // 30% below estimated value
): Promise<
  Array<
    FragmentUsername & {
      estimatedValue: number;
      discount: number;
      flipPotential: string;
    }
  >
> {
  const [sales, auctions] = await Promise.all([
    fetchUsernames("sale", "price_asc", 50),
    fetchUsernames("auction", "price_asc", 50),
  ]);

  const allListings = [...sales, ...auctions].filter((l) => l.priceRaw !== undefined);

  // Filter by budget
  const affordable = budget ? allListings.filter((l) => l.priceRaw ?? 0 <= budget) : allListings;

  // Estimate values and find deals
  const results = [];
  for (const listing of affordable.slice(0, 20)) {
    // Limit API calls
    const valuation = await estimateValue(listing.username);
    const discount = (valuation.estimated.mid - (listing.priceRaw ?? 0)) / valuation.estimated.mid;

    if (discount >= minDiscount) {
      results.push({
        ...listing,
        estimatedValue: valuation.estimated.mid,
        discount: Math.round(discount * 100),
        flipPotential: `Buy ${listing.price} → Sell ~${valuation.estimated.mid} TON (${Math.round(discount * 100)}% upside)`,
      });
    }
  }

  return results.sort((a, b) => b.discount - a.discount);
}

// ═══════════════════════════════════════════════════════════════════════
// ANONYMOUS NUMBERS (+888) — Fragment Scraping
// ═══════════════════════════════════════════════════════════════════════

export interface FragmentNumber {
  number: string; // formatted: "+888 0768 4929"
  rawDigits: string; // full digits: "88807684929"
  status: "auction" | "sale" | "sold" | "unavailable";
  price?: string;
  priceRaw?: number;
  bids?: number;
  endsAt?: string;
  owner?: string;
  url: string;
}

export interface NumberSaleHistory {
  number: string;
  soldPrice: number;
  soldDate: string;
  buyer?: string;
}

export interface NumberMarketStats {
  totalListings: number;
  avgPrice: number;
  medianPrice: number;
  minPrice: number;
  maxPrice: number;
  floorPrice: number;
  recentSales: NumberSaleHistory[];
  trending: FragmentNumber[];
  fetchedAt: string;
}

/**
 * Fetch anonymous number listings from Fragment.
 */
export async function fetchNumbers(
  type: "auction" | "sale" | "sold" = "sale",
  sort: string = "recent",
  limit: number = 50
): Promise<FragmentNumber[]> {
  const cacheKey = `numbers:${type}:${sort}:${limit}`;
  const cached = getCached<FragmentNumber[]>(cacheKey);
  if (cached) return cached;

  try {
    const url = `${FRAGMENT_BASE}/numbers?sort=${sort}&filter=${type}`;
    const response = await rateLimitedFetch(url);

    if (!response.ok) {
      log.error(`Fragment numbers fetch failed: ${response.status}`);
      return [];
    }

    const html = await response.text();
    const $ = cheerio.load(html);
    const results: FragmentNumber[] = [];
    const seen = new Set<string>();

    $("tr.tm-row-selectable").each((_i, el) => {
      const $row = $(el);
      const tds = $row.find("td");
      if (tds.length < 2) return;

      // Extract number from href like /number/888XXXXXXXX
      const link = tds.eq(0).find("a[href*='/number/']").first();
      const href = link.attr("href") || "";
      const numberMatch = href.match(/\/number\/(\d+)/);
      if (!numberMatch) return;

      const rawDigits = numberMatch[1];
      if (seen.has(rawDigits)) return;
      seen.add(rawDigits);

      // Format: +888 X XXX (7-digit) or +888 XXXX XXXX (11-digit)
      const afterPrefix = rawDigits.slice(3);
      let formatted: string;
      if (rawDigits.length <= 7) {
        // Short number: +888 X XXX (4 digits after prefix)
        formatted = `+888 ${afterPrefix.slice(0, 1)} ${afterPrefix.slice(1)}`;
      } else {
        // Standard number: +888 XXXX XXXX (8 digits after prefix)
        formatted = `+888 ${afterPrefix.slice(0, 4)} ${afterPrefix.slice(4)}`;
      }

      // Price
      const priceText = tds.eq(1).find(".table-cell-value").first().text().trim();
      const price = parsePrice(priceText);

      // Time
      const timeText =
        tds.length >= 3
          ? tds.eq(2).find(".table-cell-value").first().text().trim()
          : tds.eq(1).find(".table-cell-desc.thin-only").text().trim();
      const endTime = parseEndTime(timeText);

      const entry: FragmentNumber = {
        number: formatted,
        rawDigits,
        status: type,
        url: `${FRAGMENT_BASE}/number/${rawDigits}`,
      };

      if (price) {
        entry.price = price.display;
        entry.priceRaw = price.raw;
      }
      if (endTime) entry.endsAt = endTime;

      results.push(entry);
    });

    const limited = results.slice(0, limit);
    setCache(cacheKey, limited);
    return limited;
  } catch (error) {
    log.error({ err: error }, "Fragment number fetch error");
    return [];
  }
}

/**
 * Get details for a specific anonymous number from Fragment.
 */
export async function checkNumber(input: string): Promise<FragmentNumber | null> {
  // Normalize: strip +, spaces, dashes → pure digits
  const cleaned = input.replace(/[+\s\-()]/g, "");
  // All Fragment anonymous numbers start with 888 prefix
  // If input already has 888, use as-is; otherwise prepend
  // Valid lengths: 7 digits (short: 888XXXX) or 11 digits (standard: 888XXXXXXXX)
  let digits: string;
  if (cleaned.startsWith("888") && (cleaned.length === 7 || cleaned.length === 11)) {
    digits = cleaned;
  } else if (!cleaned.startsWith("888")) {
    digits = `888${cleaned}`;
  } else {
    digits = cleaned; // starts with 888 but odd length — try anyway
  }
  const cacheKey = `number:${digits}`;
  const cached = getCached<FragmentNumber>(cacheKey);
  if (cached) return cached;

  try {
    const url = `${FRAGMENT_BASE}/number/${digits}`;
    const response = await rateLimitedFetch(url);

    if (!response.ok) {
      if (response.status === 404) return null;
      return null;
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    const statusText = $(".tm-section-header-status").text().trim().toLowerCase();
    let status: FragmentNumber["status"] = "unavailable";
    if (statusText.includes("auction")) status = "auction";
    else if (statusText.includes("sale")) status = "sale";
    else if (statusText.includes("sold")) status = "sold";

    const priceEl = $(".tm-section-bid-info .table-cell-value.icon-before.icon-ton").first();
    const price = parsePrice(priceEl.text().trim());

    const ownerEl = $("a[href*='tonviewer.com']").first();
    const ownerHref = ownerEl.attr("href") || "";
    const owner = ownerHref ? ownerHref.split("/").pop() : undefined;

    const pageText = $("body").text();
    const bidsMatch = pageText.match(/(\d+)\s*bid/i);

    const afterPrefix = digits.slice(3);
    let formatted: string;
    if (digits.length <= 7) {
      formatted = `+888 ${afterPrefix.slice(0, 1)} ${afterPrefix.slice(1)}`;
    } else {
      formatted = `+888 ${afterPrefix.slice(0, 4)} ${afterPrefix.slice(4)}`;
    }

    const result: FragmentNumber = {
      number: formatted,
      rawDigits: digits,
      status,
      price: price?.display,
      priceRaw: price?.raw,
      bids: bidsMatch ? parseInt(bidsMatch[1]) : undefined,
      owner,
      url,
    };

    const timeText = $(".tm-section-countdown-wrap .table-cell-value").first().text().trim();
    const endTime = parseEndTime(timeText);
    if (endTime) result.endsAt = endTime;

    setCache(cacheKey, result);
    return result;
  } catch (error) {
    log.error({ err: error }, `Fragment check error for number ${digits}`);
    return null;
  }
}

/**
 * Fetch sold number history.
 */
export async function fetchNumberSoldHistory(limit: number = 100): Promise<NumberSaleHistory[]> {
  const cacheKey = `number_sold_history:${limit}`;
  const cached = getCached<NumberSaleHistory[]>(cacheKey);
  if (cached) return cached;

  const listings = await fetchNumbers("sold", "recent", limit);
  const history: NumberSaleHistory[] = listings
    .filter((l) => l.priceRaw !== undefined)
    .map((l) => ({
      number: l.number,
      soldPrice: l.priceRaw ?? 0,
      soldDate: new Date().toISOString(),
      buyer: l.owner,
    }));

  setCache(cacheKey, history);
  return history;
}

/**
 * Get number market statistics.
 */
export async function getNumberMarketStats(): Promise<NumberMarketStats> {
  const cacheKey = "number_market_stats";
  const cached = getCached<NumberMarketStats>(cacheKey);
  if (cached) return cached;

  const [salesData, auctionData, saleData] = await Promise.all([
    fetchNumberSoldHistory(100),
    fetchNumbers("auction", "ending_soon", 30),
    fetchNumbers("sale", "price_asc", 30),
  ]);

  const prices = salesData.map((s) => s.soldPrice).sort((a, b) => a - b);

  const stats: NumberMarketStats = {
    totalListings: auctionData.length + saleData.length,
    avgPrice: prices.length > 0 ? prices.reduce((a, b) => a + b, 0) / prices.length : 0,
    medianPrice: prices.length > 0 ? prices[Math.floor(prices.length / 2)] : 0,
    minPrice: prices.length > 0 ? prices[0] : 0,
    maxPrice: prices.length > 0 ? prices[prices.length - 1] : 0,
    floorPrice: saleData.length > 0 && saleData[0].priceRaw ? saleData[0].priceRaw : 1774,
    recentSales: salesData.slice(0, 10),
    trending: auctionData
      .filter((a) => (a.bids ?? 0) > 1)
      .sort((a, b) => (b.bids ?? 0) - (a.bids ?? 0))
      .slice(0, 10),
    fetchedAt: new Date().toISOString(),
  };

  setCache(cacheKey, stats);
  return stats;
}

/**
 * Find undervalued numbers by comparing Fragment listing price vs rarity-based valuation.
 */
export async function findUndervaluedNumbers(
  budget?: number,
  minDiscount: number = 0.3
): Promise<
  Array<
    FragmentNumber & {
      rarityScore: number;
      rarityTier: string;
      estimatedMin: number;
      estimatedMax: number;
      discount: number;
      flipPotential: string;
    }
  >
> {
  // Lazy import to avoid circular deps
  const { calculateRarity } = await import("./number-rarity.js");

  const [sales, auctions] = await Promise.all([
    fetchNumbers("sale", "price_asc", 50),
    fetchNumbers("auction", "price_asc", 50),
  ]);

  const allListings = [...sales, ...auctions].filter((l) => l.priceRaw !== undefined);
  const affordable = budget ? allListings.filter((l) => l.priceRaw ?? 0 <= budget) : allListings;

  const results = [];
  for (const listing of affordable.slice(0, 30)) {
    const rarity = calculateRarity(listing.rawDigits);
    if (!rarity) continue;

    const estMid = (rarity.estimatedFloor.min + rarity.estimatedFloor.max) / 2;
    if (estMid <= 0) continue; // avoid division by zero
    const discount = (estMid - (listing.priceRaw ?? 0)) / estMid;

    if (discount >= minDiscount) {
      results.push({
        ...listing,
        rarityScore: rarity.score,
        rarityTier: rarity.tier,
        estimatedMin: rarity.estimatedFloor.min,
        estimatedMax: rarity.estimatedFloor.max,
        discount: Math.round(discount * 100),
        flipPotential: `Buy ${listing.price} → Est. ${rarity.estimatedFloor.min.toLocaleString()}-${rarity.estimatedFloor.max.toLocaleString()} TON (${Math.round(discount * 100)}% upside)`,
      });
    }
  }

  return results.sort((a, b) => b.discount - a.discount);
}
