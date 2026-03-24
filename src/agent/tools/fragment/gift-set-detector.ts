/**
 * 🎨 Gift Set Detector — Find matching traits across your collection.
 *
 * Scans your portfolio for shared backdrops, symbols, or models.
 * Suggests other collections to complete themed sets.
 */

import { Type } from "@sinclair/typebox";
import type { Tool, ToolExecutor, ToolResult } from "../types.js";
import { getAllCollections, getCollection } from "./gifts-service.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("GiftSetDetector");

// ─── gift_set_scan ───────────────────────────────────────────────────

export const giftSetScanTool: Tool = {
  name: "gift_set_scan",
  description:
    "🎨 Analyze your gift portfolio and find shared traits across your collection.\n\n" +
    "Discovers:\n" +
    "• Gifts sharing the same backdrop (color-matched set)\n" +
    "• Gifts sharing the same symbol (symbol set)\n" +
    "• Gifts sharing the same model name across collections\n\n" +
    "For each group, shows completion suggestions — other collections that have the same trait " +
    "so you can expand your set.\n\n" +
    "Requires gifts in your portfolio (use gift_portfolio_add first).",
  category: "data-bearing",
  parameters: Type.Object({}),
};

interface PortfolioRow {
  id: string;
  collection: string;
  gift_num: number | null;
  model: string;
  backdrop: string;
  symbol: string;
  rarity_tier: string | null;
}

interface SetGroup {
  trait: string;
  traitType: "model" | "backdrop" | "symbol";
  gifts: Array<{ collection: string; giftNum: number | null; tier: string | null }>;
  completionSuggestions: Array<{ collection: string; rarity: string }>;
}

