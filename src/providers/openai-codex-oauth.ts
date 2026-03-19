/**
 * OpenAI Codex OAuth Flow
 * 
 * Reads OAuth tokens from local Codex CLI installation.
 * If user has ChatGPT Plus/Pro, Codex CLI can authenticate via OAuth
 * and we read those tokens — similar to claude-code-credentials.
 */

import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { createLogger } from "../utils/logger.js";

const log = createLogger("OpenAICodexOAuth");

interface CodexCredentials {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
}

const CODEX_CONFIG_PATHS = [
  join(homedir(), ".codex", "credentials.json"),
  join(homedir(), ".codex", ".credentials.json"),
];

// ── Read Codex Credentials ─────────────────────────────────────────

function readCodexCredentials(): CodexCredentials | null {
  for (const path of CODEX_CONFIG_PATHS) {
    if (!existsSync(path)) continue;
    try {
      const raw = readFileSync(path, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed.access_token) return parsed;
      // OpenAI stores it nested sometimes
      if (parsed.openai?.access_token) return parsed.openai;
    } catch {
      continue;
    }
  }
  return null;
}

// ── Public API ─────────────────────────────────────────────────────

export function isCodexOAuthConfigured(): boolean {
  const creds = readCodexCredentials();
  return creds !== null && !!creds.access_token;
}

export function isCodexTokenValid(): boolean {
  const creds = readCodexCredentials();
  if (!creds?.access_token) return false;
  if (creds.expires_at && Date.now() > creds.expires_at * 1000) return false;
  return true;
}

/**
 * Get the Codex OAuth access token.
 * Throws if not configured.
 */
export function getCodexOAuthToken(fallbackKey?: string): string {
  const creds = readCodexCredentials();
  
  if (creds?.access_token) {
    log.debug("Using Codex OAuth token");
    return creds.access_token;
  }

  if (fallbackKey && fallbackKey.trim().length > 0) {
    log.debug("Codex OAuth not found, using fallback API key");
    return fallbackKey;
  }

  throw new Error(
    "OpenAI Codex credentials not found. Install Codex CLI and run 'codex login', " +
    "or provide an API key manually."
  );
}
