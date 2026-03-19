import { Type } from "@sinclair/typebox";
import type { Tool, ToolExecutor, ToolResult, ToolEntry } from "../types.js";
import {
  createUserWallet,
  getUserWallet,
  getAgenticWalletBalance,
  withdrawAll,
  executeAgenticSwap,
} from "./wallet-service.js";
import {
  createRule,
  listRules,
  deactivateRule,
  getExecution,
  updateExecutionStatus,
  getPendingExecutions,
  getTradeHistory,
} from "./rule-engine.js";
import type { RuleType } from "./rule-engine.js";
import {
  setPin,
  hasPin,
  verifyPin,
  whitelistAddress,
  removeWhitelistedAddress,
  getWhitelistedAddresses,
  auditLog,
} from "./security.js";
import { getErrorMessage } from "../../../utils/errors.js";
import { createLogger } from "../../../utils/logger.js";
import { verifyWalletTool, verifyWalletExecutor } from "./verify-wallet.js";

const log = createLogger("AgenticWallet");

// ─── Tool: Set PIN (must be done first) ──────────────────────────────

const setPinTool: Tool = {
  name: "agentic_wallet_set_pin",
  description:
    "Set or update the security PIN for the agentic wallet. PIN is required for ALL withdrawals and trade confirmations. Must be 4-8 digits. When changing an existing PIN, the current PIN must be provided.",
  parameters: Type.Object({
    pin: Type.String({
      description: "New 4-8 digit PIN code",
      minLength: 4,
      maxLength: 8,
    }),
    current_pin: Type.Optional(
      Type.String({
        description: "Current PIN (required when changing an existing PIN)",
      })
    ),
  }),
};

const setPinExecutor: ToolExecutor<{ pin: string; current_pin?: string }> = async (
  params,
  context
): Promise<ToolResult> => {
  try {
    // If user already has a PIN, they MUST provide current PIN to change it
    if (hasPin(context.db, context.senderId)) {
      if (!params.current_pin) {
        return {
          success: false,
          error: "You already have a PIN set. Provide your current_pin to change it.",
        };
      }
      try {
        verifyPin(context.db, context.senderId, params.current_pin);
      } catch (error) {
        auditLog(context.db, context.senderId, "pin_change_failed", "Wrong current PIN during PIN change attempt");
        return { success: false, error: getErrorMessage(error) };
      }
    }

    setPin(context.db, context.senderId, params.pin);
    return {
      success: true,
      data: {
        message:
          "✅ Security PIN set. You'll need this PIN for every withdrawal and trade confirmation. Don't share it with anyone.",
      },
    };
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }
};

// ─── Tool: Create Wallet ─────────────────────────────────────────────

const createWalletTool: Tool = {
  name: "agentic_wallet_create",
  description:
    "Create a personal trading wallet for the user. This wallet is managed by Teleclaw and can execute trades based on rules the user sets. Each user gets one wallet. After creating, set a PIN with agentic_wallet_set_pin and whitelist withdrawal addresses with agentic_wallet_whitelist_add.",
  parameters: Type.Object({
    label: Type.Optional(
      Type.String({ description: "Optional label for the wallet (e.g. 'Trading', 'DCA')" })
    ),
  }),
};

const createWalletExecutor: ToolExecutor<{ label?: string }> = async (
  params,
  context
): Promise<ToolResult> => {
  try {
    const { id, address } = await createUserWallet(
      context.db,
      context.senderId,
      context.chatId,
      params.label
    );
    return {
      success: true,
      data: {
        walletId: id,
        address,
        message:
          `🔐 Trading wallet created!\n\n` +
          `Address: \`${address}\`\n\n` +
          `**⚠️ IMPORTANT — Do these steps before depositing:**\n` +
          `1. Set your security PIN: tell me a 4-8 digit PIN\n` +
          `2. Whitelist your withdrawal address(es)\n` +
          `3. Then deposit TON to the address above\n\n` +
          `Without a PIN, you cannot withdraw or confirm trades.`,
      },
    };
  } catch (error) {
    log.error({ err: error }, "Failed to create wallet");
    return { success: false, error: getErrorMessage(error) };
  }
};

