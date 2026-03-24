/**
 * 🔔 Gift Price/Rarity Alerts
 *
 * Set alerts for specific gift criteria:
 * - New listings matching your filters
 * - Price drops on collections you watch
 * - Rare finds (specific tier thresholds)
 *
 * The agent checks these when gift_mm_list or gift_mm_browse runs,
 * and can be polled periodically.
 */

import { Type } from "@sinclair/typebox";
import type { Tool, ToolExecutor, ToolResult, ToolContext } from "../types.js";
import { searchCollections } from "./gifts-service.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("GiftAlerts");

// ─── DB Schema ───────────────────────────────────────────────────────

function ensureGiftAlertTables(ctx: ToolContext): void {
  ctx.db.exec(`
    CREATE TABLE IF NOT EXISTS gift_alerts (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      collection TEXT,
      min_tier TEXT,
      max_price REAL,
      currency TEXT NOT NULL DEFAULT 'TON',
      alert_type TEXT NOT NULL DEFAULT 'new_listing' CHECK(alert_type IN ('new_listing', 'price_drop', 'rare_find')),
      model TEXT,
      backdrop TEXT,
      symbol TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      triggered_count INTEGER NOT NULL DEFAULT 0,
      last_triggered_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_gift_alerts_user ON gift_alerts(user_id);
    CREATE INDEX IF NOT EXISTS idx_gift_alerts_active ON gift_alerts(active);
  `);
}

function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

const VALID_TIERS = ["Legendary", "Epic", "Rare", "Uncommon", "Common"];
const VALID_ALERT_TYPES = ["new_listing", "price_drop", "rare_find"];

// ─── gift_alert_set ──────────────────────────────────────────────────

interface AlertSetParams {
  collection?: string;
  min_tier?: string;
  max_price?: number;
  currency?: string;
  alert_type?: string;
  model?: string;
  backdrop?: string;
  symbol?: string;
}

export const giftAlertSetTool: Tool = {
  name: "gift_alert_set",
  description:
    "🔔 Set a gift alert — get notified when matching gifts appear.\n\n" +
    "ALERT TYPES:\n" +
    "• new_listing — any new gift listed matching your filters\n" +
    "• price_drop — when a listed gift's price drops (re-listed lower)\n" +
    "• rare_find — when a gift with rarity tier ≥ your threshold is listed\n\n" +
    "FILTER OPTIONS (all optional, combine freely):\n" +
    "• collection — specific collection only\n" +
    "• model/backdrop/symbol — specific trait filters\n" +
    "• min_tier — minimum rarity tier (Legendary, Epic, Rare, Uncommon)\n" +
    "• max_price — price ceiling in TON/USDT/Stars\n\n" +
    "Examples:\n" +
    "• 'Alert me when any Epic+ Plush Pepe drops below 200 TON'\n" +
    "• 'Notify me of any new Legendary gift across all collections'\n" +
    "• 'Watch for Onyx Black backdrop gifts under 100 TON'",
  category: "action",
  parameters: Type.Object({
    collection: Type.Optional(
      Type.String({ description: "Collection to watch (e.g. 'Plush Pepe')" })
    ),
    min_tier: Type.Optional(
      Type.String({ description: "Minimum tier: Legendary, Epic, Rare, Uncommon" })
    ),
    max_price: Type.Optional(Type.Number({ description: "Max price threshold", minimum: 0 })),
    currency: Type.Optional(
      Type.String({ description: "Currency: TON, Stars, USDT (default: TON)" })
    ),
    alert_type: Type.Optional(
      Type.Union(
        [Type.Literal("new_listing"), Type.Literal("price_drop"), Type.Literal("rare_find")],
        { description: "Alert type (default: new_listing)" }
      )
    ),
    model: Type.Optional(Type.String({ description: "Specific model to watch for" })),
    backdrop: Type.Optional(Type.String({ description: "Specific backdrop to watch for" })),
    symbol: Type.Optional(Type.String({ description: "Specific symbol to watch for" })),
  }),
};

