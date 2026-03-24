/**
 * 🔐 Wallet Verification via 0.01 TON Transfer
 *
 * User sends 0.01 TON to the bot's wallet with their Telegram user ID as memo.
 * Bot verifies the transaction via TonAPI and links the wallet to the user.
 */

import { Type } from "@sinclair/typebox";
import type { Tool, ToolExecutor, ToolResult } from "../types.js";
import { tonapiFetch } from "../../../constants/api-endpoints.js";
import { getWalletAddress } from "../../../ton/wallet-service.js";
import { createLogger } from "../../../utils/logger.js";
import type Database from "better-sqlite3";

const log = createLogger("WalletVerify");

// ─── Schema ──────────────────────────────────────────────────────────

interface VerifyWalletParams {
  action: "start" | "check";
}

export const verifyWalletTool: Tool = {
  name: "verify_wallet",
  description:
    "Wallet verification for token gate access. " +
    "'start' shows instructions (send 0.01 TON with user ID as memo). " +
    "'check' scans recent transactions to find and verify the deposit.",
  parameters: Type.Object({
    action: Type.Union([Type.Literal("start"), Type.Literal("check")], {
      description: "'start' to show instructions, 'check' to verify the deposit",
    }),
  }),
};

// ─── DB Schema ───────────────────────────────────────────────────────

