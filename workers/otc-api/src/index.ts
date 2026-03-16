/**
 * Teleclaw OTC Matchmaker — Shared API
 * Cloudflare Workers + D1 (SQLite)
 *
 * PRIVACY: Only stores anonymous listing data.
 * No user IDs, usernames, wallets, or message history.
 * Bot instances identified only by bot_id (Telegram bot token hash).
 */

export interface Env {
  DB: D1Database;
}

// ─── Schema ──────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS listings (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('username', 'gift', 'number')),
  item_name TEXT NOT NULL,
  item_details TEXT NOT NULL DEFAULT '{}',
  bot_id TEXT NOT NULL,
  price REAL,
  currency TEXT NOT NULL DEFAULT 'TON',
  price_usd REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'sold', 'cancelled', 'expired'))
);

CREATE TABLE IF NOT EXISTS interests (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL,
  buyer_bot_id TEXT NOT NULL,
  offer_price REAL,
  offer_currency TEXT,
  message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (listing_id) REFERENCES listings(id)
);

CREATE TABLE IF NOT EXISTS callbacks (
  id TEXT PRIMARY KEY,
  target_bot_id TEXT NOT NULL,
  type TEXT NOT NULL,
  listing_id TEXT NOT NULL,
  from_bot_id TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  acked INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status);
