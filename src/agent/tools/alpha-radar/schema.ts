import type Database from "better-sqlite3";

/**
 * Run migrations for the Alpha Radar feature.
 * Tables for monitored channels, tracked tokens, mentions, and alert preferences.
 * Idempotent — safe to call multiple times.
 */
export function migrateAlphaRadar(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS radar_channels (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      chat_id TEXT NOT NULL,
      chat_title TEXT,
      added_at INTEGER DEFAULT (unixepoch()),
      active INTEGER DEFAULT 1,
      UNIQUE(user_id, chat_id)
    );

    CREATE INDEX IF NOT EXISTS idx_radar_channels_user
      ON radar_channels(user_id) WHERE active = 1;

    CREATE TABLE IF NOT EXISTS radar_tokens (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      contract_address TEXT,
      added_at INTEGER DEFAULT (unixepoch()),
      active INTEGER DEFAULT 1,
      UNIQUE(user_id, LOWER(symbol))
    );

    CREATE INDEX IF NOT EXISTS idx_radar_tokens_user
      ON radar_tokens(user_id) WHERE active = 1;

    CREATE TABLE IF NOT EXISTS radar_mentions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token_symbol TEXT NOT NULL,
      channel_chat_id TEXT NOT NULL,
      channel_title TEXT,
      message_text TEXT NOT NULL,
      message_id INTEGER,
      sender_name TEXT,
      sentiment TEXT CHECK(sentiment IN ('bullish', 'bearish', 'neutral', 'news')),
      detected_at INTEGER DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_radar_mentions_user_token
      ON radar_mentions(user_id, token_symbol, detected_at);

    CREATE TABLE IF NOT EXISTS radar_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token_symbol TEXT NOT NULL,
      channels_count INTEGER NOT NULL,
      mentions_count INTEGER NOT NULL,
      dominant_sentiment TEXT,
      alert_text TEXT NOT NULL,
      sent_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS radar_preferences (
      user_id INTEGER PRIMARY KEY,
      alert_mode TEXT DEFAULT 'smart' CHECK(alert_mode IN ('every', 'hourly', 'daily', 'smart')),
      min_mentions INTEGER DEFAULT 2,
      quiet_start INTEGER DEFAULT 23,
      quiet_end INTEGER DEFAULT 9,
      updated_at INTEGER DEFAULT (unixepoch())
    );
  `);
}
