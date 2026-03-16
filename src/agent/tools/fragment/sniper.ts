/**
 * 🔍 Sniper Mode — Find undervalued Fragment usernames for flipping.
 *
 * "Bütçem 200 TON, en iyi flip fırsatlarını bul"
 */

import { Type } from "@sinclair/typebox";
import type { Tool, ToolExecutor, ToolResult } from "../types.js";
import { findUndervalued, checkUsername, estimateValue } from "./fragment-service.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("FragmentSniper");

// ─── Sniper Search ───────────────────────────────────────────────────

interface SniperSearchParams {
  budget?: number;
  min_discount?: number;
  limit?: number;
}

export const fragmentSniperTool: Tool = {
  name: "fragment_sniper",
  description:
    "🔍 Sniper Mode: Find undervalued Telegram usernames on Fragment for flipping. " +
    "Compares listing prices against estimated market value to find deals with the best upside. " +
    "Optionally filter by budget (max TON to spend) and minimum discount percentage.",
  category: "data-bearing",
  parameters: Type.Object({
    budget: Type.Optional(
      Type.Number({
        description: "Maximum TON budget to spend (e.g. 200 for ≤200 TON listings)",
        minimum: 1,
      })
    ),
    min_discount: Type.Optional(
      Type.Number({
        description:
          "Minimum discount percentage to consider a deal (default: 30 = 30% below estimated value)",
        minimum: 5,
        maximum: 90,
      })
    ),
    limit: Type.Optional(
      Type.Number({
        description: "Max results to return (default: 10)",
        minimum: 1,
        maximum: 25,
      })
    ),
  }),
};

