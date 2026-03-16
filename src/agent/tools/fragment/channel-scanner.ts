/**
 * 📡 Channel Scanner — Monitor TG channels/groups for WTB/WTS username deals.
 *
 * Flow:
 * 1. User adds channels to monitor (e.g. @fragmentmarket, @usernamez)
 * 2. Scanner periodically checks new messages via Bot API (bot must be member)
 *    or user forwards messages manually for parsing
 * 3. Messages are parsed for username mentions + buy/sell intent
 * 4. Matched against user's taste profile / watched categories
 * 5. DM notification sent to interested users
 *
 * Parse patterns:
 * - "selling @username 50 TON" / "WTS @username"
 * - "buying @username" / "WTB short usernames"
 * - "looking for crypto usernames under 100 TON"
 * - Price extraction: "50 TON", "50t", "$500", "150⭐"
 */

import { Type } from "@sinclair/typebox";
import type { Tool, ToolExecutor, ToolResult, ToolContext } from "../types.js";
import { categorizeUsername, type CategoryKey } from "./categorizer.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("ChannelScanner");

// ─── Constants ───────────────────────────────────────────────────────

const MAX_CHANNELS_PER_USER = 10;
const MAX_ALERTS_PER_HOUR = 10;
const ALERT_WINDOW_MS = 60 * 60 * 1000;

// ─── Types ───────────────────────────────────────────────────────────

interface ParsedDeal {
  type: "wts" | "wtb" | "unknown";
  usernames: string[];
  price?: number;
  currency?: "TON" | "USD" | "stars";
  categories: CategoryKey[];
  rawText: string;
  confidence: number; // 0-100
}

// ─── DB Schema ───────────────────────────────────────────────────────

function ensureScannerTables(ctx: ToolContext): void {
  ctx.db.exec(`
    -- Channels being monitored per user
    CREATE TABLE IF NOT EXISTS cs_watched_channels (
      user_id INTEGER NOT NULL,
      channel TEXT NOT NULL,
      categories TEXT NOT NULL DEFAULT '[]',
      max_price REAL,
      deal_types TEXT NOT NULL DEFAULT '["wts"]',
      enabled INTEGER NOT NULL DEFAULT 1,
      added_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, channel)
    );

    -- Parsed deals from channels
    CREATE TABLE IF NOT EXISTS cs_parsed_deals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL,
      message_id INTEGER,
      deal_type TEXT NOT NULL,
      usernames TEXT NOT NULL,
      price REAL,
      currency TEXT,
      categories TEXT NOT NULL DEFAULT '[]',
      raw_text TEXT NOT NULL,
      confidence INTEGER NOT NULL DEFAULT 0,
      parsed_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(channel, message_id)
    );

    -- Alert log (dedup + rate limiting)
    CREATE TABLE IF NOT EXISTS cs_alert_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      deal_id INTEGER NOT NULL,
      sent_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, deal_id)
    );

    CREATE INDEX IF NOT EXISTS idx_cs_alerts_user_time
      ON cs_alert_log(user_id, sent_at);
  `);
}

// ─── Message Parser ──────────────────────────────────────────────────

// WTS patterns
const WTS_PATTERNS = [
  /\b(?:wts|selling|sell|for\s+sale|satılık|satıyorum|fs)\b/i,
  /\b(?:selling|sell)\s+@/i,
];

// WTB patterns
const WTB_PATTERNS = [
  /\b(?:wtb|buying|buy|looking\s+for|want\s+to\s+buy|arıyorum|alıyorum)\b/i,
  /\b(?:buying|buy)\s+@/i,
];

// Username extraction
const USERNAME_REGEX = /@([a-zA-Z][a-zA-Z0-9_]{3,31})/g;

// Price extraction
const PRICE_PATTERNS = [
  /(\d[\d,]*(?:\.\d+)?)\s*(?:TON|ton|Ton)/,          // 50 TON
  /(\d[\d,]*(?:\.\d+)?)\s*(?:t\b|T\b)/,              // 50t / 50T
  /\$\s*(\d[\d,]*(?:\.\d+)?)/,                        // $500
  /(\d[\d,]*(?:\.\d+)?)\s*(?:⭐|stars?|Stars?)/,      // 150⭐ / 150 stars
  /(\d[\d,]*(?:\.\d+)?)\s*(?:USD|usd|USDT|usdt)/,    // 500 USD
];