export function migrateVerifiedWallets(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS verified_wallets (
      user_id INTEGER PRIMARY KEY,
      wallet_address TEXT NOT NULL,
      verified_at INTEGER NOT NULL DEFAULT (unixepoch()),
      tx_hash TEXT,
      UNIQUE(wallet_address)
    );
  `);
}

// ─── Helpers ─────────────────────────────────────────────────────────

function getVerifiedWallet(db: Database.Database, userId: number): string | null {
  const row = db
    .prepare("SELECT wallet_address FROM verified_wallets WHERE user_id = ?")
    .get(userId) as { wallet_address: string } | undefined;
  return row?.wallet_address || null;
}

function getBotWalletAddress(): string | null {
  return getWalletAddress();
}

// ─── Executor ────────────────────────────────────────────────────────

export const verifyWalletExecutor: ToolExecutor<VerifyWalletParams> = async (
  params,
  context
): Promise<ToolResult> => {
  const db = context.db as Database.Database;
  const userId = context.senderId;

  // Ensure table exists
  migrateVerifiedWallets(db);

  if (params.action === "start") {
    // Check if already verified
    const existing = getVerifiedWallet(db, userId);
    if (existing) {
      return {
        success: true,
        data: {
          status: "already_verified",
          wallet: existing,
          message: `Your wallet is already verified: \`${existing}\``,
        },
      };
    }

    const botWallet = getBotWalletAddress();
    if (!botWallet) {
      return {
        success: false,
        error: "Bot wallet not set up yet. Please configure the bot wallet first.",
      };
    }

    return {
      success: true,
      data: {
        status: "instructions",
        botWallet,
        amount: "0.01",
        message:
          `To verify your wallet:\n\n` +
          `1. Send **0.01 TON** to **${botWallet}**\n` +
          `2. In the Memo/Comment field, enter your Telegram ID: \`${userId}\`\n` +
          `3. After the transaction is confirmed, use the "check" command\n\n` +
          `⚠️ Only write \`${userId}\` in the memo — nothing else.`,
      },
    };
  }

  // action === "check"
  const existing = getVerifiedWallet(db, userId);
  if (existing) {
    return {
      success: true,
      data: {
        status: "already_verified",
        wallet: existing,
        message: `Your wallet is already verified: \`${existing}\``,
      },
    };
  }

  const botWallet = getBotWalletAddress();
  if (!botWallet) {
    return {
      success: false,
      error: "Bot wallet not found. Please complete wallet setup first.",
    };
  }

  // Fetch recent transactions to bot wallet via TonAPI
  try {
    const txUrl = `/blockchain/accounts/${encodeURIComponent(botWallet)}/transactions?limit=50`;

    // Attempt with retry on 401/502/429
    let response = await tonapiFetch(txUrl);

    if (response.status === 502 || response.status === 429 || response.status === 401) {
      await new Promise((r) => setTimeout(r, 2000));
      response = await tonapiFetch(txUrl);
    }

    // If still 401, try Toncenter as fallback
    if (response.status === 401) {
      log.warn({ botWallet }, "TonAPI 401 — trying Toncenter fallback for tx verification");
      try {
        const toncenterUrl = `https://toncenter.com/api/v3/transactions?account=${encodeURIComponent(botWallet)}&limit=50`;
        const tcResponse = await fetch(toncenterUrl, {
          headers: { Accept: "application/json" },
        });
        if (tcResponse.ok) {
          const tcData = await tcResponse.json();
          const tcTransactions = tcData.transactions || [];
          // Re-format Toncenter data to match TonAPI structure for processing below
          const reformatted = tcTransactions.map((tx: Record<string, unknown>) => ({
            hash: tx.hash,
            in_msg: tx.in_msg
              ? {
                  msg_type: (tx.in_msg as Record<string, unknown>).msg_type || "int_msg",
                  value: String((tx.in_msg as Record<string, unknown>).value || "0"),
                  source: (tx.in_msg as Record<string, unknown>).source
                    ? {
                        address: (
                          (tx.in_msg as Record<string, unknown>).source as Record<string, unknown>
                        )?.address,
                      }
                    : undefined,
                  decoded_body: (tx.in_msg as Record<string, unknown>).decoded_body || {
                    text: (tx.in_msg as Record<string, unknown>).message || "",
                  },
                }
              : undefined,
          }));
          // Process with Toncenter data — skip to transaction matching below
          const userIdStr = String(userId);
          for (const tx of reformatted) {
            const inMsg = tx.in_msg;
            if (!inMsg) continue;
            const amount = BigInt(inMsg.value || "0");
            if (amount < 10_000_000n) continue;
            const comment = (inMsg.decoded_body?.text || "").trim();
            if (!comment.includes(userIdStr)) continue;
            const senderAddress = inMsg.source?.address;
            if (!senderAddress) continue;
            const txHash = tx.hash || "";

            const existingOwner = db
              .prepare(
                "SELECT user_id FROM verified_wallets WHERE wallet_address = ? AND user_id != ?"
              )
              .get(senderAddress, userId) as { user_id: number } | undefined;
            if (existingOwner) {
              return { success: false, error: "This wallet is already linked to another account." };
            }

            db.prepare(
              `INSERT OR REPLACE INTO verified_wallets (user_id, wallet_address, verified_at, tx_hash) VALUES (?, ?, unixepoch(), ?)`
            ).run(userId, senderAddress, txHash);

            const existingAgenticWallet = db
              .prepare("SELECT id FROM agentic_wallets WHERE user_id = ?")
              .get(userId);
            if (!existingAgenticWallet) {
              db.prepare(
                `INSERT OR IGNORE INTO agentic_wallets (id, user_id, chat_id, address, encrypted_secret, label) VALUES (?, ?, '', ?, '', 'Verified Wallet')`
              ).run(`verified_${userId}`, userId, senderAddress);
            }

            log.info(
              { userId, wallet: senderAddress, txHash },
              "Wallet verified via Toncenter fallback"
            );
            return {
              success: true,
              data: {
                status: "verified",
                wallet: senderAddress,
                txHash,
                message: `✅ Wallet verified!\n\nAddress: \`${senderAddress}\`\nTx: \`${txHash}\``,
              },
            };
          }
          return {
            success: true,
            data: {
              status: "not_found",
              message:
                `No matching transaction found.\n\n` +
                `• Did you send 0.01 TON to **${botWallet}**?\n` +
                `• Memo: \`${userId}\`\n` +
                `• Wait 1-2 minutes and try \`/verify check\` again.`,
            },
          };
        }
      } catch (tcErr) {
        log.warn({ err: tcErr }, "Toncenter fallback also failed");
      }
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      log.error({ status: response.status, body, botWallet }, "TonAPI error fetching transactions");
      return {
        success: false,
        error: `İşlemler kontrol edilemedi (HTTP ${response.status}). Lütfen biraz bekleyip tekrar deneyin.\n\n💡 Bu hata devam ederse bot adminine TonAPI key ayarını kontrol ettirin.`,
      };
    }

    const data = await response.json();
    const transactions = data.transactions || [];

    // Search for a matching transaction
    const userIdStr = String(userId);
    for (const tx of transactions) {
      const inMsg = tx.in_msg;
      if (!inMsg) continue;

      // Check: it's an internal message (user→bot transfer)
      if (inMsg.msg_type !== "int_msg") continue;

      // Check: amount >= 0.01 TON (10,000,000 nanoTON)
      const amount = BigInt(inMsg.value || "0");
      if (amount < 10_000_000n) continue;

      // Check: memo/comment contains user ID
      const comment = (inMsg.decoded_body?.text || "").trim();

      if (!comment.includes(userIdStr)) continue;

      // Match found! Get sender address
      const senderAddress = inMsg.source?.address;
      if (!senderAddress) continue;

      const txHash = tx.hash || "";

      // Check if this wallet is already linked to a different user
      const existingOwner = db
        .prepare("SELECT user_id FROM verified_wallets WHERE wallet_address = ? AND user_id != ?")
        .get(senderAddress, userId) as { user_id: number } | undefined;
      if (existingOwner) {
        return {
          success: false,
          error:
            "This wallet is already linked to another account. Each wallet can only be linked to one Telegram account.",
        };
      }

      // Save to DB
      db.prepare(
        `INSERT OR REPLACE INTO verified_wallets (user_id, wallet_address, verified_at, tx_hash)
           VALUES (?, ?, unixepoch(), ?)`
      ).run(userId, senderAddress, txHash);

      // Also update agentic_wallets if user doesn't have one
      const existingAgenticWallet = db
        .prepare("SELECT id FROM agentic_wallets WHERE user_id = ?")
        .get(userId);

      if (!existingAgenticWallet) {
        const walletId = `verified_${userId}`;
        db.prepare(
          `INSERT OR IGNORE INTO agentic_wallets (id, user_id, chat_id, address, encrypted_secret, label)
             VALUES (?, ?, '', ?, '', 'Verified Wallet')`
        ).run(walletId, userId, senderAddress);
      }

      log.info({ userId, wallet: senderAddress, txHash }, "Wallet verified successfully");

      return {
        success: true,
        data: {
          status: "verified",
          wallet: senderAddress,
          txHash,
          message: `✅ Wallet verified!\n\nAddress: \`${senderAddress}\`\nTx: \`${txHash}\``,
        },
      };
    }

    return {
      success: true,
      data: {
        status: "not_found",
        message:
          `No matching transaction found.\n\n` +
          `Please check:\n` +
          `• Did you send 0.01 TON to **${botWallet}**?\n` +
          `• Does the memo contain \`${userId}\`?\n` +
          `• Is the transaction confirmed? (wait 1-2 minutes)\n\n` +
          `Use the "check" command to try again.`,
      },
    };
  } catch (error) {
    log.error({ err: error }, "Error checking verification transactions");
    return {
      success: false,
      error: "An error occurred while checking transactions. Please try again.",
    };
  }
};
