/**
 * GitHub Copilot Device Login Flow
 *
 * Uses GitHub's device flow OAuth to authenticate with Copilot.
 * User visits github.com/login/device and enters a code.
 * After auth, we get an access token for Copilot API access.
 */

import { createLogger } from "../utils/logger.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const log = createLogger("CopilotAuth");

const CLIENT_ID = "Iv1.b507a08c87ecfe98";
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface CopilotCredentials {
  github_token: string;
  copilot_token?: string;
  copilot_expires_at?: number;
  created_at: number;
}

const CREDENTIALS_DIR = join(homedir(), ".teleclaw");
const CREDENTIALS_FILE = join(CREDENTIALS_DIR, "copilot-credentials.json");

// ── Device Code Flow ───────────────────────────────────────────────

export async function requestDeviceCode(): Promise<DeviceCodeResponse> {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    scope: "read:user",
  });

  const res = await fetch(DEVICE_CODE_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!res.ok) throw new Error(`GitHub device code failed: HTTP ${res.status}`);
  const json = (await res.json()) as DeviceCodeResponse;
  if (!json.device_code || !json.user_code || !json.verification_uri) {
    throw new Error("GitHub device code response missing fields");
  }
  return json;
}

export async function pollForAccessToken(params: {
  deviceCode: string;
  expiresAt: number;
  intervalMs: number;
}): Promise<string> {
  const bodyBase = new URLSearchParams({
    client_id: CLIENT_ID,
    device_code: params.deviceCode,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });

  while (Date.now() < params.expiresAt) {
    const res = await fetch(ACCESS_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: bodyBase,
    });

    if (!res.ok) throw new Error(`GitHub device token failed: HTTP ${res.status}`);
    const json = (await res.json()) as Record<string, unknown>;

    if ("access_token" in json && typeof json.access_token === "string") {
      return json.access_token;
    }

    const err = "error" in json ? json.error : "unknown";
    if (err === "authorization_pending") {
      await new Promise((r) => setTimeout(r, params.intervalMs));
      continue;
    }
    if (err === "slow_down") {
      await new Promise((r) => setTimeout(r, params.intervalMs + 2000));
      continue;
    }
    if (err === "expired_token") throw new Error("GitHub device code expired; run login again");
    if (err === "access_denied") throw new Error("GitHub login cancelled");
    throw new Error(`GitHub device flow error: ${err}`);
  }

  throw new Error("GitHub device code expired; run login again");
}

// ── Copilot Token Exchange ─────────────────────────────────────────

async function getCopilotToken(
  githubToken: string
): Promise<{ token: string; expires_at: number }> {
  const res = await fetch(COPILOT_TOKEN_URL, {
    headers: {
      Authorization: `token ${githubToken}`,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(
      `Copilot token exchange failed: HTTP ${res.status}. Is Copilot enabled on your GitHub account?`
    );
  }

  const json = (await res.json()) as { token: string; expires_at: number };
  return json;
}

// ── Credential Storage ─────────────────────────────────────────────

export function saveCopilotCredentials(githubToken: string): void {
  if (!existsSync(CREDENTIALS_DIR)) mkdirSync(CREDENTIALS_DIR, { recursive: true });
  const creds: CopilotCredentials = {
    github_token: githubToken,
    created_at: Date.now(),
  };
  writeFileSync(CREDENTIALS_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 });
  log.info("Copilot credentials saved");
}

function loadCopilotCredentials(): CopilotCredentials | null {
  if (!existsSync(CREDENTIALS_FILE)) return null;
  try {
    return JSON.parse(readFileSync(CREDENTIALS_FILE, "utf-8"));
  } catch {
    return null;
  }
}

// ── Public API ─────────────────────────────────────────────────────

export function isCopilotConfigured(): boolean {
  return loadCopilotCredentials() !== null;
}

/**
 * Get a valid Copilot API token.
 * Refreshes automatically when expired.
 */
export async function getCopilotApiKey(): Promise<string> {
  const creds = loadCopilotCredentials();
  if (!creds)
    throw new Error("Copilot not configured. Run 'teleclaw setup' and choose GitHub Copilot.");

  // Check if we have a cached copilot token that's still valid
  if (
    creds.copilot_token &&
    creds.copilot_expires_at &&
    Date.now() < creds.copilot_expires_at * 1000 - 60000
  ) {
    return creds.copilot_token;
  }

  // Exchange GitHub token for Copilot token
  log.info("Refreshing Copilot API token...");
  const result = await getCopilotToken(creds.github_token);

  // Cache the new token
  creds.copilot_token = result.token;
  creds.copilot_expires_at = result.expires_at;
  if (!existsSync(CREDENTIALS_DIR)) mkdirSync(CREDENTIALS_DIR, { recursive: true });
  writeFileSync(CREDENTIALS_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 });

  return result.token;
}
