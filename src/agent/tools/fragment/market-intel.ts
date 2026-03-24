/**
 * 📊 Market Intelligence — Username market trends, whale tracking, category analysis.
 */

import { Type } from "@sinclair/typebox";
import type { Tool, ToolExecutor, ToolResult } from "../types.js";
import {
  getMarketStats,
  fetchUsernames,
  fetchSoldHistory,
  type FragmentUsername,
  type FragmentSaleHistory,
} from "./fragment-service.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("FragmentMarket");

// ─── Market Overview ─────────────────────────────────────────────────

export const fragmentMarketTool: Tool = {
  name: "fragment_market",
  description:
    "📊 Get Fragment username market overview: total listings, price stats, " +
    "trending auctions (most bids), and recent sales. Use to understand the current market.",
  category: "data-bearing",
  parameters: Type.Object({}),
};

export const fragmentMarketExecutor: ToolExecutor<Record<string, never>> = async (
  _params,
  _context
): Promise<ToolResult> => {
  try {
    const stats = await getMarketStats();

    const trendingList =
      stats.trending.length > 0
        ? stats.trending
            .map((t, i) => `  ${i + 1}. ${t.username} — ${t.price ?? "?"} (${t.bids ?? 0} bids)`)
            .join("\n")
        : "  No trending auctions right now";

    const recentList =
      stats.recentSales.length > 0
        ? stats.recentSales
            .slice(0, 5)
            .map((s, i) => `  ${i + 1}. ${s.username} — ${s.soldPrice} TON`)
            .join("\n")
        : "  No recent sales data";

    return {
      success: true,
      data: {
        ...stats,
        message:
          `📊 Fragment Username Market\n\n` +
          `Active listings: ${stats.totalListings}\n` +
          `Avg price: ${Math.round(stats.avgPrice)} TON\n` +
          `Median: ${Math.round(stats.medianPrice)} TON\n` +
          `Range: ${Math.round(stats.minPrice)} – ${Math.round(stats.maxPrice)} TON\n\n` +
          `🔥 Trending (most bids):\n${trendingList}\n\n` +
          `💸 Recent sales:\n${recentList}\n\n` +
          `Last updated: ${stats.fetchedAt}`,
      },
    };
  } catch (error) {
    log.error({ err: error }, "Market overview error");
    return {
      success: false,
      error: `Market overview failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};

// ─── Category Analysis ───────────────────────────────────────────────

interface CategoryParams {
  category: string;
  limit?: number;
}

export const fragmentCategoryTool: Tool = {
  name: "fragment_category",
  description:
    "Analyze a specific username category on Fragment. Categories: " +
    "'short' (3-4 chars), 'medium' (5-6), 'long' (7+), 'numeric' (all digits), " +
    "'crypto' (crypto keywords), 'emoji', 'premium' (dictionary words). " +
    "Shows average prices, volume, and top listings for that category.",
  category: "data-bearing",
  parameters: Type.Object({
    category: Type.String({
      description: "Category to analyze: short, medium, long, numeric, crypto, emoji, premium",
      enum: ["short", "medium", "long", "numeric", "crypto", "emoji", "premium"],
    }),
    limit: Type.Optional(
      Type.Number({
        description: "Max results (default: 15)",
        minimum: 1,
        maximum: 50,
      })
    ),
  }),
};

const CRYPTO_KEYWORDS = [
  "ton",
  "crypto",
  "wallet",
  "coin",
  "token",
  "swap",
  "defi",
  "nft",
  "dao",
  "web3",
  "btc",
  "eth",
  "sol",
  "trade",
  "dex",
  "yield",
  "stake",
  "farm",
  "mine",
  "block",
  "chain",
  "ledger",
  "vault",
  "airdrop",
];

function categorizeUsername(username: string): string[] {
  const clean = username.replace(/^@/, "").toLowerCase();
  const cats: string[] = [];

  if (clean.length <= 4) cats.push("short");
  else if (clean.length <= 6) cats.push("medium");
  else cats.push("long");

  if (/^\d+$/.test(clean)) cats.push("numeric");
  if (CRYPTO_KEYWORDS.some((k) => clean.includes(k))) cats.push("crypto");
  if (/[\u{1F000}-\u{1FFFF}]/u.test(clean)) cats.push("emoji");

  return cats;
}

export const fragmentCategoryExecutor: ToolExecutor<CategoryParams> = async (
  params,
  _context
): Promise<ToolResult> => {
  try {
    const { category, limit = 15 } = params;

    // Fetch all listings
    const [sales, auctions, sold] = await Promise.all([
      fetchUsernames("sale", "price_asc", 100),
      fetchUsernames("auction", "ending_soon", 100),
      fetchSoldHistory(100),
    ]);

    // Filter by category
    const filterFn = (u: FragmentUsername | FragmentSaleHistory): boolean => {
      const name = "username" in u ? u.username : "";
      const cats = categorizeUsername(name);
      return cats.includes(category);
    };

    const catSales = sales.filter(filterFn);
    const catAuctions = auctions.filter(filterFn);
    const catSold = (sold as unknown as FragmentSaleHistory[]).filter(filterFn);

    const allPrices = [
      ...catSales.map((s) => s.priceRaw).filter((p): p is number => p !== undefined),
      ...catSold.map((s) => s.soldPrice),
    ].sort((a, b) => a - b);

    const avg =
      allPrices.length > 0
        ? Math.round(allPrices.reduce((a, b) => a + b, 0) / allPrices.length)
        : 0;
    const median =
      allPrices.length > 0 ? Math.round(allPrices[Math.floor(allPrices.length / 2)]) : 0;

    const topListings = [...catSales, ...catAuctions]
      .sort((a, b) => (a.priceRaw ?? Infinity) - (b.priceRaw ?? Infinity))
      .slice(0, limit);

    const listingsText =
      topListings.length > 0
        ? topListings
            .map((l, i) => `  ${i + 1}. ${l.username} — ${l.price ?? "?"} (${l.status})`)
            .join("\n")
        : "  No listings found in this category";

    return {
      success: true,
      data: {
        category,
        forSale: catSales.length,
        inAuction: catAuctions.length,
        recentlySold: catSold.length,
        avgPrice: avg,
        medianPrice: median,
        priceRange:
          allPrices.length > 0 ? { min: allPrices[0], max: allPrices[allPrices.length - 1] } : null,
        listings: topListings,
        message:
          `📊 Category: ${category.toUpperCase()}\n\n` +
          `For sale: ${catSales.length} | Auctions: ${catAuctions.length} | Recent sold: ${catSold.length}\n` +
          `Avg price: ${avg} TON | Median: ${median} TON\n` +
          `${allPrices.length > 0 ? `Range: ${allPrices[0]} – ${allPrices[allPrices.length - 1]} TON` : ""}\n\n` +
          `Top listings:\n${listingsText}`,
      },
    };
  } catch (error) {
    log.error({ err: error }, "Category analysis error");
    return {
      success: false,
      error: `Category analysis failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};

// ─── Whale Tracker ───────────────────────────────────────────────────

interface WhaleParams {
  limit?: number;
}

export const fragmentWhalesTool: Tool = {
  name: "fragment_whales",
  description:
    "Track whale activity on Fragment: biggest buyers, largest sales, " +
    "and wallets accumulating the most usernames.",
  category: "data-bearing",
  parameters: Type.Object({
    limit: Type.Optional(
      Type.Number({
        description: "Max results (default: 10)",
        minimum: 1,
        maximum: 25,
      })
    ),
  }),
};

export const fragmentWhalesExecutor: ToolExecutor<WhaleParams> = async (
  params,
  _context
): Promise<ToolResult> => {
  try {
    const { limit = 10 } = params;

    const soldHistory = await fetchSoldHistory(100);

    // Group by buyer wallet
    const buyerMap = new Map<string, { count: number; totalSpent: number; usernames: string[] }>();

    for (const sale of soldHistory) {
      const buyer = sale.buyer || "unknown";
      const entry = buyerMap.get(buyer) || {
        count: 0,
        totalSpent: 0,
        usernames: [],
      };
      entry.count++;
      entry.totalSpent += sale.soldPrice;
      entry.usernames.push(sale.username);
      buyerMap.set(buyer, entry);
    }

    // Sort by total spent
    const whales = Array.from(buyerMap.entries())
      .filter(([addr]) => addr !== "unknown")
      .map(([address, data]) => ({
        address: `${address.slice(0, 8)}...${address.slice(-6)}`,
        fullAddress: address,
        ...data,
      }))
      .sort((a, b) => b.totalSpent - a.totalSpent)
      .slice(0, limit);

    // Biggest single sales
    const biggestSales = [...soldHistory].sort((a, b) => b.soldPrice - a.soldPrice).slice(0, limit);

    const whaleText =
      whales.length > 0
        ? whales
            .map(
              (w, i) =>
                `  ${i + 1}. ${w.address} — ${w.count} usernames, ${Math.round(w.totalSpent)} TON spent`
            )
            .join("\n")
        : "  Not enough data to identify whales";

    const bigSalesText = biggestSales
      .slice(0, 5)
      .map((s, i) => `  ${i + 1}. ${s.username} — ${s.soldPrice} TON`)
      .join("\n");

    return {
      success: true,
      data: {
        whales,
        biggestSales: biggestSales.slice(0, 5),
        message:
          `🐋 Whale Tracker\n\n` +
          `Top buyers:\n${whaleText}\n\n` +
          `💎 Biggest sales:\n${bigSalesText}`,
      },
    };
  } catch (error) {
    log.error({ err: error }, "Whale tracker error");
    return {
      success: false,
      error: `Whale tracking failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};

// ─── Search Usernames ────────────────────────────────────────────────

interface SearchParams {
  query: string;
  status?: string;
  sort?: string;
  limit?: number;
}

export const fragmentSearchTool: Tool = {
  name: "fragment_search",
  description:
    "Search Fragment usernames by keyword or pattern. " +
    "Filter by status (auction/sale/sold) and sort (price_asc/price_desc/ending_soon/recent).",
  category: "data-bearing",
  parameters: Type.Object({
    query: Type.String({
      description: "Search keyword (e.g. 'crypto', 'ton', '4-letter') or username pattern",
    }),
    status: Type.Optional(
      Type.String({
        description: "Filter by status: auction, sale, or sold (default: sale)",
        enum: ["auction", "sale", "sold"],
      })
    ),
    sort: Type.Optional(
      Type.String({
        description: "Sort order (default: recent)",
        enum: ["price_asc", "price_desc", "ending_soon", "recent"],
      })
    ),
    limit: Type.Optional(
      Type.Number({
        description: "Max results (default: 20)",
        minimum: 1,
        maximum: 50,
      })
    ),
  }),
};

export const fragmentSearchExecutor: ToolExecutor<SearchParams> = async (
  params,
  _context
): Promise<ToolResult> => {
  try {
    const { query, status = "sale", sort = "recent", limit = 20 } = params;

    const statusTyped = status as "auction" | "sale" | "sold";
    const listings = await fetchUsernames(statusTyped, sort, 100);

    // Filter by query
    const queryLower = query.toLowerCase();
    let filtered: FragmentUsername[];

    // Special queries
    if (/^\d+-letter$/.test(queryLower)) {
      const len = parseInt(queryLower);
      filtered = listings.filter((l) => l.username.replace(/^@/, "").length === len);
    } else if (queryLower === "numeric") {
      filtered = listings.filter((l) => /^\d+$/.test(l.username.replace(/^@/, "")));
    } else {
      filtered = listings.filter((l) => l.username.toLowerCase().includes(queryLower));
    }

    const limited = filtered.slice(0, limit);

    if (limited.length === 0) {
      return {
        success: true,
        data: {
          results: [],
          message: `No usernames matching "${query}" found (status: ${status}).`,
        },
      };
    }

    const resultText = limited
      .map(
        (l, i) =>
          `${i + 1}. ${l.username} — ${l.price ?? "?"} (${l.status})${l.bids ? ` [${l.bids} bids]` : ""}\n   ${l.url}`
      )
      .join("\n");

    return {
      success: true,
      data: {
        totalMatched: filtered.length,
        showing: limited.length,
        query,
        status,
        results: limited,
        message: `🔎 "${query}" — ${filtered.length} result${filtered.length !== 1 ? "s" : ""} (${status}):\n\n${resultText}`,
      },
    };
  } catch (error) {
    log.error({ err: error }, "Fragment search error");
    return {
      success: false,
      error: `Search failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};
