/**
 * src/telegram/marketapp-wizard.ts
 *
 * Marketapp API integration wizard:
 * - /marketapp — setup API token from marketapp.ws
 * - Validates token against live API
 * - Stores in user_settings (encrypted)
 */

import type { TelegramTransport, CallbackQueryEvent, InlineButton } from "./transport.js";
import type Database from "better-sqlite3";
import { createLogger } from "../utils/logger.js";
import { encrypt, decrypt } from "../session/user-settings.js";

const log = createLogger("MarketappWizard");

const MARKETAPP_API_BASE = "https://api.marketapp.ws";
const _MARKETAPP_TOKEN_URL = "https://marketapp.ws/api-token";
const WIZARD_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

interface WizardState {
  step: "waiting_token";
  chatId: string;
  messageId?: number;
  createdAt: number;
}

// ── MarketappWizard ──────────────────────────────────────────────────────

export class MarketappWizard {
  private bridge: TelegramTransport;
  private db: Database.Database;
  private wizardStates = new Map<number, WizardState>();

  constructor(bridge: TelegramTransport, db: Database.Database) {
    this.bridge = bridge;
    this.db = db;
    this.ensureColumn();
  }

  /** Add marketapp_token column if missing */
  private ensureColumn(): void {
    const cols = (this.db.pragma("table_info(user_settings)") as { name: string }[]).map(
      (r) => r.name
    );
    if (!cols.includes("marketapp_token")) {
      this.db.exec("ALTER TABLE user_settings ADD COLUMN marketapp_token TEXT");
      log.info("Added marketapp_token column to user_settings");
    }
  }

  // ── /marketapp command ────────────────────────────────────────────────

  async handleMarketapp(chatId: string, senderId: number, replyToId?: number): Promise<void> {
    // Check if already connected
    const existing = this.getToken(senderId);
    if (existing) {
      const buttons: InlineButton[][] = [
        [
          { text: "🔄 Update Token", callback_data: "ma:update" },
          { text: "🗑 Remove Token", callback_data: "ma:remove" },
        ],
      ];
      await this.bridge.sendMessage({
        chatId,
        text:
          "✅ <b>Marketapp is connected!</b>\n\n" +
          "Your agent can:\n" +
          "• Compare gift/username/number prices\n" +
          "• Browse marketplace listings\n" +
          "• Track price history &amp; trends\n" +
          "• Rent gifts, usernames, numbers\n\n" +
          "Use the buttons below to update or remove your token.",
        replyToId,
        inlineKeyboard: buttons,
      });
      return;
    }

    // Show setup guide
    const buttons: InlineButton[][] = [[{ text: "✅ I have my token", callback_data: "ma:paste" }]];

    await this.bridge.sendMessage({
      chatId,
      text:
        "🦞 <b>Marketapp API Setup</b>\n\n" +
        "Marketapp gives your agent access to gift, username &amp; number marketplace data + trading.\n\n" +
        "<b>How to get your API token:</b>\n" +
        '1️⃣ Open <a href="https://marketapp.ws/api-token">marketapp.ws/api-token</a>\n' +
        "2️⃣ Connect your TON wallet\n" +
        "3️⃣ Copy your API token\n" +
        "4️⃣ Come back here and tap <b>I have my token</b>\n\n" +
        "<i>The API is free — no charges.</i>",
      replyToId,
      inlineKeyboard: buttons,
    });
  }

  // ── Callback handler ──────────────────────────────────────────────────

  async handleCallback(cb: CallbackQueryEvent): Promise<boolean> {
    if (!cb.data.startsWith("ma:")) return false;

    const action = cb.data.split(":")[1];
    const userId = cb.userId;

    switch (action) {
      case "open":
        // URL button — just ack
        await this.answer(cb.queryId);
        return true;

      case "paste":
      case "update":
        // Enter token input mode
        this.wizardStates.set(userId, {
          step: "waiting_token",
          chatId: cb.chatId,
          messageId: cb.messageId,
          createdAt: Date.now(),
        });
        await this.answer(cb.queryId);
        await this.bridge.sendMessage({
          chatId: cb.chatId,
          text: "📋 Paste your Marketapp API token below:",
        });
        return true;

      case "remove":
        this.removeToken(userId);
        await this.answer(cb.queryId, "Token removed");
        if (cb.messageId) {
          await this.bridge.editMessage({
            chatId: cb.chatId,
            messageId: cb.messageId,
            text: "🗑 Marketapp token removed. Use /marketapp to reconnect anytime.",
          });
        }
        return true;

      default:
        return false;
    }
  }

