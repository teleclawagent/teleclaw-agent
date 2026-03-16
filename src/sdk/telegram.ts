import type { TelegramTransport } from "../telegram/transport.js";
import { Api } from "telegram";
import { randomLong } from "../utils/gramjs-bigint.js";
import type { TelegramSDK, TelegramUser, SimpleMessage, PluginLogger } from "@teleclaw-agent/sdk";
import { PluginSDKError } from "@teleclaw-agent/sdk";
import { requireBridge as requireBridgeUtil } from "./telegram-utils.js";
import { createTelegramMessagesSDK } from "./telegram-messages.js";
import { createTelegramSocialSDK } from "./telegram-social.js";

export function createTelegramSDK(bridge: TelegramTransport, log: PluginLogger): TelegramSDK {
  function requireBridge(): void {
    requireBridgeUtil(bridge);
  }

  return {
    async sendMessage(chatId, text, opts) {
      requireBridge();
      try {
        const msg = await bridge.sendMessage({
          chatId,
          text,
          replyToId: opts?.replyToId,
          inlineKeyboard: opts?.inlineKeyboard,
        });
        return msg.id;
      } catch (err) {
        if (err instanceof PluginSDKError) throw err;
        throw new PluginSDKError(
          `Failed to send message: ${err instanceof Error ? err.message : String(err)}`,
          "OPERATION_FAILED"
        );
      }
    },

    async editMessage(chatId, messageId, text, opts) {
      requireBridge();
      try {
        const msg = await bridge.editMessage({
          chatId,
          messageId,
          text,
          inlineKeyboard: opts?.inlineKeyboard,
        });
        return typeof msg?.id === "number" ? msg.id : messageId;
      } catch (err) {
        if (err instanceof PluginSDKError) throw err;
        throw new PluginSDKError(
          `Failed to edit message: ${err instanceof Error ? err.message : String(err)}`,
          "OPERATION_FAILED"
        );
      }
    },

    async sendDice(chatId, emoticon, replyToId) {
      requireBridge();
      try {
        // Try raw client (GramJS in userbot mode) for dice
        const rawClient = bridge.getRawClient?.();
        if (rawClient && typeof rawClient === "object" && "getClient" in rawClient) {
          // Userbot mode — use GramJS MTProto
          const gramJsClient = (rawClient as { getClient(): unknown }).getClient() as {
            invoke(request: unknown): Promise<unknown>;
          };

          const result = await gramJsClient.invoke(
            new Api.messages.SendMedia({
              peer: chatId,
              media: new Api.InputMediaDice({ emoticon }),
              message: "",
              randomId: randomLong(),
              replyTo: replyToId
                ? new Api.InputReplyToMessage({ replyToMsgId: replyToId })
                : undefined,
            })
          );

          let value: number | undefined;
          let messageId: number | undefined;

          if (result instanceof Api.Updates || result instanceof Api.UpdatesCombined) {
            for (const update of result.updates) {
              if (
                update.className === "UpdateNewMessage" ||
                update.className === "UpdateNewChannelMessage"
              ) {
                const msg = update.message;
                if (msg instanceof Api.Message && msg.media?.className === "MessageMediaDice") {
                  value = (msg.media as Api.MessageMediaDice).value;
                  messageId = msg.id;
                  break;
                }
              }
            }
          }

          if (value === undefined || messageId === undefined) {
            throw new Error("Could not extract dice value from Telegram response");
          }

          return { value, messageId };
        }

        // Bot mode — sendDice not available via transport yet
        throw new PluginSDKError(
          "sendDice is not available in bot mode SDK",
          "NOT_SUPPORTED"
        );
      } catch (err) {
        if (err instanceof PluginSDKError) throw err;
        throw new PluginSDKError(
          `Failed to send dice: ${err instanceof Error ? err.message : String(err)}`,
          "OPERATION_FAILED"
        );
      }
    },

    async sendReaction(chatId, messageId, emoji) {
      requireBridge();
      try {
        await bridge.sendReaction(chatId, messageId, emoji);
      } catch (err) {
        if (err instanceof PluginSDKError) throw err;
        throw new PluginSDKError(
          `Failed to send reaction: ${err instanceof Error ? err.message : String(err)}`,
          "OPERATION_FAILED"
        );
      }
    },

    async getMessages(chatId, limit): Promise<SimpleMessage[]> {
      requireBridge();
      try {
        const messages = await bridge.getMessages(chatId, limit ?? 50);
        return messages.map((m) => ({
          id: m.id,
          text: m.text,
          senderId: m.senderId,
          senderUsername: m.senderUsername,
          timestamp: m.timestamp,
        }));
      } catch (err) {
        log.error("telegram.getMessages() failed:", err);
        return [];
      }
    },

    getMe(): TelegramUser | null {
      try {
        const ownId = bridge.getOwnUserId();
        const username = bridge.getUsername();
        if (!ownId) return null;
        return {
          id: Number(ownId),
          username: username,
          firstName: undefined,
          isBot: true, // In bot mode always true, userbot mode doesn't use SDK getMe typically
        };
      } catch {
        return null;
      }
    },

    isAvailable(): boolean {
      return bridge.isAvailable();
    },

    getRawClient(): unknown | null {
      log.warn("getRawClient() called — this bypasses SDK sandbox guarantees");
      if (!bridge.isAvailable()) return null;
      try {
        return bridge.getRawClient?.() ?? null;
      } catch {
        return null;
      }
    },

    // Spread extended methods from sub-modules
    ...createTelegramMessagesSDK(bridge, log),
    ...createTelegramSocialSDK(bridge, log),
  };
}
