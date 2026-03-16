/**
 * 📱 Portfolio Optimizer — Track owned usernames, P&L, sell timing recommendations.
 */

import { Type } from "@sinclair/typebox";
import type { Tool, ToolExecutor, ToolResult, ToolContext } from "../types.js";
import { checkUsername, estimateValue, checkNumber } from "./fragment-service.js";
import { calculateRarity } from "./number-rarity.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("FragmentPortfolio");

// ─── DB ──────────────────────────────────────────────────────────────

interface PortfolioEntry {
  username: string;
  buy_price: number;
  buy_date: string;
  notes?: string;
}

function ensurePortfolioTable(ctx: ToolContext): void {
  ctx.db.exec(`
    CREATE TABLE IF NOT EXISTS fragment_portfolio (
      user_id INTEGER NOT NULL,
      username TEXT NOT NULL,
      buy_price REAL NOT NULL,
      buy_date TEXT NOT NULL DEFAULT (date('now')),
      notes TEXT,
      PRIMARY KEY (user_id, username)
    );
  `);
}

// ─── Add to Portfolio ────────────────────────────────────────────────

interface AddParams {
  username: string;
  buy_price: number;
  buy_date?: string;
  notes?: string;
}

export const portfolioAddTool: Tool = {
  name: "fragment_portfolio_add",
  description:
    "Add a username OR anonymous number (+888) to your portfolio tracker. Records buy price for P&L tracking. " +
    "Supports both @usernames and +888 numbers.",
  category: "action",
  parameters: Type.Object({
    username: Type.String({ description: "Username (with or without @) or +888 anonymous number" }),
    buy_price: Type.Number({ description: "Price you paid in TON", minimum: 0 }),
    buy_date: Type.Optional(
      Type.String({ description: "Date purchased (YYYY-MM-DD, default: today)" })
    ),
    notes: Type.Optional(Type.String({ description: "Optional notes" })),
  }),
};

