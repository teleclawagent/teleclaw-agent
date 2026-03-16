import type Database from "better-sqlite3";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("AlphaRadar:Detector");

interface TrackedToken {
  id: string;
  user_id: number;
  symbol: string;
  contract_address: string | null;
}

interface DetectedMention {
  userId: number;
  tokenSymbol: string;
  channelChatId: string;
  channelTitle: string;
  messageText: string;
  messageId: number | undefined;
  senderName: string;
  sentiment: "bullish" | "bearish" | "neutral" | "news";
}

// ─── Sentiment Keywords ──────────────────────────────────────────────
// Only multi-word or unambiguous terms to avoid false positives
// e.g. "al" removed (matches "also"), "sat" removed (matches "Saturday")

const BULLISH_KEYWORDS = [
  "buy now", "going long", "moon", "pump it", "bullish", "breakout",
  "new ath", "100x", "10x gem", "undervalued", "accumulate", "dip buy",
  "good entry", "load up", "send it", "strong buy",
  "alım fırsatı", "yükseliş", "dipten al", "fırsat",
  "🚀", "📈", "💎",
];

const BEARISH_KEYWORDS = [
  "sell now", "going short", "dump", "bearish", "crash",
  "rug pull", "scam alert", "exit now", "overvalued", "dead project",
  "rekt", "stay away", "avoid", "hack", "exploit",
  "düşüş", "satış", "kaçın", "tehlike",
  "🔴", "📉",
];

const NEWS_KEYWORDS = [
  "announced", "partnership", "new listing", "just launched", "update",
  "upgrade", "airdrop", "snapshot", "migration", "audit complete",
  "integration", "mainnet",
  "duyuru", "açıklama", "güncelleme",
];

/**
 * Analyze sentiment of a message about a token.
 * Uses multi-word phrases to avoid false positives.
 */
function analyzeSentiment(text: string): "bullish" | "bearish" | "neutral" | "news" {
  const lower = text.toLowerCase();

  let bullishScore = 0;
  let bearishScore = 0;
  let newsScore = 0;

  for (const kw of BULLISH_KEYWORDS) {
    if (lower.includes(kw)) bullishScore++;
  }
  for (const kw of BEARISH_KEYWORDS) {
    if (lower.includes(kw)) bearishScore++;
  }
  for (const kw of NEWS_KEYWORDS) {
    if (lower.includes(kw)) newsScore++;
  }

  if (newsScore > 0 && newsScore >= bullishScore && newsScore >= bearishScore) return "news";
  if (bullishScore > bearishScore) return "bullish";
  if (bearishScore > bullishScore) return "bearish";
  return "neutral";
}

/**
 * Build a word-boundary regex for a token symbol.
 * Prevents "TON" matching "button", "carton", etc.
 * Matches: $TON, $ton, "TON ", " TON", "TON." but NOT "button" or "carTON"
 */
function buildTokenRegex(symbol: string): RegExp {
  const escaped = escapeRegex(symbol);
  // Match:
  // 1. $SYMBOL (dollar prefix)
  // 2. SYMBOL as standalone word (word boundary on both sides)
  // Minimum 2-char symbols to avoid single-letter false positives
  return new RegExp(
    `\\$${escaped}\\b|(?<=^|[\\s,.:;!?()\\[\\]{}])${escaped}(?=$|[\\s,.:;!?()\\[\\]{}])`,
    "i"
  );
}

/**
 * Get all tracked tokens for users who monitor a specific channel.
 */
export function getTokensForChannel(
  db: Database.Database,
  channelChatId: string
): Array<{ userId: number; tokens: TrackedToken[] }> {
  const channelUsers = db
    .prepare(
      "SELECT DISTINCT user_id FROM radar_channels WHERE chat_id = ? AND active = 1"
    )
    .all(channelChatId) as Array<{ user_id: number }>;

  if (channelUsers.length === 0) return [];

  const result: Array<{ userId: number; tokens: TrackedToken[] }> = [];

  for (const { user_id } of channelUsers) {
    const tokens = db
      .prepare("SELECT * FROM radar_tokens WHERE user_id = ? AND active = 1")
      .all(user_id) as TrackedToken[];

    if (tokens.length > 0) {
      result.push({ userId: user_id, tokens });
    }
  }

  return result;
}