export function parseMessage(text: string): ParsedDeal | null {
  if (!text || text.length < 5) return null;

  // Detect deal type
  const isWts = WTS_PATTERNS.some((p) => p.test(text));
  const isWtb = WTB_PATTERNS.some((p) => p.test(text));
  let dealType: ParsedDeal["type"] = "unknown";
  if (isWts && !isWtb) dealType = "wts";
  else if (isWtb && !isWts) dealType = "wtb";
  else if (isWts && isWtb) dealType = "wts"; // default to WTS if ambiguous

  // Extract usernames
  const usernames: string[] = [];
  let match: RegExpExecArray | null;
  const usernameRegex = new RegExp(USERNAME_REGEX.source, "g");
  while ((match = usernameRegex.exec(text)) !== null) {
    const name = match[1].toLowerCase();
    // Filter out common bot/channel names that aren't traded
    if (!EXCLUDED_NAMES.has(name) && name.length >= 4) {
      usernames.push(`@${name}`);
    }
  }

  // If no usernames found and not a clear WTB, skip
  if (usernames.length === 0 && dealType !== "wtb") return null;

  // Extract price
  let price: number | undefined;
  let currency: ParsedDeal["currency"];
  for (const pattern of PRICE_PATTERNS) {
    const priceMatch = text.match(pattern);
    if (priceMatch) {
      price = parseFloat(priceMatch[1].replace(/,/g, ""));
      if (pattern.source.includes("TON") || pattern.source.includes("t\\b")) {
        currency = "TON";
      } else if (pattern.source.includes("⭐") || pattern.source.includes("star")) {
        currency = "stars";
      } else {
        currency = "USD";
      }
      break;
    }
  }

  // Categorize found usernames
  const allCategories: CategoryKey[] = [];
  for (const username of usernames) {
    const categorized = categorizeUsername(username);
    for (const cat of categorized.categories) {
      if (!allCategories.includes(cat)) allCategories.push(cat);
    }
  }

  // Confidence scoring
  let confidence = 30; // base
  if (dealType !== "unknown") confidence += 30;
  if (usernames.length > 0) confidence += 20;
  if (price !== undefined) confidence += 20;

  // Must have at least usernames OR clear intent
  if (usernames.length === 0 && dealType === "unknown") return null;

  return {
    type: dealType,
    usernames,
    price,
    currency,
    categories: allCategories,
    rawText: text.slice(0, 500),
    confidence: Math.min(100, confidence),
  };
}

// Common channel/bot names to exclude from username detection
const EXCLUDED_NAMES = new Set([
  "admin", "admins", "here", "everyone", "channel", "group",
  "fragment", "getgems", "tonkeeper", "wallet", "telegram",
  "teleclawagent", "teleclaw", "username", "usernames",
  "fragmentmarket", "tondiamonds",
]);

// ─── Matching Logic ──────────────────────────────────────────────────

interface WatchedChannel {
  userId: number;
  channel: string;
  categories: CategoryKey[];
  maxPrice: number | null;
  dealTypes: string[];
}

function getWatchersForChannel(
  ctx: ToolContext,
  channel: string
): WatchedChannel[] {
  try {
    const rows = ctx.db
      .prepare(
        `SELECT * FROM cs_watched_channels
         WHERE channel = ? AND enabled = 1`
      )
      .all(channel.toLowerCase()) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      userId: r.user_id as number,
      channel: r.channel as string,
      categories: JSON.parse(r.categories as string),
      maxPrice: r.max_price as number | null,
      dealTypes: JSON.parse(r.deal_types as string),
    }));
  } catch {
    return [];
  }
}

function getAllWatchers(ctx: ToolContext): WatchedChannel[] {
  try {
    const rows = ctx.db
      .prepare(`SELECT * FROM cs_watched_channels WHERE enabled = 1`)
      .all() as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      userId: r.user_id as number,
      channel: r.channel as string,
      categories: JSON.parse(r.categories as string),
      maxPrice: r.max_price as number | null,
      dealTypes: JSON.parse(r.deal_types as string),
    }));
  } catch {
    return [];
  }
}

