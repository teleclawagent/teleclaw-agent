/**
 * 🔢 Number Taste Profile & Matchmaker
 *
 * Flow:
 * 1. User tells preferences: digit length, pattern type, preferred digits, budget
 * 2. Agent saves as number taste profile
 * 3. When someone lists a number for sale → match against all profiles
 * 4. Notify matching buyers via DM
 *
 * Mirrors username taste profile system but with number-specific criteria.
 */

import { Type } from "@sinclair/typebox";
import type { Tool, ToolExecutor, ToolResult, ToolContext } from "../types.js";
import { calculateRarity, type RarityTier } from "./number-rarity.js";
import { checkTokenGate } from "./token-gate.js";
import { createLogger } from "../../../utils/logger.js";
import { priceMatches } from "../../../ton/price-service.js";
import { requireOtcConsent } from "./otc-consent.js";

const log = createLogger("NumberProfile");

// ─── Types ───────────────────────────────────────────────────────────

type PatternPref = "repeating" | "sequential" | "palindrome" | "round" | "all-same" | "any";
type LengthPref = "short" | "standard" | "any";

interface NumberProfile {
  userId: number;
  lengthPref: LengthPref; // short (7-digit), standard (11-digit), any
  patterns: PatternPref[]; // desired pattern types
  preferredDigits: number[]; // digits they want more of (e.g. [8, 6, 9])
  avoidDigits: number[]; // digits to avoid (e.g. [4])
  minTier: RarityTier; // minimum tier interest (e.g. "C" = C and above)
  maxPrice: number | null; // budget in TON
  minScore: number; // minimum rarity score (0-100)
  enabled: boolean;
}

// ─── DB ──────────────────────────────────────────────────────────────

function ensureNumberProfileTables(ctx: ToolContext): void {
  ctx.db.exec(`
    CREATE TABLE IF NOT EXISTS number_taste_profiles (
      user_id INTEGER PRIMARY KEY,
      length_pref TEXT NOT NULL DEFAULT 'any',
      patterns TEXT NOT NULL DEFAULT '["any"]',
      preferred_digits TEXT NOT NULL DEFAULT '[]',
      avoid_digits TEXT NOT NULL DEFAULT '[4]',
      min_tier TEXT NOT NULL DEFAULT 'D',
      max_price REAL,
      min_score INTEGER NOT NULL DEFAULT 30,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Number sale listings (for matchmaking)
    CREATE TABLE IF NOT EXISTS number_listings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      seller_id INTEGER NOT NULL,
      number TEXT NOT NULL,
      price REAL,
      currency TEXT NOT NULL DEFAULT 'TON',
      tier TEXT NOT NULL,
      score INTEGER NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      active INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'sold', 'cancelled')),
      listed_at TEXT NOT NULL DEFAULT (datetime('now')),
      sold_at TEXT,
      last_reminder_at TEXT,
      UNIQUE(number)
    );

    -- Notification log
    CREATE TABLE IF NOT EXISTS number_match_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      buyer_id INTEGER NOT NULL,
      listing_id INTEGER NOT NULL,
      score INTEGER NOT NULL,
      sent_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(buyer_id, listing_id)
    );

    CREATE INDEX IF NOT EXISTS idx_nml_buyer_time
      ON number_match_log(buyer_id, sent_at);
  `);
}

// ─── Matching Engine ─────────────────────────────────────────────────

const MAX_ALERTS_PER_HOUR = 5;
const ALERT_WINDOW_MS = 60 * 60 * 1000;

