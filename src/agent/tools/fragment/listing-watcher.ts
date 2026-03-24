/**
 * 🔔 Listing Watcher — Monitor new Fragment listings & notify matching users.
 *
 * Flow:
 * 1. Poll Fragment for current listings (auction + sale)
 * 2. Compare with previous snapshot → detect new listings
 * 3. Categorize each new listing via Smart Categorizer
 * 4. Match against user Taste Profiles (findMatchingBuyers)
 * 5. Send DM notifications to matching users via Telegram bot
 *
 * Anti-spam:
 * - Max 5 notifications per user per hour
 * - Min 60s match score threshold (0-100)
 * - Dedup: never notify same username twice to same user
 * - Rate limited Fragment polling (respects existing 2s limiter)
 *
 * Users control preferences via:
 * - /watch <categories> — subscribe to specific categories
 * - /unwatch — unsubscribe
 * - /watchsettings — view/change budget, score threshold, frequency
 * - Taste Profile (existing) — auto-learned preferences from examples
 */

import { Type } from "@sinclair/typebox";
import type { Tool, ToolExecutor, ToolContext } from "../types.js";
import { fetchUsernames, fetchNumbers } from "./fragment-service.js";
import { categorizeUsername, type CategoryKey } from "./categorizer.js";
import { calculateRarity } from "./number-rarity.js";
import { findMatchingBuyers } from "./taste-profile.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("ListingWatcher");

// ─── Constants ───────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes
const MAX_NOTIFICATIONS_PER_HOUR = 5;
const MIN_MATCH_SCORE = 60;
const NOTIFICATION_WINDOW_MS = 60 * 60 * 1000; // 1 hour

// ─── State ───────────────────────────────────────────────────────────

/** In-memory snapshot of known listings (persisted to DB for restart survival) */
let knownListings = new Set<string>();
let watcherInterval: ReturnType<typeof setInterval> | null = null;
let isRunning = false;

// ─── DB Schema ───────────────────────────────────────────────────────

function ensureTables(ctx: ToolContext): void {
  ctx.db.exec(`
    -- User watch preferences
    CREATE TABLE IF NOT EXISTS lw_watch_preferences (
      user_id INTEGER PRIMARY KEY,
      categories TEXT NOT NULL DEFAULT '[]',
      max_price REAL,
      min_score INTEGER NOT NULL DEFAULT ${MIN_MATCH_SCORE},
      max_notifications_per_hour INTEGER NOT NULL DEFAULT ${MAX_NOTIFICATIONS_PER_HOUR},
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Notification log (dedup + rate limiting)
    CREATE TABLE IF NOT EXISTS lw_notification_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      username TEXT NOT NULL,
      score INTEGER NOT NULL,
      price REAL,
      categories TEXT NOT NULL,
      sent_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, username)
    );

    -- Known listings snapshot (survives restart)
    CREATE TABLE IF NOT EXISTS lw_known_listings (
      username TEXT PRIMARY KEY,
      first_seen TEXT NOT NULL DEFAULT (datetime('now')),
      status TEXT NOT NULL,
      price REAL,
      categories TEXT NOT NULL DEFAULT '[]'
    );

    -- Index for rate limiting queries
    CREATE INDEX IF NOT EXISTS idx_lw_notif_user_time
      ON lw_notification_log(user_id, sent_at);
  `);
}

// ─── Snapshot Management ─────────────────────────────────────────────

function loadKnownListings(ctx: ToolContext): void {
  try {
    const rows = ctx.db.prepare("SELECT username FROM lw_known_listings").all() as Array<{
      username: string;
    }>;
    knownListings = new Set(rows.map((r) => r.username.toLowerCase()));
    log.info({ count: knownListings.size }, "Loaded known listings from DB");
  } catch {
    knownListings = new Set();
  }
}

