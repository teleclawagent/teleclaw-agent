/**
 * 🎁 Gift Collection Tools — Complete Telegram gift data with real rarities.
 *
 * Data source: api.changes.tg (Telegram's official CDN data)
 * 109 collections, 7101 models, 7700 backdrops, 22830 symbols
 */

import { Type } from "@sinclair/typebox";
import type { Tool, ToolExecutor, ToolResult } from "../types.js";
import {
  getAllCollections,
  getCollection,
  getGiftStats,
  getModels,
  getBackdrops,
  getSymbols,
  calculateRarityScore,
  searchCollections,
  findRarestModels,
} from "./gifts-service.js";

// ─── gift_collections ────────────────────────────────────────────────

export const giftCollectionsTool: Tool = {
  name: "gift_collections",
  description:
    "List all Telegram gift collections with their model, backdrop, and symbol counts. Returns 109 collections.",
  category: "data-bearing",
  parameters: Type.Object({}),
};

export const giftCollectionsExecutor: ToolExecutor = async (): Promise<ToolResult> => {
  try {
    const stats = getGiftStats();
    const names = getAllCollections();

    const summary = names.map((name) => {
      const col = getCollection(name)!;
      return {
        name: col.name,
        id: col.id,
        models: col.totalModels,
        backdrops: col.totalBackdrops,
        symbols: col.totalSymbols,
      };
    });

    return {
      success: true,
      data: {
        totalCollections: stats.totalCollections,
        totalModels: stats.totalModels,
        totalBackdrops: stats.totalBackdrops,
        totalSymbols: stats.totalSymbols,
        source: stats.source,
        fetchedAt: stats.fetchedAt,
        collections: summary,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to list gift collections: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};

// ─── gift_collection_detail ──────────────────────────────────────────

export const giftCollectionDetailTool: Tool = {
  name: "gift_collection_detail",
  description:
    "Get full details for a gift collection: all models with names & rarity %, all backdrops with names, colors & rarity %, all symbols with names & rarity %. Use collection name like 'Plush Pepe', 'Santa Hat', etc.",
  category: "data-bearing",
  parameters: Type.Object({
    collection: Type.String({
      description: "Collection name (e.g. 'Plush Pepe', 'Scared Cat')",
    }),
  }),
};

interface CollectionDetailParams {
  collection: string;
}

export const giftCollectionDetailExecutor: ToolExecutor<CollectionDetailParams> = async (
  params
): Promise<ToolResult> => {
  try {
    const col = getCollection(params.collection);

    if (!col) {
      const matches = searchCollections(params.collection);
      if (matches.length > 0) {
        return {
          success: false,
          error: `Collection "${params.collection}" not found. Did you mean: ${matches
            .slice(0, 5)
            .map((m) => m.name)
            .join(", ")}?`,
        };
      }
      return { success: false, error: `Collection "${params.collection}" not found.` };
    }

    const models = getModels(params.collection);
    const backdrops = getBackdrops(params.collection);
    const symbols = getSymbols(params.collection);

    return {
      success: true,
      data: {
        name: col.name,
        id: col.id,
        customEmojiId: col.customEmojiId,
        totalModels: col.totalModels,
        totalBackdrops: col.totalBackdrops,
        totalSymbols: col.totalSymbols,
        models: models.map((m) => ({
          name: m.name,
          rarity: `${m.rarityPercent}%`,
          rarityPermille: m.rarity,
        })),
        backdrops: backdrops.map((b) => ({
          name: b.name,
          rarity: `${b.rarityPercent}%`,
          rarityPermille: b.rarity,
          colors: b.colors,
        })),
        symbols: symbols.map((s) => ({
          name: s.name,
          rarity: `${s.rarityPercent}%`,
          rarityPermille: s.rarity,
        })),
      },
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to get collection detail: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};

// ─── gift_rarity_check ───────────────────────────────────────────────

export const giftRarityCheckTool: Tool = {
  name: "gift_rarity_check",
  description:
    "Calculate the combined rarity score for a specific gift. Takes collection name, model, backdrop, symbol. Returns individual rarities + combined score + tier (Legendary/Epic/Rare/Uncommon/Common).",
  category: "data-bearing",
  parameters: Type.Object({
    collection: Type.String({ description: "Collection name (e.g. 'Plush Pepe')" }),
    model: Type.String({ description: "Model name (e.g. 'Pumpkin')" }),
    backdrop: Type.String({ description: "Backdrop name (e.g. 'Onyx Black')" }),
    symbol: Type.String({ description: "Symbol name (e.g. 'Illuminati')" }),
  }),
};

interface RarityCheckParams {
  collection: string;
  model: string;
  backdrop: string;
  symbol: string;
}

export const giftRarityCheckExecutor: ToolExecutor<RarityCheckParams> = async (
  params
): Promise<ToolResult> => {
  try {
    const result = calculateRarityScore(
      params.collection,
      params.model,
      params.backdrop,
      params.symbol
    );
    if (!result) {
      return {
        success: false,
        error:
          "Could not find one or more traits. Check collection, model, backdrop, and symbol names.",
      };
    }

    return {
      success: true,
      data: {
        collection: params.collection,
        model: { name: params.model, rarity: `${result.modelRarity / 10}%` },
        backdrop: { name: params.backdrop, rarity: `${result.backdropRarity / 10}%` },
        symbol: { name: params.symbol, rarity: `${result.symbolRarity / 10}%` },
        combinedRarityPermille: result.combinedPermille,
        combinedRarityPercent: `${(result.combinedPermille / 10).toFixed(1)}%`,
        tier: result.rarityTier,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to check rarity: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};

// ─── gift_search ─────────────────────────────────────────────────────

export const giftSearchTool: Tool = {
  name: "gift_search",
  description: "Search gift collections by keyword. Returns matching collections with stats.",
  category: "data-bearing",
  parameters: Type.Object({
    query: Type.String({ description: "Search keyword (e.g. 'pepe', 'snake', 'heart')" }),
  }),
};

interface GiftSearchParams {
  query: string;
}

export const giftSearchExecutor: ToolExecutor<GiftSearchParams> = async (
  params
): Promise<ToolResult> => {
  try {
    const results = searchCollections(params.query);

    return {
      success: true,
      data: {
        query: params.query,
        found: results.length,
        collections: results.map((c) => ({
          name: c.name,
          id: c.id,
          models: c.totalModels,
          backdrops: c.totalBackdrops,
          symbols: c.totalSymbols,
        })),
      },
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to search gifts: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};

// ─── gift_rarest ─────────────────────────────────────────────────────

export const giftRarestTool: Tool = {
  name: "gift_rarest",
  description:
    "Find the rarest models across all gift collections. Returns top N rarest with collection and rarity %.",
  category: "data-bearing",
  parameters: Type.Object({
    limit: Type.Optional(
      Type.Number({
        description: "How many results (default 20, max 50)",
        minimum: 1,
        maximum: 50,
      })
    ),
  }),
};

interface GiftRarestParams {
  limit?: number;
}

export const giftRarestExecutor: ToolExecutor<GiftRarestParams> = async (
  params
): Promise<ToolResult> => {
  try {
    const capped = Math.min(params.limit ?? 20, 50);
    const results = findRarestModels(capped);

    return {
      success: true,
      data: {
        showing: results.length,
        rarestModels: results.map((r) => ({
          collection: r.collection,
          model: r.model,
          rarity: `${r.rarityPercent}%`,
        })),
      },
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to find rarest gifts: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};
