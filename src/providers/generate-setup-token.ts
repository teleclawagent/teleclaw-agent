/**
 * Generate a setup-token from Claude Code credentials.
 *
 * This does what `claude setup-token` does but without the TUI —
 * reads saved credentials and generates a long-lived token.
 *
 * User flow:
 * 1. Run `claude login` (or `npx @anthropic-ai/claude-code login`) in any terminal
 * 2. Teleclaw reads the saved credentials
 * 3. Generates a setup-token (long-lived access token)
 * 4. Token is saved to config
 */

import { existsSync, readFileSync } from "fs";
import { execSync } from "child_process";
import { homedir } from "os";
import { join } from "path";

const OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

interface ClaudeCredentials {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
  };
}

function readCredentialsFile(): ClaudeCredentials | null {
  const filePath = join(
    process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
    ".credentials.json"
  );
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as ClaudeCredentials;
  } catch {
    return null;
  }
}

function readKeychainCredentials(): ClaudeCredentials | null {
  if (process.platform !== "darwin") return null;
  for (const service of ["Claude Code-credentials", "Claude Code"]) {
    try {
      const raw = execSync(`security find-generic-password -s "${service}" -w`, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      return JSON.parse(raw) as ClaudeCredentials;
    } catch {
      // Not found
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

/**
 * Check if Claude Code credentials exist on disk
 */
export function hasCredentials(): boolean {
  const creds = readCredentials();
  return !!(creds?.claudeAiOauth?.accessToken || creds?.claudeAiOauth?.refreshToken);
}

/**
 * Get an access token from Claude Code credentials.
 * If the saved token is expired, refreshes it using the refresh token.
 * Returns the access token string ready to use as api_key.
 */
export async function getAccessToken(): Promise<string> {
  const creds = readCredentials();
  if (!creds?.claudeAiOauth) {
    throw new Error("Claude Code credentials not found. Run 'claude login' first.");
  }

  const { accessToken, refreshToken, expiresAt } = creds.claudeAiOauth;

  // If token is still valid, use it directly
  if (accessToken && expiresAt && Date.now() < expiresAt - 60_000) {
    return accessToken;
  }

  // Token expired or missing — try refresh
  if (refreshToken) {
    const res = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: OAUTH_CLIENT_ID,
      }),
    });

    if (res.ok) {
      const data = (await res.json()) as { access_token?: string };
      if (data.access_token) {
        return data.access_token;
      }
    }
  }

  // Last resort: return existing token even if expired (might still work)
  if (accessToken) {
    return accessToken;
  }

  throw new Error(
    "Could not get a valid token from Claude Code credentials. Run 'claude login' again."
  );
}
