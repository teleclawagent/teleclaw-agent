/**
 * 🔢🔍 Number Sniper — Find undervalued Anonymous Numbers for flipping.
 */

import { Type } from "@sinclair/typebox";
import type { Tool, ToolExecutor, ToolResult } from "../types.js";
import { findUndervaluedNumbers, checkNumber } from "./fragment-service.js";
import { calculateRarity, formatRarityReport } from "./number-rarity.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("NumberSniper");

// ─── Number Sniper Search ────────────────────────────────────────────

interface SniperSearchParams {
  budget?: number;
  min_discount?: number;
  limit?: number;
}

export const numberSniperTool: Tool = {
  name: "number_sniper",
  description:
    "🔍 Number Sniper: Find undervalued +888 Anonymous Numbers on Fragment for flipping. " +
    "Compares listing prices against rarity-based valuation to find deals with the best upside. " +
    "Optionally filter by budget (max TON) and minimum discount percentage.",
  category: "data-bearing",
  parameters: Type.Object({
    budget: Type.Optional(
      Type.Number({
        description: "Maximum TON budget (e.g. 5000 for ≤5000 TON listings)",
        minimum: 1,
      })
    ),
    min_discount: Type.Optional(
      Type.Number({
        description: "Minimum discount % to consider a deal (default: 30 = 30% below estimated value)",
        minimum: 5,
        maximum: 90,
      })
    ),
    limit: Type.Optional(
      Type.Number({
        description: "Max results (default: 10)",
        minimum: 1,
        maximum: 25,
      })
    ),
  }),
};

export const numberSniperExecutor: ToolExecutor<SniperSearchParams> = async (
  params,
  _context
): Promise<ToolResult> => {
  try {
    const { budget, min_discount = 30, limit = 10 } = params;

    const deals = await findUndervaluedNumbers(budget, min_discount / 100);
    const limited = deals.slice(0, limit);

    if (limited.length === 0) {
      return {
        success: true,
        data: {
          deals: [],
          message: budget
            ? `No undervalued numbers found within ${budget} TON budget (min ${min_discount}% discount). Try increasing budget or lowering threshold.`
            : `No undervalued numbers found with ${min_discount}%+ discount. Market might be fairly priced.`,
        },
      };
    }

    const tierEmojis: Record<string, string> = { S: "🔴", A: "🟠", B: "🟡", C: "🟢", D: "⚪" };

    const summary = limited
      .map(
        (d, i) =>
          `${i + 1}. ${tierEmojis[d.rarityTier] || "⚪"} ${d.number} — ${d.price} (${d.rarityTier}, score ${d.rarityScore}/100)\n` +
          `   ${d.flipPotential}\n` +
          `   ${d.url}`
      )
      .join("\n\n");

    return {
      success: true,
      data: {
        totalFound: deals.length,
        showing: limited.length,
        budget: budget ? `${budget} TON` : "unlimited",
        minDiscount: `${min_discount}%`,
        deals: limited,
        message: `🔍 Number Sniper — ${deals.length} undervalued number${deals.length !== 1 ? "s" : ""} found${budget ? ` (≤${budget} TON)` : ""}:\n\n${summary}`,
      },
    };
  } catch (error) {
    log.error({ err: error }, "Number sniper error");
    return { success: false, error: `Number sniper failed: ${String(error)}` };
  }
};

// ─── Number Valuation ────────────────────────────────────────────────

interface ValuationParams {
  number: string;
}

export const numberValuationTool: Tool = {
  name: "number_valuation",
  description:
    "Estimate the value of a +888 Anonymous Number using rarity analysis (pattern, lucky digits, length) " +
    "combined with current Fragment listing data. Returns tier, score, price range, and deal analysis.",
  category: "data-bearing",
  parameters: Type.Object({
    number: Type.String({
      description: "The +888 number to evaluate (e.g. '+888 8 888', '88807684929')",
    }),
  }),
};

