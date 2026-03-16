/**
 * 🎁 Gift Market Intelligence — Agent Tools
 *
 * 7 tools for real-time gift market data.
 * Format: { tool: Tool, executor: ToolExecutor } for registry compat.
 */

import { Type, type TObject } from "@sinclair/typebox";
import type { ToolEntry, ToolContext, ToolResult } from "../types.js";
import {
  fetchFloorPrice,
  fetchListings,
  fetchRecentSales,
} from "./fragment-scraper.js";
import {
  getUserNFTs,
  resolveUsernameToWallet,
  getTonPriceUsd,
} from "./tonapi-service.js";
import {
  getHistory,
  calculateChange,
  getLatestFloors,
} from "./price-history.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("GiftMarketTools");

function ok(data: unknown): ToolResult {
  return { success: true, data };
}
function fail(error: string): ToolResult {
  return { success: false, data: { error } };
}

// ─── 1. Floor Prices ─────────────────────────────────────────────────

const floorPricesParams = Type.Object({
  collection: Type.Optional(Type.String({ description: "Collection name (e.g. 'Plush Pepe'). Omit for all." })),
  limit: Type.Optional(Type.Number({ description: "Max collections (default 20)", minimum: 1, maximum: 109 })),
});

async function floorPricesExecutor(params: { collection?: string; limit?: number }, ctx: ToolContext): Promise<ToolResult> {
  try {
    if (params.collection) {
      const slug = params.collection.toLowerCase().replace(/[^a-z0-9]/g, "");
      const data = await fetchFloorPrice(slug);
      if (!data) return fail(`Collection "${params.collection}" not found on Fragment`);
      const tonPrice = await getTonPriceUsd();
      return ok({
        ...data,
        floorUsd: data.floorTon ? Math.round(data.floorTon * tonPrice * 100) / 100 : null,
        tonPriceUsd: tonPrice,
      });
    }

    const dbFloors = getLatestFloors();
    if (dbFloors.length > 10) {
      const tonPrice = await getTonPriceUsd();
      const limited = dbFloors.slice(0, params.limit || 20);
      return ok({
        collections: limited.map((f) => ({
          collection: f.collection,
          floorTon: f.floor_ton,
          floorUsd: f.floor_ton ? Math.round(f.floor_ton * tonPrice * 100) / 100 : null,
          listings: f.listing_count,
          lastUpdated: f.timestamp,
        })),
        total: dbFloors.length,
        tonPriceUsd: tonPrice,
        source: "cached",
      });
    }

    return ok({
      message: "Price history not yet populated. Use a specific collection name, or wait for hourly snapshot.",
      hint: "Try: gift_floor_prices collection:'Plush Pepe'",
    });
  } catch (err) {
    log.error({ err }, "gift_floor_prices error");
    return fail("Failed to fetch floor prices");
  }
}

// ─── 2. Last Sales ───────────────────────────────────────────────────

const lastSalesParams = Type.Object({
  collection: Type.String({ description: "Collection name (e.g. 'Plush Pepe')" }),
  limit: Type.Optional(Type.Number({ description: "Number of sales (default 10)", minimum: 1, maximum: 50 })),
});

async function lastSalesExecutor(params: { collection: string; limit?: number }, ctx: ToolContext): Promise<ToolResult> {
  try {
    const slug = params.collection.toLowerCase().replace(/[^a-z0-9]/g, "");
    const sales = await fetchRecentSales(slug, params.limit || 10);
    if (sales.length === 0) return fail(`No recent sales for "${params.collection}"`);

    const tonPrice = await getTonPriceUsd();
    const prices = sales.map((s) => s.priceTon);
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;

    return ok({
      collection: params.collection,
      sales: sales.map((s) => ({
        gift: s.slug, priceTon: s.priceTon,
        priceUsd: Math.round(s.priceTon * tonPrice * 100) / 100,
        url: s.url,
      })),
      summary: {
        count: sales.length,
        avgPriceTon: Math.round(avg * 100) / 100,
        avgPriceUsd: Math.round(avg * tonPrice * 100) / 100,
        lowestTon: Math.min(...prices),
        highestTon: Math.max(...prices),
      },
      tonPriceUsd: tonPrice,
    });
  } catch (err) {
    log.error({ err }, "gift_last_sales error");
    return fail("Failed to fetch sales data");
  }
}

// ─── 3. Price History ────────────────────────────────────────────────

const priceHistoryParams = Type.Object({
  collection: Type.String({ description: "Collection name (e.g. 'Plush Pepe')" }),
  period: Type.Optional(Type.Union([Type.Literal("24h"), Type.Literal("7d"), Type.Literal("30d")], { description: "Time period (default: 7d)" })),
});

