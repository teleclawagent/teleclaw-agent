/**
 * 🔗 Username Matchmaker — Connect username buyers and sellers.
 *
 * Teleclaw = matchmaker only. Does NOT handle trades.
 * Sellers list → Teleclaw categorizes → notifies matching buyers.
 * Buyer interested → Teleclaw tells seller "this person wants it, DM them."
 *
 * OTC deal tools (list/interest/express) require holding 0.1% $TELECLAW supply.
 * All other username tools (sniper, valuation, check, market, search, etc.) are FREE.
 */

import { Type } from "@sinclair/typebox";
import type { Tool, ToolExecutor, ToolResult, ToolContext } from "../types.js";
import { estimateValue } from "./fragment-service.js";
import { categorizeUsername, getChineseMeaning, type CategoryKey } from "./categorizer.js";
import { findMatchingBuyers } from "./taste-profile.js";
import { checkTokenGate } from "./token-gate.js";
import { createLogger } from "../../../utils/logger.js";
import { priceMatches } from "../../../ton/price-service.js";
import { requireOtcConsent } from "./otc-consent.js";

const log = createLogger("Matchmaker");

// ─── DB Schema ───────────────────────────────────────────────────────

function ensureMatchmakerTables(ctx: ToolContext): void {
  ctx.db.exec(`
    CREATE TABLE IF NOT EXISTS mm_listings (
      id TEXT PRIMARY KEY,
      seller_id INTEGER NOT NULL,
      seller_username TEXT,
      username TEXT NOT NULL,
      asking_price REAL,
      categories TEXT NOT NULL,
      description TEXT,
      estimated_value REAL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'matched', 'expired', 'cancelled', 'sold')),
      match_count INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'TON',
      sold_at TEXT,
      last_reminder_at TEXT
    );

    CREATE TABLE IF NOT EXISTS mm_interests (
      id TEXT PRIMARY KEY,
      buyer_id INTEGER NOT NULL,
      buyer_username TEXT,
      categories TEXT NOT NULL,
      max_price REAL,
      currency TEXT NOT NULL DEFAULT 'TON',
      keywords TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS mm_matches (
      id TEXT PRIMARY KEY,
      listing_id TEXT NOT NULL,
      interest_id TEXT,
      buyer_id INTEGER NOT NULL,
      seller_id INTEGER NOT NULL,
      username TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      buyer_notified INTEGER NOT NULL DEFAULT 0,
      seller_notified INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (listing_id) REFERENCES mm_listings(id)
    );

    CREATE INDEX IF NOT EXISTS idx_mm_listings_status ON mm_listings(status);
    CREATE INDEX IF NOT EXISTS idx_mm_interests_active ON mm_interests(active);
    CREATE INDEX IF NOT EXISTS idx_mm_matches_buyer ON mm_matches(buyer_id);
    CREATE INDEX IF NOT EXISTS idx_mm_matches_seller ON mm_matches(seller_id);
  `);
}

function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ─── List Username for Sale ──────────────────────────────────────────

interface ListForSaleParams {
  username: string;
  asking_price?: number;
  currency?: string;
  description?: string;
  expires_days?: number;
}

export const mmListTool: Tool = {
  name: "mm_list_username",
  description:
    "🔗 List a Telegram username for sale on the Teleclaw matchmaker. " +
    "Teleclaw auto-categorizes it and notifies matching buyers. " +
    "You handle the actual trade yourself (Fragment, middleman, direct — your choice). " +
    "Requires holding 0.1% $TELECLAW supply.",
  category: "action",
  parameters: Type.Object({
    username: Type.String({ description: "Username to sell (with or without @)" }),
    asking_price: Type.Optional(
      Type.Number({ description: "Asking price (optional — can be 'offers welcome')", minimum: 0 })
    ),
    currency: Type.Optional(
      Type.String({ description: "Price currency: TON or USDT (default: TON)" })
    ),
    description: Type.Optional(
      Type.String({ description: "Short description or notes (e.g. 'OG 4-letter, clean history')" })
    ),
    expires_days: Type.Optional(
      Type.Number({
        description: "Days until listing expires (default: 14)",
        minimum: 1,
        maximum: 90,
      })
    ),
  }),
};

