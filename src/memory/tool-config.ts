import type Database from "better-sqlite3";
import type { ToolScope } from "../agent/tools/types.js";

export interface ToolConfig {
  toolName: string;
  enabled: boolean;
  scope: ToolScope | null; // null = use default from tool definition
  updatedAt: number;
  updatedBy: number | null;
}

/**
 * Load tool configuration from database
 */
export function loadToolConfig(db: Database.Database, toolName: string): ToolConfig | null {
  const row = db
    .prepare(
      `SELECT tool_name, enabled, scope, updated_at, updated_by
       FROM tool_config
       WHERE tool_name = ?`
    )
    .get(toolName) as
    | {
        tool_name: string;
        enabled: number;
        scope: ToolScope | null;
        updated_at: number;
        updated_by: number | null;
      }
    | undefined;

  if (!row) return null;

  return {
    toolName: row.tool_name,
    enabled: row.enabled === 1,
    scope: row.scope,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

/**
 * Load all tool configurations from database
 */
export function loadAllToolConfigs(db: Database.Database): Map<string, ToolConfig> {
  const rows = db
    .prepare(
      `SELECT tool_name, enabled, scope, updated_at, updated_by
       FROM tool_config`
    )
    .all() as Array<{
    tool_name: string;
    enabled: number;
    scope: ToolScope | null;
    updated_at: number;
    updated_by: number | null;
  }>;

  const configs = new Map<string, ToolConfig>();
  for (const row of rows) {
    configs.set(row.tool_name, {
      toolName: row.tool_name,
      enabled: row.enabled === 1,
      scope: row.scope,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
    });
  }
  return configs;
}

/**
 * Save or update tool configuration
 */
export function saveToolConfig(
  db: Database.Database,
  toolName: string,
  enabled: boolean,
  scope: ToolScope | null,
  updatedBy?: number
): void {
  db.prepare(
    `INSERT INTO tool_config (tool_name, enabled, scope, updated_at, updated_by)
     VALUES (?, ?, ?, unixepoch(), ?)
     ON CONFLICT(tool_name) DO UPDATE SET
       enabled = excluded.enabled,
       scope = excluded.scope,
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by`
  ).run(toolName, enabled ? 1 : 0, scope, updatedBy ?? null);
}

/**
 * Initialize tool config for a tool if not exists (seed from defaults)
 */
export function initializeToolConfig(
  db: Database.Database,
  toolName: string,
  defaultEnabled: boolean,
  defaultScope: ToolScope
): void {
  const existing = loadToolConfig(db, toolName);
  if (!existing) {
    db.prepare(
      `INSERT INTO tool_config (tool_name, enabled, scope, updated_at, updated_by)
       VALUES (?, ?, ?, unixepoch(), NULL)`
    ).run(toolName, defaultEnabled ? 1 : 0, defaultScope);
  }
}

/**
 * Delete tool configuration (reverts to defaults)
 */
export function deleteToolConfig(db: Database.Database, toolName: string): void {
  db.prepare(`DELETE FROM tool_config WHERE tool_name = ?`).run(toolName);
}