function matchNumberToProfile(
  profile: NumberProfile,
  number: string,
  rarity: {
    tier: RarityTier;
    score: number;
    tags: string[];
    totalDigits: number;
    rawDigits: string;
  }
): number {
  let score = 0;
  let maxScore = 0;

  // ── Length preference (25%) ──
  maxScore += 25;
  if (profile.lengthPref === "any") {
    score += 25;
  } else if (profile.lengthPref === "short" && rarity.totalDigits === 7) {
    score += 25;
  } else if (profile.lengthPref === "standard" && rarity.totalDigits === 11) {
    score += 25;
  }
  // else 0 — wrong length

  // ── Pattern match (30%) ──
  maxScore += 30;
  if (profile.patterns.includes("any")) {
    score += 15; // base for "any"
  }
  for (const pref of profile.patterns) {
    if (pref === "any") continue;
    // Check if any rarity tag matches
    const tagMap: Record<string, string[]> = {
      repeating: [
        "all-same",
        "all-eights",
        "near-perfect-repeat",
        "strong-repeat-6+",
        "repeat-5",
        "repeat-4",
        "repeat-3",
      ],
      sequential: ["full-sequential", "sequential-6+", "sequential-4"],
      palindrome: ["palindrome"],
      round: ["round-5+", "round-3+"],
      "all-same": ["all-same", "all-eights"],
    };
    const matchTags = tagMap[pref] || [];
    if (matchTags.some((t) => rarity.tags.includes(t))) {
      score += 30;
      break;
    }
  }

  // ── Preferred digits (25%) ──
  maxScore += 25;
  if (profile.preferredDigits.length === 0) {
    score += 12; // neutral
  } else {
    const digits = rarity.rawDigits.split("").map(Number);
    const prefCount = digits.filter((d) => profile.preferredDigits.includes(d)).length;
    const ratio = prefCount / digits.length;
    score += Math.round(ratio * 25);
  }

  // ── Avoid digits penalty ──
  if (profile.avoidDigits.length > 0) {
    const digits = rarity.rawDigits.split("").map(Number);
    const avoidCount = digits.filter((d) => profile.avoidDigits.includes(d)).length;
    score -= avoidCount * 3; // penalty per avoided digit
  }

  // ── Tier match (20%) ──
  maxScore += 20;
  const tierOrder: RarityTier[] = ["D", "C", "B", "A", "S"];
  const minTierIdx = tierOrder.indexOf(profile.minTier);
  const actualTierIdx = tierOrder.indexOf(rarity.tier);
  if (actualTierIdx >= minTierIdx) {
    // Bonus for exceeding minimum tier
    score += 10 + Math.min(10, (actualTierIdx - minTierIdx) * 3);
  }

  return Math.max(0, Math.min(100, Math.round((score / maxScore) * 100)));
}

function getRecentAlertCount(ctx: ToolContext, userId: number): number {
  try {
    const cutoff = new Date(Date.now() - ALERT_WINDOW_MS).toISOString();
    const row = ctx.db
      .prepare(`SELECT COUNT(*) as cnt FROM number_match_log WHERE buyer_id = ? AND sent_at > ?`)
      .get(userId, cutoff) as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  } catch {
    return 0;
  }
}

// ─── Tool: Set Number Preferences ────────────────────────────────────

interface SetProfileParams {
  length?: string;
  patterns?: string[];
  preferred_digits?: number[];
  avoid_digits?: number[];
  min_tier?: string;
  max_price?: number;
  min_score?: number;
}

export const numberProfileSetTool: Tool = {
  name: "number_profile_set",
  description:
    "Set your anonymous number preferences. Tell me what kind of +888 numbers you're interested in: " +
    "length (short/standard/any), patterns (repeating/sequential/palindrome/round/all-same/any), " +
    "preferred digits (e.g. [8,6,9]), digits to avoid (e.g. [4]), minimum tier, and budget. " +
    "When someone lists a matching number for sale, you'll get a DM notification.",
  category: "action",
  parameters: Type.Object({
    length: Type.Optional(
      Type.String({
        description:
          'Preferred length: "short" (7-digit, +888 8XXX), "standard" (11-digit), or "any"',
        enum: ["short", "standard", "any"],
      })
    ),
    patterns: Type.Optional(
      Type.Array(Type.String(), {
        description:
          'Pattern preferences: ["repeating", "sequential", "palindrome", "round", "all-same", "any"]',
      })
    ),
    preferred_digits: Type.Optional(
      Type.Array(Type.Number(), {
        description: "Digits you want more of (e.g. [8, 6, 9])",
      })
    ),
    avoid_digits: Type.Optional(
      Type.Array(Type.Number(), {
        description: "Digits to avoid (e.g. [4])",
      })
    ),
    min_tier: Type.Optional(
      Type.String({
        description: 'Minimum rarity tier: "S", "A", "B", "C", "D"',
        enum: ["S", "A", "B", "C", "D"],
      })
    ),
    max_price: Type.Optional(Type.Number({ description: "Maximum budget in TON", minimum: 0 })),
    min_score: Type.Optional(
      Type.Number({ description: "Minimum rarity score (0-100)", minimum: 0, maximum: 100 })
    ),
  }),
};