  // ── Text interception (token paste) ───────────────────────────────────

  async interceptText(senderId: number, chatId: string, text: string): Promise<boolean> {
    this.cleanExpired();
    const state = this.wizardStates.get(senderId);
    if (!state || state.step !== "waiting_token") return false;

    const token = text.trim();

    // Basic validation — tokens are usually long alphanumeric strings
    if (token.length < 10 || token.includes(" ")) {
      await this.bridge.sendMessage({
        chatId,
        text: "❌ That doesn't look like a valid API token. Please paste the exact token from marketapp.ws/api-token",
      });
      return true;
    }

    // Validate against live API
    await this.bridge.sendMessage({
      chatId,
      text: "⏳ Validating token...",
    });

    const valid = await this.validateToken(token);
    if (!valid) {
      await this.bridge.sendMessage({
        chatId,
        text: '❌ Token validation failed — the API returned an error. Make sure you copied the correct token from <a href="https://marketapp.ws/api-token">marketapp.ws/api-token</a>.',
      });
      return true;
    }

    // Save token
    this.saveToken(senderId, token);
    this.wizardStates.delete(senderId);

    await this.bridge.sendMessage({
      chatId,
      text:
        "✅ <b>Marketapp connected!</b>\n\n" +
        "Your agent can now:\n" +
        "• Compare gift/username/number prices across marketplaces\n" +
        "• Browse NFT collections &amp; listings\n" +
        "• View gift sale history &amp; trends\n" +
        "• Rent gifts, usernames, and numbers\n" +
        "• Buy Stars &amp; Premium via Fragment\n\n" +
        'Just ask naturally — e.g. <i>"show me cheapest Durov gifts on sale"</i>',
    });

    return true;
  }

  // ── Token validation ──────────────────────────────────────────────────

  private async validateToken(token: string): Promise<boolean> {
    try {
      const res = await fetch(`${MARKETAPP_API_BASE}/v1/collections/`, {
        headers: { Authorization: token },
        signal: AbortSignal.timeout(10000),
      });
      return res.ok;
    } catch (err) {
      log.warn({ err }, "Marketapp token validation failed");
      return false;
    }
  }

  // ── DB operations ─────────────────────────────────────────────────────

  private saveToken(userId: number, token: string): void {
    // Ensure row exists
    this.db
      .prepare(
        `INSERT INTO user_settings (user_id, marketapp_token)
         VALUES (?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           marketapp_token = excluded.marketapp_token,
           updated_at = datetime('now')`
      )
      .run(userId, encrypt(token));
    log.info({ userId }, "Marketapp token saved (encrypted)");
  }

  getToken(userId: number): string | null {
    const row = this.db
      .prepare("SELECT marketapp_token FROM user_settings WHERE user_id = ?")
      .get(userId) as { marketapp_token: string | null } | undefined;
    if (!row?.marketapp_token) return null;
    try {
      return decrypt(row.marketapp_token);
    } catch {
      log.warn({ userId }, "Failed to decrypt marketapp token");
      return null;
    }
  }

  private removeToken(userId: number): void {
    this.db
      .prepare(
        "UPDATE user_settings SET marketapp_token = NULL, updated_at = datetime('now') WHERE user_id = ?"
      )
      .run(userId);
    log.info({ userId }, "Marketapp token removed");
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  hasActiveWizard(userId: number): boolean {
    this.cleanExpired();
    return this.wizardStates.has(userId);
  }

  cancelWizard(userId: number): boolean {
    return this.wizardStates.delete(userId);
  }

  private cleanExpired(): void {
    const now = Date.now();
    for (const [uid, state] of this.wizardStates) {
      if (now - state.createdAt > WIZARD_EXPIRY_MS) {
        this.wizardStates.delete(uid);
      }
    }
  }

  private async answer(queryId: string, text?: string): Promise<void> {
    try {
      await this.bridge.answerCallbackQuery(queryId, { message: text });
    } catch (err) {
      log.error(`Failed to answer callback: ${err instanceof Error ? err.message : err}`);
    }
  }
}