export const mmListExecutor: ToolExecutor<ListForSaleParams> = async (
  params,
  context
): Promise<ToolResult> => {
  try {
    ensureMatchmakerTables(context);
    const { username, asking_price, currency = "TON", description, expires_days = 14 } = params;
    const clean = `@${username.replace(/^@/, "").toLowerCase()}`;

    // 🔒 Token Gate: verify $TELECLAW holdings
    // 🤝 OTC Consent check
    const consentError = requireOtcConsent(context);
    if (consentError) return consentError;
    const gateResult = await checkTokenGate(context.db, context.senderId);
    if (!gateResult.allowed) {
      return { success: false, error: gateResult.reason };
    }

    // Categorize
    const categorized = categorizeUsername(clean);
    const categories = categorized.categories;

    // Get Chinese meaning if applicable
    const chineseMeaning = getChineseMeaning(clean);

    // Get estimated value
    const valuation = await estimateValue(clean);

    const id = generateId("lst");
    const expiresAt = new Date(Date.now() + expires_days * 86400000).toISOString();

    context.db
      .prepare(
        `INSERT INTO mm_listings (id, seller_id, seller_username, username, asking_price, currency, categories, description, estimated_value, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        context.senderId,
        null, // Will be populated from TG context if available
        clean,
        asking_price ?? null,
        currency.toUpperCase(),
        JSON.stringify(categories),
        description ?? null,
        valuation.estimated.mid,
        expiresAt
      );

    // ── Match via Taste Profiles (AI-powered) ──
    const tasteMatches = findMatchingBuyers(
      context,
      clean,
      categories as CategoryKey[],
      asking_price,
      40
    ).filter((m) => m.userId !== context.senderId);

    // ── Match via Category Interests (legacy/manual) ──
    const interests = context.db
      .prepare(`SELECT * FROM mm_interests WHERE active = 1`)
      .all() as Array<{
      id: string;
      buyer_id: number;
      buyer_username: string | null;
      categories: string;
      max_price: number | null;
      keywords: string | null;
    }>;

    const interestMatches: Array<{ buyerId: number; interestId: string; reason: string }> = [];

    for (const interest of interests) {
      if (interest.buyer_id === context.senderId) continue;

      const buyerCats: string[] = JSON.parse(interest.categories);
      const overlap = categories.filter((c) => buyerCats.includes(c));
      if (overlap.length === 0) continue;
      // Cross-currency price check (TON vs USDT normalized via live price)
      if (interest.max_price && asking_price) {
        const interestCurrency = (
          ((interest as Record<string, unknown>).currency as string) || "TON"
        ).toUpperCase();
        const listingCurrency = currency.toUpperCase();
        const canAfford = await priceMatches(
          asking_price,
          listingCurrency,
          interest.max_price,
          interestCurrency
        );
        if (canAfford === false) continue; // Too expensive
        // canAfford === null means price fetch failed — include match to not miss opportunities
      }

      if (interest.keywords) {
        const keywords = interest.keywords.split(",").map((k) => k.trim().toLowerCase());
        const usernameClean = clean.replace(/^@/, "");
        const keywordMatch = keywords.some((k) => usernameClean.includes(k));
        if (!keywordMatch && overlap.length < 2) continue;
      }

      interestMatches.push({
        buyerId: interest.buyer_id,
        interestId: interest.id,
        reason: `Categories: ${overlap.join(", ")}`,
      });
    }

    // Merge both match sources, deduplicate by userId
    const allBuyerIds = new Set<number>();
    const matchedBuyers: Array<{
      buyerId: number;
      interestId?: string;
      reason: string;
      score?: number;
    }> = [];

    // Taste profile matches first (higher quality)
    for (const tm of tasteMatches) {
      if (!allBuyerIds.has(tm.userId)) {
        allBuyerIds.add(tm.userId);
        matchedBuyers.push({
          buyerId: tm.userId,
          reason: `Taste profile match (${tm.score}% similarity)`,
          score: tm.score,
        });
      }
    }

    // Then category interest matches
    for (const im of interestMatches) {
      if (!allBuyerIds.has(im.buyerId)) {
        allBuyerIds.add(im.buyerId);
        matchedBuyers.push({
          buyerId: im.buyerId,
          interestId: im.interestId,
          reason: im.reason,
        });
      }
    }

    // Record matches in DB
    for (const mb of matchedBuyers) {
      const matchId = generateId("mtch");
      context.db
        .prepare(
          `INSERT INTO mm_matches (id, listing_id, interest_id, buyer_id, seller_id, username)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(matchId, id, mb.interestId ?? null, mb.buyerId, context.senderId, clean);
    }

    // Update match count
    if (matchedBuyers.length > 0) {
      context.db
        .prepare(`UPDATE mm_listings SET match_count = ? WHERE id = ?`)
        .run(matchedBuyers.length, id);
    }

    const priceText = asking_price ? `${asking_price} TON` : "Offers welcome";
    const matchText =
      matchedBuyers.length > 0
        ? `\n\n🎯 ${matchedBuyers.length} potential buyer${matchedBuyers.length !== 1 ? "s" : ""} found! They'll be notified.`
        : "\n\nNo matching buyers yet — they'll be notified when they register interest.";

    return {
      success: true,
      data: {
        listingId: id,
        username: clean,
        categories,
        askingPrice: priceText,
        estimatedValue: valuation.estimated,
        matchedBuyers: matchedBuyers.length,
        expiresAt,
        // Notify matching buyers — don't reveal seller identity
        _notifyBuyers: matchedBuyers.map((m) => ({
          userId: m.buyerId,
          message:
            `🔔 New listing matching your interests!\n\n` +
            `${clean} — ${priceText}\n` +
            (chineseMeaning.hasMeaning ? `🇨🇳 ${chineseMeaning.summary}\n` : "") +
            `Est. value: ${valuation.estimated.low}–${valuation.estimated.high} TON\n` +
            `Categories: ${categories.join(", ")}\n\n` +
            `Interested? Use the matchmaker to express interest — the seller will be notified and can reach out to you directly.`,
        })),
        chineseMeaning: chineseMeaning.hasMeaning ? chineseMeaning : undefined,
        message:
          `✅ Listed ${clean} for sale!\n\n` +
          `Price: ${priceText}\n` +
          (chineseMeaning.hasMeaning ? `🇨🇳 Chinese meaning: ${chineseMeaning.summary}\n` : "") +
          `Est. value: ${valuation.estimated.low}–${valuation.estimated.high} TON\n` +
          `Categories: ${categories.join(", ")}\n` +
          `Expires: ${new Date(expiresAt).toLocaleDateString()}` +
          matchText,
      },
    };
  } catch (error) {
    log.error({ err: error }, "List username error");
    return { success: false, error: String(error) };
  }
};

