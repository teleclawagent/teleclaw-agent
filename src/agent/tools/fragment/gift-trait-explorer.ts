/**
 * 🔍 Gift Trait Explorer — Cross-collection trait search.
 *
 * Search for any trait name across all 109 collections.
 * Find which collections have "Illuminati" symbol, compare rarity across them.
 * Nobody else offers this — unique to Teleclaw.
 */

import { Type } from "@sinclair/typebox";
import type { Tool, ToolExecutor, ToolResult } from "../types.js";
import {
  getAllCollections,
  getCollection,
} from "./gifts-service.js";

// ─── gift_trait_search ───────────────────────────────────────────────

interface TraitSearchParams {
  trait_name: string;
  trait_type?: "model" | "backdrop" | "symbol" | "all";
  limit?: number;
}

export const giftTraitSearchTool: Tool = {
  name: "gift_trait_search",
  description:
    "🔍 Search for a specific trait across ALL 109 gift collections.\n\n" +
    "Find every collection that has a specific model, backdrop, or symbol.\n" +
    "Example: search 'Illuminati' → see which collections have it and how rare it is in each.\n" +
    "Example: search 'Onyx Black' → find all collections with this backdrop.\n\n" +
    "Great for:\n" +
    "• Finding where a specific trait is rarest (best value)\n" +
    "• Discovering which collections share aesthetics\n" +
    "• Building trait-matched sets across collections",
  category: "data-bearing",
  parameters: Type.Object({
    trait_name: Type.String({ description: "Trait name to search (e.g. 'Illuminati', 'Onyx Black', 'Pumpkin')" }),
    trait_type: Type.Optional(
      Type.Union([
        Type.Literal("model"),
        Type.Literal("backdrop"),
        Type.Literal("symbol"),
        Type.Literal("all"),
      ], { description: "Filter by trait type. Default: all" })
    ),
    limit: Type.Optional(Type.Number({ description: "Max results (default 50)", minimum: 1, maximum: 100 })),
  }),
};

interface TraitMatch {
  collection: string;
  traitType: "model" | "backdrop" | "symbol";
  traitName: string;
  rarityPermille: number;
  rarityPercent: number;
  colors?: {
    centerColor: string;
    edgeColor: string;
    patternColor: string;
    textColor: string;
  };
}

