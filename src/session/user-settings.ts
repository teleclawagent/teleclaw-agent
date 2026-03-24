/**
 * src/session/user-settings.ts  — TAM REPLACEMENT
 *
 * Mevcut dosyayı bu dosya ile değiştir.
 * Tek değişiklik: api_key plaintext → AES-256-GCM encrypted.
 *
 * Gereksinim: TELECLAW_ENCRYPT_SECRET env var (64 hex char = 32 byte)
 * Setup wizard bunu otomatik üretir ve ~/.teleclaw/.env'e yazar.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { createLogger } from "../utils/logger.js";
import type Database from "better-sqlite3";

const log = createLogger("UserSettings");

// ── Encryption ─────────────────────────────────────────────────────────────

const ALGO = "aes-256-gcm";
const IV_LEN = 12;

function getKey(): Buffer {
  const hex = process.env.TELECLAW_ENCRYPT_SECRET;
  if (!hex || hex.length !== 64) {
    throw new Error(
      "TELECLAW_ENCRYPT_SECRET env var eksik veya hatalı.\n" +
        "Setup wizard bunu otomatik oluşturur. Manuel için:\n" +
        "  node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"\n" +
        "  export TELECLAW_ENCRYPT_SECRET=<sonuç>"
    );
  }
  return Buffer.from(hex, "hex");
}

export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${ct.toString("hex")}`;
}

export function decrypt(encoded: string): string {
  const key = getKey();
  const parts = encoded.split(":");
  if (parts.length !== 3) throw new Error("Geçersiz şifreli format");
  const [ivH, tagH, ctH] = parts;
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivH, "hex"));
  decipher.setAuthTag(Buffer.from(tagH, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(ctH, "hex")), decipher.final()]).toString(
    "utf8"
  );
}

// ── Schema ──────────────────────────────────────────────────────────────────

export function ensureUserSettingsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id    INTEGER PRIMARY KEY,
      provider   TEXT,
      api_key    TEXT,
      model      TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Mevcut plaintext api_key değerlerini şifrele (one-time migration)
  _migrateToEncrypted(db);
}

function _migrateToEncrypted(db: Database.Database): void {
  const cols = (db.pragma("table_info(user_settings)") as { name: string }[]).map((r) => r.name);

  if (!cols.includes("api_key")) return;

  const rows = db
    .prepare(
      "SELECT user_id, api_key FROM user_settings WHERE api_key IS NOT NULL AND api_key != ''"
    )
    .all() as { user_id: number; api_key: string }[];

  for (const row of rows) {
    // Zaten şifreli mi? (iv:tag:ct formatı = 2 colon)
    if (row.api_key.split(":").length === 3) continue;

    try {
      const enc = encrypt(row.api_key);
      db.prepare("UPDATE user_settings SET api_key = ? WHERE user_id = ?").run(enc, row.user_id);
      log.info({ userId: row.user_id }, "API key şifrelendi");
    } catch (e) {
      log.warn({ userId: row.user_id, err: e }, "API key şifreleme başarısız");
    }
  }
}

// ── Types ───────────────────────────────────────────────────────────────────

export interface UserSettings {
  userId: number;
  provider: string | null;
  apiKey: string | null; // read sırasında decrypt edilmiş
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

// ── Read ────────────────────────────────────────────────────────────────────

export function getUserSettings(db: Database.Database, userId: number): UserSettings | null {
  ensureUserSettingsTable(db);

  const row = db.prepare("SELECT * FROM user_settings WHERE user_id = ?").get(userId) as
    | UserSettingsRow
    | undefined;

  if (!row) return null;
  if (!row.provider && !row.api_key && !row.model) return null;

  let apiKey: string | null = null;
  if (row.api_key) {
    try {
      apiKey = decrypt(row.api_key);
    } catch {
      log.warn({ userId }, "API key decrypt edilemedi (yanlış secret veya bozuk veri)");
    }
  }

  return {
    userId: row.user_id,
    provider: row.provider,
    apiKey,
    model: row.model,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── Write ───────────────────────────────────────────────────────────────────

export function setUserProvider(
  db: Database.Database,
  userId: number,
  provider: string,
  apiKey: string,
  model?: string
): void {
  ensureUserSettingsTable(db);

  const encryptedKey = encrypt(apiKey);

  db.prepare(
    `INSERT INTO user_settings (user_id, provider, api_key, model, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET
       provider   = excluded.provider,
       api_key    = excluded.api_key,
       model      = COALESCE(excluded.model, model),
       updated_at = datetime('now')`
  ).run(userId, provider, encryptedKey, model ?? null);

  log.info({ userId, provider }, "Kullanıcı provider güncellendi (key şifrelendi)");
}

export function setUserModel(db: Database.Database, userId: number, model: string): void {
  ensureUserSettingsTable(db);

  db.prepare(
    `INSERT INTO user_settings (user_id, model, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET
       model      = excluded.model,
       updated_at = datetime('now')`
  ).run(userId, model);

  log.info({ userId, model }, "Kullanıcı model güncellendi");
}

export function clearUserSettings(db: Database.Database, userId: number): void {
  ensureUserSettingsTable(db);
  db.prepare("DELETE FROM user_settings WHERE user_id = ?").run(userId);
  log.info({ userId }, "Kullanıcı ayarları temizlendi");
}

// ── Config overlay ──────────────────────────────────────────────────────────

/**
 * Kullanıcının kişisel ayarlarını global config'in üzerine uygular.
 * AgentRuntime.getEffectiveAgentConfig() tarafından çağrılır.
 */
export function getEffectiveAgentConfig(
  globalConfig: { provider: string; api_key: string; model: string; [k: string]: unknown },
  userSettings: UserSettings | null
): typeof globalConfig {
  if (!userSettings) return globalConfig;

  return {
    ...globalConfig,
    ...(userSettings.provider ? { provider: userSettings.provider } : {}),
    ...(userSettings.apiKey ? { api_key: userSettings.apiKey } : {}),
    ...(userSettings.model ? { model: userSettings.model } : {}),
  };
}
