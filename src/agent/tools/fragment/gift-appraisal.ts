/**
 * 💎 Gift Appraisal — AI-driven gift valuation engine.
 *
 * Combines rarity data, trait multipliers, and aesthetic bonuses
 * to estimate a gift's premium over collection floor price.
 */

import { Type } from "@sinclair/typebox";
import type { Tool, ToolExecutor, ToolResult } from "../types.js";
import { getCollection, calculateRarityScore, searchCollections } from "./gifts-service.js";

// ─── Valuation Logic ─────────────────────────────────────────────────

function getTraitMultiplier(rarityPermille: number): { multiplier: number; label: string } {
  const pct = rarityPermille / 10;
  if (pct <= 1) return { multiplier: 10, label: "Legendary (≤1%)" };
  if (pct <= 3) return { multiplier: 5, label: "Epic (1-3%)" };
  if (pct <= 5) return { multiplier: 3, label: "Rare (3-5%)" };
  if (pct <= 10) return { multiplier: 1.5, label: "Uncommon (5-10%)" };
  return { multiplier: 1, label: "Common (>10%)" };
}

// Dark, gold, and red backdrops tend to carry aesthetic premiums
const PREMIUM_BACKDROP_KEYWORDS = [
  "onyx",
  "black",
  "dark",
  "midnight",
  "obsidian",
  "noir",
  "gold",
  "golden",
  "amber",
  "royal",
  "crimson",
  "ruby",
  "scarlet",
  "blood",
  "red",
  "diamond",
  "crystal",
  "platinum",
  "silver",
];

function getAestheticBonus(
  backdropName: string,
  colors: { centerColor?: string; edgeColor?: string } | null
): {
  bonus: number;
  reason: string | null;
} {
  const lower = backdropName.toLowerCase();

  // Check keywords
  for (const keyword of PREMIUM_BACKDROP_KEYWORDS) {
    if (lower.includes(keyword)) {
      return { bonus: 1.2, reason: `Premium aesthetic: "${backdropName}" (dark/gold/red tones)` };
    }
  }

  // Check actual color values for dark backgrounds
  if (colors?.centerColor) {
    const hex = colors.centerColor.replace("#", "");
    if (hex.length === 6) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      const brightness = (r + g + b) / 3;
      if (brightness < 60) {
        return {
          bonus: 1.15,
          reason: `Dark backdrop (#${hex}, brightness ${Math.round(brightness)})`,
        };
      }
    }
  }

  return { bonus: 1, reason: null };
}

// ─── gift_appraise ───────────────────────────────────────────────────

interface AppraiseParams {
  collection: string;
  model: string;
  backdrop: string;
  symbol: string;
}

export const giftAppraiseTool: Tool = {
  name: "gift_appraise",
  description:
    "💎 Get an AI-driven valuation for a Telegram gift.\n\n" +
    "Analyzes:\n" +
    "• Individual trait rarities (model, backdrop, symbol)\n" +
    "• Trait multipliers (Legendary 10x → Common 1x)\n" +
    "• Combined score (product of all multipliers)\n" +
    "• Aesthetic bonus (dark/gold/red backdrops carry premium)\n" +
    "• Final estimated premium over collection floor price\n\n" +
    "Returns a human-readable assessment with valuation tier.\n" +
    "Note: This is a rarity-based estimate, not a market price. Actual value depends on demand, " +
    "collection floor, and current market conditions.",
  category: "data-bearing",
  parameters: Type.Object({
    collection: Type.String({ description: "Collection name (e.g. 'Plush Pepe')" }),
    model: Type.String({ description: "Model name" }),
    backdrop: Type.String({ description: "Backdrop name" }),
    symbol: Type.String({ description: "Symbol name" }),
  }),
};