function getRecentAlertCount(ctx: ToolContext, userId: number): number {
  try {
    const cutoff = new Date(Date.now() - ALERT_WINDOW_MS).toISOString();
    const row = ctx.db
      .prepare(
        `SELECT COUNT(*) as cnt FROM cs_alert_log WHERE user_id = ? AND sent_at > ?`
      )
      .get(userId, cutoff) as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  } catch {
    return 0;
  }
}

function wasAlreadyAlerted(ctx: ToolContext, userId: number, dealId: number): boolean {
  try {
    return !!ctx.db
      .prepare(`SELECT 1 FROM cs_alert_log WHERE user_id = ? AND deal_id = ?`)
      .get(userId, dealId);
  } catch {
    return false;
  }
}

function logAlert(ctx: ToolContext, userId: number, dealId: number): void {
  try {
    ctx.db
      .prepare(`INSERT OR IGNORE INTO cs_alert_log (user_id, deal_id) VALUES (?, ?)`)
      .run(userId, dealId);
  } catch (err) {
    log.error({ err }, "Failed to log alert");
  }
}

// ─── Core: Process a channel message ─────────────────────────────────

export type AlertSender = (userId: number, message: string) => Promise<boolean>;

export function processChannelMessage(
  ctx: ToolContext,
  channel: string,
  messageId: number | undefined,
  text: string,
  sendAlert: AlertSender
): { parsed: ParsedDeal | null; alertsSent: number } {
  const parsed = parseMessage(text);
  if (!parsed || parsed.confidence < 50) {
    return { parsed, alertsSent: 0 };
  }

  // Save parsed deal
  let dealId: number;
  try {
    const result = ctx.db
      .prepare(
        `INSERT OR IGNORE INTO cs_parsed_deals
         (channel, message_id, deal_type, usernames, price, currency, categories, raw_text, confidence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        channel.toLowerCase(),
        messageId ?? null,
        parsed.type,
        JSON.stringify(parsed.usernames),
        parsed.price ?? null,
        parsed.currency ?? null,
        JSON.stringify(parsed.categories),
        parsed.rawText,
        parsed.confidence
      );
    dealId = Number(result.lastInsertRowid);
    if (dealId === 0) return { parsed, alertsSent: 0 }; // duplicate
  } catch {
    return { parsed, alertsSent: 0 };
  }

  // Find matching watchers
  const watchers = getWatchersForChannel(ctx, channel);
  let alertsSent = 0;

  for (const watcher of watchers) {
    // Rate limit
    if (getRecentAlertCount(ctx, watcher.userId) >= MAX_ALERTS_PER_HOUR) continue;
    if (wasAlreadyAlerted(ctx, watcher.userId, dealId)) continue;

    // Deal type filter
    if (!watcher.dealTypes.includes(parsed.type) && parsed.type !== "unknown") continue;

    // Price filter
    if (watcher.maxPrice && parsed.price && parsed.price > watcher.maxPrice) continue;

    // Category match
    let categoryMatch = false;
    if (watcher.categories.length === 0) {
      categoryMatch = true; // watch all
    } else {
      categoryMatch = parsed.categories.some((c) => watcher.categories.includes(c));
    }
    if (!categoryMatch) continue;

    // Build alert
    const typeEmoji = parsed.type === "wts" ? "💰" : parsed.type === "wtb" ? "🔍" : "📢";
    const typeLabel = parsed.type === "wts" ? "SELLING" : parsed.type === "wtb" ? "BUYING" : "DEAL";
    const priceStr = parsed.price ? `${parsed.price} ${parsed.currency || "TON"}` : "Price N/A";
    const usernameStr = parsed.usernames.length > 0
      ? parsed.usernames.join(", ")
      : "Category request";
    const catStr = parsed.categories.slice(0, 3).join(", ") || "—";

    const message = [
      `📡 *Channel Deal Alert*`,
      ``,
      `${typeEmoji} *${typeLabel}*`,
      `📛 ${usernameStr}`,
      `💵 ${priceStr}`,
      `📂 ${catStr}`,
      `📣 Source: ${channel}`,
      ``,
      `_"${parsed.rawText.slice(0, 200)}${parsed.rawText.length > 200 ? "..." : ""}"_`,
    ].join("\n");

    sendAlert(watcher.userId, message)
      .then((ok) => {
        if (ok) logAlert(ctx, watcher.userId, dealId);
      })
      .catch(() => {});
    alertsSent++;
  }

  return { parsed, alertsSent };
}

// ─── Tool: Add Channel to Watch ──────────────────────────────────────

interface ScanAddParams {
  channel: string;
  categories?: string[];
  max_price?: number;
  deal_types?: string[];
}

export const channelScanAddTool: Tool = {
  name: "fragment_scan_channel",
  description:
    "Monitor a Telegram channel/group for username WTB/WTS deals. " +
    "When someone posts about selling/buying a username matching your interests, you get a DM alert. " +
    "Specify categories to filter (e.g. crypto, short, gaming) and optionally a max price.",
  category: "action",
  parameters: Type.Object({
    channel: Type.String({
      description: "Channel username to monitor (e.g. @fragmentmarket, @usernamez)",
    }),
    categories: Type.Optional(
      Type.Array(Type.String(), {
        description: 'Categories to watch (e.g. ["crypto", "short"]). Empty = all.',
      })
    ),
    max_price: Type.Optional(
      Type.Number({ description: "Max price filter in TON", minimum: 0 })
    ),
    deal_types: Type.Optional(
      Type.Array(Type.String(), {
        description: 'Deal types: ["wts"] for sells only, ["wtb"] for buys, ["wts","wtb"] for both. Default: ["wts"].',
      })
    ),
  }),
};

export const channelScanAddExecutor: ToolExecutor<ScanAddParams> = async (
  params,
  ctx
): Promise<ToolResult> => {
  try {
    ensureScannerTables(ctx);
    const userId = ctx.senderId;
    const channel = params.channel.replace(/^@/, "").toLowerCase();

    // Check limit
    const existing = ctx.db
      .prepare(`SELECT COUNT(*) as cnt FROM cs_watched_channels WHERE user_id = ? AND enabled = 1`)
      .get(userId) as { cnt: number };

    if (existing.cnt >= MAX_CHANNELS_PER_USER) {
      return {
        success: false,
        error: `Maximum ${MAX_CHANNELS_PER_USER} channels allowed. Remove one first.`,
      };
    }

    const categories = (params.categories || []) as CategoryKey[];
    const dealTypes = params.deal_types || ["wts"];
    const maxPrice = params.max_price ?? null;

    ctx.db
      .prepare(
        `INSERT INTO cs_watched_channels (user_id, channel, categories, max_price, deal_types, enabled)
         VALUES (?, ?, ?, ?, ?, 1)
         ON CONFLICT(user_id, channel) DO UPDATE SET
           categories = excluded.categories,
           max_price = excluded.max_price,
           deal_types = excluded.deal_types,
           enabled = 1`
      )
      .run(userId, channel, JSON.stringify(categories), maxPrice, JSON.stringify(dealTypes));

    const catDisplay = categories.length > 0 ? categories.join(", ") : "All";
    const typeDisplay = dealTypes.join(" & ").toUpperCase();

    return {
      success: true,
      data: [
        `📡 *Channel Scanner Activated*`,
        ``,
        `📣 Channel: @${channel}`,
        `📂 Categories: ${catDisplay}`,
        `💰 Max price: ${maxPrice ? maxPrice + " TON" : "No limit"}`,
        `🔄 Watching: ${typeDisplay} deals`,
        ``,
        `I'll alert you when matching deals appear in this channel.`,
        `⚠️ Bot must be a member of @${channel} to auto-scan. Otherwise, forward messages to me manually.`,
      ].join("\n"),
    };
  } catch (error) {
    log.error({ err: error }, "Channel scan add error");
    return { success: false, error: String(error) };
  }
};