function saveNewListing(
  ctx: ToolContext,
  username: string,
  status: string,
  price: number | undefined,
  categories: CategoryKey[]
): void {
  try {
    ctx.db
      .prepare(
        `INSERT OR IGNORE INTO lw_known_listings (username, status, price, categories)
         VALUES (?, ?, ?, ?)`
      )
      .run(username.toLowerCase(), status, price ?? null, JSON.stringify(categories));
  } catch (err) {
    log.error({ err, username }, "Failed to save new listing");
  }
}

// ─── Rate Limiting ───────────────────────────────────────────────────

function getRecentNotificationCount(ctx: ToolContext, userId: number): number {
  try {
    const cutoff = new Date(Date.now() - NOTIFICATION_WINDOW_MS).toISOString();
    const row = ctx.db
      .prepare(
        `SELECT COUNT(*) as cnt FROM lw_notification_log
         WHERE user_id = ? AND sent_at > ?`
      )
      .get(userId, cutoff) as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  } catch {
    return 0;
  }
}

function wasAlreadyNotified(ctx: ToolContext, userId: number, username: string): boolean {
  try {
    const row = ctx.db
      .prepare(`SELECT 1 FROM lw_notification_log WHERE user_id = ? AND username = ?`)
      .get(userId, username.toLowerCase());
    return !!row;
  } catch {
    return false;
  }
}

