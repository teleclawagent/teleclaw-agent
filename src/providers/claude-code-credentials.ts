/**
 * Claude Code credential reader.
 *
 * Reads OAuth tokens from the local Claude Code installation:
 * - Linux/Windows: ~/.claude/.credentials.json
 * - macOS: Keychain (service "Claude Code-credentials") → file fallback
 *
 * Tokens are cached in memory and re-read only on expiration or forced refresh.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import { homedir } from "os";
import { join } from "path";
import { createLogger } from "../utils/logger.js";

const log = createLogger("ClaudeCodeCreds");

// ── OAuth constants (extracted from Claude Code binary) ────────────────

const OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const OAUTH_SCOPES = "user:profile user:inference user:sessions:claude_code user:mcp_servers";

// ── Types ──────────────────────────────────────────────────────────────

interface ClaudeOAuthCredentials {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    scopes?: string[];
  };
}

// ── Module-level cache ─────────────────────────────────────────────────

let cachedToken: string | null = null;
let cachedExpiresAt = 0;
let cachedRefreshToken: string | null = null;

// ── Internal helpers ───────────────────────────────────────────────────

function getClaudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

function getCredentialsFilePath(): string {
  return join(getClaudeConfigDir(), ".credentials.json");
}

/** Read credentials from ~/.claude/.credentials.json */
function readCredentialsFile(): ClaudeOAuthCredentials | null {
  const filePath = getCredentialsFilePath();
  if (!existsSync(filePath)) return null;

  try {
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as ClaudeOAuthCredentials;
  } catch (e) {
    log.warn({ err: e, path: filePath }, "Failed to parse Claude Code credentials file");
    return null;
  }
}

/** Read credentials from macOS Keychain via security CLI */
function readKeychainCredentials(): ClaudeOAuthCredentials | null {
  // Try the standard service name, then the legacy one (bug #1311)
  const serviceNames = ["Claude Code-credentials", "Claude Code"];

  for (const service of serviceNames) {
    try {
      const raw = execSync(`security find-generic-password -s "${service}" -w`, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      return JSON.parse(raw) as ClaudeOAuthCredentials;
    } catch {
      // Not found under this service name, try next
    }
  }
  return null;
}

/** Read credentials using the appropriate platform method */
function readCredentials(): ClaudeOAuthCredentials | null {
  if (process.platform === "darwin") {
    // macOS: Keychain first, file fallback
    const keychainCreds = readKeychainCredentials();
    if (keychainCreds) return keychainCreds;
    log.debug("Keychain read failed, falling back to credentials file");
  }

  return readCredentialsFile();
}

/** Extract and validate token + expiresAt from raw credentials */
function extractToken(creds: ClaudeOAuthCredentials): {
  token: string;
  expiresAt: number;
  refreshToken?: string;
} | null {
  const oauth = creds.claudeAiOauth;
  if (!oauth?.accessToken) {
    log.warn("Claude Code credentials found but missing accessToken");
    return null;
  }
  return {
    token: oauth.accessToken,
    expiresAt: oauth.expiresAt ?? 0,
    refreshToken: oauth.refreshToken,
  };
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Get the Claude Code API key with intelligent caching.
 *
 * Resolution order:
 * 1. Return cached token if still valid (Date.now() < expiresAt)
 * 2. Read from disk/Keychain and cache
 * 3. Fall back to `fallbackKey` if provided
 * 4. Throw if nothing works
 */
export function getClaudeCodeApiKey(fallbackKey?: string): string {
  // Fast path: cached and valid
  if (cachedToken && Date.now() < cachedExpiresAt) {
    return cachedToken;
  }

  // Read from disk
  const creds = readCredentials();
  if (creds) {
    const extracted = extractToken(creds);
    if (extracted) {
      cachedToken = extracted.token;
      cachedExpiresAt = extracted.expiresAt;
      cachedRefreshToken = extracted.refreshToken ?? null;
      log.debug("Claude Code credentials loaded successfully");
      return cachedToken;
    }
  }

  // Fallback to manual key
  if (fallbackKey && fallbackKey.length > 0) {
    log.warn("Claude Code credentials not found, using fallback api_key from config");
    return fallbackKey;
  }

  throw new Error("No Claude Code credentials found. Run 'claude login' or set api_key in config.");
}

/**
 * Call the Claude Code OAuth token endpoint to exchange a refresh token for a new access token.
 * On success, persists the new credentials to disk and returns the new access token.
 */
async function performOAuthRefresh(refreshToken: string): Promise<string | null> {
  try {
    const res = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: OAUTH_CLIENT_ID,
        scope: OAUTH_SCOPES,
      }),
    });

    if (!res.ok) {
      log.warn(`OAuth token refresh failed: ${res.status} ${res.statusText}`);
      return null;
    }

    const data = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };

    if (!data.access_token || !data.expires_in) {
      log.warn("OAuth token refresh: unexpected response shape");
      return null;
    }

    const newExpiresAt = Date.now() + data.expires_in * 1000;
    const newRefreshToken = data.refresh_token ?? refreshToken;

    // Persist updated credentials to disk
    const filePath = getCredentialsFilePath();
    try {
      const existing = existsSync(filePath)
        ? (JSON.parse(readFileSync(filePath, "utf-8")) as ClaudeOAuthCredentials)
        : {};
      const updated: ClaudeOAuthCredentials = {
        ...existing,
        claudeAiOauth: {
          ...existing.claudeAiOauth,
          accessToken: data.access_token,
          refreshToken: newRefreshToken,
          expiresAt: newExpiresAt,
        },
      };
      writeFileSync(filePath, JSON.stringify(updated, null, 2), { mode: 0o600 });
    } catch (e) {
      log.warn({ err: e }, "Failed to persist refreshed OAuth credentials to disk");
    }

    // Update in-memory cache
    cachedToken = data.access_token;
    cachedExpiresAt = newExpiresAt;
    cachedRefreshToken = newRefreshToken;

    log.info("Claude Code OAuth token refreshed successfully");
    return cachedToken;
  } catch (e) {
    log.warn({ err: e }, "OAuth token refresh request failed");
    return null;
  }
}

