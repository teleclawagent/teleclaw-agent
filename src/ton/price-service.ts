/**
 * TON/USD Price Service — live price with cache for cross-currency OTC matching.
 * Used by all 3 matchmakers (username, gift, number) to normalize prices.
 */

import { createLogger } from "../utils/logger.js";
import { fetchWithTimeout } from "../utils/fetch.js";

const log = createLogger("PriceService");

let cachedPrice: number | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Get current TON price in USD.
 * Cached for 5 minutes to avoid excessive API calls.
 */
export async function getTonPriceUsd(): Promise<number | null> {
  // Return cached if fresh
  if (cachedPrice !== null && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedPrice;
  }

  // Try DeDust first (TON ecosystem native)
  try {
    const res = await fetchWithTimeout("https://api.dedust.io/v2/prices", {
      headers: { Accept: "application/json" },
    });
    if (res.ok) {
      const data = (await res.json()) as Array<{ symbol: string; price: string }>;
      const ton = data.find((d) => d.symbol === "TON");
      if (ton) {
        cachedPrice = parseFloat(ton.price);
        cacheTimestamp = Date.now();
        return cachedPrice;
      }
    }
  } catch {
    /* fallback */
  }

  // Fallback: CoinGecko
  try {
    const res = await fetchWithTimeout(
      "https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd"
    );
    if (res.ok) {
      const data = (await res.json()) as { "the-open-network": { usd: number } };
      cachedPrice = data["the-open-network"].usd;
      cacheTimestamp = Date.now();
      return cachedPrice;
    }
  } catch {
    /* fallback */
  }

  log.warn("Failed to fetch TON price from all sources");
  return cachedPrice; // Return stale cache if available
}

/**
 * Convert an amount to USD for comparison.
 * Supports TON, USDT, USD, Stars.
 */
export async function toUsd(amount: number, currency: string): Promise<number | null> {
  const c = currency.toUpperCase();

  if (c === "USD" || c === "USDT") return amount;

  if (c === "TON") {
    const price = await getTonPriceUsd();
    if (!price) return null;
    return amount * price;
  }

  if (c === "STARS") {
    // Telegram Stars ≈ $0.013 each (approximate)
    return amount * 0.013;
  }

  return null; // Unknown currency
}

/**
 * Check if buyer's max price (in their currency) covers the listing price (in listing currency).
 * Returns true if buyer can afford it, false if not, null if price conversion failed.
 */
export async function priceMatches(
  listingPrice: number | null,
  listingCurrency: string,
  buyerMaxPrice: number | null,
  buyerCurrency: string
): Promise<boolean | null> {
  // No price constraints = always matches
  if (!listingPrice || !buyerMaxPrice) return true;

  // Same currency = direct compare
  if (listingCurrency.toUpperCase() === buyerCurrency.toUpperCase()) {
    return listingPrice <= buyerMaxPrice;
  }

  // Cross-currency: convert both to USD
  const listingUsd = await toUsd(listingPrice, listingCurrency);
  const buyerUsd = await toUsd(buyerMaxPrice, buyerCurrency);

  if (listingUsd === null || buyerUsd === null) return null; // Can't compare

  return listingUsd <= buyerUsd;
}

/**
 * Format a price with USD equivalent.
 * e.g. "250 TON (~$875)"
 */
export async function formatPriceWithUsd(amount: number, currency: string): Promise<string> {
  const c = currency.toUpperCase();
  if (c === "USD" || c === "USDT") return `$${amount.toLocaleString()}`;

  const usdValue = await toUsd(amount, currency);
  if (usdValue === null) return `${amount.toLocaleString()} ${c}`;

  return `${amount.toLocaleString()} ${c} (~$${Math.round(usdValue).toLocaleString()})`;
}