// ─── Tool: Check Balance ─────────────────────────────────────────────

const balanceTool: Tool = {
  name: "agentic_wallet_balance",
  description: "Check the balance of the user's agentic trading wallet.",
  parameters: Type.Object({}),
};

const balanceExecutor: ToolExecutor<Record<string, never>> = async (
  _params,
  context
): Promise<ToolResult> => {
  try {
    const wallet = getUserWallet(context.db, context.senderId);
    if (!wallet) {
      return {
        success: false,
        error: "No trading wallet found. Create one first with agentic_wallet_create.",
      };
    }

    const balance = await getAgenticWalletBalance(wallet.address);
    if (!balance) {
      return { success: false, error: "Failed to fetch wallet balance." };
    }

    const pinSet = hasPin(context.db, context.senderId);

    return {
      success: true,
      data: {
        address: wallet.address,
        label: wallet.label,
        tonBalance: balance.tonBalance,
        maxTradeAmount: wallet.max_trade_amount,
        dailyLimit: wallet.daily_limit,
        pinSet,
        message:
          `Trading Wallet${wallet.label ? ` (${wallet.label})` : ""}\n` +
          `Address: \`${wallet.address}\`\n` +
          `Balance: ${balance.tonBalance} TON\n` +
          `Max per trade: ${wallet.max_trade_amount} TON\n` +
          `Daily limit: ${wallet.daily_limit} TON\n` +
          `PIN: ${pinSet ? "✅ Set" : "❌ NOT SET — set one now!"}`,
      },
    };
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }
};

// ─── Tool: Deposit Address ───────────────────────────────────────────

const depositAddressTool: Tool = {
  name: "agentic_wallet_deposit_address",
  description: "Show the deposit address for the user's agentic trading wallet.",
  parameters: Type.Object({}),
};

const depositAddressExecutor: ToolExecutor<Record<string, never>> = async (
  _params,
  context
): Promise<ToolResult> => {
  const wallet = getUserWallet(context.db, context.senderId);
  if (!wallet) {
    return {
      success: false,
      error: "No trading wallet found. Create one first with agentic_wallet_create.",
    };
  }
  return {
    success: true,
    data: {
      address: wallet.address,
      message: `Send TON to fund your trading wallet:\n\n\`${wallet.address}\``,
    },
  };
};

// ─── Tool: Whitelist Add ─────────────────────────────────────────────

const whitelistAddTool: Tool = {
  name: "agentic_wallet_whitelist_add",
  description:
    "Add a TON address to the withdrawal whitelist. Requires security PIN. Only whitelisted addresses can receive withdrawals — this prevents unauthorized fund transfers even if someone gains access to your chat.",
  parameters: Type.Object({
    address: Type.String({
      description: "TON address to whitelist (EQ... or UQ... format)",
    }),
    pin: Type.String({
      description: "Your security PIN to authorize this action",
    }),
    label: Type.Optional(
      Type.String({ description: "Label for this address (e.g. 'My Tonkeeper')" })
    ),
  }),
};

const whitelistAddExecutor: ToolExecutor<{ address: string; pin: string; label?: string }> = async (
  params,
  context
): Promise<ToolResult> => {
  try {
    // Validate address format
    const { Address } = await import("@ton/core");
    try {
      Address.parse(params.address);
    } catch {
      return { success: false, error: `Invalid TON address: ${params.address}` };
    }

    // Require PIN to add whitelist entries — VERIFY, not just check existence
    if (!hasPin(context.db, context.senderId)) {
      return { success: false, error: "Set a security PIN first with agentic_wallet_set_pin." };
    }
    try {
      verifyPin(context.db, context.senderId, params.pin);
    } catch (error) {
      auditLog(context.db, context.senderId, "whitelist_add_pin_failed", `Failed PIN for whitelist add: ${params.address}`);
      return { success: false, error: getErrorMessage(error) };
    }

    whitelistAddress(context.db, context.senderId, params.address, params.label);
    return {
      success: true,
      data: {
        address: params.address,
        label: params.label,
        message: `✅ Address whitelisted: ${params.address}${params.label ? ` (${params.label})` : ""}`,
      },
    };
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }
};

