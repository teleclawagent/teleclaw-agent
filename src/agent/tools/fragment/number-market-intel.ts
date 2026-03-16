/**
 * 📊 Number Market Intelligence — Anonymous number market trends, whale tracking, pattern analysis.
 */

import { Type } from "@sinclair/typebox";
import type { Tool, ToolExecutor, ToolResult } from "../types.js";
import {
  getNumberMarketStats,
  fetchNumbers,
  fetchNumberSoldHistory,
  type FragmentNumber,
  type NumberSaleHistory,
} from "./fragment-service.js";
import { calculateRarity } from "./number-rarity.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("NumberMarket");

// ─── Number Market Overview ──────────────────────────────────────────

export const numberMarketTool: Tool = {
  name: "number_market",
  description:
    "📊 Get Anonymous Number (+888) market overview on Fragment: total listings, " +
    "price stats, floor price, trending auctions, and recent sales.",
  category: "data-bearing",
  parameters: Type.Object({}),
};

export const numberMarketExecutor: ToolExecutor<Record<string, never>> = async (
  _params,
  _context
): Promise<ToolResult> => {
  try {
    const stats = await getNumberMarketStats();

    const trendingList =
      stats.trending.length > 0
        ? stats.trending
            .map((t, i) => `  ${i + 1}. ${t.number} — ${t.price ?? "?"} (${t.bids ?? 0} bids)`)
            .join("\n")
        : "  No trending auctions right now";

    const recentList =
      stats.recentSales.length > 0
        ? stats.recentSales
            .slice(0, 5)
            .map((s, i) => `  ${i + 1}. ${s.number} — ${s.soldPrice.toLocaleString()} TON`)
            .join("\n")
        : "  No recent sales data";

    return {
      success: true,
      data: {
        ...stats,
        message:
          `📊 Anonymous Number Market (+888)\n\n` +
          `Active listings: ${stats.totalListings}\n` +
          `Floor: ~${stats.floorPrice.toLocaleString()} TON\n` +
          `Avg price: ${Math.round(stats.avgPrice).toLocaleString()} TON\n` +
          `Median: ${Math.round(stats.medianPrice).toLocaleString()} TON\n` +
          `Range: ${Math.round(stats.minPrice).toLocaleString()} – ${Math.round(stats.maxPrice).toLocaleString()} TON\n\n` +
          `🔥 Trending (most bids):\n${trendingList}\n\n` +
          `💸 Recent sales:\n${recentList}\n\n` +
          `Last updated: ${stats.fetchedAt}`,
      },
    };
  } catch (error) {
    log.error({ err: error }, "Number market overview error");
    return { success: false, error: `Market overview failed: ${String(error)}` };
  }
};

// ─── Number Category Analysis ────────────────────────────────────────

interface CategoryParams {
  category: string;
  limit?: number;
}

export const numberCategoryTool: Tool = {
  name: "number_category_analysis",
  description:
    "Analyze Anonymous Numbers by pattern category on Fragment. Categories: " +
    "'short' (7-digit, +888 8XXX), 'repeating' (3+ consecutive same digit), " +
    "'sequential' (ascending/descending runs), 'palindrome', 'lucky' (8-heavy), " +
    "'round' (trailing zeros). Shows avg prices and top listings per category.",
  category: "data-bearing",
  parameters: Type.Object({
    category: Type.String({
      description: "Category to analyze",
      enum: ["short", "repeating", "sequential", "palindrome", "lucky", "round"],
    }),
    limit: Type.Optional(
      Type.Number({ description: "Max results (default: 15)", minimum: 1, maximum: 50 })
    ),
  }),
};

function categorizeNumber(rawDigits: string): string[] {
  const cats: string[] = [];
  const afterPrefix = rawDigits.startsWith("888") ? rawDigits.slice(3) : rawDigits;

  if (rawDigits.length === 7) cats.push("short");

  // Repeating: 3+ consecutive same digit
  if (/(.)\1{2,}/.test(afterPrefix)) cats.push("repeating");

  // Sequential
  let hasSeq = false;
  for (let i = 2; i < afterPrefix.length; i++) {
    const a = parseInt(afterPrefix[i - 2]);
    const b = parseInt(afterPrefix[i - 1]);
    const c = parseInt(afterPrefix[i]);
    if ((b === a + 1 && c === b + 1) || (b === a - 1 && c === b - 1)) {
      hasSeq = true;
      break;
    }
  }
  if (hasSeq) cats.push("sequential");

  // Palindrome
  if (afterPrefix === afterPrefix.split("").reverse().join("")) cats.push("palindrome");

  // Lucky (50%+ are 8s)
  const eightCount = afterPrefix.split("").filter((d) => d === "8").length;
  if (eightCount >= afterPrefix.length * 0.5) cats.push("lucky");

  // Round (3+ trailing zeros)
  if (/0{3,}$/.test(afterPrefix)) cats.push("round");

  return cats;
}