export const numberProfileSetExecutor: ToolExecutor<SetProfileParams> = async (
  params,
  ctx
): Promise<ToolResult> => {
  try {
    ensureNumberProfileTables(ctx);

    // 🔒 Token Gate: verify $TELECLAW holdings for matchmaker features
    const consentError = requireOtcConsent(ctx);
    if (consentError) return consentError;
    const gateResult = await checkTokenGate(ctx.db, ctx.senderId);
    if (!gateResult.allowed) {
      return { success: false, error: gateResult.reason };
    }

    const userId = ctx.senderId;

    const lengthPref = (params.length || "any") as LengthPref;
    const patterns = (params.patterns || ["any"]) as PatternPref[];
    const preferredDigits = params.preferred_digits || [];
    const avoidDigits = params.avoid_digits || [4];
    const minTier = (params.min_tier || "D") as RarityTier;
    const maxPrice = params.max_price ?? null;
    const minScore = params.min_score ?? 30;

    ctx.db
      .prepare(
        `INSERT INTO number_taste_profiles
         (user_id, length_pref, patterns, preferred_digits, avoid_digits, min_tier, max_price, min_score, enabled, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))
         ON CONFLICT(user_id) DO UPDATE SET
           length_pref = excluded.length_pref,
           patterns = excluded.patterns,
           preferred_digits = excluded.preferred_digits,
           avoid_digits = excluded.avoid_digits,
           min_tier = excluded.min_tier,
           max_price = excluded.max_price,
           min_score = excluded.min_score,
           enabled = 1,
           updated_at = datetime('now')`
      )
      .run(
        userId,
        lengthPref,
        JSON.stringify(patterns),
        JSON.stringify(preferredDigits),
        JSON.stringify(avoidDigits),
        minTier,
        maxPrice,
        minScore
      );

    const lengthLabel =
      lengthPref === "short"
        ? "7-digit (+888 8XXX)"
        : lengthPref === "standard"
          ? "11-digit (+888 0XXX XXXX)"
          : "Any";
    const prefDigitStr = preferredDigits.length > 0 ? preferredDigits.join(", ") : "Any";
    const avoidStr = avoidDigits.length > 0 ? avoidDigits.join(", ") : "None";

    return {
      success: true,
      data: [
        "✅ *Number Profile Saved*",
        "",
        `📏 Length: ${lengthLabel}`,
        `🎯 Patterns: ${patterns.join(", ")}`,
        `🍀 Preferred digits: ${prefDigitStr}`,
        `🚫 Avoid digits: ${avoidStr}`,
        `🏆 Min tier: ${minTier}`,
        `💰 Budget: ${maxPrice ? maxPrice.toLocaleString() + " TON" : "No limit"}`,
        `📊 Min score: ${minScore}/100`,
        "",
        "I'll notify you when someone lists a matching number for sale.",
      ].join("\n"),
    };
  } catch (error) {
    log.error({ err: error }, "Number profile set error");
    return { success: false, error: String(error) };
  }
};

// ─── Tool: View Profile ──────────────────────────────────────────────

export const numberProfileViewTool: Tool = {
  name: "number_profile_view",
  description: "View your current anonymous number preferences and notification settings.",
  category: "data-bearing",
  parameters: Type.Object({}),
};

export const numberProfileViewExecutor: ToolExecutor<Record<string, never>> = async (
  _params,
  ctx
): Promise<ToolResult> => {
  try {
    ensureNumberProfileTables(ctx);

    const row = ctx.db
      .prepare(`SELECT * FROM number_taste_profiles WHERE user_id = ? AND enabled = 1`)
      .get(ctx.senderId) as Record<string, unknown> | undefined;

    if (!row) {
      return {
        success: true,
        data: "📭 No number profile set up. Use `number_profile_set` to tell me your preferences!",
      };
    }

    const patterns = JSON.parse(row.patterns as string);
    const prefDigits = JSON.parse(row.preferred_digits as string);
    const avoidDigits = JSON.parse(row.avoid_digits as string);
    const alerts = getRecentAlertCount(ctx, ctx.senderId);

    return {
      success: true,
      data: [
        "⚙️ *Number Profile*",
        "",
        `📏 Length: ${row.length_pref}`,
        `🎯 Patterns: ${patterns.join(", ")}`,
        `🍀 Preferred: ${prefDigits.length > 0 ? prefDigits.join(", ") : "Any"}`,
        `🚫 Avoid: ${avoidDigits.length > 0 ? avoidDigits.join(", ") : "None"}`,
        `🏆 Min tier: ${row.min_tier}`,
        `💰 Budget: ${row.max_price ? (row.max_price as number).toLocaleString() + " TON" : "No limit"}`,
        `📊 Min score: ${row.min_score}/100`,
        "",
        `📬 Alerts this hour: ${alerts}/${MAX_ALERTS_PER_HOUR}`,
      ].join("\n"),
    };
  } catch (error) {
    log.error({ err: error }, "Number profile view error");
    return { success: false, error: String(error) };
  }
};

