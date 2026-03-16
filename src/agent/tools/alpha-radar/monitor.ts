import type Database from "better-sqlite3";
import type { TelegramTransport, TelegramMessage } from "../../../telegram/transport.js";
import type { Config } from "../../../config/schema.js";
import {
  detectMentions,
  storeMentions,
  getRecentMentions,
  getUniqueChannelCount,
} from "./mention-detector.js";
import { createLogger } from "../../../utils/logger.js";
import { getErrorMessage } from "../../../utils/errors.js";

const log = createLogger("AlphaRadar:Monitor");

let isListening = false;
let cleanupInterval: ReturnType<typeof setInterval> | null = null;
let alertCleanupInterval: ReturnType<typeof setInterval> | null = null;

// ─── Caches ──────────────────────────────────────────────────────────

// Cache monitored channel IDs (refreshed every 30 seconds, not per-message)
let monitoredChannelCache: Set<string> = new Set();
let channelCacheUpdatedAt = 0;
const CHANNEL_CACHE_TTL_MS = 30_000;

// Cache channel titles from DB
const channelTitleCache = new Map<string, string>();

// Track recent alerts to avoid spam (userId:tokenSymbol → last alert timestamp)
const recentAlerts = new Map<string, number>();
const ALERT_COOLDOWN_MS = 300_000; // 5 minutes between alerts for same token

/**
 * Refresh the monitored channels cache from DB.
 */
function refreshChannelCache(db: Database.Database): void {
  const rows = db
    .prepare("SELECT chat_id, chat_title FROM radar_channels WHERE active = 1")
    .all() as Array<{ chat_id: string; chat_title: string | null }>;

  monitoredChannelCache = new Set(rows.map((r) => r.chat_id));

  // Update title cache
  for (const row of rows) {
    if (row.chat_title) {
      channelTitleCache.set(row.chat_id, row.chat_title);
    }
  }

  channelCacheUpdatedAt = Date.now();
}

/**
 * Get cached monitored channel IDs. Refreshes if stale.
 */
function getMonitoredChannels(db: Database.Database): Set<string> {
  if (Date.now() - channelCacheUpdatedAt > CHANNEL_CACHE_TTL_MS) {
    refreshChannelCache(db);
  }
  return monitoredChannelCache;
}

/**
 * Get channel title from cache or DB.
 */
function getChannelTitle(db: Database.Database, chatId: string): string {
  if (channelTitleCache.has(chatId)) {
    return channelTitleCache.get(chatId)!;
  }

  const row = db
    .prepare("SELECT chat_title FROM radar_channels WHERE chat_id = ? AND active = 1 LIMIT 1")
    .get(chatId) as { chat_title: string | null } | undefined;

  const title = row?.chat_title || chatId;
  channelTitleCache.set(chatId, title);
  return title;
}

/**
 * Clean up old entries from recentAlerts map to prevent memory leak.
 */
function cleanupAlertMap(): void {
  const now = Date.now();
  for (const [key, timestamp] of recentAlerts) {
    if (now - timestamp > ALERT_COOLDOWN_MS * 2) {
      recentAlerts.delete(key);
    }
  }
}

/**
 * Check if we should send an alert based on user preferences.
 */
function shouldAlert(
  db: Database.Database,
  userId: number,
  tokenSymbol: string
): boolean {
  // Check cooldown
  const key = `${userId}:${tokenSymbol}`;
  const lastAlert = recentAlerts.get(key);
  if (lastAlert && Date.now() - lastAlert < ALERT_COOLDOWN_MS) {
    return false;
  }

  // Check quiet hours
  const prefs = db
    .prepare("SELECT * FROM radar_preferences WHERE user_id = ?")
    .get(userId) as {
    alert_mode: string;
    min_mentions: number;
    quiet_start: number;
    quiet_end: number;
  } | undefined;

  const hour = new Date().getHours();
  const quietStart = prefs?.quiet_start ?? 23;
  const quietEnd = prefs?.quiet_end ?? 9;

  if (quietStart > quietEnd) {
    if (hour >= quietStart || hour < quietEnd) return false;
  } else {
    if (hour >= quietStart && hour < quietEnd) return false;
  }

  const minMentions = prefs?.min_mentions ?? 2;
  const alertMode = prefs?.alert_mode ?? "smart";

  if (alertMode === "smart") {
    const channelCount = getUniqueChannelCount(db, userId, tokenSymbol, 3600);
    return channelCount >= minMentions;
  } else if (alertMode === "every") {
    return true;
  } else if (alertMode === "hourly" || alertMode === "daily") {
    return false; // Handled by scheduled summaries
  }

  return true;
}

