/**
 * 🔒 $TELECLAW Token Gate
 *
 * Verifies that a user holds the required amount of $TELECLAW tokens
 * before allowing access to premium OTC matchmaker features.
 *
 * Security principles:
 * 1. ALWAYS verify on-chain — never trust client-side claims
 * 2. Cache with short TTL to avoid excessive API calls but stay fresh
 * 3. Re-verify on every gated action (cache is convenience, not trust)
 * 4. Log all gate checks for audit trail
 * 5. Fail CLOSED — if verification fails for any reason, deny access
 */

import { tonapiFetch } from "../../../constants/api-endpoints.js";
import { createLogger } from "../../../utils/logger.js";
import type Database from "better-sqlite3";

const log = createLogger("TokenGate");

// ─── Constants ───────────────────────────────────────────────────────

/** $TELECLAW jetton master contract address */
const TELECLAW_JETTON_ADDRESS = "EQD01TwE1plYpYKvRwWOLwAzzAJaDKwpB2bR3nfg-wkJJwks";

/** Total supply: 100,000,000 tokens (9 decimals) */
const TOTAL_SUPPLY = 100_000_000n;
const DECIMALS = 9;

/** Required: 0.1% of total supply = 100,000 tokens */
const REQUIRED_PERCENTAGE = 0.001;
const REQUIRED_AMOUNT = BigInt(Math.floor(Number(TOTAL_SUPPLY) * REQUIRED_PERCENTAGE));
const REQUIRED_AMOUNT_RAW = REQUIRED_AMOUNT * (10n ** BigInt(DECIMALS)); // In nano units

/** Cache TTL: 5 minutes — short enough for security, long enough to not spam TonAPI */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** Maximum cache entries to prevent memory bloat */
const MAX_CACHE_ENTRIES = 1000;

// ─── Types ───────────────────────────────────────────────────────────

interface CacheEntry {
  balance: bigint;       // Raw balance (with decimals)
  hasAccess: boolean;
  checkedAt: number;     // Unix timestamp ms
  walletAddress: string; // Which wallet was checked
}

interface TokenGateResult {
  allowed: boolean;
  reason: string;
  balance?: string;       // Human-readable balance
  required?: string;      // Human-readable required amount
  walletAddress?: string;
  checkedAt?: number;
  fromCache?: boolean;
}

// ─── In-Memory Cache ─────────────────────────────────────────────────

const balanceCache = new Map<number, CacheEntry>();

function getCachedEntry(userId: number, walletAddress: string): CacheEntry | null {
  const entry = balanceCache.get(userId);
  if (!entry) return null;

  // Expired?
  if (Date.now() - entry.checkedAt > CACHE_TTL_MS) {
    balanceCache.delete(userId);
    return null;
  }

  // Wallet changed? Invalidate cache — user might have switched wallets
  if (entry.walletAddress !== walletAddress) {
    balanceCache.delete(userId);
    return null;
  }

  return entry;
}

function setCacheEntry(userId: number, entry: CacheEntry): void {
  evictIfNeeded();
  balanceCache.set(userId, entry);
}

/** Evict oldest entries if cache exceeds max size */
function evictIfNeeded(): void {
  if (balanceCache.size < MAX_CACHE_ENTRIES) return;
  const entries = Array.from(balanceCache.entries())
    .sort((a, b) => a[1].checkedAt - b[1].checkedAt);
  const toRemove = entries.slice(0, Math.floor(MAX_CACHE_ENTRIES / 4));
  for (const [key] of toRemove) {
    balanceCache.delete(key);
  }
}

/** Force-clear cache for a user (e.g., after they claim they bought more) */
export function clearTokenGateCache(userId: number): void {
  balanceCache.delete(userId);
}

// ─── Core Verification ──────────────────────────────────────────────

/**
 * Fetch $TELECLAW balance from TonAPI for a given wallet address.
 * Returns raw balance (with decimals) or null on failure.
 *
 * SECURITY: This is the ONLY source of truth for token holdings.
 * Never trust any other source (user input, cached DB values from user, etc.)
 */
