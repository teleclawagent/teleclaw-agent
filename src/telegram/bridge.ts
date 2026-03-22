import { TelegramUserClient, type TelegramClientConfig } from "./client.js";
import { Api } from "telegram";
import type { NewMessageEvent } from "telegram/events/NewMessage.js";
import type { TelegramTransport, CallbackQueryEvent, LegacyClientCompat } from "./transport.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("Telegram");

export interface TelegramMessage {
  id: number;
  chatId: string;
  senderId: number;
  senderUsername?: string;
  senderFirstName?: string;
  senderRank?: string;
  text: string;
  isGroup: boolean;
  isChannel: boolean;
  isBot: boolean;
  mentionsMe: boolean;
  timestamp: Date;
  _rawPeer?: Api.TypePeer;
  hasMedia: boolean;
  mediaType?: "photo" | "document" | "video" | "audio" | "voice" | "sticker";
  /** Base64-encoded image data (set after downloading photo from Bot API) */
  imageBase64?: string;
  imageMimeType?: string;
  replyToId?: number;
  _rawMessage?: Api.Message;
}

export interface InlineButton {
  text: string;
  callback_data: string;
}

export interface SendMessageOptions {
  chatId: string;
  text: string;
  replyToId?: number;
  inlineKeyboard?: InlineButton[][];
}

export class TelegramBridge implements TelegramTransport {
  private client: TelegramUserClient;
  private ownUserId?: bigint;
  private ownUsername?: string;
  private peerCache: Map<string, Api.TypePeer> = new Map();

  constructor(config: TelegramClientConfig) {
    this.client = new TelegramUserClient(config);
  }

  async connect(): Promise<void> {
    await this.client.connect();
    const me = this.client.getMe();
    if (me) {
      this.ownUserId = me.id;
      this.ownUsername = me.username?.toLowerCase();
    }

    try {
      await this.getDialogs();
    } catch (error) {
      log.warn({ err: error }, "Could not load dialogs");
    }
  }

  async disconnect(): Promise<void> {
    await this.client.disconnect();
  }

  isAvailable(): boolean {
    return this.client.isConnected();
  }

  getOwnUserId(): bigint | undefined {
    return this.ownUserId;
  }

  getUsername(): string | undefined {
    const me = this.client.getMe();
    return me?.username;
  }

  async getMessages(chatId: string, limit: number = 50): Promise<TelegramMessage[]> {
    try {
      const peer = this.peerCache.get(chatId) || chatId;
      const messages = await this.client.getMessages(peer, { limit });
      const results = await Promise.allSettled(messages.map((msg) => this.parseMessage(msg)));
      return results
        .filter((r): r is PromiseFulfilledResult<TelegramMessage> => r.status === "fulfilled")
        .map((r) => r.value);
    } catch (error) {
      log.error({ err: error }, "Error getting messages");
      return [];
    }
  }

  async sendMessage(
    options: SendMessageOptions & { _rawPeer?: Api.TypePeer }
  ): Promise<Api.Message> {
    try {
      const peer = options._rawPeer || this.peerCache.get(options.chatId) || options.chatId;

      if (options.inlineKeyboard && options.inlineKeyboard.length > 0) {
        const buttons = new Api.ReplyInlineMarkup({
          rows: options.inlineKeyboard.map(
            (row) =>
              new Api.KeyboardButtonRow({
                buttons: row.map(
                  (btn) =>
                    new Api.KeyboardButtonCallback({
                      text: btn.text,
                      data: Buffer.from(btn.callback_data),
                    })
                ),
              })
          ),
        });

        const gramJsClient = this.client.getClient();
        return await gramJsClient.sendMessage(peer, {
          message: options.text,
          replyTo: options.replyToId,
          buttons,
        });
      }

      return await this.client.sendMessage(peer, {
        message: options.text,
        replyTo: options.replyToId,
      });
    } catch (error) {
      log.error({ err: error }, "Error sending message");
      throw error;
    }
  }