export const giftAlertSetExecutor: ToolExecutor<AlertSetParams> = async (
  params,
  context
): Promise<ToolResult> => {
  try {
    ensureGiftAlertTables(context);

    const {
      collection,
      min_tier,
      max_price,
      currency = "TON",
      alert_type = "new_listing",
      model,
      backdrop,
      symbol,
    } = params;

    // Validate collection
    if (collection) {
      const suggestions = searchCollections(collection);
      if (
        suggestions.length === 0 ||
        !suggestions.some((s) => s.name.toLowerCase() === collection.toLowerCase())
      ) {
        return {
          success: false,
          error: `Collection "${collection}" not found.${
            suggestions.length > 0
              ? ` Did you mean: ${suggestions
                  .slice(0, 3)
                  .map((s) => s.name)
                  .join(", ")}?`
              : ""
          }`,
        };
      }
    }

    // Validate tier
    if (min_tier && !VALID_TIERS.includes(min_tier)) {
      return {
        success: false,
        error: `Invalid tier "${min_tier}". Valid: ${VALID_TIERS.join(", ")}`,
      };
    }

    // Validate alert type
    if (!VALID_ALERT_TYPES.includes(alert_type)) {
      return {
        success: false,
        error: `Invalid alert type "${alert_type}". Valid: ${VALID_ALERT_TYPES.join(", ")}`,
      };
    }

    // Check for duplicate alerts (same user, same filters)
    const existing = context.db
      .prepare(
        `SELECT id FROM gift_alerts
         WHERE user_id = ? AND active = 1
         AND COALESCE(collection, '') = COALESCE(?, '')
         AND COALESCE(min_tier, '') = COALESCE(?, '')
         AND alert_type = ?`
      )
      .get(context.senderId, collection || "", min_tier || "", alert_type) as
      | { id: string }
      | undefined;

    if (existing) {
      return {
        success: false,
        error: `You already have a similar alert (${existing.id}). Remove it first or adjust your filters.`,
      };
    }

    const id = generateId("galrt");

    context.db
      .prepare(
        `INSERT INTO gift_alerts
         (id, user_id, collection, min_tier, max_price, currency, alert_type, model, backdrop, symbol)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        context.senderId,
        collection || null,
        min_tier || null,
        max_price ?? null,
        currency,
        alert_type,
        model || null,
        backdrop || null,
        symbol || null
      );

    const filterDesc: string[] = [];
    if (collection) filterDesc.push(`Collection: ${collection}`);
    if (model) filterDesc.push(`Model: ${model}`);
    if (backdrop) filterDesc.push(`Backdrop: ${backdrop}`);
    if (symbol) filterDesc.push(`Symbol: ${symbol}`);
    if (min_tier) filterDesc.push(`Min tier: ${min_tier}`);
    if (max_price) filterDesc.push(`Max price: ${max_price} ${currency}`);
    if (filterDesc.length === 0) filterDesc.push("All gifts (no filters)");

    return {
      success: true,
      data: {
        alertId: id,
        type: alert_type,
        filters: filterDesc.join(" | "),
        message: `Alert set! You'll be notified when matching gifts are detected.`,
      },
    };
  } catch (err: unknown) {
    log.error({ err }, "Error setting gift alert");
    return { success: false, error: `Failed: ${err instanceof Error ? err.message : String(err)}` };
  }
};

// ─── gift_alert_list ─────────────────────────────────────────────────

export const giftAlertListTool: Tool = {
  name: "gift_alert_list",
  description: "🔔 List your active gift alerts.",
  category: "data-bearing",
  parameters: Type.Object({}),
};

