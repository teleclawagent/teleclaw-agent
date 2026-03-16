import { randomUUID } from "crypto";
import type Database from "better-sqlite3";
import { auditLog } from "./security.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("AgenticWallet");

export type RuleType = "price_above" | "price_below" | "dca" | "stop_loss" | "take_profit";

export interface TradingRule {
  id: string;
  wallet_id: string;
  user_id: number;
  rule_text: string;
  rule_type: RuleType;
  asset: string;
  target_asset: string;
  condition_value: number | null;
  amount: number;
  interval_seconds: number | null;
  last_triggered_at: number | null;
  active: number;
  requires_confirmation: number;
  created_at: number;
}

export interface CreateRuleParams {
  walletId: string;
  userId: number;
  ruleText: string;
  ruleType: RuleType;
  asset: string;
  targetAsset?: string;
  conditionValue?: number;
  amount: number;
  intervalSeconds?: number;
  requiresConfirmation?: boolean;
}

/** Safety limits — these are hard caps, not configurable by users */
const ABSOLUTE_MAX_TRADE_TON = 100;
const ABSOLUTE_MAX_DAILY_TON = 500;
const MAX_ACTIVE_RULES_PER_USER = 20;
const MAX_STOP_LOSS_PERCENT = 0.5; // 50%

/**
 * Create a new trading rule with safety validation.
 */
export function createRule(db: Database.Database, params: CreateRuleParams): TradingRule {
  // Hard cap on trade amount
  if (params.amount > ABSOLUTE_MAX_TRADE_TON) {
    throw new Error(
      `Trade amount ${params.amount} TON exceeds absolute maximum of ${ABSOLUTE_MAX_TRADE_TON} TON per trade.`
    );
  }

  // Check user's per-wallet limits
  const wallet = db
    .prepare("SELECT max_trade_amount, daily_limit FROM agentic_wallets WHERE id = ? AND user_id = ?")
    .get(params.walletId, params.userId) as { max_trade_amount: number; daily_limit: number } | undefined;

  if (!wallet) {
    throw new Error("Wallet not found or doesn't belong to this user.");
  }

  if (params.amount > wallet.max_trade_amount) {
    throw new Error(
      `Trade amount ${params.amount} TON exceeds your wallet limit of ${wallet.max_trade_amount} TON. Change it with agentic_wallet_set_limits.`
    );
  }

  // Check daily total
  const dailyTotal = getDailyTotal(db, params.userId);
  if (dailyTotal + params.amount > wallet.daily_limit) {
    throw new Error(
      `Adding this rule could exceed your daily limit of ${wallet.daily_limit} TON. Current daily total: ${dailyTotal.toFixed(2)} TON.`
    );
  }

  // Check active rules count
  const activeCount = db
    .prepare("SELECT COUNT(*) as count FROM trading_rules WHERE user_id = ? AND active = 1")
    .get(params.userId) as { count: number };

  if (activeCount.count >= MAX_ACTIVE_RULES_PER_USER) {
    throw new Error(
      `Maximum of ${MAX_ACTIVE_RULES_PER_USER} active rules reached. Deactivate some rules first.`
    );
  }

  // Validate stop_loss
  if (params.ruleType === "stop_loss" && params.conditionValue && params.conditionValue > MAX_STOP_LOSS_PERCENT) {
    throw new Error(`Stop-loss cannot exceed ${MAX_STOP_LOSS_PERCENT * 100}% of wallet value.`);
  }

  // DCA must require confirmation (no auto-execute)
  const requiresConfirmation = 1; // ALWAYS require confirmation — non-negotiable

  const id = randomUUID();

  db.prepare(
    `INSERT INTO trading_rules
       (id, wallet_id, user_id, rule_text, rule_type, asset, target_asset,
        condition_value, amount, interval_seconds, requires_confirmation)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    params.walletId,
    params.userId,
    params.ruleText,
    params.ruleType,
    params.asset,
    params.targetAsset || "ton",
    params.conditionValue ?? null,
    params.amount,
    params.intervalSeconds ?? null,
    requiresConfirmation
  );

  auditLog(
    db,
    params.userId,
    "rule_created",
    `Rule ${id.slice(0, 8)}: ${params.ruleType} ${params.amount} TON on ${params.asset}`
  );
  log.info({ userId: params.userId, ruleId: id, type: params.ruleType }, "Created trading rule");

  return db.prepare("SELECT * FROM trading_rules WHERE id = ?").get(id) as TradingRule;
}

/**
 * List active rules for a user.
 */
export function listRules(db: Database.Database, userId: number): TradingRule[] {
  return db
    .prepare("SELECT * FROM trading_rules WHERE user_id = ? AND active = 1 ORDER BY created_at DESC")
    .all(userId) as TradingRule[];
}

/**
 * Deactivate a rule.
 */
export function deactivateRule(db: Database.Database, ruleId: string, userId: number): boolean {
  const result = db
    .prepare("UPDATE trading_rules SET active = 0 WHERE id = ? AND user_id = ?")
    .run(ruleId, userId);

  if (result.changes > 0) {
    auditLog(db, userId, "rule_deactivated", `Rule ${ruleId.slice(0, 8)} deactivated`);
    log.info({ ruleId, userId }, "Deactivated trading rule");
    return true;
  }
  return false;
}

/**
 * Get total trade amount for a user today.
 */
function getDailyTotal(db: Database.Database, userId: number): number {
  const todayStart = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) as total
       FROM trade_executions
       WHERE user_id = ? AND created_at >= ? AND status IN ('confirmed', 'executed')`
    )
    .get(userId, todayStart) as { total: number };

  return row.total;
}

/**
 * Evaluate all active rules against current prices.
 * Returns rules that have been triggered.
 */