// ─── Tool: Remove Channel ────────────────────────────────────────────

interface ScanRemoveParams {
  channel: string;
}

export const channelScanRemoveTool: Tool = {
  name: "fragment_scan_remove",
  description: "Stop monitoring a channel for username deals.",
  category: "action",
  parameters: Type.Object({
    channel: Type.String({ description: "Channel to stop monitoring" }),
  }),
};

export const channelScanRemoveExecutor: ToolExecutor<ScanRemoveParams> = async (
  params,
  ctx
): Promise<ToolResult> => {
  try {
    ensureScannerTables(ctx);
    const channel = params.channel.replace(/^@/, "").toLowerCase();

    const result = ctx.db
      .prepare(
        `UPDATE cs_watched_channels SET enabled = 0 WHERE user_id = ? AND channel = ?`
      )
      .run(ctx.senderId, channel);

    if (result.changes === 0) {
      return { success: false, error: `@${channel} was not in your watch list.` };
    }

    return {
      success: true,
      data: `🔕 Stopped monitoring @${channel} for deals.`,
    };
  } catch (error) {
    log.error({ err: error }, "Channel scan remove error");
    return { success: false, error: String(error) };
  }
};

// ─── Tool: List Watched Channels ─────────────────────────────────────

export const channelScanListTool: Tool = {
  name: "fragment_scan_list",
  description: "View your monitored channels and their filters.",
  category: "data-bearing",
  parameters: Type.Object({}),
};