/**
 * Build alert message for a token mention.
 */
function buildAlertMessage(
  db: Database.Database,
  userId: number,
  tokenSymbol: string
): string {
  const mentions = getRecentMentions(db, userId, tokenSymbol, 3600);
  const channelCount = getUniqueChannelCount(db, userId, tokenSymbol, 3600);

  if (mentions.length === 0) return "";

  const sentiments = { bullish: 0, bearish: 0, neutral: 0, news: 0 };
  for (const m of mentions) {
    sentiments[m.sentiment as keyof typeof sentiments]++;
  }

  const total = mentions.length;
  const dominant =
    sentiments.bullish >= sentiments.bearish
      ? sentiments.bullish > 0
        ? "bullish"
        : "neutral"
      : "bearish";

  const sentimentEmoji = {
    bullish: "🟢 Bullish",
    bearish: "🔴 Bearish",
    neutral: "⚪ Neutral",
    news: "📰 News",
  };

  // Build channel breakdown — deduplicate, max 5
  const seen = new Set<string>();
  const channelBreakdown: Array<{ title: string; text: string; sentiment: string }> = [];
  for (const m of mentions) {
    const key = m.channel_title || m.channel_chat_id;
    if (seen.has(key)) continue;
    seen.add(key);
    channelBreakdown.push({
      title: key,
      text: m.message_text.slice(0, 100),
      sentiment: m.sentiment,
    });
    if (channelBreakdown.length >= 5) break;
  }

  let msg = `🔔 **Alpha Alert: $${tokenSymbol}**\n\n`;
  msg += `📊 ${channelCount} channel${channelCount > 1 ? "s" : ""} — ${total} mention${total > 1 ? "s" : ""} in the last hour\n\n`;

  for (const ch of channelBreakdown) {
    const emoji =
      ch.sentiment === "bullish"
        ? "🟢"
        : ch.sentiment === "bearish"
          ? "🔴"
          : ch.sentiment === "news"
            ? "📰"
            : "⚪";
    msg += `${emoji} **${ch.title}:** "${ch.text}${ch.text.length >= 100 ? "..." : ""}"\n`;
  }

  msg += `\nSentiment: ${sentimentEmoji[dominant]}`;
  if (total > 1) {
    msg += ` (${sentiments.bullish}🟢 ${sentiments.bearish}🔴 ${sentiments.news}📰 ${sentiments.neutral}⚪)`;
  }
  msg += `\n\n⚡ To act: "Buy [amount] TON worth of ${tokenSymbol}"`;

  return msg;
}

/**
 * Process an incoming message from a monitored channel.
 */