export const portfolioAddExecutor: ToolExecutor<AddParams> = async (
  params,
  context
): Promise<ToolResult> => {
  try {
    ensurePortfolioTable(context);
    const input = params.username.trim();
    // Detect if it's a number (+888...) or username
    const isNumber = /^\+?888[\s\d\-()]+$/.test(input.replace(/[+\s\-()]/g, "").startsWith("888") ? input : "");
    const clean = isNumber
      ? `+${input.replace(/[+\s\-()]/g, "")}` // normalize to +888XXXXXXXX
      : `@${input.replace(/^@/, "").toLowerCase()}`;

    context.db
      .prepare(
        `INSERT OR REPLACE INTO fragment_portfolio (user_id, username, buy_price, buy_date, notes)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        context.senderId,
        clean,
        params.buy_price,
        params.buy_date || new Date().toISOString().split("T")[0],
        params.notes || null
      );

    return {
      success: true,
      data: {
        message: `✅ Added ${clean} to portfolio (bought at ${params.buy_price} TON)`,
      },
    };
  } catch (error) {
    log.error({ err: error }, "Portfolio add error");
    return { success: false, error: String(error) };
  }
};

// ─── Remove from Portfolio ───────────────────────────────────────────

interface RemoveParams {
  username: string;
}

export const portfolioRemoveTool: Tool = {
  name: "fragment_portfolio_remove",
  description: "Remove a username from your portfolio.",
  category: "action",
  parameters: Type.Object({
    username: Type.String({ description: "Username to remove" }),
  }),
};

export const portfolioRemoveExecutor: ToolExecutor<RemoveParams> = async (
  params,
  context
): Promise<ToolResult> => {
  try {
    ensurePortfolioTable(context);
    const input = params.username.trim();
    const isNumber = /^\+?888[\s\d\-()]+$/.test(input.replace(/[+\s\-()]/g, "").startsWith("888") ? input : "");
    const clean = isNumber
      ? `+${input.replace(/[+\s\-()]/g, "")}`
      : `@${input.replace(/^@/, "").toLowerCase()}`;

    const result = context.db
      .prepare(
        `DELETE FROM fragment_portfolio WHERE user_id = ? AND username = ?`
      )
      .run(context.senderId, clean);

    if (result.changes === 0) {
      return { success: false, error: `${clean} not found in your portfolio.` };
    }

    return {
      success: true,
      data: { message: `✅ Removed ${clean} from portfolio` },
    };
  } catch (error) {
    log.error({ err: error }, "Portfolio remove error");
    return { success: false, error: String(error) };
  }
};

// ─── View Portfolio with P&L ─────────────────────────────────────────

interface ViewParams {
  sort?: string;
}

export const portfolioViewTool: Tool = {
  name: "fragment_portfolio",
  description:
    "📱 View your username portfolio with current valuations, P&L per item, " +
    "total portfolio value, and sell/hold recommendations.",
  category: "data-bearing",
  parameters: Type.Object({
    sort: Type.Optional(
      Type.String({
        description: "Sort by: value, profit, loss, name (default: profit)",
        enum: ["value", "profit", "loss", "name"],
      })
    ),
  }),
};

export const portfolioViewExecutor: ToolExecutor<ViewParams> = async (
  params,
  context
): Promise<ToolResult> => {
  try {
    ensurePortfolioTable(context);
    const { sort = "profit" } = params;

    const entries = context.db
      .prepare(
        `SELECT * FROM fragment_portfolio WHERE user_id = ? ORDER BY buy_date DESC`
      )
      .all(context.senderId) as PortfolioEntry[];

    if (entries.length === 0) {
      return {
        success: true,
        data: {
          message:
            "Your portfolio is empty. Use fragment_portfolio_add to track your usernames.",
        },
      };
    }

    // Valuate each — limit parallel calls
    const valuations = [];
    for (const entry of entries) {
      const isNum = entry.username.startsWith("+888") || entry.username.startsWith("888");
      let currentValue: number;
      let estimatedRange: { low: number; mid: number; high: number } = { low: 0, mid: 0, high: 0 };
      let fragmentStatus = "unknown";

      if (isNum) {
        // Number: use rarity engine for valuation, checkNumber for live price
        const numStatus = await checkNumber(entry.username);
        const rarity = calculateRarity(entry.username);
        const rarityMid = rarity ? (rarity.estimatedFloor.min + rarity.estimatedFloor.max) / 2 : 0;
        currentValue = numStatus?.priceRaw ?? rarityMid;
        if (rarity) {
          estimatedRange = { low: rarity.estimatedFloor.min, mid: rarityMid, high: rarity.estimatedFloor.max };
        }
        fragmentStatus = numStatus?.status ?? "unknown";
      } else {
        // Username: existing logic
        const [status, valuation] = await Promise.all([
          checkUsername(entry.username),
          estimateValue(entry.username),
        ]);
        currentValue = status?.priceRaw ?? valuation.estimated.mid;
        estimatedRange = valuation.estimated;
        fragmentStatus = status?.status ?? "unknown";
      }

      const pnl = currentValue - entry.buy_price;
      const pnlPct = entry.buy_price > 0 ? (pnl / entry.buy_price) * 100 : 0;

      let recommendation: string;
      if (pnlPct > 100) recommendation = "🟢 SELL — excellent profit, take it";
      else if (pnlPct > 30) recommendation = "🟡 HOLD/SELL — good profit";
      else if (pnlPct > 0) recommendation = "🟡 HOLD — small profit, wait for more";
      else if (pnlPct > -20) recommendation = "🟡 HOLD — minor dip, likely recovers";
      else recommendation = "🔴 HOLD — deep loss, wait or cut";

      valuations.push({
        username: entry.username,
        buyPrice: entry.buy_price,
        buyDate: entry.buy_date,
        currentValue: Math.round(currentValue),
        estimatedRange,
        pnl: Math.round(pnl),
        pnlPct: Math.round(pnlPct),
        recommendation,
        fragmentStatus,
        notes: entry.notes,
      });
    }

    // Sort
    if (sort === "profit") valuations.sort((a, b) => b.pnlPct - a.pnlPct);
    else if (sort === "loss") valuations.sort((a, b) => a.pnlPct - b.pnlPct);
    else if (sort === "value")
      valuations.sort((a, b) => b.currentValue - a.currentValue);
    else valuations.sort((a, b) => a.username.localeCompare(b.username));

    const totalInvested = valuations.reduce((s, v) => s + v.buyPrice, 0);
    const totalCurrent = valuations.reduce((s, v) => s + v.currentValue, 0);
    const totalPnl = totalCurrent - totalInvested;
    const totalPnlPct =
      totalInvested > 0 ? Math.round((totalPnl / totalInvested) * 100) : 0;

    const itemText = valuations
      .map(
        (v, i) =>
          `${i + 1}. ${v.username}\n` +
          `   Bought: ${v.buyPrice} TON (${v.buyDate}) → Now: ~${v.currentValue} TON\n` +
          `   P&L: ${v.pnl >= 0 ? "+" : ""}${v.pnl} TON (${v.pnlPct >= 0 ? "+" : ""}${v.pnlPct}%)\n` +
          `   ${v.recommendation}`
      )
      .join("\n\n");

    const emoji = totalPnl >= 0 ? "📈" : "📉";

    return {
      success: true,
      data: {
        portfolio: valuations,
        summary: {
          totalInvested: Math.round(totalInvested),
          totalCurrentValue: Math.round(totalCurrent),
          totalPnl: Math.round(totalPnl),
          totalPnlPct,
          itemCount: valuations.length,
        },
        message:
          `📱 Your Username Portfolio\n\n` +
          `${emoji} Total: ${Math.round(totalCurrent)} TON (invested: ${Math.round(totalInvested)} TON)\n` +
          `${emoji} P&L: ${totalPnl >= 0 ? "+" : ""}${Math.round(totalPnl)} TON (${totalPnlPct >= 0 ? "+" : ""}${totalPnlPct}%)\n` +
          `Items: ${valuations.length}\n\n` +
          itemText,
      },
    };
  } catch (error) {
    log.error({ err: error }, "Portfolio view error");
    return { success: false, error: String(error) };
  }
};
