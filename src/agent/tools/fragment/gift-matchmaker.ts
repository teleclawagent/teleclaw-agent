/**
 * 🎁 Gift Matchmaker — Connect gift buyers and sellers.
 *
 * Same pattern as username/number matchmaker:
 * - Teleclaw = matchmaker ONLY. Does NOT handle trades.
 * - Seller lists gift → Teleclaw calculates rarity → notifies matching buyers.
 * - Buyer registers interest → gets notified when matching gifts are listed.
 * - Both parties handle the trade themselves (Telegram marketplace, Tonnel, Portals, etc.)
 *
 * Requires holding 0.1% $TELECLAW supply (token gate).
 */

import { Type } from "@sinclair/typebox";
import type { Tool, ToolExecutor, ToolResult, ToolContext } from "../types.js";
import { getCollection, calculateRarityScore, searchCollections } from "./gifts-service.js";
import { checkTokenGate } from "./token-gate.js";
import { createLogger } from "../../../utils/logger.js";
import { priceMatches } from "../../../ton/price-service.js";

const log = createLogger("GiftMatchmaker");

// ─── DB Schema ───────────────────────────────────────────────────────

function ensureGiftMatchmakerTables(ctx: ToolContext): void {
  ctx.db.exec(`
    CREATE TABLE IF NOT EXISTS gift_listings (
      id TEXT PRIMARY KEY,
      seller_id INTEGER NOT NULL,
      seller_username TEXT,
      collection TEXT NOT NULL,
      gift_num INTEGER,
      model TEXT,
      model_rarity REAL,
      backdrop TEXT,
      backdrop_rarity REAL,
      symbol TEXT,
      symbol_rarity REAL,
      combined_rarity REAL,
      rarity_tier TEXT,
      asking_price REAL,
      currency TEXT NOT NULL DEFAULT 'TON',
      description TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'matched', 'expired', 'cancelled', 'sold')),
      match_count INTEGER NOT NULL DEFAULT 0,
      sold_at TEXT,
      last_reminder_at TEXT
    );

    CREATE TABLE IF NOT EXISTS gift_interests (
      id TEXT PRIMARY KEY,
      buyer_id INTEGER NOT NULL,
      buyer_username TEXT,
      collection TEXT,
      model TEXT,
      backdrop TEXT,
      symbol TEXT,
      max_rarity_permille INTEGER,
      max_price REAL,
      currency TEXT NOT NULL DEFAULT 'TON',
      min_tier TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS gift_matches (
      id TEXT PRIMARY KEY,
      listing_id TEXT NOT NULL,
      interest_id TEXT,
      buyer_id INTEGER NOT NULL,
      seller_id INTEGER NOT NULL,
      collection TEXT NOT NULL,
      gift_num INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      buyer_notified INTEGER NOT NULL DEFAULT 0,
      seller_notified INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (listing_id) REFERENCES gift_listings(id)
    );

    CREATE INDEX IF NOT EXISTS idx_gift_listings_status ON gift_listings(status);
    CREATE INDEX IF NOT EXISTS idx_gift_listings_collection ON gift_listings(collection);
    CREATE INDEX IF NOT EXISTS idx_gift_interests_active ON gift_interests(active);
    CREATE INDEX IF NOT EXISTS idx_gift_matches_buyer ON gift_matches(buyer_id);
    CREATE INDEX IF NOT EXISTS idx_gift_matches_seller ON gift_matches(seller_id);
  `);
}

function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

const TIER_RANK: Record<string, number> = {
  Legendary: 1,
  Epic: 2,
  Rare: 3,
  Uncommon: 4,
  Common: 5,
};

// ─── List Gift for Sale ──────────────────────────────────────────────

interface GiftListParams {
  collection: string;
  gift_num?: number;
  model: string;
  backdrop: string;
  symbol: string;
  asking_price?: number;
  currency?: string;
  description?: string;
  expires_days?: number;
}