// ─── Tool: List Number for Sale ──────────────────────────────────────

interface ListNumberParams {
  number: string;
  price?: number;
}

export const numberListForSaleTool: Tool = {
  name: "number_list_sale",
  description:
    "List an anonymous number for sale. The agent will automatically analyze its rarity " +
    "and notify matching buyers who have set up number profiles.",
  category: "action",
  parameters: Type.Object({
    number: Type.String({ description: "The +888 number you want to sell" }),
    price: Type.Optional(Type.Number({ description: "Asking price in TON", minimum: 0 })),
  }),
};

export type NumberAlertSender = (userId: number, message: string) => Promise<boolean>;

export const numberListForSaleExecutor: ToolExecutor<ListNumberParams> = async (
  params,
  ctx
): Promise<ToolResult> => {
  try {
    ensureNumberProfileTables(ctx);

    // 🔒 Token Gate: verify $TELECLAW holdings for matchmaker features
    const consentError = requireOtcConsent(ctx);
    if (consentError) return consentError;
    const gateResult = await checkTokenGate(ctx.db, ctx.senderId);
    if (!gateResult.allowed) {
      return { success: false, error: gateResult.reason };
    }

    const rarity = calculateRarity(params.number);
    if (!rarity) {
      return { success: false, error: "Invalid +888 number format." };
    }

    // Save listing
    const result = ctx.db
      .prepare(
        `INSERT INTO number_listings (seller_id, number, price, tier, score, tags, active)
         VALUES (?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(number) DO UPDATE SET
           seller_id = excluded.seller_id,
           price = excluded.price,
           tier = excluded.tier,
           score = excluded.score,
           tags = excluded.tags,
           active = 1,
           listed_at = datetime('now')`
      )
      .run(
        ctx.senderId,
        rarity.number,
        params.price ?? null,
        rarity.tier,
        rarity.score,
        JSON.stringify(rarity.tags)
      );

    const listingId = Number(result.lastInsertRowid);

    // Find matching buyers
    const profiles = ctx.db
      .prepare(`SELECT * FROM number_taste_profiles WHERE enabled = 1 AND user_id != ?`)
      .all(ctx.senderId) as Array<Record<string, unknown>>;

    let matchCount = 0;
    const matches: Array<{ userId: number; score: number }> = [];

    for (const row of profiles) {
      const profile: NumberProfile = {
        userId: row.user_id as number,
        lengthPref: row.length_pref as LengthPref,
        patterns: JSON.parse(row.patterns as string),
        preferredDigits: JSON.parse(row.preferred_digits as string),
        avoidDigits: JSON.parse(row.avoid_digits as string),
        minTier: row.min_tier as RarityTier,
        maxPrice: row.max_price as number | null,
        minScore: row.min_score as number,
        enabled: true,
      };

      // Price filter
      // Cross-currency price check
      if (profile.maxPrice && params.price) {
        const listingCur =
          ((params as unknown as Record<string, unknown>).currency as string) || "TON";
        const buyerCur = "TON"; // number profiles currently TON-only budget
        const canAfford = await priceMatches(params.price, listingCur, profile.maxPrice, buyerCur);
        if (canAfford === false) continue;
      }

      // Score filter
      if (rarity.score < profile.minScore) continue;

      const matchScore = matchNumberToProfile(profile, rarity.number, rarity);
      if (matchScore >= 50) {
        matches.push({ userId: profile.userId, score: matchScore });
        matchCount++;
      }
    }

    const tierEmojis: Record<string, string> = { S: "🔴", A: "🟠", B: "🟡", C: "🟢", D: "⚪" };
    const emoji = tierEmojis[rarity.tier] || "⚪";
    const priceStr = params.price ? `${params.price.toLocaleString()} TON` : "Price TBD";

    return {
      success: true,
      data: {
        listing: {
          number: rarity.number,
          price: params.price,
          tier: rarity.tier,
          score: rarity.score,
          tags: rarity.tags,
          listingId,
        },
        matches,
        _notifyBuyers: matches.map((m) => ({
          userId: m.userId,
          message:
            `🔔 New number listing matching your profile!\n\n` +
            `${emoji} ${rarity.number}\n` +
            `🏆 ${rarity.tier} — ${rarity.label} (${rarity.score}/100)\n` +
            `💰 Price: ${priceStr}\n` +
            `🏷️ ${rarity.tags.join(", ")}\n\n` +
            `Interested? Tell me "express interest in ${rarity.number}"`,
        })),
        message: [
          `✅ *Number Listed for Sale*`,
          ``,
          `${emoji} ${rarity.number}`,
          `🏆 ${rarity.tier} — ${rarity.label} (${rarity.score}/100)`,
          `💰 Price: ${priceStr}`,
          `🏷️ ${rarity.tags.join(", ")}`,
          ``,
          matchCount > 0
            ? `📬 *${matchCount} potential buyer${matchCount > 1 ? "s" : ""} matched!* Notifications being sent.`
            : `📭 No matching buyers yet. They'll be notified when they set up profiles.`,
        ].join("\n"),
      },
    };
  } catch (error) {
    log.error({ err: error }, "Number list for sale error");
    return { success: false, error: String(error) };
  }
};

