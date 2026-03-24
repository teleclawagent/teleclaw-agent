import { randomUUID, scryptSync, randomBytes, createHmac } from "crypto";
import type Database from "better-sqlite3";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("AgenticWallet:Security");

// ─── PIN System ──────────────────────────────────────────────────────

const MAX_PIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_SEC = 900; // 15 minutes
const PIN_MIN_LENGTH = 4;
const PIN_MAX_LENGTH = 8;

/**
 * Hash a PIN with salt using scrypt.
 */
function hashPin(pin: string, salt: string): string {
  return scryptSync(pin, salt, 64).toString("hex");
}

/**
 * Set or update the security PIN for a user.
 */
export function setPin(db: Database.Database, userId: number, pin: string): void {
  if (pin.length < PIN_MIN_LENGTH || pin.length > PIN_MAX_LENGTH) {
    throw new Error(`PIN must be ${PIN_MIN_LENGTH}-${PIN_MAX_LENGTH} digits.`);
  }
  if (!/^\d+$/.test(pin)) {
    throw new Error("PIN must contain only digits.");
  }

  const salt = randomBytes(32).toString("hex");
  const pinHash = hashPin(pin, salt);
  const now = Math.floor(Date.now() / 1000);

  db.prepare(
    `INSERT INTO wallet_pins (user_id, pin_hash, salt, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET pin_hash = ?, salt = ?, failed_attempts = 0, locked_until = 0, updated_at = ?`
  ).run(userId, pinHash, salt, now, now, pinHash, salt, now);

  auditLog(db, userId, "pin_set", "PIN created or updated");
  log.info({ userId }, "Security PIN set");
}

/**
 * Verify a PIN. Returns true if correct, false if wrong.
 * Locks account after MAX_PIN_ATTEMPTS failed tries.
 */
export function verifyPin(db: Database.Database, userId: number, pin: string): boolean {
  const row = db
    .prepare(
      "SELECT pin_hash, salt, failed_attempts, locked_until FROM wallet_pins WHERE user_id = ?"
    )
    .get(userId) as
    | {
        pin_hash: string;
        salt: string;
        failed_attempts: number;
        locked_until: number;
      }
    | undefined;

  if (!row) {
    throw new Error(
      "No PIN set. Use agentic_wallet_set_pin to create one before making transactions."
    );
  }

  // Check lockout
  const now = Math.floor(Date.now() / 1000);
  if (row.locked_until > now) {
    const remainingMin = Math.ceil((row.locked_until - now) / 60);
    auditLog(
      db,
      userId,
      "pin_locked_attempt",
      `Attempted while locked. ${remainingMin}min remaining`
    );
    throw new Error(
      `Account locked due to too many failed PIN attempts. Try again in ${remainingMin} minutes.`
    );
  }

  const inputHash = hashPin(pin, row.salt);

  if (inputHash === row.pin_hash) {
    // Reset failed attempts on success
    db.prepare(
      "UPDATE wallet_pins SET failed_attempts = 0, locked_until = 0 WHERE user_id = ?"
    ).run(userId);
    return true;
  }

  // Wrong PIN
  const newAttempts = row.failed_attempts + 1;
  if (newAttempts >= MAX_PIN_ATTEMPTS) {
    const lockedUntil = now + LOCKOUT_DURATION_SEC;
    db.prepare(
      "UPDATE wallet_pins SET failed_attempts = ?, locked_until = ? WHERE user_id = ?"
    ).run(newAttempts, lockedUntil, userId);
    auditLog(db, userId, "pin_lockout", `Locked after ${newAttempts} failed attempts`);
    log.warn({ userId, attempts: newAttempts }, "Account locked — too many failed PIN attempts");
    throw new Error(
      `Too many failed attempts. Account locked for ${LOCKOUT_DURATION_SEC / 60} minutes.`
    );
  }

  db.prepare("UPDATE wallet_pins SET failed_attempts = ? WHERE user_id = ?").run(
    newAttempts,
    userId
  );
  auditLog(db, userId, "pin_failed", `Failed attempt ${newAttempts}/${MAX_PIN_ATTEMPTS}`);

  const remaining = MAX_PIN_ATTEMPTS - newAttempts;
  throw new Error(
    `Wrong PIN. ${remaining} attempt${remaining > 1 ? "s" : ""} remaining before lockout.`
  );
}

/**
 * Check if user has a PIN set.
 */
export function hasPin(db: Database.Database, userId: number): boolean {
  const row = db.prepare("SELECT 1 FROM wallet_pins WHERE user_id = ?").get(userId);
  return !!row;
}