// ─── Tool: Whitelist Remove ──────────────────────────────────────────

const whitelistRemoveTool: Tool = {
  name: "agentic_wallet_whitelist_remove",
  description: "Remove an address from the withdrawal whitelist.",
  parameters: Type.Object({
    address: Type.String({ description: "TON address to remove from whitelist" }),
    pin: Type.String({ description: "Your security PIN to confirm this action" }),
  }),
};

const whitelistRemoveExecutor: ToolExecutor<{ address: string; pin: string }> = async (
  params,
  context
): Promise<ToolResult> => {
  try {
    verifyPin(context.db, context.senderId, params.pin);
    const removed = removeWhitelistedAddress(context.db, context.senderId, params.address);
    if (!removed) {
      return { success: false, error: "Address not found in whitelist." };
    }
    return {
      success: true,
      data: { message: `Address removed from whitelist: ${params.address}` },
    };
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }
};

// ─── Tool: Whitelist List ────────────────────────────────────────────

const whitelistListTool: Tool = {
  name: "agentic_wallet_whitelist_list",
  description: "List all whitelisted withdrawal addresses.",
  parameters: Type.Object({}),
};

const whitelistListExecutor: ToolExecutor<Record<string, never>> = async (
  _params,
  context
): Promise<ToolResult> => {
  const addresses = getWhitelistedAddresses(context.db, context.senderId);
  if (addresses.length === 0) {
    return {
      success: true,
      data: {
        addresses: [],
        message: "No whitelisted addresses. Add one with agentic_wallet_whitelist_add.",
      },
    };
  }
  return {
    success: true,
    data: { addresses, count: addresses.length },
  };
};

// ─── Tool: Withdraw ──────────────────────────────────────────────────

const withdrawTool: Tool = {
  name: "agentic_wallet_withdraw",
  description:
    "Withdraw all TON from the agentic trading wallet. REQUIRES: security PIN + destination must be a whitelisted address.",
  parameters: Type.Object({
    to_address: Type.String({
      description: "Destination TON address (must be whitelisted)",
    }),
    pin: Type.String({
      description: "Your security PIN",
    }),
  }),
};

const withdrawExecutor: ToolExecutor<{ to_address: string; pin: string }> = async (
  params,
  context
): Promise<ToolResult> => {
  try {
    const result = await withdrawAll(context.db, context.senderId, params.to_address, params.pin);
    if (!result.success) {
      return { success: false, error: result.error };
    }
    return {
      success: true,
      data: {
        amount: result.amount,
        to: params.to_address,
        message: `✅ Withdrew ${result.amount} TON to ${params.to_address}. Transaction sent — check balance in ~30 seconds.`,
      },
    };
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }
};

// ─── Tool: Set Rule ──────────────────────────────────────────────────

const setRuleTool: Tool = {
  name: "agentic_wallet_set_rule",
  description:
    "Create a trading rule. Rules monitor prices and notify you when conditions are met. ALL trades require PIN confirmation — no auto-execution. Rule types: price_below (buy when price drops), price_above (sell when price rises), dca (buy at intervals), stop_loss (sell if price drops to target), take_profit (sell when price target hit). Max 100 TON per trade, 500 TON daily, 20 active rules max.",
  parameters: Type.Object({
    rule_type: Type.Union(
      [
        Type.Literal("price_below"),
        Type.Literal("price_above"),
        Type.Literal("dca"),
        Type.Literal("stop_loss"),
        Type.Literal("take_profit"),
      ],
      { description: "Type of trading rule" }
    ),
    asset: Type.String({
      description: "Asset to trade — 'ton' for TON, or jetton master address (EQ... format)",
    }),
    amount: Type.Number({
      description: "Amount in TON to trade when rule triggers",
      minimum: 0.1,
      maximum: 100,
    }),
    condition_value: Type.Optional(
      Type.Number({
        description:
          "Price threshold in USD (for price_above/below/take_profit/stop_loss)",
      })
    ),
    target_asset: Type.Optional(
      Type.String({ description: "Asset to swap into. Defaults to TON." })
    ),
    interval_seconds: Type.Optional(
      Type.Number({
        description: "Interval for DCA rules in seconds (min 3600 = 1 hour)",
        minimum: 3600,
      })
    ),
    rule_description: Type.Optional(
      Type.String({ description: "Human-readable description of the rule" })
    ),
  }),
};