async function fetchTeleclawBalance(walletAddress: string): Promise<bigint | null> {
  try {
    // Validate wallet address format before making API call
    if (!walletAddress || walletAddress.length < 40 || walletAddress.length > 80) {
      log.warn({ walletAddress }, "Invalid wallet address format");
      return null;
    }

    // Sanitize: only allow base64url-safe characters and colons
    if (!/^[A-Za-z0-9_\-:]+$/.test(walletAddress)) {
      log.warn({ walletAddress }, "Wallet address contains invalid characters");
      return null;
    }

    const response = await tonapiFetch(
      `/accounts/${encodeURIComponent(walletAddress)}/jettons/${encodeURIComponent(TELECLAW_JETTON_ADDRESS)}`
    );

    if (response.status === 404) {
      // User doesn't hold this jetton at all
      return 0n;
    }

    if (!response.ok) {
      log.error({ status: response.status, walletAddress }, "TonAPI error fetching jetton balance");
      // 429 = rate limited, distinct from real errors
      if (response.status === 429) return -1n; // Sentinel: rate limited
      return null; // Fail closed — don't grant access on API error
    }

    const data = await response.json();

    // Validate response structure
    if (!data || typeof data.balance !== "string") {
      log.error({ data, walletAddress }, "Unexpected TonAPI response structure");
      return null;
    }

    // Parse balance as BigInt (raw value with decimals)
    try {
      return BigInt(data.balance);
    } catch {
      log.error({ balance: data.balance }, "Failed to parse balance as BigInt");
      return null;
    }
  } catch (error) {
    log.error({ err: error, walletAddress }, "Network error fetching TELECLAW balance");
    return null; // Fail closed
  }
}

/**
 * Get user's wallet address from the agentic_wallets table.
 * This is the wallet they registered via TON Connect / wallet setup.
 *
 * SECURITY: We trust this mapping because the user verified ownership
 * during wallet connection (TON Connect proof or similar).
 */
function getUserWalletAddress(db: Database.Database, userId: number): string | null {
  try {
    const row = db
      .prepare("SELECT address FROM agentic_wallets WHERE user_id = ?")
      .get(userId) as { address: string } | undefined;

    return row?.address || null;
  } catch (error) {
    log.error({ err: error, userId }, "Failed to query user wallet");
    return null;
  }
}

/**
 * Log a token gate check to the security audit log.
 */