/**
 * Check if a message mentions any tracked tokens.
 * Uses strict word-boundary matching to prevent false positives.
 */
export function detectMentions(
  db: Database.Database,
  channelChatId: string,
  channelTitle: string,
  messageText: string,
  messageId: number | undefined,
  senderName: string
): DetectedMention[] {
  const userTokens = getTokensForChannel(db, channelChatId);
  if (userTokens.length === 0) return [];

  const lowerText = messageText.toLowerCase();
  const mentions: DetectedMention[] = [];

  for (const { userId, tokens } of userTokens) {
    for (const token of tokens) {
      // Skip very short symbols (1-2 chars) — too many false positives
      if (token.symbol.length < 2) continue;

      const tokenRegex = buildTokenRegex(token.symbol);
      const hasSymbolMatch = tokenRegex.test(messageText);

      const hasContractMatch =
        token.contract_address &&
        token.contract_address.length > 10 &&
        lowerText.includes(token.contract_address.toLowerCase());

      if (hasSymbolMatch || hasContractMatch) {
        const sentiment = analyzeSentiment(messageText);

        mentions.push({
          userId,
          tokenSymbol: token.symbol.toUpperCase(),
          channelChatId,
          channelTitle,
          messageText: messageText.slice(0, 500),
          messageId,
          senderName,
          sentiment,
        });
      }
    }
  }

  return mentions;
}

/**
 * Store detected mentions in the database.
 * Message text is truncated for storage — not full message archive.
 */
export function storeMentions(db: Database.Database, mentions: DetectedMention[]): void {
  const stmt = db.prepare(
    `INSERT INTO radar_mentions
       (user_id, token_symbol, channel_chat_id, channel_title, message_text, message_id, sender_name, sentiment)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const txn = db.transaction(() => {
    for (const m of mentions) {
      stmt.run(
        m.userId,
        m.tokenSymbol,
        m.channelChatId,
        m.channelTitle,
        m.messageText,
        m.messageId || null,
        m.senderName,
        m.sentiment
      );
    }
  });

  txn();
  if (mentions.length > 0) {
    log.info({ count: mentions.length }, "Stored token mentions");
  }
}

/**
 * Get recent mentions for a user's token within a time window.
 */
export function getRecentMentions(
  db: Database.Database,
  userId: number,
  tokenSymbol: string,
  windowSeconds: number = 3600
): Array<{
  channel_title: string;
  channel_chat_id: string;
  message_text: string;
  sender_name: string;
  sentiment: string;
  detected_at: number;
}> {
  const since = Math.floor(Date.now() / 1000) - windowSeconds;
  return db
    .prepare(
      `SELECT channel_title, channel_chat_id, message_text, sender_name, sentiment, detected_at
       FROM radar_mentions
       WHERE user_id = ? AND token_symbol = ? AND detected_at >= ?
       ORDER BY detected_at DESC
       LIMIT 20`
    )
    .all(userId, tokenSymbol, since) as Array<{
    channel_title: string;
    channel_chat_id: string;
    message_text: string;
    sender_name: string;
    sentiment: string;
    detected_at: number;
  }>;
}

/**
 * Get unique channels where a token was mentioned recently.
 */
export function getUniqueChannelCount(
  db: Database.Database,
  userId: number,
  tokenSymbol: string,
  windowSeconds: number = 3600
): number {
  const since = Math.floor(Date.now() / 1000) - windowSeconds;
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT channel_chat_id) as count
       FROM radar_mentions
       WHERE user_id = ? AND token_symbol = ? AND detected_at >= ?`
    )
    .get(userId, tokenSymbol, since) as { count: number };

  return row.count;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
