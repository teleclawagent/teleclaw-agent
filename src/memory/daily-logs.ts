import { existsSync, mkdirSync, appendFileSync, readFileSync } from "fs";
import { join } from "path";
import { WORKSPACE_PATHS } from "../workspace/index.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("Memory");

const MEMORY_DIR = WORKSPACE_PATHS.MEMORY_DIR;

function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function getDailyLogPath(date: Date = new Date()): string {
  return join(MEMORY_DIR, `${formatDate(date)}.md`);
}

function ensureMemoryDir(): void {
  if (!existsSync(MEMORY_DIR)) {
    mkdirSync(MEMORY_DIR, { recursive: true });
  }
}

export function appendToDailyLog(content: string, date: Date = new Date()): void {
  try {
    ensureMemoryDir();

    const logPath = getDailyLogPath(date);
    const timestamp = date.toLocaleTimeString("en-US", { hour12: false });

    if (!existsSync(logPath)) {
      const header = `# Daily Log - ${formatDate(date)}\n\n`;
      appendFileSync(logPath, header, { encoding: "utf-8", mode: 0o600 });
    }

    const entry = `## ${timestamp}\n\n${content}\n\n---\n\n`;
    appendFileSync(logPath, entry, "utf-8");

    log.info(`Daily log updated: ${logPath}`);
  } catch (error) {
    log.error({ err: error }, "Failed to write daily log");
  }
}

export function readDailyLog(date: Date = new Date()): string | null {
  try {
    const logPath = getDailyLogPath(date);
    if (!existsSync(logPath)) return null;
    return readFileSync(logPath, "utf-8");
  } catch {
    return null;
  }
}

const DAILY_LOG_LINE_LIMIT = 100;

/**
 * Truncate daily log to most recent entries within line limit.
 */
function truncateDailyLog(content: string): string {
  const lines = content.split("\n");
  if (lines.length <= DAILY_LOG_LINE_LIMIT) return content;

  const truncated = lines.slice(-DAILY_LOG_LINE_LIMIT).join("\n");
  const dropped = lines.length - DAILY_LOG_LINE_LIMIT;
  return `_[... ${dropped} earlier lines omitted]_\n\n${truncated}`;
}

/**
 * Read recent daily logs (today + yesterday) for memory context.
 * Each log is truncated to DAILY_LOG_LINE_LIMIT lines.
 */
export function readRecentMemory(): string | null {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const parts: string[] = [];

  const yesterdayLog = readDailyLog(yesterday);
  if (yesterdayLog) {
    parts.push(`## Yesterday (${formatDate(yesterday)})\n\n${truncateDailyLog(yesterdayLog)}`);
  }

  const todayLog = readDailyLog(today);
  if (todayLog) {
    parts.push(`## Today (${formatDate(today)})\n\n${truncateDailyLog(todayLog)}`);
  }

  if (parts.length === 0) {
    return null;
  }

  return `# Recent Memory\n\n${parts.join("\n\n---\n\n")}`;
}

export function writeSessionEndSummary(summary: string, reason: string): void {
  const content = `### Session End (${reason})\n\n${summary}`;
  appendToDailyLog(content);
}

export function writeSummaryToDailyLog(summary: string): void {
  appendToDailyLog(`### Memory Flush (Pre-Compaction)\n\n${summary}`);
}

export function writeConversationMilestone(chatId: string, topic: string, details: string): void {
  const content = `### Conversation Milestone\n\n**Chat**: ${chatId}\n**Topic**: ${topic}\n\n${details}`;
  appendToDailyLog(content);
}