  async editMessage(options: {
    chatId: string;
    messageId: number;
    text: string;
    inlineKeyboard?: InlineButton[][];
  }): Promise<Api.Message> {
    try {
      const peer = this.peerCache.get(options.chatId) || options.chatId;

      let buttons;
      if (options.inlineKeyboard && options.inlineKeyboard.length > 0) {
        buttons = new Api.ReplyInlineMarkup({
          rows: options.inlineKeyboard.map(
            (row) =>
              new Api.KeyboardButtonRow({
                buttons: row.map(
                  (btn) =>
                    new Api.KeyboardButtonCallback({
                      text: btn.text,
                      data: Buffer.from(btn.callback_data),
                    })
                ),
              })
          ),
        });
      }

      const gramJsClient = this.client.getClient();
      const result = await gramJsClient.invoke(
        new Api.messages.EditMessage({
          peer,
          id: options.messageId,
          message: options.text,
          replyMarkup: buttons,
        })
      );

      if (result instanceof Api.Updates) {
        const messageUpdate = result.updates.find(
          (u) => u.className === "UpdateEditMessage" || u.className === "UpdateEditChannelMessage"
        );
        if (messageUpdate && "message" in messageUpdate) {
          return messageUpdate.message as Api.Message;
        }
      }

      return result as unknown as Api.Message;
    } catch (error) {
      log.error({ err: error }, "Error editing message");
      throw error;
    }
  }

  async getDialogs(): Promise<
    Array<{
      id: string;
      title: string;
      isGroup: boolean;
      isChannel: boolean;
    }>
  > {
    try {
      const dialogs = await this.client.getDialogs();
      return dialogs.map((d) => ({
        id: d.id.toString(),
        title: d.title,
        isGroup: d.isGroup,
        isChannel: d.isChannel,
      }));
    } catch (error) {
      log.error({ err: error }, "Error getting dialogs");
      return [];
    }
  }

  async setTyping(chatId: string): Promise<void> {
    try {
      await this.client.setTyping(chatId);
    } catch (error) {
      log.error({ err: error }, "Error setting typing");
    }
  }

  async sendReaction(chatId: string, messageId: number, emoji: string): Promise<void> {
    try {
      const peer = this.peerCache.get(chatId) || chatId;

      await this.client.getClient().invoke(
        new Api.messages.SendReaction({
          peer,
          msgId: messageId,
          reaction: [
            new Api.ReactionEmoji({
              emoticon: emoji,
            }),
          ],
        })
      );
    } catch (error) {
      log.error({ err: error }, "Error sending reaction");
      throw error;
    }
  }

  onNewMessage(
    handler: (message: TelegramMessage) => void | Promise<void>,
    filters?: {
      incoming?: boolean;
      outgoing?: boolean;
      chats?: string[];
    }
  ): void {
    this.client.addNewMessageHandler(
      async (event: NewMessageEvent) => {
        const message = await this.parseMessage(event.message);
        await handler(message);
      },
      {
        incoming: filters?.incoming,
        outgoing: filters?.outgoing,
        chats: filters?.chats,
      }
    );
  }

  onServiceMessage(handler: (message: TelegramMessage) => void | Promise<void>): void {
    this.client.addServiceMessageHandler(async (msg: Api.MessageService) => {
      const message = await this.parseServiceMessage(msg);
      if (message) {
        await handler(message);
      }
    });
  }

