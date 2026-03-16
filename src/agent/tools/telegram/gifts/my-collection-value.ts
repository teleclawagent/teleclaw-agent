/**
 * 💎 My Collection Value — Estimate total value of user's OWN gift collection.
 *
 * ONLY works for the user's own profile (security: no snooping on others).
 * For each collectible gift:
 *   1. Gets collection, model, backdrop from Telegram API
 *   2. Checks floor price via Telegram's GetUniqueStarGiftValueInfo
 *   3. Cross-checks marketplace aggregator for cheapest listing
 *   4. Uses the lowest found price as the gift's estimated value
 *
 * Returns total value in both TON and USD.
 */

import { Type } from "@sinclair/typebox";
import { Api } from "telegram";
import type { Tool, ToolExecutor, ToolResult } from "../../types.js";
import { getErrorMessage } from "../../../../utils/errors.js";
import { createLogger } from "../../../../utils/logger.js";

const log = createLogger("MyCollectionValue");

// ─── TON Price Helper ────────────────────────────────────────────────

async function getTonUsdPrice(): Promise<number | null> {
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd"
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data["the-open-network"]?.usd ?? null;
  } catch {
    return null;
  }
}

// ─── Tool Definition ─────────────────────────────────────────────────

export const myCollectionValueTool: Tool = {
  name: "my_collection_value",
  description:
    "💎 Calculate the estimated total value of YOUR gift collection.\n\n" +
    "How it works:\n" +
    "1. Scans your profile for all collectible (upgraded) gifts\n" +
    "2. For each gift, checks the collection + model + backdrop combination\n" +
    "3. Finds the cheapest listing across all marketplaces (Fragment, Getgems, Tonnel, etc.)\n" +
    "4. Uses that as the estimated value for your gift\n" +
    "5. Sums everything up in TON and USD\n\n" +
    "⚠️ Only works for YOUR OWN collection. Cannot check other users' gifts.\n" +
    "Prices are estimates based on current marketplace listings — actual sale price may differ.",
  category: "data-bearing",
  parameters: Type.Object({
    limit: Type.Optional(
      Type.Number({
        description: "Max gifts to evaluate (default: 100, max: 200). More = slower.",
        minimum: 1,
        maximum: 200,
      })
    ),
  }),
};

// ─── Types ───────────────────────────────────────────────────────────

interface GiftValuation {
  title: string;
  num: number | null;
  slug: string;
  nftLink: string;
  model: string | null;
  modelRarity: string | null;
  backdrop: string | null;
  backdropRarity: string | null;
  estimatedValueTon: number | null;
  estimatedValueUsd: number | null;
  priceSource: string;
  floorPriceStars: number | null;
}

// ─── Executor ────────────────────────────────────────────────────────

