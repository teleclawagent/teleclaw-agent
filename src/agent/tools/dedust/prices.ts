import { Type } from "@sinclair/typebox";
import type { Tool, ToolExecutor, ToolResult } from "../types.js";
import { DEDUST_API_URL } from "./constants.js";
import { fetchWithTimeout } from "../../../utils/fetch.js";
import { getErrorMessage } from "../../../utils/errors.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("Tools");
interface DedustPricesParams {
  symbols?: string[];
}

/**
 * Price entry from the DeDust API
 */
interface PriceEntry {
  symbol: string;
  price: number;
  updatedAt: string;
}
export const dedustPricesTool: Tool = {
  name: "dedust_prices",
  description: "Get real-time token prices from DeDust. Optionally filter by symbol(s).",
  category: "data-bearing",
  parameters: Type.Object({
    symbols: Type.Optional(
      Type.Array(
        Type.String({
          description: "Token symbol to filter (e.g. 'TON', 'BTC', 'USDT')",
        }),
        {
          description: "Filter by specific symbols. Omit to get all available prices.",
        }
      )
    ),
  }),
};
export const dedustPricesExecutor: ToolExecutor<DedustPricesParams> = async (
  params,
  _context
): Promise<ToolResult> => {
  try {
    const { symbols } = params;

    let response = await fetchWithTimeout(`${DEDUST_API_URL}/prices`, { timeoutMs: 8000 });

    // Retry once on failure
    if (!response.ok) {
      await new Promise((r) => setTimeout(r, 2000));
      response = await fetchWithTimeout(`${DEDUST_API_URL}/prices`, { timeoutMs: 8000 });
    }

    if (!response.ok) {
      // Fallback: try GeckoTerminal for TON ecosystem tokens
      log.warn("DeDust API unavailable, trying GeckoTerminal fallback");
      try {
        const geckoRes = await fetchWithTimeout(
          "https://api.geckoterminal.com/api/v2/networks/ton/dexes/dedust/pools?page=1",
          { timeoutMs: 8000 }
        );
        if (geckoRes.ok) {
          const geckoData = await geckoRes.json();
          const pools = (geckoData?.data || []) as Record<string, unknown>[];
          const geckoEntries: PriceEntry[] = [];
          for (const pool of pools) {
            const attrs = pool.attributes as Record<string, unknown>;
            if (attrs?.base_token_price_usd && attrs?.name) {
              const name = (attrs.name as string).split(" / ")[0];
              geckoEntries.push({
                symbol: name,
                price: parseFloat(attrs.base_token_price_usd as string),
                updatedAt: new Date().toISOString(),
              });
            }
          }
          if (geckoEntries.length > 0) {
            // Deduplicate by symbol (keep first/highest)
            const seen = new Set<string>();
            const deduped = geckoEntries.filter((e) => {
              if (seen.has(e.symbol)) return false;
              seen.add(e.symbol);
              return true;
            });

            if (symbols && symbols.length > 0) {
              const upper = symbols.map((s) => s.toUpperCase());
              const filtered = deduped.filter((p) => upper.includes(p.symbol.toUpperCase()));
              return {
                success: true,
                data: {
                  prices: filtered,
                  count: filtered.length,
                  message: `DeDust Prices via GeckoTerminal (${filtered.length} tokens)`,
                  source: "geckoterminal",
                },
              };
            }
            return {
              success: true,
              data: {
                prices: deduped,
                count: deduped.length,
                message: `DeDust Prices via GeckoTerminal (${deduped.length} tokens)`,
                source: "geckoterminal",
              },
            };
          }
        }
      } catch (geckoErr) {
        log.error({ err: geckoErr }, "GeckoTerminal fallback also failed");
      }
      throw new Error(`DeDust API error: ${response.status} ${response.statusText}`);
    }

    let prices: PriceEntry[] = await response.json();

    // Check data freshness — DeDust sometimes returns stale data
    const now = Date.now();
    const staleThreshold = 24 * 60 * 60 * 1000; // 24 hours
    const hasStaleData = prices.some((p) => {
      if (!p.updatedAt) return false;
      const updated = new Date(p.updatedAt).getTime();
      return now - updated > staleThreshold;
    });

    if (hasStaleData) {
      log.warn("DeDust returned stale data (>24h old), enriching with CoinGecko for TON");
      // At minimum, get fresh TON price from CoinGecko
      try {
        const cgRes = await fetchWithTimeout(
          "https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd",
          { timeoutMs: 5000 }
        );
        if (cgRes.ok) {
          const cgData = await cgRes.json();
          const freshTonPrice = cgData?.["the-open-network"]?.usd;
          if (freshTonPrice) {
            const tonEntry = prices.find((p) => p.symbol.toUpperCase() === "TON");
            if (tonEntry) {
              tonEntry.price = freshTonPrice;
              tonEntry.updatedAt = new Date().toISOString();
            }
          }
        }
      } catch {
        // CoinGecko failed, keep DeDust data as-is
      }
    }

    // Filter by symbols if provided
    if (symbols && symbols.length > 0) {
      const upper = symbols.map((s) => s.toUpperCase());
      prices = prices.filter((p) => upper.includes(p.symbol.toUpperCase()));
    }

    // Sort by symbol
    prices.sort((a, b) => a.symbol.localeCompare(b.symbol));

    let message = `DeDust Prices (${prices.length} tokens):\n\n`;
    for (const p of prices) {
      const priceStr =
        p.price >= 1
          ? `$${p.price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
          : `$${p.price.toFixed(6)}`;
      message += `${p.symbol}: ${priceStr}\n`;
    }

    if (hasStaleData) {
      message += `\n⚠️ Some prices may be outdated. TON price refreshed from CoinGecko.`;
    }

    return {
      success: true,
      data: {
        prices: prices.map((p) => ({
          symbol: p.symbol,
          price: p.price,
          updatedAt: p.updatedAt,
        })),
        count: prices.length,
        message,
        staleWarning: hasStaleData
          ? "Some DeDust prices are >24h old. TON price was refreshed from CoinGecko."
          : undefined,
      },
    };
  } catch (error) {
    log.error({ err: error }, "Error in dedust_prices");
    return {
      success: false,
      error: getErrorMessage(error),
    };
  }
};
