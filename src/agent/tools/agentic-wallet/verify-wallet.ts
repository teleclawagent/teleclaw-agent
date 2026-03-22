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
            message: `Cüzdanın zaten doğrulanmış: \`${existing}\``,
          },
        };
      }

      const botWallet = getBotWalletAddress();
      if (!botWallet) {
        return {
          success: false,
          error: "Bot cüzdanı henüz oluşturulmamış. Önce bot cüzdanını ayarlayın.",
        };
      }

      return {
        success: true,
        data: {
          status: "instructions",
          botWallet,
          amount: "0.01",
          message:
            `Cüzdanını doğrulamak için:\n\n` +
            `1. **${botWallet}** adresine **0.01 TON** gönder\n` +
            `2. Memo/Comment kısmına Telegram ID'ni yaz: \`${userId}\`\n` +
            `3. İşlem onaylandıktan sonra "check" komutunu kullan\n\n` +
            `⚠️ Memo'ya sadece \`${userId}\` yaz, başka bir şey ekleme.`,
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
          message: `Cüzdanın zaten doğrulanmış: \`${existing}\``,
        },
      };
    }

    const botWallet = getBotWalletAddress();
    if (!botWallet) {
      return {
        success: false,
        error: "Bot cüzdanı bulunamadı. Wallet setup'ı tamamlayın.",
      };
    }

    // Fetch recent transactions to bot wallet via TonAPI
    try {
      console.log("=== VERIFY START: userId=", userId, "botWallet=", botWallet);

      const txUrl = `/blockchain/accounts/${encodeURIComponent(botWallet)}/transactions?limit=50`;
      console.log("=== VERIFY: fetching from URL:", txUrl);

      // Attempt with retry on 401/502/429
      let response = await tonapiFetch(txUrl);
      console.log("=== VERIFY: TonAPI response status:", response.status);

      if (response.status === 502 || response.status === 429 || response.status === 401) {
        console.log("=== VERIFY: retrying after 2s (status:", response.status, ")...");
        await new Promise((r) => setTimeout(r, 2000));
        response = await tonapiFetch(txUrl);
        console.log("=== VERIFY: retry response status:", response.status);
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
            console.log("=== VERIFY: Toncenter fallback found", tcTransactions.length, "transactions");
            // Re-format Toncenter data to match TonAPI structure for processing below
            const reformatted = tcTransactions.map((tx: Record<string, unknown>) => ({
              hash: tx.hash,
              in_msg: tx.in_msg ? {
                msg_type: (tx.in_msg as Record<string, unknown>).msg_type || "int_msg",
                value: String((tx.in_msg as Record<string, unknown>).value || "0"),
                source: (tx.in_msg as Record<string, unknown>).source ? { address: ((tx.in_msg as Record<string, unknown>).source as Record<string, unknown>)?.address } : undefined,
                decoded_body: (tx.in_msg as Record<string, unknown>).decoded_body || { text: (tx.in_msg as Record<string, unknown>).message || "" },
              } : undefined,
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
                .prepare("SELECT user_id FROM verified_wallets WHERE wallet_address = ? AND user_id != ?")
                .get(senderAddress, userId) as { user_id: number } | undefined;
              if (existingOwner) {
                return { success: false, error: "Bu cüzdan başka bir hesaba bağlı." };
              }

              db.prepare(
                `INSERT OR REPLACE INTO verified_wallets (user_id, wallet_address, verified_at, tx_hash) VALUES (?, ?, unixepoch(), ?)`
              ).run(userId, senderAddress, txHash);

              const existingAgenticWallet = db.prepare("SELECT id FROM agentic_wallets WHERE user_id = ?").get(userId);
              if (!existingAgenticWallet) {
                db.prepare(
                  `INSERT OR IGNORE INTO agentic_wallets (id, user_id, chat_id, address, encrypted_secret, label) VALUES (?, ?, '', ?, '', 'Verified Wallet')`
                ).run(`verified_${userId}`, userId, senderAddress);
              }

              log.info({ userId, wallet: senderAddress, txHash }, "Wallet verified via Toncenter fallback");
              return {
                success: true,
                data: {
                  status: "verified",
                  wallet: senderAddress,
                  txHash,
                  message: `✅ Cüzdan doğrulandı!\n\nAdres: \`${senderAddress}\`\nTx: \`${txHash}\``,
                },
              };
            }
            return {
              success: true,
              data: {
                status: "not_found",
                message:
                  `Eşleşen işlem bulunamadı.\n\n` +
                  `• **${botWallet}** adresine 0.01 TON gönderildi mi?\n` +
                  `• Memo: \`${userId}\`\n` +
                  `• 1-2 dakika bekleyip \`/verify check\` deneyin.`,
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
      console.log("=== VERIFY: found", transactions.length, "transactions");

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
        console.log("=== VERIFY: memo check — got:", JSON.stringify(comment), "expected:", userIdStr, "amount:", amount.toString(), "nanoTON");

        if (!comment.includes(userIdStr)) continue;

        // Match found! Get sender address
        const senderAddress = inMsg.source?.address;
        if (!senderAddress) continue;

        const txHash = tx.hash || "";
        console.log("=== VERIFY: MATCH FOUND! sender:", senderAddress, "txHash:", txHash);

        // Check if this wallet is already linked to a different user
        const existingOwner = db
          .prepare("SELECT user_id FROM verified_wallets WHERE wallet_address = ? AND user_id != ?")
          .get(senderAddress, userId) as { user_id: number } | undefined;
        if (existingOwner) {
          return {
            success: false,
            error: "Bu cüzdan başka bir hesaba bağlı. Her cüzdan sadece bir Telegram hesabına bağlanabilir.",
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

        log.info(
          { userId, wallet: senderAddress, txHash },
          "Wallet verified successfully"
        );

        return {
          success: true,
          data: {
            status: "verified",
            wallet: senderAddress,
            txHash,
            message: `✅ Cüzdan doğrulandı!\n\nAdres: \`${senderAddress}\`\nTx: \`${txHash}\``,
          },
        };
      }

      return {
        success: true,
        data: {
          status: "not_found",
          message:
            `Eşleşen işlem bulunamadı.\n\n` +
            `Kontrol edin:\n` +
            `• **${botWallet}** adresine 0.01 TON gönderildi mi?\n` +
            `• Memo kısmında \`${userId}\` yazıyor mu?\n` +
            `• İşlem onaylandı mı? (1-2 dakika bekleyin)\n\n` +
            `Tekrar denemek için "check" komutunu kullanın.`,
        },
      };
    } catch (error) {
      log.error({ err: error }, "Error checking verification transactions");
      return {
        success: false,
        error: "İşlem kontrolü sırasında hata oluştu. Lütfen tekrar deneyin.",
      };
    }
};
