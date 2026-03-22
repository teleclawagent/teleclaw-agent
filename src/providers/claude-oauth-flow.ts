/**
 * Claude Subscription Credential Reader
 *
 * Reads OAuth credentials saved by Claude Code CLI (claude login).
 * User logs in via Claude Code, Teleclaw reads the saved token.
 * Token auto-refreshes when expired.
 *
 * Credential locations:
 * - Windows/Linux: ~/.claude/.credentials.json
 * - macOS: Keychain → file fallback
 */

import { existsSync, readFileSync } from "fs";
import { execSync } from "child_process";
import { homedir } from "os";
import { join } from "path";
import { createLogger } from "../utils/logger.js";

const log = createLogger("ClaudeOAuth");

const OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const OAUTH_SCOPES = "user:inference";

interface ClaudeCredentials {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
  };
}

// ── Read credentials from disk ────────────────────────────────────────

function getCredentialsFilePath(): string {
  return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), ".credentials.json");
}

function readCredentialsFile(): ClaudeCredentials | null {
  const filePath = getCredentialsFilePath();
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as ClaudeCredentials;
  } catch {
    return null;
  }
}

function readKeychainCredentials(): ClaudeCredentials | null {
  const services = ["Claude Code-credentials", "Claude Code"];
  for (const service of services) {
    try {
      const raw = execSync(`security find-generic-password -s "${service}" -w`, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      return JSON.parse(raw) as ClaudeCredentials;
    } catch {
      // Not found, try next
    }
  }
  return null;
}

function readCredentials(): ClaudeCredentials | null {
  if (process.platform === "darwin") {
    const kc = readKeychainCredentials();
    if (kc) return kc;
  }
  return readCredentialsFile();
}

// ── Public API ────────────────────────────────────────────────────────

/** Check if Claude Code credentials exist on disk */
export function hasClaudeCodeCredentials(): boolean {
  const creds = readCredentials();
  return !!creds?.claudeAiOauth?.accessToken;
}

/** Get access token from saved Claude Code credentials */
export function getClaudeAccessToken(): string | null {
  const creds = readCredentials();
  return creds?.claudeAiOauth?.accessToken ?? null;
}

/** Get refresh token for auto-refresh */
export function getClaudeRefreshToken(): string | null {
  const creds = readCredentials();
  return creds?.claudeAiOauth?.refreshToken ?? null;
}

/** Check if token is still valid */
export function isClaudeTokenValid(): boolean {
  const creds = readCredentials();
  if (!creds?.claudeAiOauth?.accessToken) return false;
  if (!creds.claudeAiOauth.expiresAt) return true; // No expiry info, assume valid
  return Date.now() < creds.claudeAiOauth.expiresAt;
}

/** Refresh the access token using the refresh token */
export async function refreshAccessToken(): Promise<string | null> {
  const refreshToken = getClaudeRefreshToken();
  if (!refreshToken) return null;

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
      log.warn(`Token refresh failed: ${res.status}`);
      return null;
    }

    const data = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
    };

    if (!data.access_token) return null;
    log.info("Claude subscription token refreshed");
    return data.access_token;
  } catch (e) {
    log.warn({ err: e }, "Token refresh failed");
    return null;
  }
}

/** Get a valid access token (refresh if expired) */
export async function getValidAccessToken(): Promise<string | null> {
  if (isClaudeTokenValid()) {
    return getClaudeAccessToken();
  }
  return refreshAccessToken();
}