export const fragmentSniperExecutor: ToolExecutor<SniperSearchParams> = async (
  params,
  _context
): Promise<ToolResult> => {
  try {
    const { budget, min_discount = 30, limit = 10 } = params;

    const deals = await findUndervalued(budget, min_discount / 100);
    const limited = deals.slice(0, limit);

    if (limited.length === 0) {
      return {
        success: true,
        data: {
          deals: [],
          message: budget
            ? `No undervalued usernames found within ${budget} TON budget (min ${min_discount}% discount). Try increasing budget or lowering discount threshold.`
            : `No undervalued usernames found with ${min_discount}%+ discount. Market might be fairly priced right now.`,
        },
      };
    }

    const summary = limited
      .map(
        (d, i) =>
          `${i + 1}. ${d.username} — ${d.price} (est. value: ~${d.estimatedValue} TON, ${d.discount}% undervalued)\n   ${d.flipPotential}\n   ${d.url}`
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
        message: `🔍 Sniper Mode — ${deals.length} undervalued username${deals.length !== 1 ? "s" : ""} found${budget ? ` (≤${budget} TON)` : ""}:\n\n${summary}`,
      },
    };
  } catch (error) {
    log.error({ err: error }, "Sniper search error");
    return {
      success: false,
      error: `Sniper search failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};

// ─── Username Valuation ──────────────────────────────────────────────

interface ValuationParams {
  username: string;
}

export const fragmentValuationTool: Tool = {
  name: "fragment_valuation",
  description:
    "Estimate the market value of a Telegram username based on length, keywords, " +
    "comparable sales, and market trends. Returns low/mid/high estimates with confidence level.",
  category: "data-bearing",
  parameters: Type.Object({
    username: Type.String({
      description: "Username to evaluate (with or without @ prefix)",
    }),
  }),
};

export const fragmentValuationExecutor: ToolExecutor<ValuationParams> = async (
  params,
  _context
): Promise<ToolResult> => {
  try {
    const { username } = params;
    const clean = username.replace(/^@/, "");

    // Get current Fragment status + valuation in parallel
    const [currentStatus, valuation] = await Promise.all([
      checkUsername(clean),
      estimateValue(clean),
    ]);

    const statusLine = currentStatus
      ? `Current status: ${currentStatus.status.toUpperCase()}${currentStatus.price ? ` at ${currentStatus.price}` : ""}`
      : "Status: Could not fetch from Fragment";

    const comparableLine =
      valuation.comparables.length > 0
        ? `\nComparable sales:\n${valuation.comparables.map((c) => `  ${c.username}: ${c.soldPrice} TON`).join("\n")}`
        : "\nNo comparable sales found — estimate based on characteristics only";

    const dealAnalysis =
      currentStatus?.priceRaw && valuation.estimated.mid
        ? currentStatus.priceRaw < valuation.estimated.low
          ? "🟢 UNDERVALUED — strong buy signal"
          : currentStatus.priceRaw > valuation.estimated.high
            ? "🔴 OVERPRICED — avoid or negotiate"
            : "🟡 FAIR PRICE — market rate"
        : "";

    return {
      success: true,
      data: {
        username: `@${clean}`,
        currentStatus: currentStatus?.status,
        currentPrice: currentStatus?.price,
        estimated: valuation.estimated,
        confidence: valuation.confidence,
        factors: valuation.factors,
        comparables: valuation.comparables,
        dealAnalysis,
        message:
          `💰 Valuation: @${clean}\n\n` +
          `${statusLine}\n\n` +
          `Estimated value:\n` +
          `  Low:  ${valuation.estimated.low} TON\n` +
          `  Mid:  ${valuation.estimated.mid} TON\n` +
          `  High: ${valuation.estimated.high} TON\n` +
          `  Confidence: ${valuation.confidence}\n\n` +
          `Factors:\n${valuation.factors.map((f) => `  • ${f}`).join("\n")}\n` +
          `${comparableLine}\n` +
          `${dealAnalysis ? `\n${dealAnalysis}` : ""}`,
      },
    };
  } catch (error) {
    log.error({ err: error }, "Valuation error");
    return {
      success: false,
      error: `Valuation failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};

// ─── Username Check ──────────────────────────────────────────────────

interface CheckParams {
  username: string;
}

export const fragmentCheckTool: Tool = {
  name: "fragment_check",
  description:
    "Check a specific Telegram username on Fragment: status (auction/sale/sold/available), " +
    "current price, bids, end time, and owner.",
  category: "data-bearing",
  parameters: Type.Object({
    username: Type.String({
      description: "Username to check (with or without @ prefix)",
    }),
  }),
};

export const fragmentCheckExecutor: ToolExecutor<CheckParams> = async (
  params,
  _context
): Promise<ToolResult> => {
  try {
    const result = await checkUsername(params.username);

    if (!result) {
      return {
        success: false,
        error: "Could not fetch username data from Fragment",
      };
    }

    const lines = [
      `@${result.username.replace(/^@/, "")} — ${result.status.toUpperCase()}`,
    ];
    if (result.price) lines.push(`Price: ${result.price}`);
    if (result.bids !== undefined) lines.push(`Bids: ${result.bids}`);
    if (result.endsAt) lines.push(`Ends: ${result.endsAt}`);
    if (result.owner) lines.push(`Owner: ${result.owner}`);

    // Show marketplace listings if available
    if (result.marketplaceListings && result.marketplaceListings.length > 0) {
      lines.push("");
      lines.push("📍 Available on:");
      for (const listing of result.marketplaceListings) {
        const marketLabel = listing.marketplace === "getgems" ? "GetGems"
          : listing.marketplace === "marketapp" ? "MarketApp"
          : listing.marketplace === "fragment" ? "Fragment"
          : listing.marketplace;
        const typeLabel = listing.saleType === "fixed_price" ? "Buy Now" : "Auction";
        lines.push(`  • ${marketLabel}: ${listing.price} TON (${typeLabel}) → ${listing.url}`);
      }
    } else if (result.status === "sold" || result.status === "unavailable") {
      lines.push("📍 Not listed on any marketplace (Fragment, GetGems, MarketApp)");
    }

    lines.push(`Fragment: ${result.url}`);

    return {
      success: true,
      data: {
        ...result,
        message: lines.join("\n"),
      },
    };
  } catch (error) {
    log.error({ err: error }, "Fragment check error");
    return {
      success: false,
      error: `Check failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};
