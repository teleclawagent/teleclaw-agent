/**
 * Bot API bridge implementing TelegramTransport via grammY.
 * Used when Teleclaw runs as a Telegram bot (self-hosted by users).
 */

import { InlineKeyboard, InputFile } from "grammy";
import type { Message } from "grammy/types";
import { BotClient, type BotClientConfig } from "./bot-client.js";
import type {
  TelegramTransport,
  TelegramMessage,
  InlineButton,
  SendMessageOptions,
  CallbackQueryEvent,
  LegacyClientCompat,
} from "./transport.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("BotBridge");

export class BotBridge implements TelegramTransport {
  private client: BotClient;
  private ownId?: bigint;
  private ownUsername?: string;

  constructor(config: BotClientConfig) {
    this.client = new BotClient(config);
  }

  // ── Lifecycle ──

  async connect(): Promise<void> {
    // Phase 1: init only (fetch bot info). Handlers registered after this.
    await this.client.init();
    const info = this.client.getBotInfo();
    this.ownId = BigInt(info.id);
    this.ownUsername = info.username?.toLowerCase();

    // Register commands with BotFather
    try {
      await this.client.getBot().api.setMyCommands([
        { command: "help", description: "List all commands" },
        { command: "ping", description: "Check if agent is alive" },
        { command: "verify", description: "Verify your TON wallet" },
        { command: "otc", description: "OTC Matchmaker — P2P trading" },
        { command: "marketapp", description: "Connect Marketapp API" },
        { command: "addprovider", description: "Add a new AI provider" },
        { command: "models", description: "Switch AI model" },
        { command: "removeprovider", description: "Remove custom AI settings" },
        { command: "apikey", description: "Set your own LLM API key" },
        { command: "mysettings", description: "View your settings" },
        { command: "reset", description: "Reset conversation (fresh start)" },
      ]);
      // Register admin-only commands separately
      await this.client.getBot().api.setMyCommands(
        [
          { command: "status", description: "Agent status & info" },
          { command: "reset", description: "Reset session context" },
          { command: "history", description: "Recent messages" },
          { command: "settings", description: "View all settings" },
          { command: "wallet", description: "TON wallet balance" },
          { command: "portfolio", description: "Portfolio summary" },
          { command: "model", description: "Switch LLM model" },
          { command: "strategy", description: "Trading thresholds" },
          { command: "sniper", description: "Sniper commands" },
          { command: "alerts", description: "Alert management" },
          { command: "version", description: "Check for updates" },
          { command: "update", description: "Update to latest version" },
          { command: "clear", description: "Clear chat history" },
          { command: "pause", description: "Pause agent" },
          { command: "resume", description: "Resume agent" },
        ],
        { scope: { type: "all_chat_administrators" } }
      );
      log.info("Registered bot commands with BotFather");
    } catch (error) {
      log.warn({ err: error }, "Failed to register bot commands");
    }
  }

  /**
   * Start polling AFTER all handlers are registered.
   * Must be called after onNewMessage/onServiceMessage/addCallbackQueryHandler.
   */
  startPolling(): void {
    void this.client.startPolling();
  }

  async disconnect(): Promise<void> {
    await this.client.stop();
  }

  isAvailable(): boolean {
    return this.client.isConnected();
  }

  // ── Identity ──

  getOwnUserId(): bigint | undefined {
    return this.ownId;
  }

  getUsername(): string | undefined {
    return this.ownUsername;
  }

  // ── Messaging ──

  async sendMessage(options: SendMessageOptions & { _rawPeer?: unknown }): Promise<{ id: number }> {
    const bot = this.client.getBot();
    const chatId = options.chatId;

    let replyMarkup: ReturnType<InlineKeyboard["toFlowed"]> | undefined;
    if (options.inlineKeyboard && options.inlineKeyboard.length > 0) {
      const kb = new InlineKeyboard();
      for (const row of options.inlineKeyboard) {
        for (const btn of row) {
          kb.text(btn.text, btn.callback_data);
        }
        kb.row();
      }
      replyMarkup = kb;
    }

    const sent = await bot.api.sendMessage(chatId, options.text, {
      parse_mode: "HTML",
      reply_parameters: options.replyToId ? { message_id: options.replyToId } : undefined,
      reply_markup: replyMarkup,
    });

    return { id: sent.message_id };
  }