async function priceHistoryExecutor(params: { collection: string; period?: "24h" | "7d" | "30d" }, ctx: ToolContext): Promise<ToolResult> {
  try {
    const period = params.period || "7d";
    const history = getHistory(params.collection, period);

    if (history.length === 0) {
      return ok({ error: "No price history yet. Hourly snapshots build up over time.", hint: "Use gift_floor_prices for current prices." });
    }

    const change = calculateChange(params.collection, period);
    return ok({
      collection: params.collection, period, dataPoints: history.length,
      change: {
        startPrice: change.startPrice, endPrice: change.endPrice,
        changePercent: change.changePercent,
        direction: change.changePercent ? (change.changePercent > 0 ? "📈 UP" : change.changePercent < 0 ? "📉 DOWN" : "➡️ FLAT") : "unknown",
      },
      snapshots: history.map((h) => ({ floorTon: h.floor_ton, listings: h.listing_count, time: h.timestamp })),
    });
  } catch (err) {
    log.error({ err }, "gift_price_history error");
    return fail("Failed to fetch price history");
  }
}

// ─── 4. Market Feed ──────────────────────────────────────────────────

const marketFeedParams = Type.Object({
  collection: Type.String({ description: "Collection name (e.g. 'Plush Pepe')" }),
  limit: Type.Optional(Type.Number({ description: "Number of listings (default 15)", minimum: 1, maximum: 50 })),
});

async function marketFeedExecutor(params: { collection: string; limit?: number }, ctx: ToolContext): Promise<ToolResult> {
  try {
    const slug = params.collection.toLowerCase().replace(/[^a-z0-9]/g, "");
    const [listings, floor] = await Promise.all([
      fetchListings(slug, params.limit || 15),
      fetchFloorPrice(slug),
    ]);
    if (listings.length === 0) return fail(`No active listings for "${params.collection}"`);

    const tonPrice = await getTonPriceUsd();
    return ok({
      collection: floor?.collection || params.collection,
      totalListings: floor?.listingCount || listings.length,
      floorTon: floor?.floorTon,
      floorUsd: floor?.floorTon ? Math.round(floor.floorTon * tonPrice * 100) / 100 : null,
      listings: listings.map((l) => ({
        gift: l.slug, num: l.giftNum, priceTon: l.priceTon,
        priceUsd: Math.round(l.priceTon * tonPrice * 100) / 100, url: l.url,
      })),
      tonPriceUsd: tonPrice,
      source: "fragment",
    });
  } catch (err) {
    log.error({ err }, "gift_market_feed error");
    return fail("Failed to fetch market feed");
  }
}

// ─── 5. User Inventory ──────────────────────────────────────────────

const userInventoryParams = Type.Object({
  username: Type.Optional(Type.String({ description: "Telegram username (without @)" })),
  wallet_address: Type.Optional(Type.String({ description: "TON wallet address" })),
});

async function userInventoryExecutor(params: { username?: string; wallet_address?: string }, ctx: ToolContext): Promise<ToolResult> {
  try {
    let wallet = params.wallet_address;
    if (!wallet && params.username) {
      wallet = await resolveUsernameToWallet(params.username) || undefined;
      if (!wallet) return fail(`Could not resolve @${params.username} to a TON wallet. They may not have TON DNS. Try wallet_address directly.`);
    }
    if (!wallet) return fail("Provide either username or wallet_address");

    const nfts = await getUserNFTs(wallet);
    const tonPrice = await getTonPriceUsd();

    return ok({
      username: params.username || null,
      wallet,
      totalNFTs: nfts.length,
      gifts: nfts.slice(0, 50).map((nft) => ({
        name: nft.metadata?.name || "Unknown",
        collection: nft.collection?.name || "Unknown",
        address: nft.address,
        onSale: !!nft.sale,
        salePriceTon: nft.sale ? Number(nft.sale.price.value) / 1e9 : null,
      })),
      tonPriceUsd: tonPrice,
    });
  } catch (err) {
    log.error({ err }, "gift_user_inventory error");
    return fail("Failed to scan inventory");
  }
}

// ─── 6. Profile Value ────────────────────────────────────────────────

const profileValueParams = Type.Object({
  username: Type.Optional(Type.String({ description: "Telegram username (without @)" })),
  wallet_address: Type.Optional(Type.String({ description: "TON wallet address" })),
});