export const giftTraitSearchExecutor: ToolExecutor<TraitSearchParams> = async (
  params
): Promise<ToolResult> => {
  try {
    const query = params.trait_name.toLowerCase();
  const typeFilter = params.trait_type ?? "all";
  const limit = Math.min(params.limit ?? 50, 100);
  const results: TraitMatch[] = [];

  const allNames = getAllCollections();

  for (const name of allNames) {
    const col = getCollection(name);
    if (!col) continue;

    if (typeFilter === "all" || typeFilter === "model") {
      for (const m of col.models) {
        if (m.name.toLowerCase().includes(query)) {
          results.push({
            collection: col.name,
            traitType: "model",
            traitName: m.name,
            rarityPermille: m.rarity,
            rarityPercent: m.rarityPercent,
          });
        }
      }
    }

    if (typeFilter === "all" || typeFilter === "backdrop") {
      for (const b of col.backdrops) {
        if (b.name.toLowerCase().includes(query)) {
          results.push({
            collection: col.name,
            traitType: "backdrop",
            traitName: b.name,
            rarityPermille: b.rarity,
            rarityPercent: b.rarityPercent,
            colors: b.colors,
          });
        }
      }
    }

    if (typeFilter === "all" || typeFilter === "symbol") {
      for (const s of col.symbols) {
        if (s.name.toLowerCase().includes(query)) {
          results.push({
            collection: col.name,
            traitType: "symbol",
            traitName: s.name,
            rarityPermille: s.rarity,
            rarityPercent: s.rarityPercent,
          });
        }
      }
    }
  }

  // Sort by rarity (rarest first)
  results.sort((a, b) => a.rarityPermille - b.rarityPermille);
  const capped = results.slice(0, limit);

  // Group by trait type for summary
  const typeCounts = { model: 0, backdrop: 0, symbol: 0 };
  for (const r of results) typeCounts[r.traitType]++;

  return {
    success: true,
    data: {
      query: params.trait_name,
      typeFilter,
      totalFound: results.length,
      showing: capped.length,
      summary: typeCounts,
      rarestOccurrence: capped.length > 0
        ? { collection: capped[0].collection, type: capped[0].traitType, rarity: `${capped[0].rarityPercent}%` }
        : null,
      mostCommonOccurrence: results.length > 0
        ? {
            collection: results[results.length - 1].collection,
            type: results[results.length - 1].traitType,
            rarity: `${results[results.length - 1].rarityPercent}%`,
          }
        : null,
      results: capped.map((r) => ({
        collection: r.collection,
        type: r.traitType,
        name: r.traitName,
        rarity: `${r.rarityPercent}%`,
        rarityPermille: r.rarityPermille,
        ...(r.colors ? { colors: r.colors } : {}),
      })),
    },
  };
  } catch (error) {
    return {
      success: false,
      error: `Failed to search traits: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};

// ─── gift_trait_compare ──────────────────────────────────────────────

interface TraitCompareParams {
  trait_name: string;
  trait_type: "model" | "backdrop" | "symbol";
}

export const giftTraitCompareTool: Tool = {
  name: "gift_trait_compare",
  description:
    "📊 Compare the rarity of the same trait across all collections.\n\n" +
    "Shows which collection gives the best/worst odds for a specific trait.\n" +
    "Example: compare 'Illuminati' symbol → sorted from rarest (0.5% in Plush Pepe) to most common (5% in Santa Hat).\n\n" +
    "Useful for:\n" +
    "• Finding the cheapest collection to get a specific trait\n" +
    "• Identifying where a trait is most valuable (rarest)\n" +
    "• Price arbitrage between collections with same trait",
  category: "data-bearing",
  parameters: Type.Object({
    trait_name: Type.String({ description: "Exact trait name to compare" }),
    trait_type: Type.Union([
      Type.Literal("model"),
      Type.Literal("backdrop"),
      Type.Literal("symbol"),
    ], { description: "Trait type: model, backdrop, or symbol" }),
  }),
};

export const giftTraitCompareExecutor: ToolExecutor<TraitCompareParams> = async (
  params
): Promise<ToolResult> => {
  try {
    const query = params.trait_name.toLowerCase();
  const allNames = getAllCollections();
  const matches: Array<{
    collection: string;
    traitName: string;
    rarityPermille: number;
    rarityPercent: number;
  }> = [];

  for (const name of allNames) {
    const col = getCollection(name);
    if (!col) continue;

    let traits: Array<{ name: string; rarity: number; rarityPercent: number }>;
    switch (params.trait_type) {
      case "model":
        traits = col.models;
        break;
      case "backdrop":
        traits = col.backdrops;
        break;
      case "symbol":
        traits = col.symbols;
        break;
    }

    for (const t of traits) {
      if (t.name.toLowerCase() === query) {
        matches.push({
          collection: col.name,
          traitName: t.name,
          rarityPermille: t.rarity,
          rarityPercent: t.rarityPercent,
        });
      }
    }
  }

  // Sort rarest first
  matches.sort((a, b) => a.rarityPermille - b.rarityPermille);

  const avgRarity = matches.length > 0
    ? matches.reduce((sum, m) => sum + m.rarityPercent, 0) / matches.length
    : 0;

  return {
    success: true,
    data: {
      trait: params.trait_name,
      type: params.trait_type,
      foundInCollections: matches.length,
      averageRarity: `${avgRarity.toFixed(1)}%`,
      rarest: matches.length > 0
        ? { collection: matches[0].collection, rarity: `${matches[0].rarityPercent}%` }
        : null,
      mostCommon: matches.length > 0
        ? {
            collection: matches[matches.length - 1].collection,
            rarity: `${matches[matches.length - 1].rarityPercent}%`,
          }
        : null,
      comparison: matches.map((m) => ({
        collection: m.collection,
        rarity: `${m.rarityPercent}%`,
        rarityPermille: m.rarityPermille,
        verdict:
          m.rarityPermille <= 10
            ? "🏆 Legendary"
            : m.rarityPermille <= 30
            ? "🔥 Epic"
            : m.rarityPermille <= 50
            ? "⭐ Rare"
            : m.rarityPermille <= 100
            ? "📈 Uncommon"
            : "📊 Common",
      })),
    },
  };
  } catch (error) {
    return {
      success: false,
      error: `Failed to compare traits: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};