  async editMessage(options: {
    chatId: string;
    messageId: number;
    text: string;
    inlineKeyboard?: InlineButton[][];
  }): Promise<{ id: number }> {
    const bot = this.client.getBot();

    let replyMarkup: InlineKeyboard | undefined;
    if (options.inlineKeyboard && options.inlineKeyboard.length > 0) {
      const kb = new InlineKeyboard();
      for (const row of options.inlineKeyboard) {
        for (const btn of row) {
          kb.text(btn.text, btn.callback_data);
        }
        kb.row();
      }
      replyMarkup = kb;
    }

    const result = await bot.api.editMessageText(options.chatId, options.messageId, options.text, {
      parse_mode: "HTML",
      reply_markup: replyMarkup,
    });

    const msgId =
      typeof result === "object" && result !== null && "message_id" in result
        ? (result as Message).message_id
        : options.messageId;

    return { id: msgId };
  }

  async setTyping(chatId: string): Promise<void> {
    try {
      await this.client.getBot().api.sendChatAction(chatId, "typing");
    } catch (error) {
      log.warn({ err: error }, "Failed to send typing action");
    }
  }

  async sendReaction(chatId: string, messageId: number, emoji: string): Promise<void> {
    try {
      await this.client.getBot().api.setMessageReaction(chatId, messageId, [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TG emoji union type
        { type: "emoji", emoji: emoji as any },
      ]);
    } catch (error) {
      log.warn({ err: error }, "Failed to send reaction");
    }
  }

  // ── Extended messaging ──

  async deleteMessages(chatId: string, messageIds: number[]): Promise<void> {
    const bot = this.client.getBot();
    for (const msgId of messageIds) {
      try {
        await bot.api.deleteMessage(chatId, msgId);
      } catch (error) {
        log.warn({ err: error }, `Failed to delete message ${msgId}`);
      }
    }
  }

  async forwardMessage(
    fromChatId: string,
    toChatId: string,
    messageId: number
  ): Promise<{ id: number }> {
    const bot = this.client.getBot();
    const sent = await bot.api.forwardMessage(toChatId, fromChatId, messageId);
    return { id: sent.message_id };
  }

  async pinMessage(chatId: string, messageId: number, silent = false): Promise<void> {
    await this.client.getBot().api.pinChatMessage(chatId, messageId, {
      disable_notification: silent,
    });
  }

  async unpinMessage(chatId: string, messageId: number): Promise<void> {
    await this.client.getBot().api.unpinChatMessage(chatId, messageId);
  }

  // ── Media ──

  async sendPhoto(
    chatId: string,
    photo: string | Buffer,
    options?: { caption?: string; replyToId?: number }
  ): Promise<{ id: number }> {
    const bot = this.client.getBot();
    const sent = await bot.api.sendPhoto(
      chatId,
      typeof photo === "string" ? photo : new InputFile(photo, "photo.jpg"),
      {
        caption: options?.caption,
        parse_mode: "HTML",
        reply_parameters: options?.replyToId ? { message_id: options.replyToId } : undefined,
      }
    );
    return { id: sent.message_id };
  }

  async sendAnimation(
    chatId: string,
    animation: string | Buffer,
    options?: { caption?: string; replyToId?: number }
  ): Promise<{ id: number }> {
    const bot = this.client.getBot();
    const sent = await bot.api.sendAnimation(
      chatId,
      typeof animation === "string" ? animation : new InputFile(animation, "animation.gif"),
      {
        caption: options?.caption,
        parse_mode: "HTML",
        reply_parameters: options?.replyToId ? { message_id: options.replyToId } : undefined,
      }
    );
    return { id: sent.message_id };
  }

  async sendSticker(
    chatId: string,
    sticker: string | Buffer,
    options?: { replyToId?: number }
  ): Promise<{ id: number }> {
    const bot = this.client.getBot();
    const sent = await bot.api.sendSticker(
      chatId,
      typeof sticker === "string" ? sticker : new InputFile(sticker, "sticker.webp"),
      {
        reply_parameters: options?.replyToId ? { message_id: options.replyToId } : undefined,
      }
    );
    return { id: sent.message_id };
  }

  async sendVoice(
    chatId: string,
    voice: string | Buffer,
    options?: { caption?: string; replyToId?: number; duration?: number }
  ): Promise<{ id: number }> {
    const bot = this.client.getBot();
    const sent = await bot.api.sendVoice(
      chatId,
      typeof voice === "string" ? voice : new InputFile(voice, "voice.ogg"),
      {
        caption: options?.caption,
        parse_mode: "HTML",
        duration: options?.duration,
        reply_parameters: options?.replyToId ? { message_id: options.replyToId } : undefined,
      }
    );
    return { id: sent.message_id };
  }

