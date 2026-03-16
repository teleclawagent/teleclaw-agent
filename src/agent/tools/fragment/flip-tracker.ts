/**
 * 💰 Flip P&L Tracker — Track completed username flips with realized profit/loss.
 *
 * Extends the existing portfolio system:
 * - Record sells → moves username from portfolio to flip history
 * - Full flip history with realized P&L, ROI%, hold duration
 * - Aggregate stats: total profit, best/worst flip, win rate, avg ROI
 * - Leaderboard-ready data for community features
 */

import { Type } from "@sinclair/typebox";
import type { Tool, ToolExecutor, ToolResult, ToolContext } from "../types.js";
import { estimateValue } from "./fragment-service.js";
import { categorizeUsername, type CategoryKey } from "./categorizer.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("FlipTracker");

// ─── DB Schema ───────────────────────────────────────────────────────

function ensureFlipTables(ctx: ToolContext): void {
  ctx.db.exec(`
    -- Completed flips (buy → sell)
    CREATE TABLE IF NOT EXISTS fragment_flips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      username TEXT NOT NULL,
      buy_price REAL NOT NULL,
      sell_price REAL NOT NULL,
      buy_date TEXT NOT NULL,
      sell_date TEXT NOT NULL DEFAULT (date('now')),
      profit REAL NOT NULL,
      roi_pct REAL NOT NULL,
      hold_days INTEGER NOT NULL DEFAULT 0,
      categories TEXT NOT NULL DEFAULT '[]',
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Indexes for queries
    CREATE INDEX IF NOT EXISTS idx_flips_user ON fragment_flips(user_id);
    CREATE INDEX IF NOT EXISTS idx_flips_profit ON fragment_flips(user_id, profit);
    CREATE INDEX IF NOT EXISTS idx_flips_date ON fragment_flips(user_id, sell_date);
  `);
}

// ─── Tool: Record a Sell (Flip) ──────────────────────────────────────

interface SellParams {
  username: string;
  sell_price: number;
  buy_price?: number;
  buy_date?: string;
  sell_date?: string;
  notes?: string;
}

export const flipSellTool: Tool = {
  name: "fragment_flip_sell",
  description:
    "Record a username or anonymous number (+888) sale/flip. If in portfolio, auto-pulls buy price & calculates P&L. " +
    "If not in portfolio, provide buy_price to record the complete flip in one step. " +
    'Works for both usernames and +888 numbers.',
  category: "action",
  parameters: Type.Object({
    username: Type.String({ description: "Username (with @) or +888 number you sold" }),
    sell_price: Type.Number({ description: "Price you sold for in TON", minimum: 0 }),
    buy_price: Type.Optional(
      Type.Number({ description: "Original buy price in TON (if not already in portfolio)", minimum: 0 })
    ),
    buy_date: Type.Optional(
      Type.String({ description: "Original buy date (YYYY-MM-DD, for quick flip recording)" })
    ),
    sell_date: Type.Optional(
      Type.String({ description: "Date sold (YYYY-MM-DD, default: today)" })
    ),
    notes: Type.Optional(Type.String({ description: "Optional notes about the flip" })),
  }),
};