// ─── Withdrawal Address Whitelist ────────────────────────────────────

/**
 * Add an address to the user's whitelist.
 */
export function whitelistAddress(
  db: Database.Database,
  userId: number,
  address: string,
  label?: string
): void {
  const id = randomUUID();
  try {
    db.prepare(
      `INSERT INTO whitelisted_addresses (id, user_id, address, label) VALUES (?, ?, ?, ?)`
    ).run(id, userId, address, label || null);
    auditLog(db, userId, "whitelist_add", `Added ${address}${label ? ` (${label})` : ""}`);
  } catch (error: unknown) {
    if (error instanceof Error && error.message.includes("UNIQUE")) {
      throw new Error("This address is already whitelisted.");
    }
    throw error;
  }
}

/**
 * Remove an address from the whitelist.
 */
export function removeWhitelistedAddress(
  db: Database.Database,
  userId: number,
  address: string
): boolean {
  const result = db
    .prepare("DELETE FROM whitelisted_addresses WHERE user_id = ? AND address = ?")
    .run(userId, address);

  if (result.changes > 0) {
    auditLog(db, userId, "whitelist_remove", `Removed ${address}`);
    return true;
  }
  return false;
}

/**
 * Check if an address is whitelisted for a user.
 */
export function isAddressWhitelisted(
  db: Database.Database,
  userId: number,
  address: string
): boolean {
  const row = db
    .prepare("SELECT 1 FROM whitelisted_addresses WHERE user_id = ? AND address = ?")
    .get(userId, address);
  return !!row;
}

/**
 * Get all whitelisted addresses for a user.
 */
export function getWhitelistedAddresses(
  db: Database.Database,
  userId: number
): Array<{ address: string; label: string | null }> {
  return db
    .prepare("SELECT address, label FROM whitelisted_addresses WHERE user_id = ?")
    .all(userId) as Array<{ address: string; label: string | null }>;
}

// ─── Trade Execution Signing ─────────────────────────────────────────

/**
 * Get the master signing key from environment.
 * MUST be set in production — never hardcoded.
 */
function getSigningKey(): string {
  const key = process.env.TELECLAW_SIGNING_KEY;
  if (!key) {
    throw new Error(
      "TELECLAW_SIGNING_KEY environment variable not set. Cannot sign trade executions."
    );
  }
  return key;
}

/**
 * Sign a trade execution for tamper-proof audit trail.
 */
export function signExecution(data: {
  executionId: string;
  userId: number;
  action: string;
  asset: string;
  amount: number;
  price: number;
  timestamp: number;
}): string {
  const payload = `${data.executionId}:${data.userId}:${data.action}:${data.asset}:${data.amount}:${data.price}:${data.timestamp}`;
  const hmac = createHmac("sha256", getSigningKey());
  hmac.update(payload);
  return hmac.digest("hex");
}

/**
 * Verify a trade execution signature.
 */
export function verifyExecutionSignature(
  data: {
    executionId: string;
    userId: number;
    action: string;
    asset: string;
    amount: number;
    price: number;
    timestamp: number;
  },
  signature: string
): boolean {
  const expected = signExecution(data);
  // Constant-time comparison
  if (expected.length !== signature.length) return false;
  let result = 0;
  for (let i = 0; i < expected.length; i++) {
    result |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return result === 0;
}

// ─── Security Audit Log ──────────────────────────────────────────────

/**
 * Log a security-relevant event.
 */
export function auditLog(
  db: Database.Database,
  userId: number,
  eventType: string,
  details: string,
  context?: string
): void {
  db.prepare(
    `INSERT INTO security_audit_log (user_id, event_type, details, ip_or_context)
     VALUES (?, ?, ?, ?)`
  ).run(userId, eventType, details, context || null);
}

// ─── Pending Execution Expiry ────────────────────────────────────────

const EXECUTION_EXPIRY_SEC = 300; // 5 minutes

/**
 * Get the expiry timestamp for a new pending execution.
 */
export function getExecutionExpiry(): number {
  return Math.floor(Date.now() / 1000) + EXECUTION_EXPIRY_SEC;
}

/**
 * Expire old pending executions that were never confirmed.
 */
export function expirePendingExecutions(db: Database.Database): number {
  const now = Math.floor(Date.now() / 1000);
  const result = db
    .prepare(
      `UPDATE trade_executions SET status = 'expired'
       WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at < ?`
    )
    .run(now);

  if (result.changes > 0) {
    log.info({ count: result.changes }, "Expired pending trade executions");
  }
  return result.changes;
}
