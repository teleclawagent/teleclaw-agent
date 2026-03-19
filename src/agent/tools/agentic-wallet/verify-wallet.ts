/**
 * 🔐 Wallet Verification via 0.01 TON Transfer
 *
 * User sends 0.01 TON to the bot's wallet with their Telegram user ID as memo.
 * Bot verifies the transaction via TonAPI and links the wallet to the user.
 */

import { Type } from "@sinclair/typebox";
import type { Tool, ToolExecutor, ToolResult } from "../types.js";
import { tonapiFetch, tonapiHeaders } from "../../../constants/api-endpoints.js";
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

    // Check TonAPI key availability (check both env and in-memory config)
    const hasTonapiKey = !!process.env.TELECLAW_TONAPI_KEY || !!tonapiHeaders()["Authorization"];
    console.log("=== VERIFY WALLET: TonAPI key present:", hasTonapiKey, "env:", !!process.env.TELECLAW_TONAPI_KEY, "header:", !!tonapiHeaders()["Authorization"]);
    if (!hasTonapiKey) {
      return {
        success: false,
        error: "Cüzdan doğrulaması için TonAPI key gerekli. Setup'ta ekleyin.",
      };
    }

    // Fetch recent transactions to bot wallet via TonAPI
    try {
      const response = await tonapiFetch(
        `/accounts/${encodeURIComponent(botWallet)}/events?limit=50`
      );

      if (!response.ok) {
        log.error({ status: response.status }, "TonAPI error fetching transactions");
        return {
          success: false,
          error: "İşlemler kontrol edilemedi. Lütfen biraz bekleyip tekrar deneyin.",
        };
      }

      const data = await response.json();
      const events = data.events || [];

      // Search for a matching transaction
      for (const event of events) {
        for (const action of event.actions || []) {
          if (action.type !== "TonTransfer") continue;

          const transfer = action.TonTransfer;
          if (!transfer) continue;

          // Check: destination is bot wallet
          const dest = transfer.recipient?.address;
          if (!dest) continue;

          // Normalize addresses for comparison
          const destNorm = dest.replace(/[^A-Za-z0-9]/g, "");
          const botNorm = botWallet.replace(/[^A-Za-z0-9]/g, "");
          if (destNorm !== botNorm && !dest.includes(botWallet) && !botWallet.includes(dest)) {
            continue;
          }

          // Check: amount >= 0.01 TON (10,000,000 nanoTON)
          const amount = BigInt(transfer.amount || "0");
          if (amount < 10_000_000n) continue;

          // Check: memo contains user ID
          const comment = transfer.comment || "";
          if (!comment.includes(String(userId))) continue;

          // Match found! Link wallet
          const senderAddress = transfer.sender?.address;
          if (!senderAddress) continue;

          const txHash = event.event_id || "";

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
