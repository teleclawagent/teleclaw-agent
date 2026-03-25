/**
 * 🏪 Unified Marketplace Tools
 *
 * Asset-based tools that search across ALL marketplaces.
 * The agent uses these instead of marketplace-specific tools.
 *
 * Marketplace is an implementation detail — user says "find cheapest Plush Pepe",
 * agent searches Fragment + Getgems + Market.app + Tonnel + Portals + MRKT.
 */

import { Type } from "@sinclair/typebox";
import type { Tool, ToolExecutor, ToolResult, ToolEntry } from "../types.js";
import { aggregatedSearch, aggregatedGetListing, checkMarketplaceHealth } from "./aggregator.js";
import type { AssetKind } from "./types.js";
import { MARKETPLACE_SUPPORT } from "./types.js";

// ─── marketplace_search ─────────────────────────────────────────────

interface MarketSearchParams {
  asset_type: AssetKind;
  query?: string;
  collection?: string;
  model?: string;
  backdrop?: string;
  symbol?: string;
  min_tier?: string;
  max_price?: number;
  sort_by?: "price" | "rarity" | "newest";
  limit?: number;
  marketplace?: string;
}

const marketSearchTool: Tool = {
  name: "marketplace_search",
  description:
    "🏪 Search across ALL marketplaces at once for usernames, numbers, or gifts.\n" +
    "USE THIS TOOL whenever a user asks about prices, floor prices, or where to buy/sell.\n" +
    "NEVER quote prices from memory — always call this tool for live data.\n\n" +
    "IMPORTANT — GIFT LISTINGS ARE ON-CHAIN/NFT ONLY:\n" +
    "Market.app API only exposes on-chain (NFT) gift listings at the item level.\n" +
    "Off-chain / non-NFT gifts are NOT included in search results.\n" +
    "If a user asks about off-chain gifts, explain this limitation.\n\n" +
    "MARKETPLACES CHECKED:\n" +
    "• Market.app (primary) — on-chain/NFT gift listings via API\n" +
    "• Fragment — Telegram's official marketplace (on-chain gifts via scraper)\n" +
    "• Getgems — Major NFT marketplace\n\n" +
    "Results are normalized and sorted by price. Shows which marketplace has the best deal.\n\n" +
    "EXAMPLES:\n" +
    "• Search usernames: asset_type='username', query='crypto'\n" +
    "• Search numbers: asset_type='number', query='888777'\n" +
    "• Search gifts: asset_type='gift', collection='Plush Pepe', min_tier='Epic'\n" +
    "• Find cheapest: asset_type='gift', collection='Plush Pepe', sort_by='price'\n" +
    "• Market.app only: asset_type='gift', collection='Plush Pepe', marketplace='marketapp'\n" +
    "• Fragment only: asset_type='gift', collection='Plush Pepe', marketplace='fragment'\n\n" +
    "Use 'marketplace' param to isolate a single source. Omit for cross-marketplace search.",
  category: "data-bearing",
  parameters: Type.Object({
    asset_type: Type.Union(
      [Type.Literal("username"), Type.Literal("number"), Type.Literal("gift")],
      { description: "What to search for" }
    ),
    query: Type.Optional(Type.String({ description: "Search keyword (for usernames/numbers)" })),
    collection: Type.Optional(Type.String({ description: "Gift collection name" })),
    model: Type.Optional(Type.String({ description: "Gift model filter" })),
    backdrop: Type.Optional(Type.String({ description: "Gift backdrop filter" })),
    symbol: Type.Optional(Type.String({ description: "Gift symbol filter" })),
    min_tier: Type.Optional(
      Type.String({ description: "Min rarity tier (Legendary/Epic/Rare/Uncommon)" })
    ),
    max_price: Type.Optional(Type.Number({ description: "Max price in TON", minimum: 0 })),
    sort_by: Type.Optional(
      Type.Union([Type.Literal("price"), Type.Literal("rarity"), Type.Literal("newest")], {
        description: "Sort order (default: price)",
      })
    ),
    limit: Type.Optional(
      Type.Number({ description: "Max results (default 20)", minimum: 1, maximum: 50 })
    ),
    marketplace: Type.Optional(
      Type.String({
        description:
          "Filter to a specific marketplace: 'fragment', 'marketapp', 'getgems', 'tonnel', 'portals', 'mrkt'. Omit to search all.",
      })
    ),
  }),
};