function logNotification(
  ctx: ToolContext,
  userId: number,
  username: string,
  score: number,
  price: number | undefined,
  categories: CategoryKey[]
): void {
  try {
    ctx.db
      .prepare(
        `INSERT OR IGNORE INTO lw_notification_log (user_id, username, score, price, categories)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(userId, username.toLowerCase(), score, price ?? null, JSON.stringify(categories));
  } catch (err) {
    log.error({ err, userId, username }, "Failed to log notification");
  }
}

// ─── User Preferences ───────────────────────────────────────────────

interface WatchPreferences {
  userId: number;
  categories: CategoryKey[];
  maxPrice: number | null;
  minScore: number;
  maxNotificationsPerHour: number;
  enabled: boolean;
}

function getWatchPreferences(ctx: ToolContext, userId: number): WatchPreferences | null {
  try {
    const row = ctx.db
      .prepare("SELECT * FROM lw_watch_preferences WHERE user_id = ? AND enabled = 1")
      .get(userId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      userId: row.user_id as number,
      categories: JSON.parse(row.categories as string),
      maxPrice: row.max_price as number | null,
      minScore: row.min_score as number,
      maxNotificationsPerHour: row.max_notifications_per_hour as number,
      enabled: true,
    };
  } catch {
    return null;
  }
}

function getAllActiveWatchers(ctx: ToolContext): WatchPreferences[] {
  try {
    const rows = ctx.db
      .prepare("SELECT * FROM lw_watch_preferences WHERE enabled = 1")
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      userId: row.user_id as number,
      categories: JSON.parse(row.categories as string),
      maxPrice: row.max_price as number | null,
      minScore: row.min_score as number,
      maxNotificationsPerHour: row.max_notifications_per_hour as number,
      enabled: true,
    }));
  } catch {
    return [];
  }
}

// ─── Core: Detect New Listings ───────────────────────────────────────

interface NewListing {
  username: string;
  status: "auction" | "sale";
  price?: number;
  categories: CategoryKey[];
  url: string;
}

async function detectNewListings(ctx: ToolContext): Promise<NewListing[]> {
  const newListings: NewListing[] = [];

  // Fetch current username auctions + sales from Fragment
  const [auctions, sales, numAuctions, numSales] = await Promise.all([
    fetchUsernames("auction", "recent", 50),
    fetchUsernames("sale", "recent", 50),
    fetchNumbers("auction", "recent", 50),
    fetchNumbers("sale", "recent", 50),
  ]);

  // Process usernames
  const allUsernames = [
    ...auctions.map((u) => ({ ...u, type: "auction" as const })),
    ...sales.map((u) => ({ ...u, type: "sale" as const })),
  ];

  for (const listing of allUsernames) {
    const cleanName = listing.username.replace(/^@/, "").toLowerCase();
    if (knownListings.has(cleanName)) continue;

    const categorized = categorizeUsername(listing.username);
    const categories = categorized.categories;

    newListings.push({
      username: listing.username,
      status: listing.type,
      price: listing.priceRaw,
      categories,
      url: listing.url,
    });

    knownListings.add(cleanName);
    saveNewListing(ctx, cleanName, listing.type, listing.priceRaw, categories);
  }

  // Process anonymous numbers
  const allNumbers = [
    ...numAuctions.map((n) => ({ ...n, type: "auction" as const })),
    ...numSales.map((n) => ({ ...n, type: "sale" as const })),
  ];

  for (const listing of allNumbers) {
    const key = `num:${listing.rawDigits}`;
    if (knownListings.has(key)) continue;

    // Categorize number by rarity tags
    const rarity = calculateRarity(listing.rawDigits);
    const categories: CategoryKey[] = [];
    if (rarity) {
      // Map rarity tags to category-like labels
      if (rarity.tags.includes("short")) categories.push("ultra_short" as CategoryKey);
      if (rarity.tier === "S" || rarity.tier === "A") categories.push("premium" as CategoryKey);
      if (rarity.tags.some((t) => t.includes("repeat")))
        categories.push("repeating" as CategoryKey);
      if (rarity.tags.includes("palindrome")) categories.push("palindrome" as CategoryKey);
    }

    newListings.push({
      username: listing.number, // display name
      status: listing.type,
      price: listing.priceRaw,
      categories,
      url: listing.url,
    });

    knownListings.add(key);
    saveNewListing(ctx, key, listing.type, listing.priceRaw, categories);
  }

  if (newListings.length > 0) {
    log.info({ count: newListings.length }, "New listings detected");
  }

  return newListings;
}

// ─── Core: Match & Notify ────────────────────────────────────────────

export type NotifySender = (userId: number, message: string) => Promise<boolean>;

async function matchAndNotify(
  ctx: ToolContext,
  newListings: NewListing[],
  sendNotification: NotifySender
): Promise<{ sent: number; skipped: number }> {
  let sent = 0;
  let skipped = 0;

  // Get all active watchers
  const watchers = getAllActiveWatchers(ctx);

  // Also get taste profile matches
  for (const listing of newListings) {
    // Method 1: Explicit category watchers
    for (const watcher of watchers) {
      // Check rate limit
      const recentCount = getRecentNotificationCount(ctx, watcher.userId);
      if (recentCount >= watcher.maxNotificationsPerHour) {
        skipped++;
        continue;
      }

      // Check dedup
      if (wasAlreadyNotified(ctx, watcher.userId, listing.username)) {
        continue;
      }

      // Check price limit
      if (watcher.maxPrice && listing.price && listing.price > watcher.maxPrice) {
        skipped++;
        continue;
      }

      // Check category overlap (if user specified categories)
      let matched = false;
      let score = 0;

      if (watcher.categories.length > 0) {
        const overlap = listing.categories.filter((c) => watcher.categories.includes(c));
        if (overlap.length > 0) {
          matched = true;
          score = Math.round((overlap.length / listing.categories.length) * 100);
        }
      }

      // Method 2: Taste profile scoring (if no explicit categories or for additional matching)
      if (!matched) {
        const profileMatches = findMatchingBuyers(
          ctx,
          listing.username,
          listing.categories,
          listing.price,
          watcher.minScore
        );
        const userMatch = profileMatches.find((m) => m.userId === watcher.userId);
        if (userMatch) {
          matched = true;
          score = userMatch.score;
        }
      }

      if (!matched || score < watcher.minScore) {
        continue;
      }

      // Build notification message
      const priceStr = listing.price ? `${listing.price} TON` : "Price TBD";
      const catLabels = listing.categories.slice(0, 3).join(", ");
      const statusEmoji = listing.status === "auction" ? "🔨" : "💰";

      const message = [
        `🔔 *New Listing Alert*`,
        ``,
        `${statusEmoji} \`${listing.username}\` — ${priceStr}`,
        `📂 ${catLabels}`,
        `🎯 Match score: ${score}/100`,
        ``,
        `[View on Fragment](${listing.url})`,
      ].join("\n");

      const success = await sendNotification(watcher.userId, message);
      if (success) {
        logNotification(
          ctx,
          watcher.userId,
          listing.username,
          score,
          listing.price,
          listing.categories
        );
        sent++;
      } else {
        skipped++;
      }
    }
  }

  return { sent, skipped };
}

