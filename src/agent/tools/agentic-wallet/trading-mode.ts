/**
 * 🔀 Trading Mode Selector
 *
 * Users choose between:
 * 🟢 Safe Mode — Teleclaw prepares tx, user approves via deeplink (no custody)
 * 🔴 Auto Mode — Teleclaw holds custody wallet, fully autonomous trading
 *
 * Can switch anytime. Can even mix: "meme tokens Auto, gifts Safe"
 */

import { Type } from "@sinclair/typebox";
import type { Tool, ToolExecutor, ToolResult, ToolContext } from "../types.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("TradingMode");

// ─── DB Schema ───────────────────────────────────────────────────────

function ensureTradingModeTables(ctx: ToolContext): void {
  ctx.db.exec(`
    CREATE TABLE IF NOT EXISTS trading_mode (
      user_id INTEGER PRIMARY KEY,
      default_mode TEXT NOT NULL DEFAULT 'safe' CHECK(default_mode IN ('safe', 'auto')),
      token_mode TEXT CHECK(token_mode IN ('safe', 'auto', NULL)),
      gift_mode TEXT CHECK(gift_mode IN ('safe', 'auto', NULL)),
      username_mode TEXT CHECK(username_mode IN ('safe', 'auto', NULL)),
      number_mode TEXT CHECK(number_mode IN ('safe', 'auto', NULL)),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

type AssetType = "token" | "gift" | "username" | "number";
type TradingModeType = "safe" | "auto";

// ─── trading_mode_set ────────────────────────────────────────────────

interface ModeSetParams {
  mode: TradingModeType;
  asset_type?: AssetType;
}

export const tradingModeSetTool: Tool = {
  name: "trading_mode_set",
  description:
    "🔀 Set your trading mode — choose how Teleclaw handles trades.\n\n" +
    "TWO MODES:\n" +
    "🟢 Safe Mode — You keep full custody. Teleclaw prepares transactions, sends you a deeplink, " +
    "you approve in your wallet (Tonkeeper/MyTonWallet). Zero risk.\n\n" +
    "🔴 Auto Mode — Teleclaw holds a custody wallet for you. Fully autonomous trading — faster, " +
    "can snipe/DCA 24/7, but funds are in Teleclaw's custody wallet.\n\n" +
    "You can set different modes per asset type:\n" +
    "• 'Set tokens to auto, gifts to safe' → meme coins auto-trade, gifts need manual approval\n" +
    "• Or just set a default for everything\n\n" +
    "Switch anytime. Your funds stay where they are.",
  category: "action",
  parameters: Type.Object({
    mode: Type.Union([Type.Literal("safe"), Type.Literal("auto")], {
      description: "Trading mode: safe (deeplink approval) or auto (custody wallet)",
    }),
    asset_type: Type.Optional(
      Type.Union(
        [
          Type.Literal("token"),
          Type.Literal("gift"),
          Type.Literal("username"),
          Type.Literal("number"),
        ],
        { description: "Apply to specific asset type only. Omit to set as default for all." }
      )
    ),
  }),
};

export const tradingModeSetExecutor: ToolExecutor<ModeSetParams> = async (
  params,
  context
): Promise<ToolResult> => {
  try {
    ensureTradingModeTables(context);

    if (params.asset_type) {
      const column = `${params.asset_type}_mode`;
      // Ensure row exists
      context.db
        .prepare(
          `INSERT INTO trading_mode (user_id) VALUES (?)
           ON CONFLICT(user_id) DO NOTHING`
        )
        .run(context.senderId);

      context.db
        .prepare(
          `UPDATE trading_mode SET ${column} = ?, updated_at = datetime('now') WHERE user_id = ?`
        )
        .run(params.mode, context.senderId);

      return {
        success: true,
        data: {
          assetType: params.asset_type,
          mode: params.mode,
          message: `${params.mode === "safe" ? "🟢" : "🔴"} ${params.asset_type} trading set to ${params.mode.toUpperCase()} mode.`,
        },
      };
    }

    // Set default mode
    context.db
      .prepare(
        `INSERT INTO trading_mode (user_id, default_mode) VALUES (?, ?)
         ON CONFLICT(user_id) DO UPDATE SET default_mode = ?, updated_at = datetime('now')`
      )
      .run(context.senderId, params.mode, params.mode);

    return {
      success: true,
      data: {
        mode: params.mode,
        message:
          params.mode === "safe"
            ? "🟢 Default trading mode: SAFE\n\nAll trades will send you a deeplink to approve in your wallet. Zero custody risk."
            : "🔴 Default trading mode: AUTO\n\nTrades execute automatically via your custody wallet. Make sure it's funded and PIN is set.",
      },
    };
  } catch (err: unknown) {
    log.error({ err }, "Error setting trading mode");
    return { success: false, error: `Failed: ${err instanceof Error ? err.message : String(err)}` };
  }
};

// ─── trading_mode_view ───────────────────────────────────────────────

export const tradingModeViewTool: Tool = {
  name: "trading_mode_view",
  description: "🔀 View your current trading mode settings — default + per-asset overrides.",
  category: "data-bearing",
  parameters: Type.Object({}),
};

export const tradingModeViewExecutor: ToolExecutor = async (
  _params,
  context
): Promise<ToolResult> => {
  try {
    ensureTradingModeTables(context);

    const row = context.db
      .prepare(`SELECT * FROM trading_mode WHERE user_id = ?`)
      .get(context.senderId) as
      | {
          default_mode: string;
          token_mode: string | null;
          gift_mode: string | null;
          username_mode: string | null;
          number_mode: string | null;
        }
      | undefined;

    if (!row) {
      return {
        success: true,
        data: {
          default_mode: "safe",
          overrides: {},
          message:
            "No trading mode set yet. Default is 🟢 Safe Mode. Use trading_mode_set to change.",
        },
      };
    }

    const icon = (mode: string | null, fallback: string) => {
      const m = mode || fallback;
      return m === "safe" ? "🟢 Safe" : "🔴 Auto";
    };

    const overrides: Record<string, string> = {};
    if (row.token_mode) overrides.tokens = icon(row.token_mode, row.default_mode);
    if (row.gift_mode) overrides.gifts = icon(row.gift_mode, row.default_mode);
    if (row.username_mode) overrides.usernames = icon(row.username_mode, row.default_mode);
    if (row.number_mode) overrides.numbers = icon(row.number_mode, row.default_mode);

    return {
      success: true,
      data: {
        default_mode: icon(row.default_mode, "safe"),
        effective: {
          tokens: icon(row.token_mode, row.default_mode),
          gifts: icon(row.gift_mode, row.default_mode),
          usernames: icon(row.username_mode, row.default_mode),
          numbers: icon(row.number_mode, row.default_mode),
        },
        overrides: Object.keys(overrides).length > 0 ? overrides : "None — using default for all",
      },
    };
  } catch (err: unknown) {
    return { success: false, error: `Failed: ${err instanceof Error ? err.message : String(err)}` };
  }
};

// ─── Helper: Get effective mode for an asset type ────────────────────

/**
 * Resolve which trading mode to use for a given asset type.
 * Checks per-asset override first, falls back to default.
 */
export function getEffectiveMode(
  db: ToolContext["db"],
  userId: number,
  assetType: AssetType
): TradingModeType {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS trading_mode (
        user_id INTEGER PRIMARY KEY,
        default_mode TEXT NOT NULL DEFAULT 'safe',
        token_mode TEXT, gift_mode TEXT, username_mode TEXT, number_mode TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  } catch {
    // Table already exists
  }

  const column = `${assetType}_mode`;
  const row = db
    .prepare(`SELECT default_mode, ${column} as override_mode FROM trading_mode WHERE user_id = ?`)
    .get(userId) as { default_mode: string; override_mode: string | null } | undefined;

  if (!row) return "safe"; // Default to safe
  return (row.override_mode || row.default_mode) as TradingModeType;
}
