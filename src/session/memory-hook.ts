import { writeFile, mkdir, readdir, readFile, unlink } from "fs/promises";
import { join } from "path";
import { complete, type Context } from "@mariozechner/pi-ai";
import {
  summarizeViaClaude,
  summarizeWithFallback,
  formatMessagesForSummary,
} from "../memory/ai-summarization.js";
import { getUtilityModel } from "../agent/client.js";
import type { SupportedProvider } from "../config/providers.js";
import { createLogger } from "../utils/logger.js";
import {
  SESSION_SLUG_RECENT_MESSAGES,
  SESSION_SLUG_MAX_TOKENS,
  DEFAULT_MAX_SUMMARY_TOKENS,
  DEFAULT_CONTEXT_WINDOW,
} from "../constants/limits.js";

const log = createLogger("Session");

/**
 * Generate a semantic slug for a session using LLM.
 * Creates a short, descriptive identifier based on conversation content.
 */
async function generateSlugViaClaude(params: {
  messages: Context["messages"];
  apiKey: string;
  provider?: SupportedProvider;
  utilityModel?: string;
}): Promise<string> {
  const provider = params.provider || "anthropic";
  const model = getUtilityModel(provider, params.utilityModel);

  const formatted = formatMessagesForSummary(params.messages.slice(-SESSION_SLUG_RECENT_MESSAGES));

  if (!formatted.trim()) {
    return "empty-session";
  }

  try {
    const context: Context = {
      messages: [
        {
          role: "user",
          content: `Generate a short, descriptive slug (2-4 words, kebab-case) for this conversation.
Examples: "gift-transfer-fix", "context-overflow-debug", "telegram-integration"

Conversation:
${formatted}

Slug:`,
          timestamp: Date.now(),
        },
      ],
    };

    const response = await complete(model, context, {
      apiKey: params.apiKey,
      maxTokens: SESSION_SLUG_MAX_TOKENS,
    });

    const textContent = response.content.find((block) => block.type === "text");
    const slug = textContent?.type === "text" ? textContent.text.trim() : "";

    return (
      slug
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, "")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .slice(0, 50) || "session"
    );
  } catch (error) {
    log.warn({ err: error }, "Slug generation failed, using fallback");
    const now = new Date();
    return `session-${now.getHours().toString().padStart(2, "0")}${now.getMinutes().toString().padStart(2, "0")}`;
  }
}

/**
 * Save session memory to dated markdown file.
 * Creates audit trail of session transitions for human review.
 */
export async function saveSessionMemory(params: {
  oldSessionId: string;
  newSessionId: string;
  context: Context;
  chatId: string;
  apiKey: string;
  provider?: SupportedProvider;
  utilityModel?: string;
}): Promise<void> {
  try {
    const { TELECLAW_ROOT } = await import("../workspace/paths.js");
    const memoryDir = join(TELECLAW_ROOT, "memory");
    await mkdir(memoryDir, { recursive: true });

    const now = new Date();
    const dateStr = now.toISOString().split("T")[0];

    log.info("Generating semantic slug for session memory...");
    const slug = await generateSlugViaClaude({
      messages: params.context.messages,
      apiKey: params.apiKey,
      provider: params.provider,
      utilityModel: params.utilityModel,
    });

    const filename = `${dateStr}-${slug}.md`;
    const filepath = join(memoryDir, filename);

    const timeStr = now.toISOString().split("T")[1].split(".")[0];

    log.info("Generating session summary...");
    let summary: string;
    try {
      summary = await summarizeViaClaude({
        messages: params.context.messages,
        apiKey: params.apiKey,
        maxSummaryTokens: DEFAULT_MAX_SUMMARY_TOKENS,
        customInstructions:
          "Summarize this session comprehensively. Include key topics, decisions made, problems solved, and important context.",
        provider: params.provider,
        utilityModel: params.utilityModel,
      });
    } catch (error) {
      log.warn({ err: error }, "Session summary generation failed");
      summary = `Session contained ${params.context.messages.length} messages. Summary generation failed.`;
    }

    const content = `# Session Memory: ${dateStr} ${timeStr} UTC

## Metadata

- **Old Session ID**: \`${params.oldSessionId}\`
- **New Session ID**: \`${params.newSessionId}\`
- **Chat ID**: \`${params.chatId}\`
- **Timestamp**: ${now.toISOString()}
- **Message Count**: ${params.context.messages.length}

## Session Summary

${summary}

## Context

This session was compacted and migrated to a new session ID. The summary above preserves key information for continuity.

---

*Generated automatically by Teleclaw-AI session memory hook*
`;

    await writeFile(filepath, content, "utf-8");

    const relPath = filepath.replace(TELECLAW_ROOT, "~/.teleclaw");
    log.info(`Session memory saved: ${relPath}`);
  } catch (error) {
    log.error({ err: error }, "Failed to save session memory");
  }
}