const marketSearchExecutor: ToolExecutor<MarketSearchParams> = async (params, context) => {
  try {
    const result = await aggregatedSearch(
      {
        assetKind: params.asset_type,
        query: params.query,
        collection: params.collection,
        model: params.model,
        backdrop: params.backdrop,
        symbol: params.symbol,
        minTier: params.min_tier,
        maxPrice: params.max_price,
        sortBy: params.sort_by || "price",
        limit: params.limit ?? 20,
        marketplace: params.marketplace,
      },
      {
        marketappToken: context.marketappToken ?? null,
      }
    );

    return {
      success: true,
      data: {
        assetType: params.asset_type,
        totalFound: result.totalFound,
        marketplacesChecked: result.marketplacesChecked,
        marketplacesFailed:
          result.marketplacesFailed.length > 0 ? result.marketplacesFailed : undefined,
        note:
          result.marketplacesFailed.length > 0
            ? `⚠️ ${result.marketplacesFailed.length}/${result.marketplacesChecked.length} marketplaces unavailable (${result.marketplacesFailed.join(", ")}). Results may be incomplete — prices shown are from available sources only.`
            : undefined,
        bestDeal: result.bestDeal
          ? {
              marketplace: result.bestDeal.marketplace,
              price: result.bestDeal.priceTon ? `${result.bestDeal.priceTon} TON` : "N/A",
              identifier: result.bestDeal.identifier || result.bestDeal.collection,
              url: result.bestDeal.url,
            }
          : null,
        priceRange:
          result.priceRange.lowest !== null
            ? {
                lowest: `${result.priceRange.lowest} TON (${result.priceRange.marketplace_lowest})`,
                highest: `${result.priceRange.highest} TON`,
              }
            : null,
        listings: result.listings.map((l) => ({
          marketplace: l.marketplace,
          identifier: l.identifier,
          collection: l.collection,
          giftNum: l.giftNum,
          model: l.model,
          backdrop: l.backdrop,
          symbol: l.symbol,
          rarityTier: l.rarityTier,
          price: l.priceTon
            ? `${l.priceTon} TON`
            : l.originalPrice
              ? `${l.originalPrice} ${l.originalCurrency}`
              : "N/A",
          floorPrice: l.floorPriceTon ? `${l.floorPriceTon} TON` : undefined,
          onSale: l.onSaleCount,
          type: l.listingType,
          onChain: l.onChain,
          url: l.url,
        })),
      },
    };
  } catch (err: unknown) {
    return {
      success: false,
      error: `Search failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
};

// ─── marketplace_compare ─────────────────────────────────────────────

interface MarketCompareParams {
  asset_type: AssetKind;
  identifier: string;
}

const marketCompareTool: Tool = {
  name: "marketplace_compare",
  description:
    "🏪 Compare prices for a specific username, number, or gift across all marketplaces.\n\n" +
    "Shows where it's listed, at what price, and which marketplace has the best deal.\n\n" +
    "EXAMPLES:\n" +
    "• Compare username: asset_type='username', identifier='crypto'\n" +
    "• Compare number: asset_type='number', identifier='+888123456'\n" +
    "• Compare gift: asset_type='gift', identifier='<nft_address>'",
  category: "data-bearing",
  parameters: Type.Object({
    asset_type: Type.Union([
      Type.Literal("username"),
      Type.Literal("number"),
      Type.Literal("gift"),
    ]),
    identifier: Type.String({ description: "Username, number (+888...), or NFT address" }),
  }),
};

const marketCompareExecutor: ToolExecutor<MarketCompareParams> = async (params, context) => {
  try {
    const result = await aggregatedGetListing(params.asset_type, params.identifier, {
      marketappToken: context.marketappToken ?? null,
    });

    if (result.listings.length === 0) {
      return {
        success: true,
        data: {
          identifier: params.identifier,
          found: false,
          message: `"${params.identifier}" not found on any marketplace.`,
        },
      };
    }

    return {
      success: true,
      data: {
        identifier: params.identifier,
        foundOn: result.listings.length,
        cheapest: result.cheapest
          ? {
              marketplace: result.cheapest.marketplace,
              price: result.cheapest.priceTon ? `${result.cheapest.priceTon} TON` : "N/A",
              url: result.cheapest.url,
            }
          : null,
        allListings: result.listings.map((l) => ({
          marketplace: l.marketplace,
          price: l.priceTon
            ? `${l.priceTon} TON`
            : l.originalPrice
              ? `${l.originalPrice} ${l.originalCurrency}`
              : "N/A",
          type: l.listingType,
          onChain: l.onChain,
          url: l.url,
        })),
        savingsIfBuyingCheapest:
          result.listings.length >= 2 && result.listings[0].priceTon && result.listings[1].priceTon
            ? `${(result.listings[1].priceTon - result.listings[0].priceTon).toFixed(2)} TON vs next cheapest (${result.listings[1].marketplace})`
            : null,
      },
    };
  } catch (err: unknown) {
    return {
      success: false,
      error: `Compare failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
};

// ─── marketplace_health ──────────────────────────────────────────────

const marketHealthTool: Tool = {
  name: "marketplace_health",
  description:
    "🏪 Check which marketplaces are currently online and what they support.\n" +
    "Useful for debugging when searches return no results.",
  category: "data-bearing",
  parameters: Type.Object({}),
};

const marketHealthExecutor: ToolExecutor = async (_params, context): Promise<ToolResult> => {
  try {
    const health = await checkMarketplaceHealth({ marketappToken: context.marketappToken ?? null });

    return {
      success: true,
      data: {
        marketplaces: health.map((h) => ({
          id: h.id,
          name: h.name,
          status: h.available ? "🟢 Online" : "🔴 Offline",
          supports: h.supports.join(", "),
        })),
        summary: {
          online: health.filter((h) => h.available).length,
          offline: health.filter((h) => !h.available).length,
          total: health.length,
        },
        assetCoverage: {
          usernames: `${Object.entries(MARKETPLACE_SUPPORT).filter(([, v]) => v.includes("username")).length} marketplaces`,
          numbers: `${Object.entries(MARKETPLACE_SUPPORT).filter(([, v]) => v.includes("number")).length} marketplaces`,
          gifts: `${Object.entries(MARKETPLACE_SUPPORT).filter(([, v]) => v.includes("gift")).length} marketplaces`,
        },
      },
    };
  } catch (err: unknown) {
    return {
      success: false,
      error: `Health check failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
};

// ─── Export ──────────────────────────────────────────────────────────

export const tools: ToolEntry[] = [
  { tool: marketSearchTool, executor: marketSearchExecutor },
  { tool: marketCompareTool, executor: marketCompareExecutor },
  { tool: marketHealthTool, executor: marketHealthExecutor },
];