const setRuleExecutor: ToolExecutor<{
  rule_type: RuleType;
  asset: string;
  amount: number;
  condition_value?: number;
  target_asset?: string;
  interval_seconds?: number;
  rule_description?: string;
}> = async (params, context): Promise<ToolResult> => {
  try {
    const wallet = getUserWallet(context.db, context.senderId);
    if (!wallet) {
      return {
        success: false,
        error: "No trading wallet found. Create one first.",
      };
    }

    if (!hasPin(context.db, context.senderId)) {
      return {
        success: false,
        error: "Set a security PIN first. You'll need it to confirm triggered trades.",
      };
    }

    if (params.rule_type === "dca" && !params.interval_seconds) {
      return {
        success: false,
        error: "DCA rules require interval_seconds (e.g. 86400 for daily).",
      };
    }
    if (
      ["price_below", "price_above", "take_profit", "stop_loss"].includes(params.rule_type) &&
      params.condition_value === undefined
    ) {
      return {
        success: false,
        error: `${params.rule_type} rules require a condition_value (price threshold in USD).`,
      };
    }

    const ruleText =
      params.rule_description ||
      `${params.rule_type}: ${params.amount} TON on ${params.asset}${params.condition_value ? ` @ $${params.condition_value}` : ""}`;

    const rule = createRule(context.db, {
      walletId: wallet.id,
      userId: context.senderId,
      ruleText,
      ruleType: params.rule_type,
      asset: params.asset,
      targetAsset: params.target_asset,
      conditionValue: params.condition_value,
      amount: params.amount,
      intervalSeconds: params.interval_seconds,
    });

    return {
      success: true,
      data: {
        ruleId: rule.id,
        ruleType: rule.rule_type,
        asset: rule.asset,
        amount: rule.amount,
        conditionValue: rule.condition_value,
        message:
          `📋 Trading rule created!\n\n` +
          `Rule: ${ruleText}\n` +
          `ID: \`${rule.id.slice(0, 8)}\`\n` +
          `Confirmation: Always required (PIN + manual confirm)\n\n` +
          `Price monitor checks every 60 seconds. You'll get a notification when the rule triggers, and you'll need to confirm with your PIN to execute.`,
      },
    };
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }
};

// ─── Tool: List Rules ────────────────────────────────────────────────

const listRulesTool: Tool = {
  name: "agentic_wallet_list_rules",
  description: "List all active trading rules for the user's agentic wallet.",
  parameters: Type.Object({}),
};

const listRulesExecutor: ToolExecutor<Record<string, never>> = async (
  _params,
  context
): Promise<ToolResult> => {
  const rules = listRules(context.db, context.senderId);
  if (rules.length === 0) {
    return {
      success: true,
      data: { rules: [], message: "No active trading rules." },
    };
  }

  const ruleList = rules.map((r, i) => ({
    index: i + 1,
    id: r.id.slice(0, 8),
    type: r.rule_type,
    asset: r.asset,
    amount: r.amount,
    condition: r.condition_value,
    interval: r.interval_seconds ? `${r.interval_seconds / 3600}h` : null,
    description: r.rule_text,
  }));

  return {
    success: true,
    data: { rules: ruleList, count: rules.length },
  };
};

// ─── Tool: Remove Rule ───────────────────────────────────────────────

const removeRuleTool: Tool = {
  name: "agentic_wallet_remove_rule",
  description: "Deactivate/remove a trading rule.",
  parameters: Type.Object({
    rule_id: Type.String({ description: "Rule ID (full UUID or first 8 characters)" }),
  }),
};