const CONSOLIDATION_THRESHOLD = 20;
const CONSOLIDATION_BATCH = 10;

/**
 * Consolidate old session memory files when they exceed a threshold.
 * Reads the oldest session files, LLM-summarizes them into a single file,
 * and deletes the originals to prevent unbounded accumulation.
 */
export async function consolidateOldMemoryFiles(params: {
  apiKey: string;
  provider?: SupportedProvider;
  utilityModel?: string;
}): Promise<{ consolidated: number }> {
  try {
    const { TELECLAW_ROOT } = await import("../workspace/paths.js");
    const memoryDir = join(TELECLAW_ROOT, "memory");

    let entries: string[];
    try {
      entries = await readdir(memoryDir);
    } catch {
      return { consolidated: 0 };
    }

    // Session files match YYYY-MM-DD-slug.md (not plain YYYY-MM-DD.md daily logs)
    const sessionFiles = entries
      .filter((f) => /^\d{4}-\d{2}-\d{2}-.+\.md$/.test(f) && !f.startsWith("consolidated-"))
      .sort();

    if (sessionFiles.length < CONSOLIDATION_THRESHOLD) {
      return { consolidated: 0 };
    }

    const batch = sessionFiles.slice(0, CONSOLIDATION_BATCH);
    log.info(`Consolidating ${batch.length} old session memory files...`);

    const contents: string[] = [];
    for (const file of batch) {
      const text = await readFile(join(memoryDir, file), "utf-8");
      contents.push(`--- ${file} ---\n${text}`);
    }

    const combined = contents.join("\n\n");
    let summary: string;
    try {
      const result = await summarizeWithFallback({
        messages: [{ role: "user", content: combined, timestamp: Date.now() }],
        apiKey: params.apiKey,
        contextWindow: DEFAULT_CONTEXT_WINDOW,
        maxSummaryTokens: DEFAULT_MAX_SUMMARY_TOKENS,
        customInstructions:
          "Consolidate these session memories into a single comprehensive summary. Preserve key facts, decisions, patterns, and important context. Remove redundancy. Organize by topic.",
        provider: params.provider,
        utilityModel: params.utilityModel,
      });
      summary = result.summary;
    } catch (error) {
      log.warn({ err: error }, "Consolidation summary failed, skipping");
      return { consolidated: 0 };
    }

    const dateOf = (f: string) => f.slice(0, 10);
    const dateRange = `${dateOf(batch[0])}_to_${dateOf(batch[batch.length - 1])}`;
    const outFile = `consolidated-${dateRange}.md`;
    const outContent = `# Consolidated Session Memories

## Period
${batch[0]} → ${batch[batch.length - 1]}

## Summary

${summary}

---

*Consolidated from ${batch.length} session files by Teleclaw memory consolidation*
`;

    await writeFile(join(memoryDir, outFile), outContent, "utf-8");

    for (const file of batch) {
      await unlink(join(memoryDir, file));
    }

    log.info(`Consolidated ${batch.length} files → ${outFile}`);
    return { consolidated: batch.length };
  } catch (error) {
    log.error({ err: error }, "Memory consolidation failed");
    return { consolidated: 0 };
  }
}