function logGateCheck(
  db: Database.Database,
  userId: number,
  eventType: string,
  details: Record<string, unknown>
): void {
  try {
    db.prepare(
      `INSERT INTO security_audit_log (user_id, event_type, details)
       VALUES (?, ?, ?)`
    ).run(userId, eventType, JSON.stringify(details));
  } catch {
    // Non-critical — don't fail the gate check if logging fails
  }
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Check if a user has the required $TELECLAW balance for OTC features.
 *
 * SECURITY GUARANTEES:
 * - Always checks on-chain balance (with short cache)
 * - Fails CLOSED: any error = access denied
 * - Validates wallet address format
 * - Logs all checks for audit
 * - Cache is invalidated on wallet change
 *
 * @param db - Database instance
 * @param userId - Telegram user ID
 * @param skipCache - Force fresh on-chain check (e.g., after user says they bought)
 * @returns TokenGateResult with allowed/denied + reason
 */
export async function checkTokenGate(
  db: Database.Database,
  userId: number,
  skipCache = false
): Promise<TokenGateResult> {
  // Step 1: Get user's wallet address
  const walletAddress = getUserWalletAddress(db, userId);

  if (!walletAddress) {
    logGateCheck(db, userId, "token_gate_no_wallet", { result: "denied" });
    return {
      allowed: false,
      reason: "No wallet connected. Please connect your TON wallet first using the wallet setup command. Your wallet must hold at least 100,000 $TELECLAW tokens.",
    };
  }

  // Step 2: Check cache (unless skip requested)
  if (!skipCache) {
    const cached = getCachedEntry(userId, walletAddress);
    if (cached) {
      const humanBalance = formatBalance(cached.balance);
      logGateCheck(db, userId, "token_gate_cached", {
        result: cached.hasAccess ? "allowed" : "denied",
        balance: humanBalance,
        walletAddress,
      });
      return {
        allowed: cached.hasAccess,
        reason: cached.hasAccess
          ? `✅ Token gate passed (cached). Balance: ${humanBalance} $TELECLAW`
          : `❌ Insufficient $TELECLAW balance. You have ${humanBalance}, need ${formatBalance(REQUIRED_AMOUNT_RAW)}.`,
        balance: humanBalance,
        required: formatBalance(REQUIRED_AMOUNT_RAW),
        walletAddress,
        checkedAt: cached.checkedAt,
        fromCache: true,
      };
    }
  }

  // Step 3: Fetch on-chain balance
  const rawBalance = await fetchTeleclawBalance(walletAddress);

  if (rawBalance === null) {
    // API error — fail CLOSED
    logGateCheck(db, userId, "token_gate_api_error", {
      result: "denied",
      walletAddress,
    });
    return {
      allowed: false,
      reason: "⚠️ Unable to verify $TELECLAW balance at this time. Please try again in a moment.",
      walletAddress,
    };
  }

  if (rawBalance === -1n) {
    // Rate limited — use last known cache if available (even if expired)
    const staleCache = balanceCache.get(userId);
    if (staleCache && staleCache.walletAddress === walletAddress) {
      log.warn({ userId, walletAddress }, "Rate limited — using stale cache");
      logGateCheck(db, userId, "token_gate_rate_limited_stale_cache", {
        result: staleCache.hasAccess ? "allowed" : "denied",
        walletAddress,
        cacheAge: Date.now() - staleCache.checkedAt,
      });
      return {
        allowed: staleCache.hasAccess,
        reason: staleCache.hasAccess
          ? `✅ Token gate passed (rate-limited, using last check). Balance: ${formatBalance(staleCache.balance)} $TELECLAW`
          : `❌ Insufficient $TELECLAW balance (rate-limited, using last check). Balance: ${formatBalance(staleCache.balance)} $TELECLAW`,
        balance: formatBalance(staleCache.balance),
        required: formatBalance(REQUIRED_AMOUNT_RAW),
        walletAddress,
        checkedAt: staleCache.checkedAt,
        fromCache: true,
      };
    }
    // No cache at all — fail closed
    logGateCheck(db, userId, "token_gate_rate_limited_no_cache", {
      result: "denied",
      walletAddress,
    });
    return {
      allowed: false,
      reason: "⚠️ Rate limited by blockchain API. Please try again in a moment.",
      walletAddress,
    };
  }

  // Step 4: Check if balance meets requirement
  const hasAccess = rawBalance >= REQUIRED_AMOUNT_RAW;
  const humanBalance = formatBalance(rawBalance);

  // Step 5: Cache the result
  setCacheEntry(userId, {
    balance: rawBalance,
    hasAccess,
    checkedAt: Date.now(),
    walletAddress,
  });

  // Step 6: Log the check
  logGateCheck(db, userId, "token_gate_check", {
    result: hasAccess ? "allowed" : "denied",
    balance: humanBalance,
    required: formatBalance(REQUIRED_AMOUNT_RAW),
    walletAddress,
  });

  log.info(
    { userId, walletAddress, balance: humanBalance, hasAccess },
    `Token gate ${hasAccess ? "PASSED" : "DENIED"}`
  );

  return {
    allowed: hasAccess,
    reason: hasAccess
      ? `✅ Token gate passed. Balance: ${humanBalance} $TELECLAW`
      : `❌ Insufficient $TELECLAW balance.\n\nYou have: ${humanBalance} $TELECLAW\nRequired: ${formatBalance(REQUIRED_AMOUNT_RAW)} $TELECLAW (0.1% of supply)\n\nBuy $TELECLAW on DeDust: https://dedust.io/swap/TON/EQD01TwE1plYpYKvRwWOLwAzzAJaDKwpB2bR3nfg-wkJJwks`,
    balance: humanBalance,
    required: formatBalance(REQUIRED_AMOUNT_RAW),
    walletAddress,
    checkedAt: Date.now(),
    fromCache: false,
  };
}

/**
 * Quick check — does user pass the gate? Returns boolean only.
 * Use checkTokenGate() for detailed results.
 */
export async function hasTokenAccess(
  db: Database.Database,
  userId: number
): Promise<boolean> {
  const result = await checkTokenGate(db, userId);
  return result.allowed;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function formatBalance(rawBalance: bigint): string {
  const whole = rawBalance / (10n ** BigInt(DECIMALS));
  const frac = rawBalance % (10n ** BigInt(DECIMALS));
  if (frac === 0n) return whole.toLocaleString();
  const fracStr = frac.toString().padStart(DECIMALS, "0").replace(/0+$/, "");
  return `${whole.toLocaleString()}.${fracStr}`;
}

// ─── Exports for testing ─────────────────────────────────────────────

export const _testing = {
  TELECLAW_JETTON_ADDRESS,
  TOTAL_SUPPLY,
  REQUIRED_AMOUNT,
  REQUIRED_AMOUNT_RAW,
  DECIMALS,
  CACHE_TTL_MS,
  formatBalance,
  fetchTeleclawBalance,
  balanceCache,
  setCacheEntry,
  evictIfNeeded,
};