const removeRuleExecutor: ToolExecutor<{ rule_id: string }> = async (
  params,
  context
): Promise<ToolResult> => {
  let ruleId = params.rule_id;
  if (ruleId.length < 36) {
    const allRules = listRules(context.db, context.senderId);
    const match = allRules.find((r) => r.id.startsWith(ruleId));
    if (!match) {
      return { success: false, error: `No active rule found matching ID: ${ruleId}` };
    }
    ruleId = match.id;
  }

  const removed = deactivateRule(context.db, ruleId, context.senderId);
  if (!removed) {
    return { success: false, error: "Rule not found or already inactive." };
  }

  return {
    success: true,
    data: { ruleId, message: `Rule ${ruleId.slice(0, 8)} deactivated.` },
  };
};

// ─── Tool: Confirm Trade ─────────────────────────────────────────────

const confirmTradeTool: Tool = {
  name: "agentic_wallet_confirm_trade",
  description:
    "Confirm or cancel a pending trade. REQUIRES security PIN to confirm. Pending trades expire after 5 minutes.",
  parameters: Type.Object({
    execution_id: Type.String({
      description: "Execution ID (full UUID or first 8 characters)",
    }),
    action: Type.Union([Type.Literal("confirm"), Type.Literal("cancel")], {
      description: "Whether to confirm (execute) or cancel the trade",
    }),
    pin: Type.Optional(
      Type.String({ description: "Your security PIN (required for confirm, not needed for cancel)" })
    ),
  }),
};

const confirmTradeExecutor: ToolExecutor<{
  execution_id: string;
  action: "confirm" | "cancel";
  pin?: string;
}> = async (params, context): Promise<ToolResult> => {
  try {
    // Resolve partial ID
    let execId = params.execution_id;
    if (execId.length < 36) {
      const pending = getPendingExecutions(context.db, context.senderId);
      const match = pending.find((e) => e.id.startsWith(execId));
      if (!match) {
        return { success: false, error: `No pending execution found matching ID: ${execId}` };
      }
      execId = match.id;
    }

    const execution = getExecution(context.db, execId);
    if (!execution) {
      return { success: false, error: "Execution not found." };
    }
    if (execution.user_id !== context.senderId) {
      return { success: false, error: "This execution doesn't belong to you." };
    }
    if (execution.status !== "pending") {
      return { success: false, error: `Execution is already ${execution.status}.` };
    }

    // Check expiry
    if (execution.expires_at && execution.expires_at < Math.floor(Date.now() / 1000)) {
      updateExecutionStatus(context.db, execId, "expired");
      return { success: false, error: "This trade has expired. Rules will trigger again if conditions are still met." };
    }

    if (params.action === "cancel") {
      updateExecutionStatus(context.db, execId, "cancelled");
      auditLog(context.db, context.senderId, "trade_cancelled", `Cancelled ${execId.slice(0, 8)}`);
      return {
        success: true,
        data: { message: `❌ Trade cancelled: ${execution.action}` },
      };
    }

    // Confirm — MUST provide PIN
    if (!params.pin) {
      return { success: false, error: "PIN required to confirm trade. Provide your security PIN." };
    }

    try {
      verifyPin(context.db, context.senderId, params.pin);
    } catch (error) {
      auditLog(context.db, context.senderId, "trade_confirm_pin_failed", `Failed PIN for ${execId.slice(0, 8)}`);
      return { success: false, error: getErrorMessage(error) };
    }

    // PIN verified → execute
    updateExecutionStatus(context.db, execId, "confirmed");

    const swapResult = await executeAgenticSwap(context.db, context.senderId, {
      fromAsset: "ton",
      toAsset: execution.asset,
      amount: execution.amount,
      executionId: execId,
    });

    if (swapResult.success) {
      updateExecutionStatus(context.db, execId, "executed", JSON.stringify(swapResult.data));
      auditLog(context.db, context.senderId, "trade_executed", `Executed ${execId.slice(0, 8)}: ${execution.action}`);
      return {
        success: true,
        data: {
          ...(typeof swapResult.data === "object" && swapResult.data !== null ? swapResult.data : {}),
          message: `✅ Trade executed!\n\n${execution.action}\n\nCheck your wallet balance in ~30 seconds.`,
        },
      };
    } else {
      updateExecutionStatus(context.db, execId, "failed", swapResult.error);
      return { success: false, error: `Trade failed: ${swapResult.error}` };
    }
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }
};

