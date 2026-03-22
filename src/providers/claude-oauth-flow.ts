/**
 * Claude Subscription OAuth Flow
 *
 * Handles browser-based OAuth login for Claude Pro/Max subscriptions.
 * No Claude Code CLI needed — Teleclaw does it directly.
 *
 * Flow:
 * 1. Generate PKCE code verifier + challenge
 * 2. Open browser to Claude OAuth authorize URL
 * 3. Start local HTTP server to receive callback
 * 4. Exchange authorization code for access + refresh tokens
 * 5. Save credentials to ~/.teleclaw/claude-oauth.json
 */

import { createServer, type Server } from "http";
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
const OAUTH_REDIRECT_URI = "http://localhost:19485/oauth/callback";
const OAUTH_SCOPES = "user:inference";
const LOCAL_PORT = 19485;

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

// ── Main OAuth Flow (used during setup) ───────────────────────────────

/**
 * Run the Claude OAuth flow:
 * 1. Start local callback server
 * 2. Open browser for login
 * 3. Receive auth code via callback
 * 4. Exchange for tokens
 * 5. Save and return access token
 *
 * @param openUrl - function to open URL in browser (injected for testability)
 * @param onWaiting - callback when waiting for user to authorize
 */
export async function runClaudeOAuthFlow(
  openUrl: (url: string) => Promise<void>,
  onWaiting?: (url: string) => void
): Promise<{ accessToken: string; expiresIn: number }> {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);

  // Build authorize URL
  const params = new URLSearchParams({
    code: "true",
    client_id: OAUTH_CLIENT_ID,
    response_type: "code",
    redirect_uri: OAUTH_REDIRECT_URI,
    scope: OAUTH_SCOPES,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  const authorizeUrl = `${OAUTH_AUTHORIZE_URL}?${params}`;

  // Start local callback server
  return new Promise<{ accessToken: string; expiresIn: number }>((resolve, reject) => {
    let timeoutHandle: ReturnType<typeof setTimeout>;

    const server: Server = createServer((req, res) => {
      void (async () => {
        try {
          const url = new URL(req.url ?? "/", `http://localhost:${LOCAL_PORT}`);

          if (url.pathname !== "/oauth/callback") {
            res.writeHead(404);
            res.end("Not found");
            return;
          }

          const code = url.searchParams.get("code");
          const error = url.searchParams.get("error");

          if (error) {
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(`
            <html><body style="font-family:system-ui;text-align:center;padding:40px">
              <h2>❌ Authorization Failed</h2>
              <p>${error}</p>
              <p>You can close this window and try again.</p>
            </body></html>
          `);
            clearTimeout(timeoutHandle);
            server.close();
            reject(new Error(`OAuth authorization failed: ${error}`));
            return;
          }

          if (!code) {
            res.writeHead(400, { "Content-Type": "text/html" });
            res.end(`
            <html><body style="font-family:system-ui;text-align:center;padding:40px">
              <h2>⚠️ Missing Code</h2>
              <p>No authorization code received. Please try again.</p>
            </body></html>
          `);
            return;
          }

          // Exchange code for tokens
          const creds = await exchangeCodeForTokens(code, codeVerifier);
          saveCredentials(creds);

          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(`
          <html><body style="font-family:system-ui;text-align:center;padding:40px">
            <h2>✅ Success!</h2>
            <p>Your Claude subscription is now connected to Teleclaw.</p>
            <p>You can close this window and return to the terminal.</p>
          </body></html>
        `);

          clearTimeout(timeoutHandle);
          server.close();
          resolve({
            accessToken: creds.accessToken,
            expiresIn: Math.floor((creds.expiresAt - Date.now()) / 1000),
          });
        } catch (e) {
          res.writeHead(500, { "Content-Type": "text/html" });
          res.end(`
          <html><body style="font-family:system-ui;text-align:center;padding:40px">
            <h2>❌ Error</h2>
            <p>${e instanceof Error ? e.message : String(e)}</p>
          </body></html>
        `);
          clearTimeout(timeoutHandle);
          server.close();
          reject(e);
        }
      })();
    });

    server.listen(LOCAL_PORT, () => {
      // Set timeout after server is listening
      timeoutHandle = setTimeout(
        () => {
          server.close();
          reject(new Error("OAuth flow timed out after 5 minutes. Please try again."));
        },
        5 * 60 * 1000
      );

      // Open browser
      onWaiting?.(authorizeUrl);
      openUrl(authorizeUrl).catch(() => {
        // Browser didn't open — user will need to copy URL manually
      });
    });

    server.on("error", (err) => {
      clearTimeout(timeoutHandle);
      reject(new Error(`Failed to start OAuth callback server: ${err.message}`));
    });
  });
}
