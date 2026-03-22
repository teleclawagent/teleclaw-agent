/**
 * Claude Subscription OAuth Flow
 *
 * Handles browser-based OAuth login for Claude Pro/Max subscriptions.
 * Uses PKCE flow with Claude's registered redirect URI.
 *
 * Flow:
 * 1. Generate PKCE code verifier + challenge
 * 2. Open browser to Claude OAuth authorize URL
 * 3. User signs in, gets redirected to platform.claude.com/oauth/code/callback
 * 4. Claude shows the authorization code on-screen
 * 5. User pastes the code back into the terminal
 * 6. Exchange code for access + refresh tokens
 * 7. Save credentials to ~/.teleclaw/claude-oauth.json
 */

import { randomBytes, createHash } from "crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { createLogger } from "../utils/logger.js";

const log = createLogger("ClaudeOAuth");

// OAuth constants (same as Claude Code uses)
const OAUTH_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const OAUTH_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
const OAUTH_SCOPES = "user:inference";

// Credential storage
function getCredentialsPath(): string {
  const dir = join(homedir(), ".teleclaw");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(dir, "claude-oauth.json");
}

interface StoredCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

// ── PKCE helpers ──────────────────────────────────────────────────────

function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

// ── Token exchange ────────────────────────────────────────────────────

async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string
): Promise<StoredCredentials> {
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      client_id: OAUTH_CLIENT_ID,
      redirect_uri: OAUTH_REDIRECT_URI,
      code_verifier: codeVerifier,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  if (!data.access_token) {
    throw new Error("No access_token in token response");
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}

// ── Token refresh ─────────────────────────────────────────────────────

export async function refreshClaudeOAuthToken(): Promise<string | null> {
  const creds = loadCredentials();
  if (!creds?.refreshToken) return null;

  try {
    const res = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: creds.refreshToken,
        client_id: OAUTH_CLIENT_ID,
        scope: OAUTH_SCOPES,
      }),
    });

    if (!res.ok) {
      log.warn(`OAuth refresh failed: ${res.status}`);
      return null;
    }

    const data = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };

    if (!data.access_token) return null;

    const updated: StoredCredentials = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? creds.refreshToken,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
    saveCredentials(updated);
    log.info("Claude OAuth token refreshed");
    return updated.accessToken;
  } catch (e) {
    log.warn({ err: e }, "OAuth refresh failed");
    return null;
  }
}

// ── Credential storage ────────────────────────────────────────────────

function saveCredentials(creds: StoredCredentials): void {
  const filePath = getCredentialsPath();
  writeFileSync(filePath, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

function loadCredentials(): StoredCredentials | null {
  const filePath = getCredentialsPath();
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as StoredCredentials;
  } catch {
    return null;
  }
}

/** Get a valid access token (refreshes if expired) */
export async function getClaudeOAuthAccessToken(): Promise<string | null> {
  const creds = loadCredentials();
  if (!creds) return null;

  // Still valid? Return it
  if (Date.now() < creds.expiresAt - 60_000) {
    return creds.accessToken;
  }

  // Expired — try refresh
  return refreshClaudeOAuthToken();
}

/** Check if we have stored OAuth credentials */
export function hasClaudeOAuthCredentials(): boolean {
  return loadCredentials() !== null;
}

// ── OAuth Flow Types ──────────────────────────────────────────────────

export interface OAuthFlowResult {
  accessToken: string;
  expiresIn: number;
  codeVerifier: string;
}

// ── Step 1: Generate authorize URL ────────────────────────────────────

export function generateAuthorizeUrl(): { url: string; codeVerifier: string } {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = randomBytes(16).toString("base64url");

  const params = new URLSearchParams({
    code: "true",
    client_id: OAUTH_CLIENT_ID,
    response_type: "code",
    redirect_uri: OAUTH_REDIRECT_URI,
    scope: OAUTH_SCOPES,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
  });

  return {
    url: `${OAUTH_AUTHORIZE_URL}?${params}`,
    codeVerifier,
  };
}

// ── Step 2: Exchange code for tokens ──────────────────────────────────

export async function exchangeCode(
  code: string,
  codeVerifier: string
): Promise<{ accessToken: string; expiresIn: number }> {
  const creds = await exchangeCodeForTokens(code.trim(), codeVerifier);
  saveCredentials(creds);
  return {
    accessToken: creds.accessToken,
    expiresIn: Math.floor((creds.expiresAt - Date.now()) / 1000),
  };
}