// ─── Tool: Browse Number Listings ────────────────────────────────────

interface BrowseParams {
  tier?: string;
  max_price?: number;
  pattern?: string;
}

export const numberBrowseListingsTool: Tool = {
  name: "number_browse",
  description:
    "Browse anonymous numbers currently listed for sale. Filter by tier, price, and pattern type.",
  category: "data-bearing",
  parameters: Type.Object({
    tier: Type.Optional(
      Type.String({ description: 'Filter by minimum tier: "S", "A", "B", "C", "D"' })
    ),
    max_price: Type.Optional(Type.Number({ description: "Maximum price in TON" })),
    pattern: Type.Optional(
      Type.String({ description: "Filter by pattern tag (e.g. repeating, sequential, palindrome)" })
    ),
  }),
};

export const numberBrowseListingsExecutor: ToolExecutor<BrowseParams> = async (
  params,
  ctx
): Promise<ToolResult> => {
  try {
    ensureNumberProfileTables(ctx);

    let query = `SELECT * FROM number_listings WHERE active = 1`;
    const queryParams: unknown[] = [];

    if (params.tier) {
      const tierOrder = ["D", "C", "B", "A", "S"];
      const minIdx = tierOrder.indexOf(params.tier);
      if (minIdx >= 0) {
        const validTiers = tierOrder.slice(minIdx);
        query += ` AND tier IN (${validTiers.map(() => "?").join(",")})`;
        queryParams.push(...validTiers);
      }
    }

    if (params.max_price) {
      query += ` AND (price IS NULL OR price <= ?)`;
      queryParams.push(params.max_price);
    }

    if (params.pattern) {
      query += ` AND tags LIKE ?`;
      queryParams.push(`%"${params.pattern}"%`);
    }

    query += ` ORDER BY score DESC LIMIT 20`;

    const listings = ctx.db.prepare(query).all(...queryParams) as Array<Record<string, unknown>>;

    if (listings.length === 0) {
      return {
        success: true,
        data: "📭 No matching numbers listed for sale right now.",
      };
    }

    const tierEmojis: Record<string, string> = { S: "🔴", A: "🟠", B: "🟡", C: "🟢", D: "⚪" };

    const lines = listings.map((l, i) => {
      const emoji = tierEmojis[l.tier as string] || "⚪";
      const tags = JSON.parse(l.tags as string)
        .slice(0, 2)
        .join(", ");
      const price = l.price ? `${(l.price as number).toLocaleString()} TON` : "Offer";
      return `${i + 1}. ${emoji} ${l.number} — ${l.tier} (${l.score})\n   💰 ${price} | 🏷️ ${tags}`;
    });

    return {
      success: true,
      data: [`🔢 *Numbers for Sale* (${listings.length})`, ``, ...lines].join("\n"),
    };
  } catch (error) {
    log.error({ err: error }, "Number browse error");
    return { success: false, error: String(error) };
  }
};

// ─── Mark Number as Sold ─────────────────────────────────────────────