async function processMessage(
  db: Database.Database,
  bridge: TelegramTransport,
  message: TelegramMessage
): Promise<void> {
  if (!message.text || message.text.trim().length < 3) return;

  // Get the proper channel title
  const channelTitle = getChannelTitle(db, message.chatId);

  const mentions = detectMentions(
    db,
    message.chatId,
    channelTitle,
    message.text,
    message.id,
    message.senderFirstName || message.senderUsername || "Unknown"
  );

  if (mentions.length === 0) return;

  storeMentions(db, mentions);

  // Group by user + token for alerting
  const userTokenPairs = new Map<string, { userId: number; tokenSymbol: string }>();
  for (const m of mentions) {
    const key = `${m.userId}:${m.tokenSymbol}`;
    if (!userTokenPairs.has(key)) {
      userTokenPairs.set(key, { userId: m.userId, tokenSymbol: m.tokenSymbol });
    }
  }

  for (const [key, { userId, tokenSymbol }] of userTokenPairs) {
    if (!shouldAlert(db, userId, tokenSymbol)) continue;

    const alertMsg = buildAlertMessage(db, userId, tokenSymbol);
    if (!alertMsg) continue;

    try {
      await bridge.sendMessage({
        chatId: userId.toString(),
        text: alertMsg,
      });

      recentAlerts.set(key, Date.now());

      db.prepare(
        `INSERT INTO radar_alerts (user_id, token_symbol, channels_count, mentions_count, dominant_sentiment, alert_text)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        userId,
        tokenSymbol,
        getUniqueChannelCount(db, userId, tokenSymbol, 3600),
        getRecentMentions(db, userId, tokenSymbol, 3600).length,
        "bullish",
        alertMsg.slice(0, 500)
      );

      log.info({ userId, tokenSymbol }, "Alpha alert sent");
    } catch (err) {
      log.warn({ err: getErrorMessage(err), userId }, "Failed to send alpha alert");
    }
  }
}

/**
 * Start listening to monitored channels.
 * Registers ONE message handler that filters by cached channel list.
 */
export function startAlphaRadar(context: {
  db: Database.Database;
  bridge: TelegramTransport;
  config: Config;
}): void {
  if (isListening) {
    log.warn("Alpha Radar already running — skipping duplicate start");
    return;
  }

  // Initial cache load
  refreshChannelCache(context.db);
  const channelCount = monitoredChannelCache.size;

  if (channelCount === 0) {
    log.info("No channels to monitor — Alpha Radar on standby");
  } else {
    log.info({ channels: channelCount }, "Alpha Radar monitoring channels");
  }

  // Register message handler
  context.bridge.onNewMessage(
    async (message) => {
      // Guard: if stopped, don't process
      if (!isListening) return;

      try {
        // Use cached channel set (NOT a DB query per message)
        const monitored = getMonitoredChannels(context.db);
        if (!monitored.has(message.chatId)) return;

        // NEVER process DMs
        if (!message.isGroup && !message.isChannel) return;

        // NEVER process bot messages (reduce noise)
        if (message.isBot) return;

        await processMessage(context.db, context.bridge, message);
      } catch (error) {
        log.error({ err: getErrorMessage(error) }, "Error in Alpha Radar message handler");
      }
    },
    { incoming: true }
  );

  // Cleanup old mentions every hour (keep last 7 days)
  cleanupInterval = setInterval(() => {
    try {
      const weekAgo = Math.floor(Date.now() / 1000) - 7 * 24 * 3600;
      const result = context.db
        .prepare("DELETE FROM radar_mentions WHERE detected_at < ?")
        .run(weekAgo);
      if (result.changes > 0) {
        log.info({ deleted: result.changes }, "Cleaned up old mentions");
      }
    } catch (err) {
      log.error({ err: getErrorMessage(err) }, "Failed to cleanup old mentions");
    }
  }, 3600_000);

  // Cleanup alert cooldown map every 10 minutes
  alertCleanupInterval = setInterval(cleanupAlertMap, 600_000);

  isListening = true;
  log.info("Alpha Radar started");
}

/**
 * Stop the Alpha Radar monitor.
 */
export function stopAlphaRadar(): void {
  isListening = false; // Handler checks this flag

  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
  if (alertCleanupInterval) {
    clearInterval(alertCleanupInterval);
    alertCleanupInterval = null;
  }

  // Clear caches
  recentAlerts.clear();
  monitoredChannelCache.clear();
  channelTitleCache.clear();
  channelCacheUpdatedAt = 0;

  log.info("Alpha Radar stopped");
}

/**
 * Force refresh monitored channels (called when user adds/removes channels).
 */
export function refreshMonitoredChannels(db: Database.Database): void {
  refreshChannelCache(db);
  log.info({ channels: monitoredChannelCache.size }, "Refreshed monitored channels");
}
