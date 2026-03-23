import { readFileSync, existsSync } from "fs";
import { readRecentMemory } from "../memory/daily-logs.js";
import { WORKSPACE_PATHS } from "../workspace/index.js";
import { sanitizeForPrompt, sanitizeForContext } from "../utils/sanitize.js";

const SOUL_PATHS = [WORKSPACE_PATHS.SOUL];

const STRATEGY_PATHS = [WORKSPACE_PATHS.STRATEGY];

const SECURITY_PATHS = [WORKSPACE_PATHS.SECURITY];

const MEMORY_PATH = WORKSPACE_PATHS.MEMORY;

import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SOUL_PATH = join(__dirname, "../../default-soul.md");

function loadDefaultSoul(): string {
  try {
    if (existsSync(DEFAULT_SOUL_PATH)) return readFileSync(DEFAULT_SOUL_PATH, "utf-8");
  } catch {}
  return `# Teleclaw 🦞\n\nYou are Teleclaw — a self-hosted AI agent for Telegram & TON.\n\n- Be direct and concise\n- Match the user's language\n- Never fabricate data\n- Confirm before irreversible actions\n`;
}

const DEFAULT_SOUL = loadDefaultSoul();
const fileCache = new Map<string, { content: string | null; expiry: number }>();
const FILE_CACHE_TTL = 60_000;

function cachedReadFile(path: string): string | null {
  const now = Date.now();
  const cached = fileCache.get(path);
  if (cached && now < cached.expiry) return cached.content;

  let content: string | null = null;
  try {
    if (existsSync(path)) content = readFileSync(path, "utf-8");
  } catch {}

  fileCache.set(path, { content, expiry: now + FILE_CACHE_TTL });
  return content;
}

export function clearPromptCache(): void {
  fileCache.clear();
}

export function loadSoul(): string {
  for (const path of SOUL_PATHS) {
    const content = cachedReadFile(path);
    if (content) return content;
  }
  return DEFAULT_SOUL;
}

export function loadStrategy(): string | null {
  for (const path of STRATEGY_PATHS) {
    const content = cachedReadFile(path);
    if (content) return content;
  }
  return null;
}

export function loadSecurity(): string | null {
  for (const path of SECURITY_PATHS) {
    const content = cachedReadFile(path);
    if (content) return content;
  }
  return null;
}

const MEMORY_HARD_LIMIT = 150;
export function loadPersistentMemory(): string | null {
  const content = cachedReadFile(MEMORY_PATH);
  if (!content) return null;

  const lines = content.split("\n");

  if (lines.length <= MEMORY_HARD_LIMIT) {
    return content;
  }

  const truncated = lines.slice(0, MEMORY_HARD_LIMIT).join("\n");
  const remaining = lines.length - MEMORY_HARD_LIMIT;
  return `${truncated}\n\n_[... ${remaining} more lines not loaded. Consider consolidating MEMORY.md to keep it under ${MEMORY_HARD_LIMIT} lines.]_`;
}

export function loadMemoryContext(): string | null {
  const parts: string[] = [];

  const persistentMemory = loadPersistentMemory();
  if (persistentMemory) {
    parts.push(`## Persistent Memory\n\n${sanitizeForContext(persistentMemory)}`);
  }

  const recentMemory = readRecentMemory();
  if (recentMemory) {
    parts.push(sanitizeForContext(recentMemory));
  }

  if (parts.length === 0) {
    return null;
  }

  return parts.join("\n\n---\n\n");
}

