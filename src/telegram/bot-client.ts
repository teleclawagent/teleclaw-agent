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
    log.info(
      `Bot initialized: @${this.bot.botInfo.username} (${this.bot.botInfo.id})`
    );
  }

  /**
   * Phase 2: Start long polling.
   * Call this AFTER all handlers (onNewMessage, etc.) are registered.
   */
  startPolling(): void {
    if (this.polling) return;
    void this.bot.start({
      drop_pending_updates: true,
      onStart: () => {
        log.info("Bot polling started");
      },
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
