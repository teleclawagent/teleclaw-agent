import type Database from "better-sqlite3";
import type { TelegramTransport } from "../../../telegram/transport.js";
import type { Config } from "../../../config/schema.js";
import { evaluateRules, markRuleTriggered, createPendingExecution } from "./rule-engine.js";
import { getTonPrice as _getTonPrice } from "../../../ton/wallet-service.js";
import { expirePendingExecutions, getExecutionExpiry, auditLog } from "./security.js";
import { createLogger } from "../../../utils/logger.js";
import { getErrorMessage } from "../../../utils/errors.js";

const log = createLogger("AgenticWallet:PriceMonitor");

const CHECK_INTERVAL_MS = 60_000; // 60 seconds
const PRICE_DIVERGENCE_THRESHOLD = 0.05; // 5% max divergence between sources
let intervalId: ReturnType<typeof setInterval> | null = null;
let isRunning = false;

/**
 * Fetch price from multiple sources and validate consistency.
 * Rejects if sources diverge by more than 5%.
 */
async function fetchVerifiedPrice(asset: string): Promise<{
  price: number;
  sources: string[];
  verified: boolean;
} | null> {
  if (asset.toLowerCase() === "ton") {
    // Use TonAPI + CoinGecko dual-source for TON
    const prices: Array<{ price: number; source: string }> = [];

    // Source 1: TonAPI
    try {
      const { tonapiFetch } = await import("../../../constants/api-endpoints.js");
      const response = await tonapiFetch(`/rates?tokens=ton&currencies=usd`);
      if (response.ok) {
        const data = await response.json();
        const price = data?.rates?.TON?.prices?.USD;
        if (typeof price === "number" && price > 0) {
          prices.push({ price, source: "TonAPI" });
        }
      }
    } catch {
      // continue to next source
    }

    // Source 2: CoinGecko
    try {
      const { fetchWithTimeout } = await import("../../../utils/fetch.js");
      const { COINGECKO_API_URL } = await import("../../../constants/api-endpoints.js");
      const response = await fetchWithTimeout(
        `${COINGECKO_API_URL}/simple/price?ids=the-open-network&vs_currencies=usd`
      );
      if (response.ok) {
        const data = await response.json();
        const price = data["the-open-network"]?.usd;
        if (typeof price === "number" && price > 0) {
          prices.push({ price, source: "CoinGecko" });
        }
      }
    } catch {
      // continue
    }

    if (prices.length === 0) return null;

    // If we have multiple sources, check divergence
    if (prices.length >= 2) {
      const avg = prices.reduce((s, p) => s + p.price, 0) / prices.length;
      const maxDivergence = Math.max(...prices.map((p) => Math.abs(p.price - avg) / avg));

      if (maxDivergence > PRICE_DIVERGENCE_THRESHOLD) {
        log.warn(
          {
            prices: prices.map((p) => `${p.source}: $${p.price.toFixed(4)}`),
            divergence: `${(maxDivergence * 100).toFixed(1)}%`,
          },
          "Price sources diverge too much — skipping rule evaluation for safety"
        );
        return null; // Don't trigger any rules with suspicious prices
      }

      return {
        price: avg,
        sources: prices.map((p) => p.source),
        verified: true,
      };
    }

    // Single source — mark as unverified (still usable but logged)
    return {
      price: prices[0].price,
      sources: [prices[0].source],
      verified: false,
    };
  }

  // Jetton prices — use TonAPI
  try {
    const { tonapiFetch } = await import("../../../constants/api-endpoints.js");
    const response = await tonapiFetch(`/rates?tokens=${asset}&currencies=usd`);
    if (response.ok) {
      const data = await response.json();
      const rateKey = Object.keys(data?.rates || {})[0];
      if (rateKey) {
        const price = data.rates[rateKey]?.prices?.USD;
        if (typeof price === "number" && price > 0) {
          return { price, sources: ["TonAPI"], verified: false };
        }
      }
    }
  } catch (error) {
    log.warn({ asset, err: getErrorMessage(error) }, "Failed to fetch jetton price");
  }

  return null;
}

/**
 * Fetch current prices for all monitored assets with multi-source verification.
 */
async function fetchCurrentPrices(
  db: Database.Database
): Promise<Map<string, { price: number; sources: string[]; verified: boolean }>> {
  const priceMap = new Map<string, { price: number; sources: string[]; verified: boolean }>();

  // Always fetch TON price
  const tonPrice = await fetchVerifiedPrice("ton");
  if (tonPrice) {
    priceMap.set("ton", tonPrice);
  }

  // Get unique assets from active rules
  const assets = db
    .prepare(`SELECT DISTINCT asset FROM trading_rules WHERE active = 1 AND LOWER(asset) != 'ton'`)
    .all() as Array<{ asset: string }>;

  for (const { asset } of assets) {
    const price = await fetchVerifiedPrice(asset);
    if (price) {
      priceMap.set(asset.toLowerCase(), price);
    }
  }

  return priceMap;
}

/**
 * Process triggered rules — create pending executions and notify users.
 */
