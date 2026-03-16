/**
 * 🔢 Anonymous Number Tools — Rarity check, compare, search by pattern.
 */

import { Type } from "@sinclair/typebox";
import type { Tool, ToolExecutor, ToolResult, ToolContext } from "../types.js";
import { calculateRarity, formatRarityReport, compareNumbers, type RarityResult } from "./number-rarity.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("NumberTools");

// ─── Tool: Number Rarity Check ───────────────────────────────────────

interface RarityCheckParams {
  number: string;
}

export const numberRarityTool: Tool = {
  name: "number_rarity",
  description:
    "Check the rarity tier, score, and estimated value of a Telegram Anonymous Number (+888). " +
    "Analyzes pattern quality, lucky digits, length, and uniqueness. " +
    "Works for any +888 number format.",
  category: "data-bearing",
  parameters: Type.Object({
    number: Type.String({
      description: "The anonymous number to analyze (e.g. +888 8 888, +888 0768 4929, 88807684929)",
    }),
  }),
};

export const numberRarityExecutor: ToolExecutor<RarityCheckParams> = async (
  params,
  _ctx
): Promise<ToolResult> => {
  try {
    const result = calculateRarity(params.number);
    if (!result) {
      return {
        success: false,
        error: "Invalid number format. Must be a +888 anonymous number.",
      };
    }

    return {
      success: true,
      data: {
        ...result,
        message: formatRarityReport(result),
      },
    };
  } catch (error) {
    log.error({ err: error }, "Number rarity check error");
    return { success: false, error: String(error) };
  }
};

// ─── Tool: Compare Numbers ───────────────────────────────────────────

interface CompareParams {
  numbers: string[];
}

export const numberCompareTool: Tool = {
  name: "number_compare",
  description:
    "Compare multiple anonymous numbers side by side — rarity tier, score, estimated value. " +
    "Ranks them from most to least rare. Great for deciding which to buy/sell first.",
  category: "data-bearing",
  parameters: Type.Object({
    numbers: Type.Array(Type.String(), {
      description: "List of numbers to compare (2-10)",
      minItems: 2,
      maxItems: 10,
    }),
  }),
};

export const numberCompareExecutor: ToolExecutor<CompareParams> = async (
  params,
  _ctx
): Promise<ToolResult> => {
  try {
    const results = compareNumbers(params.numbers);
    if (results.length === 0) {
      return {
        success: false,
        error: "No valid numbers provided.",
      };
    }

    const lines = results.map((r, i) => {
      const tierEmojis: Record<string, string> = { S: "🔴", A: "🟠", B: "🟡", C: "🟢", D: "⚪" };
      const emoji = tierEmojis[r.tier] || "⚪";
      return (
        `${i + 1}. ${emoji} ${r.number}\n` +
        `   ${r.tier} (${r.score}/100) — ${r.label}\n` +
        `   💰 ${r.estimatedFloor.min.toLocaleString()}-${r.estimatedFloor.max.toLocaleString()} TON\n` +
        `   🏷️ ${r.tags.slice(0, 3).join(", ")}`
      );
    });

    const best = results[0];
    const worst = results[results.length - 1];

    return {
      success: true,
      data: {
        rankings: results,
        message: [
          `📊 *Number Comparison* (${results.length} numbers)\n`,
          ...lines,
          ``,
          `🏆 Best: ${best.number} (${best.tier}, ${best.score}/100)`,
          `📉 Lowest: ${worst.number} (${worst.tier}, ${worst.score}/100)`,
        ].join("\n"),
      },
    };
  } catch (error) {
    log.error({ err: error }, "Number compare error");
    return { success: false, error: String(error) };
  }
};

// ─── Tool: Number Portfolio Rarity ───────────────────────────────────

export const numberPortfolioRarityTool: Tool = {
  name: "number_portfolio_rarity",
  description:
    "Analyze the rarity of all anonymous numbers in your portfolio. " +
    "Shows tier distribution, total estimated value, and which to sell first.",
  category: "data-bearing",
  parameters: Type.Object({}),
};

export const numberPortfolioRarityExecutor: ToolExecutor<Record<string, never>> = async (
  _params,
  ctx
): Promise<ToolResult> => {
  try {
    // Get numbers from portfolio
    const entries = ctx.db
      .prepare(
        `SELECT username FROM fragment_portfolio WHERE user_id = ? AND username LIKE '+888%'`
      )
      .all(ctx.senderId) as Array<{ username: string }>;

    if (entries.length === 0) {
      return {
        success: true,
        data: {
          message: "📭 No anonymous numbers in your portfolio. Add them with `portfolio add +888 XXXX XXXX`.",
        },
      };
    }

    const results = compareNumbers(entries.map((e) => e.username));

    // Tier distribution
    const tierCounts: Record<string, number> = { S: 0, A: 0, B: 0, C: 0, D: 0 };
    let totalMin = 0;
    let totalMax = 0;

    for (const r of results) {
      tierCounts[r.tier]++;
      totalMin += r.estimatedFloor.min;
      totalMax += r.estimatedFloor.max;
    }

    const tierEmojis: Record<string, string> = { S: "🔴", A: "🟠", B: "🟡", C: "🟢", D: "⚪" };

    const lines = results.slice(0, 15).map((r, i) => {
      const emoji = tierEmojis[r.tier];
      return `${i + 1}. ${emoji} ${r.number} — ${r.tier} (${r.score}) | ${r.estimatedFloor.min.toLocaleString()}-${r.estimatedFloor.max.toLocaleString()} TON`;
    });

    const tierDist = Object.entries(tierCounts)
      .filter(([, count]) => count > 0)
      .map(([tier, count]) => `${tierEmojis[tier]} ${tier}: ${count}`)
      .join(" | ");

    return {
      success: true,
      data: {
        results,
        summary: { tierCounts, totalMin, totalMax, count: results.length },
        message: [
          `🔢 *Number Portfolio Rarity*\n`,
          tierDist,
          `💰 Total est: ${totalMin.toLocaleString()}-${totalMax.toLocaleString()} TON`,
          ``,
          ...lines,
          results.length > 15 ? `\n...and ${results.length - 15} more` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      },
    };
  } catch (error) {
    log.error({ err: error }, "Number portfolio rarity error");
    return { success: false, error: String(error) };
  }
};