// ─── Tool: Trade History ─────────────────────────────────────────────

const tradeHistoryTool: Tool = {
  name: "agentic_wallet_history",
  description: "View executed trade history for the user's agentic wallet. Each trade has a cryptographic signature for verification.",
  parameters: Type.Object({
    limit: Type.Optional(
      Type.Number({ description: "Number of trades to show (default 20)", minimum: 1, maximum: 100 })
    ),
  }),
};

const tradeHistoryExecutor: ToolExecutor<{ limit?: number }> = async (
  params,
  context
): Promise<ToolResult> => {
  const trades = getTradeHistory(context.db, context.senderId, params.limit || 20);
  if (trades.length === 0) {
    return {
      success: true,
      data: { trades: [], message: "No executed trades yet." },
    };
  }
  return {
    success: true,
    data: { trades, count: trades.length },
  };
};

// ─── Safe Mode ───────────────────────────────────────────────────────

import {
  safeConnectTool,
  safeConnectExecutor,
  safeSwapTool,
  safeSwapExecutor,
  safeTransferTool,
  safeTransferExecutor,
  safeTxHistoryTool,
  safeTxHistoryExecutor,
} from "./safe-mode.js";

// ─── Trading Mode Selector ──────────────────────────────────────────

import {
  tradingModeSetTool,
  tradingModeSetExecutor,
  tradingModeViewTool,
  tradingModeViewExecutor,
} from "./trading-mode.js";

// ─── Export All Tools ────────────────────────────────────────────────

export { migrateAgenticWallet } from "./schema.js";
export { startPriceMonitor, stopPriceMonitor } from "./price-monitor.js";
export { getEffectiveMode } from "./trading-mode.js";

export const tools: ToolEntry[] = [
  // 🔀 Mode Selection (do this first)
  { tool: tradingModeSetTool, executor: tradingModeSetExecutor, scope: "dm-only" },
  { tool: tradingModeViewTool, executor: tradingModeViewExecutor, scope: "dm-only" },

  // 🟢 Safe Mode (no custody)
  { tool: safeConnectTool, executor: safeConnectExecutor, scope: "dm-only" },
  { tool: safeSwapTool, executor: safeSwapExecutor, scope: "dm-only" },
  { tool: safeTransferTool, executor: safeTransferExecutor, scope: "dm-only" },
  { tool: safeTxHistoryTool, executor: safeTxHistoryExecutor, scope: "dm-only" },

  // 🔴 Auto Mode — Security (must be done first)
  { tool: setPinTool, executor: setPinExecutor, scope: "dm-only" },
  // 🔴 Auto Mode — Wallet
  { tool: createWalletTool, executor: createWalletExecutor, scope: "dm-only" },
  { tool: balanceTool, executor: balanceExecutor, scope: "dm-only" },
  { tool: depositAddressTool, executor: depositAddressExecutor, scope: "dm-only" },
  { tool: withdrawTool, executor: withdrawExecutor, scope: "dm-only" },
  // 🔴 Auto Mode — Whitelist
  { tool: whitelistAddTool, executor: whitelistAddExecutor, scope: "dm-only" },
  { tool: whitelistRemoveTool, executor: whitelistRemoveExecutor, scope: "dm-only" },
  { tool: whitelistListTool, executor: whitelistListExecutor, scope: "dm-only" },
  // 🔴 Auto Mode — Trading rules
  { tool: setRuleTool, executor: setRuleExecutor, scope: "dm-only" },
  { tool: listRulesTool, executor: listRulesExecutor, scope: "dm-only" },
  { tool: removeRuleTool, executor: removeRuleExecutor, scope: "dm-only" },
  // 🔴 Auto Mode — Trade execution
  { tool: confirmTradeTool, executor: confirmTradeExecutor, scope: "dm-only" },
  { tool: tradeHistoryTool, executor: tradeHistoryExecutor, scope: "dm-only" },
  // 🔐 Wallet Verification (token gate)
  { tool: verifyWalletTool, executor: verifyWalletExecutor as unknown as ToolExecutor<Record<string, unknown>>, scope: "dm-only" },
];
