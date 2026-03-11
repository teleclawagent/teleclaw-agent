/**
 * Journal Tools - Trading & Business Operations Logging
 *
 * Three tools for comprehensive business tracking:
 *
 * 1. journal_log - Manual logging with reasoning
 * 2. journal_query - Query and analyze entries
 * 3. journal_update - Update outcomes and P&L
 */

import { journalLogTool, journalLogExecutor } from "./log.js";
import { journalQueryTool, journalQueryExecutor } from "./query.js";
import { journalUpdateTool, journalUpdateExecutor } from "./update.js";
import type { ToolEntry } from "../types.js";

export { journalLogTool, journalLogExecutor };
export { journalQueryTool, journalQueryExecutor };
export { journalUpdateTool, journalUpdateExecutor };

export const tools: ToolEntry[] = [
  { tool: journalLogTool, executor: journalLogExecutor, scope: "dm-only" },
  { tool: journalUpdateTool, executor: journalUpdateExecutor, scope: "dm-only" },
  { tool: journalQueryTool, executor: journalQueryExecutor },
];

// Re-export types from journal-store
export type { JournalEntry, JournalType, JournalOutcome } from "../../../memory/journal-store.js";
