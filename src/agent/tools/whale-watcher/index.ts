import { Type } from "@sinclair/typebox";
import { randomUUID } from "crypto";
import type { Tool, ToolExecutor, ToolResult, ToolEntry } from "../types.js";
import { Address } from "@ton/core";
import { getErrorMessage } from "../../../utils/errors.js";
import { createLogger } from "../../../utils/logger.js";

const _log = createLogger("WhaleWatcher");

const MAX_WATCHED_WALLETS = 20;

// ─── Tool: Watch Wallet ──────────────────────────────────────────────

const watchWalletTool: Tool = {
  name: "whale_watch_add",
  description:
    "Start watching a TON wallet address for transactions. You'll get DM alerts when this wallet sends or receives significant amounts (≥100 TON or any jetton transfer). Great for tracking whale activity, project wallets, or your own addresses.",
  parameters: Type.Object({
    address: Type.String({
      description: "TON wallet address to watch (EQ... or UQ... format)",
    }),
    label: Type.Optional(
      Type.String({
        description: "Friendly name for this wallet (e.g. 'TON Foundation', 'Mystery Whale')",
      })
    ),
  }),
};

const watchWalletExecutor: ToolExecutor<{ address: string; label?: string }> = async (
  params,
  context
): Promise<ToolResult> => {
  try {
    // Validate address
    try {
      Address.parse(params.address);
    } catch {
      return { success: false, error: `Invalid TON address: ${params.address}` };
    }

    // Check limit
    const count = context.db
      .prepare(
        "SELECT COUNT(*) as count FROM whale_watched_wallets WHERE user_id = ? AND active = 1"
      )
      .get(context.senderId) as { count: number };

    if (count.count >= MAX_WATCHED_WALLETS) {
      return {
        success: false,
        error: `Maximum ${MAX_WATCHED_WALLETS} watched wallets. Remove some first.`,
      };
    }

    const id = randomUUID();

    // Normalize address to raw format for consistent matching
    const normalizedAddress = Address.parse(params.address).toRawString();

    // Fetch current latest LT so we don't flood alerts on first add
    let initialLt: string | null = null;
    try {
      const { tonapiFetch } = await import("../../../constants/api-endpoints.js");
      const response = await tonapiFetch(`/accounts/${normalizedAddress}/events?limit=1`);
      if (response.ok) {
        const data = await response.json();
        if (data.events && data.events.length > 0) {
          initialLt = data.events[0].lt?.toString() || null;
        }
      }
    } catch {
      // If we can't fetch, leave null — first check will set it
    }

    try {
      context.db
        .prepare(
          `INSERT INTO whale_watched_wallets (id, user_id, address, label, last_seen_lt)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(id, context.senderId, normalizedAddress, params.label || null, initialLt);
    } catch (error: unknown) {
      if (error instanceof Error && error.message.includes("UNIQUE")) {
        return { success: false, error: "You're already watching this address." };
      }
      throw error;
    }

    const name = params.label || `${params.address.slice(0, 6)}...${params.address.slice(-4)}`;
    return {
      success: true,
      data: {
        address: params.address,
        message: `🐋 Now watching **${name}**\n\nYou'll get alerts for:\n• TON transfers ≥ 100 TON\n• Any jetton transfers\n\nChecked every 30 seconds.`,
      },
    };
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }
};

// ─── Tool: Unwatch Wallet ────────────────────────────────────────────

const unwatchWalletTool: Tool = {
  name: "whale_watch_remove",
  description: "Stop watching a wallet address.",
  parameters: Type.Object({
    address: Type.String({ description: "Wallet address to stop watching" }),
  }),
};

const unwatchWalletExecutor: ToolExecutor<{ address: string }> = async (
  params,
  context
): Promise<ToolResult> => {
  // Try both raw and original format for matching
  let normalizedAddress = params.address;
  try {
    normalizedAddress = Address.parse(params.address).toRawString();
  } catch {
    /* use as-is */
  }

  const result = context.db
    .prepare(
      "UPDATE whale_watched_wallets SET active = 0 WHERE user_id = ? AND (address = ? OR address = ?)"
    )
    .run(context.senderId, params.address, normalizedAddress);

  if (result.changes === 0) {
    return { success: false, error: "Wallet not found in your watch list." };
  }

  return {
    success: true,
    data: {
      message: `Stopped watching ${params.address.slice(0, 6)}...${params.address.slice(-4)}.`,
    },
  };
};

// ─── Tool: List Watched ──────────────────────────────────────────────

const listWatchedTool: Tool = {
  name: "whale_watch_list",
  description: "List all wallets currently being watched.",
  parameters: Type.Object({}),
};

const listWatchedExecutor: ToolExecutor<Record<string, never>> = async (
  _params,
  context
): Promise<ToolResult> => {
  const wallets = context.db
    .prepare(
      "SELECT address, label, added_at FROM whale_watched_wallets WHERE user_id = ? AND active = 1 ORDER BY added_at DESC"
    )
    .all(context.senderId) as Array<{
    address: string;
    label: string | null;
    added_at: number;
  }>;

  if (wallets.length === 0) {
    return {
      success: true,
      data: {
        wallets: [],
        message: "No wallets being watched. Use whale_watch_add to start tracking.",
      },
    };
  }

  return {
    success: true,
    data: { wallets, count: wallets.length },
  };
};

// ─── Tool: Whale Activity ────────────────────────────────────────────

const whaleActivityTool: Tool = {
  name: "whale_watch_activity",
  description:
    "Show recent whale transaction history — all alerts triggered for your watched wallets. Filter by address or show all.",
  category: "data-bearing",
  parameters: Type.Object({
    address: Type.Optional(Type.String({ description: "Filter by specific wallet address" })),
    limit: Type.Optional(
      Type.Number({
        description: "Number of transactions to show (default 20)",
        minimum: 1,
        maximum: 100,
      })
    ),
  }),
};

const whaleActivityExecutor: ToolExecutor<{ address?: string; limit?: number }> = async (
  params,
  context
): Promise<ToolResult> => {
  const limit = params.limit || 20;

  let query = `SELECT * FROM whale_transactions WHERE user_id = ?`;
  const queryParams: unknown[] = [context.senderId];

  if (params.address) {
    query += ` AND wallet_address = ?`;
    queryParams.push(params.address);
  }

  query += ` ORDER BY detected_at DESC LIMIT ?`;
  queryParams.push(limit);

  const txs = context.db.prepare(query).all(...queryParams) as Array<{
    wallet_address: string;
    wallet_label: string | null;
    tx_type: string;
    amount: string;
    asset: string;
    counterparty: string;
    detected_at: number;
  }>;

  if (txs.length === 0) {
    return {
      success: true,
      data: { transactions: [], message: "No whale activity recorded yet." },
    };
  }

  return {
    success: true,
    data: { transactions: txs, count: txs.length },
  };
};

// ─── Export ──────────────────────────────────────────────────────────

export { migrateWhaleWatcher } from "./schema.js";
export { startWhaleWatcher, stopWhaleWatcher } from "./monitor.js";

export const tools: ToolEntry[] = [
  { tool: watchWalletTool, executor: watchWalletExecutor, scope: "dm-only" },
  { tool: unwatchWalletTool, executor: unwatchWalletExecutor, scope: "dm-only" },
  { tool: listWatchedTool, executor: listWatchedExecutor, scope: "dm-only" },
  { tool: whaleActivityTool, executor: whaleActivityExecutor, scope: "dm-only" },
];
