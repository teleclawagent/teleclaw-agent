/**
 * 🏪 Gift Marketplace Aggregator Tools
 *
 * Tools:
 * - gift_price_compare: Compare prices across all marketplaces for a collection
 * - gift_sniper: Find undervalued gifts (low price + high rarity)
 * - gift_best_deal: Quick best deal finder
 * - gift_arbitrage: Find price differences between marketplaces
 */

import { Type } from "@sinclair/typebox";
import type { Tool, ToolExecutor, ToolResult } from "../types.js";
import { aggregateGiftPrices, compareFloorPrices } from "./marketplace-aggregator.js";
import { getCollection, calculateRarityScore } from "./gifts-service.js";

// ─── gift_price_compare ──────────────────────────────────────────────

export const giftPriceCompareTool: Tool = {
  name: "gift_price_compare",
  description:
    "Compare gift prices across all marketplaces (Tonnel, Portals, Fragment, Telegram). " +
    "Shows floor price per marketplace, total listings, and cheapest option. " +
    "Optionally filter by model, backdrop, or symbol.",
  category: "data-bearing",
  parameters: Type.Object({
    collection: Type.String({
      description: "Gift collection name (e.g. 'Plush Pepe', 'Scared Cat')",
    }),
    model: Type.Optional(Type.String({ description: "Filter by model name (e.g. 'Pumpkin')" })),
    backdrop: Type.Optional(
      Type.String({ description: "Filter by backdrop name (e.g. 'Onyx Black')" })
    ),
    symbol: Type.Optional(
      Type.String({ description: "Filter by symbol name (e.g. 'Illuminati')" })
    ),
    limit: Type.Optional(
      Type.Number({ description: "Max listings to return (default 10)", minimum: 1, maximum: 30 })
    ),
  }),
};

interface PriceCompareParams {
  collection: string;
  model?: string;
  backdrop?: string;
  symbol?: string;
  limit?: number;
}

