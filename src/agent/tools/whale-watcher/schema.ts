import type Database from "better-sqlite3";

/**
 * Run migrations for the Whale Watcher feature.
 * Idempotent — safe to call multiple times.
 */
export function migrateWhaleWatcher(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS whale_watched_wallets (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      address TEXT NOT NULL,
      label TEXT,
      last_seen_lt TEXT,
      active INTEGER DEFAULT 1,
      added_at INTEGER DEFAULT (unixepoch()),
      UNIQUE(user_id, address)
    );

    CREATE INDEX IF NOT EXISTS idx_whale_wallets_user
      ON whale_watched_wallets(user_id) WHERE active = 1;

    CREATE TABLE IF NOT EXISTS whale_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      wallet_address TEXT NOT NULL,
      wallet_label TEXT,
      tx_hash TEXT,
      tx_type TEXT NOT NULL,
      amount TEXT NOT NULL,
      asset TEXT DEFAULT 'TON',
      counterparty TEXT,
      detected_at INTEGER DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_whale_tx_user
      ON whale_transactions(user_id, detected_at);
  `);
}