// ─── Watcher Lifecycle ───────────────────────────────────────────────

export function startWatcher(ctx: ToolContext, sendNotification: NotifySender): void {
  if (isRunning) {
    log.warn("Watcher already running");
    return;
  }

  ensureTables(ctx);
  loadKnownListings(ctx);
  isRunning = true;

  log.info({ interval: POLL_INTERVAL_MS }, "Starting listing watcher");

  // Initial poll
  pollOnce(ctx, sendNotification).catch((err) => log.error({ err }, "Initial poll failed"));

  // Recurring poll
  watcherInterval = setInterval(() => {
    pollOnce(ctx, sendNotification).catch((err) => log.error({ err }, "Poll cycle failed"));
  }, POLL_INTERVAL_MS);
}

export function stopWatcher(): void {
  if (watcherInterval) {
    clearInterval(watcherInterval);
    watcherInterval = null;
  }
  isRunning = false;
  log.info("Listing watcher stopped");
}

export function isWatcherRunning(): boolean {
  return isRunning;
}

async function pollOnce(
  ctx: ToolContext,
  sendNotification: NotifySender
): Promise<{ newListings: number; sent: number; skipped: number }> {
  const newListings = await detectNewListings(ctx);
  if (newListings.length === 0) {
    return { newListings: 0, sent: 0, skipped: 0 };
  }

  const { sent, skipped } = await matchAndNotify(ctx, newListings, sendNotification);
  log.info({ newListings: newListings.length, sent, skipped }, "Poll cycle complete");
  return { newListings: newListings.length, sent, skipped };
}

// ─── Tool: /watch ────────────────────────────────────────────────────

interface WatchParams {
  categories?: string[];
  maxPrice?: number;
  minScore?: number;
}

export const listingWatchTool: Tool = {
  name: "fragment_watch",
  description:
    "Subscribe to new Fragment listing alerts. Specify categories you're interested in (e.g. crypto, gaming, short) " +
    "and optionally set a max price filter. New listings matching your preferences will be sent via DM. " +
    "Uses your Taste Profile for smart matching if set up.",
  parameters: Type.Object({
    categories: Type.Optional(
      Type.Array(Type.String(), {
        description:
          'Categories to watch (e.g. ["crypto", "gaming", "short", "ton_related"]). Leave empty to use Taste Profile only.',
      })
    ),
    maxPrice: Type.Optional(
      Type.Number({ description: "Maximum price in TON. Listings above this are filtered out." })
    ),
    minScore: Type.Optional(
      Type.Number({
        description:
          "Minimum match score (0-100). Default 60. Higher = fewer but more relevant alerts.",
        minimum: 0,
        maximum: 100,
      })
    ),
  }),
};