export const giftPriceCompareExecutor: ToolExecutor<PriceCompareParams> = async (
  params
): Promise<ToolResult> => {
  try {
    const result = await aggregateGiftPrices(params.collection, {
      model: params.model,
      backdrop: params.backdrop,
      symbol: params.symbol,
      limit: params.limit || 10,
    });

    return {
      success: true,
      data: {
        collection: result.collection,
        filters: {
          model: params.model || "any",
          backdrop: params.backdrop || "any",
          symbol: params.symbol || "any",
        },
        floorPrices: result.floors.map((f) => ({
          marketplace: f.marketplace,
          floorTon: f.priceTon ? `${f.priceTon} TON` : "N/A",
          floorStars: f.priceStars ? `${f.priceStars} ⭐` : undefined,
          listings: f.listingCount,
          url: f.url,
        })),
        bestDeal: result.bestDeal
          ? {
              marketplace: result.bestDeal.marketplace,
              price: `${result.bestDeal.priceTon} TON`,
              url: result.bestDeal.url,
            }
          : "No listings found",
        totalListings: result.totalListings,
        topListings: result.listings.slice(0, 5).map((l) => ({
          marketplace: l.marketplace,
          price: l.priceTon ? `${l.priceTon} TON` : `${l.priceStars} ⭐`,
          model: l.model,
          backdrop: l.backdrop,
          symbol: l.symbol,
          giftNum: l.giftNum,
        })),
        errors: result.errors.length > 0 ? result.errors : undefined,
        fetchedAt: result.fetchedAt,
      },
    };
  } catch (err: unknown) {
    return {
      success: false,
      error: `Price comparison failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
};

// ─── gift_sniper ─────────────────────────────────────────────────────

export const giftSniperTool: Tool = {
  name: "gift_sniper",
  description:
    "🔍 Find undervalued gifts across all marketplaces. Combines price data with rarity scores " +
    "to find gifts listed below their expected value. Calculates value score = rarity ÷ price. " +
    "Higher score = better deal. Filters by budget if specified.",
  category: "data-bearing",
  parameters: Type.Object({
    collection: Type.String({
      description: "Gift collection name (e.g. 'Plush Pepe')",
    }),
    budget: Type.Optional(
      Type.Number({
        description: "Maximum TON budget (e.g. 100 for ≤100 TON)",
        minimum: 1,
      })
    ),
    limit: Type.Optional(
      Type.Number({ description: "Max results (default 10)", minimum: 1, maximum: 30 })
    ),
  }),
};

interface SniperParams {
  collection: string;
  budget?: number;
  limit?: number;
}

export const giftSniperExecutor: ToolExecutor<SniperParams> = async (
  params
): Promise<ToolResult> => {
  try {
    const col = getCollection(params.collection);
    if (!col) {
      return { success: false, error: `Collection "${params.collection}" not found.` };
    }

    const result = await aggregateGiftPrices(params.collection, {
      limit: 30, // fetch more to filter
    });

    // Score each listing: lower combined rarity permille + lower price = better
    const scored = result.listings
      .filter((l) => l.priceTon && l.priceTon > 0)
      .filter((l) => !params.budget || (l.priceTon && l.priceTon <= params.budget))
      .map((l) => {
        // Calculate rarity score if we have model/backdrop/symbol
        let rarityScore: ReturnType<typeof calculateRarityScore> = null;
        if (l.model && l.backdrop && l.symbol) {
          rarityScore = calculateRarityScore(params.collection, l.model, l.backdrop, l.symbol);
        }

        const combinedRarity = rarityScore?.combinedPermille ?? 999;
        const inverseRarity = 1000 - combinedRarity; // higher = rarer
        const valueScore = l.priceTon ? inverseRarity / l.priceTon : 0;

        return {
          ...l,
          rarityScore,
          valueScore: Math.round(valueScore * 100) / 100,
          tier: rarityScore?.rarityTier ?? "Unknown",
        };
      })
      .sort((a, b) => b.valueScore - a.valueScore) // best value first
      .slice(0, params.limit || 10);

    return {
      success: true,
      data: {
        collection: params.collection,
        budget: params.budget ? `≤${params.budget} TON` : "unlimited",
        deals: scored.map((s) => ({
          marketplace: s.marketplace,
          price: `${s.priceTon} TON`,
          model: s.model,
          backdrop: s.backdrop,
          symbol: s.symbol,
          tier: s.tier,
          modelRarity: s.rarityScore ? `${s.rarityScore.modelRarity / 10}%` : undefined,
          backdropRarity: s.rarityScore ? `${s.rarityScore.backdropRarity / 10}%` : undefined,
          symbolRarity: s.rarityScore ? `${s.rarityScore.symbolRarity / 10}%` : undefined,
          valueScore: s.valueScore,
          giftNum: s.giftNum,
          url: s.url,
        })),
        totalFound: scored.length,
        marketplacesChecked: result.floors.map((f) => f.marketplace),
        errors: result.errors.length > 0 ? result.errors : undefined,
      },
    };
  } catch (err: unknown) {
    return {
      success: false,
      error: `Sniper search failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
};

// ─── gift_best_deal ──────────────────────────────────────────────────

export const giftBestDealTool: Tool = {
  name: "gift_best_deal",
  description:
    "Quick floor price check — find the cheapest marketplace to buy a gift collection. " +
    "Returns floor price per marketplace with no individual listings (fast).",
  category: "data-bearing",
  parameters: Type.Object({
    collection: Type.String({
      description: "Gift collection name (e.g. 'Toy Bear', 'Diamond Ring')",
    }),
  }),
};

interface BestDealParams {
  collection: string;
}

export const giftBestDealExecutor: ToolExecutor<BestDealParams> = async (
  params
): Promise<ToolResult> => {
  try {
    const result = await compareFloorPrices(params.collection);

    return {
      success: true,
      data: {
        collection: params.collection,
        floors: result.floors.map((f) => ({
          marketplace: f.marketplace,
          floor: f.priceTon ? `${f.priceTon} TON` : "N/A",
          listings: f.listingCount,
        })),
        bestDeal: result.bestDeal
          ? {
              marketplace: result.bestDeal.marketplace,
              price: `${result.bestDeal.priceTon} TON`,
              savings:
                result.floors.length > 1
                  ? `${Math.round((((result.floors[result.floors.length - 1]?.priceTon ?? 0) - (result.bestDeal.priceTon ?? 0)) / (result.floors[result.floors.length - 1]?.priceTon ?? 1)) * 100)}% cheaper than ${result.floors[result.floors.length - 1]?.marketplace}`
                  : undefined,
            }
          : "No listings found across any marketplace",
        errors: result.errors.length > 0 ? result.errors : undefined,
      },
    };
  } catch (err: unknown) {
    return {
      success: false,
      error: `Best deal search failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
};

// ─── gift_arbitrage ──────────────────────────────────────────────────

export const giftArbitrageTool: Tool = {
  name: "gift_arbitrage",
  description:
    "🔄 Find arbitrage opportunities — gifts listed at different prices on different marketplaces. " +
    "Buy low on one marketplace, sell high on another. Shows price spread and potential profit.",
  category: "data-bearing",
  parameters: Type.Object({
    collection: Type.String({
      description: "Gift collection name (e.g. 'Plush Pepe')",
    }),
    minSpreadPercent: Type.Optional(
      Type.Number({
        description: "Minimum price spread % to consider (default: 10)",
        minimum: 1,
        maximum: 90,
      })
    ),
  }),
};

interface ArbitrageParams {
  collection: string;
  minSpreadPercent?: number;
}

export const giftArbitrageExecutor: ToolExecutor<ArbitrageParams> = async (
  params
): Promise<ToolResult> => {
  try {
    const result = await aggregateGiftPrices(params.collection, { limit: 30 });
    const minSpread = (params.minSpreadPercent ?? 10) / 100;

    if (result.floors.length < 2) {
      return {
        success: true,
        data: {
          collection: params.collection,
          message: "Need at least 2 marketplaces with listings to find arbitrage.",
          floors: result.floors,
          errors: result.errors,
        },
      };
    }

    const cheapest = result.floors[0];
    const opportunities = result.floors
      .slice(1)
      .filter((f) => {
        if (!cheapest.priceTon || !f.priceTon) return false;
        const spread = (f.priceTon - cheapest.priceTon) / cheapest.priceTon;
        return spread >= minSpread;
      })
      .map((f) => {
        const spread =
          (((f.priceTon ?? 0) - (cheapest.priceTon ?? 0)) / (cheapest.priceTon ?? 1)) * 100;
        const profit = (f.priceTon ?? 0) - (cheapest.priceTon ?? 0);
        return {
          buyOn: cheapest.marketplace,
          buyPrice: `${cheapest.priceTon} TON`,
          sellOn: f.marketplace,
          sellPrice: `${f.priceTon} TON`,
          spread: `${Math.round(spread)}%`,
          potentialProfit: `${Math.round(profit * 100) / 100} TON`,
        };
      });

    return {
      success: true,
      data: {
        collection: params.collection,
        opportunities:
          opportunities.length > 0 ? opportunities : "No arbitrage found above threshold",
        minSpreadThreshold: `${params.minSpreadPercent ?? 10}%`,
        floors: result.floors.map((f) => ({
          marketplace: f.marketplace,
          floor: `${f.priceTon} TON`,
          listings: f.listingCount,
        })),
        errors: result.errors.length > 0 ? result.errors : undefined,
      },
    };
  } catch (err: unknown) {
    return {
      success: false,
      error: `Arbitrage search failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
};
