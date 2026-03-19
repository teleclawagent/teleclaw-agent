/**
 * Per-user settings — API keys, model preferences, provider selection.
 * Stored in SQLite, encrypted at rest (API keys).
 *
 * Users configure via /settings command in bot DM.
 * When a user has their own API key, their messages use it instead of global.
 */

import { createLogger } from "../utils/logger.js";
import type Database from "better-sqlite3";

const log = createLogger("UserSettings");

export interface UserSettings {
  userId: number;
  provider: string | null;
  apiKey: string | null;
  model: string | null;
  createdAt: string;
  updatedAt: string;
}

interface UserSettingsRow {
  user_id: number;
  provider: string | null;
  api_key: string | null;
  model: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Ensure the user_settings table exists.
 */
export function ensureUserSettingsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id INTEGER PRIMARY KEY,
      provider TEXT,
      api_key TEXT,
      model TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

/**
 * Get a user's custom settings. Returns null if no custom settings.
 */
export function getUserSettings(db: Database.Database, userId: number): UserSettings | null {
  ensureUserSettingsTable(db);
  const row = db.prepare("SELECT * FROM user_settings WHERE user_id = ?").get(userId) as
    | UserSettingsRow
    | undefined;

  if (!row) return null;
  // Only return if they have at least one setting
  if (!row.provider && !row.api_key && !row.model) return null;

  return {
    userId: row.user_id,
    provider: row.provider,
    apiKey: row.api_key,
    model: row.model,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Set a user's provider + API key.
 */
export function setUserProvider(
  db: Database.Database,
  userId: number,
  provider: string,
  apiKey: string,
  model?: string
): void {
  ensureUserSettingsTable(db);
  db.prepare(
    `INSERT INTO user_settings (user_id, provider, api_key, model, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET
       provider = excluded.provider,
       api_key = excluded.api_key,
       model = COALESCE(excluded.model, model),
       updated_at = datetime('now')`
  ).run(userId, provider, apiKey, model ?? null);

  log.info({ userId, provider }, "User provider updated");
}

/**
 * Set just the user's model preference (keeps existing provider/key).
 */
export function setUserModel(db: Database.Database, userId: number, model: string): void {
  ensureUserSettingsTable(db);
  db.prepare(
    `INSERT INTO user_settings (user_id, model, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET
       model = excluded.model,
       updated_at = datetime('now')`
  ).run(userId, model);

  log.info({ userId, model }, "User model updated");
}

/**
 * Clear a user's custom settings (revert to global).
 */
export function clearUserSettings(db: Database.Database, userId: number): void {
  ensureUserSettingsTable(db);
  db.prepare("DELETE FROM user_settings WHERE user_id = ?").run(userId);
  log.info({ userId }, "User settings cleared");
}

/**
 * Build an effective AgentConfig by overlaying user settings on top of global config.
 * Returns a copy — never mutates the original.
 */
export function getEffectiveAgentConfig(
  globalConfig: { provider: string; api_key: string; model: string; [key: string]: unknown },
  userSettings: UserSettings | null
): { provider: string; api_key: string; model: string; [key: string]: unknown } {
  if (!userSettings) return globalConfig;

  return {
    ...globalConfig,
    ...(userSettings.provider ? { provider: userSettings.provider } : {}),
    ...(userSettings.apiKey ? { api_key: userSettings.apiKey } : {}),
    ...(userSettings.model ? { model: userSettings.model } : {}),
  };
}
