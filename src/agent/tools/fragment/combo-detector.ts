/**
 * 🏆 Username Combo Detector — Find username sets that are worth more together.
 *
 * "@wallet" + "@wallets" + "@mywallet" individually = 500 TON
 * As a set = 1200 TON. Teleclaw finds these combos.
 */

import { Type } from "@sinclair/typebox";
import type { Tool, ToolExecutor, ToolResult, ToolContext } from "../types.js";
import {
  checkUsername,
  estimateValue,
  fetchUsernames,
  type FragmentUsername,
} from "./fragment-service.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("FragmentCombo");

// ─── Combo Patterns ──────────────────────────────────────────────────

interface ComboMatch {
  base: string;
  variants: string[];
  available: Array<{ username: string; price?: string; priceRaw?: number; status: string }>;
  owned: string[];
  totalCost: number;
  estimatedSetValue: number;
  comboMultiplier: number;
  opportunity: string;
}

/**
 * Generate variant usernames from a base word.
 */
function generateVariants(base: string): string[] {
  const clean = base.replace(/^@/, "").toLowerCase();
  const variants = new Set<string>();

  // Plural
  variants.add(`${clean}s`);
  if (clean.endsWith("s")) variants.add(clean.slice(0, -1));

  // Common prefixes
  for (const prefix of ["my", "the", "get", "go", "i", "we", "x"]) {
    variants.add(`${prefix}${clean}`);
  }

  // Common suffixes
  for (const suffix of [
    "app",
    "bot",
    "pro",
    "vip",
    "io",
    "hq",
    "xyz",
    "hub",
    "dev",
    "ai",
    "ton",
    "pay",
    "fi",
  ]) {
    variants.add(`${clean}${suffix}`);
  }

  // Number variants
  variants.add(`${clean}1`);
  variants.add(`${clean}0`);
  variants.add(`${clean}x`);

  // Underscore
  if (clean.length > 4) {
    // Try splitting and joining with underscore — only for longer names
    variants.add(`${clean}_`);
  }

  // Remove the original
  variants.delete(clean);

  return Array.from(variants);
}

// ─── Combo Scan for Owned Username ───────────────────────────────────

interface ComboScanParams {
  username: string;
}

export const comboScanTool: Tool = {
  name: "fragment_combo_scan",
  description:
    "🏆 Scan for username combos: given a username you own (or are interested in), " +
    "find related variants available on Fragment. Username sets (e.g. @wallet + @wallets + @mywallet) " +
    "are worth significantly more together. Shows which variants are available, their prices, " +
    "and the estimated combo multiplier.",
  category: "data-bearing",
  parameters: Type.Object({
    username: Type.String({
      description: "Base username to find combos for (e.g. 'wallet')",
    }),
  }),
};