// ─── Register Buying Interest ────────────────────────────────────────

interface RegisterInterestParams {
  categories: string[];
  max_price?: number;
  currency?: string;
  keywords?: string;
}

export const mmInterestTool: Tool = {
  name: "mm_set_interest",
  description:
    "🔗 Register your buying interest: which username categories you're looking for. " +
    "When a matching username is listed, you'll be notified via DM. " +
    "Categories: short, medium, long, numeric, crypto, gaming, business, brand, emoji, premium. " +
    "Requires holding 0.1% $TELECLAW supply.",
  category: "action",
  parameters: Type.Object({
    categories: Type.Array(
      Type.String({
        enum: [
          "ultra_short",
          "short",
          "medium",
          "standard",
          "numeric",
          "repeating",
          "palindrome",
          "crypto",
          "finance",
          "gaming",
          "tech",
          "social",
          "business",
          "lifestyle",
          "media",
          "premium",
          "brandable",
          "emoji_name",
          "country",
          "name",
          "ton_related",
          "meme",
          "chinese",
        ],
      }),
      {
        description: "Categories you're interested in (e.g. crypto, short, gaming, premium)",
        minItems: 1,
      }
    ),
    max_price: Type.Optional(
      Type.Number({ description: "Maximum you're willing to pay", minimum: 0 })
    ),
    currency: Type.Optional(
      Type.String({
        description:
          "Price currency: TON or USDT (default: TON). Only listings in this currency will match.",
      })
    ),
    keywords: Type.Optional(
      Type.String({ description: "Specific keywords (comma-separated, e.g. 'wallet,pay,bank')" })
    ),
  }),
};