  private async parseMessage(msg: Api.Message): Promise<TelegramMessage> {
    const chatId = msg.chatId?.toString() ?? msg.peerId?.toString() ?? "unknown";
    const senderIdBig = msg.senderId ? BigInt(msg.senderId.toString()) : BigInt(0);
    const senderId = Number(senderIdBig);

    let mentionsMe = msg.mentioned ?? false;
    if (!mentionsMe && this.ownUsername && msg.message) {
      mentionsMe = msg.message.toLowerCase().includes(`@${this.ownUsername}`);
    }

    const isChannel = msg.post ?? false;
    const isGroup = !isChannel && chatId.startsWith("-");

    if (msg.peerId) {
      this.peerCache.set(chatId, msg.peerId);
      if (this.peerCache.size > 5000) {
        const oldest = this.peerCache.keys().next().value;
        if (oldest !== undefined) this.peerCache.delete(oldest);
      }
    }

    let senderUsername: string | undefined;
    let senderFirstName: string | undefined;
    let isBot = false;
    try {
      const sender = await Promise.race([
        msg.getSender(),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 5000)),
      ]);
      if (sender && "username" in sender) {
        senderUsername = sender.username ?? undefined;
      }
      if (sender && "firstName" in sender) {
        senderFirstName = sender.firstName ?? undefined;
      }
      if (sender instanceof Api.User) {
        isBot = sender.bot ?? false;
      }
    } catch {
      // getSender() can fail on deleted accounts, timeouts, etc.
      // Non-critical: message still processed with default sender info
    }

    const hasMedia = !!(
      msg.photo ||
      msg.document ||
      msg.video ||
      msg.audio ||
      msg.voice ||
      msg.sticker
    );
    let mediaType: TelegramMessage["mediaType"];
    if (msg.photo) mediaType = "photo";
    else if (msg.video) mediaType = "video";
    else if (msg.audio) mediaType = "audio";
    else if (msg.voice) mediaType = "voice";
    else if (msg.sticker) mediaType = "sticker";
    else if (msg.document) mediaType = "document";

    const replyToMsgId = msg.replyToMsgId; // GramJS getter, returns number | undefined

    let text = msg.message ?? "";
    if (!text && msg.media) {
      if (msg.media.className === "MessageMediaDice") {
        const dice = msg.media as Api.MessageMediaDice;
        text = `[Dice: ${dice.emoticon} = ${dice.value}]`;
      } else if (msg.media.className === "MessageMediaGame") {
        const game = msg.media as Api.MessageMediaGame;
        text = `[Game: ${game.game.title}]`;
      } else if (msg.media.className === "MessageMediaPoll") {
        const poll = msg.media as Api.MessageMediaPoll;
        text = `[Poll: ${poll.poll.question.text}]`;
      } else if (msg.media.className === "MessageMediaContact") {
        const contact = msg.media as Api.MessageMediaContact;
        text = `[Contact: ${contact.firstName} ${contact.lastName || ""} - ${contact.phoneNumber}]`;
      } else if (
        msg.media.className === "MessageMediaGeo" ||
        msg.media.className === "MessageMediaGeoLive"
      ) {
        text = `[Location shared]`;
      }
    }

    // fromRank is a Layer 223 field on Message (not in CustomMessage typings)
    const senderRank = (msg as unknown as { fromRank?: string }).fromRank || undefined;

    return {
      id: msg.id,
      chatId,
      senderId,
      senderUsername,
      senderFirstName,
      senderRank,
      text,
      isGroup,
      isChannel,
      isBot,
      mentionsMe,
      timestamp: new Date(msg.date * 1000),
      _rawPeer: msg.peerId,
      hasMedia,
      mediaType,
      replyToId: replyToMsgId,
      _rawMessage: hasMedia || !!replyToMsgId ? msg : undefined,
    };
  }

  private async parseServiceMessage(msg: Api.MessageService): Promise<TelegramMessage | null> {
    const action = msg.action;
    if (!action) return null;

    // Only handle gift-related actions
    const isGiftAction =
      action instanceof Api.MessageActionStarGiftPurchaseOffer ||
      action instanceof Api.MessageActionStarGiftPurchaseOfferDeclined ||
      action instanceof Api.MessageActionStarGift;
    if (!isGiftAction) return null;

    // Skip our own outgoing actions
    if (msg.out) return null;

    const chatId = msg.chatId?.toString() ?? msg.peerId?.toString() ?? "unknown";
    const senderIdBig = msg.senderId ? BigInt(msg.senderId.toString()) : BigInt(0);
    const senderId = Number(senderIdBig);

    // Resolve sender info (same pattern as parseMessage, 5s timeout)
    let senderUsername: string | undefined;
    let senderFirstName: string | undefined;
    let isBot = false;
    try {
      const sender = await Promise.race([
        msg.getSender(),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 5000)),
      ]);
      if (sender && "username" in sender) {
        senderUsername = sender.username ?? undefined;
      }
      if (sender && "firstName" in sender) {
        senderFirstName = sender.firstName ?? undefined;
      }
      if (sender instanceof Api.User) {
        isBot = sender.bot ?? false;
      }
    } catch {
      // getSender() can fail — non-critical
    }

    let text = "";

    if (action instanceof Api.MessageActionStarGiftPurchaseOffer) {
      const gift = action.gift;
      const isUnique = gift instanceof Api.StarGiftUnique;
      const title = gift.title || "Unknown Gift";
      const slug = isUnique ? gift.slug : undefined;
      const num = isUnique ? gift.num : undefined;
      const priceStars = action.price.amount?.toString() || "?";
      const status = action.accepted ? "accepted" : action.declined ? "declined" : "pending";
      const expires = action.expiresAt
        ? new Date(action.expiresAt * 1000).toISOString()
        : "unknown";

      text = `[Gift Offer Received]\n`;
      text += `Offer: ${priceStars} Stars for your NFT "${title}"${num ? ` #${num}` : ""}${slug ? ` (slug: ${slug})` : ""}\n`;
      text += `From: ${senderUsername ? `@${senderUsername}` : senderFirstName || `user:${senderId}`}\n`;
      text += `Expires: ${expires}\n`;
      text += `Status: ${status}\n`;
      text += `Message ID: ${msg.id} — use telegram_resolve_gift_offer(offerMsgId=${msg.id}) to accept or telegram_resolve_gift_offer(offerMsgId=${msg.id}, decline=true) to decline.`;

      log.info(
        `Gift offer received: ${priceStars} Stars for "${title}" from ${senderUsername || senderId}`
      );
    } else if (action instanceof Api.MessageActionStarGiftPurchaseOfferDeclined) {
      const gift = action.gift;
      const isUnique = gift instanceof Api.StarGiftUnique;
      const title = gift.title || "Unknown Gift";
      const slug = isUnique ? gift.slug : undefined;
      const num = isUnique ? gift.num : undefined;
      const priceStars = action.price.amount?.toString() || "?";
      const reason = action.expired ? "expired" : "declined";

      text = `[Gift Offer ${action.expired ? "Expired" : "Declined"}]\n`;
      text += `Your offer of ${priceStars} Stars for NFT "${title}"${num ? ` #${num}` : ""}${slug ? ` (slug: ${slug})` : ""} was ${reason}.`;

      log.info(`Gift offer ${reason}: ${priceStars} Stars for "${title}"`);
    } else if (action instanceof Api.MessageActionStarGift) {
      const gift = action.gift;
      const title = gift.title || "Unknown Gift";
      const stars = gift instanceof Api.StarGift ? gift.stars?.toString() || "?" : "?";
      const giftMessage = action.message?.text || "";
      const fromAnonymous = action.nameHidden;

      text = `[Gift Received]\n`;
      text += `Gift: "${title}" (${stars} Stars)${action.upgraded ? " [Upgraded to Collectible]" : ""}\n`;
      text += `From: ${fromAnonymous ? "Anonymous" : senderUsername ? `@${senderUsername}` : senderFirstName || `user:${senderId}`}\n`;
      if (giftMessage) text += `Message: "${giftMessage}"\n`;
      if (action.canUpgrade && action.upgradeStars) {
        text += `This gift can be upgraded to a collectible for ${action.upgradeStars.toString()} Stars.\n`;
      }
      if (action.convertStars) {
        text += `Can be converted to ${action.convertStars.toString()} Stars.`;
      }

      log.info(
        `Gift received: "${title}" (${stars} Stars) from ${fromAnonymous ? "Anonymous" : senderUsername || senderId}`
      );
    }

    if (!text) return null;

    // Cache peer
    if (msg.peerId) {
      this.peerCache.set(chatId, msg.peerId);
      if (this.peerCache.size > 5000) {
        const oldest = this.peerCache.keys().next().value;
        if (oldest !== undefined) this.peerCache.delete(oldest);
      }
    }

    return {
      id: msg.id,
      chatId,
      senderId,
      senderUsername,
      senderFirstName,
      text: text.trim(),
      isGroup: false,
      isChannel: false,
      isBot,
      mentionsMe: true,
      timestamp: new Date(msg.date * 1000),
      hasMedia: false,
      _rawPeer: msg.peerId,
    };
  }

  getPeer(chatId: string): Api.TypePeer | undefined {
    return this.peerCache.get(chatId);
  }

  async fetchReplyContext(
    rawMsg: Api.Message
  ): Promise<{ text?: string; senderName?: string; isAgent?: boolean } | undefined> {
    try {
      const replyMsg = await Promise.race([
        rawMsg.getReplyMessage(),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 5000)),
      ]);
      if (!replyMsg) return undefined;

      let senderName: string | undefined;
      try {
        const sender = await Promise.race([
          replyMsg.getSender(),
          new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 5000)),
        ]);
        if (sender && "firstName" in sender) {
          senderName = (sender.firstName as string) ?? undefined;
        }
        if (sender && "username" in sender && !senderName) {
          senderName = (sender.username as string) ?? undefined;
        }
      } catch {
        // Non-critical
      }

      const replyMsgSenderId = replyMsg.senderId ? BigInt(replyMsg.senderId.toString()) : undefined;
      const isAgent = this.ownUserId !== undefined && replyMsgSenderId === this.ownUserId;

      return {
        text: replyMsg.message || undefined,
        senderName,
        isAgent,
      };
    } catch {
      return undefined;
    }
  }

  // ── Extended messaging (TelegramTransport) ──

  async deleteMessages(chatId: string, messageIds: number[]): Promise<void> {
    const peer = this.peerCache.get(chatId) || chatId;
    await this.client.getClient().deleteMessages(peer, messageIds, { revoke: true });
  }

  async forwardMessage(
    fromChatId: string,
    toChatId: string,
    messageId: number
  ): Promise<{ id: number }> {
    const fromPeer = this.peerCache.get(fromChatId) || fromChatId;
    const toPeer = this.peerCache.get(toChatId) || toChatId;
    const result = await this.client.getClient().forwardMessages(toPeer, {
      fromPeer,
      messages: [messageId],
    });
    const msgId = Array.isArray(result) && result.length > 0 ? result[0].id : messageId;
    return { id: msgId };
  }

  async pinMessage(chatId: string, messageId: number, silent = false): Promise<void> {
    const peer = this.peerCache.get(chatId) || chatId;
    await this.client.getClient().pinMessage(peer, messageId, { notify: !silent });
  }

  async unpinMessage(chatId: string, messageId: number): Promise<void> {
    const peer = this.peerCache.get(chatId) || chatId;
    await this.client.getClient().unpinMessage(peer, messageId);
  }

  async sendPhoto(
    chatId: string,
    photo: string | Buffer,
    options?: { caption?: string; replyToId?: number }
  ): Promise<{ id: number }> {
    const peer = this.peerCache.get(chatId) || chatId;
    const msg = await this.client.getClient().sendFile(peer, {
      file: photo,
      caption: options?.caption,
      replyTo: options?.replyToId,
    });
    return { id: msg.id };
  }

  async sendAnimation(
    chatId: string,
    animation: string | Buffer,
    options?: { caption?: string; replyToId?: number }
  ): Promise<{ id: number }> {
    const peer = this.peerCache.get(chatId) || chatId;
    const msg = await this.client.getClient().sendFile(peer, {
      file: animation,
      caption: options?.caption,
      replyTo: options?.replyToId,
      forceDocument: false,
    });
    return { id: msg.id };
  }

  async sendSticker(
    chatId: string,
    sticker: string | Buffer,
    options?: { replyToId?: number }
  ): Promise<{ id: number }> {
    const peer = this.peerCache.get(chatId) || chatId;
    const msg = await this.client.getClient().sendFile(peer, {
      file: sticker,
      replyTo: options?.replyToId,
    });
    return { id: msg.id };
  }

  async sendVoice(
    chatId: string,
    voice: string | Buffer,
    options?: { caption?: string; replyToId?: number; duration?: number }
  ): Promise<{ id: number }> {
    const peer = this.peerCache.get(chatId) || chatId;
    const msg = await this.client.getClient().sendFile(peer, {
      file: voice,
      caption: options?.caption,
      replyTo: options?.replyToId,
      voiceNote: true,
    });
    return { id: msg.id };
  }

  async sendDocument(
    chatId: string,
    document: string | Buffer,
    options?: { caption?: string; replyToId?: number; filename?: string }
  ): Promise<{ id: number }> {
    const peer = this.peerCache.get(chatId) || chatId;
    const msg = await this.client.getClient().sendFile(peer, {
      file: document,
      caption: options?.caption,
      replyTo: options?.replyToId,
      forceDocument: true,
    });
    return { id: msg.id };
  }

  async downloadFile(fileId: string): Promise<Buffer> {
    // In GramJS mode, fileId handling is complex — this is a simplified version
    // Most tool executors use getClient() directly for media downloads
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- GramJS downloadMedia accepts various types
    const result = await this.client.getClient().downloadMedia(fileId as any);
    if (result instanceof Buffer) return result;
    throw new Error("Failed to download file");
  }

  async sendPoll(
    chatId: string,
    question: string,
    options: string[],
    opts?: { isAnonymous?: boolean; allowsMultiple?: boolean; replyToId?: number }
  ): Promise<{ id: number }> {
    const peer = this.peerCache.get(chatId) || chatId;
    const { Api: TgApi } = await import("telegram");
    const { randomLong } = await import("../utils/gramjs-bigint.js");
    const result = await this.client.getClient().invoke(
      new TgApi.messages.SendMedia({
        peer,
        media: new TgApi.InputMediaPoll({
          poll: new TgApi.Poll({
            id: randomLong(),
            question: new TgApi.TextWithEntities({ text: question, entities: [] }),
            answers: options.map(
              (opt, i) =>
                new TgApi.PollAnswer({
                  text: new TgApi.TextWithEntities({ text: opt, entities: [] }),
                  option: Buffer.from([i]),
                })
            ),
            publicVoters: !(opts?.isAnonymous ?? true),
            multipleChoice: opts?.allowsMultiple,
          }),
        }),
        message: "",
        randomId: randomLong(),
      })
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- extracting message ID from Updates
    const updates = result as any;
    const msgId =
      updates?.updates?.find?.(
        (u: { className: string; message?: { id: number } }) =>
          u.className === "UpdateNewMessage" || u.className === "UpdateNewChannelMessage"
      )?.message?.id ?? 0;
    return { id: msgId };
  }

  async sendDice(
    chatId: string,
    emoji?: string,
    replyToId?: number
  ): Promise<{ id: number; value?: number }> {
    const peer = this.peerCache.get(chatId) || chatId;
    const { Api: TgApi } = await import("telegram");
    const { randomLong } = await import("../utils/gramjs-bigint.js");
    const result = await this.client.getClient().invoke(
      new TgApi.messages.SendMedia({
        peer,
        media: new TgApi.InputMediaDice({ emoticon: emoji || "🎲" }),
        message: "",
        randomId: randomLong(),
        replyTo: replyToId ? new TgApi.InputReplyToMessage({ replyToMsgId: replyToId }) : undefined,
      })
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- extracting from Updates
    const updates = result as any;
    const msg = updates?.updates?.find?.(
      (u: { className: string }) =>
        u.className === "UpdateNewMessage" || u.className === "UpdateNewChannelMessage"
    )?.message;
    return { id: msg?.id ?? 0, value: msg?.media?.value };
  }

  getClient(): LegacyClientCompat {
    return this.client as unknown as LegacyClientCompat;
  }

  /**
   * Get the typed TelegramUserClient (userbot mode only).
   */
  getUserClient(): TelegramUserClient {
    return this.client;
  }

  // ── TelegramTransport interface methods ──

  addCallbackQueryHandler(handler: (event: CallbackQueryEvent) => Promise<void>): void {
    this.client.addCallbackQueryHandler(async (update: unknown) => {
      if (!update || typeof update !== "object") return;

      const callbackUpdate = update as {
        queryId?: unknown;
        data?: { toString(): string } | string;
        peer?: {
          channelId?: { toString(): string };
          chatId?: { toString(): string };
          userId?: { toString(): string };
        };
        msgId?: unknown;
        userId?: unknown;
      };

      const queryId = String(callbackUpdate.queryId ?? "");
      const data =
        typeof callbackUpdate.data === "string"
          ? callbackUpdate.data
          : callbackUpdate.data?.toString() || "";
      const chatId =
        callbackUpdate.peer?.channelId?.toString() ??
        callbackUpdate.peer?.chatId?.toString() ??
        callbackUpdate.peer?.userId?.toString() ??
        "";
      const messageId =
        typeof callbackUpdate.msgId === "number"
          ? callbackUpdate.msgId
          : Number(callbackUpdate.msgId || 0);
      const userId = Number(callbackUpdate.userId);

      const event: CallbackQueryEvent = {
        queryId,
        data,
        chatId,
        messageId,
        userId,
      };

      await handler(event);
    });
  }

  async answerCallbackQuery(
    queryId: string,
    options: { message?: string; alert?: boolean }
  ): Promise<void> {
    try {
      await this.client.answerCallbackQuery(queryId, {
        message: options.message,
        alert: options.alert,
      });
    } catch (error) {
      log.error({ err: error }, "Failed to answer callback query");
    }
  }

  async getEntity(id: string): Promise<unknown> {
    try {
      return await this.client.getClient().getEntity(id);
    } catch (error) {
      log.warn({ err: error }, `Failed to get entity: ${id}`);
      return undefined;
    }
  }

  getRawClient(): unknown {
    return this.client;
  }
}
