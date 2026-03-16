/**
 * OTC Consent Gate — Users must opt-in before using OTC matchmaker features.
 * Stores consent in SQLite per user. Explains how the system works before asking.
 */

import { Type } from "@sinclair/typebox";
import type { Tool, ToolExecutor, ToolResult, ToolContext } from "../types.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("OTCConsent");

function ensureConsentTable(ctx: ToolContext): void {
  ctx.db.exec(`
    CREATE TABLE IF NOT EXISTS otc_consent (
      user_id INTEGER PRIMARY KEY,
      consented INTEGER NOT NULL DEFAULT 0,
      consented_at TEXT,
      revoked_at TEXT
    );
  `);
}

/**
 * Check if a user has opted into OTC.
 */
export function hasOtcConsent(ctx: ToolContext): boolean {
  ensureConsentTable(ctx);
  const row = ctx.db
    .prepare("SELECT consented FROM otc_consent WHERE user_id = ?")
    .get(ctx.senderId) as { consented: number } | undefined;
  return row?.consented === 1;
}

/**
 * Check OTC consent and return error message if not consented.
 * Use this at the top of every OTC tool executor.
 */
export function requireOtcConsent(ctx: ToolContext): ToolResult | null {
  if (hasOtcConsent(ctx)) return null; // Has consent, proceed
  return {
    success: false,
    error:
      "⚠️ You need to opt into the OTC Matchmaker first.\n\n" +
      "The OTC system connects buyers and sellers across Teleclaw bots. " +
      "Here's how it works:\n\n" +
      "• You list items (usernames, gifts, numbers) for sale or register buying interest\n" +
      "• Active listings are shared anonymously with other Teleclaw bots\n" +
      "• Only item details and price are shared — your identity stays private\n" +
      "• When someone is interested, the seller decides whether to share contact info\n" +
      "• All trades happen directly between parties — Teleclaw never handles funds\n\n" +
      "To opt in, use the otc_join command.",
  };
}

// ─── Tool: Join OTC ──────────────────────────────────────────────────

export const otcJoinTool: Tool = {
  name: "otc_join",
  description:
    "Join the OTC Matchmaker — opt in to buy and sell usernames, gifts, and numbers.\n" +
    "Your listings will be shared anonymously with other Teleclaw bots for matching.\n" +
    "Only item details and prices are shared — your identity stays private until you choose to reveal it.",
  category: "action",
  parameters: Type.Object({}),
};

export const otcJoinExecutor: ToolExecutor<Record<string, never>> = async (
  _params,
  ctx
): Promise<ToolResult> => {
  try {
    ensureConsentTable(ctx);

    ctx.db
      .prepare(
        `INSERT INTO otc_consent (user_id, consented, consented_at)
         VALUES (?, 1, datetime('now'))
         ON CONFLICT(user_id) DO UPDATE SET consented = 1, consented_at = datetime('now'), revoked_at = NULL`
      )
      .run(ctx.senderId);

    log.info({ userId: ctx.senderId }, "User joined OTC");

    return {
      success: true,
      data: {
        message:
          "✅ Welcome to the OTC Matchmaker!\n\n" +
          "You can now:\n" +
          "• List usernames, gifts, or numbers for sale\n" +
          "• Register buying interest with filters\n" +
          "• Browse listings from other users\n" +
          "• Express interest and connect with sellers\n\n" +
          "Your identity is private until you choose to share it. " +
          "Use /otc leave to opt out at any time.",
      },
    };
  } catch (error) {
    log.error({ err: error }, "OTC join error");
    return { success: false, error: String(error) };
  }
};

// ─── Tool: Leave OTC ─────────────────────────────────────────────────

export const otcLeaveTool: Tool = {
  name: "otc_leave",
  description:
    "Leave the OTC Matchmaker — your listings will be deactivated and you won't receive notifications.",
  category: "action",
  parameters: Type.Object({}),
};

export const otcLeaveExecutor: ToolExecutor<Record<string, never>> = async (
  _params,
  ctx
): Promise<ToolResult> => {
  try {
    ensureConsentTable(ctx);

    ctx.db
      .prepare(
        `UPDATE otc_consent SET consented = 0, revoked_at = datetime('now') WHERE user_id = ?`
      )
      .run(ctx.senderId);

    log.info({ userId: ctx.senderId }, "User left OTC");

    return {
      success: true,
      data: {
        message:
          "✅ You've left the OTC Matchmaker. Your listings have been kept but won't be visible. You can rejoin anytime with otc_join.",
      },
    };
  } catch (error) {
    log.error({ err: error }, "OTC leave error");
    return { success: false, error: String(error) };
  }
};

// ─── Tool: OTC Status ────────────────────────────────────────────────

export const otcStatusTool: Tool = {
  name: "otc_status",
  description:
    "Check your OTC Matchmaker status — are you opted in, how many listings do you have.",
  category: "data-bearing",
  parameters: Type.Object({}),
};

export const otcStatusExecutor: ToolExecutor<Record<string, never>> = async (
  _params,
  ctx
): Promise<ToolResult> => {
  try {
    ensureConsentTable(ctx);
    const consent = hasOtcConsent(ctx);

    if (!consent) {
      return {
        success: true,
        data: {
          opted_in: false,
          message: "❌ You're not in the OTC Matchmaker. Use otc_join to opt in.",
        },
      };
    }

    // Count active listings
    const usernameCount =
      (
        ctx.db
          .prepare(
            `SELECT COUNT(*) as c FROM mm_listings WHERE seller_id = ? AND status = 'active'`
          )
          .get(ctx.senderId) as { c: number } | undefined
      )?.c ?? 0;

    const giftCount =
      (
        ctx.db
          .prepare(
            `SELECT COUNT(*) as c FROM gift_listings WHERE seller_id = ? AND status = 'active'`
          )
          .get(ctx.senderId) as { c: number } | undefined
      )?.c ?? 0;

    const numberCount =
      (
        ctx.db
          .prepare(`SELECT COUNT(*) as c FROM number_listings WHERE seller_id = ? AND active = 1`)
          .get(ctx.senderId) as { c: number } | undefined
      )?.c ?? 0;

    return {
      success: true,
      data: {
        opted_in: true,
        listings: {
          usernames: usernameCount,
          gifts: giftCount,
          numbers: numberCount,
          total: usernameCount + giftCount + numberCount,
        },
        message:
          `✅ OTC Matchmaker — Active\n\n` +
          `📋 Your listings:\n` +
          `  🔗 Usernames: ${usernameCount}\n` +
          `  🎁 Gifts: ${giftCount}\n` +
          `  📞 Numbers: ${numberCount}\n\n` +
          `Use otc_leave to opt out.`,
      },
    };
  } catch (error) {
    return { success: false, error: String(error) };
  }
};
