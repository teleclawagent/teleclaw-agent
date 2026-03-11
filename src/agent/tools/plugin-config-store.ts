/**
 * Plugin config store — CRUD for plugin_config table (priority ordering).
 * Mirrors the tool_config pattern.
 */

import type Database from "better-sqlite3";

export interface PluginPriorityEntry {
  plugin_name: string;
  priority: number;
}

/**
 * Get all configured plugin priorities.
 * Returns a Map of pluginName → priority (only non-default entries).
 */
export function getPluginPriorities(db: Database.Database): Map<string, number> {
  const rows = db
    .prepare("SELECT plugin_name, priority FROM plugin_config")
    .all() as PluginPriorityEntry[];

  const map = new Map<string, number>();
  for (const row of rows) {
    map.set(row.plugin_name, row.priority);
  }
  return map;
}

/**
 * Set the global priority for a plugin. Creates or updates the entry.
 */
export function setPluginPriority(
  db: Database.Database,
  pluginName: string,
  priority: number
): void {
  db.prepare(
    `INSERT INTO plugin_config (plugin_name, priority, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(plugin_name) DO UPDATE SET
       priority = excluded.priority,
       updated_at = excluded.updated_at`
  ).run(pluginName, priority);
}

/**
 * Reset a plugin's priority back to default (removes the entry).
 */
export function resetPluginPriority(db: Database.Database, pluginName: string): void {
  db.prepare("DELETE FROM plugin_config WHERE plugin_name = ?").run(pluginName);
}