export const giftMmListTool: Tool = {
  name: "gift_mm_list",
  description:
    "🎁 List a Telegram gift for sale on the Teleclaw OTC matchmaker.\n\n" +
    "HOW IT WORKS FOR SELLERS:\n" +
    "1. You list your gift with collection name, model, backdrop, symbol\n" +
    "2. Teleclaw auto-calculates rarity (Legendary/Epic/Rare/Uncommon/Common)\n" +
    "3. Buyers who registered interest in matching gifts get notified instantly\n" +
    "4. When a buyer is interested, you get their offer + contact\n" +
    "5. You handle the trade yourself — Teleclaw only connects, never touches funds\n\n" +
    "TIP: Include gift_num (e.g. #1847) so buyers can verify on Fragment/Telegram.\n" +
    "Requires 0.1% $TELECLAW.",
  category: "action",
  parameters: Type.Object({
    collection: Type.String({ description: "Gift collection (e.g. 'Plush Pepe')" }),
    gift_num: Type.Optional(Type.Number({ description: "Gift number (e.g. 1847)" })),
    model: Type.String({ description: "Model name (e.g. 'Ninja Mike')" }),
    backdrop: Type.String({ description: "Backdrop name (e.g. 'Onyx Black')" }),
    symbol: Type.String({ description: "Symbol name (e.g. 'Illuminati')" }),
    asking_price: Type.Optional(
      Type.Number({ description: "Asking price (optional — 'offers welcome')", minimum: 0 })
    ),
    currency: Type.Optional(
      Type.String({ description: "Currency: TON, Stars, USDT (default: TON)" })
    ),
    description: Type.Optional(
      Type.String({ description: "Notes (e.g. 'Quick sale, open to offers')" })
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

export const giftMmListExecutor: ToolExecutor<GiftListParams> = async (
  params,
  context
): Promise<ToolResult> => {
  try {
    ensureGiftMatchmakerTables(context);

    // Token gate
    const gate = await checkTokenGate(context.db, context.senderId);
    if (!gate.allowed) return { success: false, error: gate.reason };

    const {
      collection,
      gift_num,
      model,
      backdrop,
      symbol,
      asking_price,
      currency = "TON",
      description,
      expires_days = 14,
    } = params;

    // Validate collection exists
    const col = getCollection(collection);
    if (!col) {
      const suggestions = searchCollections(collection);
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

    // Calculate rarity
    const rarity = calculateRarityScore(collection, model, backdrop, symbol);
    if (!rarity) {
      return {
        success: false,
        error: `Could not verify traits. Check model/backdrop/symbol names for "${collection}".`,
      };
    }

    const id = generateId("glst");
    const expiresAt = new Date(Date.now() + expires_days * 86400000).toISOString();

    context.db
      .prepare(
        `INSERT INTO gift_listings
         (id, seller_id, seller_username, collection, gift_num, model, model_rarity, backdrop, backdrop_rarity, symbol, symbol_rarity, combined_rarity, rarity_tier, asking_price, currency, description, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        context.senderId,
        context.senderUsername || null,
        col.name,
        gift_num ?? null,
        model,
        rarity.modelRarity,
        backdrop,
        rarity.backdropRarity,
        symbol,
        rarity.symbolRarity,
        rarity.combinedPermille,
        rarity.rarityTier,
        asking_price ?? null,
        currency,
        description ?? null,
        expiresAt
      );

    // Find matching buyers
    const interests = context.db
      .prepare(`SELECT * FROM gift_interests WHERE active = 1`)
      .all() as GiftInterestRow[];

    const matches: Array<{ buyerId: number; interestId: string; reason: string }> = [];

    for (const interest of interests) {
      if (interest.buyer_id === context.senderId) continue;

      // Collection match
      if (interest.collection && interest.collection.toLowerCase() !== col.name.toLowerCase())
        continue;

      // Model match
      if (interest.model && interest.model.toLowerCase() !== model.toLowerCase()) continue;

      // Backdrop match
      if (interest.backdrop && interest.backdrop.toLowerCase() !== backdrop.toLowerCase()) continue;

      // Symbol match
      if (interest.symbol && interest.symbol.toLowerCase() !== symbol.toLowerCase()) continue;

      // Price + currency check
      if (interest.max_price && asking_price) {
        // Only compare prices if currencies match (or buyer didn't specify currency)
        // Cross-currency price check (TON vs USDT normalized via live price)
        const interestCurrency = (interest.currency || "TON").toUpperCase();
        const listingCurrency = currency.toUpperCase();
        const canAfford = await priceMatches(
          asking_price,
          listingCurrency,
          interest.max_price,
          interestCurrency
        );
        if (canAfford === false) continue;
      }

      // Rarity check
      if (interest.max_rarity_permille && rarity.combinedPermille > interest.max_rarity_permille)
        continue;

      // Tier check
      if (interest.min_tier) {
        const buyerTierRank = TIER_RANK[interest.min_tier] ?? 5;
        const listingTierRank = TIER_RANK[rarity.rarityTier] ?? 5;
        if (listingTierRank > buyerTierRank) continue;
      }

      const reasons: string[] = [];
      if (interest.collection) reasons.push(`collection: ${interest.collection}`);
      if (interest.model) reasons.push(`model: ${interest.model}`);
      if (interest.min_tier) reasons.push(`tier ≥ ${interest.min_tier}`);
      if (!interest.collection && !interest.model) reasons.push("open buyer");

      matches.push({
        buyerId: interest.buyer_id,
        interestId: interest.id,
        reason: reasons.join(", "),
      });

      // Save match
      context.db
        .prepare(
          `INSERT INTO gift_matches (id, listing_id, interest_id, buyer_id, seller_id, collection, gift_num)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          generateId("gmtch"),
          id,
          interest.id,
          interest.buyer_id,
          context.senderId,
          col.name,
          gift_num ?? null
        );
    }

    // Update match count
    if (matches.length > 0) {
      context.db
        .prepare(`UPDATE gift_listings SET match_count = ? WHERE id = ?`)
        .run(matches.length, id);
    }

    return {
      success: true,
      data: {
        listingId: id,
        collection: col.name,
        giftNum: gift_num,
        model: { name: model, rarity: `${rarity.modelRarity / 10}%` },
        backdrop: { name: backdrop, rarity: `${rarity.backdropRarity / 10}%` },
        symbol: { name: symbol, rarity: `${rarity.symbolRarity / 10}%` },
        combinedRarity: `${(rarity.combinedPermille / 10).toFixed(1)}%`,
        tier: rarity.rarityTier,
        askingPrice: asking_price ? `${asking_price} ${currency}` : "Offers welcome",
        expiresAt,
        matchedBuyers: matches.length,
        matches: matches.map((m) => ({
          buyerId: m.buyerId,
          reason: m.reason,
        })),
        _notifyBuyers: matches.map((m) => ({
          userId: m.buyerId,
          message:
            `🔔 New gift listing matching your interest!\n\n` +
            `🎁 ${col.name}${gift_num ? ` #${gift_num}` : ""}\n` +
            `Model: ${model} (${rarity.modelRarity / 10}%)\n` +
            `Backdrop: ${backdrop} (${rarity.backdropRarity / 10}%)\n` +
            `Symbol: ${symbol} (${rarity.symbolRarity / 10}%)\n` +
            `Tier: ${rarity.rarityTier}\n` +
            `Price: ${asking_price ? `${asking_price} ${currency}` : "Offers welcome"}\n\n` +
            `Interested? Use the gift matchmaker to express interest.`,
        })),
        note: "Teleclaw is a matchmaker only. Handle the trade yourself via any marketplace or direct transfer.",
      },
    };
  } catch (err: unknown) {
    log.error({ err }, "Error listing gift");
    return { success: false, error: `Failed: ${err instanceof Error ? err.message : String(err)}` };
  }
};

// ─── Register Interest (Buyer) ───────────────────────────────────────

interface GiftInterestParams {
  collection?: string;
  model?: string;
  backdrop?: string;
  symbol?: string;
  max_price?: number;
  currency?: string;
  min_tier?: string;
}

export const giftMmInterestTool: Tool = {
  name: "gift_mm_interest",
  description:
    "🎁 Register buying interest for gifts — get notified ONLY when YOUR exact criteria are met.\n\n" +
    "HOW IT WORKS FOR BUYERS:\n" +
    "1. Tell me exactly what you want — as broad or specific as you like\n" +
    "2. You'll ONLY get notified when a gift matching ALL your filters is listed\n" +
    "3. No spam — if you say 'Plush Pepe + black backdrop', you won't hear about other backdrops\n\n" +
    "FILTER EXAMPLES (all optional, combine freely):\n" +
    "• Just collection: 'Plush Pepe' → any Plush Pepe listed = notification\n" +
    "• Collection + model: 'Plush Pepe, Ninja Mike' → only this model\n" +
    "• Collection + backdrop: 'Plush Pepe, Onyx Black background' → any model with this backdrop\n" +
    "• Collection + model + backdrop + symbol: full exact match only\n" +
    "• Max price + currency: 'max 50 TON' or 'max 200 USDT' → only listings in your currency & budget\n" +
    "• No price filter: get notified about ALL matching gifts regardless of price\n" +
    "• Min tier: 'Epic or better' → only rare gifts\n\n" +
    "The more filters you set, the more precise your notifications. Unset filters = 'any is fine'.\n" +
    "Price filtering is currency-aware: TON prices only match TON listings, USDT only matches USDT.\n" +
    "Requires 0.1% $TELECLAW.",
  category: "action",
  parameters: Type.Object({
    collection: Type.Optional(Type.String({ description: "Collection name (e.g. 'Plush Pepe')" })),
    model: Type.Optional(Type.String({ description: "Specific model wanted (e.g. 'Ninja Mike')" })),
    backdrop: Type.Optional(Type.String({ description: "Specific backdrop wanted" })),
    symbol: Type.Optional(Type.String({ description: "Specific symbol wanted" })),
    max_price: Type.Optional(
      Type.Number({ description: "Maximum price willing to pay", minimum: 0 })
    ),
    currency: Type.Optional(
      Type.String({ description: "Currency: TON, Stars, USDT (default: TON)" })
    ),
    min_tier: Type.Optional(
      Type.String({ description: "Minimum rarity tier: Legendary, Epic, Rare, Uncommon, Common" })
    ),
  }),
};

export const giftMmInterestExecutor: ToolExecutor<GiftInterestParams> = async (
  params,
  context
): Promise<ToolResult> => {
  try {
    ensureGiftMatchmakerTables(context);

    const gate = await checkTokenGate(context.db, context.senderId);
    if (!gate.allowed) return { success: false, error: gate.reason };

    const { collection, model, backdrop, symbol, max_price, currency = "TON", min_tier } = params;

    // Validate collection if specified
    if (collection && !getCollection(collection)) {
      const suggestions = searchCollections(collection);
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

    // Validate tier
    if (min_tier && !TIER_RANK[min_tier]) {
      return {
        success: false,
        error: `Invalid tier "${min_tier}". Valid: Legendary, Epic, Rare, Uncommon, Common`,
      };
    }

    const id = generateId("gint");

    context.db
      .prepare(
        `INSERT INTO gift_interests
         (id, buyer_id, buyer_username, collection, model, backdrop, symbol, max_rarity_permille, max_price, currency, min_tier)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        context.senderId,
        context.senderUsername || null,
        collection || null,
        model || null,
        backdrop || null,
        symbol || null,
        null, // max_rarity_permille calculated from min_tier if needed
        max_price ?? null,
        currency,
        min_tier || null
      );

    // Check existing active listings for immediate matches
    let query = `SELECT * FROM gift_listings WHERE status = 'active'`;
    const conditions: string[] = [];
    const queryParams: unknown[] = [];
    if (collection) {
      conditions.push(`LOWER(collection) = LOWER(?)`);
      queryParams.push(collection);
    }
    if (model) {
      conditions.push(`LOWER(model) = LOWER(?)`);
      queryParams.push(model);
    }
    if (backdrop) {
      conditions.push(`LOWER(backdrop) = LOWER(?)`);
      queryParams.push(backdrop);
    }
    if (symbol) {
      conditions.push(`LOWER(symbol) = LOWER(?)`);
      queryParams.push(symbol);
    }
    // Price filtering done post-query with cross-currency support
    if (min_tier) {
      const tierRank = TIER_RANK[min_tier];
      const validTiers = Object.entries(TIER_RANK)
        .filter(([, r]) => r <= tierRank)
        .map(([t]) => t);
      conditions.push(`rarity_tier IN (${validTiers.map(() => "?").join(",")})`);
      queryParams.push(...validTiers);
    }
    if (conditions.length > 0) query += ` AND ${conditions.join(" AND ")}`;

    const existingListings = context.db.prepare(query).all(...queryParams) as GiftListingRow[];
    // Cross-currency price filter
    const priceFiltered: GiftListingRow[] = [];
    for (const l of existingListings) {
      if (l.seller_id === context.senderId) continue;
      if (max_price && l.asking_price) {
        const canAfford = await priceMatches(l.asking_price, l.currency, max_price, currency);
        if (canAfford === false) continue;
      }
      priceFiltered.push(l);
    }
    const immediateMatches = priceFiltered.slice(0, 10);

    return {
      success: true,
      data: {
        interestId: id,
        filters: {
          collection: collection || "any",
          model: model || "any",
          backdrop: backdrop || "any",
          symbol: symbol || "any",
          maxPrice: max_price ? `${max_price} ${currency}` : "any",
          minTier: min_tier || "any",
        },
        existingMatches: immediateMatches.length,
        matches: immediateMatches.map((l) => ({
          collection: l.collection,
          giftNum: l.gift_num,
          model: l.model,
          backdrop: l.backdrop,
          symbol: l.symbol,
          tier: l.rarity_tier,
          askingPrice: l.asking_price ? `${l.asking_price} ${l.currency}` : "Offers welcome",
          sellerId: l.seller_id,
        })),
        note: "You'll be notified when new matching gifts are listed.",
      },
    };
  } catch (err: unknown) {
    log.error({ err }, "Error registering gift interest");
    return { success: false, error: `Failed: ${err instanceof Error ? err.message : String(err)}` };
  }
};

// ─── Browse Gift Listings ────────────────────────────────────────────

interface GiftBrowseParams {
  collection?: string;
  min_tier?: string;
  max_price?: number;
  limit?: number;
}

export const giftMmBrowseTool: Tool = {
  name: "gift_mm_browse",
  description:
    "🎁 Browse active gift listings on the Teleclaw OTC matchmaker. " +
    "See what's available before registering interest. Filter by collection, rarity tier, or max price. " +
    "To make an offer on a listing, use gift_mm_express with the listing ID.",
  category: "data-bearing",
  parameters: Type.Object({
    collection: Type.Optional(Type.String({ description: "Filter by collection" })),
    min_tier: Type.Optional(
      Type.String({ description: "Minimum tier: Legendary, Epic, Rare, Uncommon" })
    ),
    max_price: Type.Optional(Type.Number({ description: "Maximum price" })),
    limit: Type.Optional(
      Type.Number({ description: "Max results (default 15)", minimum: 1, maximum: 50 })
    ),
  }),
};

export const giftMmBrowseExecutor: ToolExecutor<GiftBrowseParams> = async (
  params,
  context
): Promise<ToolResult> => {
  try {
    ensureGiftMatchmakerTables(context);

    let query = `SELECT * FROM gift_listings WHERE status = 'active' AND expires_at > datetime('now')`;
    const browseParams: unknown[] = [];
    if (params.collection) {
      query += ` AND LOWER(collection) = LOWER(?)`;
      browseParams.push(params.collection);
    }
    if (params.max_price) {
      query += ` AND (asking_price IS NULL OR asking_price <= ?)`;
      browseParams.push(params.max_price);
    }
    if (params.min_tier) {
      const tierRank = TIER_RANK[params.min_tier] ?? 5;
      const validTiers = Object.entries(TIER_RANK)
        .filter(([, r]) => r <= tierRank)
        .map(([t]) => t);
      query += ` AND rarity_tier IN (${validTiers.map(() => "?").join(",")})`;
      browseParams.push(...validTiers);
    }
    const limit = params.limit ?? 15;
    query += ` ORDER BY combined_rarity ASC LIMIT ?`;
    browseParams.push(limit);

    const listings = context.db.prepare(query).all(...browseParams) as GiftListingRow[];

    return {
      success: true,
      data: {
        total: listings.length,
        listings: listings.map((l) => ({
          id: l.id,
          collection: l.collection,
          giftNum: l.gift_num,
          model: `${l.model} (${(l.model_rarity ?? 0) / 10}%)`,
          backdrop: `${l.backdrop} (${(l.backdrop_rarity ?? 0) / 10}%)`,
          symbol: `${l.symbol} (${(l.symbol_rarity ?? 0) / 10}%)`,
          tier: l.rarity_tier,
          askingPrice: l.asking_price ? `${l.asking_price} ${l.currency}` : "Offers welcome",
          sellerId: l.seller_id,
          listedAt: l.created_at,
          expiresAt: l.expires_at,
        })),
        note: "Contact the seller directly to negotiate. Teleclaw does not handle trades.",
      },
    };
  } catch (err: unknown) {
    return {
      success: false,
      error: `Browse failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
};

// ─── My Gift Listings ────────────────────────────────────────────────

export const giftMmMyListingsTool: Tool = {
  name: "gift_mm_my_listings",
  description: "🎁 View your active gift listings and their match status.",
  category: "data-bearing",
  parameters: Type.Object({}),
};

export const giftMmMyListingsExecutor: ToolExecutor = async (
  _params,
  context
): Promise<ToolResult> => {
  try {
    ensureGiftMatchmakerTables(context);

    const listings = context.db
      .prepare(
        `SELECT l.*, COUNT(m.id) as total_matches
         FROM gift_listings l
         LEFT JOIN gift_matches m ON m.listing_id = l.id
         WHERE l.seller_id = ? AND l.status = 'active'
         GROUP BY l.id
         ORDER BY l.created_at DESC`
      )
      .all(context.senderId) as (GiftListingRow & { total_matches: number })[];

    return {
      success: true,
      data: {
        total: listings.length,
        listings: listings.map((l) => ({
          id: l.id,
          collection: l.collection,
          giftNum: l.gift_num,
          model: l.model,
          backdrop: l.backdrop,
          symbol: l.symbol,
          tier: l.rarity_tier,
          askingPrice: l.asking_price ? `${l.asking_price} ${l.currency}` : "Offers welcome",
          matches: l.total_matches,
          listedAt: l.created_at,
          expiresAt: l.expires_at,
        })),
      },
    };
  } catch (err: unknown) {
    return { success: false, error: `Failed: ${err instanceof Error ? err.message : String(err)}` };
  }
};

// ─── Cancel Gift Listing ─────────────────────────────────────────────

interface GiftCancelParams {
  listing_id: string;
}

export const giftMmCancelTool: Tool = {
  name: "gift_mm_cancel",
  description: "🎁 Cancel one of your active gift listings.",
  category: "action",
  parameters: Type.Object({
    listing_id: Type.String({ description: "Listing ID to cancel" }),
  }),
};

export const giftMmCancelExecutor: ToolExecutor<GiftCancelParams> = async (
  params,
  context
): Promise<ToolResult> => {
  try {
    ensureGiftMatchmakerTables(context);

    const listing = context.db
      .prepare(`SELECT * FROM gift_listings WHERE id = ? AND seller_id = ?`)
      .get(params.listing_id, context.senderId) as GiftListingRow | undefined;

    if (!listing) {
      return { success: false, error: "Listing not found or not yours." };
    }

    context.db
      .prepare(`UPDATE gift_listings SET status = 'cancelled' WHERE id = ?`)
      .run(params.listing_id);

    return {
      success: true,
      data: {
        cancelled: params.listing_id,
        collection: listing.collection,
        model: listing.model,
      },
    };
  } catch (err: unknown) {
    return {
      success: false,
      error: `Cancel failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
};

// ─── Express Interest (contact seller) ───────────────────────────────

interface GiftExpressParams {
  listing_id: string;
  offer_price?: number;
  message?: string;
}

export const giftMmExpressTool: Tool = {
  name: "gift_mm_express",
  description:
    "🎁 Express interest in a listed gift — seller gets your offer + contact.\n\n" +
    "Include an offer price and/or message. After this, both parties handle the trade directly " +
    "(DM each other, use Telegram marketplace, Tonnel, Portals, etc.).\n" +
    "Teleclaw never touches funds or NFTs — matchmaker only.",
  category: "action",
  parameters: Type.Object({
    listing_id: Type.String({ description: "Listing ID to express interest in" }),
    offer_price: Type.Optional(Type.Number({ description: "Your offer price in TON" })),
    message: Type.Optional(Type.String({ description: "Message to the seller" })),
  }),
};

export const giftMmExpressExecutor: ToolExecutor<GiftExpressParams> = async (
  params,
  context
): Promise<ToolResult> => {
  try {
    ensureGiftMatchmakerTables(context);

    const gate = await checkTokenGate(context.db, context.senderId);
    if (!gate.allowed) return { success: false, error: gate.reason };

    const listing = context.db
      .prepare(`SELECT * FROM gift_listings WHERE id = ? AND status = 'active'`)
      .get(params.listing_id) as GiftListingRow | undefined;

    if (!listing) {
      return { success: false, error: "Listing not found or no longer active." };
    }

    if (listing.seller_id === context.senderId) {
      return { success: false, error: "You can't express interest in your own listing." };
    }

    // Save match
    const matchId = generateId("gmtch");
    context.db
      .prepare(
        `INSERT INTO gift_matches (id, listing_id, buyer_id, seller_id, collection, gift_num)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        matchId,
        params.listing_id,
        context.senderId,
        listing.seller_id,
        listing.collection,
        listing.gift_num
      );

    // Update match count
    context.db
      .prepare(`UPDATE gift_listings SET match_count = match_count + 1 WHERE id = ?`)
      .run(params.listing_id);

    return {
      success: true,
      data: {
        matchId,
        listing: {
          collection: listing.collection,
          giftNum: listing.gift_num,
          model: listing.model,
          backdrop: listing.backdrop,
          symbol: listing.symbol,
          tier: listing.rarity_tier,
          askingPrice: listing.asking_price
            ? `${listing.asking_price} ${listing.currency}`
            : "Offers welcome",
        },
        yourOffer: params.offer_price ? `${params.offer_price} TON` : undefined,
        yourMessage: params.message,
        sellerId: listing.seller_id,
        // Notify seller via DM
        _notifySeller: {
          userId: listing.seller_id,
          message:
            `🔔 Someone is interested in your gift!\n\n` +
            `🎁 ${listing.collection}${listing.gift_num ? ` #${listing.gift_num}` : ""}\n` +
            `Model: ${listing.model} | Tier: ${listing.rarity_tier}\n` +
            `${params.offer_price ? `💰 Their offer: ${params.offer_price} TON\n` : ""}` +
            `${params.message ? `💬 Message: ${params.message}\n` : ""}` +
            `👤 Buyer: ${context.senderUsername ? "@" + context.senderUsername : "User #" + context.senderId}\n\n` +
            `Reach out to them directly if you'd like to proceed.`,
        },
        note: "The seller has been notified. Handle the trade directly — Teleclaw does not process payments or transfers.",
      },
    };
  } catch (err: unknown) {
    return {
      success: false,
      error: `Express interest failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
};

// ─── Mark Gift as Sold ───────────────────────────────────────────────

interface GiftSoldParams {
  listing_id: string;
}

export const giftMmSoldTool: Tool = {
  name: "gift_mm_sold",
  description:
    "🎁 Mark a gift listing as SOLD. Call this after you've completed the trade.\n\n" +
    "This closes the listing and notifies all other interested buyers that the gift is no longer available. " +
    "Important: only the seller can mark a listing as sold.",
  category: "action",
  parameters: Type.Object({
    listing_id: Type.String({ description: "Listing ID to mark as sold" }),
  }),
};

export const giftMmSoldExecutor: ToolExecutor<GiftSoldParams> = async (
  params,
  context
): Promise<ToolResult> => {
  try {
    ensureGiftMatchmakerTables(context);

    const listing = context.db
      .prepare(`SELECT * FROM gift_listings WHERE id = ? AND seller_id = ?`)
      .get(params.listing_id, context.senderId) as GiftListingRow | undefined;

    if (!listing) {
      return { success: false, error: "Listing not found or not yours." };
    }

    if (listing.status === "sold") {
      return { success: false, error: "This listing is already marked as sold." };
    }

    context.db
      .prepare(`UPDATE gift_listings SET status = 'sold', sold_at = datetime('now') WHERE id = ?`)
      .run(params.listing_id);

    // Get all interested buyers to notify them
    const interestedBuyers = context.db
      .prepare(`SELECT DISTINCT buyer_id FROM gift_matches WHERE listing_id = ?`)
      .all(params.listing_id) as Array<{ buyer_id: number }>;

    return {
      success: true,
      data: {
        listingId: params.listing_id,
        collection: listing.collection,
        giftNum: listing.gift_num,
        model: listing.model,
        status: "sold",
        buyersToNotify: interestedBuyers.length,
        buyerIds: interestedBuyers.map((b) => b.buyer_id),
        _notifyBuyers: interestedBuyers
          .filter((b) => b.buyer_id !== context.senderId)
          .map((b) => ({
            userId: b.buyer_id,
            message:
              `ℹ️ A gift you were interested in has been sold.\n\n` +
              `🎁 ${listing.collection}${listing.gift_num ? " #" + listing.gift_num : ""} — ${listing.model}\n\n` +
              `Keep browsing — more gifts are listed regularly!`,
          })),
        note: "Listing closed. All interested buyers will be informed this gift is no longer available.",
      },
    };
  } catch (err: unknown) {
    return {
      success: false,
      error: `Mark sold failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
};

// ─── Check Stale Listings (for agent reminders) ──────────────────────

/**
 * Returns listings that have been active for 48+ hours without update.
 * The agent should call this periodically and remind sellers to update status.
 */
export function getStaleListings(ctx: ToolContext): GiftListingRow[] {
  ensureGiftMatchmakerTables(ctx);

  return ctx.db
    .prepare(
      `SELECT * FROM gift_listings
       WHERE status = 'active'
       AND match_count > 0
       AND created_at < datetime('now', '-48 hours')
       AND (last_reminder_at IS NULL OR last_reminder_at < datetime('now', '-24 hours'))`
    )
    .all() as GiftListingRow[];
}

/**
 * Mark a listing as reminded so we don't spam the seller.
 */
export function markListingReminded(ctx: ToolContext, listingId: string): void {
  ctx.db
    .prepare(`UPDATE gift_listings SET last_reminder_at = datetime('now') WHERE id = ?`)
    .run(listingId);
}

// ─── Row Types ───────────────────────────────────────────────────────

interface GiftListingRow {
  id: string;
  seller_id: number;
  seller_username: string | null;
  collection: string;
  gift_num: number | null;
  model: string;
  model_rarity: number | null;
  backdrop: string;
  backdrop_rarity: number | null;
  symbol: string;
  symbol_rarity: number | null;
  combined_rarity: number | null;
  rarity_tier: string | null;
  asking_price: number | null;
  currency: string;
  description: string | null;
  created_at: string;
  expires_at: string;
  status: string;
  match_count: number;
  sold_at: string | null;
  last_reminder_at: string | null;
}

interface GiftInterestRow {
  id: string;
  buyer_id: number;
  buyer_username: string | null;
  collection: string | null;
  model: string | null;
  backdrop: string | null;
  symbol: string | null;
  max_rarity_permille: number | null;
  max_price: number | null;
  currency: string;
  min_tier: string | null;
  created_at: string;
  active: number;
}