  async sendDocument(
    chatId: string,
    document: string | Buffer,
    options?: { caption?: string; replyToId?: number; filename?: string }
  ): Promise<{ id: number }> {
    const bot = this.client.getBot();
    const sent = await bot.api.sendDocument(
      chatId,
      typeof document === "string"
        ? document
        : new InputFile(document, options?.filename ?? "file"),
      {
        caption: options?.caption,
        parse_mode: "HTML",
        reply_parameters: options?.replyToId ? { message_id: options.replyToId } : undefined,
      }
    );
    return { id: sent.message_id };
  }

  async downloadFile(fileId: string): Promise<Buffer> {
    const bot = this.client.getBot();
    const file = await bot.api.getFile(fileId);
    if (!file.file_path) throw new Error("File path not available");
    const url = `https://api.telegram.org/file/bot${this.client.getBot().token}/${file.file_path}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Download failed: ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }

  // ── Interactive ──

  async sendPoll(
    chatId: string,
    question: string,
    options: string[],
    opts?: { isAnonymous?: boolean; allowsMultiple?: boolean; replyToId?: number }
  ): Promise<{ id: number }> {
    const bot = this.client.getBot();
    const sent = await bot.api.sendPoll(chatId, question, options, {
      is_anonymous: opts?.isAnonymous,
      allows_multiple_answers: opts?.allowsMultiple,
      reply_parameters: opts?.replyToId ? { message_id: opts.replyToId } : undefined,
    });
    return { id: sent.message_id };
  }

  async sendDice(
    chatId: string,
    emoji?: string,
    _replyToId?: number
  ): Promise<{ id: number; value?: number }> {
    const bot = this.client.getBot();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- emoji is a union of dice emojis
    const sent = await bot.api.sendDice(chatId, emoji as any);
    return { id: sent.message_id, value: sent.dice?.value };
  }

  // ── Event handlers ──

  onNewMessage(
    handler: (message: TelegramMessage) => void | Promise<void>,
    _filters?: { incoming?: boolean; outgoing?: boolean; chats?: string[] }
  ): void {
    const bot = this.client.getBot();

    bot.on("message", async (ctx) => {
      const msg = ctx.message;
      log.info(
        { from: msg.from?.first_name, text: msg.text?.slice(0, 50), chatId: msg.chat.id },
        "📩 Incoming message"
      );
      const parsed = this.parseMessage(msg);
      // Download photo for vision (if present)
      if (msg.photo && msg.photo.length > 0) {
        try {
          const largestPhoto = msg.photo[msg.photo.length - 1];
          const buf = await this.downloadFile(largestPhoto.file_id);
          parsed.imageBase64 = buf.toString("base64");
          parsed.imageMimeType = "image/jpeg";
          log.debug(
            `📷 Downloaded photo (${Math.round(buf.length / 1024)}KB) for msg ${msg.message_id}`
          );
        } catch (err) {
          log.warn({ err }, `Failed to download photo for msg ${msg.message_id}`);
        }
      }
      await handler(parsed);
    });

    // Also handle edited messages
    bot.on("edited_message", async (ctx) => {
      if (!ctx.editedMessage) return;
      const parsed = this.parseMessage(ctx.editedMessage);
      await handler(parsed);
    });

    // Handle channel posts
    bot.on("channel_post", async (ctx) => {
      if (!ctx.channelPost) return;
      const parsed = this.parseMessage(ctx.channelPost);
      await handler(parsed);
    });
  }

  onServiceMessage(_handler: (message: TelegramMessage) => void | Promise<void>): void {
    // Bot API doesn't receive service messages the same way GramJS does.
    // Gift-related service messages aren't available via Bot API.
    // No-op for now.
  }

  // ── Chat data ──

  async getDialogs(): Promise<
    Array<{ id: string; title: string; isGroup: boolean; isChannel: boolean }>
  > {
    // Bots don't have dialogs — return empty
    return [];
  }

  async getMessages(_chatId: string, _limit?: number): Promise<TelegramMessage[]> {
    // Bot API doesn't support fetching chat history
    return [];
  }

  async fetchReplyContext(
    rawMsg: unknown
  ): Promise<{ text?: string; senderName?: string; isAgent?: boolean } | undefined> {
    // In bot mode, rawMsg is a grammY Message object
    const msg = rawMsg as Message | undefined;
    if (!msg?.reply_to_message) return undefined;

    const reply = msg.reply_to_message;
    const senderName = reply.from?.first_name || reply.from?.username || undefined;
    const isAgent =
      this.ownId !== undefined &&
      reply.from?.id !== undefined &&
      BigInt(reply.from.id) === this.ownId;

    return {
      text: reply.text || reply.caption || undefined,
      senderName,
      isAgent,
    };
  }

  getPeer(chatId: string): unknown {
    // Bot API doesn't use peers — return chatId as-is
    return chatId;
  }

  // ── Callback queries ──

  addCallbackQueryHandler(handler: (event: CallbackQueryEvent) => Promise<void>): void {
    const bot = this.client.getBot();

    bot.on("callback_query:data", async (ctx) => {
      const query = ctx.callbackQuery;
      const event: CallbackQueryEvent = {
        queryId: query.id,
        data: query.data,
        chatId: query.message?.chat?.id?.toString() ?? "",
        messageId: query.message?.message_id ?? 0,
        userId: query.from.id,
      };
      await handler(event);
    });
  }

  async answerCallbackQuery(
    queryId: string,
    options: { message?: string; alert?: boolean }
  ): Promise<void> {
    try {
      await this.client.getBot().api.answerCallbackQuery(queryId, {
        text: options.message,
        show_alert: options.alert,
      });
    } catch (error) {
      log.error({ err: error }, "Failed to answer callback query");
    }
  }

  // ── Optional ──

  async getEntity(id: string): Promise<unknown> {
    try {
      return await this.client.getBot().api.getChat(id);
    } catch (error) {
      log.warn({ err: error }, `Failed to get entity: ${id}`);
      return undefined;
    }
  }

  getRawClient(): unknown {
    return this.client.getBot();
  }

  // ── Legacy compat ──

  /**
   * @deprecated Legacy compat for tools that call context.bridge.getClient().getClient()
   * In bot mode, this returns a shim that throws on actual GramJS method calls.
   */
  getClient(): LegacyClientCompat {
    const bot = this.client.getBot();
    return {
      getClient: () => bot.api,
      getMe: () => {
        const info = this.client.getBotInfo();
        return {
          id: BigInt(info.id),
          username: info.username,
          firstName: info.first_name,
          isBot: true,
        };
      },
    };
  }

  // ── Internals ──

  /**
   * Get the underlying BotClient for direct grammY access.
   */
  getBotClient(): BotClient {
    return this.client;
  }

  /**
   * Parse a grammY Message into our TelegramMessage format.
   */
  private parseMessage(msg: Message): TelegramMessage {
    const chatId = msg.chat.id.toString();
    const senderId = msg.from?.id ?? 0;
    const senderUsername = msg.from?.username;
    const senderFirstName = msg.from?.first_name;
    const isBot = msg.from?.is_bot ?? false;

    const isChannel = msg.chat.type === "channel";
    const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";

    // Check if bot is mentioned
    let mentionsMe = false;
    if (this.ownUsername && msg.text) {
      mentionsMe = msg.text.toLowerCase().includes(`@${this.ownUsername}`);
    }
    // Also check entities for bot_command or text_mention
    if (!mentionsMe && msg.entities) {
      for (const entity of msg.entities) {
        if (entity.type === "mention") {
          const mentionText = msg.text?.substring(entity.offset, entity.offset + entity.length);
          if (
            mentionText &&
            this.ownUsername &&
            mentionText.toLowerCase() === `@${this.ownUsername}`
          ) {
            mentionsMe = true;
            break;
          }
        }
      }
    }

    // Determine text content
    let text = msg.text || msg.caption || "";
    if (!text) {
      if (msg.poll) {
        text = `[Poll: ${msg.poll.question}]`;
      } else if (msg.contact) {
        text = `[Contact: ${msg.contact.first_name} ${msg.contact.last_name || ""} - ${msg.contact.phone_number}]`;
      } else if (msg.location) {
        text = `[Location shared]`;
      } else if (msg.dice) {
        text = `[Dice: ${msg.dice.emoji} = ${msg.dice.value}]`;
      } else if (msg.game) {
        text = `[Game: ${msg.game.title}]`;
      }
    }

    // Media detection
    const hasMedia = !!(
      msg.photo ||
      msg.document ||
      msg.video ||
      msg.audio ||
      msg.voice ||
      msg.sticker ||
      msg.animation
    );
    let mediaType: TelegramMessage["mediaType"];
    if (msg.photo) mediaType = "photo";
    else if (msg.video || msg.animation) mediaType = "video";
    else if (msg.audio) mediaType = "audio";
    else if (msg.voice) mediaType = "voice";
    else if (msg.sticker) mediaType = "sticker";
    else if (msg.document) mediaType = "document";

    return {
      id: msg.message_id,
      chatId,
      senderId,
      senderUsername,
      senderFirstName,
      text,
      isGroup,
      isChannel,
      isBot,
      mentionsMe,
      timestamp: new Date(msg.date * 1000),
      hasMedia,
      mediaType,
      replyToId: msg.reply_to_message?.message_id,
      _rawMessage: msg as unknown as never, // Bot API message stored as-is
      _rawPeer: undefined,
    };
  }
}