export function evaluateRules(
  db: Database.Database,
  currentPrices: Map<string, number>
): Array<{ rule: TradingRule; currentPrice: number }> {
  const activeRules = db
    .prepare("SELECT * FROM trading_rules WHERE active = 1")
    .all() as TradingRule[];

  const triggered: Array<{ rule: TradingRule; currentPrice: number }> = [];
  const now = Math.floor(Date.now() / 1000);

  for (const rule of activeRules) {
    const price = currentPrices.get(rule.asset.toLowerCase());
    if (price === undefined && rule.rule_type !== "dca") continue;

    // Check if there's already a pending execution for this rule (prevent duplicates)
    const pendingExists = db
      .prepare(
        "SELECT 1 FROM trade_executions WHERE rule_id = ? AND status = 'pending'"
      )
      .get(rule.id);

    if (pendingExists) continue; // Don't trigger again while pending

    switch (rule.rule_type) {
      case "price_below":
        if (price !== undefined && rule.condition_value !== null && price <= rule.condition_value) {
          triggered.push({ rule, currentPrice: price });
        }
        break;

      case "price_above":
        if (price !== undefined && rule.condition_value !== null && price >= rule.condition_value) {
          triggered.push({ rule, currentPrice: price });
        }
        break;

      case "stop_loss":
        if (price !== undefined && rule.condition_value !== null) {
          // condition_value is the absolute price threshold
          if (price <= rule.condition_value) {
            triggered.push({ rule, currentPrice: price });
          }
        }
        break;

      case "take_profit":
        if (price !== undefined && rule.condition_value !== null && price >= rule.condition_value) {
          triggered.push({ rule, currentPrice: price });
        }
        break;

      case "dca": {
        if (!rule.interval_seconds) continue;
        const lastTriggered = rule.last_triggered_at || rule.created_at;
        if (now - lastTriggered >= rule.interval_seconds) {
          triggered.push({ rule, currentPrice: price ?? 0 });
        }
        break;
      }
    }
  }

  return triggered;
}

/**
 * Mark a rule as triggered (update last_triggered_at).
 */
export function markRuleTriggered(db: Database.Database, ruleId: string): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare("UPDATE trading_rules SET last_triggered_at = ? WHERE id = ?").run(now, ruleId);
}

/**
 * Create a pending trade execution record.
 */
export function createPendingExecution(
  db: Database.Database,
  params: {
    ruleId: string;
    walletId: string;
    userId: number;
    action: string;
    asset: string;
    amount: number;
    priceAtExecution: number;
    priceSources?: string;
    expiresAt?: number;
  }
): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO trade_executions
       (id, rule_id, wallet_id, user_id, action, asset, amount, price_at_execution, price_sources, status, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
  ).run(
    id,
    params.ruleId,
    params.walletId,
    params.userId,
    params.action,
    params.asset,
    params.amount,
    params.priceAtExecution,
    params.priceSources || null,
    params.expiresAt || null
  );

  return id;
}

/**
 * Update trade execution status.
 */
export function updateExecutionStatus(
  db: Database.Database,
  executionId: string,
  status: "confirmed" | "executed" | "failed" | "cancelled" | "expired",
  result?: string
): void {
  const executedAt = status === "executed" ? Math.floor(Date.now() / 1000) : null;
  db.prepare(
    `UPDATE trade_executions SET status = ?, result = ?, executed_at = ? WHERE id = ?`
  ).run(status, result || null, executedAt, executionId);
}

/**
 * Get pending executions for a user.
 */
export function getPendingExecutions(
  db: Database.Database,
  userId: number
): Array<{
  id: string;
  rule_id: string;
  action: string;
  asset: string;
  amount: number;
  price_at_execution: number;
  expires_at: number | null;
  created_at: number;
}> {
  return db
    .prepare(
      `SELECT id, rule_id, action, asset, amount, price_at_execution, expires_at, created_at
       FROM trade_executions
       WHERE user_id = ? AND status = 'pending'
       ORDER BY created_at DESC`
    )
    .all(userId) as Array<{
    id: string;
    rule_id: string;
    action: string;
    asset: string;
    amount: number;
    price_at_execution: number;
    expires_at: number | null;
    created_at: number;
  }>;
}

/**
 * Get execution by ID.
 */
export function getExecution(
  db: Database.Database,
  executionId: string
): {
  id: string;
  rule_id: string;
  wallet_id: string;
  user_id: number;
  action: string;
  asset: string;
  amount: number;
  price_at_execution: number;
  status: string;
  expires_at: number | null;
} | null {
  return (
    (db.prepare("SELECT * FROM trade_executions WHERE id = ?").get(executionId) as {
      id: string;
      rule_id: string;
      wallet_id: string;
      user_id: number;
      action: string;
      asset: string;
      amount: number;
      price_at_execution: number;
      status: string;
      expires_at: number | null;
    } | undefined) ?? null
  );
}

/**
 * Get trade history for a user.
 */
export function getTradeHistory(
  db: Database.Database,
  userId: number,
  limit = 50
): Array<{
  id: string;
  action: string;
  asset: string;
  amount: number;
  price_at_execution: number;
  status: string;
  executed_at: number | null;
  signature: string | null;
}> {
  return db
    .prepare(
      `SELECT id, action, asset, amount, price_at_execution, status, executed_at, signature
       FROM trade_executions
       WHERE user_id = ? AND status = 'executed'
       ORDER BY executed_at DESC
       LIMIT ?`
    )
    .all(userId, limit) as Array<{
    id: string;
    action: string;
    asset: string;
    amount: number;
    price_at_execution: number;
    status: string;
    executed_at: number | null;
    signature: string | null;
  }>;
}
