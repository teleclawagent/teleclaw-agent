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
  private started = false;

  constructor(config: BotClientConfig) {
    this.bot = new Bot(config.token, config.botConfig);
  }

  /**
   * Get the underlying grammY Bot instance.
   */
  getBot(): Bot {
    return this.bot;
  }

  /**
   * Get bot info (id, username, name, etc.).
   * Only available after start() or init().
   */
  getBotInfo() {
    return this.bot.botInfo;
  }

  /**
   * Initialize the bot (fetches botInfo) and start polling.
   */
  async start(): Promise<void> {
    if (this.started) return;

    // Init fetches bot info from Telegram
    await this.bot.init();
    log.info(
      `Bot initialized: @${this.bot.botInfo.username} (${this.bot.botInfo.id})`
    );

    // Start long polling in background (non-blocking)
    void this.bot.start({
      drop_pending_updates: true,
      onStart: () => {
        log.info("Bot polling started");
      },
    });

    this.started = true;
  }

  /**
   * Stop the bot gracefully.
   */
  async stop(): Promise<void> {
    if (!this.started) return;
    await this.bot.stop();
    this.started = false;
    log.info("Bot stopped");
  }

  /**
   * Whether the bot is currently connected and polling.
   */
  isConnected(): boolean {
    return this.started;
  }
}