export const listingWatchExecutor: ToolExecutor<WatchParams> = async (params, ctx) => {
  ensureTables(ctx);
  const userId = ctx.senderId;
  if (!userId) {
    return { success: true, data: "❌ User identification required. Send me a DM first." };
  }

  const categories = (params.categories || []) as CategoryKey[];
  const maxPrice = params.maxPrice ?? null;
  const minScore = params.minScore ?? MIN_MATCH_SCORE;

  // Upsert preferences
  ctx.db
    .prepare(
      `INSERT INTO lw_watch_preferences (user_id, categories, max_price, min_score, enabled, updated_at)
       VALUES (?, ?, ?, ?, 1, datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET
         categories = excluded.categories,
         max_price = excluded.max_price,
         min_score = excluded.min_score,
         enabled = 1,
         updated_at = datetime('now')`
    )
    .run(userId, JSON.stringify(categories), maxPrice, minScore);

  const catDisplay = categories.length > 0 ? categories.join(", ") : "All (via Taste Profile)";
  const priceDisplay = maxPrice ? `${maxPrice} TON` : "No limit";

  return {
    success: true,
    data: [
      "✅ *Listing Watch Activated*",
      "",
      `📂 Categories: ${catDisplay}`,
      `💰 Max price: ${priceDisplay}`,
      `🎯 Min match score: ${minScore}/100`,
      "",
      "I'll DM you when new listings match your preferences.",
      categories.length === 0 ? "💡 Set up your Taste Profile (`/taste`) for better matching!" : "",
    ]
      .filter(Boolean)
      .join("\n"),
  };
};

// ─── Tool: /unwatch ──────────────────────────────────────────────────

export const listingUnwatchTool: Tool = {
  name: "fragment_unwatch",
  description: "Stop receiving new listing alerts from Fragment.",
  parameters: Type.Object({}),
};

export const listingUnwatchExecutor: ToolExecutor<Record<string, never>> = async (_params, ctx) => {
  ensureTables(ctx);
  const userId = ctx.senderId;
  if (!userId) {
    return { success: true, data: "❌ User identification required." };
  }

  ctx.db
    .prepare(
      `UPDATE lw_watch_preferences SET enabled = 0, updated_at = datetime('now') WHERE user_id = ?`
    )
    .run(userId);

  return { success: true, data: "🔕 Listing alerts disabled. Use `/watch` to re-enable anytime." };
};

// ─── Tool: /watchsettings ────────────────────────────────────────────

export const watchSettingsTool: Tool = {
  name: "fragment_watch_settings",
  description:
    "View your current listing watch settings — categories, price filters, notification stats.",
  parameters: Type.Object({}),
};

export const watchSettingsExecutor: ToolExecutor<Record<string, never>> = async (_params, ctx) => {
  ensureTables(ctx);
  const userId = ctx.senderId;
  if (!userId) {
    return { success: true, data: "❌ User identification required." };
  }

  const prefs = getWatchPreferences(ctx, userId);
  if (!prefs) {
    return {
      success: true,
      data: "📭 No active watch subscription. Use `/watch` to start receiving alerts!",
    };
  }

  // Get notification stats
  const _cutoff = new Date(Date.now() - NOTIFICATION_WINDOW_MS).toISOString();
  const recentCount = getRecentNotificationCount(ctx, userId);

  const totalRow = ctx.db
    .prepare("SELECT COUNT(*) as cnt FROM lw_notification_log WHERE user_id = ?")
    .get(userId) as { cnt: number } | undefined;
  const totalSent = totalRow?.cnt ?? 0;

  const catDisplay =
    prefs.categories.length > 0 ? prefs.categories.join(", ") : "All (Taste Profile)";

  return {
    success: true,
    data: [
      "⚙️ *Watch Settings*",
      "",
      `📂 Categories: ${catDisplay}`,
      `💰 Max price: ${prefs.maxPrice ? prefs.maxPrice + " TON" : "No limit"}`,
      `🎯 Min score: ${prefs.minScore}/100`,
      `📊 Rate limit: ${prefs.maxNotificationsPerHour}/hour`,
      "",
      `*Stats:*`,
      `📬 Last hour: ${recentCount} notifications`,
      `📈 All time: ${totalSent} notifications sent`,
    ].join("\n"),
  };
};

// ─── Exports for index.ts ────────────────────────────────────────────

export {
  detectNewListings,
  matchAndNotify,
  pollOnce,
  ensureTables as ensureWatcherTables,
  type NewListing,
  type WatchPreferences,
};
