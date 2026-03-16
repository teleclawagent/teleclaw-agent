/**
 * 🤝 Deal Negotiation — OTC username trading, escrow-style safety,
 * buyer/seller matching, and trade management.
 */

import { Type } from "@sinclair/typebox";
import type { Tool, ToolExecutor, ToolResult, ToolContext } from "../types.js";
import { checkUsername, estimateValue } from "./fragment-service.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("FragmentDeals");

// ─── Types ───────────────────────────────────────────────────────────

interface DealListing {
  id: string;
  type: "buy" | "sell";
  username: string;
  price: number; // TON
  sellerId?: number;
  buyerId?: number;
  createdAt: string;
  expiresAt: string;
  status: "open" | "matched" | "completed" | "expired" | "cancelled";
  matchedWith?: string; // deal id
  estimatedValue?: number;
}

// ─── DB Helpers ──────────────────────────────────────────────────────

function ensureDealsTable(context: ToolContext): void {
  context.db.exec(`
    CREATE TABLE IF NOT EXISTS fragment_deals (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN ('buy', 'sell')),
      username TEXT NOT NULL,
      price REAL NOT NULL,
      seller_id INTEGER,
      buyer_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'matched', 'completed', 'expired', 'cancelled')),
      matched_with TEXT,
      estimated_value REAL,
      notes TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_fragment_deals_status ON fragment_deals(status);
    CREATE INDEX IF NOT EXISTS idx_fragment_deals_username ON fragment_deals(username);
  `);
}