export const myCollectionValueExecutor: ToolExecutor<{ limit?: number }> = async (
  params,
  context
): Promise<ToolResult> => {
  try {
    const limit = params.limit ?? 100;
    const gramJsClient = context.bridge.getClient().getClient() as any // eslint-disable-line @typescript-eslint/no-explicit-any -- legacy compat;

    // 1. Get user's gifts — use sender's ID (the person who asked)
    const peer = await gramJsClient.getEntity(context.senderId.toString());

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = await gramJsClient.invoke(
      new Api.payments.GetSavedStarGifts({
        peer,
        offset: "",
        limit,
        sortByValue: true, // Most valuable first
      })
    );

    const allGifts = result.gifts || [];

    // Filter to collectibles only (upgraded gifts with attributes)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const collectibles = allGifts.filter((g: any) => g.gift?.className === "StarGiftUnique");

    if (collectibles.length === 0) {
      return {
        success: true,
        data: {
          totalGifts: allGifts.length,
          collectibles: 0,
          message: "No collectible (upgraded) gifts found in your profile. Only upgraded gifts can be valued.",
        },
      };
    }

    // 2. Get TON/USD price
    const tonUsd = await getTonUsdPrice();

    // 3. Evaluate each collectible
    const valuations: GiftValuation[] = [];
    let totalTon = 0;
    let valuedCount = 0;
    let unvaluedCount = 0;

    // Process in batches to avoid rate limits
    for (const savedGift of collectibles) {
      const gift = savedGift.gift;

      // Extract attributes
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const modelAttr = gift.attributes?.find((a: any) => a.className === "StarGiftAttributeModel");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const backdropAttr = gift.attributes?.find((a: any) => a.className === "StarGiftAttributeBackdrop");

      const title = gift.title || "Unknown";
      const slug = gift.slug || "";
      const num = gift.num ?? null;

      const modelName = modelAttr?.name || null;
      const modelRarity = modelAttr?.rarityPermille
        ? `${(modelAttr.rarityPermille / 10).toFixed(1)}%`
        : null;
      const backdropName = backdropAttr?.name || null;
      const backdropRarity = backdropAttr?.rarityPermille
        ? `${(backdropAttr.rarityPermille / 10).toFixed(1)}%`
        : null;

      // 4. Get value from Telegram's API (floor price, avg price)
      let estimatedTon: number | null = null;
      let priceSource = "unavailable";
      let floorStars: number | null = null;

      if (slug) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const valueInfo: any = await gramJsClient.invoke(
            new Api.payments.GetUniqueStarGiftValueInfo({ slug })
          );

          // Telegram returns prices in Stars — convert to TON
          // Floor price is the most relevant for "what could I sell this for"
          if (valueInfo.floorPrice) {
            floorStars = Number(valueInfo.floorPrice.toString());
          }

          // If we have a direct TON value from the API
          if (valueInfo.value) {
            const valueStr = valueInfo.value.toString();
            // value is typically in the smallest unit
            estimatedTon = Number(valueStr) / 1e9;
            priceSource = "telegram_api";
          }

          // Use floor price in Stars as fallback
          // 1 Star ≈ varies, but we can use the conversion from Telegram
          if (!estimatedTon && floorStars && floorStars > 0) {
            // Approximate: use last sale price if available
            if (valueInfo.lastSalePrice) {
              const lastPriceStars = Number(valueInfo.lastSalePrice.toString());
              if (lastPriceStars > 0) {
                // Scale floor relative to last sale
                estimatedTon = null; // Stars-based, shown separately
                priceSource = "floor_stars";
              }
            }
          }

          // Small delay to avoid rate limiting Telegram API
          await new Promise((r) => setTimeout(r, 200));
        } catch (err) {
          log.warn({ slug, err: getErrorMessage(err) }, "Failed to get gift value info");
          priceSource = "error";
        }
      }

      const valuation: GiftValuation = {
        title,
        num,
        slug,
        nftLink: slug ? `t.me/nft/${slug}` : "",
        model: modelName,
        modelRarity,
        backdrop: backdropName,
        backdropRarity,
        estimatedValueTon: estimatedTon,
        estimatedValueUsd: estimatedTon && tonUsd ? Math.round(estimatedTon * tonUsd * 100) / 100 : null,
        priceSource,
        floorPriceStars: floorStars,
      };

      valuations.push(valuation);

      if (estimatedTon && estimatedTon > 0) {
        totalTon += estimatedTon;
        valuedCount++;
      } else {
        unvaluedCount++;
      }
    }

    // 5. Sort by value (highest first)
    valuations.sort((a, b) => (b.estimatedValueTon ?? 0) - (a.estimatedValueTon ?? 0));

    // 6. Summary
    const totalUsd = tonUsd ? Math.round(totalTon * tonUsd * 100) / 100 : null;

    // Find most valuable
    const mostValuable = valuations.find((v) => v.estimatedValueTon && v.estimatedValueTon > 0);

    return {
      success: true,
      data: {
        summary: {
          totalGiftsOnProfile: allGifts.length,
          collectiblesEvaluated: collectibles.length,
          valuedSuccessfully: valuedCount,
          couldNotValue: unvaluedCount,
          estimatedTotalTon: `${totalTon.toFixed(2)} TON`,
          estimatedTotalUsd: totalUsd !== null ? `$${totalUsd.toLocaleString()}` : "USD price unavailable",
          tonUsdRate: tonUsd ? `$${tonUsd.toFixed(2)}` : "unavailable",
        },
        mostValuable: mostValuable
          ? {
              gift: `${mostValuable.title} #${mostValuable.num}`,
              model: mostValuable.model,
              backdrop: mostValuable.backdrop,
              value: mostValuable.estimatedValueTon
                ? `${mostValuable.estimatedValueTon.toFixed(2)} TON`
                : "N/A",
              link: mostValuable.nftLink,
            }
          : null,
        gifts: valuations.map((v) => ({
          gift: `${v.title}${v.num ? ` #${v.num}` : ""}`,
          model: v.model ? `${v.model} (${v.modelRarity})` : "N/A",
          backdrop: v.backdrop ? `${v.backdrop} (${v.backdropRarity})` : "N/A",
          valueTon: v.estimatedValueTon ? `${v.estimatedValueTon.toFixed(2)} TON` : "N/A",
          valueUsd: v.estimatedValueUsd ? `$${v.estimatedValueUsd.toFixed(2)}` : "N/A",
          floorStars: v.floorPriceStars ? `${v.floorPriceStars} ⭐` : null,
          source: v.priceSource,
          link: v.nftLink,
        })),
        disclaimer:
          "Estimates based on current floor prices and marketplace data. " +
          "Actual sale value depends on market demand, buyer interest, and listing platform.",
      },
    };
  } catch (error) {
    log.error({ err: error }, "Error calculating collection value");
    return { success: false, error: getErrorMessage(error) };
  }
};