export const giftAlertListExecutor: ToolExecutor = async (
  _params,
  context
): Promise<ToolResult> => {
  try {
    ensureGiftAlertTables(context);

    const alerts = context.db
      .prepare(
        `SELECT * FROM gift_alerts WHERE user_id = ? AND active = 1 ORDER BY created_at DESC`
      )
      .all(context.senderId) as GiftAlertRow[];

    return {
      success: true,
      data: {
        total: alerts.length,
        alerts: alerts.map((a) => {
          const filters: string[] = [];
          if (a.collection) filters.push(`Collection: ${a.collection}`);
          if (a.model) filters.push(`Model: ${a.model}`);
          if (a.backdrop) filters.push(`Backdrop: ${a.backdrop}`);
          if (a.symbol) filters.push(`Symbol: ${a.symbol}`);
          if (a.min_tier) filters.push(`Min tier: ${a.min_tier}`);
          if (a.max_price) filters.push(`Max: ${a.max_price} ${a.currency}`);
          if (filters.length === 0) filters.push("All gifts");

          return {
            id: a.id,
            type: a.alert_type,
            filters: filters.join(" | "),
            triggeredCount: a.triggered_count,
            lastTriggered: a.last_triggered_at,
            createdAt: a.created_at,
          };
        }),
      },
    };
  } catch (err: unknown) {
    return {
      success: false,
      error: `List failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
};

// ─── gift_alert_remove ───────────────────────────────────────────────

interface AlertRemoveParams {
  alert_id: string;
}

export const giftAlertRemoveTool: Tool = {
  name: "gift_alert_remove",
  description: "🔔 Remove a gift alert by ID.",
  category: "action",
  parameters: Type.Object({
    alert_id: Type.String({ description: "Alert ID to remove" }),
  }),
};

export const giftAlertRemoveExecutor: ToolExecutor<AlertRemoveParams> = async (
  params,
  context
): Promise<ToolResult> => {
  try {
    ensureGiftAlertTables(context);

    const alert = context.db
      .prepare(`SELECT * FROM gift_alerts WHERE id = ? AND user_id = ?`)
      .get(params.alert_id, context.senderId) as GiftAlertRow | undefined;

    if (!alert) {
      return { success: false, error: "Alert not found or not yours." };
    }

    context.db.prepare(`UPDATE gift_alerts SET active = 0 WHERE id = ?`).run(params.alert_id);

    return {
      success: true,
      data: {
        removed: params.alert_id,
        type: alert.alert_type,
        collection: alert.collection || "all",
      },
    };
  } catch (err: unknown) {
    return {
      success: false,
      error: `Remove failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
};

// ─── Exported: Check alerts against a new listing (for agent use) ────

export interface AlertMatch {
  alertId: string;
  userId: number;
  alertType: string;
  filters: string;
}

/**
 * Check all active alerts against a new gift listing.
 * Returns matching alerts that should be triggered.
 */
export function checkAlertsForListing(
  ctx: ToolContext,
  listing: {
    collection: string;
    model: string;
    backdrop: string;
    symbol: string;
    rarity_tier: string;
    asking_price: number | null;
    currency: string;
  }
): AlertMatch[] {
  ensureGiftAlertTables(ctx);

  const TIER_RANK: Record<string, number> = {
    Legendary: 1,
    Epic: 2,
    Rare: 3,
    Uncommon: 4,
    Common: 5,
  };

  const alerts = ctx.db
    .prepare(`SELECT * FROM gift_alerts WHERE active = 1`)
    .all() as GiftAlertRow[];

  const matches: AlertMatch[] = [];

  for (const alert of alerts) {
    // Collection filter
    if (alert.collection && alert.collection.toLowerCase() !== listing.collection.toLowerCase())
      continue;

    // Model filter
    if (alert.model && alert.model.toLowerCase() !== listing.model.toLowerCase()) continue;

    // Backdrop filter
    if (alert.backdrop && alert.backdrop.toLowerCase() !== listing.backdrop.toLowerCase()) continue;

    // Symbol filter
    if (alert.symbol && alert.symbol.toLowerCase() !== listing.symbol.toLowerCase()) continue;

    // Tier filter
    if (alert.min_tier) {
      const alertTierRank = TIER_RANK[alert.min_tier] ?? 5;
      const listingTierRank = TIER_RANK[listing.rarity_tier] ?? 5;
      if (listingTierRank > alertTierRank) continue;
    }

    // Price filter
    if (alert.max_price && listing.asking_price) {
      if (alert.currency.toUpperCase() === listing.currency.toUpperCase()) {
        if (listing.asking_price > alert.max_price) continue;
      } else {
        continue; // Can't compare cross-currency
      }
    }

    // Alert type specific checks
    if (alert.alert_type === "rare_find" && !alert.min_tier) continue; // rare_find needs tier filter

    const filters: string[] = [];
    if (alert.collection) filters.push(alert.collection);
    if (alert.min_tier) filters.push(`≥${alert.min_tier}`);
    if (alert.max_price) filters.push(`≤${alert.max_price} ${alert.currency}`);

    matches.push({
      alertId: alert.id,
      userId: alert.user_id,
      alertType: alert.alert_type,
      filters: filters.join(", ") || "all",
    });

    // Update trigger count
    ctx.db
      .prepare(
        `UPDATE gift_alerts SET triggered_count = triggered_count + 1, last_triggered_at = datetime('now') WHERE id = ?`
      )
      .run(alert.id);
  }

  return matches;
}

// ─── Row Type ────────────────────────────────────────────────────────

interface GiftAlertRow {
  id: string;
  user_id: number;
  collection: string | null;
  min_tier: string | null;
  max_price: number | null;
  currency: string;
  alert_type: string;
  model: string | null;
  backdrop: string | null;
  symbol: string | null;
  active: number;
  triggered_count: number;
  last_triggered_at: string | null;
  created_at: string;
}
