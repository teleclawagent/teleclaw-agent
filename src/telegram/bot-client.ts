/**
 * grammY-based Bot API client for Teleclaw.
 * Replaces TelegramUserClient when running in bot mode.
 */

import { Bot } from "grammy";
import { createLogger } from "../utils/logger.js";

const log = createLogger("BotClient");

export interface BotClientConfig {
  token: string;
  botConfig?: ConstructorParameters<typeof Bot>[1];
}

export class BotClient {
  private bot: Bot;
  private initialized = false;
  private polling = false;

  constructor(config: BotClientConfig) {
    this.bot = new Bot(config.token, config.botConfig);
  }

  getBot(): Bot {
    return this.bot;
  }

  getBotInfo() {
    return this.bot.botInfo;
  }

  /**
   * Phase 1: Initialize bot (fetch botInfo from Telegram).
   * Call this BEFORE registering any handlers.
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    await this.bot.init();
    this.initialized = true;
    log.info(`Bot initialized: @${this.bot.botInfo.username} (${this.bot.botInfo.id})`);
  }

  /**
   * Phase 2: Start long polling.
   * Call this AFTER all handlers (onNewMessage, etc.) are registered.
   */
  async startPolling(): Promise<void> {
    if (this.polling) return;

    // Clean up any stale webhook/polling session before starting
    try {
      await this.bot.api.deleteWebhook({ drop_pending_updates: true });
      log.info("Cleaned up stale webhook/polling session");
    } catch (err) {
      log.warn({ err }, "Failed to delete webhook (non-fatal)");
    }

    void this.bot
      .start({
        drop_pending_updates: true,
        allowed_updates: [
          "message",
          "edited_message",
          "callback_query",
          "inline_query",
          "chosen_inline_result",
          "channel_post",
        ],
        onStart: () => {
          log.info("Bot polling started");
        },
      })
      .catch((err: unknown) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes("409") || errMsg.includes("Conflict")) {
          log.error(
            "❌ Another bot instance is already running with this token. " +
              "Stop the other instance first, then try again."
          );
        } else {
          log.error({ err }, "❌ Bot polling failed");
        }
        this.polling = false;
      });
    this.polling = true;
  }

  async stop(): Promise<void> {
    if (!this.polling) return;
    await this.bot.stop();
    this.polling = false;
    log.info("Bot stopped");
  }

  isConnected(): boolean {
    // After init, we're "connected" (can make API calls).
    // Polling is separate — it's for receiving updates.
    return this.initialized;
  }
}