export const giftSetScanExecutor: ToolExecutor = async (_params, context): Promise<ToolResult> => {
  try {
    // Ensure portfolio table exists (created by gift-portfolio.ts)
    context.db.exec(`
      CREATE TABLE IF NOT EXISTS gift_portfolio (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        collection TEXT NOT NULL,
        gift_num INTEGER,
        model TEXT NOT NULL,
        backdrop TEXT NOT NULL,
        symbol TEXT NOT NULL,
        model_rarity REAL,
        backdrop_rarity REAL,
        symbol_rarity REAL,
        combined_rarity REAL,
        rarity_tier TEXT,
        buy_price REAL,
        buy_currency TEXT NOT NULL DEFAULT 'TON',
        buy_date TEXT,
        notes TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    const entries = context.db
      .prepare(
        `SELECT id, collection, gift_num, model, backdrop, symbol, rarity_tier FROM gift_portfolio WHERE user_id = ?`
      )
      .all(context.senderId) as PortfolioRow[];

    if (entries.length < 2) {
      return {
        success: true,
        data: {
          total: entries.length,
          message:
            entries.length === 0
              ? "Your portfolio is empty. Add gifts with gift_portfolio_add first."
              : "You need at least 2 gifts to detect sets. Add more gifts!",
        },
      };
    }

    const allCollectionNames = getAllCollections();
    const ownedCollections = new Set(entries.map((e) => e.collection.toLowerCase()));

    // Group by each trait type
    const groups: SetGroup[] = [];

    for (const traitType of ["backdrop", "symbol", "model"] as const) {
      const traitMap = new Map<string, PortfolioRow[]>();

      for (const entry of entries) {
        const traitVal = entry[traitType].toLowerCase();
        if (!traitMap.has(traitVal)) traitMap.set(traitVal, []);
        traitMap.get(traitVal)?.push(entry);
      }

      for (const [traitVal, giftsInGroup] of traitMap) {
        if (giftsInGroup.length < 2) continue; // Only show groups of 2+

        // Find other collections with same trait for completion
        const suggestions: Array<{ collection: string; rarity: string }> = [];

        for (const colName of allCollectionNames) {
          if (ownedCollections.has(colName.toLowerCase())) continue;
          // Check if already in this group from a different gift
          if (giftsInGroup.some((g) => g.collection.toLowerCase() === colName.toLowerCase()))
            continue;

          const col = getCollection(colName);
          if (!col) continue;

          let _found = false;
          if (traitType === "model") {
            const match = col.models.find((m) => m.name.toLowerCase() === traitVal);
            if (match) {
              suggestions.push({ collection: colName, rarity: `${match.rarityPercent}%` });
              _found = true;
            }
          } else if (traitType === "backdrop") {
            const match = col.backdrops.find((b) => b.name.toLowerCase() === traitVal);
            if (match) {
              suggestions.push({ collection: colName, rarity: `${match.rarityPercent}%` });
              _found = true;
            }
          } else {
            const match = col.symbols.find((s) => s.name.toLowerCase() === traitVal);
            if (match) {
              suggestions.push({ collection: colName, rarity: `${match.rarityPercent}%` });
              _found = true;
            }
          }
        }

        // Sort suggestions by rarity (most common first = easier to get)
        suggestions.sort((a, b) => parseFloat(b.rarity) - parseFloat(a.rarity));

        groups.push({
          trait: giftsInGroup[0][traitType], // Use original casing from first match
          traitType,
          gifts: giftsInGroup.map((g) => ({
            collection: g.collection,
            giftNum: g.gift_num,
            tier: g.rarity_tier,
          })),
          completionSuggestions: suggestions.slice(0, 5),
        });
      }
    }

    // Sort by group size (biggest sets first)
    groups.sort((a, b) => b.gifts.length - a.gifts.length);

    return {
      success: true,
      data: {
        portfolioSize: entries.length,
        setsFound: groups.length,
        sets: groups.map((g) => ({
          trait: g.trait,
          type: g.traitType,
          count: g.gifts.length,
          gifts: g.gifts,
          canExpandTo: g.completionSuggestions.length,
          suggestions: g.completionSuggestions,
        })),
        tip:
          groups.length === 0
            ? "No shared traits found yet. Your gifts all have unique traits — very diverse collection!"
            : `Found ${groups.length} trait groups. Look at completion suggestions to build themed sets!`,
      },
    };
  } catch (err: unknown) {
    log.error({ err }, "Error scanning gift sets");
    return {
      success: false,
      error: `Scan failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
};

// ─── gift_set_suggest ────────────────────────────────────────────────

interface SetSuggestParams {
  trait_name: string;
  trait_type: "model" | "backdrop" | "symbol";
  limit?: number;
}

export const giftSetSuggestTool: Tool = {
  name: "gift_set_suggest",
  description:
    "🎨 Find all collections that share a specific trait — useful for set building.\n\n" +
    "Example: 'Onyx Black' backdrop → shows every collection with Onyx Black and how rare it is.\n" +
    "Great for planning which collections to target for a themed set.\n\n" +
    "No portfolio needed — works for anyone.",
  category: "data-bearing",
  parameters: Type.Object({
    trait_name: Type.String({ description: "Trait name (e.g. 'Onyx Black', 'Illuminati')" }),
    trait_type: Type.Union(
      [Type.Literal("model"), Type.Literal("backdrop"), Type.Literal("symbol")],
      { description: "Trait type" }
    ),
    limit: Type.Optional(
      Type.Number({ description: "Max results (default 20)", minimum: 1, maximum: 50 })
    ),
  }),
};

export const giftSetSuggestExecutor: ToolExecutor<SetSuggestParams> = async (
  params
): Promise<ToolResult> => {
  const query = params.trait_name.toLowerCase();
  const limit = params.limit ?? 20;
  const allNames = getAllCollections();
  const matches: Array<{
    collection: string;
    traitName: string;
    rarityPercent: number;
    rarityPermille: number;
  }> = [];

  for (const name of allNames) {
    const col = getCollection(name);
    if (!col) continue;

    if (params.trait_type === "model") {
      const m = col.models.find((t) => t.name.toLowerCase() === query);
      if (m)
        matches.push({
          collection: name,
          traitName: m.name,
          rarityPercent: m.rarityPercent,
          rarityPermille: m.rarity,
        });
    } else if (params.trait_type === "backdrop") {
      const b = col.backdrops.find((t) => t.name.toLowerCase() === query);
      if (b)
        matches.push({
          collection: name,
          traitName: b.name,
          rarityPercent: b.rarityPercent,
          rarityPermille: b.rarity,
        });
    } else {
      const s = col.symbols.find((t) => t.name.toLowerCase() === query);
      if (s)
        matches.push({
          collection: name,
          traitName: s.name,
          rarityPercent: s.rarityPercent,
          rarityPermille: s.rarity,
        });
    }
  }

  // Sort by rarity — easiest to get first (for set building)
  matches.sort((a, b) => b.rarityPermille - a.rarityPermille);
  const capped = matches.slice(0, limit);

  return {
    success: true,
    data: {
      trait: params.trait_name,
      type: params.trait_type,
      foundInCollections: matches.length,
      easiestToGet:
        capped.length > 0
          ? { collection: capped[0].collection, rarity: `${capped[0].rarityPercent}%` }
          : null,
      rarestVersion:
        matches.length > 0
          ? {
              collection: matches[matches.length - 1].collection,
              rarity: `${matches[matches.length - 1].rarityPercent}%`,
            }
          : null,
      collections: capped.map((m) => ({
        collection: m.collection,
        rarity: `${m.rarityPercent}%`,
        difficulty:
          m.rarityPermille >= 100
            ? "🟢 Easy"
            : m.rarityPermille >= 50
              ? "🟡 Medium"
              : m.rarityPermille >= 20
                ? "🟠 Hard"
                : "🔴 Very Hard",
      })),
    },
  };
};