export const channelScanListExecutor: ToolExecutor<Record<string, never>> = async (
  _params,
  ctx
): Promise<ToolResult> => {
  try {
    ensureScannerTables(ctx);

    const channels = ctx.db
      .prepare(
        `SELECT * FROM cs_watched_channels WHERE user_id = ? AND enabled = 1 ORDER BY added_at DESC`
      )
      .all(ctx.senderId) as Array<Record<string, unknown>>;

    if (channels.length === 0) {
      return {
        success: true,
        data: "📭 No channels being monitored. Use `scan channel @channelname` to start.",
      };
    }

    const alertCount = getRecentAlertCount(ctx, ctx.senderId);

    const lines = channels.map((ch, i) => {
      const cats = JSON.parse(ch.categories as string);
      const types = JSON.parse(ch.deal_types as string);
      const catStr = cats.length > 0 ? cats.join(", ") : "All";
      const priceStr = ch.max_price ? `≤${ch.max_price} TON` : "No limit";
      return (
        `${i + 1}. @${ch.channel}\n` +
        `   📂 ${catStr} | 💰 ${priceStr} | 🔄 ${types.join("/").toUpperCase()}`
      );
    });

    return {
      success: true,
      data: [
        `📡 *Monitored Channels* (${channels.length}/${MAX_CHANNELS_PER_USER})`,
        ``,
        ...lines,
        ``,
        `📬 Alerts this hour: ${alertCount}/${MAX_ALERTS_PER_HOUR}`,
      ].join("\n"),
    };
  } catch (error) {
    log.error({ err: error }, "Channel scan list error");
    return { success: false, error: String(error) };
  }
};

// ─── Tool: Parse a forwarded message ─────────────────────────────────

interface ParseParams {
  text: string;
  channel?: string;
}

export const channelParseTool: Tool = {
  name: "fragment_parse_deal",
  description:
    "Parse a forwarded channel message for username deals. " +
    "Use when a user forwards a message from a trading channel — " +
    "extracts usernames, prices, and deal type (WTB/WTS).",
  category: "data-bearing",
  parameters: Type.Object({
    text: Type.String({ description: "The message text to parse for deals" }),
    channel: Type.Optional(
      Type.String({ description: "Source channel (if known)" })
    ),
  }),
};

export const channelParseExecutor: ToolExecutor<ParseParams> = async (
  params,
  ctx
): Promise<ToolResult> => {
  try {
    const parsed = parseMessage(params.text);
    if (!parsed) {
      return {
        success: true,
        data: "🤷 No username deal detected in this message.",
      };
    }

    const typeEmoji = parsed.type === "wts" ? "💰" : parsed.type === "wtb" ? "🔍" : "📢";
    const typeLabel = parsed.type === "wts" ? "SELLING" : parsed.type === "wtb" ? "BUYING" : "UNCLEAR";

    return {
      success: true,
      data: {
        parsed,
        message: [
          `📡 *Deal Detected*`,
          ``,
          `${typeEmoji} Type: ${typeLabel}`,
          `📛 Usernames: ${parsed.usernames.join(", ") || "—"}`,
          `💵 Price: ${parsed.price ? `${parsed.price} ${parsed.currency || "TON"}` : "Not specified"}`,
          `📂 Categories: ${parsed.categories.join(", ") || "—"}`,
          `🎯 Confidence: ${parsed.confidence}%`,
        ].join("\n"),
      },
    };
  } catch (error) {
    log.error({ err: error }, "Parse deal error");
    return { success: false, error: String(error) };
  }
};

// ─── Exports ─────────────────────────────────────────────────────────

export {
  ensureScannerTables,
  getAllWatchers,
  type ParsedDeal,
  type WatchedChannel,
};
