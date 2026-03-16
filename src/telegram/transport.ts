/**
 * Unified transport interface for Telegram communication.
 * Both GramJS (userbot) and grammY (bot) bridges implement this.
 */

import type { TelegramMessage, InlineButton, SendMessageOptions } from "./bridge.js";

export type { TelegramMessage, InlineButton, SendMessageOptions };

/**
 * Callback query event (normalized across GramJS and Bot API)
 */
export interface CallbackQueryEvent {
  queryId: string;
  data: string;
  chatId: string;
  messageId: number;
  userId: number;
}

/**
 * Unified Telegram transport interface.
 * All tools and plugins interact with Telegram through this interface.
 */
export interface TelegramTransport {
  // ── Lifecycle ──
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isAvailable(): boolean;

  // ── Identity ──
  getOwnUserId(): bigint | undefined;
  getUsername(): string | undefined;

  // ── Messaging ──
  sendMessage(
    options: SendMessageOptions & { _rawPeer?: unknown }
  ): Promise<{ id: number }>;

  editMessage(options: {
    chatId: string;
    messageId: number;
    text: string;
    inlineKeyboard?: InlineButton[][];
  }): Promise<{ id: number }>;

  setTyping(chatId: string): Promise<void>;
  sendReaction(chatId: string, messageId: number, emoji: string): Promise<void>;

  // ── Event handlers ──
  onNewMessage(
    handler: (message: TelegramMessage) => void | Promise<void>,
    filters?: { incoming?: boolean; outgoing?: boolean; chats?: string[] }
  ): void;

  onServiceMessage(
    handler: (message: TelegramMessage) => void | Promise<void>
  ): void;

  // ── Chat data ──
  getDialogs(): Promise<
    Array<{ id: string; title: string; isGroup: boolean; isChannel: boolean }>
  >;

  getMessages(chatId: string, limit?: number): Promise<TelegramMessage[]>;

  fetchReplyContext(
    rawMsg: unknown
  ): Promise<{ text?: string; senderName?: string; isAgent?: boolean } | undefined>;

  getPeer(chatId: string): unknown;

  // ── Callback queries ──
  addCallbackQueryHandler(
    handler: (event: CallbackQueryEvent) => Promise<void>
  ): void;

  answerCallbackQuery(
    queryId: string,
    options: { message?: string; alert?: boolean }
  ): Promise<void>;

  // ── Optional (userbot-only) ──
  getEntity?(id: string): Promise<unknown>;

  /** Access raw underlying client — only available in userbot mode */
  getRawClient?(): unknown;

  /**
   * @deprecated Legacy compat — use TelegramTransport methods directly.
   * Returns an object with getClient() for GramJS access in userbot mode.
   * In bot mode, throws an error. Will be removed after Phase 1.2 migration.
   */
  getClient(): LegacyClientCompat;
}

/**
 * @deprecated Legacy compatibility wrapper for getClient() chain.
 * Allows existing tool executors to call context.bridge.getClient().getClient()
 * without immediate breakage during the Bot API migration.
 */
export interface LegacyClientCompat {
  getClient(): unknown;
  getMe?(): unknown;
  [key: string]: unknown;
}
