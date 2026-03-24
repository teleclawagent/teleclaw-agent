import { Type } from "@sinclair/typebox";
import type { Tool, ToolExecutor, ToolResult } from "../types.js";
import {
  getWalletAddress,
  getWalletBalance,
  invalidateTonClientCache,
} from "../../../ton/wallet-service.js";
import { tonapiFetch } from "../../../constants/api-endpoints.js";
import { getErrorMessage } from "../../../utils/errors.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("Tools");
export const tonGetBalanceTool: Tool = {
  name: "ton_get_balance",
  description:
    "Check your current TON balance in TON units. Returns spendable funds. For jetton token balances, use jetton_balances instead.",
  parameters: Type.Object({}),
  category: "data-bearing",
};

/**
 * Fallback: fetch balance directly from TonAPI /v2/accounts/{address}
 */
async function getBalanceFromTonAPI(address: string): Promise<string | null> {
  try {
    const res = await tonapiFetch(`/accounts/${encodeURIComponent(address)}`);
    if (!res.ok) return null;
    const data = (await res.json()) as { balance?: number | string };
    if (data.balance != null) {
      const nano = BigInt(data.balance);
      const ton = Number(nano) / 1e9;
      return ton.toFixed(4);
    }
  } catch (err) {
    log.warn({ err }, "TonAPI balance fallback failed");
  }
  return null;
}

export const tonGetBalanceExecutor: ToolExecutor<object> = async (
  _params,
  _context
): Promise<ToolResult> => {
  try {
    const address = getWalletAddress();

    if (!address) {
      return {
        success: false,
        error: "Wallet not initialized. Contact admin to generate wallet.",
      };
    }

    // Primary: TonCenter via @ton/ton client
    const balance = await getWalletBalance(address);

    // Sanity check: if balance is exactly 0, verify with TonAPI fallback
    // (TonCenter/ORBS nodes can return stale 0 for active wallets)
    if (balance && balance.balanceNano === "0") {
      log.info("Balance returned 0 — verifying with TonAPI fallback...");
      const tonApiBalance = await getBalanceFromTonAPI(address);
      if (tonApiBalance && parseFloat(tonApiBalance) > 0) {
        log.warn(
          { primary: "0", fallback: tonApiBalance },
          "TonCenter returned 0 but TonAPI shows funds — using TonAPI result"
        );
        // Invalidate stale TonCenter cache
        invalidateTonClientCache();
        return {
          success: true,
          data: {
            address,
            balance: tonApiBalance,
            balanceNano: Math.round(parseFloat(tonApiBalance) * 1e9).toString(),
            message: `Your wallet balance: ${tonApiBalance} TON`,
            summary: `${tonApiBalance} TON`,
            note: "Balance verified via TonAPI (primary source returned stale data)",
          },
        };
      }
    }

    // Primary failed entirely — try TonAPI
    if (!balance) {
      log.info("Primary balance fetch failed — trying TonAPI fallback...");
      const tonApiBalance = await getBalanceFromTonAPI(address);
      if (tonApiBalance) {
        return {
          success: true,
          data: {
            address,
            balance: tonApiBalance,
            balanceNano: Math.round(parseFloat(tonApiBalance) * 1e9).toString(),
            message: `Your wallet balance: ${tonApiBalance} TON`,
            summary: `${tonApiBalance} TON`,
            note: "Balance fetched via TonAPI fallback",
          },
        };
      }
      return {
        success: false,
        error:
          "Failed to fetch balance from both TonCenter and TonAPI. Network might be unavailable.",
      };
    }

    return {
      success: true,
      data: {
        address,
        balance: balance.balance,
        balanceNano: balance.balanceNano,
        message: `Your wallet balance: ${balance.balance} TON`,
        summary: `${balance.balance} TON (${balance.balanceNano} nanoTON)`,
      },
    };
  } catch (error) {
    log.error({ err: error }, "Error in ton_get_balance");
    return {
      success: false,
      error: getErrorMessage(error),
    };
  }
};