export const giftAppraiseExecutor: ToolExecutor<AppraiseParams> = async (
  params
): Promise<ToolResult> => {
  try {
    const col = getCollection(params.collection);
    if (!col) {
      const suggestions = searchCollections(params.collection);
      return {
        success: false,
        error: `Collection "${params.collection}" not found.${
          suggestions.length > 0
            ? ` Did you mean: ${suggestions
                .slice(0, 3)
                .map((s) => s.name)
                .join(", ")}?`
            : ""
        }`,
      };
    }

    const rarity = calculateRarityScore(
      params.collection,
      params.model,
      params.backdrop,
      params.symbol
    );
    if (!rarity) {
      return {
        success: false,
        error: `Could not verify traits. Check model/backdrop/symbol names for "${params.collection}".`,
      };
    }

    // Calculate multipliers
    const modelMult = getTraitMultiplier(rarity.modelRarity);
    const backdropMult = getTraitMultiplier(rarity.backdropRarity);
    const symbolMult = getTraitMultiplier(rarity.symbolRarity);

    // Get backdrop colors for aesthetic bonus
    const backdropData = col.backdrops.find(
      (b) => b.name.toLowerCase() === params.backdrop.toLowerCase()
    );
    const aesthetic = getAestheticBonus(params.backdrop, backdropData?.colors ?? null);

    // Combined score
    const baseMultiplier = modelMult.multiplier * backdropMult.multiplier * symbolMult.multiplier;
    const finalMultiplier = baseMultiplier * aesthetic.bonus;
    const premiumPct = Math.round((finalMultiplier - 1) * 100);

    // Valuation tier
    let valuationTier: string;
    let assessment: string;

    if (finalMultiplier >= 500) {
      valuationTier = "🏆 God-Tier";
      assessment =
        "One of the rarest possible combinations. Triple legendary traits. Collector's holy grail — name your price.";
    } else if (finalMultiplier >= 100) {
      valuationTier = "💎 Ultra Legendary";
      assessment =
        "Extremely rare combo with multiple legendary traits. These rarely trade and command massive premiums.";
    } else if (finalMultiplier >= 50) {
      valuationTier = "🔥 Legendary";
      assessment =
        "Outstanding rarity. At least one legendary trait paired with other rare traits. Significant premium over floor.";
    } else if (finalMultiplier >= 15) {
      valuationTier = "⭐ Epic";
      assessment =
        "Well above average. Multiple uncommon+ traits combine for a strong premium. Solid collector's piece.";
    } else if (finalMultiplier >= 5) {
      valuationTier = "📈 Rare";
      assessment =
        "Noticeably above floor. Some desirable traits that set it apart from common gifts in this collection.";
    } else if (finalMultiplier >= 2) {
      valuationTier = "📊 Above Average";
      assessment =
        "Slightly better than typical. Minor premium justified by one or two less common traits.";
    } else {
      valuationTier = "📉 Floor";
      assessment =
        "Common trait combination. Trades near floor price. Value depends on overall collection demand.";
    }

    return {
      success: true,
      data: {
        collection: col.name,
        traits: {
          model: {
            name: params.model,
            rarity: `${rarity.modelRarity / 10}%`,
            multiplier: `${modelMult.multiplier}x`,
            tier: modelMult.label,
          },
          backdrop: {
            name: params.backdrop,
            rarity: `${rarity.backdropRarity / 10}%`,
            multiplier: `${backdropMult.multiplier}x`,
            tier: backdropMult.label,
          },
          symbol: {
            name: params.symbol,
            rarity: `${rarity.symbolRarity / 10}%`,
            multiplier: `${symbolMult.multiplier}x`,
            tier: symbolMult.label,
          },
        },
        aestheticBonus: aesthetic.reason
          ? { multiplier: `${aesthetic.bonus}x`, reason: aesthetic.reason }
          : null,
        score: {
          baseMultiplier: `${baseMultiplier.toFixed(1)}x`,
          finalMultiplier: `${finalMultiplier.toFixed(1)}x`,
          estimatedPremium: `${premiumPct}% over floor`,
        },
        rarityTier: rarity.rarityTier,
        valuationTier,
        assessment,
        disclaimer:
          "Rarity-based estimate. Actual market value depends on demand, floor price, and liquidity.",
      },
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to appraise gift: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};
