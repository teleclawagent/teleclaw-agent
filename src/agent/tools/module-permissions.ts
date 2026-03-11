import type Database from "better-sqlite3";

export type ModuleLevel = "open" | "admin" | "disabled";

const PROTECTED_MODULES = new Set(["telegram", "memory"]);

/**
 * Per-group module permission manager.
 * Only non-default overrides (level !== "open") are stored in DB.
 */
export class ModulePermissions {
  private db: Database.Database;
  private cache: Map<string, Map<string, ModuleLevel>> = new Map();

  constructor(db: Database.Database) {
    this.db = db;
    this.ensureTable();
    this.loadAll();
  }

  private ensureTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS group_modules (
        chat_id    TEXT NOT NULL,
        module     TEXT NOT NULL,
        level      TEXT NOT NULL CHECK(level IN ('open', 'admin', 'disabled')),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_by INTEGER,
        PRIMARY KEY (chat_id, module)
      )
    `);
  }

  private loadAll(): void {
    const rows = this.db
      .prepare("SELECT chat_id, module, level FROM group_modules")
      .all() as Array<{ chat_id: string; module: string; level: ModuleLevel }>;

    for (const row of rows) {
      let chatMap = this.cache.get(row.chat_id);
      if (!chatMap) {
        chatMap = new Map();
        this.cache.set(row.chat_id, chatMap);
      }
      chatMap.set(row.module, row.level);
    }
  }

  getLevel(chatId: string, module: string): ModuleLevel {
    return this.cache.get(chatId)?.get(module) ?? "open";
  }

  setLevel(chatId: string, module: string, level: ModuleLevel, userId?: number): void {
    if (PROTECTED_MODULES.has(module)) {
      throw new Error(`Module "${module}" is protected`);
    }

    if (level === "open") {
      this.db
        .prepare("DELETE FROM group_modules WHERE chat_id = ? AND module = ?")
        .run(chatId, module);
      this.cache.get(chatId)?.delete(module);
    } else {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO group_modules (chat_id, module, level, updated_at, updated_by)
           VALUES (?, ?, ?, unixepoch(), ?)`
        )
        .run(chatId, module, level, userId ?? null);

      let chatMap = this.cache.get(chatId);
      if (!chatMap) {
        chatMap = new Map();
        this.cache.set(chatId, chatMap);
      }
      chatMap.set(module, level);
    }
  }

  resetModule(chatId: string, module: string): void {
    this.db
      .prepare("DELETE FROM group_modules WHERE chat_id = ? AND module = ?")
      .run(chatId, module);
    this.cache.get(chatId)?.delete(module);
  }

  resetAll(chatId: string): void {
    this.db.prepare("DELETE FROM group_modules WHERE chat_id = ?").run(chatId);
    this.cache.delete(chatId);
  }

  getOverrides(chatId: string): Map<string, ModuleLevel> {
    return this.cache.get(chatId) ?? new Map();
  }

  isProtected(module: string): boolean {
    return PROTECTED_MODULES.has(module);
  }
}