interface NumberSoldParams {
  number: string;
}

export const numberSoldTool: Tool = {
  name: "number_sold",
  description:
    "✅ Mark an anonymous number listing as SOLD after completing the trade.\n" +
    "Closes the listing. Only the seller can mark it as sold.",
  category: "action",
  parameters: Type.Object({
    number: Type.String({ description: "The +888 number that was sold" }),
  }),
};

export const numberSoldExecutor: ToolExecutor<NumberSoldParams> = async (
  params,
  ctx
): Promise<ToolResult> => {
  try {
    ensureNumberProfileTables(ctx);

    const result = ctx.db
      .prepare(
        `UPDATE number_listings SET active = 0, status = 'sold', sold_at = datetime('now')
         WHERE number = ? AND seller_id = ? AND active = 1`
      )
      .run(params.number.replace(/\s/g, ""), ctx.senderId);

    if (result.changes === 0) {
      return { success: false, error: "No active listing found for this number, or not yours." };
    }

    // Get interested buyers from match log
    const interestedBuyers = ctx.db
      .prepare(
        `SELECT DISTINCT buyer_id FROM number_match_log
         WHERE listing_id IN (SELECT id FROM number_listings WHERE number = ?)`
      )
      .all(params.number.replace(/\s/g, "")) as Array<{ buyer_id: number }>;

    return {
      success: true,
      data: {
        number: params.number,
        status: "sold",
        _notifyBuyers: interestedBuyers
          .filter((b) => b.buyer_id !== ctx.senderId)
          .map((b) => ({
            userId: b.buyer_id,
            message:
              `ℹ️ A number you were interested in has been sold.\n\n` +
              `📞 ${params.number}\n\n` +
              `Keep browsing — new numbers are listed regularly!`,
          })),
        message: `✅ ${params.number} marked as sold.${interestedBuyers.length > 0 ? ` ${interestedBuyers.length} interested buyer(s) notified.` : ""}`,
      },
    };
  } catch (error) {
    log.error({ err: error }, "Number sold error");
    return { success: false, error: String(error) };
  }
};

// ─── Tool: Express Interest in Number ────────────────────────────────

interface NumberExpressParams {
  number: string;
  offer_price?: number;
  message?: string;
}

export const numberExpressInterestTool: Tool = {
  name: "number_express_interest",
  description:
    "Express interest in a listed anonymous number. The seller will be notified with your offer.\n" +
    "After this, the seller can reach out to you directly to arrange the trade.",
  category: "action",
  parameters: Type.Object({
    number: Type.String({ description: "The +888 number you're interested in" }),
    offer_price: Type.Optional(Type.Number({ description: "Your offer price in TON" })),
    message: Type.Optional(Type.String({ description: "Message to the seller" })),
  }),
};

export const numberExpressInterestExecutor: ToolExecutor<NumberExpressParams> = async (
  params,
  ctx
): Promise<ToolResult> => {
  try {
    ensureNumberProfileTables(ctx);

    const consentError = requireOtcConsent(ctx);
    if (consentError) return consentError;
    const gateResult = await checkTokenGate(ctx.db, ctx.senderId);
    if (!gateResult.allowed) {
      return { success: false, error: gateResult.reason };
    }

    const cleanNumber = params.number.replace(/\s/g, "");
    const listing = ctx.db
      .prepare(`SELECT * FROM number_listings WHERE number = ? AND active = 1`)
      .get(cleanNumber) as Record<string, unknown> | undefined;

    if (!listing) {
      return { success: false, error: "No active listing found for this number." };
    }

    if ((listing.seller_id as number) === ctx.senderId) {
      return { success: false, error: "You can't express interest in your own listing." };
    }

    // Log the match
    ctx.db
      .prepare(
        `INSERT OR IGNORE INTO number_match_log (buyer_id, listing_id, score)
         VALUES (?, ?, 100)`
      )
      .run(ctx.senderId, listing.id);

    const buyerLabel = ctx.senderUsername ? `@${ctx.senderUsername}` : `User #${ctx.senderId}`;

    return {
      success: true,
      data: {
        number: params.number,
        sellerId: listing.seller_id,
        _notifySeller: {
          userId: listing.seller_id as number,
          message:
            `🔔 Someone is interested in your number!\n\n` +
            `📞 ${params.number}\n` +
            `🏆 ${listing.tier} (${listing.score}/100)\n` +
            `${params.offer_price ? `💰 Their offer: ${params.offer_price} TON\n` : ""}` +
            `${params.message ? `💬 Message: ${params.message}\n` : ""}` +
            `👤 Buyer: ${buyerLabel}\n\n` +
            `Reach out to them directly if you'd like to proceed.`,
        },
        message:
          `✅ Interest expressed!\n\n` +
          `📞 ${params.number} — ${listing.price ? listing.price + " TON" : "Price TBD"}\n\n` +
          `The seller has been notified. If they're interested, they'll reach out to you directly.`,
      },
    };
  } catch (error) {
    log.error({ err: error }, "Number express interest error");
    return { success: false, error: String(error) };
  }
};