async function profileValueExecutor(params: { username?: string; wallet_address?: string }, ctx: ToolContext): Promise<ToolResult> {
  try {
    let wallet = params.wallet_address;
    if (!wallet && params.username) {
      wallet = await resolveUsernameToWallet(params.username) || undefined;
      if (!wallet) return fail(`Could not resolve @${params.username} to a TON wallet.`);
    }
    if (!wallet) return fail("Provide either username or wallet_address");

    const nfts = await getUserNFTs(wallet);
    const tonPrice = await getTonPriceUsd();

    // Group by collection
    const byCol: Record<string, number> = {};
    for (const nft of nfts) {
      const col = nft.collection?.name || "Unknown";
      byCol[col] = (byCol[col] || 0) + 1;
    }

    let totalValueTon = 0;
    const collections: Array<{ collection: string; count: number; floorTon: number | null; totalTon: number | null }> = [];

    for (const [colName, count] of Object.entries(byCol)) {
      const slug = colName.toLowerCase().replace(/[^a-z0-9]/g, "");
      const floor = await fetchFloorPrice(slug);
      const floorTon = floor?.floorTon || null;
      const total = floorTon ? floorTon * count : null;
      if (total) totalValueTon += total;
      collections.push({ collection: colName, count, floorTon, totalTon: total ? Math.round(total * 100) / 100 : null });
    }

    collections.sort((a, b) => (b.totalTon || 0) - (a.totalTon || 0));

    return ok({
      username: params.username || null, wallet,
      totalGifts: nfts.length,
      totalValueTon: Math.round(totalValueTon * 100) / 100,
      totalValueUsd: Math.round(totalValueTon * tonPrice * 100) / 100,
      collections: collections.slice(0, 20),
      tonPriceUsd: tonPrice,
      note: "Values based on collection floor prices from Fragment.",
    });
  } catch (err) {
    log.error({ err }, "gift_profile_value error");
    return fail("Failed to calculate profile value");
  }
}

// ─── 7. Upgrade Stats ────────────────────────────────────────────────

const upgradeStatsParams = Type.Object({
  collection: Type.Optional(Type.String({ description: "Collection name (default: Plush Pepe)" })),
});

async function upgradeStatsExecutor(params: { collection?: string }, ctx: ToolContext): Promise<ToolResult> {
  try {
    const slug = params.collection ? params.collection.toLowerCase().replace(/[^a-z0-9]/g, "") : "plushpepe";
    const [listings, sales] = await Promise.all([fetchListings(slug, 50), fetchRecentSales(slug, 50)]);

    const activity = listings.length + sales.length;
    return ok({
      collection: params.collection || "Plush Pepe",
      activeListings: listings.length,
      recentSales: sales.length,
      marketActivity: activity > 50 ? "🔥 HIGH" : activity > 20 ? "📊 MEDIUM" : "❄️ LOW",
      listings: { cheapest: listings[0]?.priceTon || null, mostExpensive: listings[listings.length - 1]?.priceTon || null },
      sales: {
        cheapest: sales.length > 0 ? Math.min(...sales.map((s) => s.priceTon)) : null,
        mostExpensive: sales.length > 0 ? Math.max(...sales.map((s) => s.priceTon)) : null,
        avgPrice: sales.length > 0 ? Math.round((sales.reduce((a, s) => a + s.priceTon, 0) / sales.length) * 100) / 100 : null,
      },
      note: "Full on-chain upgrade tracking coming soon. Currently showing marketplace activity.",
    });
  } catch (err) {
    log.error({ err }, "gift_upgrade_stats error");
    return fail("Failed to fetch upgrade stats");
  }
}

// ─── Export ──────────────────────────────────────────────────────────

export const tools: ToolEntry[] = [
  {
    tool: { name: "gift_floor_prices", description: "🏷️ Get current floor prices for gift collections from Fragment. Pass a collection name for one, or omit for top collections.", parameters: floorPricesParams },
    executor: floorPricesExecutor,
  },
  {
    tool: { name: "gift_last_sales", description: "💰 Get recent completed sales (actual sale prices, not listings) for a gift collection.", parameters: lastSalesParams },
    executor: lastSalesExecutor,
  },
  {
    tool: { name: "gift_price_history", description: "📈 Show price trends for a gift collection over time (24h/7d/30d). Requires hourly snapshots.", parameters: priceHistoryParams },
    executor: priceHistoryExecutor,
  },
  {
    tool: { name: "gift_market_feed", description: "📡 Get active listings for a gift collection — what's on sale right now, sorted by price.", parameters: marketFeedParams },
    executor: marketFeedExecutor,
  },
  {
    tool: { name: "gift_user_inventory", description: "🔍 Scan any user's gift NFTs by username (TON DNS) or wallet address.", parameters: userInventoryParams },
    executor: userInventoryExecutor,
  },
  {
    tool: { name: "gift_profile_value", description: "💎 Calculate total gift portfolio value for any user. Combines inventory + floor prices.", parameters: profileValueParams },
    executor: profileValueExecutor,
  },
  {
    tool: { name: "gift_upgrade_stats", description: "🔄 Market activity & upgrade stats for a gift collection. Shows listings, sales, and activity level.", parameters: upgradeStatsParams },
    executor: upgradeStatsExecutor,
  },
];
