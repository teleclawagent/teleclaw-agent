/**
 * 🎁 Gift Portfolio + P&L Tracker
 *
 * Track your Telegram gift collection with buy prices, rarity data,
 * and estimated value. See unrealized P&L at a glance.
 */

import { Type } from "@sinclair/typebox";
import type { Tool, ToolExecutor, ToolResult, ToolContext } from "../types.js";
import { getCollection, calculateRarityScore, searchCollections } from "./gifts-service.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("GiftPortfolio");

// ─── DB Schema ───────────────────────────────────────────────────────

function ensureGiftPortfolioTables(ctx: ToolContext): void {
  ctx.db.exec(`
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

    CREATE INDEX IF NOT EXISTS idx_gift_portfolio_user ON gift_portfolio(user_id);
  `);
}

function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ─── Valuation Helpers ───────────────────────────────────────────────

function getTraitMultiplier(rarityPercent: number): number {
  if (rarityPercent <= 1) return 10;
  if (rarityPercent <= 3) return 5;
  if (rarityPercent <= 5) return 3;
  if (rarityPercent <= 10) return 1.5;
  return 1;
}

function estimateGiftPremium(
  modelRarity: number,
  backdropRarity: number,
  symbolRarity: number
): { multiplier: number; premiumPct: number; tier: string } {
  const modelPct = modelRarity / 10;
  const backdropPct = backdropRarity / 10;
  const symbolPct = symbolRarity / 10;

  const m1 = getTraitMultiplier(modelPct);
  const m2 = getTraitMultiplier(backdropPct);
  const m3 = getTraitMultiplier(symbolPct);

  const combined = m1 * m2 * m3;
  const premiumPct = Math.round((combined - 1) * 100);

  let tier: string;
  if (combined >= 200) tier = "🏆 God-Tier";
  else if (combined >= 50) tier = "💎 Legendary";
  else if (combined >= 15) tier = "🔥 Epic";
  else if (combined >= 5) tier = "⭐ Rare";
  else if (combined >= 2) tier = "📈 Above Average";
  else tier = "📊 Common";

  return { multiplier: combined, premiumPct, tier };
}

// ─── gift_portfolio_add ──────────────────────────────────────────────

interface PortfolioAddParams {
  collection: string;
  gift_num?: number;
  model: string;
  backdrop: string;
  symbol: string;
  buy_price?: number;
  buy_currency?: string;
  buy_date?: string;
  notes?: string;
}

export const giftPortfolioAddTool: Tool = {
  name: "gift_portfolio_add",
  description:
    "🎁 Add a Telegram gift to your portfolio. Tracks buy price, rarity, and estimated value.\n\n" +
    "Provide collection name + model + backdrop + symbol. Rarity is auto-calculated.\n" +
    "Add buy_price to track P&L later.",
  category: "action",
  parameters: Type.Object({
    collection: Type.String({ description: "Collection name (e.g. 'Plush Pepe')" }),
    gift_num: Type.Optional(Type.Number({ description: "Gift number (e.g. #1847)" })),
    model: Type.String({ description: "Model name" }),
    backdrop: Type.String({ description: "Backdrop name" }),
    symbol: Type.String({ description: "Symbol name" }),
    buy_price: Type.Optional(Type.Number({ description: "Price paid", minimum: 0 })),
    buy_currency: Type.Optional(
      Type.String({ description: "Currency: TON, Stars, USDT (default: TON)" })
    ),
    buy_date: Type.Optional(Type.String({ description: "When you bought it (YYYY-MM-DD)" })),
    notes: Type.Optional(Type.String({ description: "Any notes" })),
  }),
};