async function processTriggeredRules(
  db: Database.Database,
  bridge: TelegramTransport,
  triggered: Array<{
    rule: ReturnType<typeof evaluateRules>[number]["rule"];
    currentPrice: number;
  }>,
  priceData: Map<string, { price: number; sources: string[]; verified: boolean }>
): Promise<void> {
  for (const { rule, currentPrice } of triggered) {
    try {
      let action: string;
      switch (rule.rule_type) {
        case "price_below":
          action = `Buy ${rule.amount} TON worth of ${rule.asset} (price hit $${currentPrice.toFixed(4)}, target was ≤$${rule.condition_value})`;
          break;
        case "price_above":
          action = `Sell ${rule.asset} (price hit $${currentPrice.toFixed(4)}, target was ≥$${rule.condition_value})`;
          break;
        case "dca":
          action = `DCA: Buy ${rule.amount} TON worth of ${rule.asset}`;
          break;
        case "stop_loss":
          action = `Stop-Loss: Sell ${rule.asset} (price dropped to $${currentPrice.toFixed(4)})`;
          break;
        case "take_profit":
          action = `Take-Profit: Sell ${rule.asset} (price reached $${currentPrice.toFixed(4)})`;
          break;
        default:
          action = `Trade ${rule.amount} ${rule.asset}`;
      }

      // Get price source info
      const assetPriceData = priceData.get(rule.asset.toLowerCase());
      const priceSources = assetPriceData ? assetPriceData.sources.join(", ") : "unknown";
      const priceVerified = assetPriceData?.verified
        ? "✅ Multi-source verified"
        : "⚠️ Single source";

      const executionId = createPendingExecution(db, {
        ruleId: rule.id,
        walletId: rule.wallet_id,
        userId: rule.user_id,
        action,
        asset: rule.asset,
        amount: rule.amount,
        priceAtExecution: currentPrice,
        priceSources: priceSources,
        expiresAt: getExecutionExpiry(),
      });

      markRuleTriggered(db, rule.id);

      // For non-DCA price rules, deactivate after triggering (one-shot)
      if (rule.rule_type !== "dca") {
        db.prepare("UPDATE trading_rules SET active = 0 WHERE id = ?").run(rule.id);
      }

      auditLog(
        db,
        rule.user_id,
        "rule_triggered",
        `Rule ${rule.id.slice(0, 8)} triggered at $${currentPrice.toFixed(4)} (${priceSources})`
      );

      // Notify user — always requires confirmation
      const message =
        `🔔 **Trading Rule Triggered**\n\n` +
        `${action}\n\n` +
        `Amount: ${rule.amount} TON\n` +
        `Price: $${currentPrice.toFixed(6)} (${priceVerified})\n` +
        `Sources: ${priceSources}\n` +
        `⏰ Expires in 5 minutes\n\n` +
        `To execute, reply:\n` +
        `\`confirm ${executionId.slice(0, 8)} YOUR_PIN\`\n\n` +
        `To cancel:\n` +
        `\`cancel ${executionId.slice(0, 8)}\``;

      try {
        await bridge.sendMessage({ chatId: String(rule.user_id), text: message });
      } catch (sendErr) {
        log.warn(
          { err: getErrorMessage(sendErr), userId: rule.user_id },
          "Failed to send trade notification"
        );
      }

      log.info(
        { ruleId: rule.id, executionId, userId: rule.user_id, action, priceVerified },
        "Rule triggered, pending PIN confirmation"
      );
    } catch (error) {
      log.error(
        { err: getErrorMessage(error), ruleId: rule.id },
        "Error processing triggered rule"
      );
    }
  }
}

/**
 * Main monitoring loop tick.
 */
async function monitorTick(db: Database.Database, bridge: TelegramTransport): Promise<void> {
  if (isRunning) return;
  isRunning = true;

  try {
    // Expire old pending executions
    expirePendingExecutions(db);

    const activeCount = db
      .prepare("SELECT COUNT(*) as count FROM trading_rules WHERE active = 1")
      .get() as { count: number };

    if (activeCount.count === 0) return;

    // Fetch verified prices
    const priceData = await fetchCurrentPrices(db);
    if (priceData.size === 0) {
      log.warn("No prices available, skipping evaluation");
      return;
    }

    // Convert to simple price map for rule evaluation
    const simplePrices = new Map<string, number>();
    for (const [key, data] of priceData) {
      simplePrices.set(key, data.price);
    }

    const triggered = evaluateRules(db, simplePrices);
    if (triggered.length === 0) return;

    log.info({ count: triggered.length }, "Rules triggered");
    await processTriggeredRules(db, bridge, triggered, priceData);
  } catch (error) {
    log.error({ err: getErrorMessage(error) }, "Price monitor tick failed");
  } finally {
    isRunning = false;
  }
}

/**
 * Start the price monitoring background service.
 */
export function startPriceMonitor(context: {
  db: Database.Database;
  bridge: TelegramTransport;
  config: Config;
}): void {
  if (intervalId) {
    log.warn("Price monitor already running");
    return;
  }

  // Verify master key exists at startup
  if (!process.env.TELECLAW_MASTER_KEY) {
    log.warn("TELECLAW_MASTER_KEY not set — price monitor will not start until it is configured");
    return;
  }

  log.info("Starting price monitor (60s interval)");
  intervalId = setInterval(() => {
    monitorTick(context.db, context.bridge).catch((err) => {
      log.error({ err: getErrorMessage(err) }, "Unhandled error in price monitor");
    });
  }, CHECK_INTERVAL_MS);

  // First tick after 5 seconds
  setTimeout(() => {
    monitorTick(context.db, context.bridge).catch((err) => {
      log.error({ err: getErrorMessage(err) }, "Unhandled error in initial price monitor tick");
    });
  }, 5000);
}

/**
 * Stop the price monitoring background service.
 */
export function stopPriceMonitor(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    log.info("Price monitor stopped");
  }
}