CREATE INDEX IF NOT EXISTS idx_listings_type ON listings(type, status);
CREATE INDEX IF NOT EXISTS idx_listings_bot ON listings(bot_id);
CREATE INDEX IF NOT EXISTS idx_callbacks_target ON callbacks(target_bot_id, acked);
`;

function generateId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

function getBotId(request: Request): string | null {
  return request.headers.get("X-Bot-Id");
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}

// ─── Routes ──────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // Ensure schema
    try {
      await env.DB.exec(SCHEMA);
    } catch {
      // Schema already exists
    }

    // Auto-expire old listings
    await env.DB.prepare(
      `UPDATE listings SET status = 'expired' WHERE status = 'active' AND expires_at < datetime('now')`
    ).run();

    // CORS
    if (method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, X-Bot-Id, Authorization",
        },
      });
    }

    // Require bot_id for all non-health endpoints
    const botId = getBotId(request);
    if (!botId && path !== "/api/health") {
      return errorResponse("Missing X-Bot-Id header", 401);
    }

    // ── Health ──
    if (path === "/api/health" && method === "GET") {
      const count = await env.DB.prepare(
        `SELECT COUNT(*) as c FROM listings WHERE status = 'active'`
      ).first<{ c: number }>();
      return jsonResponse({ ok: true, active_listings: count?.c ?? 0 });
    }

    // ── POST /api/listings — Publish listing ──
    if (path === "/api/listings" && method === "POST") {
      const body = (await request.json()) as {
        type: string;
        item_name: string;
        item_details?: Record<string, unknown>;
        bot_id: string;
        price?: number;
        currency?: string;
        price_usd?: number;
        expires_days?: number;
      };

      if (!body.type || !body.item_name) {
        return errorResponse("type and item_name required");
      }

      // Rate limit: max 20 active listings per bot
      const existing = await env.DB.prepare(
        `SELECT COUNT(*) as c FROM listings WHERE bot_id = ? AND status = 'active'`
      ).bind(botId).first<{ c: number }>();

      if ((existing?.c ?? 0) >= 20) {
        return errorResponse("Max 20 active listings per bot", 429);
      }

      const id = generateId();
      const expiresDays = body.expires_days ?? 14;
      const expiresAt = new Date(Date.now() + expiresDays * 86400000).toISOString();

      await env.DB.prepare(
        `INSERT INTO listings (id, type, item_name, item_details, bot_id, price, currency, price_usd, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        id,
        body.type,
        body.item_name,
        JSON.stringify(body.item_details ?? {}),
        botId,
        body.price ?? null,
        body.currency ?? "TON",
        body.price_usd ?? null,
        expiresAt
      ).run();

      return jsonResponse({ id }, 201);
    }

    // ── GET /api/listings — Browse listings ──
    if (path === "/api/listings" && method === "GET") {
      const type = url.searchParams.get("type");
      const maxPriceUsd = url.searchParams.get("max_price_usd");
      const search = url.searchParams.get("q");
      const excludeBot = url.searchParams.get("exclude_bot");
      const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50"), 100);

      let query = `SELECT * FROM listings WHERE status = 'active'`;
      const binds: unknown[] = [];

      if (type) { query += ` AND type = ?`; binds.push(type); }
      if (maxPriceUsd) { query += ` AND (price_usd IS NULL OR price_usd <= ?)`; binds.push(parseFloat(maxPriceUsd)); }
      if (search) { query += ` AND item_name LIKE ?`; binds.push(`%${search}%`); }
      if (excludeBot) { query += ` AND bot_id != ?`; binds.push(excludeBot); }

      query += ` ORDER BY created_at DESC LIMIT ?`;
      binds.push(limit);

      const stmt = env.DB.prepare(query);
      const result = await (binds.length > 0 ? stmt.bind(...binds) : stmt).all();

      const listings = (result.results ?? []).map((row: Record<string, unknown>) => ({
        ...row,
        item_details: JSON.parse(row.item_details as string || "{}"),
      }));

      return jsonResponse(listings);
    }

    // ── DELETE /api/listings/:id — Remove listing ──
    if (path.startsWith("/api/listings/") && method === "DELETE") {
      const id = path.split("/").pop();
      await env.DB.prepare(
        `UPDATE listings SET status = 'cancelled' WHERE id = ? AND bot_id = ?`
      ).bind(id, botId).run();
      return jsonResponse({ ok: true });
    }

    // ── POST /api/interests — Signal interest ──
    if (path === "/api/interests" && method === "POST") {
      const body = (await request.json()) as {
        listing_id: string;
        buyer_bot_id: string;
        offer_price?: number;
        offer_currency?: string;
        message?: string;
      };

      if (!body.listing_id) {
        return errorResponse("listing_id required");
      }

      // Get listing to find seller's bot
      const listing = await env.DB.prepare(
        `SELECT * FROM listings WHERE id = ? AND status = 'active'`
      ).bind(body.listing_id).first();

      if (!listing) {
        return errorResponse("Listing not found or expired", 404);
      }

      // Can't express interest in own listing
      if (listing.bot_id === botId) {
        return errorResponse("Cannot express interest in your own listing");
      }

      // Save interest
      const id = generateId();
      await env.DB.prepare(
        `INSERT INTO interests (id, listing_id, buyer_bot_id, offer_price, offer_currency, message)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(
        id,
        body.listing_id,
        botId,
        body.offer_price ?? null,
        body.offer_currency ?? null,
        body.message ?? null
      ).run();

      // Create callback for seller's bot
      const callbackId = generateId();
      await env.DB.prepare(
        `INSERT INTO callbacks (id, target_bot_id, type, listing_id, from_bot_id, data)
         VALUES (?, ?, 'interest', ?, ?, ?)`
      ).bind(
        callbackId,
        listing.bot_id as string,
        body.listing_id,
        botId,
        JSON.stringify({
          offer_price: body.offer_price,
          offer_currency: body.offer_currency,
          message: body.message,
        })
      ).run();

      return jsonResponse({ ok: true, interest_id: id });
    }

    // ── GET /api/callbacks — Poll callbacks for this bot ──
    if (path === "/api/callbacks" && method === "GET") {
      const result = await env.DB.prepare(
        `SELECT * FROM callbacks WHERE target_bot_id = ? AND acked = 0 ORDER BY created_at ASC LIMIT 20`
      ).bind(botId).all();

      const callbacks = (result.results ?? []).map((row: Record<string, unknown>) => ({
        ...row,
        data: JSON.parse(row.data as string || "{}"),
      }));

      return jsonResponse(callbacks);
    }

    // ── POST /api/callbacks/:id/ack — Acknowledge callback ──
    if (path.match(/^\/api\/callbacks\/[^/]+\/ack$/) && method === "POST") {
      const id = path.split("/")[3];
      await env.DB.prepare(
        `UPDATE callbacks SET acked = 1 WHERE id = ? AND target_bot_id = ?`
      ).bind(id, botId).run();
      return jsonResponse({ ok: true });
    }

    return errorResponse("Not found", 404);
  },
};
