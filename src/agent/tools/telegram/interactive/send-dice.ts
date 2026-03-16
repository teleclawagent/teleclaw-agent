import { Type } from "@sinclair/typebox";
import type { Tool, ToolExecutor, ToolResult } from "../../types.js";
import { getErrorMessage } from "../../../../utils/errors.js";
import { createLogger } from "../../../../utils/logger.js";

const log = createLogger("Tools");

interface SendDiceParams {
  chatId: string;
  emoji?: string;
  replyToId?: number;
}

export const telegramSendDiceTool: Tool = {
  name: "telegram_send_dice",
  description:
    'Send a random dice animation. Supported emojis: 🎲 (1-6), 🎯 (1-6), 🏀 (1-5), ⚽ (1-5), 🎳 (1-6), 🎰 (1-64). Default: 🎲',
  parameters: Type.Object({
    chatId: Type.String({ description: "The chat ID" }),
    emoji: Type.Optional(
      Type.String({ description: "Dice emoji (🎲, 🎯, 🏀, ⚽, 🎳, 🎰)", default: "🎲" })
    ),
    replyToId: Type.Optional(Type.Number({ description: "Message ID to reply to" })),
  }),
};

export const telegramSendDiceExecutor: ToolExecutor<SendDiceParams> = async (
  params,
  context
): Promise<ToolResult> => {
  try {
    const result = await context.bridge.sendDice(
      params.chatId,
      params.emoji || "🎲",
      params.replyToId
    );
    return {
      success: true,
      data: { messageId: result.id, value: result.value, emoji: params.emoji || "🎲" },
    };
  } catch (error) {
    log.error({ err: error }, "Error sending dice");
    return { success: false, error: getErrorMessage(error) };
  }
};
