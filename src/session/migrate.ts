import { readFileSync, existsSync, renameSync } from "fs";
import { join } from "path";
import { getDatabase } from "../memory/index.js";
import type { SessionEntry } from "./store.js";
import { TELECLAW_ROOT } from "../workspace/paths.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("Session");

const SESSIONS_JSON = join(TELECLAW_ROOT, "sessions.json");
const SESSIONS_JSON_BACKUP = join(TELECLAW_ROOT, "sessions.json.backup");

/**
 * Migrate sessions from JSON to SQLite.
 * Returns number of sessions migrated.
 */
export function migrateSessionsToDb(): number {
  if (!existsSync(SESSIONS_JSON)) {
    return 0;
  }

  try {
    log.info("Migrating sessions from JSON to SQLite...");

    const raw = readFileSync(SESSIONS_JSON, "utf-8");
    const store = JSON.parse(raw) as Record<string, SessionEntry>;

    const db = getDatabase().getDb();
    let migrated = 0;

    const insertStmt = db.prepare(`
      INSERT OR REPLACE INTO sessions (
        id, chat_id, started_at, updated_at, message_count,
        last_message_id, last_channel, last_to, context_tokens,
        model, provider, last_reset_date
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const [chatId, session] of Object.entries(store)) {
      insertStmt.run(
        session.sessionId,
        chatId,
        session.createdAt,
        session.updatedAt,
        session.messageCount || 0,
        session.lastMessageId || null,
        session.lastChannel || null,
        session.lastTo || null,
        session.contextTokens || null,
        session.model || null,
        session.provider || null,
        session.lastResetDate || null
      );
      migrated++;
    }

    renameSync(SESSIONS_JSON, SESSIONS_JSON_BACKUP);

    log.info(`Migrated ${migrated} sessions to SQLite`);
    log.info(`Backup saved: ${SESSIONS_JSON_BACKUP}`);

    return migrated;
  } catch (error) {
    log.error({ err: error }, "Failed to migrate sessions");
    return 0;
  }
}