export const numberCategoryExecutor: ToolExecutor<CategoryParams> = async (
  params,
  _context
): Promise<ToolResult> => {
  try {
    const { category, limit = 15 } = params;

    const [sales, auctions, sold] = await Promise.all([
      fetchNumbers("sale", "price_asc", 100),
      fetchNumbers("auction", "ending_soon", 100),
      fetchNumberSoldHistory(100),
    ]);

    const filterNum = (n: FragmentNumber): boolean => {
      return categorizeNumber(n.rawDigits).includes(category);
    };
    const filterSold = (s: NumberSaleHistory): boolean => {
      const raw = s.number.replace(/[+\s\-]/g, "");
      return categorizeNumber(raw).includes(category);
    };

    const catSales = sales.filter(filterNum);
    const catAuctions = auctions.filter(filterNum);
    const catSold = sold.filter(filterSold);

    const allPrices = [
      ...catSales.map((s) => s.priceRaw).filter((p): p is number => p !== undefined),
      ...catSold.map((s) => s.soldPrice),
    ].sort((a, b) => a - b);

    const avg = allPrices.length > 0 ? Math.round(allPrices.reduce((a, b) => a + b, 0) / allPrices.length) : 0;
    const median = allPrices.length > 0 ? Math.round(allPrices[Math.floor(allPrices.length / 2)]) : 0;

    const topListings = [...catSales, ...catAuctions]
      .sort((a, b) => (a.priceRaw ?? Infinity) - (b.priceRaw ?? Infinity))
      .slice(0, limit);

    const listingsText =
      topListings.length > 0
        ? topListings.map((l, i) => `  ${i + 1}. ${l.number} — ${l.price ?? "?"} (${l.status})`).join("\n")
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
        priceRange: allPrices.length > 0 ? { min: allPrices[0], max: allPrices[allPrices.length - 1] } : null,
        listings: topListings,
        message:
          `📊 Number Category: ${category.toUpperCase()}\n\n` +
          `For sale: ${catSales.length} | Auctions: ${catAuctions.length} | Recent sold: ${catSold.length}\n` +
          `Avg: ${avg.toLocaleString()} TON | Median: ${median.toLocaleString()} TON\n` +
          `${allPrices.length > 0 ? `Range: ${allPrices[0].toLocaleString()} – ${allPrices[allPrices.length - 1].toLocaleString()} TON` : ""}\n\n` +
          `Top listings:\n${listingsText}`,
      },
    };
  } catch (error) {
    log.error({ err: error }, "Number category analysis error");
    return { success: false, error: `Category analysis failed: ${String(error)}` };
  }
};

// ─── Number Whale Tracker ────────────────────────────────────────────

interface WhaleParams {
  limit?: number;
}

export const numberWhalesTool: Tool = {
  name: "number_whales",
  description:
    "Track whale activity for Anonymous Numbers on Fragment: biggest buyers, " +
    "largest sales, and wallets accumulating the most numbers.",
  category: "data-bearing",
  parameters: Type.Object({
    limit: Type.Optional(
      Type.Number({ description: "Max results (default: 10)", minimum: 1, maximum: 25 })
    ),
  }),
};

export const numberWhalesExecutor: ToolExecutor<WhaleParams> = async (
  params,
  _context
): Promise<ToolResult> => {
  try {
    const { limit = 10 } = params;
    const soldHistory = await fetchNumberSoldHistory(100);

    const buyerMap = new Map<string, { count: number; totalSpent: number; numbers: string[] }>();

    for (const sale of soldHistory) {
      const buyer = sale.buyer || "unknown";
      const entry = buyerMap.get(buyer) || { count: 0, totalSpent: 0, numbers: [] };
      entry.count++;
      entry.totalSpent += sale.soldPrice;
      entry.numbers.push(sale.number);
      buyerMap.set(buyer, entry);
    }

    const whales = Array.from(buyerMap.entries())
      .filter(([addr]) => addr !== "unknown")
      .map(([address, data]) => ({
        address: `${address.slice(0, 8)}...${address.slice(-6)}`,
        fullAddress: address,
        ...data,
      }))
      .sort((a, b) => b.totalSpent - a.totalSpent)
      .slice(0, limit);

    const biggestSales = [...soldHistory]
      .sort((a, b) => b.soldPrice - a.soldPrice)
      .slice(0, limit);

    const whaleText =
      whales.length > 0
        ? whales.map((w, i) => `  ${i + 1}. ${w.address} — ${w.count} numbers, ${Math.round(w.totalSpent).toLocaleString()} TON spent`).join("\n")
        : "  Not enough data to identify whales";

    const bigSalesText = biggestSales
      .slice(0, 5)
      .map((s, i) => `  ${i + 1}. ${s.number} — ${s.soldPrice.toLocaleString()} TON`)
      .join("\n");

    return {
      success: true,
      data: {
        whales,
        biggestSales: biggestSales.slice(0, 5),
        message:
          `🐋 Number Whale Tracker\n\n` +
          `Top buyers:\n${whaleText}\n\n` +
          `💎 Biggest sales:\n${bigSalesText}`,
      },
    };
  } catch (error) {
    log.error({ err: error }, "Number whale tracker error");
    return { success: false, error: `Whale tracking failed: ${String(error)}` };
  }
};