export const giftPortfolioAddExecutor: ToolExecutor<PortfolioAddParams> = async (
  params,
  context
): Promise<ToolResult> => {
  try {
    ensureGiftPortfolioTables(context);

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

    const id = generateId("gpf");

    context.db
      .prepare(
        `INSERT INTO gift_portfolio
         (id, user_id, collection, gift_num, model, backdrop, symbol, model_rarity, backdrop_rarity, symbol_rarity, combined_rarity, rarity_tier, buy_price, buy_currency, buy_date, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        context.senderId,
        col.name,
        params.gift_num ?? null,
        params.model,
        params.backdrop,
        params.symbol,
        rarity.modelRarity,
        rarity.backdropRarity,
        rarity.symbolRarity,
        rarity.combinedPermille,
        rarity.rarityTier,
        params.buy_price ?? null,
        params.buy_currency ?? "TON",
        params.buy_date ?? null,
        params.notes ?? null
      );

    const premium = estimateGiftPremium(
      rarity.modelRarity,
      rarity.backdropRarity,
      rarity.symbolRarity
    );

    return {
      success: true,
      data: {
        portfolioId: id,
        collection: col.name,
        giftNum: params.gift_num,
        model: { name: params.model, rarity: `${rarity.modelRarity / 10}%` },
        backdrop: { name: params.backdrop, rarity: `${rarity.backdropRarity / 10}%` },
        symbol: { name: params.symbol, rarity: `${rarity.symbolRarity / 10}%` },
        tier: rarity.rarityTier,
        buyPrice: params.buy_price
          ? `${params.buy_price} ${params.buy_currency ?? "TON"}`
          : "Not set",
        estimatedPremium: `${premium.premiumPct}% over floor`,
        valuationTier: premium.tier,
      },
    };
  } catch (err: unknown) {
    log.error({ err }, "Error adding to gift portfolio");
    return { success: false, error: `Failed: ${err instanceof Error ? err.message : String(err)}` };
  }
};

// ─── gift_portfolio_remove ───────────────────────────────────────────

interface PortfolioRemoveParams {
  portfolio_id: string;
}

export const giftPortfolioRemoveTool: Tool = {
  name: "gift_portfolio_remove",
  description: "🎁 Remove a gift from your portfolio by its portfolio entry ID.",
  category: "action",
  parameters: Type.Object({
    portfolio_id: Type.String({ description: "Portfolio entry ID to remove" }),
  }),
};

export const giftPortfolioRemoveExecutor: ToolExecutor<PortfolioRemoveParams> = async (
  params,
  context
): Promise<ToolResult> => {
  try {
    ensureGiftPortfolioTables(context);

    const entry = context.db
      .prepare(`SELECT * FROM gift_portfolio WHERE id = ? AND user_id = ?`)
      .get(params.portfolio_id, context.senderId) as GiftPortfolioRow | undefined;

    if (!entry) {
      return { success: false, error: "Portfolio entry not found or not yours." };
    }

    context.db.prepare(`DELETE FROM gift_portfolio WHERE id = ?`).run(params.portfolio_id);

    return {
      success: true,
      data: {
        removed: params.portfolio_id,
        collection: entry.collection,
        model: entry.model,
      },
    };
  } catch (err: unknown) {
    return {
      success: false,
      error: `Remove failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
};

// ─── gift_portfolio_view ─────────────────────────────────────────────

export const giftPortfolioViewTool: Tool = {
  name: "gift_portfolio_view",
  description:
    "🎁 View your complete gift portfolio with rarity, buy prices, estimated premiums, and P&L summary.\n\n" +
    "Shows each gift's rarity tier, what you paid, estimated premium over floor, and overall portfolio stats.",
  category: "data-bearing",
  parameters: Type.Object({}),
};

export const giftPortfolioViewExecutor: ToolExecutor = async (
  _params,
  context
): Promise<ToolResult> => {
  try {
    ensureGiftPortfolioTables(context);

    const entries = context.db
      .prepare(`SELECT * FROM gift_portfolio WHERE user_id = ? ORDER BY created_at DESC`)
      .all(context.senderId) as GiftPortfolioRow[];

    if (entries.length === 0) {
      return {
        success: true,
        data: {
          total: 0,
          message:
            "Your gift portfolio is empty. Use gift_portfolio_add to start tracking your collection.",
        },
      };
    }

    let totalInvested = 0;
    let bestPremium = { id: "", collection: "", premium: 0 };
    let worstPremium = { id: "", collection: "", premium: Infinity };
    const tierCounts: Record<string, number> = {};

    const gifts = entries.map((e) => {
      const premium = estimateGiftPremium(
        e.model_rarity ?? 0,
        e.backdrop_rarity ?? 0,
        e.symbol_rarity ?? 0
      );

      if (e.buy_price) totalInvested += e.buy_price;

      tierCounts[e.rarity_tier ?? "Unknown"] = (tierCounts[e.rarity_tier ?? "Unknown"] || 0) + 1;

      if (premium.premiumPct > bestPremium.premium) {
        bestPremium = {
          id: e.id,
          collection: `${e.collection} ${e.model}`,
          premium: premium.premiumPct,
        };
      }
      if (premium.premiumPct < worstPremium.premium) {
        worstPremium = {
          id: e.id,
          collection: `${e.collection} ${e.model}`,
          premium: premium.premiumPct,
        };
      }

      return {
        id: e.id,
        collection: e.collection,
        giftNum: e.gift_num,
        model: `${e.model} (${(e.model_rarity ?? 0) / 10}%)`,
        backdrop: `${e.backdrop} (${(e.backdrop_rarity ?? 0) / 10}%)`,
        symbol: `${e.symbol} (${(e.symbol_rarity ?? 0) / 10}%)`,
        tier: e.rarity_tier,
        buyPrice: e.buy_price ? `${e.buy_price} ${e.buy_currency}` : "N/A",
        buyDate: e.buy_date,
        estimatedPremium: `${premium.premiumPct}% over floor`,
        valuationTier: premium.tier,
      };
    });

    return {
      success: true,
      data: {
        total: entries.length,
        totalInvested: totalInvested > 0 ? `${totalInvested} TON` : "Not tracked",
        tierBreakdown: tierCounts,
        bestPerformer:
          bestPremium.premium > 0
            ? { gift: bestPremium.collection, premium: `${bestPremium.premium}% over floor` }
            : null,
        worstPerformer:
          worstPremium.premium < Infinity
            ? { gift: worstPremium.collection, premium: `${worstPremium.premium}% over floor` }
            : null,
        gifts,
      },
    };
  } catch (err: unknown) {
    log.error({ err }, "Error viewing gift portfolio");
    return { success: false, error: `Failed: ${err instanceof Error ? err.message : String(err)}` };
  }
};

// ─── Row Type ────────────────────────────────────────────────────────

interface GiftPortfolioRow {
  id: string;
  user_id: number;
  collection: string;
  gift_num: number | null;
  model: string;
  backdrop: string;
  symbol: string;
  model_rarity: number | null;
  backdrop_rarity: number | null;
  symbol_rarity: number | null;
  combined_rarity: number | null;
  rarity_tier: string | null;
  buy_price: number | null;
  buy_currency: string;
  buy_date: string | null;
  notes: string | null;
  created_at: string;
}