/**
 * Force credential refresh (called on 401).
 * First attempts OAuth refresh via the refresh token, then falls back to re-reading disk.
 * Returns the new token or null if unavailable.
 */
export async function refreshClaudeCodeApiKey(): Promise<string | null> {
  // Clear access token cache (keep refresh token for OAuth attempt)
  cachedToken = null;
  cachedExpiresAt = 0;

  // Populate refresh token from disk if not already cached
  if (!cachedRefreshToken) {
    const creds = readCredentials();
    if (creds) {
      const extracted = extractToken(creds);
      cachedRefreshToken = extracted?.refreshToken ?? null;
    }
  }

  // Try OAuth refresh first
  if (cachedRefreshToken) {
    const refreshed = await performOAuthRefresh(cachedRefreshToken);
    if (refreshed) return refreshed;
    log.warn("OAuth refresh failed, falling back to disk read");
  }

  // Fallback: re-read from disk (in case another process already refreshed it)
  const creds = readCredentials();
  if (creds) {
    const extracted = extractToken(creds);
    if (extracted) {
      cachedToken = extracted.token;
      cachedExpiresAt = extracted.expiresAt;
      cachedRefreshToken = extracted.refreshToken ?? null;
      log.info("Claude Code credentials refreshed from disk");
      return cachedToken;
    }
  }

  log.warn("Failed to refresh Claude Code credentials");
  return null;
}

/** Check if the currently cached token is still valid */
export function isClaudeCodeTokenValid(): boolean {
  return cachedToken !== null && Date.now() < cachedExpiresAt;
}

/** Reset internal cache — exposed for testing only */
export function _resetCache(): void {
  cachedToken = null;
  cachedExpiresAt = 0;
  cachedRefreshToken = null;
}