// ─── Number Search ───────────────────────────────────────────────────

interface SearchParams {
  pattern?: string;
  digits?: string;
  length?: string;
  status?: string;
  sort?: string;
  limit?: number;
}

export const numberSearchTool: Tool = {
  name: "number_search",
  description:
    "Search Anonymous Numbers on Fragment by pattern, specific digits, or length. " +
    "Examples: pattern 'repeating', digits '888' (numbers containing 888 after prefix), " +
    "length 'short' (7-digit) or 'standard' (11-digit).",
  category: "data-bearing",
  parameters: Type.Object({
    pattern: Type.Optional(
      Type.String({
        description: "Pattern type: repeating, sequential, palindrome, lucky, round",
        enum: ["repeating", "sequential", "palindrome", "lucky", "round"],
      })
    ),
    digits: Type.Optional(
      Type.String({ description: "Search for numbers containing these digits (e.g. '888', '1234')" })
    ),
    length: Type.Optional(
      Type.String({
        description: "Filter by length: 'short' (7-digit) or 'standard' (11-digit)",
        enum: ["short", "standard"],
      })
    ),
    status: Type.Optional(
      Type.String({
        description: "Listing status (default: sale)",
        enum: ["auction", "sale", "sold"],
      })
    ),
    sort: Type.Optional(
      Type.String({
        description: "Sort order (default: price_asc)",
        enum: ["price_asc", "price_desc", "ending_soon", "recent"],
      })
    ),
    limit: Type.Optional(
      Type.Number({ description: "Max results (default: 20)", minimum: 1, maximum: 50 })
    ),
  }),
};

export const numberSearchExecutor: ToolExecutor<SearchParams> = async (
  params,
  _context
): Promise<ToolResult> => {
  try {
    const { pattern, digits, length, status = "sale", sort = "price_asc", limit = 20 } = params;

    const statusTyped = status as "auction" | "sale" | "sold";
    const listings = await fetchNumbers(statusTyped, sort, 100);

    let filtered = listings;

    // Filter by pattern
    if (pattern) {
      filtered = filtered.filter((n) => categorizeNumber(n.rawDigits).includes(pattern));
    }

    // Filter by digits
    if (digits) {
      filtered = filtered.filter((n) => n.rawDigits.includes(digits));
    }

    // Filter by length
    if (length === "short") {
      filtered = filtered.filter((n) => n.rawDigits.length === 7);
    } else if (length === "standard") {
      filtered = filtered.filter((n) => n.rawDigits.length === 11);
    }

    const limited = filtered.slice(0, limit);

    if (limited.length === 0) {
      return {
        success: true,
        data: {
          results: [],
          message: `No numbers found matching your criteria (status: ${status}).`,
        },
      };
    }

    const tierEmojis: Record<string, string> = { S: "🔴", A: "🟠", B: "🟡", C: "🟢", D: "⚪" };

    const resultText = limited
      .map((l, i) => {
        const rarity = calculateRarity(l.rawDigits);
        const tierStr = rarity ? `${tierEmojis[rarity.tier]} ${rarity.tier}(${rarity.score})` : "";
        return `${i + 1}. ${l.number} — ${l.price ?? "?"} ${tierStr}\n   ${l.url}`;
      })
      .join("\n");

    const filterDesc = [
      pattern && `pattern=${pattern}`,
      digits && `contains=${digits}`,
      length && `length=${length}`,
    ].filter(Boolean).join(", ");

    return {
      success: true,
      data: {
        totalMatched: filtered.length,
        showing: limited.length,
        filters: filterDesc,
        results: limited,
        message: `🔎 Number Search — ${filtered.length} result${filtered.length !== 1 ? "s" : ""} (${status}${filterDesc ? `, ${filterDesc}` : ""}):\n\n${resultText}`,
      },
    };
  } catch (error) {
    log.error({ err: error }, "Number search error");
    return { success: false, error: `Search failed: ${String(error)}` };
  }
};