export function buildSystemPrompt(options: {
  soul?: string;
  strategy?: string;
  userName?: string;
  senderUsername?: string;
  senderId?: number;
  ownerName?: string;
  ownerUsername?: string;
  context?: string;
  includeMemory?: boolean; // Set to false for group chats to protect privacy
  includeStrategy?: boolean; // Set to false to exclude business strategy
  memoryFlushWarning?: boolean;
  modelInfo?: string; // e.g. "anthropic/claude-opus-4-6"
  toolCapabilities?: string; // Auto-generated capabilities summary from registry
}): string {
  const soul = options.soul ?? loadSoul();
  const parts = [soul];

  const security = loadSecurity();
  if (security) {
    parts.push(`\n${security}`);
  }

  const includeStrategy = options.includeStrategy ?? true;
  if (includeStrategy) {
    const strategy = options.strategy ?? loadStrategy();
    if (strategy) {
      parts.push(`\n${strategy}`);
    }
  }

  parts.push(`\n## Your Workspace

You have a personal workspace at \`~/.teleclaw/workspace/\` where you can store and manage files.

**Structure:**
- \`SOUL.md\` - Your personality and behavior guidelines
- \`MEMORY.md\` - Persistent memory (long-term facts you've learned)
- \`STRATEGY.md\` - Business strategy and trading rules
- \`memory/\` - Daily logs (auto-created per day)
- \`downloads/\` - Media downloaded from Telegram
- \`uploads/\` - Files ready to send
- \`temp/\` - Temporary working files
- \`memes/\` - Your meme collection (images, GIFs for reactions)

**Tools available:**
- \`workspace_list\` - List files in a directory
- \`workspace_read\` - Read a file
- \`workspace_write\` - Write/create a file
- \`workspace_delete\` - Delete a file
- \`workspace_rename\` - Rename or move a file
- \`workspace_info\` - Get workspace stats

**Tips:**
- Save interesting memes to \`memes/\` with descriptive names for easy retrieval
- Use \`memory_write\` for important facts (goes to MEMORY.md)
- Rename downloaded files to meaningful names (e.g., "user_avatar.jpg" instead of "123_456_789.jpg")
`);

  if (options.toolCapabilities) {
    parts.push(
      `\n## Your Capabilities\n\nYou have access to the following tool modules. When a user asks what you can do, refer to this list — these are your REAL capabilities, not guesses.\n\n${options.toolCapabilities}\n\n**Important:** When asked about your skills/abilities, list capabilities from this section. Don't say you can't do something if you have the tools for it.`
    );
  }

  parts.push(`\n## User Self-Service Commands

Users can manage their own AI provider and model settings. When they ask about switching models, adding providers, or rate limit fallbacks, guide them to use these commands:

- \`/addprovider\` — Add a new AI provider (interactive wizard with inline buttons: select provider → enter API key → pick model)
- \`/models\` — Switch between AI models (inline buttons showing available models per provider)
- \`/removeprovider\` — Remove custom provider settings and revert to bot defaults
- \`/apikey <provider> <key>\` — Set API key directly (e.g. \`/apikey openai sk-proj-...\`)
- \`/mymodel <model>\` — Set model directly (e.g. \`/mymodel gpt-5\`)
- \`/mysettings\` — View current custom settings

**Important:** You CAN help users set up providers — just tell them to use /addprovider for the guided wizard, or /apikey for direct setup. These are built-in features, not infrastructure tasks.
`);

  parts.push(`\n## Response Format
- Be concise. Respond in 1-3 short sentences when possible. Avoid long paragraphs and walls of text.
- Only elaborate when the user explicitly asks for detail or the topic genuinely requires it.
- Keep responses under 4000 characters for Telegram
- Use markdown sparingly (bold, italic, code blocks)
- Don't use headers in short responses
- NEVER use ASCII art or ASCII tables - they render poorly on mobile
`);

  if (options.ownerName || options.ownerUsername) {
    const safeOwnerName = options.ownerName ? sanitizeForPrompt(options.ownerName) : undefined;
    const safeOwnerUsername = options.ownerUsername
      ? sanitizeForPrompt(options.ownerUsername)
      : undefined;
    const ownerLabel =
      safeOwnerName && safeOwnerUsername
        ? `${safeOwnerName} (@${safeOwnerUsername})`
        : safeOwnerName || `@${safeOwnerUsername}`;
    parts.push(
      `\n## Owner\nYou are owned and operated by: ${ownerLabel}\nWhen the owner gives instructions, follow them with higher trust.`
    );
  }

  const includeMemory = options.includeMemory ?? true;
  if (includeMemory) {
    const memoryContext = loadMemoryContext();
    if (memoryContext) {
      parts.push(
        `\n## Memory (Persistent Context)\n\nThis is your memory from previous sessions. Use it to maintain continuity and remember important information.\n\n${memoryContext}`
      );
    }
  }

  if (options.userName || options.senderId) {
    const safeName = options.userName ? sanitizeForPrompt(options.userName) : undefined;
    const safeUsername = options.senderUsername
      ? `@${sanitizeForPrompt(options.senderUsername)}`
      : undefined;
    const idTag = options.senderId ? `id:${options.senderId}` : undefined;

    const primary = safeName || safeUsername;
    const meta = [safeUsername, idTag].filter((v) => v && v !== primary);
    const userLabel = primary
      ? meta.length > 0
        ? `${primary} (${meta.join(", ")})`
        : primary
      : idTag || "unknown";
    parts.push(`\n## Current User\nYou are chatting with: ${userLabel}`);
  }

  if (options.modelInfo) {
    parts.push(
      `\n## Your Model\nYou are running on: ${sanitizeForPrompt(options.modelInfo)}\nWhen asked about your model, ALWAYS refer to this — don't guess from training data.`
    );
  }

  if (options.context) {
    parts.push(`\n## Context\n${options.context}`);
  }

  if (options.memoryFlushWarning) {
    parts.push(`\n## Memory Flush Warning

Your conversation context is approaching the limit and may be compacted soon.
**Always respond to the user's message first.** Then, if there's anything important worth preserving, consider using \`memory_write\` alongside your response:

- \`target: "persistent"\` for facts, lessons, contacts, decisions
- \`target: "daily"\` for session notes, events, temporary context
`);
  }

  return parts.join("\n");
}