export const comboScanExecutor: ToolExecutor<ComboScanParams> = async (
  params,
  _context
): Promise<ToolResult> => {
  try {
    const clean = params.username.replace(/^@/, "").toLowerCase();
    const variants = generateVariants(clean);

    // Check base + all variants on Fragment (with rate limiting built into service)
    const checks: Array<{
      username: string;
      status: FragmentUsername | null;
      valuation: Awaited<ReturnType<typeof estimateValue>>;
    }> = [];

    // Check base first
    const [baseStatus, baseVal] = await Promise.all([
      checkUsername(clean),
      estimateValue(clean),
    ]);
    checks.push({ username: `@${clean}`, status: baseStatus, valuation: baseVal });

    // Check variants (limit to avoid hammering Fragment)
    const variantsToCheck = variants.slice(0, 15);
    for (const v of variantsToCheck) {
      const status = await checkUsername(v);
      if (status) {
        const val = await estimateValue(v);
        checks.push({ username: `@${v}`, status, valuation: val });
      }
    }

    // Categorize
    const available: ComboMatch["available"] = [];
    const owned: string[] = [];
    let totalAvailableCost = 0;
    let totalIndividualValue = 0;

    for (const check of checks) {
      totalIndividualValue += check.valuation.estimated.mid;

      if (
        check.status?.status === "sale" ||
        check.status?.status === "auction"
      ) {
        available.push({
          username: check.username,
          price: check.status.price,
          priceRaw: check.status.priceRaw,
          status: check.status.status,
        });
        if (check.status.priceRaw) {
          totalAvailableCost += check.status.priceRaw;
        }
      } else if (check.status?.status === "sold") {
        // Already owned by someone
      } else if (check.status?.status === "available") {
        available.push({
          username: check.username,
          status: "available",
        });
      }
    }

    // Combo multiplier: sets are worth 1.5-3x individual sum
    const comboSize = available.length + 1; // +1 for the base
    const comboMultiplier =
      comboSize >= 5 ? 3.0 : comboSize >= 3 ? 2.0 : comboSize >= 2 ? 1.5 : 1.0;
    const estimatedSetValue = Math.round(
      totalIndividualValue * comboMultiplier
    );

    const opportunity =
      available.length > 0
        ? `Buy ${available.length} variant${available.length !== 1 ? "s" : ""} for ~${Math.round(totalAvailableCost)} TON → Set worth ~${estimatedSetValue} TON (${comboMultiplier}x multiplier)`
        : "No available variants found — all taken or unavailable";

    // Format output
    const baseText = `Base: @${clean}\n  Status: ${baseStatus?.status?.toUpperCase() ?? "UNKNOWN"}\n  Est. value: ${baseVal.estimated.mid} TON`;

    const availableText =
      available.length > 0
        ? available
            .map(
              (a, i) =>
                `  ${i + 1}. ${a.username} — ${a.price ?? "free to register"} (${a.status})`
            )
            .join("\n")
        : "  None available";

    return {
      success: true,
      data: {
        base: `@${clean}`,
        variantsChecked: variantsToCheck.length,
        available,
        comboMultiplier,
        totalAvailableCost: Math.round(totalAvailableCost),
        estimatedSetValue,
        opportunity,
        message:
          `🏆 Combo Scan: @${clean}\n\n` +
          `${baseText}\n\n` +
          `Available variants (${available.length}/${variantsToCheck.length} checked):\n${availableText}\n\n` +
          `💡 ${opportunity}`,
      },
    };
  } catch (error) {
    log.error({ err: error }, "Combo scan error");
    return {
      success: false,
      error: `Combo scan failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};

// ─── Combo Suggest (from market) ─────────────────────────────────────

interface ComboSuggestParams {
  budget?: number;
  limit?: number;
}

export const comboSuggestTool: Tool = {
  name: "fragment_combo_suggest",
  description:
    "Find combo opportunities in the current Fragment market. " +
    "Scans active listings for usernames that have cheap variants available, " +
    "creating flip-worthy sets.",
  category: "data-bearing",
  parameters: Type.Object({
    budget: Type.Optional(
      Type.Number({
        description: "Max TON budget for the full combo",
        minimum: 1,
      })
    ),
    limit: Type.Optional(
      Type.Number({
        description: "Max combos to return (default: 5)",
        minimum: 1,
        maximum: 10,
      })
    ),
  }),
};

export const comboSuggestExecutor: ToolExecutor<ComboSuggestParams> = async (
  params,
  _context
): Promise<ToolResult> => {
  try {
    const { budget, limit = 5 } = params;

    // Get current cheap listings as combo candidates
    const listings = await fetchUsernames("sale", "price_asc", 30);

    const combos: Array<{
      base: string;
      basePrice: number;
      availableVariants: number;
      totalCost: number;
      estimatedSetValue: number;
      upside: number;
    }> = [];

    // Check top candidates for combo potential (limit to avoid too many requests)
    const candidates = listings.slice(0, 8);

    for (const listing of candidates) {
      if (!listing.priceRaw) continue;

      const clean = listing.username.replace(/^@/, "");
      const variants = generateVariants(clean).slice(0, 5); // Check fewer per candidate

      let variantCount = 0;
      let variantCost = 0;

      for (const v of variants) {
        const status = await checkUsername(v);
        if (
          status &&
          (status.status === "sale" || status.status === "auction") &&
          status.priceRaw
        ) {
          variantCount++;
          variantCost += status.priceRaw;
        } else if (status?.status === "available") {
          variantCount++;
          // Free to register (just auction cost)
        }
      }

      if (variantCount >= 1) {
        const totalCost = listing.priceRaw + variantCost;
        if (budget && totalCost > budget) continue;

        const multiplier = variantCount >= 3 ? 2.5 : variantCount >= 2 ? 2.0 : 1.5;
        const baseVal = await estimateValue(clean);
        const setVal = Math.round(
          (baseVal.estimated.mid + variantCost) * multiplier
        );

        combos.push({
          base: listing.username,
          basePrice: listing.priceRaw,
          availableVariants: variantCount,
          totalCost: Math.round(totalCost),
          estimatedSetValue: setVal,
          upside: Math.round(((setVal - totalCost) / totalCost) * 100),
        });
      }
    }

    // Sort by upside
    combos.sort((a, b) => b.upside - a.upside);
    const topCombos = combos.slice(0, limit);

    if (topCombos.length === 0) {
      return {
        success: true,
        data: {
          combos: [],
          message: budget
            ? `No combo opportunities found within ${budget} TON budget.`
            : "No strong combo opportunities found in current listings.",
        },
      };
    }

    const comboText = topCombos
      .map(
        (c, i) =>
          `${i + 1}. ${c.base} + ${c.availableVariants} variant${c.availableVariants !== 1 ? "s" : ""}\n` +
          `   Cost: ~${c.totalCost} TON → Set value: ~${c.estimatedSetValue} TON (+${c.upside}% upside)`
      )
      .join("\n\n");

    return {
      success: true,
      data: {
        found: topCombos.length,
        combos: topCombos,
        message:
          `🏆 Combo Opportunities${budget ? ` (≤${budget} TON)` : ""}:\n\n${comboText}\n\n` +
          `Use fragment_combo_scan on any base username for full details.`,
      },
    };
  } catch (error) {
    log.error({ err: error }, "Combo suggest error");
    return {
      success: false,
      error: `Combo suggest failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};