export const numberValuationExecutor: ToolExecutor<ValuationParams> = async (
  params,
  _context
): Promise<ToolResult> => {
  try {
    const rarity = calculateRarity(params.number);
    if (!rarity) {
      return { success: false, error: "Invalid +888 number format." };
    }

    // Try to get current Fragment listing
    const currentStatus = await checkNumber(params.number);

    const statusLine = currentStatus
      ? `Current status: ${currentStatus.status.toUpperCase()}${currentStatus.price ? ` at ${currentStatus.price}` : ""}`
      : "Not currently listed on Fragment";

    let dealAnalysis = "";
    if (currentStatus?.priceRaw && rarity.estimatedFloor.max > 0) {
      if (currentStatus.priceRaw < rarity.estimatedFloor.min) {
        dealAnalysis = "🟢 UNDERVALUED — strong buy signal";
      } else if (currentStatus.priceRaw > rarity.estimatedFloor.max) {
        dealAnalysis = "🔴 OVERPRICED — avoid or wait";
      } else {
        dealAnalysis = "🟡 FAIR PRICE — within estimated range";
      }
    }

    return {
      success: true,
      data: {
        number: rarity.number,
        tier: rarity.tier,
        score: rarity.score,
        label: rarity.label,
        tags: rarity.tags,
        breakdown: rarity.breakdown,
        estimatedFloor: rarity.estimatedFloor,
        currentStatus: currentStatus?.status,
        currentPrice: currentStatus?.price,
        dealAnalysis,
        message:
          formatRarityReport(rarity) +
          `\n\n${statusLine}` +
          (dealAnalysis ? `\n${dealAnalysis}` : ""),
      },
    };
  } catch (error) {
    log.error({ err: error }, "Number valuation error");
    return { success: false, error: `Valuation failed: ${String(error)}` };
  }
};

// ─── Number Check ────────────────────────────────────────────────────

interface CheckParams {
  number: string;
}

export const numberCheckTool: Tool = {
  name: "number_check",
  description:
    "Check a specific +888 Anonymous Number on Fragment: status (auction/sale/sold), " +
    "current price, bids, end time, owner, and rarity tier.",
  category: "data-bearing",
  parameters: Type.Object({
    number: Type.String({
      description: "Number to check (e.g. '+888 0768 4929', '88807684929')",
    }),
  }),
};

export const numberCheckExecutor: ToolExecutor<CheckParams> = async (
  params,
  _context
): Promise<ToolResult> => {
  try {
    const result = await checkNumber(params.number);

    if (!result) {
      return { success: false, error: "Could not fetch number data from Fragment." };
    }

    // Also run rarity analysis
    const rarity = calculateRarity(result.rawDigits);
    const tierEmojis: Record<string, string> = { S: "🔴", A: "🟠", B: "🟡", C: "🟢", D: "⚪" };

    const lines = [
      `${rarity ? tierEmojis[rarity.tier] + " " : ""}${result.number} — ${result.status.toUpperCase()}`,
    ];
    if (result.price) lines.push(`💰 Price: ${result.price}`);
    if (result.bids !== undefined) lines.push(`🔨 Bids: ${result.bids}`);
    if (result.endsAt) lines.push(`⏰ Ends: ${result.endsAt}`);
    if (result.owner) lines.push(`👤 Owner: ${result.owner}`);
    if (rarity) {
      lines.push(`📊 Rarity: ${rarity.tier} — ${rarity.label} (${rarity.score}/100)`);
      lines.push(`💎 Est: ${rarity.estimatedFloor.min.toLocaleString()}-${rarity.estimatedFloor.max.toLocaleString()} TON`);
      lines.push(`🏷️ ${rarity.tags.join(", ")}`);
    }
    lines.push(`🔗 ${result.url}`);

    return {
      success: true,
      data: {
        ...result,
        rarity: rarity ? { tier: rarity.tier, score: rarity.score, label: rarity.label, tags: rarity.tags } : null,
        message: lines.join("\n"),
      },
    };
  } catch (error) {
    log.error({ err: error }, "Number check error");
    return { success: false, error: `Check failed: ${String(error)}` };
  }
};
