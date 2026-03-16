import type Database from "better-sqlite3";

/**
 * Run migrations for the agentic wallet feature.
 * Creates tables for user wallets, trading rules, trade executions,
 * whitelisted addresses, and security PINs.
 * Idempotent — safe to call multiple times.
 */
export function migrateAgenticWallet(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agentic_wallets (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      chat_id TEXT NOT NULL,
      address TEXT NOT NULL,
      encrypted_secret TEXT NOT NULL,
      label TEXT,
      max_trade_amount REAL DEFAULT 100,
      daily_limit REAL DEFAULT 500,
      created_at INTEGER DEFAULT (unixepoch()),
      UNIQUE(user_id)
    );

    CREATE TABLE IF NOT EXISTS wallet_pins (
      user_id INTEGER PRIMARY KEY,
      pin_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      failed_attempts INTEGER DEFAULT 0,
      locked_until INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS whitelisted_addresses (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      address TEXT NOT NULL,
      label TEXT,
      created_at INTEGER DEFAULT (unixepoch()),
      UNIQUE(user_id, address)
    );

    CREATE TABLE IF NOT EXISTS trading_rules (
      id TEXT PRIMARY KEY,
      wallet_id TEXT NOT NULL REFERENCES agentic_wallets(id),
      user_id INTEGER NOT NULL,
      rule_text TEXT NOT NULL,
      rule_type TEXT NOT NULL CHECK(rule_type IN ('price_above', 'price_below', 'dca', 'stop_loss', 'take_profit')),
      asset TEXT NOT NULL,
      target_asset TEXT DEFAULT 'ton',
      condition_value REAL,
      amount REAL NOT NULL,
      interval_seconds INTEGER,
      last_triggered_at INTEGER,
      active INTEGER DEFAULT 1,
      requires_confirmation INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_trading_rules_active
      ON trading_rules(active) WHERE active = 1;

    CREATE INDEX IF NOT EXISTS idx_trading_rules_user
      ON trading_rules(user_id);

    CREATE TABLE IF NOT EXISTS trade_executions (
      id TEXT PRIMARY KEY,
      rule_id TEXT REFERENCES trading_rules(id),
      wallet_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      asset TEXT NOT NULL,
      amount REAL NOT NULL,
      price_at_execution REAL,
      price_sources TEXT,
      result TEXT,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'confirmed', 'executed', 'failed', 'cancelled', 'expired')),
      signature TEXT,
      created_at INTEGER DEFAULT (unixepoch()),
      executed_at INTEGER,
      expires_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_trade_executions_status
      ON trade_executions(status) WHERE status = 'pending';

    CREATE INDEX IF NOT EXISTS idx_trade_executions_user
      ON trade_executions(user_id);

    CREATE TABLE IF NOT EXISTS security_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      details TEXT,
      ip_or_context TEXT,
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_audit_log_user
      ON security_audit_log(user_id);
  `);
}