export const mmInterestExecutor: ToolExecutor<RegisterInterestParams> = async (
  params,
  context
): Promise<ToolResult> => {
  try {
    ensureMatchmakerTables(context);
    const { categories, max_price, currency = "TON", keywords } = params;

    // 🔒 Token Gate: verify $TELECLAW holdings
    // 🤝 OTC Consent check
    const consentError = requireOtcConsent(context);
    if (consentError) return consentError;
    const gateResult = await checkTokenGate(context.db, context.senderId);
    if (!gateResult.allowed) {
      return { success: false, error: gateResult.reason };
    }

    // Deactivate previous interests from this user
    context.db
      .prepare(`UPDATE mm_interests SET active = 0 WHERE buyer_id = ?`)
      .run(context.senderId);

    const id = generateId("int");
    context.db
      .prepare(
        `INSERT INTO mm_interests (id, buyer_id, buyer_username, categories, max_price, currency, keywords)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        context.senderId,
        null,
        JSON.stringify(categories),
        max_price ?? null,
        currency.toUpperCase(),
        keywords ?? null
      );

    // Check existing active listings that match
    const listings = context.db
      .prepare(`SELECT * FROM mm_listings WHERE status = 'active' AND expires_at > datetime('now')`)
      .all() as Array<{
      id: string;
      seller_id: number;
      username: string;
      asking_price: number | null;
      categories: string;
      estimated_value: number | null;
    }>;

    const existingMatches: string[] = [];
    for (const listing of listings) {
      if (listing.seller_id === context.senderId) continue;

      const listingCats: string[] = JSON.parse(listing.categories);
      const overlap = categories.filter((c) => listingCats.includes(c));
      if (overlap.length === 0) continue;
      if (max_price && listing.asking_price) {
        const listingCur = ((listing as Record<string, unknown>).currency as string) || "TON";
        const canAfford = await priceMatches(listing.asking_price, listingCur, max_price, currency);
        if (canAfford === false) continue;
      }

      existingMatches.push(
        `${listing.username} — ${listing.asking_price ? listing.asking_price + " TON" : "offers welcome"}`
      );
    }

    const matchText =
      existingMatches.length > 0
        ? `\n\n📋 ${existingMatches.length} existing listing${existingMatches.length !== 1 ? "s" : ""} match:\n` +
          existingMatches
            .slice(0, 10)
            .map((m, i) => `  ${i + 1}. ${m}`)
            .join("\n") +
          "\n\nUse mm_express_interest to signal interest in any listing."
        : "\n\nNo current listings match — you'll be notified when one appears.";

    return {
      success: true,
      data: {
        interestId: id,
        categories,
        maxPrice: max_price ? `${max_price} TON` : "no limit",
        keywords: keywords ?? "none",
        existingMatches: existingMatches.length,
        message:
          `✅ Buying interest registered!\n\n` +
          `Categories: ${categories.join(", ")}\n` +
          `Max price: ${max_price ? max_price + " TON" : "no limit"}\n` +
          `Keywords: ${keywords || "any"}` +
          matchText,
      },
    };
  } catch (error) {
    log.error({ err: error }, "Register interest error");
    return { success: false, error: String(error) };
  }
};

// ─── Express Interest in a Listing ───────────────────────────────────

interface ExpressInterestParams {
  listing_id?: string;
  username?: string;
}

export const mmExpressInterestTool: Tool = {
  name: "mm_express_interest",
  description:
    "Signal that you're interested in buying a listed username. " +
    "The seller will be notified that you're interested and can DM you to arrange the trade.",
  category: "action",
  parameters: Type.Object({
    listing_id: Type.Optional(Type.String({ description: "Listing ID (full or last 8 chars)" })),
    username: Type.Optional(Type.String({ description: "Or specify the username directly" })),
  }),
};

export const mmExpressInterestExecutor: ToolExecutor<ExpressInterestParams> = async (
  params,
  context
): Promise<ToolResult> => {
  try {
    ensureMatchmakerTables(context);
    const { listing_id, username } = params;

    // 🔒 Token Gate: verify $TELECLAW holdings
    // 🤝 OTC Consent check
    const consentError = requireOtcConsent(context);
    if (consentError) return consentError;
    const gateResult = await checkTokenGate(context.db, context.senderId);
    if (!gateResult.allowed) {
      return { success: false, error: gateResult.reason };
    }

    if (!listing_id && !username) {
      return { success: false, error: "Provide either listing_id or username." };
    }

    let listing;
    if (listing_id) {
      listing = context.db
        .prepare(`SELECT * FROM mm_listings WHERE (id = ? OR id LIKE ?) AND status = 'active'`)
        .get(listing_id, `%${listing_id}`) as Record<string, unknown> | undefined;
    } else if (username) {
      const clean = `@${username.replace(/^@/, "").toLowerCase()}`;
      listing = context.db
        .prepare(
          `SELECT * FROM mm_listings WHERE username = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1`
        )
        .get(clean) as Record<string, unknown> | undefined;
    }

    if (!listing) {
      return { success: false, error: "No active listing found." };
    }

    if ((listing.seller_id as number) === context.senderId) {
      return { success: false, error: "You can't express interest in your own listing." };
    }

    // Record the match
    const matchId = generateId("mtch");
    context.db
      .prepare(
        `INSERT INTO mm_matches (id, listing_id, buyer_id, seller_id, username)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(matchId, listing.id, context.senderId, listing.seller_id, listing.username);

    // Update match count
    context.db
      .prepare(`UPDATE mm_listings SET match_count = match_count + 1 WHERE id = ?`)
      .run(listing.id);

    const priceText = listing.asking_price ? `${listing.asking_price} TON` : "offers welcome";

    // Get buyer's username from context for seller notification
    const buyerUsername = context.senderUsername ? `@${context.senderUsername}` : null;
    const buyerLabel = buyerUsername || `User #${context.senderId}`;

    return {
      success: true,
      data: {
        matchId,
        username: listing.username,
        sellerId: listing.seller_id,
        // Notify seller WITH buyer's username — seller decides whether to reach out
        _notifySeller: {
          userId: listing.seller_id as number,
          message:
            `🔔 A buyer is interested in your listing!\n\n` +
            `📦 ${listing.username} (${priceText})\n` +
            `👤 Buyer: ${buyerLabel}\n\n` +
            `You can reach out to them directly if you'd like to proceed. The next step is yours.`,
        },
        // Buyer does NOT get seller's identity — seller contacts them
        message:
          `✅ Interest expressed!\n\n` +
          `${listing.username} — ${priceText}\n\n` +
          `The seller has been notified and received your username. ` +
          `If they're interested in proceeding, they'll reach out to you directly via DM. ` +
          `No further action needed from your side — just wait for the seller.`,
      },
    };
  } catch (error) {
    log.error({ err: error }, "Express interest error");
    return { success: false, error: String(error) };
  }
};

// ─── Browse Active Listings ──────────────────────────────────────────

interface BrowseListingsParams {
  category?: string;
  max_price?: number;
  sort?: string;
  limit?: number;
}

export const mmBrowseTool: Tool = {
  name: "mm_browse",
  description:
    "Browse active username listings on the Teleclaw matchmaker. " +
    "Filter by category, max price, and sort order.",
  category: "data-bearing",
  parameters: Type.Object({
    category: Type.Optional(
      Type.String({
        description: "Filter by category",
        enum: [
          "ultra_short",
          "short",
          "medium",
          "standard",
          "numeric",
          "repeating",
          "palindrome",
          "crypto",
          "finance",
          "gaming",
          "tech",
          "social",
          "business",
          "lifestyle",
          "media",
          "premium",
          "brandable",
          "emoji_name",
          "country",
          "name",
          "ton_related",
          "meme",
          "chinese",
        ],
      })
    ),
    max_price: Type.Optional(Type.Number({ description: "Max price in TON", minimum: 0 })),
    sort: Type.Optional(
      Type.String({
        description: "Sort: newest, cheapest, popular (most interest)",
        enum: ["newest", "cheapest", "popular"],
      })
    ),
    limit: Type.Optional(
      Type.Number({ description: "Max results (default: 20)", minimum: 1, maximum: 50 })
    ),
  }),
};

export const mmBrowseExecutor: ToolExecutor<BrowseListingsParams> = async (
  params,
  context
): Promise<ToolResult> => {
  try {
    ensureMatchmakerTables(context);
    const { category, max_price, sort = "newest", limit = 20 } = params;

    let query = `SELECT * FROM mm_listings WHERE status = 'active' AND expires_at > datetime('now')`;
    const queryParams: unknown[] = [];

    if (max_price !== undefined) {
      query += ` AND (asking_price IS NULL OR asking_price <= ?)`;
      queryParams.push(max_price);
    }

    const orderBy =
      sort === "cheapest"
        ? "asking_price ASC NULLS LAST"
        : sort === "popular"
          ? "match_count DESC"
          : "created_at DESC";
    query += ` ORDER BY ${orderBy} LIMIT ?`;
    queryParams.push(limit);

    let listings = context.db.prepare(query).all(...queryParams) as Array<{
      id: string;
      username: string;
      asking_price: number | null;
      categories: string;
      estimated_value: number | null;
      match_count: number;
      created_at: string;
    }>;

    // Filter by category in JS (categories stored as JSON array)
    if (category) {
      listings = listings.filter((l) => {
        const cats: string[] = JSON.parse(l.categories);
        return cats.includes(category);
      });
    }

    if (listings.length === 0) {
      return {
        success: true,
        data: { listings: [], message: "No active listings found matching your criteria." },
      };
    }

    const text = listings
      .map((l, i) => {
        const cats: string[] = JSON.parse(l.categories);
        const price = l.asking_price ? `${l.asking_price} TON` : "offers welcome";
        const est = l.estimated_value ? ` (est. ~${Math.round(l.estimated_value)} TON)` : "";
        const interest = l.match_count > 0 ? ` 🔥 ${l.match_count} interested` : "";
        return `${i + 1}. ${l.username} — ${price}${est}${interest}\n   ${cats.join(", ")} | ID: ${l.id.slice(-8)}`;
      })
      .join("\n\n");

    return {
      success: true,
      data: {
        count: listings.length,
        listings,
        message: `🏪 Active Listings (${listings.length}):\n\n${text}\n\nUse mm_express_interest to signal interest in any listing.`,
      },
    };
  } catch (error) {
    log.error({ err: error }, "Browse listings error");
    return { success: false, error: String(error) };
  }
};

// ─── My Listings ─────────────────────────────────────────────────────

export const mmMyListingsTool: Tool = {
  name: "mm_my_listings",
  description: "View your active username listings and how many buyers are interested.",
  category: "data-bearing",
  parameters: Type.Object({}),
};

export const mmMyListingsExecutor: ToolExecutor<Record<string, never>> = async (
  _params,
  context
): Promise<ToolResult> => {
  try {
    ensureMatchmakerTables(context);

    const listings = context.db
      .prepare(
        `SELECT * FROM mm_listings WHERE seller_id = ? AND status IN ('active', 'matched')
         ORDER BY created_at DESC`
      )
      .all(context.senderId) as Array<{
      id: string;
      username: string;
      asking_price: number | null;
      match_count: number;
      created_at: string;
      expires_at: string;
      status: string;
    }>;

    if (listings.length === 0) {
      return {
        success: true,
        data: { message: "No active listings. Use mm_list_username to list a username for sale." },
      };
    }

    const text = listings
      .map((l, i) => {
        const price = l.asking_price ? `${l.asking_price} TON` : "offers welcome";
        const interest = l.match_count > 0 ? `🔥 ${l.match_count} interested` : "no interest yet";
        return `${i + 1}. ${l.username} — ${price} | ${interest}\n   Listed: ${new Date(l.created_at).toLocaleDateString()} | Expires: ${new Date(l.expires_at).toLocaleDateString()}`;
      })
      .join("\n\n");

    return {
      success: true,
      data: {
        count: listings.length,
        listings,
        message: `📋 Your Listings (${listings.length}):\n\n${text}`,
      },
    };
  } catch (error) {
    log.error({ err: error }, "My listings error");
    return { success: false, error: String(error) };
  }
};

// ─── Cancel Listing ──────────────────────────────────────────────────

interface CancelListingParams {
  listing_id?: string;
  username?: string;
}

export const mmCancelTool: Tool = {
  name: "mm_cancel_listing",
  description: "Cancel one of your active username listings.",
  category: "action",
  parameters: Type.Object({
    listing_id: Type.Optional(Type.String({ description: "Listing ID (full or last 8 chars)" })),
    username: Type.Optional(Type.String({ description: "Or specify the username" })),
  }),
};

export const mmCancelExecutor: ToolExecutor<CancelListingParams> = async (
  params,
  context
): Promise<ToolResult> => {
  try {
    ensureMatchmakerTables(context);
    const { listing_id, username } = params;

    if (!listing_id && !username) {
      return { success: false, error: "Provide listing_id or username." };
    }

    let result;
    if (listing_id) {
      result = context.db
        .prepare(
          `UPDATE mm_listings SET status = 'cancelled'
           WHERE (id = ? OR id LIKE ?) AND seller_id = ? AND status = 'active'`
        )
        .run(listing_id, `%${listing_id}`, context.senderId);
    } else {
      const clean = `@${(username ?? "").replace(/^@/, "").toLowerCase()}`;
      result = context.db
        .prepare(
          `UPDATE mm_listings SET status = 'cancelled'
           WHERE username = ? AND seller_id = ? AND status = 'active'`
        )
        .run(clean, context.senderId);
    }

    if (result.changes === 0) {
      return { success: false, error: "No matching active listing found." };
    }

    return {
      success: true,
      data: { message: "✅ Listing cancelled." },
    };
  } catch (error) {
    log.error({ err: error }, "Cancel listing error");
    return { success: false, error: String(error) };
  }
};

// ─── Mark Username as Sold ───────────────────────────────────────────

interface SoldParams {
  listing_id?: string;
  username?: string;
}

export const mmSoldTool: Tool = {
  name: "mm_sold_username",
  description:
    "✅ Mark a username listing as SOLD after completing the trade.\n\n" +
    "This closes the listing and notifies interested buyers that it's no longer available. " +
    "Only the seller can mark a listing as sold.",
  category: "action",
  parameters: Type.Object({
    listing_id: Type.Optional(Type.String({ description: "Listing ID" })),
    username: Type.Optional(Type.String({ description: "Or specify the username" })),
  }),
};

export const mmSoldExecutor: ToolExecutor<SoldParams> = async (
  params,
  context
): Promise<ToolResult> => {
  try {
    ensureMatchmakerTables(context);
    const { listing_id, username } = params;

    if (!listing_id && !username) {
      return { success: false, error: "Provide listing_id or username." };
    }

    let listing;
    if (listing_id) {
      listing = context.db
        .prepare(
          `SELECT * FROM mm_listings WHERE (id = ? OR id LIKE ?) AND seller_id = ? AND status = 'active'`
        )
        .get(listing_id, `%${listing_id}`, context.senderId) as Record<string, unknown> | undefined;
    } else {
      const clean = `@${(username ?? "").replace(/^@/, "").toLowerCase()}`;
      listing = context.db
        .prepare(
          `SELECT * FROM mm_listings WHERE username = ? AND seller_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1`
        )
        .get(clean, context.senderId) as Record<string, unknown> | undefined;
    }

    if (!listing) {
      return { success: false, error: "No matching active listing found." };
    }

    context.db
      .prepare(`UPDATE mm_listings SET status = 'sold', sold_at = datetime('now') WHERE id = ?`)
      .run(listing.id);

    // Get interested buyers to notify
    const interestedBuyers = context.db
      .prepare(`SELECT DISTINCT buyer_id FROM mm_matches WHERE listing_id = ?`)
      .all(listing.id as string) as Array<{ buyer_id: number }>;

    return {
      success: true,
      data: {
        listingId: listing.id,
        username: listing.username,
        status: "sold",
        buyersToNotify: interestedBuyers.length,
        buyerIds: interestedBuyers.map((b) => b.buyer_id),
        _notifyBuyers: interestedBuyers
          .filter((b) => b.buyer_id !== context.senderId)
          .map((b) => ({
            userId: b.buyer_id,
            message:
              `ℹ️ A username you were interested in has been sold.\n\n` +
              `🔗 ${listing.username}\n\n` +
              `Keep browsing — new usernames are listed regularly!`,
          })),
        message: `✅ ${listing.username} marked as sold! ${interestedBuyers.length} interested buyer(s) will be notified.`,
      },
    };
  } catch (error) {
    log.error({ err: error }, "Mark sold error");
    return { success: false, error: String(error) };
  }
};

// ─── Stale Listing Check ────────────────────────────────────────────

/**
 * Returns username listings active 48+ hours with matches but no update.
 * Agent should remind sellers to update status.
 */
export function getStaleUsernameListings(ctx: ToolContext): Array<Record<string, unknown>> {
  ensureMatchmakerTables(ctx);
  return ctx.db
    .prepare(
      `SELECT * FROM mm_listings
       WHERE status = 'active'
       AND match_count > 0
       AND created_at < datetime('now', '-48 hours')
       AND (last_reminder_at IS NULL OR last_reminder_at < datetime('now', '-24 hours'))`
    )
    .all() as Array<Record<string, unknown>>;
}

export function markUsernameListingReminded(ctx: ToolContext, listingId: string): void {
  ctx.db
    .prepare(`UPDATE mm_listings SET last_reminder_at = datetime('now') WHERE id = ?`)
    .run(listingId);
}