// ─── Tool: Cancel Number Listing ─────────────────────────────────────

interface NumberCancelParams {
  number: string;
}

export const numberCancelTool: Tool = {
  name: "number_cancel",
  description: "Cancel your active number listing.",
  category: "action",
  parameters: Type.Object({
    number: Type.String({ description: "The +888 number listing to cancel" }),
  }),
};

export const numberCancelExecutor: ToolExecutor<NumberCancelParams> = async (
  params,
  ctx
): Promise<ToolResult> => {
  try {
    ensureNumberProfileTables(ctx);

    const cleanNumber = params.number.replace(/\s/g, "");
    const result = ctx.db
      .prepare(
        `UPDATE number_listings SET active = 0, status = 'cancelled'
         WHERE number = ? AND seller_id = ? AND active = 1`
      )
      .run(cleanNumber, ctx.senderId);

    if (result.changes === 0) {
      return { success: false, error: "No active listing found for this number, or not yours." };
    }

    return {
      success: true,
      data: {
        number: params.number,
        status: "cancelled",
        message: `✅ Listing for ${params.number} cancelled.`,
      },
    };
  } catch (error) {
    log.error({ err: error }, "Number cancel error");
    return { success: false, error: String(error) };
  }
};

// ─── Tool: My Number Listings ────────────────────────────────────────

export const numberMyListingsTool: Tool = {
  name: "number_my_listings",
  description: "View your active number listings.",
  category: "data-bearing",
  parameters: Type.Object({}),
};

export const numberMyListingsExecutor: ToolExecutor<Record<string, never>> = async (
  _params,
  ctx
): Promise<ToolResult> => {
  try {
    ensureNumberProfileTables(ctx);

    const listings = ctx.db
      .prepare(
        `SELECT * FROM number_listings WHERE seller_id = ? AND active = 1 ORDER BY listed_at DESC`
      )
      .all(ctx.senderId) as Array<Record<string, unknown>>;

    if (listings.length === 0) {
      return {
        success: true,
        data: { message: "No active listings. Use number_list_sale to list a number." },
      };
    }

    const text = listings
      .map((l, i) => {
        const tierEmojis: Record<string, string> = { S: "🔴", A: "🟠", B: "🟡", C: "🟢", D: "⚪" };
        const emoji = tierEmojis[l.tier as string] || "⚪";
        return `${i + 1}. ${emoji} ${l.number} — ${l.price ? l.price + " TON" : "Price TBD"} | ${l.tier} (${l.score}/100)`;
      })
      .join("\n");

    return {
      success: true,
      data: {
        count: listings.length,
        listings,
        message: `📋 Your Listings (${listings.length}):\n\n${text}`,
      },
    };
  } catch (error) {
    log.error({ err: error }, "Number my listings error");
    return { success: false, error: String(error) };
  }
};

// ─── Stale Number Listings ───────────────────────────────────────────

export function getStaleNumberListings(ctx: ToolContext): Array<Record<string, unknown>> {
  ensureNumberProfileTables(ctx);
  return ctx.db
    .prepare(
      `SELECT * FROM number_listings
       WHERE active = 1 AND status = 'active'
       AND listed_at < datetime('now', '-48 hours')
       AND (last_reminder_at IS NULL OR last_reminder_at < datetime('now', '-24 hours'))`
    )
    .all() as Array<Record<string, unknown>>;
}

export function markNumberListingReminded(ctx: ToolContext, number: string): void {
  ctx.db
    .prepare(`UPDATE number_listings SET last_reminder_at = datetime('now') WHERE number = ?`)
    .run(number);
}

// ─── Exports ─────────────────────────────────────────────────────────

export { ensureNumberProfileTables, matchNumberToProfile, type NumberProfile };