export const flipSellExecutor: ToolExecutor<SellParams> = async (
  params,
  ctx
): Promise<ToolResult> => {
  try {
    ensureFlipTables(ctx);
    const input = params.username.trim();
    const isNumber = /^\+?888[\s\d\-()]+$/.test(input.replace(/[+\s\-()]/g, "").startsWith("888") ? input : "");
    const clean = isNumber
      ? `+${input.replace(/[+\s\-()]/g, "")}`
      : `@${input.replace(/^@/, "").toLowerCase()}`;
    const sellDate = params.sell_date || new Date().toISOString().split("T")[0];
    const userId = ctx.senderId;

    // Check if username exists in portfolio
    const portfolioEntry = ctx.db
      .prepare(
        `SELECT * FROM fragment_portfolio WHERE user_id = ? AND username = ?`
      )
      .get(userId, clean) as { buy_price: number; buy_date: string; notes?: string } | undefined;

    let buyPrice: number;
    let buyDate: string;

    if (portfolioEntry) {
      buyPrice = params.buy_price ?? portfolioEntry.buy_price;
      buyDate = params.buy_date ?? portfolioEntry.buy_date;
    } else if (params.buy_price !== undefined) {
      // Not in portfolio but buy_price provided — record flip directly
      buyPrice = params.buy_price;
      buyDate = params.buy_date || sellDate;
    } else {
      return {
        success: false,
        error:
          `${clean} is not in your portfolio. Either add it first with fragment_portfolio_add, ` +
          `or provide the buy_price parameter to record the flip directly.`,
      };
    }

    // Calculate P&L
    const profit = params.sell_price - buyPrice;
    const roiPct = buyPrice > 0 ? Math.round((profit / buyPrice) * 100 * 10) / 10 : 0;

    // Calculate hold duration
    const buyMs = new Date(buyDate).getTime();
    const sellMs = new Date(sellDate).getTime();
    const holdDays = Math.max(0, Math.round((sellMs - buyMs) / (1000 * 60 * 60 * 24)));

    // Categorize for analytics
    const categorized = categorizeUsername(clean);
    const categories = categorized.categories;

    // Record the flip
    ctx.db
      .prepare(
        `INSERT INTO fragment_flips (user_id, username, buy_price, sell_price, buy_date, sell_date, profit, roi_pct, hold_days, categories, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        userId,
        clean,
        buyPrice,
        params.sell_price,
        buyDate,
        sellDate,
        profit,
        roiPct,
        holdDays,
        JSON.stringify(categories),
        params.notes || portfolioEntry?.notes || null
      );

    // Remove from active portfolio (if it was there)
    if (portfolioEntry) {
      ctx.db
        .prepare(`DELETE FROM fragment_portfolio WHERE user_id = ? AND username = ?`)
        .run(userId, clean);
    }

    const emoji = profit >= 0 ? "🟢" : "🔴";
    const profitStr = profit >= 0 ? `+${profit}` : `${profit}`;

    return {
      success: true,
      data: {
        username: clean,
        buyPrice,
        sellPrice: params.sell_price,
        profit,
        roiPct,
        holdDays,
        categories,
        message:
          `${emoji} *Flip Recorded*\n\n` +
          `📛 ${clean}\n` +
          `💸 Buy: ${buyPrice} TON → Sell: ${params.sell_price} TON\n` +
          `${emoji} P&L: ${profitStr} TON (${roiPct >= 0 ? "+" : ""}${roiPct}%)\n` +
          `📅 Held: ${holdDays} days (${buyDate} → ${sellDate})\n` +
          (profit > 0 ? `\n🎉 Nice flip!` : profit === 0 ? `\n😐 Break even.` : `\n💎 Lesson learned.`),
      },
    };
  } catch (error) {
    log.error({ err: error }, "Flip sell error");
    return { success: false, error: String(error) };
  }
};

// ─── Tool: Flip History ──────────────────────────────────────────────

interface HistoryParams {
  limit?: number;
  sort?: string;
  category?: string;
}

export const flipHistoryTool: Tool = {
  name: "fragment_flip_history",
  description:
    "View your completed flip history — all username buys & sells with realized P&L, ROI, and hold duration.",
  category: "data-bearing",
  parameters: Type.Object({
    limit: Type.Optional(
      Type.Number({ description: "Number of flips to show (default: 10)", minimum: 1, maximum: 50 })
    ),
    sort: Type.Optional(
      Type.String({
        description: "Sort by: recent, profit, loss, roi, duration",
        enum: ["recent", "profit", "loss", "roi", "duration"],
      })
    ),
    category: Type.Optional(
      Type.String({ description: "Filter by category (e.g. crypto, short, gaming)" })
    ),
  }),
};

export const flipHistoryExecutor: ToolExecutor<HistoryParams> = async (
  params,
  ctx
): Promise<ToolResult> => {
  try {
    ensureFlipTables(ctx);
    const { limit = 10, sort = "recent", category } = params;
    const userId = ctx.senderId;

    let orderBy: string;
    switch (sort) {
      case "profit": orderBy = "profit DESC"; break;
      case "loss": orderBy = "profit ASC"; break;
      case "roi": orderBy = "roi_pct DESC"; break;
      case "duration": orderBy = "hold_days DESC"; break;
      default: orderBy = "sell_date DESC, id DESC";
    }

    let query = `SELECT * FROM fragment_flips WHERE user_id = ?`;
    const queryParams: unknown[] = [userId];

    if (category) {
      query += ` AND categories LIKE ?`;
      queryParams.push(`%"${category}"%`);
    }

    query += ` ORDER BY ${orderBy} LIMIT ?`;
    queryParams.push(limit);

    const flips = ctx.db.prepare(query).all(...queryParams) as Array<{
      username: string;
      buy_price: number;
      sell_price: number;
      buy_date: string;
      sell_date: string;
      profit: number;
      roi_pct: number;
      hold_days: number;
      categories: string;
      notes: string | null;
    }>;

    if (flips.length === 0) {
      return {
        success: true,
        data: {
          message: "📭 No flips recorded yet. Sell a username from your portfolio to start tracking!",
        },
      };
    }

    const flipText = flips
      .map((f, i) => {
        const emoji = f.profit >= 0 ? "🟢" : "🔴";
        const profitStr = f.profit >= 0 ? `+${f.profit}` : `${f.profit}`;
        const cats = JSON.parse(f.categories).slice(0, 2).join(", ");
        return (
          `${i + 1}. ${f.username} ${emoji}\n` +
          `   ${f.buy_price} → ${f.sell_price} TON (${profitStr} TON, ${f.roi_pct >= 0 ? "+" : ""}${f.roi_pct}%)\n` +
          `   ${f.hold_days}d hold | ${cats}`
        );
      })
      .join("\n\n");

    return {
      success: true,
      data: {
        flips: flips.map((f) => ({
          ...f,
          categories: JSON.parse(f.categories),
        })),
        message: `📜 *Flip History* (${flips.length} shown)\n\n${flipText}`,
      },
    };
  } catch (error) {
    log.error({ err: error }, "Flip history error");
    return { success: false, error: String(error) };
  }
};

// ─── Tool: Flip Stats ────────────────────────────────────────────────

export const flipStatsTool: Tool = {
  name: "fragment_flip_stats",
  description:
    "📊 Your flip trading statistics — total profit, win rate, best/worst flip, " +
    "average ROI, avg hold time, profit by category. The ultimate P&L dashboard.",
  category: "data-bearing",
  parameters: Type.Object({
    period: Type.Optional(
      Type.String({
        description: "Time period: all, week, month, year (default: all)",
        enum: ["all", "week", "month", "year"],
      })
    ),
  }),
};

interface StatsParams {
  period?: string;
}

export const flipStatsExecutor: ToolExecutor<StatsParams> = async (
  params,
  ctx
): Promise<ToolResult> => {
  try {
    ensureFlipTables(ctx);
    const userId = ctx.senderId;
    const { period = "all" } = params;

    // Date filter
    let dateFilter = "";
    if (period !== "all") {
      const now = new Date();
      let cutoff: Date;
      switch (period) {
        case "week":
          cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
          break;
        case "month":
          cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
          break;
        case "year":
          cutoff = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
          break;
        default:
          cutoff = new Date(0);
      }
      dateFilter = ` AND sell_date >= '${cutoff.toISOString().split("T")[0]}'`;
    }

    const flips = ctx.db
      .prepare(
        `SELECT * FROM fragment_flips WHERE user_id = ?${dateFilter} ORDER BY sell_date DESC`
      )
      .all(userId) as Array<{
      username: string;
      buy_price: number;
      sell_price: number;
      profit: number;
      roi_pct: number;
      hold_days: number;
      categories: string;
      sell_date: string;
    }>;

    if (flips.length === 0) {
      return {
        success: true,
        data: { message: "📭 No flip data yet. Record some sells to see your stats!" },
      };
    }

    // Aggregate stats
    const totalFlips = flips.length;
    const wins = flips.filter((f) => f.profit > 0);
    const losses = flips.filter((f) => f.profit < 0);
    const breakEven = flips.filter((f) => f.profit === 0);

    const totalProfit = flips.reduce((s, f) => s + f.profit, 0);
    const totalInvested = flips.reduce((s, f) => s + f.buy_price, 0);
    const totalRevenue = flips.reduce((s, f) => s + f.sell_price, 0);
    const avgRoi = totalInvested > 0 ? Math.round((totalProfit / totalInvested) * 100 * 10) / 10 : 0;
    const avgHoldDays = Math.round(flips.reduce((s, f) => s + f.hold_days, 0) / totalFlips);
    const winRate = Math.round((wins.length / totalFlips) * 100);

    // Best & worst
    const bestFlip = flips.reduce((best, f) => (f.profit > best.profit ? f : best), flips[0]);
    const worstFlip = flips.reduce((worst, f) => (f.profit < worst.profit ? f : worst), flips[0]);

    // Biggest single profit & loss
    const biggestWin = wins.length > 0
      ? wins.reduce((a, b) => (a.profit > b.profit ? a : b))
      : null;
    const biggestLoss = losses.length > 0
      ? losses.reduce((a, b) => (a.profit < b.profit ? a : b))
      : null;

    // Profit by category
    const catProfit: Record<string, { profit: number; count: number }> = {};
    for (const f of flips) {
      const cats: string[] = JSON.parse(f.categories);
      for (const cat of cats) {
        if (!catProfit[cat]) catProfit[cat] = { profit: 0, count: 0 };
        catProfit[cat].profit += f.profit;
        catProfit[cat].count++;
      }
    }

    const topCategories = Object.entries(catProfit)
      .sort((a, b) => b[1].profit - a[1].profit)
      .slice(0, 5)
      .map(([cat, data]) => ({
        category: cat,
        profit: Math.round(data.profit),
        count: data.count,
      }));

    // Monthly trend (last 6 months)
    const monthlyProfit: Record<string, number> = {};
    for (const f of flips) {
      const month = f.sell_date.slice(0, 7); // YYYY-MM
      monthlyProfit[month] = (monthlyProfit[month] || 0) + f.profit;
    }

    const periodLabel = period === "all" ? "All Time" : `Last ${period}`;

    // Build message
    const profitEmoji = totalProfit >= 0 ? "📈" : "📉";
    const message = [
      `📊 *Flip Stats — ${periodLabel}*`,
      ``,
      `${profitEmoji} *Total P&L: ${totalProfit >= 0 ? "+" : ""}${Math.round(totalProfit)} TON*`,
      `💵 Invested: ${Math.round(totalInvested)} TON → Revenue: ${Math.round(totalRevenue)} TON`,
      `📊 Avg ROI: ${avgRoi >= 0 ? "+" : ""}${avgRoi}%`,
      ``,
      `*Trades:*`,
      `🔢 Total: ${totalFlips} flips`,
      `🟢 Wins: ${wins.length} (${winRate}%)`,
      `🔴 Losses: ${losses.length}`,
      `⚪ Break-even: ${breakEven.length}`,
      `⏱️ Avg hold: ${avgHoldDays} days`,
      ``,
      `*Best & Worst:*`,
      biggestWin
        ? `🏆 Best: ${biggestWin.username} (+${biggestWin.profit} TON, +${biggestWin.roi_pct}%)`
        : `🏆 Best: —`,
      biggestLoss
        ? `💀 Worst: ${biggestLoss.username} (${biggestLoss.profit} TON, ${biggestLoss.roi_pct}%)`
        : `💀 Worst: —`,
      ``,
      `*Top Categories:*`,
      ...topCategories.map(
        (c) =>
          `${c.profit >= 0 ? "🟢" : "🔴"} ${c.category}: ${c.profit >= 0 ? "+" : ""}${c.profit} TON (${c.count} flips)`
      ),
    ].join("\n");

    return {
      success: true,
      data: {
        summary: {
          totalFlips,
          totalProfit: Math.round(totalProfit),
          totalInvested: Math.round(totalInvested),
          totalRevenue: Math.round(totalRevenue),
          avgRoi,
          winRate,
          avgHoldDays,
          wins: wins.length,
          losses: losses.length,
        },
        bestFlip: biggestWin
          ? { username: biggestWin.username, profit: biggestWin.profit, roi: biggestWin.roi_pct }
          : null,
        worstFlip: biggestLoss
          ? { username: biggestLoss.username, profit: biggestLoss.profit, roi: biggestLoss.roi_pct }
          : null,
        topCategories,
        monthlyProfit,
        message,
      },
    };
  } catch (error) {
    log.error({ err: error }, "Flip stats error");
    return { success: false, error: String(error) };
  }
};