function generateId(): string {
  return `deal_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ─── List Offer (Buy or Sell) ────────────────────────────────────────

interface CreateDealParams {
  type: string;
  username: string;
  price: number;
  expires_hours?: number;
  notes?: string;
}

export const fragmentCreateDealTool: Tool = {
  name: "fragment_deal_create",
  description:
    "🤝 Create a buy or sell offer for a Telegram username. " +
    "Other Teleclaw users can see matching offers and connect. " +
    "Type 'buy' = looking to buy, 'sell' = offering to sell. " +
    "Includes AI valuation to help set fair prices.",
  category: "action",
  parameters: Type.Object({
    type: Type.String({
      description: "'buy' if looking to buy, 'sell' if offering to sell",
      enum: ["buy", "sell"],
    }),
    username: Type.String({
      description: "The username (with or without @)",
    }),
    price: Type.Number({
      description: "Asking/offering price in TON",
      minimum: 0.1,
    }),
    expires_hours: Type.Optional(
      Type.Number({
        description: "Hours until offer expires (default: 72 = 3 days)",
        minimum: 1,
        maximum: 720,
      })
    ),
    notes: Type.Optional(
      Type.String({
        description: "Additional notes (e.g. 'negotiable', 'serious buyers only')",
      })
    ),
  }),
};

export const fragmentCreateDealExecutor: ToolExecutor<CreateDealParams> = async (
  params,
  context
): Promise<ToolResult> => {
  try {
    ensureDealsTable(context);

    const { type, username, price, expires_hours = 72, notes } = params;
    const clean = username.replace(/^@/, "").toLowerCase();
    const typedType = type as "buy" | "sell";

    // Get valuation for context
    const valuation = await estimateValue(clean);

    const id = generateId();
    const expiresAt = new Date(
      Date.now() + expires_hours * 3600 * 1000
    ).toISOString();

    context.db
      .prepare(
        `INSERT INTO fragment_deals (id, type, username, price, ${typedType === "sell" ? "seller_id" : "buyer_id"}, expires_at, estimated_value, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        typedType,
        `@${clean}`,
        price,
        context.senderId,
        expiresAt,
        valuation.estimated.mid,
        notes || null
      );

    // Check for matching offers
    const matchType = typedType === "buy" ? "sell" : "buy";
    const matches = context.db
      .prepare(
        `SELECT * FROM fragment_deals
         WHERE username = ? AND type = ? AND status = 'open'
         AND expires_at > datetime('now')
         ${typedType === "buy" ? "AND price <= ?" : "AND price >= ?"}
         ORDER BY ${typedType === "buy" ? "price ASC" : "price DESC"}
         LIMIT 5`
      )
      .all(`@${clean}`, matchType, price) as DealListing[];

    const priceAssessment =
      price < valuation.estimated.low
        ? "⚠️ Below estimated market value"
        : price > valuation.estimated.high
          ? "⚠️ Above estimated market value"
          : "✅ Within fair market range";

    const matchText =
      matches.length > 0
        ? `\n\n🔗 ${matches.length} matching ${matchType} offer${matches.length !== 1 ? "s" : ""} found:\n` +
          matches
            .map(
              (m, i) =>
                `  ${i + 1}. ${m.price} TON (Deal #${m.id.slice(-8)})`
            )
            .join("\n") +
          "\n\nUse fragment_deal_match to connect with a match."
        : `\n\nNo matching ${matchType} offers yet. Your offer is now visible to other users.`;

    return {
      success: true,
      data: {
        dealId: id,
        type: typedType,
        username: `@${clean}`,
        price: `${price} TON`,
        expiresAt,
        estimatedValue: valuation.estimated,
        matches: matches.length,
        message:
          `🤝 ${typedType.toUpperCase()} offer created!\n\n` +
          `Username: @${clean}\n` +
          `${typedType === "sell" ? "Asking" : "Offering"}: ${price} TON\n` +
          `Estimated value: ${valuation.estimated.low}–${valuation.estimated.high} TON\n` +
          `${priceAssessment}\n` +
          `Expires: ${new Date(expiresAt).toLocaleString()}\n` +
          `Deal ID: ${id.slice(-8)}` +
          matchText,
      },
    };
  } catch (error) {
    log.error({ err: error }, "Create deal error");
    return {
      success: false,
      error: `Failed to create deal: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};

// ─── Browse Deals ────────────────────────────────────────────────────

interface BrowseParams {
  type?: string;
  username?: string;
  max_price?: number;
  limit?: number;
}

export const fragmentBrowseDealsTool: Tool = {
  name: "fragment_deal_browse",
  description:
    "Browse open buy/sell offers from other Teleclaw users. " +
    "Filter by type (buy/sell), username, and max price.",
  category: "data-bearing",
  parameters: Type.Object({
    type: Type.Optional(
      Type.String({
        description: "Filter by offer type: buy or sell",
        enum: ["buy", "sell"],
      })
    ),
    username: Type.Optional(
      Type.String({
        description: "Filter by specific username",
      })
    ),
    max_price: Type.Optional(
      Type.Number({
        description: "Maximum price in TON",
        minimum: 0,
      })
    ),
    limit: Type.Optional(
      Type.Number({
        description: "Max results (default: 20)",
        minimum: 1,
        maximum: 50,
      })
    ),
  }),
};

export const fragmentBrowseDealsExecutor: ToolExecutor<BrowseParams> = async (
  params,
  context
): Promise<ToolResult> => {
  try {
    ensureDealsTable(context);

    const { type, username, max_price, limit = 20 } = params;

    let query = `SELECT * FROM fragment_deals WHERE status = 'open' AND expires_at > datetime('now')`;
    const queryParams: unknown[] = [];

    if (type) {
      query += ` AND type = ?`;
      queryParams.push(type);
    }
    if (username) {
      const clean = username.replace(/^@/, "").toLowerCase();
      query += ` AND username = ?`;
      queryParams.push(`@${clean}`);
    }
    if (max_price !== undefined) {
      query += ` AND price <= ?`;
      queryParams.push(max_price);
    }

    query += ` ORDER BY created_at DESC LIMIT ?`;
    queryParams.push(limit);

    const deals = context.db.prepare(query).all(...queryParams) as DealListing[];

    if (deals.length === 0) {
      return {
        success: true,
        data: {
          deals: [],
          message: "No open deals found matching your criteria.",
        },
      };
    }

    const dealText = deals
      .map(
        (d, i) =>
          `${i + 1}. ${d.type.toUpperCase()} ${d.username} — ${d.price} TON` +
          (d.estimatedValue
            ? ` (est. ${Math.round(d.estimatedValue)} TON)`
            : "") +
          `\n   ID: ${d.id.slice(-8)} | Expires: ${new Date(d.expiresAt).toLocaleDateString()}`
      )
      .join("\n");

    return {
      success: true,
      data: {
        total: deals.length,
        deals,
        message: `🤝 Open deals (${deals.length}):\n\n${dealText}`,
      },
    };
  } catch (error) {
    log.error({ err: error }, "Browse deals error");
    return {
      success: false,
      error: `Failed to browse deals: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};

// ─── My Deals ────────────────────────────────────────────────────────

export const fragmentMyDealsTool: Tool = {
  name: "fragment_deal_mine",
  description: "List your active buy/sell offers and their status.",
  category: "data-bearing",
  parameters: Type.Object({}),
};

export const fragmentMyDealsExecutor: ToolExecutor<Record<string, never>> = async (
  _params,
  context
): Promise<ToolResult> => {
  try {
    ensureDealsTable(context);

    const deals = context.db
      .prepare(
        `SELECT * FROM fragment_deals
         WHERE (seller_id = ? OR buyer_id = ?)
         AND status IN ('open', 'matched')
         ORDER BY created_at DESC`
      )
      .all(context.senderId, context.senderId) as DealListing[];

    if (deals.length === 0) {
      return {
        success: true,
        data: {
          deals: [],
          message:
            "You have no active deals. Use fragment_deal_create to list a buy or sell offer.",
        },
      };
    }

    const dealText = deals
      .map(
        (d, i) =>
          `${i + 1}. ${d.type.toUpperCase()} ${d.username} — ${d.price} TON [${d.status}]\n` +
          `   ID: ${d.id.slice(-8)} | Created: ${new Date(d.createdAt).toLocaleDateString()}`
      )
      .join("\n");

    return {
      success: true,
      data: {
        total: deals.length,
        deals,
        message: `📋 Your deals (${deals.length}):\n\n${dealText}`,
      },
    };
  } catch (error) {
    log.error({ err: error }, "My deals error");
    return {
      success: false,
      error: `Failed to list deals: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};

// ─── Cancel Deal ─────────────────────────────────────────────────────

interface CancelParams {
  deal_id: string;
}

export const fragmentCancelDealTool: Tool = {
  name: "fragment_deal_cancel",
  description: "Cancel one of your open buy/sell offers.",
  category: "action",
  parameters: Type.Object({
    deal_id: Type.String({
      description: "Deal ID (full or last 8 characters)",
    }),
  }),
};

export const fragmentCancelDealExecutor: ToolExecutor<CancelParams> = async (
  params,
  context
): Promise<ToolResult> => {
  try {
    ensureDealsTable(context);

    const { deal_id } = params;

    // Support partial ID matching
    const deal = context.db
      .prepare(
        `SELECT * FROM fragment_deals
         WHERE (id = ? OR id LIKE ?)
         AND (seller_id = ? OR buyer_id = ?)
         AND status = 'open'`
      )
      .get(
        deal_id,
        `%${deal_id}`,
        context.senderId,
        context.senderId
      ) as DealListing | undefined;

    if (!deal) {
      return {
        success: false,
        error: "Deal not found or you don't own it.",
      };
    }

    context.db
      .prepare(`UPDATE fragment_deals SET status = 'cancelled' WHERE id = ?`)
      .run(deal.id);

    return {
      success: true,
      data: {
        dealId: deal.id,
        message: `✅ Deal cancelled: ${deal.type.toUpperCase()} ${deal.username} at ${deal.price} TON`,
      },
    };
  } catch (error) {
    log.error({ err: error }, "Cancel deal error");
    return {
      success: false,
      error: `Failed to cancel: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};

// ─── Compare Usernames ───────────────────────────────────────────────

interface CompareParams {
  usernames: string[];
}

export const fragmentCompareTool: Tool = {
  name: "fragment_compare",
  description:
    "Compare multiple usernames side by side: current status, price, " +
    "estimated value, and which is the best deal. Great for deciding between similar options.",
  category: "data-bearing",
  parameters: Type.Object({
    usernames: Type.Array(
      Type.String({ description: "Username (with or without @)" }),
      {
        description: "2-5 usernames to compare",
        minItems: 2,
        maxItems: 5,
      }
    ),
  }),
};

export const fragmentCompareExecutor: ToolExecutor<CompareParams> = async (
  params,
  _context
): Promise<ToolResult> => {
  try {
    const { usernames } = params;

    const results = await Promise.all(
      usernames.map(async (u) => {
        const clean = u.replace(/^@/, "").toLowerCase();
        const [status, valuation] = await Promise.all([
          checkUsername(clean),
          estimateValue(clean),
        ]);
        return { username: `@${clean}`, status, valuation };
      })
    );

    const comparisonText = results
      .map((r, i) => {
        const price = r.status?.price ?? "N/A";
        const statusStr = r.status?.status?.toUpperCase() ?? "UNKNOWN";
        const estMid = r.valuation.estimated.mid;
        const priceRaw = r.status?.priceRaw;
        const dealScore = priceRaw
          ? Math.round(((estMid - priceRaw) / estMid) * 100)
          : null;
        const dealEmoji =
          dealScore !== null
            ? dealScore > 30
              ? "🟢"
              : dealScore > 0
                ? "🟡"
                : "🔴"
            : "⚪";

        return (
          `${i + 1}. ${r.username}\n` +
          `   Status: ${statusStr} | Price: ${price}\n` +
          `   Est. value: ${r.valuation.estimated.low}–${r.valuation.estimated.high} TON (mid: ${estMid})\n` +
          `   ${dealEmoji} ${dealScore !== null ? `${dealScore}% ${dealScore > 0 ? "undervalued" : "overpriced"}` : "No price data"}\n` +
          `   Factors: ${r.valuation.factors.join(", ")}`
        );
      })
      .join("\n\n");

    // Find best deal
    const withScores = results
      .filter((r) => r.status?.priceRaw)
      .map((r) => ({
        username: r.username,
        score:
          ((r.valuation.estimated.mid - r.status!.priceRaw!) /
            r.valuation.estimated.mid) *
          100,
      }))
      .sort((a, b) => b.score - a.score);

    const bestDeal = withScores[0];
    const recommendation = bestDeal
      ? `\n\n🏆 Best deal: ${bestDeal.username} (${Math.round(bestDeal.score)}% undervalued)`
      : "";

    return {
      success: true,
      data: {
        comparisons: results,
        bestDeal: bestDeal?.username,
        message: `⚖️ Username Comparison\n\n${comparisonText}${recommendation}`,
      },
    };
  } catch (error) {
    log.error({ err: error }, "Compare error");
    return {
      success: false,
      error: `Comparison failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};
